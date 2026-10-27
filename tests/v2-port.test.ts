import { describe, it, expect, vi } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createV2Plugin } from "../src/v2"
import { createServer } from "../src/server"
import { RELAY_MARKER } from "../src/defaults"
import plugin from "../src/index"
import { EventLog } from "../src/ledger"

// Non-trivial waits (event loop dispatch, save-to-disk) poll on a condition; everything is
// synchronous otherwise so tests are deterministic.
async function until(cond: () => boolean, ms = 1000): Promise<void> {
  const started = Date.now()
  while (!cond()) {
    if (Date.now() - started > ms) throw new Error("timed out waiting for condition")
    await new Promise((r) => setTimeout(r, 10))
  }
}

function readState(file: string): any {
  try { return JSON.parse(fs.readFileSync(file, "utf8")) } catch { return { sessions: {}, health: {} } }
}

function env(withConfig = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-v2-"))
  fs.mkdirSync(path.join(root, "cfg", "opencode"), { recursive: true })
  if (withConfig) {
    fs.writeFileSync(
      path.join(root, "cfg", "opencode", "opencode-model-relay.jsonc"),
      `{"tiers":{"primary":"a/1","secondary":["b/2"]}}`,
    )
  }
  fs.mkdirSync(path.join(root, "data", "opencode-model-relay"), { recursive: true })
  return {
    root,
    env: { XDG_CONFIG_HOME: path.join(root, "cfg"), XDG_DATA_HOME: path.join(root, "data") } as Record<string, string>,
    stateFile: path.join(root, "data", "opencode-model-relay", "state.json"),
  }
}

// --- OpenCode v2-shaped fixtures (doctor: real shapes probed from OpenCode 2.1.3, see docs/spike-v2.md).

const user = (id: string, text: string) => ({ id, time: { created: 1 }, text, files: [], type: "user" })
const asst = (id: string, providerID: string, modelID: string, text: string) =>
  ({ id, time: { created: 2 }, type: "assistant", agent: "build", model: { id: modelID, providerID }, content: [{ type: "text", text }], tokens: { input: 1, output: 5, reasoning: 0, cache: { read: 0, write: 0 } } })
const failedEvent = () =>
  ({ created: 1, type: "session.execution.failed", data: { sessionID: "s1", error: { type: "api_error", message: "429 Too Many Requests", status: 429 } } })
const idleEvent = () => ({ created: 1, type: "session.execution.succeeded", data: { sessionID: "s1" } })

interface CtxCalls {
  interrupt: any[]
  prompt: any[]
  switchModel: any[]
  synthetic: any[]
  tools: any[]
  commands: any[]
  hooks: Record<string, (ev: any) => unknown>
  hookOrder: string[]
}

function makeCtx(opts: { sessionModel?: { id: string; providerID: string }; messages?: unknown[]; parentID?: string } = {}) {
  const calls: CtxCalls = {
    interrupt: [], prompt: [], switchModel: [], synthetic: [], tools: [], commands: [],
    hooks: {}, hookOrder: [],
  }
  const signals: AbortSignal[] = []
  const sessionModel = opts.sessionModel ?? { id: "1", providerID: "a" }
  const messages = opts.messages ?? [user("u1", "fix the bug"), asst("a1", "a", "1", "working on it")]
  const ctx: any = {
    app: { version: "2.1.3", channel: "latest", name: "opencode" },
    event: {
      subscribe: (a: { signal?: AbortSignal }) => {
        const signal = a.signal as AbortSignal
        signals.push(signal)
        const queue: any[] = []
        let awake: (() => void) | null = null
        ;(ctx as any).__emit = (ev: any) => { queue.push(ev); const w = awake; awake = null; w?.() }
        signal?.addEventListener?.("abort", () => { const w = awake; awake = null; w?.() })
        return {
          [Symbol.asyncIterator]: () => ({
            next: async () => {
              for (;;) {
                if (queue.length > 0) return { done: false, value: queue.shift() }
                if (signal?.aborted) return { done: true, value: undefined }
                await new Promise<void>((r) => { awake = r })
              }
            },
          }),
        }
      },
    },
    session: {
      get: async (a: { sessionID: string }) => ({ id: a.sessionID, model: sessionModel, ...(opts.parentID ? { parentID: opts.parentID } : {}) }),
      context: async (_a: { sessionID: string }) => messages,
      hook: async (name: string, cb: (ev: any) => unknown) => { calls.hooks[name] = cb; calls.hookOrder.push(name); return {} },
      switchModel: async (a: { sessionID: string; model: unknown }) => { calls.switchModel.push(a); return {} },
      prompt: async (a: { sessionID: string; text: string }) => { calls.prompt.push(a); return {} },
      synthetic: async (a: { sessionID: string; text: string }) => { calls.synthetic.push(a); return {} },
      interrupt: async (a: { sessionID: string }) => { calls.interrupt.push(a); return {} },
    },
    model: {
      list: async () => ({ location: { directory: "x" }, data: [{ providerID: "a", modelID: "1", id: "a/1" }, { providerID: "b", modelID: "2", id: "b/2" }] }),
    },
    tool: { transform: async (cb: (editor: any) => unknown) => cb({ add: (t: any) => calls.tools.push(t) }) },
    command: { transform: async (cb: (editor: any) => unknown) => cb({ add: (t: any) => calls.commands.push(t) }) },
  }
  return { ctx, calls, signals }
}

/** Seed a session record directly into the state file, like a plugin run from a previous process. */
const NOW = Date.now()
/** Seed a session record directly into the state file, like a plugin run from a previous process.
 *  `updated` is always fresh so the state store's 14-day session TTL does not prune the record on load. */
const seed = (file: string, s1: object) =>
  fs.writeFileSync(file, JSON.stringify({
    v: 1,
    sessions: { s1: { ...s1, updated: NOW } },
    health: {},
    judgeDaily: {},
  }))

describe("v2 activation rules", () => {
  it("stays dormant when the v2 domains are missing (OpenCode 1.x partial ctx)", async () => {
    const e = env()
    const { ctx } = makeCtx()
    delete ctx.event
    delete ctx.session
    const r = await createV2Plugin(e.env).setup(ctx)
    expect(r).toBeUndefined()
    expect(ctx.__emit).toBeUndefined()
    expect(Object.keys(plugin).sort()).toEqual(["id", "server", "setup"])
  })
  it("activates on a full v2 ctx: hooks, tools and commands are registered, a teardown is returned", async () => {
    const e = env()
    const { ctx, calls } = makeCtx()
    const teardown = await createV2Plugin(e.env).setup(ctx)
    expect(typeof teardown).toBe("function")
    expect(calls.hookOrder.sort()).toEqual(["context", "prompt", "retry"])
    expect(calls.tools.map((t) => t.name)).toEqual(["relay_status", "relay_init", "relay_stats", "relay_purge"])
    expect(calls.commands.map((c) => c.name)).toEqual(["relay", "relay-init"])
  })
  it("ignores untrusted ctx.options and ctx.location; the layer still activates", async () => {
    const e = env()
    const { ctx, calls } = makeCtx()
    const poison = () => new Proxy({}, { get: () => { throw new Error("poison") } })
    ctx.options = poison()
    ctx.location = poison()
    const teardown = await createV2Plugin(e.env).setup(ctx)
    expect(typeof teardown).toBe("function")
    expect(calls.hookOrder).toEqual(["prompt", "context", "retry"])
    teardown?.()
  })
  it("a hostile ctx never throws out of setup", async () => {
    const e = env()
    const { ctx } = makeCtx()
    ctx.session.hook = () => { throw new TypeError("hook registration failed") }
    const r = await createV2Plugin(e.env).setup(ctx)
    expect(typeof r).toBe("function")
  })
})

describe("v2 failure and retry paths", () => {
  // Synthetic documented retry-hook shapes, not captures of the reported incident.
  for (const [message, kind] of [
    ["The usage limit has been reached", "quota"],
    ["Free usage limit reached. Subscribe to OpenCode Go to keep going: https://opencode.ai/go", "free_tier_403"],
  ]) for (const status of [undefined, 429]) {
    it(`retry exhaustion switches on attempt 1 (${kind}, status ${status})`, async () => {
      const e = env()
      const { ctx, calls } = makeCtx()
      const teardown = await createV2Plugin(e.env).setup(ctx)
      const ev = { sessionID: "s1", agent: "build", model: { providerID: "a", id: "1" }, attempt: 1, error: { type: "api_error", message, status }, decision: { retry: true, delay: 1000 } }
      await calls.hooks.retry!(ev)
      expect(ev.decision).toEqual({ retry: false, delay: 1000 })
      expect(calls.switchModel).toHaveLength(1)
      expect(readState(e.stateFile).health["a/1"]?.permanent).toBe(true)
      expect(readState(e.stateFile).sessions.s1?.switchCount).toBe(1)
      await calls.hooks.retry!(ev)
      expect(calls.switchModel).toHaveLength(1)
      teardown?.()
    })
  }
  for (const message of [
    "The usage limit has been reached. Please try again at 5pm",
    "Usage limit reached, resets at 5pm",
    "You've hit your usage limit. Please try again at 5:00 PM",
    "Rate limit reached for requests, usage limit resets at 5pm, see your billing page",
  ]) for (const status of [undefined, 429]) {
    it(`retry reset hint leaves first attempt native (${message}, ${status})`, async () => {
      const e = env()
      const { ctx, calls } = makeCtx()
      const teardown = await createV2Plugin(e.env).setup(ctx)
      const ev = { sessionID: "s1", agent: "build", model: { providerID: "a", id: "1" }, attempt: 1, error: { type: "api_error", message, status }, decision: { retry: true, delay: 1000 } }
      await calls.hooks.retry!(ev)
      expect(ev.decision).toEqual({ retry: true, delay: 1000 })
      expect(calls.switchModel).toEqual([])
      ev.attempt = 2
      await calls.hooks.retry!(ev)
      expect(ev.decision.retry).toBe(false)
      expect(calls.switchModel).toHaveLength(1)
      expect(readState(e.stateFile).health["a/1"]?.permanent).not.toBe(true)
      teardown?.()
    })
  }
  it("unattributed failure event advances a known handover target (compatibility only)", async () => {
    const e = env(false)
    fs.writeFileSync(path.join(e.root, "cfg", "opencode", "opencode-model-relay.jsonc"), `{"tiers":{"primary":"a/1","secondary":["b/2","c/3"]}}`)
    seed(e.stateFile, { pluginPinned: "b/2", switchCount: 1 })
    const { ctx, calls } = makeCtx({ sessionModel: { providerID: "b", id: "2" }, messages: [asst("a1", "a", "1", "x"), user("h1", `${RELAY_MARKER}\ncontinue`)] })
    const teardown = await createV2Plugin(e.env).setup(ctx)
    ctx.__emit({ type: "session.execution.failed", data: { sessionID: "s1", error: { type: "api_error", message: "The usage limit has been reached" } } })
    // AC-04 moved the state persist ahead of switchModel, so switchCount is observable before the
    // enactment completes: wait on switchModel itself.
    await until(() => calls.switchModel.length > 0)
    expect(calls.switchModel[0].model).toEqual({ providerID: "c", id: "3" })
    expect(readState(e.stateFile).health["b/2"]?.permanent).toBe(true)
    expect(readState(e.stateFile).health["a/1"]).toBeUndefined()
    teardown?.()
  })
  it("a failed execution switches to the next chain model with the full handover", async () => {
    const e = env()
    const { ctx, calls, signals } = makeCtx()
    const teardown = (await createV2Plugin(e.env).setup(ctx)) as () => void
    ctx.__emit(failedEvent())
    await until(() => calls.switchModel.length > 0)
    expect(calls.interrupt).toEqual([{ sessionID: "s1" }])
    expect(calls.switchModel[0]).toEqual({ sessionID: "s1", model: { providerID: "b", id: "2" } })
    expect(calls.prompt[0].sessionID).toBe("s1")
    expect(calls.prompt[0].text.startsWith(RELAY_MARKER)).toBe(true)
    await until(() => calls.synthetic.length > 0) // narration surfaces as a synthetic message
    const rec = readState(e.stateFile).sessions.s1
    expect(rec).toMatchObject({ pluginPinned: "b/2", switchCount: 1 })
    expect(signals).toHaveLength(1)
    teardown()
    expect(signals.at(0)?.aborted).toBe(true)
  })
  it("a failed execution is ignored for child sessions and non-session events", async () => {
    const e = env()
    const { ctx, calls } = makeCtx({ parentID: "ses_parent" })
    const teardown = await createV2Plugin(e.env).setup(ctx)
    ctx.__emit(failedEvent())
    await new Promise((r) => setTimeout(r, 50))
    expect(calls.switchModel).toEqual([])
    expect(calls.interrupt).toEqual([])
    teardown?.()
  })
  it("the retry hook vetoes a permanent error at attempt 1 and switches", async () => {
    const e = env()
    const { ctx, calls } = makeCtx()
    const teardown = await createV2Plugin(e.env).setup(ctx)
    const ev = { sessionID: "s1", attempt: 1, model: { providerID: "a", id: "1" }, error: { message: "402 payment required", status: 402 }, decision: {} as any }
    await calls.hooks.retry!(ev)
    expect(ev.decision).toEqual({ retry: false })
    expect(calls.switchModel[0]!.model).toEqual({ providerID: "b", id: "2" })
    expect(calls.prompt[0].text.startsWith(RELAY_MARKER)).toBe(true)
    teardown?.()
  })
  it("the retry hook waits for attempt 2 on transient errors and leaves OpenCode's own retry alone", async () => {
    const e = env()
    const { ctx, calls } = makeCtx()
    const teardown = await createV2Plugin(e.env).setup(ctx)
    const first = { sessionID: "s1", attempt: 1, error: { message: "429 Too Many Requests", status: 429 }, decision: {} as any }
    await calls.hooks.retry!(first)
    expect(first.decision).toEqual({})
    expect(calls.switchModel).toEqual([])
    const second = { sessionID: "s1", attempt: 2, error: { message: "429 Too Many Requests", status: 429 }, decision: {} as any }
    await calls.hooks.retry!(second)
    expect(second.decision).toEqual({ retry: false })
    teardown?.()
  })
  it("the retry hook leaves OpenCode's retry alone when the relay cannot switch (child session)", async () => {
    const e = env()
    const { ctx, calls } = makeCtx({ parentID: "ses_parent" })
    const teardown = await createV2Plugin(e.env).setup(ctx)
    const ev = { sessionID: "s1", attempt: 1, model: { providerID: "a", id: "1" }, error: { message: "402 payment required", status: 402 }, decision: {} as any }
    await calls.hooks.retry!(ev)
    expect(ev.decision).toEqual({})
    expect(calls.interrupt).toEqual([])
    expect(calls.switchModel).toEqual([])
    teardown?.()
  })
  it("a failure attributed to the handover target advances the chain: the handover turn itself failed (#56)", async () => {
    const e = env(false)
    fs.writeFileSync(path.join(e.root, "cfg", "opencode", "opencode-model-relay.jsonc"), `{"tiers":{"primary":"a/1","secondary":["b/2","c/3"]}}`)
    const { ctx, calls } = makeCtx({
      sessionModel: { id: "2", providerID: "b" },
      messages: [user("u1", "fix the bug"), asst("a1", "a", "1", "x"), { id: "h1", time: { created: 3 }, text: `${RELAY_MARKER}\nhandover`, files: [], type: "user" }],
    })
    seed(e.stateFile, { pluginPinned: "b/2", switchCount: 1 })
    const teardown = await createV2Plugin(e.env).setup(ctx)
    const ev = { sessionID: "s1", attempt: 2, model: { providerID: "b", id: "2" }, error: { message: "429 Too Many Requests", status: 429 }, decision: {} as any }
    await calls.hooks.retry!(ev)
    await until(() => calls.switchModel.length > 0)
    expect(calls.switchModel.at(0)?.model).toEqual({ providerID: "c", id: "3" })
    expect(ev.decision).toEqual({ retry: false })
    expect(readState(e.stateFile).sessions.s1?.pluginPinned).toBe("c/3")
    teardown?.()
  })
  it("a re-fired error attributed to the model that already switched away does not switch again", async () => {
    const e = env()
    const { ctx, calls } = makeCtx({
      sessionModel: { id: "2", providerID: "b" },
      messages: [user("u1", "fix the bug"), asst("a1", "a", "1", "x"), { id: "h1", time: { created: 3 }, text: `${RELAY_MARKER}\nhandover`, files: [], type: "user" }],
    })
    seed(e.stateFile, { pluginPinned: "b/2", switchCount: 1 })
    const teardown = await createV2Plugin(e.env).setup(ctx)
    const ev = { sessionID: "s1", attempt: 2, model: { providerID: "a", id: "1" }, error: { message: "429 Too Many Requests", status: 429 }, decision: {} as any }
    await calls.hooks.retry!(ev)
    expect(ev.decision).toEqual({})
    expect(calls.interrupt).toEqual([])
    expect(calls.switchModel).toEqual([])
    teardown?.()
  })
})

describe("v2 switch safety", () => {
  for (const blocked of ["cap", "exhausted", "context failure", "malformed", "lock"]) {
    it(`retry keeps the native decision when blocked by ${blocked}`, async () => {
      const e = env()
      if (blocked === "cap") fs.writeFileSync(e.stateFile, JSON.stringify({ v: 1, sessions: { s1: { switchCount: 6, updated: NOW } }, health: { "b/2": { cooldownUntil: NOW + 3_600_000 } }, judgeDaily: {} }))
      if (blocked === "exhausted") fs.writeFileSync(path.join(e.root, "cfg", "opencode", "opencode-model-relay.jsonc"), `{"tiers":{"primary":"a/1","secondary":[]}}`)
      const { ctx, calls } = makeCtx()
      let release!: () => void
      let entered!: () => void
      const started = new Promise<void>((r) => { entered = r })
      if (blocked === "context failure") ctx.session.context = async () => { throw new Error("down") }
      if (blocked === "lock") ctx.session.interrupt = async () => { entered(); await new Promise<void>((r) => { release = r }) }
      const teardown = await createV2Plugin(e.env).setup(ctx)
      const ev = { sessionID: "s1", agent: "build", model: { providerID: "a", id: "1" }, attempt: 1, error: { type: "api_error", message: "The usage limit has been reached" }, decision: { retry: true, delay: 1000 } }
      const pendingEvent = { ...ev, decision: { retry: true, delay: 1000 } }
      let finished = false
      const pending = blocked === "lock" ? Promise.resolve(calls.hooks.retry!(pendingEvent)).then(() => { finished = true }) : undefined
      if (pending) {
        await started
        expect(finished).toBe(false)
        expect(pendingEvent.decision.retry).toBe(true)
      }
      await expect(Promise.resolve(calls.hooks.retry!(blocked === "malformed" ? { ...ev, error: null } : ev))).resolves.toBeUndefined()
      expect(ev.decision).toEqual({ retry: true, delay: 1000 })
      if (pending) { release(); await pending; expect(pendingEvent.decision.retry).toBe(false) }
      else expect(calls.switchModel).toEqual([])
      teardown?.()
    })
  }
  it("a late error for the handover turn does not switch again (#56)", async () => {
    const e = env()
    const { ctx, calls } = makeCtx({
      messages: [user("u1", "fix the bug"), asst("a1", "a", "1", "x"), { id: "h1", time: { created: 3 }, text: `${RELAY_MARKER}\nhandover`, files: [], type: "user" }],
    })
    const teardown = await createV2Plugin(e.env).setup(ctx)
    ctx.__emit(failedEvent())
    await new Promise((r) => setTimeout(r, 80))
    expect(calls.switchModel).toEqual([])
    expect(calls.interrupt).toEqual([])
    teardown?.()
  })
  it("duplicate fan-out of the same event across two setups over one env switches exactly once", async () => {
    const e = env()
    const a = makeCtx()
    const b = makeCtx()
    await createV2Plugin(e.env).setup(a.ctx)
    await createV2Plugin(e.env).setup(b.ctx)
    const ev = failedEvent()
    a.ctx.__emit(ev)
    b.ctx.__emit(ev)
    await until(() => a.calls.switchModel.length + b.calls.switchModel.length > 0)
    await new Promise((r) => setTimeout(r, 50))
    // The client holder is rebound by the newest setup, so the switch is enacted through b.
    expect(a.calls.switchModel).toEqual([])
    expect(b.calls.switchModel).toHaveLength(1)
    expect(b.calls.interrupt).toHaveLength(1)
  })
})

describe("v2 idle and health", () => {
  it("a succeeded execution clears the model's cooldown and seeds no switch", async () => {
    const e = env()
    const { ctx, calls } = makeCtx({ messages: [user("u1", "hi"), asst("a1", "a", "1", "done")] })
    fs.writeFileSync(
      e.stateFile,
      JSON.stringify({ v: 1, sessions: {}, health: { "a/1": { cooldownUntil: NOW + 3_600_000, failures: 1 } }, judgeDaily: {} }),
    )
    const teardown = await createV2Plugin(e.env).setup(ctx)
    ctx.__emit(idleEvent())
    await until(() => readState(e.stateFile).health["a/1"] === undefined)
    expect(calls.switchModel).toEqual([])
    expect(calls.interrupt).toEqual([])
    teardown?.()
  })
})

describe("v2 stay-put and adoption (#66)", () => {
  it.each(["child session", "rejected lookup", "throwing lookup"])("context adoption leaves shared health and session state intact for %s", async (blocked) => {
    const e = env()
    fs.writeFileSync(e.stateFile, JSON.stringify({
      v: 1,
      sessions: { s1: { pluginPinned: "b/2", switchCount: 1, updated: NOW } },
      health: { "z/9": { cooldownUntil: NOW + 3_600_000, failures: 4 } },
      judgeDaily: {},
    }))
    const { ctx, calls } = makeCtx({ parentID: blocked === "child session" ? "ses_parent" : undefined })
    const teardown = await createV2Plugin(e.env).setup(ctx)
    if (blocked === "rejected lookup") ctx.session.get = async () => { throw new Error("unavailable") }
    if (blocked === "throwing lookup") ctx.session.get = () => { throw new Error("unavailable") }
    const before = readState(e.stateFile)
    try {
      expect(calls.hooks.context!({ sessionID: "s1", model: { providerID: "z", id: "9" } })).toBeUndefined()
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(readState(e.stateFile)).toEqual(before)
      expect(calls.switchModel).toEqual([])
      expect(calls.prompt).toEqual([])
    } finally { teardown?.() }
  })
  it("a stale context lookup superseded by a newer context event never adopts (CodeRabbit, PR #80)", async () => {
    const e = env()
    fs.writeFileSync(e.stateFile, JSON.stringify({
      v: 1,
      sessions: { s3: { pluginPinned: "b/2", switchCount: 1, updated: NOW } },
      health: { "z/9": { cooldownUntil: NOW + 3_600_000, failures: 4 }, "c/3": { cooldownUntil: NOW + 3_600_000, failures: 2 } },
      judgeDaily: {},
    }))
    const { ctx, calls } = makeCtx()
    let n = 0
    let release!: () => void
    const olderLookup = new Promise<void>((resolve) => { release = resolve })
    ctx.session.get = async (a: { sessionID: string }) => {
      if (++n === 1) await olderLookup
      return { id: a.sessionID, model: { id: "9", providerID: "z" } }
    }
    const teardown = await createV2Plugin(e.env).setup(ctx)
    try {
      calls.hooks.context!({ sessionID: "s3", model: { providerID: "z", id: "9" } })
      calls.hooks.context!({ sessionID: "s3", model: { providerID: "c", id: "3" } })
      // The hook returns void; drain its lookup continuations while the older lookup stays blocked.
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(n).toBe(2)
      expect(readState(e.stateFile).sessions.s3?.pluginPinned).toBe("c/3")
      release() // the older lookup can only finish after the newer adoption
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(readState(e.stateFile).sessions.s3?.pluginPinned).toBe("c/3") // the newer pick survives
      expect(readState(e.stateFile).health["z/9"]?.failures).toBe(4) // the stale pick's health is NOT cleared
      expect(readState(e.stateFile).health["c/3"]).toBeUndefined() // the newer pick's health cleared once
      expect(calls.switchModel).toEqual([])
    } finally {
      release()
      await new Promise<void>((resolve) => setImmediate(resolve))
      teardown?.()
    }
  })
  it("a context event whose session lookup finds no session never adopts (CodeRabbit, PR #80)", async () => {
    const e = env()
    fs.writeFileSync(e.stateFile, JSON.stringify({
      v: 1,
      sessions: { s4: { pluginPinned: "b/2", switchCount: 1, updated: NOW } },
      health: { "z/9": { cooldownUntil: NOW + 3_600_000, failures: 4 } },
      judgeDaily: {},
    }))
    const { ctx, calls } = makeCtx()
    ctx.session.get = async () => undefined // the session cannot be found
    const teardown = await createV2Plugin(e.env).setup(ctx)
    try {
      calls.hooks.context!({ sessionID: "s4", model: { providerID: "z", id: "9" } })
      await new Promise<void>((resolve) => setImmediate(resolve)) // drain the missing-session hook's continuations
      expect(readState(e.stateFile).sessions.s4?.pluginPinned).toBe("b/2") // unverifiable session: no adoption
      expect(readState(e.stateFile).health["z/9"]?.failures).toBe(4)
      expect(calls.switchModel).toEqual([])
    } finally { teardown?.() }
  })
  it("the prompt hook never re-asserts a model (switchModel persists, probe Q1)", async () => {
    const e = env()
    seed(e.stateFile, { pluginPinned: "b/2", switchCount: 1 })
    const { ctx, calls } = makeCtx()
    const teardown = await createV2Plugin(e.env).setup(ctx)
    calls.hooks.prompt!({ sessionID: "s1", prompt: { text: "next question" } })
    calls.hooks.prompt!({ sessionID: "s1", prompt: { text: `${RELAY_MARKER}\nhandover` } })
    await new Promise((r) => setTimeout(r, 50))
    expect(calls.switchModel).toEqual([]) // stay-put: no fabricated-arrival re-pin
    teardown?.()
  })
  it("a context hook model outside pluginPinned is adopted: marks cleared once, counters kept, nothing enacted", async () => {
    const e = env()
    fs.writeFileSync(e.stateFile, JSON.stringify({
      v: 1,
      sessions: { s1: { pluginPinned: "b/2", switchCount: 1, helperCalls: 2, updated: NOW } },
      health: { "z/9": { cooldownUntil: NOW + 3_600_000, failures: 4 } },
      judgeDaily: {},
    }))
    const { ctx, calls } = makeCtx()
    const teardown = await createV2Plugin(e.env).setup(ctx)
    calls.hooks.context!({ sessionID: "s1", model: { providerID: "z", id: "9" } })
    await until(() => readState(e.stateFile).sessions.s1?.pluginPinned === "z/9")
    expect(readState(e.stateFile).sessions.s1).toMatchObject({ switchCount: 1, helperCalls: 2, adoptedAt: expect.any(Number) })
    expect(readState(e.stateFile).health["z/9"]).toBeUndefined() // the pick's marks cleared once
    expect(calls.switchModel).toEqual([]) // adoption never enacts a switch
    teardown?.()
  })
  it("a context hook model equal to pluginPinned changes nothing", async () => {
    const e = env()
    seed(e.stateFile, { pluginPinned: "b/2", switchCount: 1 })
    const { ctx, calls } = makeCtx()
    const teardown = await createV2Plugin(e.env).setup(ctx)
    calls.hooks.context!({ sessionID: "s1", model: { providerID: "b", id: "2" } })
    await new Promise((r) => setTimeout(r, 50))
    expect(readState(e.stateFile).sessions.s1?.adoptedAt).toBeUndefined()
    expect(calls.switchModel).toEqual([])
    teardown?.()
  })
  it("a session.model.selected event that contradicts the context model vetoes the adoption (probe Q4 corroboration)", async () => {
    const e = env()
    const { ctx, calls } = makeCtx()
    const teardown = await createV2Plugin(e.env).setup(ctx)
    ctx.__emit({ type: "session.model.selected", data: { sessionID: "s1", model: { providerID: "c", id: "3" }, previous: { providerID: "a", id: "1" } } })
    await new Promise((r) => setTimeout(r, 30))
    calls.hooks.context!({ sessionID: "s1", model: { providerID: "z", id: "9" } })
    await new Promise((r) => setTimeout(r, 50))
    expect(readState(e.stateFile).sessions.s1?.pluginPinned).toBeUndefined() // stale context payload: not adopted
    teardown?.()
  })
})

describe("v2 manual-pick race and retry storm (#66)", () => {
  it("U-01: a pick landing mid-failover supersedes the pending switchModel: adopted, logged superseded, nothing enacted", async () => {
    const e = env()
    fs.writeFileSync(e.stateFile, JSON.stringify({
      v: 1,
      sessions: { s1: { switchCount: 0, updated: NOW } },
      health: { "z/9": { cooldownUntil: NOW + 3_600_000 } },
      judgeDaily: {},
    }))
    const sm = { id: "1", providerID: "a" } // the session's resolved model; mutated below to simulate the pick
    const { ctx, calls } = makeCtx({ sessionModel: sm })
    let release!: () => void
    ctx.session.interrupt = async (a: { sessionID: string }) => { calls.interrupt.push(a); await new Promise<void>((r) => { release = r }) }
    const teardown = await createV2Plugin(e.env).setup(ctx)
    ctx.__emit(failedEvent())
    await until(() => calls.interrupt.length > 0)
    sm.id = "9"; sm.providerID = "z" // the owner picks z/9 during the abort window
    release()
    await until(() => readState(e.stateFile).sessions.s1?.pluginPinned === "z/9")
    await new Promise((r) => setTimeout(r, 150)) // the delayed handover prompt must NOT fire
    expect(calls.switchModel).toEqual([])
    expect(calls.prompt).toEqual([])
    expect(readState(e.stateFile).sessions.s1).toMatchObject({ pluginPinned: "z/9", switchCount: 0, adoptedAt: expect.any(Number) })
    expect(readState(e.stateFile).health["z/9"]).toBeUndefined()
    const rows = fs.readFileSync(path.join(e.root, "data", "opencode-model-relay", "switches.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
    expect(rows).toEqual([expect.objectContaining({ kind: "switch_dropped", reason: "superseded", from: "a/1", to: "z/9" })])
    teardown?.()
  })
  it("U-06: after an enacted switch, retry events for the old model are consumed and vetoed; the new model's are not", async () => {
    const e = env()
    fs.writeFileSync(path.join(e.root, "cfg", "opencode", "opencode-model-relay.jsonc"), `{"levels":["a/1","b/2","c/3"]}`)
    const sm = { id: "1", providerID: "a" }
    const messages = [user("u1", "fix the bug"), asst("a1", "a", "1", "working on it")]
    const { ctx, calls } = makeCtx({ sessionModel: sm, messages })
    const teardown = await createV2Plugin(e.env).setup(ctx)
    ctx.__emit(failedEvent()) // a/1 fails -> switch to b/2 enacted
    await until(() => calls.switchModel.length > 0)
    expect(calls.switchModel[0]).toEqual({ sessionID: "s1", model: { providerID: "b", id: "2" } })
    const stale = { sessionID: "s1", attempt: 2, model: { providerID: "a", id: "1" }, error: { message: "429 Too Many Requests", status: 429 }, decision: { retry: true, delay: 100 } as any }
    await calls.hooks.retry!(stale)
    expect(stale.decision.retry).toBe(false) // consumed + vetoed: the old turn is dead
    expect(calls.switchModel).toHaveLength(1) // no re-entry into handle
    // the handover turn runs on b/2: the transcript gains the marker row and the session model moves
    messages.push({ id: "h1", time: { created: 3 }, text: `${RELAY_MARKER}\nhandover`, files: [], type: "user" })
    sm.id = "2"; sm.providerID = "b"
    const fresh = { sessionID: "s1", attempt: 2, model: { providerID: "b", id: "2" }, error: { message: "429 Too Many Requests", status: 429 }, decision: { retry: true, delay: 100 } as any }
    await calls.hooks.retry!(fresh)
    await until(() => calls.switchModel.length > 1)
    expect(calls.switchModel[1]).toEqual({ sessionID: "s1", model: { providerID: "c", id: "3" } }) // b/2 == pluginPinned: not storm, a real failover
    teardown?.()
  })
})

describe("v2 crash-restart and setup ordering (#66)", () => {
  it("on load, pluginPinned is validated against levels and a pending handover is discarded (AC-04)", async () => {
    const e = env()
    fs.writeFileSync(e.stateFile, JSON.stringify({
      v: 1,
      sessions: {
        s1: { switchCount: 1, pluginPinned: "a/1", pendingHandover: { to: "a/1", at: NOW }, updated: NOW },
        s2: { switchCount: 1, pluginPinned: "z/9", updated: NOW },
      },
      health: {}, judgeDaily: {},
    }))
    const { ctx } = makeCtx()
    const teardown = await createV2Plugin(e.env).setup(ctx)
    const state = readState(e.stateFile)
    expect(state.sessions.s1?.pluginPinned).toBe("a/1") // a configured level: kept
    expect(state.sessions.s1?.pendingHandover).toBeUndefined() // crash-window intent discarded on load
    expect(state.sessions.s2?.pluginPinned).toBeUndefined() // not in levels: dropped silently
    teardown?.()
  })
  it("the layer activates only after its hooks are registered (no dormant window, AC-04)", async () => {
    vi.resetModules()
    const { createV2Plugin: freshPlugin, isV2Active: freshActive } = await import("../src/v2")
    const e = env()
    const { ctx, calls } = makeCtx()
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const origHook = ctx.session.hook
    ctx.session.hook = async (name: string, cb: (ev: any) => unknown) => { if (name === "retry") await gate; return origHook(name, cb) }
    const pending = freshPlugin(e.env).setup(ctx)
    await new Promise((r) => setTimeout(r, 30))
    expect(freshActive()).toBe(false) // registrations still in flight: the v1 layer must keep working
    release()
    await pending
    expect(freshActive()).toBe(true)
    expect(calls.hookOrder).toEqual(["prompt", "context", "retry"])
  })
})

describe("v2 tools, commands and model list", () => {
  it("relay_status reads session status; the /relay command posts it via a synthetic message", async () => {
    const e = env()
    const { ctx, calls } = makeCtx()
    const teardown = await createV2Plugin(e.env).setup(ctx)
    const statusTool = calls.tools.find((t) => t.name === "relay_status")
    const out = await statusTool!.execute(undefined, { sessionID: "s1" })
    expect(out).toEqual({ content: expect.stringContaining("chain: a/1 ->") })
    expect(out).toEqual({ content: expect.stringContaining("circular: 0 (completed 0)") })
    const relayCmd = calls.commands.find((c) => c.name === "relay")
    for (const input of [
      { sessionID: "s1" },
      { sessionID: "s1", prompt: { text: "  " }, delivery: "steer" },
      { sessionID: "s1", prompt: { text: "status" }, delivery: "steer" },
      { sessionID: "s1", prompt: { text: null }, delivery: "steer" },
    ]) await expect(relayCmd!.execute(input)).resolves.toBeTruthy()
    await until(() => calls.synthetic.length === 4)
    expect(calls.synthetic).toHaveLength(4)
    expect(calls.synthetic.every((x) => x.sessionID === "s1" && x.text.includes("chain:"))).toBe(true)
    expect(calls.switchModel).toEqual([])
    expect(calls.prompt).toEqual([])
    teardown?.()
  })
  it("relay_init creates a config and lists models from v2 model.list", async () => {
    const e = env(false) // no config file yet: the tool creates it and lists the discovered models
    const { ctx, calls } = makeCtx()
    const teardown = await createV2Plugin(e.env).setup(ctx)
    const initTool = calls.tools.find((t) => t.name === "relay_init")
    const out = await initTool!.execute(undefined, {})
    expect(out.content).toContain("Created")
    expect(out.content).toContain("- a/1")
    expect(out.content).toContain("- b/2")
    teardown?.()
  })

  it("preserves official V2 assistant USD cost through idle and both stats surfaces", async () => {
    const e = env()
    const ledgerDir = path.join(e.root, "data", "opencode-model-relay")
    // Schema-derived, not captured: V2 OpenAPI Session.Message.Assistant.cost -> Money.USD (number),
    // https://opencode.ai/v2/openapi.json, checked 2026-10-26 for target CLI v2.1.4.
    const { ctx, calls } = makeCtx({ messages: [user("u1", "work"), { ...asst("a1", "a", "1", "done"), cost: 0.20 }] })
    const teardown = await createV2Plugin(e.env).setup(ctx)
    try {
      ctx.__emit(idleEvent())
      const ledger = new EventLog(ledgerDir, true)
      await until(() => ledger.read().some((r) => r.event === "turn"))
      const tool = calls.tools.find((t) => t.name === "relay_stats")
      const row = (text: string) => text.split("\n").find((line) => line.startsWith("a/1 |"))
      expect(row((await tool.execute(undefined, {})).content)).toMatch(/\| \$0\.20 \| \$0\.00 \| 0$/)
      expect(ledger.read().find((r) => r.event === "turn")).toMatchObject({ model: "a/1", cost: 0.20 })
      ledger.append({ ts: Date.now(), sessionID: "s1", event: "judge", model: "a/1", verdict: "stay", helperCostUsd: 0.02 })
      ledger.append({ ts: Date.now(), sessionID: "s1", event: "narrative", model: "a/1", helperCostUsd: 0.03 })
      expect(row((await tool.execute(undefined, {})).content)).toMatch(/\| \$0\.20 \| \$0\.05 \| 0$/)
      await calls.commands.find((c) => c.name === "relay").execute({ sessionID: "s1", prompt: { text: "stats" }, delivery: "steer" })
      expect(row(calls.synthetic.at(-1).text)).toMatch(/\| \$0\.20 \| \$0\.05 \| 0$/)
    } finally { teardown?.() }
  })
  it.each([0, undefined, null, "0.2", -1, NaN, Infinity, -Infinity])("V2 records turns with known-cost-only metadata: %s", async (cost) => {
    const e = env()
    const { ctx } = makeCtx({ messages: [
      { ...user("u1", "work"), cost: 99 },
      { ...asst("a1", "a", "1", "done"), cost },
      ...["synthetic", "idle", "compaction"].map((type) => ({ id: type, type, cost: 99, model: { providerID: "z", id: "9" } })),
    ] })
    const teardown = await createV2Plugin(e.env).setup(ctx)
    try {
      const ledger = new EventLog(path.join(e.root, "data", "opencode-model-relay"), true)
      ctx.__emit(idleEvent())
      await until(() => ledger.read().length > 0)
      const rows = ledger.read()
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ event: "turn", model: "a/1" })
      if (cost === 0) expect(rows[0]!.cost).toBe(0)
      else expect(rows[0]).not.toHaveProperty("cost")
    } finally { teardown?.() }
  })
  it("relay_stats and /relay stats render the per-model table from the metadata-only ledger", async () => {
    const e = env()
    const ledgerDir = path.join(e.root, "data", "opencode-model-relay")
    const { ctx, calls } = makeCtx()
    const teardown = await createV2Plugin(e.env).setup(ctx)
    const statsTool = calls.tools.find((t) => t.name === "relay_stats")
    // An empty ledger still renders the table header, never throws.
    expect((await statsTool!.execute(undefined, {})).content).toContain("model | turns")
    fs.writeFileSync(
      path.join(ledgerDir, `events-${process.pid}.jsonl`),
      `${JSON.stringify({ ts: Date.now() - 1000, session: "0123456789abcdef", event: "turn", model: "a/1", tier: 1 })}\n`,
    )
    expect((await statsTool!.execute(undefined, {})).content).toContain("a/1")
    const relayCmd = calls.commands.find((c) => c.name === "relay")
    await relayCmd!.execute({ sessionID: "s1", prompt: { text: "stats" }, delivery: "steer" })
    await until(() => calls.synthetic.some((x) => x.text.includes("a/1")))
    teardown?.()
  })
  it("relay_purge and /relay purge clear the event files and the switch log, never other data", async () => {
    const e = env()
    const ledgerDir = path.join(e.root, "data", "opencode-model-relay")
    fs.writeFileSync(path.join(ledgerDir, `events-${process.pid}.jsonl`), "\n")
    fs.writeFileSync(path.join(ledgerDir, "switches.jsonl"), '{"kind":"sentinel"}\n')
    fs.writeFileSync(path.join(ledgerDir, "keep.txt"), "x")
    const { ctx, calls } = makeCtx()
    const teardown = await createV2Plugin(e.env).setup(ctx)
    const purgeTool = calls.tools.find((t) => t.name === "relay_purge")
    expect((await purgeTool!.execute(undefined, {})).content).toContain("Purged 1 ledger file(s).")
    expect(fs.readdirSync(ledgerDir)).not.toContain(`events-${process.pid}.jsonl`)
    expect(fs.existsSync(path.join(ledgerDir, "switches.jsonl"))).toBe(false)
    expect(fs.readdirSync(ledgerDir)).toContain("keep.txt")
    const relayCmd = calls.commands.find((c) => c.name === "relay")
    fs.writeFileSync(path.join(ledgerDir, "switches.jsonl"), '{"kind":"sentinel"}\n')
    await relayCmd!.execute({ sessionID: "s1", prompt: { text: "purge" }, delivery: "steer" })
    await until(() => calls.synthetic.some((x) => x.text.includes("Purged")))
    expect(fs.existsSync(path.join(ledgerDir, "switches.jsonl"))).toBe(false)
    teardown?.()
  })

  it("/relay model uses the fast manual path and emits receipt plus completion feedback", async () => {
    const e = env()
    const { ctx, calls } = makeCtx()
    const teardown = await createV2Plugin(e.env).setup(ctx)
    const relayCmd = calls.commands.find((c) => c.name === "relay")
    await relayCmd!.execute({ sessionID: "s1", prompt: { text: "model b/2" }, delivery: "steer" })
    expect(calls.switchModel).toEqual([{ sessionID: "s1", model: { providerID: "b", id: "2" } }])
    expect(calls.prompt[0].text).toMatch(/summary unavailable/i)
    expect(calls.synthetic.map((x) => x.text).join(" ")).toMatch(/switching.*b\/2/i)
    expect(calls.synthetic.map((x) => x.text).join(" ")).toMatch(/done|complete/i)
    teardown?.()
  })

  it("rejects invalid model command input without switching or logging", async () => {
    const e = env()
    const { ctx, calls } = makeCtx()
    const teardown = await createV2Plugin(e.env).setup(ctx)
    const relayCmd = calls.commands.find((c) => c.name === "relay")
    for (const text of ["model", "model nope", "model nope now", "model b/\u0000"]) {
      await expect(relayCmd!.execute({ sessionID: "s1", prompt: { text }, delivery: "steer" })).resolves.toBeTruthy()
    }
    expect(calls.switchModel).toEqual([])
    expect(calls.prompt).toEqual([])
    expect(calls.synthetic).toHaveLength(4)
    expect(calls.synthetic.every((x) => /invalid.*provider\/model/i.test(x.text))).toBe(true)
    expect(fs.existsSync(path.join(e.root, "data", "opencode-model-relay", "switches.jsonl"))).toBe(false)
    teardown?.()
  })

  it("/relay next uses the current command shape", async () => {
    const e = env()
    const { ctx, calls } = makeCtx()
    const teardown = await createV2Plugin(e.env).setup(ctx)
    const relayCmd = calls.commands.find((c) => c.name === "relay")
    await relayCmd!.execute({ sessionID: "s1", prompt: { text: "next" }, delivery: "steer" })
    expect(calls.switchModel).toEqual([{ sessionID: "s1", model: { providerID: "b", id: "2" } }])
    expect(calls.prompt[0].text).toMatch(/summary unavailable/i)
    expect(calls.synthetic.map((x) => x.text).join(" ")).toMatch(/switching.*next|switched.*b\/2/i)
    teardown?.()
  })

  it("/relay next gives an explicit bottom-of-ladder message", async () => {
    const e = env()
    fs.writeFileSync(path.join(e.root, "cfg", "opencode", "opencode-model-relay.jsonc"), `{"tiers":{"primary":"a/1","secondary":[]}}`)
    const { ctx, calls } = makeCtx()
    const teardown = await createV2Plugin(e.env).setup(ctx)
    const relayCmd = calls.commands.find((c) => c.name === "relay")
    await relayCmd!.execute({ sessionID: "s1", prompt: { text: "next" }, delivery: "steer" })
    expect(calls.switchModel).toEqual([])
    expect(calls.synthetic.map((x) => x.text).join(" ")).toMatch(/no healthy model|bottom|relay status/i)
    teardown?.()
  })

  it("/relay next does not select a quarantined candidate when the ladder is exhausted", async () => {
    const e = env()
    fs.writeFileSync(path.join(e.root, "cfg", "opencode", "opencode-model-relay.jsonc"), `{"tiers":{"primary":"a/1","secondary":["b/2","c/3"]}}`)
    seed(e.stateFile, { switchCount: 0, quarantine: { "b/2": NOW, "c/3": NOW } })
    const { ctx, calls } = makeCtx()
    const teardown = await createV2Plugin(e.env).setup(ctx)
    const relayCmd = calls.commands.find((c) => c.name === "relay")
    await relayCmd!.execute({ sessionID: "s1", prompt: { text: "next" }, delivery: "steer" })
    expect(calls.switchModel).toEqual([])
    expect(calls.synthetic.map((x) => x.text).join(" ")).toMatch(/bottom|relay status/i)
    teardown?.()
  })

  it("uses legacy arguments only when prompt.text is absent", async () => {
    const e = env()
    const { ctx, calls } = makeCtx()
    const teardown = await createV2Plugin(e.env).setup(ctx)
    const relayCmd = calls.commands.find((c) => c.name === "relay")
    await relayCmd!.execute({ sessionID: "s1", arguments: "next" })
    await relayCmd!.execute({ sessionID: "s1", prompt: { text: "status" }, arguments: "next", delivery: "steer" })
    expect(calls.switchModel).toEqual([{ sessionID: "s1", model: { providerID: "b", id: "2" } }])
    expect(calls.synthetic.at(-1)?.text).toContain("chain:")
    teardown?.()
  })
})

describe("v2 stats and purge surfaces (#103)", () => {
  const STATS_USAGE = "Usage: /relay stats [--days N] [--kinds]"
  const WARNING = "Warning: the stats snapshot could not be refreshed."
  const DAY = 864e5

  it("relay_purge rebuilds stats.json immediately and clears the switch log; other data survives; a zero-file repeat refreshes too", async () => {
    const e = env()
    const ledgerDir = path.join(e.root, "data", "opencode-model-relay")
    const statsFile = path.join(ledgerDir, "stats.json")
    seed(e.stateFile, { switchCount: 1 })
    const l = new EventLog(ledgerDir, true)
    const t0 = Date.now()
    expect(l.append({ ts: t0 - 1000, sessionID: "s1", event: "turn", model: "a/1" })).toBe(true)
    fs.writeFileSync(path.join(ledgerDir, "switches.jsonl"), '{"kind":"sentinel"}\n')
    fs.writeFileSync(path.join(ledgerDir, "keep.txt"), "x")
    const { ctx, calls } = makeCtx()
    const teardown = await createV2Plugin(e.env).setup(ctx)
    try {
      expect(Object.keys(JSON.parse(fs.readFileSync(statsFile, "utf8")).models)).toEqual(["a/1"]) // nonempty snapshot established at startup
      const before = {
        state: fs.readFileSync(e.stateFile, "utf8"),
        salt: fs.readFileSync(path.join(ledgerDir, "salt"), "utf8"),
        cfg: fs.readFileSync(path.join(e.root, "cfg", "opencode", "opencode-model-relay.jsonc"), "utf8"),
        keep: fs.readFileSync(path.join(ledgerDir, "keep.txt"), "utf8"),
      }
      const purgeTool = calls.tools.find((t) => t.name === "relay_purge")!
      expect((await purgeTool.execute(undefined, {})).content).toBe("Purged 1 ledger file(s).")
      const snap = JSON.parse(fs.readFileSync(statsFile, "utf8"))
      expect(snap).toEqual({ version: 1, generatedAt: expect.any(Number), models: {} })
      expect(snap.generatedAt).toBeGreaterThanOrEqual(t0)
      expect(fs.readFileSync(e.stateFile, "utf8")).toBe(before.state)
      expect(fs.readFileSync(path.join(ledgerDir, "salt"), "utf8")).toBe(before.salt)
      expect(fs.existsSync(path.join(ledgerDir, "switches.jsonl"))).toBe(false)
      expect(fs.readFileSync(path.join(e.root, "cfg", "opencode", "opencode-model-relay.jsonc"), "utf8")).toBe(before.cfg)
      expect(fs.readFileSync(path.join(ledgerDir, "keep.txt"), "utf8")).toBe(before.keep)
      expect((await purgeTool.execute(undefined, {})).content).toBe("Purged 0 ledger file(s).") // zero-file repeat still refreshes
      expect(JSON.parse(fs.readFileSync(statsFile, "utf8")).models).toEqual({})
    } finally { teardown?.() }
  })

  it("/relay purge also rebuilds the snapshot immediately and clears the switch log (command surface, after reseeding)", async () => {
    const e = env()
    const ledgerDir = path.join(e.root, "data", "opencode-model-relay")
    const l = new EventLog(ledgerDir, true)
    l.append({ ts: Date.now() - 1000, sessionID: "s1", event: "turn", model: "a/1" })
    fs.writeFileSync(path.join(ledgerDir, "switches.jsonl"), '{"kind":"sentinel"}\n')
    const { ctx, calls } = makeCtx()
    const teardown = await createV2Plugin(e.env).setup(ctx)
    try {
      const relayCmd = calls.commands.find((c) => c.name === "relay")!
      await relayCmd.execute({ sessionID: "s1", prompt: { text: "purge" }, delivery: "steer" })
      await until(() => calls.synthetic.some((x) => x.text.includes("Purged")))
      expect(calls.synthetic.at(-1)?.text).toBe("Purged 1 ledger file(s).")
      expect(fs.existsSync(path.join(ledgerDir, "switches.jsonl"))).toBe(false)
      expect(JSON.parse(fs.readFileSync(path.join(ledgerDir, "stats.json"), "utf8")).models).toEqual({})
    } finally { teardown?.() }
  })

  it("stats --kinds --days 1 (command) and { days: 1, kinds: true } (tool) produce identical exact-window tables", async () => {
    const e = env()
    const ledgerDir = path.join(e.root, "data", "opencode-model-relay")
    const l = new EventLog(ledgerDir, true)
    const now = Date.now()
    l.append({ ts: now - 6000, sessionID: "s", event: "turn", model: "b/2", latencyMs: 50 })
    l.append({ ts: now - 5000, sessionID: "s", event: "failure", model: "a/1", errorKind: "timeout" })
    l.append({ ts: now - 4000, sessionID: "s", event: "failure", model: "a/1", errorKind: "quota" })
    l.append({ ts: now - 3000, sessionID: "s", event: "failure", model: "a/1", errorKind: "quota" })
    l.append({ ts: now - 2000, sessionID: "s", event: "turn", model: "a/1", latencyMs: 300 })
    l.append({ ts: now - 1000, sessionID: "s", event: "turn", model: "a/1", latencyMs: 100 })
    // outside the 1-day window: same UTC day as the cutoff edge, 40 days old, future
    l.append({ ts: now - DAY - 1, sessionID: "s", event: "turn", model: "a/1", latencyMs: 9999 })
    l.append({ ts: now - 40 * DAY, sessionID: "s", event: "turn", model: "a/1", latencyMs: 7 })
    l.append({ ts: now + 60_000, sessionID: "s", event: "turn", model: "a/1", latencyMs: 8 })
    const { ctx, calls } = makeCtx()
    const teardown = await createV2Plugin(e.env).setup(ctx)
    try {
      const statsTool = calls.tools.find((t) => t.name === "relay_stats")!
      const toolText = (await statsTool.execute({ days: 1, kinds: true }, {})).content
      const relayCmd = calls.commands.find((c) => c.name === "relay")!
      await relayCmd.execute({ sessionID: "s1", prompt: { text: "stats --kinds --days 1" }, delivery: "steer" })
      expect(calls.synthetic.at(-1)?.text).toBe(toolText)
      expect(toolText).toContain("a/1 | 2 | 3 | – | 0 | 0 | 0% | 100% | 200ms | 0/0 | $0.00 | $0.00")
      expect(toolText).toContain("a/1 failure kinds: quota 2, timeout 1") // lexicographic, sums to the fails column
      expect(toolText).toContain("b/2 | 1 | 0 | – | 0 | 0 | 0% | – | 50ms | 0/0 | $0.00 | $0.00")
      expect(toolText).toContain("b/2 failure kinds: none")
    } finally { teardown?.() }
  })

  it("median latency is the median of all samples in the window, not a median of daily medians", async () => {
    const e = env()
    const ledgerDir = path.join(e.root, "data", "opencode-model-relay")
    const l = new EventLog(ledgerDir, true)
    const now = Date.now()
    for (const [ts, latencyMs] of [[now - 2 * DAY, 1000], [now - DAY, 10], [now - DAY, 20], [now - DAY, 30]] as const)
      l.append({ ts, sessionID: "s", event: "turn", model: "a/1", latencyMs })
    const { ctx, calls } = makeCtx()
    const teardown = await createV2Plugin(e.env).setup(ctx)
    try {
      const statsTool = calls.tools.find((t) => t.name === "relay_stats")!
      const text = (await statsTool.execute(undefined, {})).content
      expect(text).toContain("a/1 | 4 | 0 | – | 0 | 0 | 0% | 100% | 25ms | 0/0 | $0.00 | $0.00")
    } finally { teardown?.() }
  })

  it("invalid stats requests return the usage line on both surfaces and touch nothing", async () => {
    const e = env()
    const ledgerDir = path.join(e.root, "data", "opencode-model-relay")
    const statsFile = path.join(ledgerDir, "stats.json")
    const l = new EventLog(ledgerDir, true)
    l.append({ ts: Date.now() - 1000, sessionID: "s", event: "turn", model: "a/1" })
    const { ctx, calls } = makeCtx()
    const teardown = await createV2Plugin(e.env).setup(ctx)
    try {
      const beforeStats = fs.readFileSync(statsFile, "utf8")
      const statsTool = calls.tools.find((t) => t.name === "relay_stats")!
      for (const bad of [{ days: 0 }, { days: 31 }, { days: 1.5 }, { days: "7" }, { days: null }, { kinds: "yes" }, { days: 1, extra: 2 }, [], null, "x", 7])
        expect((await statsTool.execute(bad, {})).content).toBe(STATS_USAGE)
      const relayCmd = calls.commands.find((c) => c.name === "relay")!
      const synthBefore = calls.synthetic.length
      for (const text of [
        "stats --days", "stats --days 0", "stats --days 31", "stats --days -1", "stats --days 1.5", "stats --days 1e1",
        "stats --days abc", "stats --days=7", "stats --days 1 --days 2", "stats --kinds --kinds", "stats --kinds 7",
        "stats --week 3", "stats foo", "stats 7",
      ]) await relayCmd.execute({ sessionID: "s1", prompt: { text }, delivery: "steer" })
      const replies = calls.synthetic.slice(synthBefore)
      expect(replies).toHaveLength(14)
      expect(replies.every((x) => x.text === STATS_USAGE)).toBe(true)
      // invalid input never falls through to status, deletes or writes data, or switches
      expect(fs.readFileSync(statsFile, "utf8")).toBe(beforeStats)
      expect(fs.readdirSync(ledgerDir)).toContain(`events-${process.pid}.jsonl`)
      expect(calls.switchModel).toEqual([])
      expect(calls.prompt).toEqual([])
    } finally { teardown?.() }
  })

  it("relay_stats advertises optional days/kinds with bounds; relay_purge stays argument-free", async () => {
    const e = env()
    const { ctx, calls } = makeCtx()
    const teardown = await createV2Plugin(e.env).setup(ctx)
    try {
      const statsTool = calls.tools.find((t) => t.name === "relay_stats")!
      expect(statsTool.input).toMatchObject({
        type: "object",
        properties: { days: { type: "integer", minimum: 1, maximum: 30 }, kinds: { type: "boolean" } },
        additionalProperties: false,
      })
      expect(statsTool.description).toContain("days")
      const purgeTool = calls.tools.find((t) => t.name === "relay_purge")!
      expect(purgeTool.input).toEqual({ type: "object", properties: {}, additionalProperties: false })
      expect(purgeTool.description).toContain("immediately")
      expect(purgeTool.description).toContain("switch log")
    } finally { teardown?.() }
  })

  it("a failed switch-log removal warns sanitized on both purge surfaces while event purge and stats refresh continue", async () => {
    const e = env()
    const ledgerDir = path.join(e.root, "data", "opencode-model-relay")
    const switchFile = path.join(ledgerDir, "switches.jsonl")
    const sentinel = '{"kind":"sentinel"}\n'
    const l = new EventLog(ledgerDir, true)
    l.append({ ts: Date.now() - 1000, sessionID: "s", event: "turn", model: "a/1" })
    fs.writeFileSync(switchFile, sentinel)
    const { ctx, calls } = makeCtx()
    const teardown = await createV2Plugin(e.env).setup(ctx)
    const rm = fs.rmSync
    const spy = vi.spyOn(fs, "rmSync").mockImplementation((file, options) => {
      if (file === switchFile) throw new Error("E_PERM secret /C:/users/path")
      return rm(file, options)
    })
    try {
      const warning = "Warning: the switch log could not be cleared."
      const purgeTool = calls.tools.find((t) => t.name === "relay_purge")!
      expect((await purgeTool.execute(undefined, {})).content).toBe(`Purged 1 ledger file(s). ${warning}`)
      expect(fs.readFileSync(switchFile, "utf8")).toBe(sentinel)
      const relayCmd = calls.commands.find((c) => c.name === "relay")!
      await relayCmd.execute({ sessionID: "s1", prompt: { text: "purge" }, delivery: "steer" })
      await until(() => calls.synthetic.some((x) => x.text.includes("Purged")))
      expect(calls.synthetic.at(-1)?.text).toBe(`Purged 0 ledger file(s). ${warning}`)
      expect(fs.readFileSync(switchFile, "utf8")).toBe(sentinel)
      expect(JSON.parse(fs.readFileSync(path.join(ledgerDir, "stats.json"), "utf8")).models).toEqual({})
      expect(calls.switchModel).toEqual([])
      expect(calls.prompt).toEqual([])
    } finally { spy.mockRestore(); teardown?.() }
  })

  it("a failed stats snapshot write during purge warns sanitized on both surfaces and switches nothing", async () => {
    const e = env()
    const ledgerDir = path.join(e.root, "data", "opencode-model-relay")
    const statsFile = path.join(ledgerDir, "stats.json")
    const l = new EventLog(ledgerDir, true)
    l.append({ ts: Date.now() - 1000, sessionID: "s", event: "turn", model: "a/1" })
    const { ctx, calls } = makeCtx()
    const teardown = await createV2Plugin(e.env).setup(ctx)
    try {
      const before = fs.readFileSync(statsFile, "utf8")
      const spy = vi.spyOn(fs, "renameSync").mockImplementation(() => { throw new Error("E_PERM secret /C:/users/path") })
      try {
        const purgeTool = calls.tools.find((t) => t.name === "relay_purge")!
        expect((await purgeTool.execute(undefined, {})).content).toBe(`Purged 1 ledger file(s). ${WARNING}`)
        const relayCmd = calls.commands.find((c) => c.name === "relay")!
        await relayCmd.execute({ sessionID: "s1", prompt: { text: "purge" }, delivery: "steer" })
        await until(() => calls.synthetic.some((x) => x.text.includes("Purged")))
        expect(calls.synthetic.at(-1)?.text).toBe(`Purged 0 ledger file(s). ${WARNING}`)
      } finally { spy.mockRestore() }
      expect(fs.readFileSync(statsFile, "utf8")).toBe(before) // prior valid destination preserved
      expect(calls.switchModel).toEqual([])
      expect(calls.prompt).toEqual([])
    } finally { teardown?.() }
  })

  it("defaults and both flag orders agree across surfaces; legacy arguments and a missing session stay contained", async () => {
    const e = env()
    const ledgerDir = path.join(e.root, "data", "opencode-model-relay")
    const l = new EventLog(ledgerDir, true)
    const now = Date.now()
    l.append({ ts: now - 2000, sessionID: "s", event: "failure", model: "a/1", errorKind: "quota" })
    l.append({ ts: now - 1000, sessionID: "s", event: "turn", model: "a/1", latencyMs: 100 })
    const { ctx, calls } = makeCtx()
    const teardown = await createV2Plugin(e.env).setup(ctx)
    try {
      const statsTool = calls.tools.find((t) => t.name === "relay_stats")!
      const bare = (await statsTool.execute(undefined, {})).content
      expect(bare).toContain("a/1 | 1 | 1 | – | 0 | 0 | 0% | – | 100ms | 0/0 | $0.00 | $0.00")
      expect((await statsTool.execute({}, {})).content).toBe(bare) // {} keeps defaults
      expect((await statsTool.execute({ days: 30 }, {})).content).toBe(bare) // explicit default window
      const relayCmd = calls.commands.find((c) => c.name === "relay")!
      await relayCmd.execute({ sessionID: "s1", prompt: { text: "stats" }, delivery: "steer" })
      expect(calls.synthetic.at(-1)?.text).toBe(bare) // bare command = defaults
      await relayCmd.execute({ sessionID: "s1", prompt: { text: "stats --days 30" }, delivery: "steer" })
      expect(calls.synthetic.at(-1)?.text).toBe(bare)
      const withKinds = (await statsTool.execute({ kinds: true }, {})).content
      expect(withKinds).toContain("a/1 failure kinds: quota 1")
      await relayCmd.execute({ sessionID: "s1", prompt: { text: "stats --days 30 --kinds" }, delivery: "steer" })
      expect(calls.synthetic.at(-1)?.text).toBe(withKinds)
      await relayCmd.execute({ sessionID: "s1", prompt: { text: "stats --kinds --days 30" }, delivery: "steer" })
      expect(calls.synthetic.at(-1)?.text).toBe(withKinds) // both flag orders
      await relayCmd.execute({ sessionID: "s1", arguments: "stats --days 30" }) // legacy arguments fallback
      expect(calls.synthetic.at(-1)?.text).toBe(bare)
      await expect(relayCmd.execute({ prompt: { text: "stats --days 1" } })).resolves.toBeTruthy() // no session
    } finally { teardown?.() }
  })
})

describe("v1 suppression while the v2 layer is active", () => {
  it("server() hooks no-op for failure events once setup() activated the v2 layer (#56)", async () => {
    const e = env()
    const { ctx } = makeCtx()
    await createV2Plugin(e.env).setup(ctx)
    const messages: any[] = [
      { info: { id: "u1", role: "user", model: { providerID: "a", modelID: "1" } }, parts: [{ type: "text", text: "fix the bug" }] },
      { info: { id: "a1", role: "assistant", providerID: "a", modelID: "1" }, parts: [] },
    ]
    const v1Calls: any[] = []
    const v1Client: any = {
      session: {
        get: async () => ({ data: {} }),
        messages: async () => ({ data: messages }),
        abort: async () => { v1Calls.push("abort"); return {} },
        prompt: async (a: any) => { v1Calls.push(a); return {} },
      },
      tui: { showToast: async () => {} },
    }
    const hooks: any = await createServer(e.env)({ client: v1Client, directory: e.root })
    await hooks.event({ event: { type: "session.error", properties: { sessionID: "s1", error: { name: "APIError", data: { statusCode: 429 } } } } })
    await new Promise((r) => setTimeout(r, 50))
    expect(v1Calls).toEqual([])
  })
})
