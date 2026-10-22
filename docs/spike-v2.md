# Spike: OpenCode 2 plugin API port (#56)

> Path note: the probe used a sandboxed copy under the local user's profile
> (`C:\Users\<user>\.opencode-v2-probe\oc2\`); examples below use that neutral placeholder.

Probed against a **real OpenCode 2.1.3 Windows binary** (standalone zip from
`https://opencode.ai/update/api/latest/cli/opencode/opencode-windows-x64.zip`, isolated at
`C:\Users\<user>\.opencode-v2-probe\oc2\` — the mainline 1.18.32 install was never touched).
Date: 2026-10-22. Everything below was verified empirically, not taken from docs.

## Runtime facts (probe-verified)

### Plugin loading

- The v2 binary loads local plugins from `~/.config/opencode/plugins/*.js` and also consumes the
  `plugins` array in `opencode.jsonc` (unlike 1.x, where the array was unsupported).
- Both `server()` (v1 shape) and `setup(ctx)` are supported by both generations. On 1.x, `setup`
  receives a **partial** ctx (`agent, aisdk, catalog, command, integration, options, plugin,
  reference, skill` — no `event`/`session`/`model`/`tool`), which is our all-or-nothing activation
  gate: the v2 layer stays dormant on 1.x.
- `@opencode/plugin` / `@opencode-ai/plugin` runtime imports **fail to build** from local
  plugins-dir files on 1.x ("AggregateError: 3 errors building"). Hence the bundle
  self-defines the plugin object; `@opencode-ai/plugin` stays a dev-only type for v1.
- **Build-time writes are silenced**: `console.*` and `fs.*` inside module evaluation, `server()`
  and the `setup()` body do not survive the v2 loader. Diagnostics must run inside hook callbacks
  / tool `execute` (runtime) — that is where writes persist.

### v2 ctx surface (full, 2.1.3)

`agent, aisdk, app, command, credential, event, experimental, generate, integration, location,
mcp, model, options, permission, plugin, provider, reference, rpc, session, shell, skill, storage,
tool, vcs, websearch, worktree` — the domains the relay uses:

- `ctx.event.subscribe({signal})` → async iterable of `{id, created, type, durable?, location?,
  data}`. Payload lives in `data` (v1 wrapped it in `properties`). **The stream is user-wide and
  cross-project**: one subscription receives events of every running project's sessions, so the
  relay routes by `data.sessionID` only and never trusts `location`.
- `ctx.session.get({sessionID})` → session info **directly** (`{id, model:{id, providerID,
  variant}, parentID?...}`) — not a `{data}` wrapper.
- `ctx.session.context({sessionID})` → flat typed message array:
  - user: `{id, time, text, files, type: "user"}` — text at top level, **no `model` field**
    (the session model is the turn's model: `ctx.session.get().model`);
  - assistant: `{id, time, type: "assistant", agent, model: {id, providerID}, content: [...],
    tokens, finish, cost}`;
  - plus status records `{id, type: "idle", outcome}`.
  - **Empty at prompt-hook admission time** — the new prompt is not in the transcript yet; it is
    complete by the time execution ends.
- `ctx.session.switchModel({sessionID, model: {providerID, id}})` works pre-resolution (emits
  `session.model.selected`); this is how the v2 layer enacts pins and handover targets. v2
  `session.prompt` has no model field, so the adapter switches the model right before prompting.
- `ctx.session.synthetic({sessionID, text})` works (queued inbox item, `type: "synthetic"`).
  Toasts route through it (the plugins API has no TUI endpoint); the adapter tracks a fallback
  `lastSession` so narration lands in a session when one is known.
- Tool `execute(input, context)` gets `context = {sessionID, agent, messageID, id, progress,
  signal}` — enough for `relay_status(sessionID)`.
- `ctx.model.list()` → `{location, data: [{providerID, modelID, id, ...}]}`; the adapter
  synthesizes the v1 `{data: {providers: [{id, models}]}}` shape from **ids only**.
- v2 **silently re-selects the fallback model** when a session resolves an invalid/unavailable
  model (`session.model.selected` with `previous`), so `model_not_found` may not surface as an
  error under v2 — failover there must be driven by real provider errors (retry hook / failure
  events).

## Design (as implemented)

- Plain-object dual export `{ id, server, setup }` from `dist/index.js`; no `@opencode/plugin`
  runtime dependency; fully self-contained bundle (tsup config unchanged).
- `src/v2-types.ts` holds narrow structural types (every field optional; host shape not trusted).
- All-or-nothing activation: `event.subscribe && session.{hook,get,context,switchModel,prompt,
  synthetic,interrupt} && model.list && tool.transform && command.transform` — else dormant.
- Module-scope singleton: one Controller/StateStore/SessionLock per process+env layout; a second
  `setup()` only rebinds which ctx performs the calls (newest wins; rejecting after unload).
- `v2Active` module flag: once a full v2 layer activated, v1 `event`/`chat.message` hooks
  no-op — a host supporting both must never run both layers.
- The v1 `createRelay(env, client)` bootstrap is shared by both layers.
- Marker semantics: `hasRelayMarker` drops the `!t.synthetic` requirement (v2 delivers our
  handover prompt through a runtime that may mark it synthetic); `controller.handle` exits when
  the newest transcript message is our handover (no second switch on late errors).

## Verified live (2.1.3 + `~/.config/opencode/plugins/opencode-model-relay.js`)

- v1 path on 1.18.32: plugin loads, `relay_status` returns the live chain (run in-session and via
  `opencode run`).
- v2 path on 2.1.3: `relay_status` registered through `ctx.tool.transform` and executed with a
  session context; the model reached it and printed the same chain.
- Unit: 17 dedicated v2-port tests (activation gating, hostile ctx, cross-project event routing,
  duplicate fan-out across two setups, retry veto semantics, pin/clear, late-error guard,
  teardown abort) plus the full existing suite untouched.

## Not verified yet (needs a real failure)

- The exact v2 failure-event type/shape. `session.execution.succeeded` was observed live; the
  failure counterpart is routed defensively (`session.error` / `session.execution.failed`, error
  payload mapped into the v1 envelope `{name: "APIError", data: {message, statusCode?}}`). The
  retry-hook shape (`{sessionID, attempt, error: {type, message, status?}, decision}`) is per the
  v2 docs; a live confirmation needs a genuine provider error, since v2 masks invalid models by
  re-selecting the fallback.
- Toast ergonomics in the TUI on v2 (synthetic messages), and `/relay` / `/relay-init` execution
  (registered via `ctx.command.transform`; execute shape `input.sessionID` is defensive).
- Chain-recover `switchModel` enact timing while a switch holds the lock (unit-covered only).

## Known limitations (documented, not fixed here)

- The v2 event bus is user-wide: two relay processes (two projects) each see all events. Dedup is
  per process (session lock + handover marker + persisted state), same class of behaviour as v1.
- Cross-process duplicate event fan-out already existed on v1; no change.
