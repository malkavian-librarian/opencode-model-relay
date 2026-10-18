import { describe, it, expect } from "vitest"
import { performSwitch } from "../src/switcher"
import { SessionLock } from "../src/session-lock"

function fake(over: { abort?: () => Promise<unknown>; prompt?: (a: any) => Promise<unknown> } = {}) {
  const calls: { abort: any[]; prompt: any[] } = { abort: [], prompt: [] }
  const client: any = {
    session: {
      abort: async (a: any) => { calls.abort.push(a); return over.abort ? over.abort() : {} },
      prompt: (a: any) => { calls.prompt.push(a); return over.prompt ? over.prompt(a) : Promise.resolve({}) },
    },
  }
  return { client, calls }
}
const args = { sessionID: "s1", to: { providerID: "b", modelID: "2" }, agent: "build", handoverText: "HANDOVER" }
const fast = { abortTimeoutMs: 20, abortDelayMs: 0 }

describe("performSwitch", () => {
  it("marks the abort, aborts, then prompts the new model with the handover", async () => {
    const { client, calls } = fake(); const lock = new SessionLock()
    await performSwitch({ client, lock, ...fast }, args)
    expect(calls.abort).toEqual([{ path: { id: "s1" } }])
    expect(lock.consumePluginAbort("s1")).toBe(true)
    expect(calls.prompt[0]).toEqual({
      path: { id: "s1" },
      body: { model: { providerID: "b", modelID: "2" }, agent: "build", parts: [{ type: "text", text: "HANDOVER" }] },
    })
  })
  it("does not prompt until abort has resolved, then waits abortDelayMs", async () => {
    let resolveAbort!: () => void
    const abortGate = new Promise<void>((r) => { resolveAbort = r })
    let abortResolvedAt = 0
    let promptAt = 0
    const { client, calls } = fake({
      abort: () => abortGate,
      prompt: () => { promptAt = Date.now(); return Promise.resolve({}) },
    })
    const delay = 60
    const done = performSwitch({ client, lock: new SessionLock(), abortTimeoutMs: 5000, abortDelayMs: delay }, args)
    await new Promise((r) => setTimeout(r, 80))
    expect(calls.abort).toHaveLength(1)
    expect(calls.prompt).toHaveLength(0) // abort still pending, even after more than the delay has passed
    abortResolvedAt = Date.now(); resolveAbort()
    await done
    expect(calls.prompt).toHaveLength(1)
    expect(promptAt - abortResolvedAt).toBeGreaterThanOrEqual(delay - 5)
  })
  it("omits agent when unknown", async () => {
    const { client, calls } = fake()
    await performSwitch({ client, lock: new SessionLock(), ...fast }, { ...args, agent: undefined })
    expect("agent" in calls.prompt[0].body).toBe(false)
  })
  it("does not wait for the prompt to finish (a whole model turn)", async () => {
    const { client } = fake({ prompt: () => new Promise(() => {}) })
    await expect(Promise.race([
      performSwitch({ client, lock: new SessionLock(), ...fast }, args).then(() => "done"),
      new Promise((r) => setTimeout(() => r("hung"), 500)),
    ])).resolves.toBe("done")
  })
  it("continues when abort hangs (timeout) or rejects, and clears the mark on reject", async () => {
    const hang = fake({ abort: () => new Promise(() => {}) })
    await performSwitch({ client: hang.client, lock: new SessionLock(), ...fast }, args)
    expect(hang.calls.prompt).toHaveLength(1)
    const lock = new SessionLock()
    const rej = fake({ abort: () => Promise.reject(new Error("nope")) })
    await performSwitch({ client: rej.client, lock, ...fast }, args)
    expect(rej.calls.prompt).toHaveLength(1)
    expect(lock.consumePluginAbort("s1")).toBe(false)
  })
  it("logs, and never throws, when the prompt fails", async () => {
    const logs: string[] = []
    const { client } = fake({ prompt: () => Promise.reject(new Error("boom")) })
    await performSwitch({ client, lock: new SessionLock(), ...fast, log: (m) => logs.push(m) }, args)
    await new Promise((r) => setTimeout(r, 10))
    expect(logs.join(" ")).toMatch(/boom/)
  })
  it("keeps the abort mark when abort timed out", async () => {
    const lock = new SessionLock()
    const { client } = fake({ abort: () => new Promise(() => {}) })
    await performSwitch({ client, lock, ...fast }, args)
    expect(lock.consumePluginAbort("s1")).toBe(true)
  })
  it("abort rejecting after the timeout fired causes no unhandled rejection and keeps the mark", async () => {
    const unhandled: unknown[] = []
    const h = (e: unknown) => unhandled.push(e)
    process.on("unhandledRejection", h)
    try {
      const lock = new SessionLock()
      const { client } = fake({ abort: () => new Promise((_, rej) => setTimeout(() => rej(new Error("late")), 60)) })
      await performSwitch({ client, lock, abortTimeoutMs: 10, abortDelayMs: 0 }, args)
      await new Promise((r) => setTimeout(r, 120))
      expect(unhandled).toEqual([])
      expect(lock.consumePluginAbort("s1")).toBe(true)
    } finally { process.off("unhandledRejection", h) }
  })
  it("catches a synchronous throw from session.prompt and logs it", async () => {
    const logs: string[] = []
    const { client } = fake({ prompt: () => { throw new Error("syncboom") } })
    await expect(performSwitch({ client, lock: new SessionLock(), ...fast, log: (m) => logs.push(m) }, args)).resolves.toBeUndefined()
    expect(logs.join(" ")).toMatch(/syncboom/)
  })
  it("catches a synchronous throw from session.abort and still prompts", async () => {
    const lock = new SessionLock()
    const calls: any[] = []
    const client: any = { session: { abort: () => { throw new Error("x") }, prompt: (a: any) => { calls.push(a); return Promise.resolve({}) } } }
    await performSwitch({ client, lock, ...fast }, args)
    expect(calls).toHaveLength(1)
    expect(lock.consumePluginAbort("s1")).toBe(false)
  })
  it("never throws when the log callback itself throws", async () => {
    const throwingLog = () => { throw new Error("logfail") }
    const unhandled: unknown[] = []
    const h = (e: unknown) => unhandled.push(e)
    process.on("unhandledRejection", h)
    try {
      const a = fake({ prompt: () => Promise.reject(new Error("boom")) })
      await expect(performSwitch({ client: a.client, lock: new SessionLock(), ...fast, log: throwingLog }, args)).resolves.toBeUndefined()
      const b = fake({ prompt: () => { throw new Error("sync") } })
      await expect(performSwitch({ client: b.client, lock: new SessionLock(), ...fast, log: throwingLog }, args)).resolves.toBeUndefined()
      await new Promise((r) => setTimeout(r, 20))
      expect(unhandled).toEqual([])
    } finally { process.off("unhandledRejection", h) }
  })
})
