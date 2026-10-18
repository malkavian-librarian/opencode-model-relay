# Changelog

## Unreleased

Targeting 1.0.0 (not yet released).

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
- Self-contained `dist/index.js`: `zod` and `jsonc-parser` are bundled, so the package has no runtime dependencies and copying the file into the plugins directory works.
