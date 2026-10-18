# Spike findings: OpenCode plugin API assumptions (issue #2)

Run on 2026-10-18 against OpenCode CLI 1.3.13 (`opencode serve`, headless) with an
isolated config/data directory, driven over its HTTP API. Not exercised in the
TUI; hook behaviour there is assumed identical (confirmation tracked in #19). No real user config was touched.

| Question | Result | Consequence |
|---|---|---|
| (a) Does a plugin command (config hook + `command.execute.before` with `output.parts = []`) run WITHOUT a model turn? | **No.** The command was still sent to the model as a user message (`relay`) and a model answered (about 21K input tokens, $0.003 on a small model). Clearing `parts` does not stop the turn. | `/relay status` cannot be a plain command. Ship a `relay_status` tool the model can call, plus a `/relay` command whose template asks the model to call that tool and print its output verbatim. Tracked in #3. |
| (b) Does mutating `output.message.model` in `chat.message` change the model actually used? | **Yes.** A message sent for `openrouter/openai/gpt-4o-mini` was answered by the model the hook substituted (`openrouter/meta-llama/llama-3.1-8b-instruct`); both the stored user message and the assistant message show the substituted model. | Pinning works as designed. Keep the `chat.message` hook. |
| (c) Real `session.error` payload shape | Captured for a 401 from a provider: `{ name: "APIError", data: { message, statusCode: 401, isRetryable: false, responseHeaders, responseBody, metadata: { url } } }`. The failed turn also produces an assistant message with `providerID`, `modelID` and the same `error`. See `tests/fixtures/error-401-provider.json`. | The classifier reads the right fields. `responseHeaders` can contain cookies and request ids, so nothing from headers other than `retry-after` may be logged or stored. |
| (c) 403 FreeTierError, 429, quota, and `session.status` retry payloads | **Not captured.** They cannot be produced without a provider that actually rate-limits or an OpenCode gateway that rejects the request. | The classifier keeps matching these by message text and status code (unit-tested with hand-written payloads). Capture real ones opportunistically and add them to `tests/fixtures/` (tracked in #18). |
| (d) Does `session.prompt({ model })` mid-session switch the model, and does it keep history? | **Yes.** After the 401, the relay aborted the turn and prompted the secondary model in the same session; the new model answered in the same message list. The prompt is fired without awaiting it, as designed. | Design confirmed. |
| (e) Export shape | `export default { id, server }` plus a named `server` export loaded **once** (init counter stayed at 1) in the isolated server. | Keep both exports. |

## Other facts learned

- A bundle that imports `jsonc-parser` through esbuild's default `main` field picks the UMD
  build and fails at runtime ("Cannot find module './impl/format'"). Bundling must use
  `mainFields: ["module", "main"]`. The published npm package keeps `zod` and
  `jsonc-parser` as normal dependencies; the "copy `dist/index.js`" install path needs a
  self-contained build (tracked in #3).
- Newest-message handling matters: the user message carries `info.model`, and a failed
  turn creates an assistant message with `providerID`/`modelID`.
- `session.error` for a non-retryable error fires immediately (no `session.status` retry
  event preceded it for a 401).
