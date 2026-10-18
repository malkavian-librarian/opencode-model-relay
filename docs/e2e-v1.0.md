# End-to-end run: v1.0 failover (issue #4)

Run on 2026-10-18 against OpenCode CLI 1.3.13 (`opencode serve`, headless, driven over its
HTTP API) with an isolated config and data directory. Plugin: a self-contained bundle of
`src/index.ts` from `main` at commit aeb80fc (v1.0 code) placed in the plugins directory.

## Setup

- Primary: `openai/gpt-4o-mini` with a deliberately invalid API key (guaranteed 401).
- Secondary: `openrouter/meta-llama/llama-3.1-8b-instruct` (real OpenRouter key from the environment).
- `privacy.consent: true`, handover model `z-ai/glm-5.2` (default; the slug exists on OpenRouter).

## Results

| Check | Result |
|---|---|
| Failure detected and switch performed automatically | **Pass.** The 401 (`auth`, not retryable) triggered abort, then a handover prompt on the secondary model in the same session. |
| Continuation on the secondary model | **Pass.** The secondary answered the user's request ("pong"). |
| Handover contains the user's last request verbatim | **Pass.** `Reply with exactly one word: pong` appears in its own section outside the data block. |
| LLM summary written with consent | **Pass.** GLM 5.2 produced a structured summary inside the `handover-data` fence; recorded helper cost $0.0027. |
| Handover framed as data, not instructions | **Pass.** The message states the fenced block is data and not user instructions. |
| Second message still naming the failing primary stays on the secondary (pinning) | **Pass.** `openai/gpt-4o-mini` was requested; the secondary answered with no error. |
| Esc / abort mid-turn does not trigger a switch | **Pass.** A `MessageAbortedError` on a user abort produced no switch (switch log still had one row). |
| Switch log metadata only, HMAC'd session id | **Pass.** One row: timestamp, hashed session id, from, to, `auth`, helper cost. No prompt or response text, no raw session id. |
| Sticky state persisted | **Pass.** `state.json` held the sticky model, origin, `switchCount: 1`, `helperCalls: 1`. |
| Plugin load | **Pass** once bundled with `mainFields: ["module", "main"]` (see `docs/spike.md`). |

## Not covered

- `/relay status` as a command (does not work as designed; see `docs/spike.md`, tracked in #3).
- A real 429, quota, or gateway `FreeTierError` (could not be produced on demand).
- The OpenCode desktop/TUI front end (the hooks are identical; only the HTTP driver was used).
- Retry-status switching (`session.status` with `type: "retry"`) against a live provider.
