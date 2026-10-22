# opencode-model-relay

> Status: v1.0.0 published to npm as opencode-model-relay.

An [OpenCode](https://opencode.ai) plugin that keeps a session going when the current model fails: it classifies the failure, moves to the next model in your chain, hands the work over with a structured summary, and resumes.

## Quick start

1. Add the plugin to `opencode.json` once it is published: `{ "plugin": ["opencode-model-relay"] }`. Until then, build it (`npm ci; npm run build`) and copy `dist/index.js` into `~/.config/opencode/plugins/` (or `<project>/.opencode/plugins/`); the build is self-contained (zod and jsonc-parser are bundled, no `node_modules` needed). Step-by-step: [docs/publish-and-install.md](docs/publish-and-install.md).
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

Models are written `providerID/modelID`; only the first `/` splits them (`openrouter/z-ai/glm-5.2` is provider `openrouter`, model `z-ai/glm-5.2`). Type `/relay` inside OpenCode (or ask the model for the relay status) to see the chain and the current state. `/relay` is a command whose template asks the model to call the `relay_status` tool and print its output verbatim, so using it costs one small model turn. The `relay_status` tool reports the chain, current model, switch count and whether the API key is set or missing (never the key itself). If you opt in to OpenRouter summaries (see Privacy), the helper model defaults to `z-ai/glm-5.2` (listed on the public OpenRouter models list as of 2026-10-18); change it with `handover.model`.

## How it works

1. A `session.error` event arrives. The failure is classified: `rate_limit`, `quota`, `auth`, `free_tier_403`, `model_not_found`, `server_5xx` or `timeout` can trigger a switch. `overflow`, `user_abort` (pressing Esc) and `unknown` never do.
2. The plugin picks the next model according to `mode` (see [Modes](#modes)) among models that are not permanently failed or cooling down. If none is left, or the per-session switch cap is reached, it tells you and stays on the current model.
3. It builds a structured handover: a summary, the tool calls so far (with DONE / FAILED / UNKNOWN status), files touched, open todos, and your last request verbatim. The summary is written by a helper model through OpenRouter only if you opted in (see Privacy); otherwise the handover carries the plain tail of the redacted transcript.
4. The plugin aborts the failed turn, sends the handover to the next model, and the work resumes there.
5. The choice is sticky for the session: later messages are pinned to the model that took over (`chain-recover` can move them back once a higher-ranked model recovers). If you pick a different model yourself, the pin is cleared.
6. Optional (off by default): a quality judge watches finished turns on secondary/tertiary models. Local heuristics flag a silent turn, repeated identical tool calls or repeated tool errors; only then does a cheap judge model see the redacted transcript tail and decide. Two consecutive `switch: true` verdicts switch to the next healthy, untried chain model — logged as `quality`, never counting as a failure for cooldowns. See the `judge.*` config rows.

Subagent sessions (those with a `parentID`) are skipped. Any internal error leaves the session on its current model; hooks never throw. Main-model traffic always goes through OpenCode; the plugin does not proxy it.

## Modes

`mode` decides where a failure moves the session and whether it ever comes back. In every mode, a model is skipped while it cools down (a cooldown that ends exactly now counts as over) or after a permanent failure (quota, auth, model not found: blacklisted for 24 hours, or until a turn on that model finishes without a plugin-seen failure), and `maxSwitchesPerSession` stops all switching.

| Mode | On a failure | Later turns |
| --- | --- | --- |
| `chain-sticky` (default) | First healthy model of the flat list `primary`, `secondary...`, `tertiary...` other than the failing one; a model already tried for the same failing turn is never chosen again. | Stay on the model that took over. No automatic return. |
| `chain-recover` | Same flat list, but a model already tried for the same failing turn is never chosen again, even if its cooldown has run out meanwhile. | On your next message, if a model ranked above the current one is healthy again, the session returns to the highest-ranked one (primary first). Back on the original model, the pin is cleared; if the turn instead arrives on the old fallback, it re-pins to the recovered model (the TUI may keep sending the old one). |
| `escalate` | Tiers read cheap to strong. A failure in tier T moves to the first healthy model of tier T+1; a tier with no healthy model (or no model at all) is skipped. Siblings in the same tier and lower tiers are never tried, so the session never moves down or sideways. Exhausted once the top tier fails. | Stay on the model that took over. No automatic return. |

Worked example with `primary: A`, `secondary: [B1, B2]`, `tertiary: [C]`, and A hitting a rate limit (60 s cooldown):

- `chain-sticky`: A fails -> B1. If B1 fails too -> B2, then C. Later messages stay on whichever model took over.
- `chain-recover`: A fails -> B1. Your next message 30 s later still goes to B1 (A is cooling). Your message 60 s or more after the failure goes to A again and the pin is cleared. Had A failed permanently, the session would stay on B1.
- `escalate`: A fails -> B1. If B1 fails -> C (B2 is not tried). If C fails -> exhausted.

A return in `chain-recover` is not a failure: it does not count towards `maxSwitchesPerSession` and is written to the switch log with kind `recover`. It happens only on a message you send, never on the plugin's own handover message and never while a switch is in progress. There is a budget: recovery stops one switch before the cap (never strand the session on a failing model at the limit) and is itself capped, with both counts visible in `relay_status` as `switches` and `recoveries`. Picking a different model yourself still clears the pin in every mode. Model health (cooldowns and blacklists) is persisted in `state.json`, so it survives an OpenCode restart; a blacklist still expires after 24 hours and lifts as soon as a turn on that model ends cleanly.

## Configuration

Run `/relay-init` inside OpenCode to create a commented default config. It asks the model to call the `relay_init` tool (one small model turn), which writes the file below with `privacy.consent: false`, lists the `provider/model` ids from your configured providers (first 40), and prints next steps: edit the tiers, set consent only if you accept sending a redacted transcript to OpenRouter, and set `OPENROUTER_API_KEY` (never written to the file). It never overwrites an existing file, only writes inside the config directory (directory mode 0700, file mode 0600), and if it cannot list models it still writes the file. The tiers in the file are always commented-out examples (the file is harmless until you edit it); up to 10 of your configured models are listed in a comment block to pick from.

File: `~/.config/opencode/opencode-model-relay.jsonc` (JSONC, max 64 KB). It is read from the user config directory only, never from a project. `XDG_CONFIG_HOME` overrides the base directory. An invalid file falls back to defaults and shows a warning toast. Unknown keys are rejected.

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `mode` | `"chain-sticky"` \| `"chain-recover"` \| `"escalate"` | `"chain-sticky"` | See [Modes](#modes). An unknown value falls back to the defaults with a warning toast. |
| `tiers.primary` | `"provider/model"` | unset | If unset, the model currently in use heads the chain. |
| `tiers.secondary` | `"provider/model"[]` | `[]` | Tried after primary, in order. |
| `tiers.tertiary` | `"provider/model"[]` | `[]` | Tried after secondary, in order. |
| `privacy.consent` | boolean | `false` | Must be `true` before anything is sent to OpenRouter. |
| `privacy.zdr` | boolean | `false` | Adds `provider.zdr: true` to helper requests (zero data retention endpoints only). |
| `openrouter.keyEnv` | string | `"OPENROUTER_API_KEY"` | Name of the environment variable that holds the key. The key is never read from config. |
| `openrouter.baseUrl` | URL string | `"https://openrouter.ai/api/v1"` | Must be `https`, and host `openrouter.ai` unless `allowCustomBaseUrl` is true. |
| `openrouter.allowCustomBaseUrl` | boolean | `false` | Allows another `https` host. |
| `handover.model` | string | `"z-ai/glm-5.2"` (on the OpenRouter models list, verified 2026-10-18) | OpenRouter model that writes the summary. |
| `handover.writerPrompt` | string | built-in prompt | System prompt for the summary writer. |
| `handover.messageTemplate` | string | built-in template | Placeholders: `{{from}} {{to}} {{reason}} {{summary}} {{toolCalls}} {{files}} {{todo}} {{lastRequest}}`. |
| `handover.maxToolChars` | positive integer | `1500` | Per tool output cap before truncation. |
| `handover.maxTranscriptChars` | positive integer | `60000` | Transcript cap (internally limited to 60000). |
| `handover.maxCallsPerSession` | integer >= 0 | `3` | Helper-model calls per session; after that the plain tail is used. |
| `judge.enabled` | boolean | `false` | Opt-in quality judge: after a finished turn, if the local heuristics find the turn suspicious, a judge model decides whether to switch to a healthier chain model. Never applies to the primary tier or its own handover turns. Two consecutive `switch: true` verdicts are required for a switch (no cooldown recorded for it). |
| `judge.model` | string | `"google/gemini-2.5-flash-lite"` | OpenRouter model that judges. Keep it cheap: it runs after idle turns. |
| `judge.prompt` | string | built-in prompt | System prompt for the judge; must answer strict JSON `{switch, reason, confidence}`. |
| `judge.maxCallsPerSession` | integer >= 0 | `3` | Judge calls per session (failed calls count). |
| `judge.minIntervalMs` | integer >= 0 | `60000` | Minimum time between judge calls per session. |
| `judge.maxDailyUsd` | number | `0.5` (max 100) | Per-day judge spend cap across all sessions. |
| `cooldownMs` | positive integer | `60000` | Base cooldown for a temporarily failed model; doubles per repeat, capped at 1 hour. A `Retry-After` header is honoured. |
| `maxSwitchesPerSession` | positive integer | `6` | Hard cap on switches per session. |
| `onExhausted` | `"stop"` | `"stop"` | Only behaviour in v1.0. |
| `narrator.verbosity` | `"off"` \| `"quiet"` \| `"normal"` \| `"chatty"` | `"normal"` | `quiet` shows only exhausted, cap and config problems. `chain-recover` returns to a recovered model get their own `recovered` toast (facts: from, to) at `normal` and up. |
| `narrator.tone` | `"plain"` \| `"british"` | `"plain"` | `plain` is terse. `british` is opt-in dry humour (tea, queueing, "Plan B"): every message still states the facts first (models, reason, or the actual condition), static text only, no repeats back to back. |
| `ledger.enabled` | boolean | `true` | Write the local switch log. |
| `ledger.dir` | string | unset (data dir) | Must resolve inside the data directory, otherwise the data directory is used. |

## Privacy

- Nothing leaves your machine except through OpenCode itself, unless you opt in. The only direct calls the plugin makes are the optional handover summary and (if `judge.enabled`) the optional quality judge, both to OpenRouter.
- Opt in with `"privacy.consent": true` and an OpenRouter key in the environment variable named by `openrouter.keyEnv`. Without both, no network call is made: the handover uses the plain transcript tail and the judge does not run. You get a one-time toast saying so.
- Every helper request sends `provider.data_collection: "deny"`. With `privacy.zdr: true` it also requests zero-data-retention routing.
- Everything sent passes through a redaction step first (private keys, common API token formats, bearer tokens, `KEY=value` lines, auth and cookie headers, URL credentials, secret-looking query parameters and CLI flags). Output of tools that touched sensitive paths (`.env`, SSH keys, `.pem`, `.npmrc`, `.netrc`, `credentials`, `secrets.json` and similar) is dropped. Redaction is pattern-based and best effort, not a guarantee.
- The helper request goes only to the configured base URL over `https`, with redirects not followed. The key is never written to config, logs, the switch log or error messages.
- Transcripts and tool output are treated as untrusted data. The handover message says it is a model-generated summary, not user instructions.
- Stored locally under `~/.local/share/opencode-model-relay` (or `$XDG_DATA_HOME/opencode-model-relay`):
  - `switches.jsonl`: one row per switch with timestamp, HMAC'd session id, from/to model, failure kind (or `recover` for a `chain-recover` return) and optional helper cost. Metadata only, no prompt or response text.
  - `state.json`: per-session sticky model and counters (helper/judge call counts, cooldowns, the optional daily judge spend bucket).
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
| Quality-failure judge | no | optional, opt-in: local heuristics + a cheap LLM judge (`judge.enabled`) |

This table reflects the author's reading of both projects; check their READMEs for current behaviour.

## Roadmap

- OpenCode v2 plugin API port (`@opencode/plugin` `Plugin.define`, native zero-turn `/relay` via `ctx.session.synthetic`, `ctx.session.hook("retry")` + `switchModel`): tracked in #56.
- v1.2: per-model 30-day performance ledger and `/relay stats` (#7, after #56).

## Known limits

- Verified headless against a real OpenCode server (see [docs/e2e-v1.0.md](docs/e2e-v1.0.md)); behaviour in the TUI (toast, the Esc keypress, `/relay`) is unconfirmed (#19). Model pinning is covered in [docs/spike.md](docs/spike.md).
- Real 403, 429 and quota error payloads have not been captured yet; those classifications rely on message and status matching tested with hand-written payloads (#18).
- `/relay` always costs one small model turn, because OpenCode plugin commands cannot run without the model.
- `free_tier_403` detection is by error-message match and may miss other wordings.
- Subagent sessions are not handled, and the plugin does not support per-agent chains.
- The helper summary and the judge need an OpenRouter key; no other provider is supported for either.

## Development

Development and tests need Node >= 20.19 (vitest 4 / vite 8; CI uses 22, see `.node-version`); the published plugin itself runs on Node >= 20.

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
