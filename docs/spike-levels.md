# Levels redesign v2 probe: switchModel persistence, retry-veto, synthetic targeting, pick-vs-resolution

> Spike for issue #65 (parent epic #62), probed 2026-10-23. The runtime facts
> below feed the rewiring child #66; the per-question consequences name the
> child behaviors they select and are already recorded on the child issues.

Probed 2026-10-23 against the real **OpenCode v2.1.3** binary in the existing sandbox (`~\.opencode-v2-probe\oc2\opencode.exe`), headless `run --standalone`, fully isolated config/data (`XDG_CONFIG_HOME`/`XDG_DATA_HOME` under `spike65\`, own `auth.json` copy — real user config untouched). An instrumented probe plugin (`spike65\cfg\opencode\plugins\probe65.js`) subscribed to `ctx.event.subscribe`, installed v2 session hooks (`prompt`, `context`, `model.request`, `retry`) via `ctx.session.hook`, and executed side-effects (`switchModel`, `synthetic`) through a trigger-file driver; every payload quoted below comes from its JSONL captures. All turns used free models (`opencode/flint-40b-free` exhausted → 429 free-limit; `openrouter/openrouter/free` + `openrouter/thinkingmachines/inkling-small:free` worked). No repo files were touched; probe artifacts live only in the sandbox.

## Q1 — Does `ctx.session.switchModel` persist across subsequent user turns?

**Answer: YES — persists. The runtime does NOT re-assert the agent-config model on admission.**

Evidence (session `ses_e962bf8b7ffeBrnd6hpJ7Ysq2X`, started on `openrouter/openrouter/free`):

- Turn 2 ran with a pre-placed trigger `{action:"switchModel", sessionID:ses_e962bf8b…, model:"openrouter/thinkingmachines/inkling-small:free"}`; the probe driver executed it mid-turn (actions log `{"action":"switchModel",…,"ok":true}`), and the host emitted:
  `{"type":"session.model.selected","data":{"sessionID":"ses_e962bf8b…","model":{"id":"thinkingmachines/inkling-small:free","providerID":"openrouter"},"previous":{"id":"openrouter/free","providerID":"openrouter","variant":"default"}}}` (emitted **before** `session.execution.started`). Turn 2 then ran ON the switched model: context hook reported `model:{id:"thinkingmachines/inkling-small:free",providerID:"openrouter"}`; `session.step.started` carried the same model; turn succeeded.
- Turn 3 — **plain** turn, no `-m`, no trigger: the prompt-hook admission snapshot reported `sessionModel:{id:"thinkingmachines/inkling-small:free",…}`, context hook + `model.request` + `step.started` all resolved `inkling-small:free`, and the turn succeeded. Persistence across admissions confirmed.
- Turn 4 — agent config now pinned an explicit `"model": "opencode/flint-40b-free"` (a hard config model, currently 429-dead): the plain turn **still** resolved and executed `inkling-small:free` (no flint attempt, no new `session.model.selected`), succeeding again.

Note: on plain admissions that change nothing, **no** `session.model.selected` is emitted (it fires only on actual changes, carrying `previous`).

**Consequence (child #66):** the prompt hook does **not** need to re-assert `pluginPinned` on every admission — a `switchModel` enact persists across turns, including against an explicit `model` in the agent config. The redesign can keep stay-put semantics; adoption only re-enacts when the resolved model differs from `pluginPinned`.

## Q2 — Is the retry hook's `e.decision.retry = false` mutation honored by the host?

**Answer: YES — honored.**

Forcing a retryable failure: the probe's `model.request` hook rewrote `baseURL` to a dead endpoint (`http://127.0.0.1:9/v1`) for the first primary attempt only.

Evidence:

- Baseline (no veto, session `ses_e96244f6affewo…`): retry hook fired with `{"attempt":2,"error":{"type":"provider.transport","message":"ECONNREFUSED: …"},"decisionBefore":{"retry":true,"delay":2212},"decisionAfter":true}`; host emitted `{"type":"session.retry.scheduled","data":{"attempt":2,"at":…,"error":{…}}}`, then a second `session.step.started` on the same assistantMessageID → `session.execution.succeeded`. (Host honored its own `{retry:true, delay}`.)
- Veto run (session `ses_e96233832ffe9…`): retry hook fired with `{"attempt":2,…,"decisionBefore":{"retry":true,"delay":2279},"decisionAfter":false,"vetoFile":true}` — the hook flipped `decision.retry = false` — and the host complied: events went `session.step.started → session.step.failed → session.execution.failed` with **no `session.retry.scheduled` and no second attempt**; the CLI turn produced no output (failed fast).
- Bonus real-world replication: genuine 429 `provider.free-limit` errors (`status:429`, `retryAfterMs` ~23M ms) also invoke the retry hook (`attempt:2`, `decisionBefore` already `{"retry":false}` — the host itself declines multi-hour-delay windows), followed by `session.step.failed`/`session.execution.failed` carrying the full error.

**Consequence (child #66):** the retry veto is a real control surface — the observed `e.decision.retry = false` mutation is binding. The transcript does not establish whether the host honors a decision set after an `await`; that needs a separate async-hook probe. The #56 adapter currently awaits the handover outcome to preserve its "veto only when the relay actually took the turn over" rule. Preserve that rule, but treat the host's awaiting of the hook as an unverified assumption until probed. The storm-token guard remains needed for repeated failures across rows/turns, but is no longer the *only* protection against OpenCode's own within-turn retry loop.

## Q3 — Does `ctx.session.synthetic` reliably land in the INTENDED session?

**Answer: YES — explicit `sessionID` targeting is honored, even across live sessions.**

Evidence (runner process active on `ses_e962bf8b7ffeBrnd6hpJ7Ysq2X` executing an E3RUNNER turn; trigger posted a synthetic to the *other* live/paused session `ses_e96233832ffe9XsxGesjNBlwOP`):

- Targeted in-flight, actions log: `{"action":"synthetic","arg":{…,"sessionID":"ses_e96233832ffe9XsxGesjNBlwOP","text":"probe65-cross-target-should-land-HERE-in-q2b-session"},"ok":true}`.
- Event stream showed it landing on the TARGET only:
  `{"type":"session.inbox.enqueued","data":{"sessionID":"ses_e96233832ffe9XsxGesjNBlwOP","inboxID":"msg_169dd9476001RJDeSkzbeHtFDe","item":{"type":"synthetic","payload":{"text":"probe65-cross-target-should-land-HERE-in-q2b-session"},"delivery":"steer"}}}` then `session.inbox.delivered` for the same target inboxID. The runner session's stream contained only its own user (`type:"user"`) enqueued item; no synthetic was misrouted to the caller's session.

**Consequence (#70):** explicit `sessionID` targeting works for `ctx.session.synthetic`. The v2 notification adapter reads the shared `CORE.lastSession.sid`, which event and hook handlers update, before sending a synthetic message. This probe does not establish event-bound notification routing; notification routing remains a separate concern for #70.

## Q4 — Can the context hook's model report distinguish a genuine user pick from runtime-internal resolution?

**Answer: NO for the tested paths — the hook payload carried no origin information.** (The tested paths are `-m` CLI pick, config-default resolution, plugin `switchModel`, and an invalid pick. The actual TUI `/model` path was not exercised by the headless probe and remains unverified; see Unresolved.)

Evidence — the rhyme-community payload is identical in structure in every scenario:

- Default resolution (fresh session, smoke run): context hook `{hook:"context", sessionID, agent:"build", model:{id:"flint-40b-free",providerID:"opencode"}}` — and **no** `session.model.selected` at all.
- `-m` pick at creation (`-m opencode/glm-5.3-flash-free`): same context hook shape (`model:{id:"glm-5.3-flash-free",providerID:"opencode","variant":"default"}`), again **no** `session.model.selected`; the pick is recorded only in `session.created` data (`{"model":{"id":"glm-5.3-flash-free","providerID":"opencode"}}`).
- Plugin `switchModel`: context hook same shape; the **change** is visible via `session.model.selected` with `previous`.
- Invalid `-m` pick (`openrouter/not-a-real-model`): context hook still reported the invalid pick at admission (`model:{id:"not-a-real-model"}`) and the turn failed honestly with `{"type":"provider.no-route","message":"Model unavailable: openrouter/not-a-real-model"}` — no distinguishing metadata in the hook (top-level event `metadata` fields stayed absent in all observed payloads).

**Consequence (child #66):** adoption trust cannot rest on the context-hook payload alone — it must be `diff != pluginPinned` (plugin crash-context: anything the plugin itself did not last set is treated as external). Note the residual ambiguity that deliberately surfaced: a provider/gateway fallback that re-resolves the session model would look *exactly* like a user pick under this rule (same payload shape), which is why §4.2.2's post-abort re-read + `previous`-carrying `session.model.selected` events + the persisted `pluginPinned` record must be used together.

## Runtime API facts established (for the rewiring child)

- Hook surface (2.1.3, `@opencode/plugin@2.1.3` types + live probe): `ctx.session.hook(name, cb)` with names `prompt`, `context`, `compaction`, `generate`, `title`, `model.request`, `http.request`, `http.response`, `experimental.ws.*`, `retry`. `SessionRetry = {sessionID, agent, model, error, attempt, decision: {retry:false} | {retry:true, delay}}`.
- `session` domain: `hook,list,create,get,remove,switchAgent,switchModel,prompt,generate,command,compact,synthetic,interrupt,update,move,wait,context`.
- Event vocabulary observed: `session.created` (carries creation-time `model`), `session.renamed`, `session.inbox.enqueued/delivered` (`item.type: user|synthetic`), `session.execution.started/succeeded/failed`, `session.step.started/ended/failed`, `session.retry.scheduled`, `session.model.selected` (+`previous`), `*.updated` catalog events, `session.usage.updated`.
- Connection failures classify as `provider.transport` (retryable); opencode gateway free-limit 429s classify as `provider.free-limit` with `retryAfterMs`.

## Unresolved

- **TUI `/model` picker unexercised.** The headless probe used `-m` and `switchModel` as proxies, so a TUI-specific event/metadata channel cannot be ruled out. Q4 remains incomplete until an actual TUI `/model` pick and a post-pick provider/gateway fallback re-resolution case have captured context-hook payloads and relevant events for comparison. Section 5 of the redesign plan requires resolving the probe questions before rewiring; the proxy evidence does not complete this question.
- **Async retry-hook timing unverified.** Capture a retry decision changed after an `await` and the resulting host events before treating the #56 adapter's host-awaiting assumption as established.
- `metadata` fields on `session.model.selected` were never populated in observed payloads — cannot confirm they never carry origin info; treat their absence as "no origin info today".
