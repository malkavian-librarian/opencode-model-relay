import { afterEach, describe, it, expect } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Controller, type Deps } from "../src/controller"
import { ConfigSchema } from "../src/config"
import { SessionLock } from "../src/session-lock"
import { StateStore } from "../src/state"
import { createNarrator } from "../src/narrator"
import { RELAY_MARKER } from "../src/defaults"
import { PERMANENT_HEALTH_TTL_MS, recordFailure, walkFromTop, type ModelHealth } from "../src/strategy"
import type { Classified, OcMessage } from "../src/types"
import { EventLog, type EventInput } from "../src/ledger"

const T0 = 1_000_000
const COOLDOWN = 60_000
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })
const err429 = (retryAfter?: string) => ({
  name: "APIError",
  data: { statusCode: 429, isRetryable: true, message: "", responseBody: "slow", responseHeaders: retryAfter === undefined ? {} : { "retry-after": retryAfter } },
})
const user = (id: string, text: string, providerID: string, modelID: string): OcMessage =>
  ({ info: { id, role: "user", agent: "build", model: { providerID, modelID } }, parts: [{ type: "text", text }] })
const asst = (id: string, providerID: string, modelID: string): OcMessage =>
  ({ info: { id, role: "assistant", providerID, modelID }, parts: [] })

function setup(levels: unknown[] = ["a/1", "b/2", "c/3"], extra: object = {}) {
  const calls = { abort: [] as any[], prompt: [] as any[], logs: [] as any[], toasts: [] as any[], events: [] as EventInput[] }
  const messages: OcMessage[] = [user("u1", "fix the bug", "a", "1"), asst("a1", "a", "1")]
  const client: any = {
    session: {
      get: async () => ({ data: {} }),
      messages: async () => ({ data: messages }),
      abort: async (a: any) => { calls.abort.push(a); return {} },
      prompt: (a: any) => { calls.prompt.push(a); return Promise.resolve({}) },
    },
    tui: { showToast: async (b: any) => { calls.toasts.push(b) } },
  }
  const clock = { now: T0 }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-m-")); dirs.push(dir)
  const state = new StateStore(path.join(dir, "state.json"), () => clock.now); state.load()
  const d: Deps = {
    client, cfg: ConfigSchema.parse({ levels, cooldownMs: COOLDOWN, ...extra }), lock: new SessionLock(), state, health: {},
    narrate: createNarrator({ verbosity: "off", tone: "plain" }), switchLog: { append: (r) => calls.logs.push(r) },
    ledger: { append: (event) => { calls.events.push(event); return true } },
    env: {}, now: () => clock.now, chat: async () => ({ text: "" }), log: () => {}, switchOpts: { abortTimeoutMs: 20, abortDelayMs: 0 },
  }
  return { c: new Controller(d), d, calls, messages, clock, dir }
}

describe("health telemetry paths (#108)", () => {
  it.each(["adoption", "manual command", "supersession"])("closes health marks before %s clears them", async (mode) => {
    const { c, d, messages } = setup(["a/1", "b/2", "c/3"])
    d.health = d.state.health
    const mark = { cooldownUntil: T0 + COOLDOWN, permanent: true, permanentAt: T0, failures: 3 }
    d.health["b/2"] = { ...mark }
    d.state.set("s1", { pluginPinned: "a/1", switchCount: 2, helperCalls: 1, updated: T0 })
    d.state.save()
    const events: EventInput[] = []; const marksAtEmission: Array<ModelHealth | undefined> = []
    d.ledger = { append: (event) => {
      if (event.event === "health" && event.model === "b/2") {
        events.push(event); marksAtEmission.push(d.health["b/2"] && { ...d.health["b/2"] })
      }
      return true
    } }
    if (mode === "adoption") c.adoptPick("s1", "b/2")
    else if (mode === "manual command") await expect(c.manualSwitch("s1", "b/2")).resolves.toMatchObject({ status: "switched", to: "b/2" })
    else {
      d.client.session.abort = async () => {
        messages.push(user("u2", "picked", "b", "2"))
        return {}
      }
      await expect(c.onSessionError("s1", err429())).resolves.toBe(false)
    }
    expect(events).toEqual([
      { ts: T0, sessionID: "s1", event: "health", model: "b/2", tier: 2, what: "cooldown_end" },
      { ts: T0, sessionID: "s1", event: "health", model: "b/2", tier: 2, what: "permanent_expire" },
    ])
    expect(marksAtEmission).toEqual([mark, mark])
    expect(d.health["b/2"]).toBeUndefined()
    expect(d.state.get("s1")).toMatchObject({ pluginPinned: "b/2", switchCount: 2, helperCalls: 1 })
    c.adoptPick("s1", "b/2")
    expect(events).toHaveLength(2)
  })

  it("timestamps manual health clearing when the clear occurs", async () => {
    const { c, d, calls, clock } = setup(["a/1", "b/2"])
    d.health = d.state.health
    d.health["b/2"] = { cooldownUntil: T0 + COOLDOWN }
    d.state.set("s1", { pluginPinned: "a/1", switchCount: 0, updated: T0 })
    d.state.save()
    let reads = 0
    d.now = () => T0 + (reads++ === 0 ? 0 : 100)

    await expect(c.manualSwitch("s1", "b/2")).resolves.toMatchObject({ status: "switched", to: "b/2" })
    expect(calls.events.find((e) => e.event === "health" && e.what === "cooldown_end")).toMatchObject({ ts: T0 + 100 })
  })

  it("emits expiry for an expired mark that the selected ladder does not visit before save pruning", async () => {
    const { c, d, calls } = setup(["a/1", "b/2", "c/3"])
    d.health = d.state.health
    d.state.set("s1", { pluginPinned: "a/1", switchCount: 0, updated: T0 })
    d.state.save()
    d.health["c/3"] = { cooldownUntil: T0 }
    calls.events.length = 0

    await expect(c.onSessionError("s1", err429())).resolves.toBe(true)
    expect(calls.events).toContainEqual({ ts: T0, sessionID: "s1", event: "health", model: "c/3", tier: 3, what: "cooldown_end" })
    expect(d.health["c/3"]).toBeUndefined()
  })

  it.each([
    { name: "exhaustion", capped: false, blocked: true, circular: false, what: "exhausted" },
    { name: "cap without a fallback", capped: true, blocked: true, circular: false, what: "cap_hit" },
    { name: "cap with a fallback", capped: true, blocked: false, circular: false, what: "cap_hit" },
    { name: "circular cap", capped: true, blocked: false, circular: true, what: "cap_hit" },
  ])("emits one outcome for $name and preserves the decision", async ({ capped, blocked, circular, what }) => {
    const { c, d, calls } = setup(["a/1", "b/2"], { maxSwitchesPerSession: 1, maxCircularFlows: circular ? 1 : 0 })
    d.state.set("s1", { pluginPinned: "a/1", switchCount: capped ? 1 : 0, updated: T0 })
    if (blocked) d.health["b/2"] = { cooldownUntil: T0 + COOLDOWN }
    const switched = capped && !blocked && !circular
    expect(await c.onSessionError("s1", err429())).toBe(switched)
    expect(calls.events.filter((e) => e.event === "health" && (e.what === "cap_hit" || e.what === "exhausted"))).toEqual([
      { ts: T0, sessionID: "s1", event: "health", model: "a/1", tier: 1, what },
    ])
    expect(calls.prompt).toHaveLength(switched ? 1 : 0)
    expect(calls.abort).toHaveLength(switched ? 1 : 0)
    expect(d.state.get("s1")).toMatchObject({ pluginPinned: switched ? "b/2" : "a/1", switchCount: switched ? 2 : capped ? 1 : 0 })
  })

  it.each(["fallback", "circular"])("emits one quarantine skip on the %s path", async (mode) => {
    const { c, d, calls, messages } = setup(["a/1", "b/2"], { maxCircularFlows: mode === "circular" ? 1 : 0 })
    d.state.set("s1", { switchCount: 0, updated: T0, quarantine: { "b/2": T0 } })
    if (mode === "fallback") messages.push(asst("b1", "b", "2"), asst("a2", "a", "1"))
    expect(await c.onSessionError("s1", err429())).toBe(mode === "circular")
    expect(calls.events.filter((e) => e.what === "quarantine_skip")).toEqual([
      { ts: T0, sessionID: "s1", event: "health", model: "b/2", tier: 2, what: "quarantine_skip" },
    ])
    expect(calls.prompt).toHaveLength(mode === "circular" ? 1 : 0)
  })

  it("deduplicates expired marks across ladder, fallback, repeated failures and idle reads", async () => {
    const { c, d, calls, messages, clock } = setup(["a/1", "b/2"])
    clock.now += PERMANENT_HEALTH_TTL_MS
    d.health["b/2"] = { cooldownUntil: clock.now, permanent: true, permanentAt: T0, failures: 2 }
    expect(await c.onSessionError("s1", err429())).toBe(false)
    messages.push(asst("a2", "a", "1"))
    expect(await c.onSessionError("s1", err429())).toBe(false)
    messages.push(asst("b1", "b", "2"))
    await expect(c.onSessionIdle("s1")).resolves.toBeUndefined()
    expect(calls.events.filter((e) => e.event === "health" && e.model === "b/2")).toEqual([
      { ts: clock.now, sessionID: "s1", event: "health", model: "b/2", tier: 2, what: "cooldown_end" },
      { ts: clock.now, sessionID: "s1", event: "health", model: "b/2", tier: 2, what: "permanent_expire" },
    ])
    expect(d.health["b/2"]).toEqual({ failures: 2 })
  })

  describe.each(["disabled", "unwritable", "throwing"] as const)("%s ledger", (failure) => {
    it.each(["switch", "exhaustion", "cap", "idle"] as const)("isolates %s decisions, counters and persisted health from emission failure", async (scenario) => {
      const baseline = setup(["a/1", "b/2"], { maxSwitchesPerSession: 1 })
      const failing = setup(["a/1", "b/2"], { maxSwitchesPerSession: 1 })
      for (const { d } of [baseline, failing]) {
        d.health = d.state.health
        d.state.set("s1", { pluginPinned: "a/1", switchCount: scenario === "cap" ? 1 : 0, updated: T0 })
        if (scenario === "exhaustion" || scenario === "cap") d.health["b/2"] = { cooldownUntil: T0 + COOLDOWN }
        if (scenario === "idle") d.health["a/1"] = { cooldownUntil: T0 + COOLDOWN, permanent: true, permanentAt: T0 }
        d.state.save()
      }
      const ledgerDir = path.join(failing.dir, "ledger")
      // A regular file makes appends fail even when tests run with elevated filesystem permissions.
      if (failure === "unwritable") fs.writeFileSync(ledgerDir, "blocked")
      const ledger = new EventLog(ledgerDir, failure !== "disabled")
      const attempts: EventInput[] = []; const results: boolean[] = []
      failing.d.ledger = { append: (event) => {
        attempts.push(event)
        if (failure === "throwing") throw new Error("ledger unavailable")
        const result = ledger.append(event); results.push(result); return result
      } }
      const result = scenario === "idle" ? await baseline.c.onSessionIdle("s1") : await baseline.c.onSessionError("s1", err429())
      const failedResult = scenario === "idle" ? await failing.c.onSessionIdle("s1") : await failing.c.onSessionError("s1", err429())
      expect(result).toBe(scenario === "idle" ? undefined : scenario === "switch")
      expect(failedResult).toBe(result)
      expect(attempts.filter((e) => e.event === "health")).toEqual(baseline.calls.events.filter((e) => e.event === "health"))
      expect(attempts.some((e) => e.event === "health")).toBe(true)
      if (failure !== "throwing") expect(results).toEqual(attempts.map(() => false))
      if (failure === "disabled") expect(fs.existsSync(ledgerDir)).toBe(false)
      expect(failing.calls).toMatchObject({ abort: baseline.calls.abort, prompt: baseline.calls.prompt, logs: baseline.calls.logs, toasts: baseline.calls.toasts })
      expect(failing.d.health).toEqual(baseline.d.health)
      expect(failing.d.state.get("s1")).toEqual(baseline.d.state.get("s1"))
      expect(JSON.parse(fs.readFileSync(path.join(failing.dir, "state.json"), "utf8"))).toEqual(
        JSON.parse(fs.readFileSync(path.join(baseline.dir, "state.json"), "utf8")),
      )
    })
  })
})

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
