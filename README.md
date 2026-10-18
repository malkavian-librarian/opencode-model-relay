# opencode-model-relay

> Status: v1.0 in development. Not yet published to npm.

An [OpenCode](https://opencode.ai) plugin that keeps a session going when the current model fails: it classifies the failure, moves to the next model in your chain, hands the work over with a structured summary, and resumes.

## Quick start

1. Add the plugin to `opencode.json` once it is published: `{ "plugin": ["opencode-model-relay"] }`. Until then, build it (`npm ci; npm run build`) and copy `dist/index.js` into `~/.config/opencode/plugins/`; the build is self-contained (zod and jsonc-parser are bundled, no `node_modules` needed).
2. Create `~/.config/opencode/opencode-model-relay.jsonc`:

```jsonc
{
  "tiers": {
    "primary": "anthropic/claude-sonnet-4-5",
    "secondary": ["openrouter/z-ai/glm-5.2"],
    "tertiary": ["openrouter/deepseek/deepseek-chat"]
  }
}
```

Models are written `providerID/modelID`; only the first `/` splits them (`openrouter/z-ai/glm-5.2` is provider `openrouter`, model `z-ai/glm-5.2`). Type `/relay` inside OpenCode (or ask the model for the relay status) to see the chain and the current state. `/relay` is a command whose template asks the model to call the `relay_status` tool and print its output verbatim, so using it costs one small model turn. The `relay_status` tool reports the chain, current model, switch count and whether the API key is set or missing (never the key itself). If you opt in to OpenRouter summaries (see Privacy), the helper model defaults to `z-ai/glm-5.2` (slug unverified; check openrouter.ai/models); change it with `handover.model`.

## How it works

1. A `session.error` event arrives. The failure is classified: `rate_limit`, `quota`, `auth`, `free_tier_403`, `model_not_found`, `server_5xx` or `timeout` can trigger a switch. `overflow`, `user_abort` (pressing Esc) and `unknown` never do.
2. The plugin picks the next model in the chain (`primary`, then `secondary`, then `tertiary`) that is not permanently failed or cooling down. If none is left, or the per-session switch cap is reached, it tells you and stays on the current model.
3. It builds a structured handover: a summary, the tool calls so far (with DONE / FAILED / UNKNOWN status), files touched, open todos, and your last request verbatim. The summary is written by a helper model through OpenRouter only if you opted in (see Privacy); otherwise the handover carries the plain tail of the redacted transcript.
4. The plugin aborts the failed turn, sends the handover to the next model, and the work resumes there.
5. The choice is sticky for the session: later messages are pinned to the model that took over. If you pick a different model yourself, the pin is cleared.

Subagent sessions (those with a `parentID`) are skipped. Any internal error leaves the session on its current model; hooks never throw. Main-model traffic always goes through OpenCode; the plugin does not proxy it.

## Configuration

File: `~/.config/opencode/opencode-model-relay.jsonc` (JSONC, max 64 KB). It is read from the user config directory only, never from a project. `XDG_CONFIG_HOME` overrides the base directory. An invalid file falls back to defaults and shows a warning toast. Unknown keys are rejected.

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `mode` | `"chain-sticky"` | `"chain-sticky"` | Only mode in v1.0. |
| `tiers.primary` | `"provider/model"` | unset | If unset, the model currently in use heads the chain. |
| `tiers.secondary` | `"provider/model"[]` | `[]` | Tried after primary, in order. |
| `tiers.tertiary` | `"provider/model"[]` | `[]` | Tried after secondary, in order. |
| `privacy.consent` | boolean | `false` | Must be `true` before anything is sent to OpenRouter. |
| `privacy.zdr` | boolean | `false` | Adds `provider.zdr: true` to helper requests (zero data retention endpoints only). |
| `openrouter.keyEnv` | string | `"OPENROUTER_API_KEY"` | Name of the environment variable that holds the key. The key is never read from config. |
| `openrouter.baseUrl` | URL string | `"https://openrouter.ai/api/v1"` | Must be `https`, and host `openrouter.ai` unless `allowCustomBaseUrl` is true. |
| `openrouter.allowCustomBaseUrl` | boolean | `false` | Allows another `https` host. |
| `handover.model` | string | `"z-ai/glm-5.2"` (slug unverified; check openrouter.ai/models) | OpenRouter model that writes the summary. |
| `handover.writerPrompt` | string | built-in prompt | System prompt for the summary writer. |
| `handover.messageTemplate` | string | built-in template | Placeholders: `{{from}} {{to}} {{reason}} {{summary}} {{toolCalls}} {{files}} {{todo}} {{lastRequest}}`. |
| `handover.maxToolChars` | positive integer | `1500` | Per tool output cap before truncation. |
| `handover.maxTranscriptChars` | positive integer | `60000` | Transcript cap (internally limited to 60000). |
| `handover.maxCallsPerSession` | integer >= 0 | `3` | Helper-model calls per session; after that the plain tail is used. |
| `cooldownMs` | positive integer | `60000` | Base cooldown for a temporarily failed model; doubles per repeat, capped at 1 hour. A `Retry-After` header is honoured. |
| `maxSwitchesPerSession` | positive integer | `6` | Hard cap on switches per session. |
| `onExhausted` | `"stop"` | `"stop"` | Only behaviour in v1.0. |
| `narrator.verbosity` | `"off"` \| `"quiet"` \| `"normal"` \| `"chatty"` | `"normal"` | `quiet` shows only exhausted, cap and config problems. |
| `narrator.tone` | `"plain"` \| `"british"` | `"plain"` | Accepted, but v1.0 has only plain messages; `british` has no effect yet. |
| `ledger.enabled` | boolean | `true` | Write the local switch log. |
| `ledger.dir` | string | unset (data dir) | Must resolve inside the data directory, otherwise the data directory is used. |

## Privacy

- Nothing leaves your machine except through OpenCode itself, unless you opt in. The only direct call the plugin makes is the optional handover summary to OpenRouter.
- Opt in with `"privacy.consent": true` and an OpenRouter key in the environment variable named by `openrouter.keyEnv`. Without both, no network call is made and the handover uses the plain transcript tail. You get a one-time toast saying so.
- Every helper request sends `provider.data_collection: "deny"`. With `privacy.zdr: true` it also requests zero-data-retention routing.
- Everything sent passes through a redaction step first (private keys, common API token formats, bearer tokens, `KEY=value` lines, auth and cookie headers, URL credentials, secret-looking query parameters and CLI flags). Output of tools that touched sensitive paths (`.env`, SSH keys, `.pem`, `.npmrc`, `.netrc`, `credentials`, `secrets.json` and similar) is dropped. Redaction is pattern-based and best effort, not a guarantee.
- The helper request goes only to the configured base URL over `https`, with redirects not followed. The key is never written to config, logs, the switch log or error messages.
- Transcripts and tool output are treated as untrusted data. The handover message says it is a model-generated summary, not user instructions.
- Stored locally under `~/.local/share/opencode-model-relay` (or `$XDG_DATA_HOME/opencode-model-relay`):
  - `switches.jsonl`: one row per switch with timestamp, HMAC'd session id, from/to model, failure kind and optional helper cost. Metadata only, no prompt or response text.
  - `state.json`: per-session sticky model and counters.
  - `salt`: the random per-install salt used for the session-id HMAC.

## Compared to opencode-auto-fallback

An honest comparison; pick what fits your setup.

| | opencode-auto-fallback | opencode-model-relay |
| --- | --- | --- |
| Failover on errors | yes | yes |
| Retry same model with backoff | yes (`maxRetries`) | no |
| Per-agent chains | yes | no (one chain per install) |
| Large-context switching | yes | no (context overflow never switches) |
| Handover | re-prompts the session on the fallback model; large-context switches preserve context via compaction | structured handover: summary, tool-call status, files, todos, your last request verbatim |
| LLM-written summary | not for failover (compaction-based context preservation for large-context switches only) | optional, opt-in, redacted |
| Consent and redaction for data egress | n/a | explicit consent gate, redaction, `data_collection: "deny"` |
| Config | per-agent chains | `tiers` (primary, secondary, tertiary) |
| Sticky per session | not documented | yes |
| Quality-failure judge | no | not yet (planned v1.1) |

This table reflects the author's reading of both projects; check their READMEs for current behaviour.

## Roadmap

- v1.1: a judge model for quality failures (not only hard errors), a quality path for tiers, and the British narrator tone.
- v1.2: per-model statistics.

## Known limits

- Verified headless against a real OpenCode server (see [docs/e2e-v1.0.md](docs/e2e-v1.0.md)); behaviour in the TUI (toast, the Esc keypress, `/relay`) is unconfirmed (#19). Model pinning is covered in [docs/spike.md](docs/spike.md).
- Real 403, 429 and quota error payloads have not been captured yet; those classifications rely on message and status matching tested with hand-written payloads (#18).
- `/relay` always costs one small model turn, because OpenCode plugin commands cannot run without the model.
- `free_tier_403` detection is by error-message match and may miss other wordings.
- Subagent sessions are not handled, and the plugin does not support per-agent chains.
- The helper summary needs an OpenRouter key; no other provider is supported for it.

## Development

```
npm ci
npm run typecheck
npm test
npm run build
```

Design notes: [docs/superpowers/specs/2026-10-18-model-relay-design.md](docs/superpowers/specs/2026-10-18-model-relay-design.md)

## Contributing / working with agents

Work is tracked as GitHub issues and follows one documented process. Start with [AGENTS.md](AGENTS.md) (commands, rules, gotchas) and [docs/process.md](docs/process.md) (lifecycle, reviewer loop, merge authority). This applies to human contributors and AI agents alike.

## License

MIT. The bundled dist/index.js includes zod and jsonc-parser (MIT); see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
