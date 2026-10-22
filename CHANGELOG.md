# Changelog

## Unreleased

- OpenCode 2 (v2 plugin API) support (#56): the plugin now exports both a v1 `server()` and a v2 `setup(ctx)`; OpenCode 2 binaries run the v2 layer (session hooks `prompt`/`context`/`retry`, cross-project event subscription, native `ctx.session.switchModel`-based pinning) and OpenCode 1.x binaries keep the proven v1 hooks — the v1 layer stands down automatically when the v2 layer is live, so no double switching.
- On v2 binaries `relay_status` / `relay_init` are registered natively via `ctx.tool.transform`, and `/relay` / `/relay-init` are native zero-turn commands that surface status through a synthetic session message (no model turn needed on 2.x).
- The retry hook vetoes OpenCode's own retry (`decision.retry = false`) when the relay decides to switch: permanent failures at attempt 1, transient ones from attempt 2, mirroring the v1 `session.status` policy.
- `hasRelayMarker` now recognises a leading relay marker in a synthetic text part as the plugin's own handover prompt (v2 delivers prompts that way); mid-message pastes still never count.
- Late errors for a turn that already got a handover can no longer cause a second switch: `controller.handle` exits when the newest transcript message is the relay handover itself.
- Spec verified against a real OpenCode 2.1.3 binary (isolated probe); see [docs/spike-v2.md](docs/spike-v2.md). A live failover E2E (real provider error triggering a switch under v2) remains to be observed on a real failure; the portable parts (tool registration, status, config bootstrap, v1 path) ran green.

## 1.0.0 - 2026-10-19

- Failure classification: rate limit, quota, auth, free-tier 403, model not found, 5xx and timeout trigger a switch; context overflow, user abort and unknown errors never do.
- Chain failover across `tiers.primary`, `tiers.secondary` and `tiers.tertiary`, with permanent-failure marking, exponential cooldown (honouring `Retry-After`), and a per-session switch cap.
- Sticky model per session, with pinning of later messages and clearing when the user picks another model.
- Structured handover message: summary, tool calls with status, files touched, todos, and the user's last request verbatim, framed as untrusted context.
- Optional LLM-written handover summary through OpenRouter, behind explicit consent, with `provider.data_collection: "deny"`, optional ZDR, redaction, and a per-session call cap.
- Secret redaction and sensitive-path output dropping before any data is sent.
- Local switch log (`switches.jsonl`, metadata only, HMAC'd session ids) and `state.json`.
- Toast narration with verbosity levels, and a `relay_status` tool and a `/relay` command that asks the model to call it (it costs one small model turn; plugin commands cannot skip the model turn).
- `relay_init` tool and `/relay-init` command: create a commented default config (never overwrites, confined to the config directory, consent off), listing your configured models.
- Config from the user config directory only, validated with a strict schema.
- Subagent sessions are skipped; hooks never throw.
- Opt-in British narrator tone (`narrator.tone: "british"`): four variants per event, facts always stated first; `plain` stays the default and is unchanged.
- CI hardening: `persist-credentials: false` on checkout, and a manual dry-run-only path for the release workflow (`workflow_dispatch`); real publishing stays tag-only and owner-only.
- `mode` gains `chain-recover` (return to the highest-priority recovered model on the next user message, logged as switch kind `recover`, not counted as a switch; models tried for the same failing turn are never re-chosen) and `escalate` (failures move up one tier at a time, cheap to strong, never down or sideways). `chain-sticky` stays the default (#25).
- The never-re-choose-a-tried-model rule now applies to `chain-sticky` too (including a 0 ms `Retry-After` cooldown), and failure handling reads the transcript under the session lock so a recovered message cannot be blamed on the recovered model (#40).
- `chain-recover` hardening: recovery leaves one switch of headroom to the cap so a relapse cannot strand the session on the failing model, has its own visible `recoveries` counter, keeps pinning later turns to the recovered model even while the TUI still sends the old one, and only a text part starting with the relay marker (not a user-pasted substring or a synthetic part) counts as the handover (#49).
- Model health survives an OpenCode restart: cooldowns and permanent-failure blacklists live in `state.json` (validated and capped at load, expiring at their timestamps), a blacklist lifts after 24 hours or on the first turn on that model that ends cleanly (#39).
- Opt-in quality judge (`judge.enabled`, #26): after each finished turn, local heuristics score the turn on secondary/tertiary tiers (no output, repeated identical tool calls, repeated tool errors); only suspicious turns reach the `judge.model`, which answers strict JSON and must return `switch: true` twice in a row before the plugin switches to the next healthy, untried chain model (logged as failure kind `quality`, no cooldown recorded). Gated by `privacy.consent` and the OpenRouter key, capped per session (`judge.maxCallsPerSession`), per interval (`judge.minIntervalMs`) and per day (`judge.maxDailyUsd`), never judges its own handover turns, the primary tier, question-pending turns or subagent sessions, and deduplicates on the judged message id.
- Self-contained `dist/index.js`: `zod` and `jsonc-parser` are bundled, so the package has no runtime dependencies and copying the file into the plugins directory works.
