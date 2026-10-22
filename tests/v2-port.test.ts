import { describe, it, expect } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createV2Plugin } from "../src/v2"
import { createServer } from "../src/server"
import { RELAY_MARKER } from "../src/defaults"
import plugin from "../src/index"

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
    expect(calls.tools.map((t) => t.name)).toEqual(["relay_status", "relay_init"])
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
    expect(rec).toMatchObject({ sticky: "b/2", switchCount: 1 })
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
    seed(e.stateFile, { sticky: "b/2", origin: "a/1", switchCount: 1 })
    const teardown = await createV2Plugin(e.env).setup(ctx)
    const ev = { sessionID: "s1", attempt: 2, model: { providerID: "b", id: "2" }, error: { message: "429 Too Many Requests", status: 429 }, decision: {} as any }
    await calls.hooks.retry!(ev)
    await until(() => calls.switchModel.length > 0)
    expect(calls.switchModel.at(0)?.model).toEqual({ providerID: "c", id: "3" })
    expect(ev.decision).toEqual({ retry: false })
    expect(readState(e.stateFile).sessions.s1?.sticky).toBe("c/3")
    teardown?.()
  })
  it("a re-fired error attributed to the model that already switched away does not switch again", async () => {
    const e = env()
    const { ctx, calls } = makeCtx({
      sessionModel: { id: "2", providerID: "b" },
      messages: [user("u1", "fix the bug"), asst("a1", "a", "1", "x"), { id: "h1", time: { created: 3 }, text: `${RELAY_MARKER}\nhandover`, files: [], type: "user" }],
    })
    seed(e.stateFile, { sticky: "b/2", origin: "a/1", switchCount: 1 })
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

describe("v2 pinning", () => {
  it("admission pins the turn to the sticky model via switchModel", async () => {
    const e = env()
    seed(e.stateFile, { sticky: "b/2", origin: "a/1", switchCount: 1, updated: NOW })
    const { ctx, calls } = makeCtx()
    const teardown = await createV2Plugin(e.env).setup(ctx)
    calls.hooks.prompt!({ sessionID: "s1", prompt: { text: "next question" } })
    await until(() => calls.switchModel.length > 0)
    expect(calls.switchModel[0]).toEqual({ sessionID: "s1", model: { providerID: "b", id: "2" } })
    teardown?.()
  })
  it("our own handover prompt is never re-pinned", async () => {
    const e = env()
    seed(e.stateFile, { sticky: "b/2", origin: "a/1", switchCount: 1, updated: NOW })
    const { ctx, calls } = makeCtx()
    const teardown = await createV2Plugin(e.env).setup(ctx)
    calls.hooks.prompt!({ sessionID: "s1", prompt: { text: `${RELAY_MARKER}\nhandover` } })
    await new Promise((r) => setTimeout(r, 50))
    expect(calls.switchModel).toEqual([])
    teardown?.()
  })
  it("an explicit user pick outside the relay family clears stickiness without enacting", async () => {
    const e = env()
    seed(e.stateFile, { sticky: "b/2", origin: "a/1", switchCount: 1, helperCalls: 2, updated: 1 })
    const { ctx, calls } = makeCtx()
    const teardown = await createV2Plugin(e.env).setup(ctx)
    calls.hooks.context!({ sessionID: "s1", model: { providerID: "z", id: "9" } })
    await until(() => readState(e.stateFile).sessions.s1?.sticky === undefined)
    expect(calls.switchModel).toEqual([])
    const rec = readState(e.stateFile).sessions.s1
    expect(rec.switchCount).toBe(1) // counters survive the clear
    expect(rec.helperCalls).toBe(2)
    teardown?.()
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
    const relayCmd = calls.commands.find((c) => c.name === "relay")
    await relayCmd!.execute({ sessionID: "s1" })
    await until(() => calls.synthetic.length > 0)
    expect(calls.synthetic[0]).toMatchObject({ sessionID: "s1", text: expect.stringContaining("chain:") })
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
