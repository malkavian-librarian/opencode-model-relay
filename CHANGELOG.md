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
- Toast narration with verbosity levels, and a `/relay status` command.
- Config from the user config directory only, validated with a strict schema.
- Subagent sessions are skipped; hooks never throw.
