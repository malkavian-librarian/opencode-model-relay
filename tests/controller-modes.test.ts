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
import { recordFailure, walkFromTop, type ModelHealth } from "../src/strategy"
import type { Classified, OcMessage } from "../src/types"

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

function setup(levels: unknown[] = ["a/1", "b/2", "c/3"], extra: object = {}) {
  const calls = { prompt: [] as any[], logs: [] as any[], toasts: [] as any[] }
  const messages: OcMessage[] = [user("u1", "fix the bug", "a", "1"), asst("a1", "a", "1")]
  const client: any = {
    session: {
      get: async () => ({ data: {} }),
      messages: async () => ({ data: messages }),
      abort: async () => ({}),
      prompt: (a: any) => { calls.prompt.push(a); return Promise.resolve({}) },
    },
    tui: { showToast: async (b: any) => { calls.toasts.push(b) } },
  }
  const clock = { now: T0 }
  const state = new StateStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "relay-m-")), "state.json"), () => clock.now); state.load()
  const d: Deps = {
    client, cfg: ConfigSchema.parse({ levels, cooldownMs: COOLDOWN, ...extra }), lock: new SessionLock(), state, health: {},
    narrate: createNarrator({ verbosity: "off", tone: "plain" }), switchLog: { append: (r) => calls.logs.push(r) },
    env: {}, now: () => clock.now, chat: async () => ({ text: "" }), log: () => {}, switchOpts: { abortTimeoutMs: 20, abortDelayMs: 0 },
  }
  return { c: new Controller(d), d, calls, messages, clock }
}

describe("failover walk over levels (#66)", () => {
  it("a model tried for the same failing turn is never re-chosen, even after its cooldown ran out", async () => {
    const { c, d, calls, messages } = setup()
    await c.onSessionError("s1", err429("0")) // a/1 cools down for 0 ms: healthy again at once
    expect(calls.prompt[0].body.model).toEqual({ providerID: "b", modelID: "2" })
    messages.push(user("h1", `${RELAY_MARKER}\nhandover`, "b", "2"), asst("b1", "b", "2"))
    await c.onSessionError("s1", err429())
    expect(calls.prompt[1].body.model).toEqual({ providerID: "c", modelID: "3" })
    expect(d.state.get("s1")).toMatchObject({ pluginPinned: "c/3", switchCount: 2 })
  })
  it("first failure with no assistant message yet switches away from the user message's model", async () => {
    const { c, calls, messages } = setup()
    messages.splice(0, messages.length, user("u1", "hi", "a", "1"))
    await c.onSessionError("s1", err429("0"))
    expect(calls.prompt[0].body.model).toEqual({ providerID: "b", modelID: "2" })
  })
  it("the per-session quarantine is wired: a cooldown-expired corpse stays skipped within 10 min (October oscillation, controller level)", async () => {
    const { c, d, calls, messages, clock } = setup()
    await c.onSessionError("s1", err429()) // a/1 -> b/2; the session record carries quarantine[a/1]
    expect(calls.prompt[0].body.model).toEqual({ providerID: "b", modelID: "2" })
    expect(d.state.get("s1").quarantine).toMatchObject({ "a/1": T0 })
    // T0+90 s, a NEW turn: b/2 fails too. a/1's 60 s cooldown has expired; without the quarantine the
    // walk-from-top re-enters the corpse (the exact gpt-6.1-sol <-> glm-5.3-flash-free loop).
    messages.splice(0, messages.length, user("u2", "again", "b", "2"), asst("b1", "b", "2"))
    clock.now = T0 + 90_000
    await c.onSessionError("s1", err429())
    expect(calls.prompt[1].body.model).toEqual({ providerID: "c", modelID: "3" })
  })
})

describe("retry storm token (#66)", () => {
  it("retry events after an enacted switch are consumed for 30 s, then handled again", async () => {
    const { c, d, calls, messages, clock } = setup()
    await c.onSessionError("s1", err429()) // a/1 -> b/2 enacted at T0
    expect(calls.prompt).toHaveLength(1)
    messages.push(user("u2", "again", "a", "1")) // a stale retry of the old turn lands as a new row
    clock.now = T0 + 5_000
    await c.onRetryStatus("s1", 3, "rate limit")
    expect(calls.prompt).toHaveLength(1) // consumed: handle is never re-entered
    messages.push(user("u3", "again", "a", "1"))
    clock.now = T0 + 31_000
    await c.onRetryStatus("s1", 4, "rate limit")
    expect(calls.prompt).toHaveLength(2) // window over: the service resumes
  })
})

describe("E-01: October oscillation replica — walk from top with per-session quarantine (#64)", () => {
  const L1 = "openai/gpt-6.1-sol"
  const L2 = "opencode/glm-5.3-flash-free"
  const L3 = "openrouter/meta/muse-wonder"
  const rl: Classified = { kind: "rate_limit", retryable: true, permanent: false, switchable: true }
  it("an expired cooldown must not re-enter the corpse: quarantine holds for 10 min", () => {
    const health: Record<string, ModelHealth> = {}
    const quarantine: Record<string, number> = {}
    // T0: L1 rate-limits with the 60 s default cooldown; the walk moves to L2.
    recordFailure(health, L1, rl, T0, COOLDOWN)
    quarantine[L1] = T0
    expect(walkFromTop({ ladder: [L1, L2, L3], current: L1, health, quarantine, now: T0, switchCount: 1, maxSwitches: 6 })).toEqual({ action: "switch", to: L2 })
    // T0+90 s, a NEW turn (tried resets, so only the failing L2 is tried): L2 fails too. L1's
    // 60 s cooldown has expired, so without quarantine the walk-from-top re-enters L1 — the
    // exact gpt-6.1-sol <-> glm-5.3-flash-free loop from switches.jsonl.
    const T1 = T0 + 90_000
    recordFailure(health, L2, rl, T1, COOLDOWN)
    quarantine[L2] = T1
    expect(walkFromTop({ ladder: [L1, L2, L3], current: L2, health, now: T1, switchCount: 2, maxSwitches: 6, tried: [L2] })).toEqual({ action: "switch", to: L1 })
    // With the per-session quarantine, the walk skips L1 and picks L3 or deeper instead.
    expect(walkFromTop({ ladder: [L1, L2, L3], current: L2, health, quarantine, now: T1, switchCount: 2, maxSwitches: 6, tried: [L2] })).toEqual({ action: "switch", to: L3 })
  })
})

describe("E-01 (#66): October stranding replay — never a silent no-op", () => {
  const L1 = "openai/gpt-6.1-sol"
  const L2 = "opencode/glm-5.3-flash-free"
  const L3 = "openrouter/meta/muse-wonder"
  it("a permanent failure on L1 with everything else tried/cooling emits an observable action, not silence", async () => {
    const { c, d, calls, messages } = setup([L1, L2, L3])
    d.narrate = createNarrator({ verbosity: "normal", tone: "plain" })
    messages.splice(0, messages.length, user("u1", "fix the bug", "openai", "gpt-6.1-sol"), asst("a1", "openai", "gpt-6.1-sol"))
    d.health[L2] = { cooldownUntil: T0 + 10 * COOLDOWN }
    d.health[L3] = { cooldownUntil: T0 + 10 * COOLDOWN }
    await c.onSessionError("s1", { name: "APIError", data: { statusCode: 402, responseBody: "insufficient credits" } })
    expect(calls.prompt).toHaveLength(0) // nothing healthy to switch to
    expect(calls.toasts.length).toBeGreaterThan(0)
    const text = calls.toasts.map((t: any) => t.body.message).join(" ")
    expect(text).toMatch(/no healthy model/i) // the owner is told why
    expect(text).toMatch(/relay next/) // and what to do
  })
})
