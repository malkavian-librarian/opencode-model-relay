import { describe, it, expect } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Controller, type Deps } from "../src/controller"
import { ConfigSchema } from "../src/config"
import { SessionLock } from "../src/session-lock"
import { StateStore } from "../src/state"
import { createNarrator } from "../src/narrator"
import { RELAY_MARKER } from "../src/defaults"
import type { OcMessage } from "../src/types"

const T0 = 1_000_000
const COOLDOWN = 60_000
const err429 = (retryAfter?: string) => ({
  name: "APIError",
  data: { statusCode: 429, isRetryable: true, message: "", responseBody: "slow", responseHeaders: retryAfter === undefined ? {} : { "retry-after": retryAfter } },
})
const user = (id: string, text: string, providerID: string, modelID: string): OcMessage =>
  ({ info: { id, role: "user", agent: "build", model: { providerID, modelID } }, parts: [{ type: "text", text }] })
const asst = (id: string, providerID: string, modelID: string): OcMessage =>
  ({ info: { id, role: "assistant", providerID, modelID }, parts: [] })
const handoverParts = [{ type: "text", text: `${RELAY_MARKER}\nhandover` }]
const userParts = [{ type: "text", text: "next question" }]

function setup(mode: string, tiers: object = { primary: "a/1", secondary: ["b/2"], tertiary: ["c/3"] }, extra: object = {}) {
  const calls = { prompt: [] as any[], logs: [] as any[] }
  const messages: OcMessage[] = [user("u1", "fix the bug", "a", "1"), asst("a1", "a", "1")]
  const client: any = {
    session: {
      get: async () => ({ data: {} }),
      messages: async () => ({ data: messages }),
      abort: async () => ({}),
      prompt: (a: any) => { calls.prompt.push(a); return Promise.resolve({}) },
    },
    tui: { showToast: async () => ({}) },
  }
  const clock = { now: T0 }
  const state = new StateStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "relay-m-")), "state.json"), () => clock.now); state.load()
  const d: Deps = {
    client, cfg: ConfigSchema.parse({ mode, tiers, cooldownMs: COOLDOWN, ...extra }), lock: new SessionLock(), state, health: {},
    narrate: createNarrator({ verbosity: "off", tone: "plain" }), switchLog: { append: (r) => calls.logs.push(r) },
    env: {}, now: () => clock.now, chat: async () => ({ text: "" }), log: () => {}, switchOpts: { abortTimeoutMs: 20, abortDelayMs: 0 },
  }
  return { c: new Controller(d), d, calls, messages, clock }
}

describe("chain-recover", () => {
  it("returns to the primary on the next turn once its cooldown expired; clears sticky; not counted as a switch", async () => {
    const { c, d, calls, clock } = setup("chain-recover")
    await c.onSessionError("s1", err429())
    expect(d.state.get("s1")).toMatchObject({ sticky: "b/2", origin: "a/1", switchCount: 1 })

    clock.now = T0 + COOLDOWN - 1 // still cooling: plain pin to the sticky model
    expect(c.onChatMessage("s1", "a/1", userParts)).toBe("b/2")
    expect(calls.logs).toHaveLength(1)

    clock.now = T0 + COOLDOWN // expiry exactly now counts as recovered
    expect(c.onChatMessage("s1", "a/1", userParts)).toBe("a/1")
    const rec = d.state.get("s1")
    expect(rec.sticky).toBeUndefined()
    expect(rec.origin).toBeUndefined()
    expect(rec.switchCount).toBe(1)
    expect(calls.logs[1]).toMatchObject({ sessionID: "s1", from: "b/2", to: "a/1", kind: "recover" })

    expect(c.onChatMessage("s1", "a/1", userParts)).toBeUndefined() // nothing sticky any more
    expect(calls.logs).toHaveLength(2)
  })
  it("recovers from the sticky model too and keeps pinning it (TUI may keep sending the sticky model, #19)", async () => {
    const { c, d, calls, clock } = setup("chain-recover")
    await c.onSessionError("s1", err429())
    clock.now = T0 + COOLDOWN
    expect(c.onChatMessage("s1", "b/2", userParts)).toBe("a/1")
    expect(d.state.get("s1")).toMatchObject({ sticky: "a/1", origin: "b/2", switchCount: 1, recoveries: 1 })
    // the second message still arrives on B: it must run on the recovered A, not silently on B
    expect(c.onChatMessage("s1", "b/2", userParts)).toBe("a/1")
    expect(c.onChatMessage("s1", "a/1", userParts)).toBeUndefined()
    expect(calls.logs.filter((l) => l.kind === "recover")).toHaveLength(1)
  })
  it("no recovery at switchCount == cap - 1: the session stays on the working fallback", async () => {
    const { c, d, calls, clock } = setup("chain-recover", undefined, { maxSwitchesPerSession: 3 })
    d.state.set("s1", { sticky: "b/2", origin: "a/1", switchCount: 2, updated: T0 })
    clock.now = T0 + 100 * COOLDOWN
    expect(c.onChatMessage("s1", "a/1", userParts)).toBe("b/2")
    expect(d.state.get("s1").sticky).toBe("b/2")
    expect(calls.logs).toHaveLength(0)
  })
  it("stops recovering once recoveries reach the cap; relay_status shows the count", async () => {
    const { c, d, clock } = setup("chain-recover", undefined, { maxSwitchesPerSession: 3 })
    d.state.set("s1", { sticky: "b/2", origin: "a/1", switchCount: 1, recoveries: 3, updated: T0 })
    clock.now = T0 + 100 * COOLDOWN
    expect(c.onChatMessage("s1", "a/1", userParts)).toBe("b/2")
    expect(c.status("s1")).toContain("recoveries: 3")
    d.state.set("s1", { sticky: "b/2", origin: "a/1", switchCount: 1, recoveries: 2, updated: T0 })
    expect(c.onChatMessage("s1", "a/1", userParts)).toBe("a/1")
    expect(d.state.get("s1").recoveries).toBe(3)
    expect(c.status("s1")).toContain("recoveries: 3")
  })
  it("fail / recover cycles end on the working fallback, never stuck on the failing model at the cap", async () => {
    const { c, d, calls, messages, clock } = setup("chain-recover", { primary: "a/1", secondary: ["b/2"] }, { maxSwitchesPerSession: 3 })
    await c.onSessionError("s1", err429()) // a -> b (switch 1)
    clock.now += 10 * COOLDOWN
    expect(c.onChatMessage("s1", "a/1", userParts)).toBe("a/1") // recovery 1
    messages.push(user("u2", "again", "a", "1"), asst("a2", "a", "1"))
    await c.onSessionError("s1", err429()) // a -> b (switch 2)
    expect(d.state.get("s1")).toMatchObject({ sticky: "b/2", switchCount: 2, recoveries: 1 })
    clock.now += 10 * COOLDOWN
    expect(c.onChatMessage("s1", "a/1", userParts)).toBe("b/2") // cap - 1 reached: no more recovery
    expect(calls.prompt.map((p) => p.body.model.modelID)).toEqual(["2", "2"])
    expect(calls.logs.map((l) => l.kind)).toEqual(["rate_limit", "recover", "rate_limit"])
  })
  it("first failure with no assistant message yet switches away from the user message's model", async () => {
    const { c, calls, messages } = setup("chain-recover")
    messages.splice(0, messages.length, user("u1", "hi", "a", "1"))
    await c.onSessionError("s1", err429("0"))
    expect(calls.prompt[0].body.model).toEqual({ providerID: "b", modelID: "2" })
  })
  it("a marker pasted mid-message or in a synthetic part is a real user turn, so recovery still happens", async () => {
    const { c, d, clock } = setup("chain-recover")
    d.state.set("s1", { sticky: "b/2", origin: "a/1", switchCount: 1, updated: T0 })
    clock.now = T0 + COOLDOWN
    expect(c.onChatMessage("s1", "a/1", [{ type: "text", text: "see <!-- opencode-model-relay --> here" }])).toBe("a/1")
    d.state.set("s1", { sticky: "b/2", origin: "a/1", switchCount: 1, updated: T0 })
    expect(c.onChatMessage("s1", "a/1", [{ type: "text", synthetic: true, text: `${RELAY_MARKER}\nx` }, ...userParts])).toBe("a/1")
  })
  it("moves sticky up to a recovered secondary while the primary still cools; origin kept", async () => {
    const { c, d, calls, clock } = setup("chain-recover")
    d.state.set("s1", { sticky: "c/3", origin: "a/1", switchCount: 2, helperCalls: 1, updated: T0 })
    d.health["a/1"] = { cooldownUntil: T0 + 10 * COOLDOWN }
    d.health["b/2"] = { cooldownUntil: T0 }
    clock.now = T0 + 1
    expect(c.onChatMessage("s1", "a/1", userParts)).toBe("b/2")
    expect(d.state.get("s1")).toMatchObject({ sticky: "b/2", origin: "a/1", switchCount: 2, helperCalls: 1 })
    expect(calls.logs[0]).toMatchObject({ from: "c/3", to: "b/2", kind: "recover" })
  })
  it("a permanently blacklisted primary is never recovered", async () => {
    const { c, d, calls, clock } = setup("chain-recover", { primary: "a/1", secondary: ["b/2"] })
    await c.onSessionError("s1", { name: "APIError", data: { statusCode: 402, responseBody: "insufficient credits" } })
    clock.now = T0 + 100 * COOLDOWN
    expect(c.onChatMessage("s1", "a/1", userParts)).toBe("b/2")
    expect(d.state.get("s1").sticky).toBe("b/2")
    expect(calls.logs).toHaveLength(1)
  })
  it("never recovers on our own handover prompt (same failing turn) or while a switch holds the lock", async () => {
    const { c, d, clock } = setup("chain-recover")
    await c.onSessionError("s1", err429())
    clock.now = T0 + COOLDOWN
    expect(c.onChatMessage("s1", "b/2", handoverParts)).toBeUndefined()
    expect(c.onChatMessage("s1", "a/1", handoverParts)).toBe("b/2")
    d.lock.tryAcquire("s1")
    expect(c.onChatMessage("s1", "a/1", userParts)).toBe("b/2")
    d.lock.release("s1")
    expect(d.state.get("s1").sticky).toBe("b/2")
    expect(c.onChatMessage("s1", "a/1", userParts)).toBe("a/1") // lock released again after the decision
    expect(d.lock.tryAcquire("s1")).toBe(true)
  })
  it("a user-picked model still clears stickiness and keeps the counters", async () => {
    const { c, d, calls } = setup("chain-recover")
    d.state.set("s1", { sticky: "b/2", origin: "a/1", switchCount: 3, helperCalls: 2, updated: T0 })
    expect(c.onChatMessage("s1", "z/9", userParts)).toBeUndefined()
    expect(d.state.get("s1")).toEqual({ switchCount: 3, helperCalls: 2, updated: T0 })
    expect(calls.logs).toHaveLength(0)
  })
  it("a model tried for the same failing turn is never re-chosen, even after its cooldown ran out", async () => {
    const { c, calls, messages } = setup("chain-recover")
    await c.onSessionError("s1", err429("0")) // a/1 cools down for 0 ms: healthy again at once
    expect(calls.prompt[0].body.model).toEqual({ providerID: "b", modelID: "2" })
    messages.push(user("h1", `${RELAY_MARKER}\nhandover`, "b", "2"), asst("b1", "b", "2"))
    await c.onSessionError("s1", err429())
    expect(calls.prompt[1].body.model).toEqual({ providerID: "c", modelID: "3" })
  })
  it("never throws: a failing state store leaves the turn alone", () => {
    const { c, d } = setup("chain-recover")
    ;(d.state as any).get = () => { throw new Error("boom") }
    expect(c.onChatMessage("s1", "a/1", userParts)).toBeUndefined()
  })
})

describe("chain-sticky", () => {
  it("a model tried for the same failing turn is never re-chosen (incl. a 0 ms Retry-After) and never auto-returns on a new turn", async () => {
    const { c, d, calls, messages, clock } = setup("chain-sticky")
    await c.onSessionError("s1", err429("0")) // a/1 cools down for 0 ms: healthy again at once
    expect(calls.prompt[0].body.model).toEqual({ providerID: "b", modelID: "2" })
    messages.push(user("h1", `${RELAY_MARKER}\nhandover`, "b", "2"), asst("b1", "b", "2"))
    await c.onSessionError("s1", err429())
    expect(calls.prompt[1].body.model).toEqual({ providerID: "c", modelID: "3" })
    expect(d.state.get("s1")).toMatchObject({ sticky: "c/3", switchCount: 2 })

    d.state.set("s1", { sticky: "b/2", origin: "a/1", switchCount: 1, updated: T0 })
    clock.now = T0 + 100 * COOLDOWN
    expect(c.onChatMessage("s1", "a/1", userParts)).toBe("b/2")
    expect(c.onChatMessage("s1", "b/2", userParts)).toBeUndefined()
    expect(d.state.get("s1").sticky).toBe("b/2")
    expect(calls.logs.every((l) => l.kind !== "recover")).toBe(true)
  })
})

describe("escalate", () => {
  const tiers = { primary: "a/1", secondary: ["b/2", "b/3"], tertiary: ["c/3"] }
  it("moves up a tier, skipping same-tier siblings, and is exhausted at the top tier", async () => {
    const { c, d, calls, messages } = setup("escalate", tiers)
    await c.onSessionError("s1", err429())
    expect(calls.prompt[0].body.model).toEqual({ providerID: "b", modelID: "2" })
    messages.push(user("h1", `${RELAY_MARKER}\nhandover`, "b", "2"), asst("b1", "b", "2"))
    await c.onSessionError("s1", err429())
    expect(calls.prompt[1].body.model).toEqual({ providerID: "c", modelID: "3" })
    messages.push(user("h2", `${RELAY_MARKER}\nhandover`, "c", "3"), asst("c1", "c", "3"))
    await c.onSessionError("s1", err429())
    expect(calls.prompt).toHaveLength(2)
    expect(d.state.get("s1")).toMatchObject({ sticky: "c/3", origin: "a/1", switchCount: 2 })
  })
  it("pins like chain-sticky and never auto-returns", async () => {
    const { c, d, clock } = setup("escalate", tiers)
    d.state.set("s1", { sticky: "c/3", origin: "a/1", switchCount: 1, updated: T0 })
    clock.now = T0 + 100 * COOLDOWN
    expect(c.onChatMessage("s1", "a/1", userParts)).toBe("c/3")
  })
})
