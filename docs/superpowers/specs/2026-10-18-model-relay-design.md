# opencode-model-relay: design spec

Status: DRAFT v2 (revised after a four-critic panel: API feasibility, security/privacy, reliability, product/scope). Date: 2026-10-18.
Name: `opencode-model-relay` (npm name checked free on 2026-10-18; repo folder is `model-relay`).
Release cut line decided: staged v1.0 / v1.1 / v1.2, see section 13.

## 1. Purpose

An OpenCode plugin that keeps a coding session alive when the current model fails or underperforms. It detects failure, decides whether to switch, builds a handover, and resumes the work on another model in the same session, with an optional asynchronous model-written narrative. Per-model performance history remains planned for #7.

Why it exists: the installed `opencode-auto-fallback` keeps one flat model list, has no judge and no handover, and on the author's machine its free `opencode/*` models hit OpenCode's gateway 403 (`FreeTierError`: "free tier can only be used from within OpenCode"). Our edges over it: structured handover that preserves session state, ordered levels with a quality judge, and planned per-model performance history.

Audience: the author first; then public GitHub/npm users who bring their own OpenRouter key.

## 2. Scope

In scope: ordered-level switching, judge, handover, narrator, switch log, `/relay` commands, schema-validated config, npm packaging, public repo. Strategy modes were removed by the levels redesign; full performance analytics remain planned (#7).
Out of scope: prompt optimisation per model (future: GLM reads `stats.json`), auto-learned model order, request proxying, TUI settings screen, seeded/forked sessions as a default route (see 6.3), remote state.
Delivery is staged (section 12-13); everything above remains the target design.

## 3. Hard constraints

1. **No request proxying.** Main-model traffic always goes through OpenCode. The plugin calls OpenRouter directly only for helpers (judge, handover) and consent-gated public catalog discovery. Catalog requests carry no key or user data.
2. **Key handling.** OpenRouter key comes from an env var (default `OPENROUTER_API_KEY`), never from the config file, ledger or logs. `openrouter.baseUrl` must be https, defaults to openrouter.ai, and changing it requires `allowCustomBaseUrl: true`. Requests use `redirect: "manual"` so the Authorization header is never forwarded. Redaction covers thrown errors and response bodies.
3. **Data egress is opt-in.** Judge and handover send session content to OpenRouter and onward to whichever provider serves the model. Nothing is sent until `privacy.consent: true`, including catalog discovery. Until then the plugin runs local-only (hard-failure switching, plain-tail handover). First run shows a toast explaining this. Helper requests also require the environment key and set `provider.data_collection: "deny"`; optional `privacy.zdr`.
4. **Redaction before egress.** A mandatory `redact` unit strips secret patterns (sk-/ghp_/AWS keys, JWTs, PEM blocks, `KEY=value` lines) and drops tool output read from `.env*`, key and credential files. Per-call byte cap.
5. **Untrusted content.** Transcripts are wrapped as delimited data blocks the judge/writer are told not to obey. Judge output is strict JSON, schema-validated, `reason` capped and control-chars stripped. The handover message states it is a model-generated summary, not user instructions; the user's last request is carried verbatim and separately. A judge verdict never changes permissions; nothing is auto-approved after a switch.
6. **Config is user-level only.** Load from the user config dir, never from the project tree. `ledger.dir` must resolve (symlinks included) under the plugin's data dir. The earlier `narrator.extraPool` proposal is historical (section 7). Parse JSONC with a size cap; never eval or require config.
7. **Ledger holds metadata only**, no prompt or response text; reasons and error kinds are enums, never free provider text.
8. **Fail safe.** Any internal failure leaves the session usable on its current model.

## 4. Concepts

The levels redesign adopts the dispositions in [the plan's section 6](../plans/2026-10-23-model-relay-levels-redesign.md#6-adversarial-panel--round-1-2026-10-23); the shipped issues take precedence if the plan and implementation differ.

- **Level:** an ordered `levels` entry, either a `providerID/modelID` string or a `{ find: { match, free?, via? } }` matcher. The ladder is capped at 32 entries and deduplicated, keeping the first occurrence. A legacy `tiers` object is accepted only as a compatibility input and migrates to levels in `primary`, `secondary`, `tertiary` order; explicit `levels` wins when both are present.
- **Failure kinds** (classifier output `{kind, retryable, retryAfterMs, permanent}`) are `rate_limit`, `quota`, `auth`, `free_tier_403`, `server_5xx`, `timeout`, `model_not_found`, `overflow`, `user_abort`, `unknown`, and `quality`. Overflow, user abort and unknown are not automatic switch triggers.
- **Stay-put:** the plugin switches only for failover or an explicit manual command. There is no automatic recovery mode or pin rewrite on ordinary turns. The model the plugin last set is persisted as `pluginPinned`.
- **Failover walk:** on a switchable failure, walk from level 1, skipping the current model, unhealthy models, models tried in the same turn and recently quarantined models. Quarantine lasts 10 minutes per session and is a preference: the quarantined model may be used when it is the only healthy candidate. A matcher resolves lazily during the walk; unresolved levels are skipped.
- **Manual adoption:** a context model different from `pluginPinned` is the owner's pick. Adoption merges the session record under the session lock, sets `pluginPinned`, clears that model's health marks once and records a short grace window. A pending failover re-reads the model after abort and abandons itself when the pick supersedes it.
- **Health:** transient failures use exponential cooldowns with reset-aware deadlines capped at six hours; permanent quota/auth/model-not-found marks are retained for 24 hours. A successful turn clears cooldown and permanent marks but keeps the failure count. The default automatic switch cap is `max(6, levels.length + 1)`; an explicit non-default value wins and manual commands are exempt.
- **Discovery:** OpenCode find levels use the configured model list and the `-free` convention. `via: "openrouter"` reads the public catalog only at resolution time, filters by regex and free pricing, caches the result for 60 minutes and invalidates it when the resolved model fails. Discovery is skipped before consent, and external ids are bounded and validated before switching or handover text.
- **Exhaustion:** the controller tries the deepest healthy level as a last resort; if no candidate exists, it reports the condition and suggests `/relay next`.
- **Eligibility:** subagent sessions (`parentID`) and internal/non-token turns are skipped. Hooks fail safe and leave the current model in place.

## 5. Architecture

TypeScript, ESM, with `zod` and a JSONC parser; `@opencode-ai/plugin` is a peer dependency.

| Unit | Job |
|---|---|
| `config` | Load and validate user-level settings, migrate deprecated tiers, cap and deduplicate levels, resolve the environment key, and confine paths to the user config/data directories. |
| `classifier` | Classify `session.error` and retry-status input into the bounded failure-kind enum. |
| `strategy` | Walk the ordered levels, resolve find entries lazily, apply health/quarantine/tried-model rules, and return a switch target or exhaustion. |
| `session-lock` | Provide single-flight per-session mutual exclusion and deduplicate failure events; adoption, failover and deferred narrative checks share this lock. |
| `controller` | Enforce eligibility and attribution, record health/quarantine, adopt manual picks, persist `pluginPinned` before switching, enact failover, expose status and manual commands, and never throw into the host. |
| `judge` | Asynchronously apply local heuristics and, with consent and a key, call OpenRouter for a validated verdict; two consecutive positive verdicts can trigger a `quality` switch below level 1. |
| `handover` | Build the structured redacted handover and use the plain tail for immediate resume; an optional narrative is written asynchronously after an enacted switch. |
| `switchlog` | Append metadata-only rows with HMAC session ids, enum kinds/reasons, bounded model references and elapsed time; read a bounded, validated tail for status. |
| `command` | Register `/relay`, `/relay model <provider/model>` and `/relay next` on v2; emit immediate synthetic progress and completion feedback. The status tool is also available for the v2 API. |
| `openrouter` | Make consent-gated helper and public-catalog requests over HTTPS with host validation, bounded responses and no redirects. Catalog discovery sends no key or user data. |
| `redact` | Apply the section 3 redaction and truncation rules before helper egress. |
| `index` | Wire the v1 and v2 plugin surfaces while ensuring only the active host layer handles a session. |

API facts verified against `@opencode-ai/plugin` 1.17.x and the reference plugin: provider/model lists and context limits come from `client.config.providers()`; per-turn latency/tokens/cost come from `message.updated` on the assistant message (idle carries only sessionID); OpenCode retries retryable errors itself and emits `session.status {type:"retry"}` before `session.error`, so the plugin does not run its own backoff loop; `session.prompt` blocks for the whole turn so it is fired without await; subagent detection via `session.get` parentID.

## 6. Flows

### 6.1 Hard failure
`session.error` / retry status -> classifier -> gate (eligible session, not plugin-caused, lock free) -> levels walk -> redacted plain-tail handover -> persist `pluginPinned` and intent -> abort, re-read model and resume -> switch log. Optional narratives run asynchronously after an enacted switch.

### 6.2 Quality check (below level 1)
`session.idle` -> gate (no parentID, last assistant message completed with tokens > 0, not our own turn) -> heuristics/judge budget -> async judge -> two consecutive `switch:true` -> 6.1 from strategy onward.

### 6.3 Handover and route
Same-session plain-tail handover is the default route; the optional narrative follows asynchronously. The earlier `seedThreshold`-based compaction and seeded/forked-session routes are historical proposals, not runtime settings. Handover input is bounded by `maxTranscriptChars` and `maxToolChars`, then redacted before use.

## 7. Settings and commands (JSONC, schema-validated)

`levels` is the runtime ladder (section 4). Deprecated `tiers.primary` / `tiers.secondary[]` / `tiers.tertiary[]` migrate on load; explicit `levels` wins. Legacy `mode` is ignored with a warning. Current settings also include `privacy.{consent,zdr}`; `openrouter.{keyEnv,baseUrl,allowCustomBaseUrl}`; `judge.{enabled,model,prompt,maxCallsPerSession,minIntervalMs,maxDailyUsd}`; `handover.{model,writerPrompt,messageTemplate,maxToolChars,maxTranscriptChars,maxCallsPerSession}`; `cooldownMs`; `maxSwitchesPerSession`; `onExhausted`; `narrator.{verbosity,tone}`; `ledger.{enabled,dir}`. The [README configuration table](../../../README.md#configuration) describes types and defaults. Earlier proposals for `seedThreshold`, `maxHelperSpendUsdPerDay`, `narrator.extraPool` and `ledger.retentionDays` are historical, not accepted runtime settings.

Defaults: `tone` is `plain` (British is opt-in). `/relay-init` creates a commented default config with consent off and lists configured models; it never overwrites an existing file. Its template and next steps still say the levels ladder is not active and recommend `tiers`: this is stale bootstrap text, not the runtime contract. Configure `levels` directly or use `tiers` migration as documented in the README. Helpers require consent and a key; public catalog discovery requires consent only.

On v2, `/relay model <provider/model>` switches to an explicit model and `/relay next` walks downward to the next healthy candidate. Both give immediate feedback, use plain-tail resume, log `manual`, and are exempt from the automatic switch cap. `/relay` (including `/relay status`) shows status. The proposed `/relay pick` and `/relay init` spellings are historical and are not registered commands; use `/relay-init` for bootstrap.

## 8. Narrator

Facts first, flavour second: every message carries from-model, to-model and reason enum; the joke wraps them. Several variants per event, random pick avoiding repeats, no LLM calls. No emoji or sound as the only signal. Verbosity `off | quiet | normal | chatty`. The narrator is not on the critical path: a failure to deliver a toast is ignored.

## 9. Performance ledger

The metadata-only event ledger is shipped behavior. The current event schema and
stats surface are documented in [Reading the event ledger and stats](../../../README.md#reading-the-event-ledger-and-stats).

- Location: user data dir `~/.local/share/opencode-model-relay` (`XDG_DATA_HOME` overrides), never under the project tree. Directory 0700 / files 0600 on POSIX; on Windows rely on the user-private location and say so in docs.
- Raw: per-process `events-<pid>.jsonl` (or a lockfile), one line per append, readers skip corrupt lines, monthly rotation. Fields: epoch-ms ts, HMAC session id (random per-install salt), model, tier, mode, latencyMs, tokens, cost, errorKind enum, judge verdict, switch from/to/reason enum, helper-call cost. Every completed turn is recorded (needed as the denominator).
- Derived: `stats.json` (schema-versioned, atomic temp+rename write), per-model UTC daily buckets over a rolling 30 days: turns, failures by kind, judge rejection rate (below level 1), switch-away rate, survival, median latency, tokens, cost, helper overhead, clipped downtime (`downMs`), and off-primary usage share (`offPrimary`). Prune by `ts`, not bucket label; rebuild on startup.
- Health rows use named transitions (`cooldown_start`, `cooldown_end`, `permanent_mark`, `permanent_expire`, `quarantine_skip`, `exhausted`, `cap_hit`), model/tier metadata, and a numeric deadline only where applicable; emission is best effort and cannot change switching decisions.
- Survival: the next assistant turn on the same model in the same session completes with no switch within 30 minutes or 5 turns; sessions with no next turn are censored and excluded from the denominator.
- `/relay stats` prints the per-model table including relay overhead $; `/relay purge` deletes ledger data.

## 10. Failure handling and guards

Judge failure: hard failures still switch, quality check is a no-op. Handover failure: plain tail. Without consent, no discovery or helper egress; without a key, helper calls are skipped with one explanatory toast, while consent-gated public catalog discovery remains available. Guards: single-flight lock, plugin-abort marks, per-model backoff, no re-choosing a tried model, switch cap, helper call caps and daily judge spend cap; judge never evaluates helper calls. Logs never contain transcripts, are size-capped and rotated, key redacted. Ledger failures never affect the session.

Gotcha (2026-10-23, #59): usage-exhaustion wording fell through to `unknown`, and the
handover guard swallowed unattributed target failures -> classify exhaustion in both error
paths and require matching transcript/sticky context rather than model attribution alone.
Recorded here because `AGENTS.md` is above its append guard.

Usage exhaustion (#59): structured errors (message or response body) and retry text recognize
`The usage limit has been reached` as permanent `quota`, and `Free usage limit reached` as
permanent `free_tier_403`, with or without a 429. Usage-limit wording with an explicit
reset/try-again/retry hint is transient `rate_limit`; bare billing/subscription/usage-limit
mentions are not permanent evidence. Existing explicit auth, hard quota, abort and overflow
precedence is retained. Ordinary 429s still honor Retry-After. Reset-aware cooldowns (#64)
parse future ISO timestamps and local-time `resets at HH:mm` / `resets at 5pm` wording,
capped at six hours. Clock hours must be 0–23 (1–12 with am/pm) and minutes 0–59;
unsupported or invalid reset wording falls back to numeric Retry-After or exponential backoff.

Gotcha (2026-10-23, #64): `Date.setHours` normalizes out-of-range provider clock values
-> validate hours and minutes before setting a reset deadline. Recorded here because
`AGENTS.md` is above its append guard.

Failure attribution must match the newest message's model (assistant provider/model, or
user model before any assistant reply). When a relay-marker prompt is newest, its model
must also match persisted sticky state: an attributed target failure or an unattributed
failure then advances the chain, while an explicitly attributed old-model failure is
ignored without health/counter changes. Marker text alone supplies no model authority.
Missing/conflicting model context fails safe. Unattributed late old-model errors cannot
be distinguished from target failures by text alone; lock, message dedup, tried-model
exclusion and persisted switch/helper caps remain in force, without resetting counters.

The [V2 plugin API](https://opencode.ai/v2/docs/build/plugins) permits async retry hooks
with `{sessionID, agent, model: {providerID, id}, error: {type, message, status?}, attempt,
decision}`. Permanent exhaustion is eligible at attempt 1; transient failures only at
attempt 2. The callback awaits the controller's takeover result and vetoes native retry
only on takeover; child-session/lock/dedup/cap/exhaustion/invalid-input/internal-error
gates leave the native decision unchanged. The controller's enacted switch (`enactSwitch`)
reports a handover attempt, not successful continuation: V2 `session.prompt()` returns an
admitted inbox user item, not a completed model turn, and the controller's switch enactment
dispatches prompts without awaiting them. Admission failures after dispatch do not
retroactively change the retry decision.

Validation for #59 uses synthetic v1/v2 fixtures, not captured incident status or
attribution. Status/chain smoke only demonstrates loading/configuration, not failover,
fallback continuation or successful turn completion. Owner-assisted live captures and
isolated failover E2E remain tracked in [#18](https://github.com/malkavian-librarian/opencode-model-relay/issues/18).

## 11. Testing

- Unit (pure): classifier (real captured payloads incl. 403 FreeTierError, 429 with retry-after, quota, overflow, user abort), strategy (levels walk, exhaustion, tried-model rule), config + path confinement, redact (secret corpus), narrator pools, switch-log validation. Full ledger rollups/survival/UTC buckets remain planned with #7.
- Component with fakes: judge, handover, the controller switch enactment (abort races, subagent gate, dedup — see tests/controller.test.ts), lock.
- Recorded-event replay harness: real OpenCode event sequences replayed against the plugin; CI pinned to the plugin API version; compatibility matrix stated in the README.
- Manual end-to-end in live OpenCode with a deliberately failing primary.

## 12. Delivery phases

Historical roadmap from 2026-10-18, retained to explain the release decisions in
section 13. The levels redesign supersedes the tier-era milestones; the current
epic status is in [docs/process.md](../../process.md#epic-62-child-status-2026-10-25-live).

0. **Spike (gate; findings written to `docs/spike.md`):** (a) `/relay` via `config.command` + `command.execute.before` runs with no model turn; (b) `chat.message` model rewrite is honoured; (c) real error payload shapes; (d) `session.prompt({model})` mid-session behaviour and non-await resume; (e) compaction/summarise with a target model for the oversize route.
1. Repo scaffold, CI, README skeleton (written early to expose config confusion), LICENSE (MIT), SECURITY.md, CHANGELOG, `config`/`classifier`/`strategy`/`session-lock`/`redact` with tests.
2. Switcher + handover (local-only and OpenRouter) + sticky persistence: hard-failure switching end to end.
3. Judge + quality path below level 1 + caps (originally tiers 2/3).
4. Narrator.
5. Ledger + `stats.json` + `/relay`.
6. Docs with before/after demo and "compared to opencode-auto-fallback" table, secret scan, publish public GitHub repo, npm with provenance (GitHub Actions, 2FA, lockfile + `npm ci`, `files` allowlist, `npm pack --dry-run` in CI, actions pinned by SHA).

## 13. Release cut line (open decision)

Historical staged-release decision; tier and extra-mode references below describe
the original plan, not the current levels contract.

Critics (product lens) recommend shipping v1.0 as hard-failure failover + handover + minimal narrator + switch-event log + `/relay status`, then judge/tiers in v1.1, extra modes and full stats later. The author asked for the full set, so the spec keeps it all in scope but stages it:
DECIDED (author, 2026-10-18): staged releases. v1.0 = phases 1-2 (+ plain narrator and switch log), v1.1 = phases 3-4 (judge, tiers 2/3 quality path, British pools), v1.2 = phase 5 (full ledger, `stats.json`, `/relay stats`). The public repo exists from the start; each tag ships a working plugin. The design for all three stages stays in this spec.
