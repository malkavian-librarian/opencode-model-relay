# opencode-model-relay

> Status: v1.0.0 tagged but not yet on npm (publish owner-gated, [#5](https://github.com/malkavian-librarian/opencode-model-relay/issues/5)); build and copy locally per the Quick start.

An [OpenCode](https://opencode.ai) plugin that keeps a session going when the current model fails: it classifies the failure, moves to the next model in your chain, hands the work over with a structured summary, and resumes.

## Quick start

1. Add the plugin to `opencode.json` once it is published: `"plugin": ["opencode-model-relay"]` on OpenCode 1.x, `"plugins": ["opencode-model-relay"]` on OpenCode 2. Until then, build it (`npm ci; npm run build`) and copy `dist/index.js` into `~/.config/opencode/plugins/` (or `<project>/.opencode/plugins/`); the build is self-contained (zod and jsonc-parser are bundled, no `node_modules` needed). Step-by-step: [docs/publish-and-install.md](docs/publish-and-install.md).
2. Create `~/.config/opencode/opencode-model-relay.jsonc`:

```jsonc
{
  "levels": [
    "anthropic/claude-sonnet-4-5",
    "openrouter/z-ai/glm-5.2",
    "openrouter/deepseek/deepseek-chat"
  ]
}
```

Models are written `providerID/modelID`; only the first `/` splits them (`openrouter/z-ai/glm-5.2` is provider `openrouter`, model `z-ai/glm-5.2`). Levels are tried from the top, and the first healthy candidate wins. Type `/relay` inside OpenCode to see the ladder and current state. On OpenCode 2, `/relay` is a native zero-turn command; on OpenCode 1.x it costs one small model turn. `/relay model <provider/model>` forces a specific switch and `/relay next` takes the next healthy ladder hop. If you opt in to OpenRouter summaries (see Privacy), the helper model defaults to `z-ai/glm-5.2`; change it with `handover.model`.

## How it works

1. A `session.error` event arrives. The failure is classified: `rate_limit`, `quota`, `auth`, `free_tier_403`, `model_not_found`, `server_5xx` or `timeout` can trigger a switch. `overflow`, `user_abort` (pressing Esc) and `unknown` never do.
2. The plugin walks `levels` from the top, skipping the failed, unhealthy, already-tried and recently quarantined models. A find level resolves lazily at failover time. If the walk is exhausted, it tries the deepest healthy level; if none exists, it explains the failure and suggests `/relay next`.
3. It builds a structured handover: a summary, the tool calls so far (with DONE / FAILED / UNKNOWN status), files touched, open todos, and your last request verbatim. Tool names and tool parts follow the OpenCode message shape, while file and todo extraction remains independent of the tool name. The summary is written by a helper model through OpenRouter only if you opted in (see Privacy); otherwise the handover carries the plain tail of the redacted transcript.
4. The plugin aborts the failed turn, sends the handover to the next model, and the work resumes there.
5. The choice stays put for the session. A manual model pick is adopted under the same lock, clears that model's health marks once and opens a short grace window; the plugin never auto-recovers to a higher level.
6. Optional (off by default): a quality judge watches finished turns below level 1. Local heuristics flag a silent turn, repeated identical tool calls or repeated tool errors; only then does a cheap judge model see the redacted transcript tail and decide. Two consecutive `switch: true` verdicts trigger a `quality` switch.

Subagent sessions (those with a `parentID`) are skipped. Any internal error leaves the session on its current model; hooks never throw. Main-model traffic always goes through OpenCode; the plugin does not proxy it.

## OpenCode 2 (v2 plugin API)

The plugin ships both plugin shapes in one file: the v1 `server()` hooks and the v2 `setup(ctx)` layer. Which one runs is decided by the host binary, per process:

- **OpenCode 1.x** calls `server()` at boot: the hooks described above run unchanged. The v2 `setup()` call that 1.x also makes carries only a partial context, so the v2 layer stays dormant — no registers, no double handling.
- **OpenCode 2.x** calls `setup(ctx)` with the full v2 surface. The relay then uses `ctx.session.hook("retry")` (igniting switch + vetoing OpenCode's own retry), a cross-project event stream routed by session id, pinning through `ctx.session.switchModel` before model resolution, and the `context` hook to detect an explicit user pick. The v1 hooks stand down in that process (the relay decides once per process, never twice).
- On v2, `relay_status` / `relay_init` are registered as real tools and `/relay` / `/relay-init` are native commands that print status via a synthetic message — no model turn required. `/relay model <provider/model>` forces a plain-tail switch and `/relay next` takes the next healthy ladder hop; both report progress immediately and completion without an LLM narrative.

Details and the verified runtime shapes: [docs/spike-v2.md](docs/spike-v2.md).

## Levels and manual commands

`levels` is an ordered ladder of exact `provider/model` strings or `{ "find": { "match", "free", "via" } }` matchers. It is capped at 32 entries, deduplicated with the first occurrence winning, and invalid entries produce a warning naming their index. Failover walks from level 1. A model that failed in this session is quarantined for 10 minutes where possible, but quarantine is a preference rather than a veto when it is the only healthy candidate. Reset-aware cooldowns are capped at six hours; the configured default switch cap grows to `max(6, levels.length + 1)`, while other explicit values win.

The deprecated `tiers` shape is accepted and auto-migrated (`primary` to level 1, then `secondary` and `tertiary` in order), with a warning. If both are present, explicit `levels` wins and `tiers` is not merged. The old `mode` key is ignored with a deprecation warning.

- `/relay model <provider/model>` switches immediately using the plain-tail path, clears the chosen model's health marks once, logs `manual`, and is exempt from the automatic switch cap.
- `/relay next` walks to the next healthy ladder candidate using the same fast path. At the bottom it reports the condition instead of silently doing nothing.

## Configuration

Run `/relay-init` inside OpenCode to create a commented default config. It writes `privacy.consent: false`, lists up to 40 configured `provider/model` ids, and leaves the example `levels` ladder commented. Its generated comments and next steps still say "the levels ladder is not active yet" and recommend configuring `tiers` (`primary`, `secondary`, and `tertiary`). That bootstrap text is outdated: the runtime uses `levels` now. You can configure `levels` directly using the table below, or use the legacy `tiers` shape, which migrates on load. The remaining next steps cover consent and `OPENROUTER_API_KEY` (never written to the file). The command never overwrites an existing file and stays inside the user config directory.

File: `~/.config/opencode/opencode-model-relay.jsonc` (JSONC, max 64 KB). It is read from the user config directory only, never from a project. `XDG_CONFIG_HOME` overrides the base directory. An invalid file falls back to defaults and shows a warning toast. Unknown keys are rejected.

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `mode` | deprecated | ignored | Removed from runtime configuration: failover uses the levels ladder. Loading a file with this legacy key ignores it and warns once about mode while preserving and validating all other settings, including automatic tiers migration. |
| `levels` | `"provider/model"` \| `{ "find": { "match": string, "free"?: boolean, "via"?: "openrouter" } }`[] | `[]` | Ordered ladder, walked from the top. Max 32 entries; duplicates drop, first wins. Find entries resolve lazily and skip when consent is off. Invalid entries fall back to defaults with a warning naming the level index. |
| `tiers` | object with `primary`, `secondary[]`, `tertiary[]` | `{}` | Deprecated compatibility shape. Auto-migrates to `levels` in that order; explicit `levels` wins when both are present. |
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
| `handover.maxCallsPerSession` | integer >= 0 | `3` | Helper-model calls per session; after that the plain tail is used. Plain-tail resume is the default critical path; optional narratives run asynchronously after resume. |
| `judge.enabled` | boolean | `false` | Opt-in quality judge: after a finished turn, if local heuristics find it suspicious, a judge model decides whether to switch below level 1. Two consecutive `switch: true` verdicts are required (no cooldown is recorded for a quality switch). |
| `judge.model` | string | `"google/gemini-2.5-flash-lite"` | OpenRouter model that judges. Keep it cheap: it runs after idle turns. |
| `judge.prompt` | string | built-in prompt | System prompt for the judge; must answer strict JSON `{switch, reason, confidence}`. |
| `judge.maxCallsPerSession` | integer >= 0 | `3` | Judge calls per session (failed calls count). |
| `judge.minIntervalMs` | integer >= 0 | `60000` | Minimum time between judge calls per session. |
| `judge.maxDailyUsd` | number | `0.5` (max 100) | Per-day judge spend cap across all sessions. |
| `cooldownMs` | positive integer | `60000` | Base cooldown for a temporarily failed model; reset-aware cooldowns are capped at six hours. |
| `maxSwitchesPerSession` | positive integer | `6` | Automatic cap; the default scales to at least `levels.length + 1`. Manual commands are exempt. |
| `maxCircularFlows` | integer `0`–`3` | `0` | Opt-in deterministic circular failover cap. One flow returns to its origin after at least two model transitions (for example `A -> B -> C -> A`); zero preserves the normal top-down walk. |
| `onExhausted` | `"stop"` | `"stop"` | Exhaustion falls back to the deepest healthy level; if none exists, the user is told to run `/relay next`. |
| `narrator.verbosity` | `"off"` \| `"quiet"` \| `"normal"` \| `"chatty"` | `"normal"` | `quiet` shows only exhausted, cap and config problems. |
| `narrator.tone` | `"plain"` \| `"british"` | `"plain"` | `plain` is terse. `british` is opt-in dry humour (tea, queueing, "Plan B"): every message still states the facts first (models, reason, or the actual condition), static text only, no repeats back to back. |
| `ledger.enabled` | boolean | `true` | Write the local switch log. |
| `ledger.dir` | string | unset (data dir) | Must resolve inside the data directory, otherwise the data directory is used. |

## Privacy

- Main-model traffic goes through OpenCode. The plugin's direct network calls are the optional handover summary, the optional quality judge, and the consent-gated public catalog lookup; nothing leaves your machine without opt-in.
- A `find` level using `via: "openrouter"` reads the public `GET /api/v1/models` catalog only when `privacy.consent` is true. The request carries no API key, transcript, or other user data, uses HTTPS, follows no redirects, and has a bounded response. Returned model ids are treated as untrusted data: malformed rows are ignored and ids are length-limited and validated against the allowed `provider/model` format before they can reach switching or handover text.
- Helper calls require `"privacy.consent": true` and an OpenRouter key in the environment variable named by `openrouter.keyEnv`. Without both, the handover uses the plain transcript tail and the judge does not run; a one-time toast explains this. Public catalog discovery requires consent but no key.
- Every helper request sends `provider.data_collection: "deny"`. With `privacy.zdr: true` it also requests zero-data-retention routing.
- Everything sent to a helper or judge passes through a redaction step first (private keys, common API token formats, bearer tokens, `KEY=value` lines, auth and cookie headers, URL credentials, secret-looking query parameters and CLI flags). Catalog discovery sends no user data or secrets; any catalog id later included in handover text remains validated untrusted data. Output of tools that touched sensitive paths (`.env`, SSH keys, `.pem`, `.npmrc`, `.netrc`, `credentials`, `secrets.json` and similar) is dropped. Redaction is pattern-based and best effort, not a guarantee.
- Failover resumes on the plain-tail handover without waiting for a narrative: the hard latency budget is 6 seconds (5-second abort race plus the 300 ms handoff delay), with a typical budget of 2 seconds when abort completes promptly. If `privacy.consent` is false, or the configured `openrouter.keyEnv` is missing, no narrative call is made. Only enacted switches spend narrative attempts. Plain tails say a narrative is deferred only when one is scheduled; manual switches and ineligible calls use a neutral no-summary label. A late narrative is discarded if the resumed model, turn or handover intent changed, or the session lock is busy.
- The helper request goes only to the configured base URL over `https`, with redirects not followed. The key is never written to config, logs, the switch log or error messages.
- Transcripts and tool output are treated as untrusted data. The handover message says it is a model-generated summary, not user instructions.
- Stored locally under `~/.local/share/opencode-model-relay` (or `$XDG_DATA_HOME/opencode-model-relay`):
  - `switches.jsonl`: one metadata row per switch attempt with timestamp, HMAC'd session id, from/to model, failure kind, `manual` or `switch_dropped` kind (with its enum reason), elapsed time and optional helper cost. No prompt or response text.
  - `state.json`: per-session `pluginPinned` model, adoption/quarantine state and counters (helper/judge calls, cooldowns, the optional discovery cache and daily judge spend bucket).
  - `salt`: the random per-install salt used for the session-id HMAC.

## Reading the switch log

`/relay status` is the operational dashboard. It lists the configured ladder in order,
including whether a find level is `unresolved`, `consent-gated`, or resolved to a
cached model (with its cache age), then shows each level's health. Health is either
`healthy`, a remaining cooldown, or a `blacklisted-until` timestamp. The dashboard
also shows `pluginPinned`, the most recent `adoptedAt`, the switch count, key presence
(`set` or `missing`, never the key), the consent state, the last ten ledger rows, and
separate manual and automatic counts for those rows.

Each `switches.jsonl` row is metadata-only and uses these fields:

| Field | Meaning |
|---|---|
| `ts` | Numeric Unix timestamp recorded when the event starts. |
| `session` | The first 16 hexadecimal characters of the per-install HMAC of the OpenCode session id. |
| `from` / `to` | The source and destination `provider/model` identifiers, when known. |
| `kind` | An enum: failure kind, `quality`, `manual`, or `switch_dropped`. |
| `reason` | For `switch_dropped` only: `lock_held`, `marker_guard`, or `superseded`. |
| `elapsedMs` | Finite, non-negative numeric duration for the operation. |
| `helperCostUsd` | Optional finite, non-negative helper-call cost. |

Rows never contain prompts, responses, provider free text, raw session ids, API keys,
or other secrets. `from` and `to` are accepted only as identifier-shaped
`provider/model` references; malformed ledger rows are skipped, and invalid append
values are represented by a fixed unknown reference. `switch_dropped` is useful because a dropped attempt is visible
without pretending that a switch happened. The October evidence in the levels plan
shows why: the real entries recorded `openai/gpt-6.1-sol` →
`opencode/glm-5.3-flash-free` as `rate_limit`, `opencode/muse-spark-1.3` →
`openai/gpt-6.1-sol` as `quota`, `openrouter/meta/muse-wonder` →
`openai/gpt-6.1-sol` as `auth`, and the final two
`opencode/glm-5.3-flash-free` → `openai/gpt-6.1-sol` entries as `rate_limit`.
The same evidence records `openai/gpt-6.1-sol` as permanently marked at exactly
10:02:49 on October 23, with no switch logged afterward. That 10:02 permanent-mark
gap was therefore visible as a failure with no corresponding failover row; a future
lock-held, marker-guard, or superseded attempt is represented explicitly as
`switch_dropped` with its reason and elapsed time.

The log is size-bounded: on each append, rows older than 30 days (the ledger's
default read window) are compacted away in one atomic rewrite gated on the
file's oldest row, so most appends rewrite nothing; `/relay purge` also clears
the file outright.

## Reading the event ledger and stats

Besides `switches.jsonl`, the relay writes a per-turn event ledger on OpenCode v2 to
`events-<pid>.jsonl` in the same data directory: same `ledger.enabled` switch, same
`salt` file as the switch log, so session ids hash identically. When the active
file's first row belongs to an older UTC month, it is rotated to
`events-<pid>-<YYYYMM>.jsonl` on the next append. Reads validate every row with the
same zod schema the writer used and skip corrupt lines and unreadable files,
retaining events from the files that can be read.

Each event row is metadata-only and uses these fields:

| Field | Meaning |
|---|---|
| `ts` / `session` | As in the switch log. |
| `event` | `turn` (a completed turn), `failure` (an accepted non-quality failure mark), `judge` (a quality-judge verdict), `switch` (an enacted or dropped switch), or `narrative` (successful deferred helper work with known cost). |
| `model` / `tier` | The affected `provider/model` and its 1-based ladder position, when known. |
| `latencyMs`, `tokens`, `cost` | Optional turn measurements; only fields the host actually provides are recorded. `cost` is the selected assistant message's finite non-negative USD spend, including explicit zero, not an estimate or sum of all assistant steps. |
| `errorKind` | For `failure` rows: the failure-kind enum. |
| `verdict` | For `judge` rows: `switch` or `stay`. Only valid verdicts are recorded; an errored judge call is not a `stay`. |
| `sw` | Required for `switch` rows: `kind`, plus `reason` for `switch_dropped` and `from`/`to` when known. |
| `helperCostUsd` | Optional judge-call cost; required finite non-negative USD cost (including zero) for `narrative` rows, which also require `model`. |

`failure` counts accepted non-quality health marks, not every raw provider error.
Marker-rejected and message-dedup-rejected errors, and errors whose re-marking is
suppressed by adoption grace, add no failure row. An accepted mark counts even
when no healthy destination exists and no switch is enacted. Existing dedup TTL
semantics remain; historical rows are not corrected or backfilled.

Narrative spend belongs to the original switched-from model and completion-time UTC
day, even if the result is stale or cannot be delivered. A narrative row has no
`sw`, `verdict` or `errorKind` and adds no turn, judge, failure or switch activity.
The immediate append-only `switches.jsonl` row is unchanged: it precedes narrative
completion and cannot include that deferred cost. The event ledger is authoritative
for this spend; no second switch row or historical backfill is written.

`/relay stats [--days N] [--kinds]` (OpenCode v2 only; the `relay_stats` tool is
the same surface with optional `days` (integer 1-30, default 30) and `kinds`
(boolean)) prints a per-model table over the selected rolling window: turns,
failures, the share of tier-2/3 judge verdicts that said `switch`, how often the
model was switched away from, survival (the share of turns followed by another
turn on the same model in the same session within 30 minutes or 5 turns with no
effective switch in between; turns with no observable outcome are censored and
excluded), median latency, token and known turn USD cost totals (`cost$`), and
known judge plus narrative overhead (`helper$`). The window is exact event
timestamps: only events with `now - N*86400000 <= ts <= now` count, inclusive at
both ends and never a UTC-day label. Median latency is the median of every
retained turn sample in that window, not a median of daily medians. Invalid
options (missing, out-of-range or non-integer `days`, unknown or duplicate
flags, `--days=7`, a value after `--kinds`, stray tokens, or any wrong tool
input shape) print `Usage: /relay stats [--days N] [--kinds]` and change
nothing. `--kinds` (tool: `kinds: true`) adds one breakdown line per model with
its nonzero failure kinds and counts in lexicographic order, `none` when
failure-free; the counts sum to the model's `fails` column. These are not a
complete provider invoice: absent/invalid costs are not estimated, and
failed/null narrative results may have unknown spend.

A schema-versioned `stats.json` (v1) is derived from the ledger with an atomic
write on startup and again immediately after a purge: a best-effort snapshot of
the default 30-day window, not continuously current between events and never
rewritten for a short-window query. A missing or corrupt file is ignored and
rebuilt.

`/relay purge` (or the `relay_purge` tool, which takes no arguments; both
OpenCode v2 only) deletes every `events-*.jsonl` file inside the ledger
directory and clears `switches.jsonl`, touching nothing else, then rebuilds
`stats.json` from what remains right away, while `state.json`, config and the
`salt` are untouched. If that
snapshot write fails, the purge still reports its file count plus a fixed
sanitized warning (`Warning: the stats snapshot could not be refreshed.`) and
leaves the previous `stats.json` as it was. If the switch log cannot be cleared,
both purge surfaces append `Warning: the switch log could not be cleared.`;
event purging and snapshot refresh still proceed. Stats and purge command/tool
surfaces are V2-only: v1 keeps its `relay_status` / `relay_init` surfaces and
the shared startup snapshot behavior.

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
| Config | per-agent chains | ordered `levels` (deprecated `tiers` auto-migrate) |
| Stay-put per session | not documented | yes |
| Quality-failure judge | no | optional, opt-in: local heuristics + a cheap LLM judge (`judge.enabled`) |

This table reflects the author's reading of both projects; check their READMEs for current behaviour.

## Roadmap

- ~~OpenCode v2 plugin API port~~ (`@opencode/plugin` avoided: the bundle self-defines the plugin object; native zero-turn `/relay` via `ctx.session.synthetic`, `ctx.session.hook("retry")` + `switchModel`): done, #56.
- v1.2: per-model 30-day performance ledger and `/relay stats` (#7) — shipped (event ledger, `stats.json`, `/relay stats`, `/relay purge`).

## Known limits

- Verified headless against a real OpenCode server (see [docs/e2e-v1.0.md](docs/e2e-v1.0.md)); behaviour in the TUI (toast, the Esc keypress, `/relay`) is unconfirmed (#19). Model pinning is covered in [docs/spike.md](docs/spike.md). On v2 the port ran live against OpenCode 2.1.3 ([docs/spike-v2.md](docs/spike-v2.md)); a forced failover under v2 could not be triggered without a real provider error yet.
- On OpenCode 2 the event bus is user-wide: several relay processes (e.g. two projects at once) each see all events. Switches are deduplicated per process by the session lock and the handover marker; cross-process double events rely on that same state, not on a shared lock.
- Real 403, 429 and quota error payloads have not been captured yet; those classifications rely on message and status matching tested with hand-written payloads (#18).
- `/relay` costs one small model turn on OpenCode 1.x (plugin commands cannot skip the model turn there); on 2.x it is a native command.
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
