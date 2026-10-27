import { describe, it, expect, vi } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { defaultConfig } from "../src/config"
import {
  buildLadder, clearSuccess, effectiveMaxSwitches, hasRelayMarker, isHealthy, resolveFindLevel, walkCircular, walkFromTopAsync,
  parseResetCooldown, recordFailure, triedThisTurn, walkFromTop,
  PERMANENT_HEALTH_TTL_MS, QUARANTINE_MS, RESET_COOLDOWN_MAX_MS,
  type Decision, type ModelHealth,
} from "../src/strategy"
import { StateStore } from "../src/state"
import { RELAY_MARKER } from "../src/defaults"
import type { Classified, OcMessage } from "../src/types"

// Decision helpers shared by the ladder tests (#64/#66).
const sw = (to: string): Decision => ({ action: "switch", to })
const NONE: Decision = { action: "exhausted", reason: "no_candidates" }
const CAP: Decision = { action: "exhausted", reason: "switch_cap" }


describe("triedThisTurn", () => {
  const user = (id: string, text: string, model?: { providerID: string; modelID: string }): OcMessage =>
    ({ info: { id, role: "user", ...(model ? { model } : {}) }, parts: [{ type: "text", text }] })
  const asst = (id: string, providerID: string, modelID: string): OcMessage => ({ info: { id, role: "assistant", providerID, modelID }, parts: [] })
  it("collects models since the newest real user message, across relay handovers", () => {
    const msgs = [
      user("u0", "old", { providerID: "x", modelID: "0" }), asst("a0", "x", "0"),
      user("u1", "fix it", { providerID: "a", modelID: "1" }), asst("a1", "a", "1"),
      user("h1", `${RELAY_MARKER}\nhandover`, { providerID: "b", modelID: "2" }), asst("b1", "b", "2"),
    ]
    expect(triedThisTurn(msgs).sort()).toEqual(["a/1", "b/2"])
  })
  it("a marker pasted mid-message is not a handover; a leading marker counts even when synthetic (#56)", () => {
    const pasted = user("u2", `look: ${RELAY_MARKER} odd`, { providerID: "b", modelID: "2" })
    const synthetic: OcMessage = { info: { id: "u3", role: "user", model: { providerID: "c", modelID: "3" } }, parts: [{ type: "text", text: `${RELAY_MARKER}\nx`, synthetic: true }] }
    expect(triedThisTurn([user("u1", "x", { providerID: "a", modelID: "1" }), pasted])).toEqual(["b/2"])
    // The synthetic marker message is our own handover prompt: it continues the turn instead of starting one.
    expect(triedThisTurn([user("u1", "x", { providerID: "a", modelID: "1" }), synthetic])).toEqual(["a/1", "c/3"])
    expect(hasRelayMarker(pasted.parts)).toBe(false)
    expect(hasRelayMarker(synthetic.parts)).toBe(true)
    expect(hasRelayMarker([{ type: "text", text: `${RELAY_MARKER}\nhandover` }])).toBe(true)
    expect(hasRelayMarker(undefined)).toBe(false)
  })
  it("first failure before any assistant reply: the user message's model is tried", () => {
    expect(triedThisTurn([user("u1", "hi", { providerID: "a", modelID: "1" })])).toEqual(["a/1"])
  })
  it("is empty for no messages and tolerates malformed entries", () => {
    expect(triedThisTurn([])).toEqual([])
    expect(triedThisTurn([{ parts: [] } as any, asst("a1", "a", "1")])).toEqual(["a/1"])
  })
})

describe("recordFailure", () => {
  const c = (o: Partial<Classified>): Classified => ({ kind: "rate_limit", retryable: true, permanent: false, switchable: true, ...o })
  it("permanent errors blacklist", () => {
    const h: Record<string, ModelHealth> = {}
    recordFailure(h, "a/1", c({ kind: "quota", permanent: true }), 1000, 60000)
    expect(h["a/1"]?.permanent).toBe(true)
  })
  it("transient errors cool down, using retry-after when given", () => {
    const h: Record<string, ModelHealth> = {}
    recordFailure(h, "a/1", c({ retryAfterMs: 5000 }), 1000, 60000)
    expect(h["a/1"]?.cooldownUntil).toBe(6000)
  })
  it("repeated transient failures back off exponentially, capped at 1h", () => {
    const h: Record<string, ModelHealth> = {}
    recordFailure(h, "a/1", c({}), 0, 60000)
    recordFailure(h, "a/1", c({}), 0, 60000)
    expect(h["a/1"]?.cooldownUntil).toBe(120000)
    for (let i = 0; i < 20; i++) recordFailure(h, "a/1", c({}), 0, 60000)
    expect(h["a/1"]?.cooldownUntil).toBe(3_600_000)
  })
  it("clamps an absurd retry-after to the 6 h reset cap (#64)", () => {
    const h: Record<string, ModelHealth> = {}
    recordFailure(h, "a/1", c({ retryAfterMs: 10 * 365 * 24 * 3_600_000 }), 1000, 60000)
    expect(h["a/1"]?.cooldownUntil).toBe(1000 + RESET_COOLDOWN_MAX_MS)
  })
  it("ignores Infinity, NaN and negative retry-after, using backoff", () => {
    for (const bad of [Infinity, NaN, -5]) {
      const h: Record<string, ModelHealth> = {}
      recordFailure(h, "a/1", c({ retryAfterMs: bad }), 1000, 60000)
      expect(h["a/1"]?.cooldownUntil).toBe(61000)
    }
  })
  it("a permanent failure keeps the entry blacklisted through later transient ones", () => {
    const h: Record<string, ModelHealth> = {}
    recordFailure(h, "a/1", c({ permanent: true }), 0, 60000)
    recordFailure(h, "a/1", c({}), 0, 60000)
    expect(h["a/1"]?.permanent).toBe(true)
  })
  it("failures are tracked per model", () => {
    const h: Record<string, ModelHealth> = {}
    recordFailure(h, "a/1", c({}), 0, 60000)
    recordFailure(h, "a/1", c({}), 0, 60000)
    recordFailure(h, "b/2", c({}), 0, 60000)
    expect(h["b/2"]?.cooldownUntil).toBe(60000)
  })
  it("a huge failure count stays capped (no overflow to Infinity)", () => {
    const h: Record<string, ModelHealth> = { "a/1": { failures: 5000 } }
    recordFailure(h, "a/1", c({}), 10, 60000)
    expect(h["a/1"]?.cooldownUntil).toBe(10 + 3_600_000)
  })
  it("emits one transition for a new mark, not for repeated failures during the same cooldown", () => {
    const h: Record<string, ModelHealth> = {}
    const events: unknown[] = []
    const emit = (what: string, untilMs?: number) => events.push({ what, untilMs })
    recordFailure(h, "a/1", c({}), 1000, 60000, undefined, emit)
    recordFailure(h, "a/1", c({}), 1000, 60000, undefined, emit)
    expect(events).toEqual([{ what: "cooldown_start", untilMs: 61000 }, { what: "cooldown_start", untilMs: 121000 }])
  })
  it("reports cooldown and permanent expiry when a health read observes it", () => {
    const events: string[] = []
    expect(isHealthy({ cooldownUntil: 100 }, 100, (what) => events.push(what))).toBe(true)
    expect(isHealthy({ permanent: true, permanentAt: 0 }, PERMANENT_HEALTH_TTL_MS, (what) => events.push(what))).toBe(false)
    expect(events).toEqual(["cooldown_end", "permanent_expire"])
  })
  it("reports every permanent deadline renewal", () => {
    const events: Array<[string, number | undefined]> = []
    const c = { kind: "quota", retryable: false, permanent: true, switchable: true } as const
    recordFailure({}, "a/1", c, 1000, 60000, undefined, (what, untilMs) => events.push([what, untilMs]))
    recordFailure({ "a/1": { permanent: true, permanentAt: 1000 } }, "a/1", c, 2000, 60000, undefined, (what, untilMs) => events.push([what, untilMs]))
    expect(events).toEqual([["permanent_mark", 1000 + PERMANENT_HEALTH_TTL_MS], ["permanent_mark", 2000 + PERMANENT_HEALTH_TTL_MS]])
  })
})

describe("buildLadder (#64)", () => {
  it("returns the ordered, deduped level list; find entries carried unresolved", () => {
    const c = { ...defaultConfig(), levels: ["a/1", "b/2", "a/1", { find: { match: "glm-5" } }, "b/2", "c/3"] as any }
    expect(buildLadder(c)).toEqual(["a/1", "b/2", { find: { match: "glm-5" } }, "c/3"])
  })
})

describe("walkFromTop (#64)", () => {
  const ladder = ["a/1", "b/2", "c/3"] as any
  const w = (o: Record<string, unknown>) =>
    walkFromTop({ ladder, current: "a/1", health: {}, now: 1000, switchCount: 0, maxSwitches: 6, ...o } as any)
  it("picks the first healthy level from the top that is not the current model", () => {
    expect(w({})).toEqual(sw("b/2"))
    expect(w({ current: "c/3" })).toEqual(sw("a/1"))
  })
  it("skips cooling, blacklisted and tried models, and unresolved find entries", () => {
    expect(w({ health: { "b/2": { cooldownUntil: 1001 }, "c/3": { permanent: true } } })).toEqual(NONE)
    expect(w({ tried: ["b/2"] })).toEqual(sw("c/3"))
    expect(
      walkFromTop({ ladder: ["x/9", { find: { match: "glm" } }, "y/1"], current: "x/9", health: {}, now: 1000, switchCount: 0, maxSwitches: 6 } as any),
    ).toEqual(sw("y/1"))
  })
  it("reports quarantined candidates that are skipped without changing the selected model", () => {
    const skipped: string[] = []
    expect(walkFromTop({ ladder, current: "a/1", health: {}, quarantine: { "b/2": 900 }, now: 1000, switchCount: 0, maxSwitches: 6, onQuarantineSkip: (m) => skipped.push(m) })).toEqual(sw("c/3"))
    expect(skipped).toEqual(["b/2"])
  })
  it("a quarantined model is skipped while a healthy alternative exists, chosen when it is the only candidate", () => {
    expect(w({ current: "b/2", quarantine: { "a/1": 950 } })).toEqual(sw("c/3"))
    expect(w({ current: "b/2", health: { "c/3": { permanent: true } }, quarantine: { "a/1": 950 } })).toEqual(sw("a/1"))
  })
  it("a quarantine older than QUARANTINE_MS no longer skips", () => {
    expect(w({ current: "b/2", quarantine: { "a/1": 1000 - QUARANTINE_MS } })).toEqual(sw("a/1"))
  })
  it("exhaustion reasons: switch_cap when at the cap, no_candidates when nothing is walkable", () => {
    expect(w({ switchCount: 6 })).toEqual(CAP)
    expect(w({ current: "c/3", health: { "a/1": { permanent: true }, "b/2": { permanent: true } } })).toEqual(NONE)
  })
})

describe("walkCircular (#122)", () => {
  const ladder = ["a/1", "b/2", "c/3"] as any
  const w = (current: string, o: Record<string, unknown> = {}) => walkCircular({
    ladder, current, health: {}, now: 1000, switchCount: 0, maxSwitches: 20, maxCircularFlows: 3, ...o,
  } as any)
  it("walks forward and wraps deterministically", () => {
    expect(w("a/1")).toEqual(sw("b/2"))
    expect(w("b/2")).toEqual(sw("c/3"))
    expect(w("c/3")).toEqual(sw("a/1"))
  })
  it("skips unhealthy entries without jumping backward", () => {
    expect(w("a/1", { health: { "b/2": { permanent: true } } })).toEqual(sw("c/3"))
    expect(w("a/1", { health: { "b/2": { permanent: true }, "c/3": { cooldownUntil: 1001 } } })).toEqual(NONE)
    expect(w("a/1", { quarantine: { "b/2": 950, "c/3": 950 } })).toEqual(sw("b/2"))
  })
  it("retains resolved find positions while walking", () => {
    expect(w("b/2", { ladder: ["a/1", { find: { match: "glm" } }, "b/2", "c/3"], resolveFind: () => "x/9" })).toEqual(sw("c/3"))
    expect(w("x/9", { ladder: ["a/1", { find: { match: "glm" } }, "b/2"], resolveFind: () => "x/9" })).toEqual(sw("b/2"))
    expect(w("b/2", { ladder: ["a/1", { find: { match: "b" } }, "b/2", "c/3"], resolveFind: () => "b/2" })).toEqual(sw("c/3"))
  })
  it("stops after the configured number of completed flows", () => {
    expect(w("a/1", { circularFlows: 2 })).toEqual(sw("b/2"))
    expect(w("a/1", { circularFlows: 3 })).toEqual(CAP)
  })
  it("does not cycle unresolved find entries or a one-model ladder", () => {
    expect(w("a/1", { ladder: ["a/1", { find: { match: "b" } }] })).toEqual(NONE)
    expect(w("a/1", { ladder: ["a/1"] })).toEqual(NONE)
  })
})

describe("find levels (#69)", () => {
  const entry = { find: { match: "glm-5\\.[23]", free: true, via: "openrouter" as const } }
  const base = { current: "openai/current", health: {}, tried: [], quarantine: {}, now: 1_000, switchCount: 0, maxSwitches: 6 }

  it("does not fetch when consent is off", async () => {
    let calls = 0
    await expect(resolveFindLevel(entry, {
      ...base, consent: false, fetchCatalog: async () => { calls++; return [] },
    })).resolves.toBeUndefined()
    expect(calls).toBe(0)
  })

  it("resolves a find level only while walking the failover ladder", async () => {
    let calls = 0
    await expect(walkFromTopAsync({ ladder: [entry], ...base, consent: true, fetchCatalog: async () => {
      calls++
      return [{ id: "fake-org/glm-5.2:free", pricing: { prompt: "0" } }]
    }})).resolves.toEqual(sw("openrouter/fake-org/glm-5.2:free"))
    expect(calls).toBe(1)
  })

  it("rejects overlong catalog ids before running the configured regex", async () => {
    const id = `glm-${"a".repeat(129)}`
    const test = vi.spyOn(RegExp.prototype, "test")
    try {
      await expect(resolveFindLevel(entry, {
        ...base, consent: true, fetchCatalog: async () => [{ id, pricing: { prompt: "0" } }],
      })).resolves.toBeUndefined()
      expect(test).not.toHaveBeenCalledWith(id)
    } finally { test.mockRestore() }
  })

  it("stops before discovering lower levels once a healthy static level wins", async () => {
    const fetchCatalog = vi.fn(async () => [])
    await expect(walkFromTopAsync({
      ...base, ladder: ["b/2", entry], consent: true, fetchCatalog,
    })).resolves.toEqual(sw("b/2"))
    expect(fetchCatalog).not.toHaveBeenCalled()
  })

  it("chooses the first healthy free catalog candidate and skips unhealthy ones", async () => {
    await expect(resolveFindLevel(entry, {
      ...base, consent: true, fetchCatalog: async () => [
        { id: "fake-org/glm-5.2:free", pricing: { prompt: "0" } },
        { id: "fake-org/glm-5.3:free", pricing: { prompt: "0" } },
        { id: "fake-org/glm-5.4", pricing: { prompt: "1" } },
      ], health: { "openrouter/fake-org/glm-5.2:free": { permanent: true } },
    })).resolves.toBe("openrouter/fake-org/glm-5.3:free")
  })

  it("uses OpenCode -free ids for non-OpenRouter discovery", async () => {
    await expect(resolveFindLevel({ find: { match: "glm-5", free: true } }, {
      ...base, consent: true, openCodeModels: ["opencode/glm-5.2", "opencode/glm-5.3-free"],
    })).resolves.toBe("opencode/glm-5.3-free")
  })

  it("rejects unsafe ids, caches for an hour, and invalidates a failed result", async () => {
    let clock = 1_000
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-find-"))
    const state = new StateStore(path.join(dir, "state.json"), () => clock)
    state.load()
    let calls = 0
    const input = { ...base, consent: true, cache: state, fetchCatalog: async () => {
      calls++
      return [{ id: calls === 1 ? "fake-org/glm-5.2:free" : calls === 2 ? "fake-org/glm-5.3:free" : "bad/id?", pricing: { prompt: "0" } }]
    }}
    await expect(resolveFindLevel(entry, input)).resolves.toBe("openrouter/fake-org/glm-5.2:free")
    await expect(resolveFindLevel(entry, input)).resolves.toBe("openrouter/fake-org/glm-5.2:free")
    expect(calls).toBe(1)
    await expect(resolveFindLevel(entry, { ...input, failed: "openrouter/fake-org/glm-5.2:free" })).resolves.toBe("openrouter/fake-org/glm-5.3:free")
    expect(calls).toBe(2)
    clock += 60 * 60 * 1000 + 1
    input.now = clock
    await expect(resolveFindLevel(entry, input)).resolves.toBeUndefined()
    expect(calls).toBe(3)
    expect(state.getFindCache(JSON.stringify(entry), clock)).toBeUndefined()
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe("reset cooldowns (#64)", () => {
  const now = new Date(2026, 9, 23, 12, 0, 0).getTime()
  it("parses 'usage limit resets at HH:mm' local time; +24 h when already past, capped at 6 h", () => {
    expect(parseResetCooldown("usage limit resets at 17:00", now)).toBe(new Date(2026, 9, 23, 17, 0, 0).getTime())
    expect(parseResetCooldown("resets at 5pm", now)).toBe(new Date(2026, 9, 23, 17, 0, 0).getTime())
    // 05:00 already passed today: the target rolls to tomorrow, then the 6 h cap applies.
    expect(parseResetCooldown("usage limit resets at 05:00", now)).toBe(now + RESET_COOLDOWN_MAX_MS)
  })
  it("parses ISO timestamps and retry-after seconds", () => {
    const iso = new Date(2026, 9, 23, 12, 30, 0).toISOString()
    expect(parseResetCooldown(`quota until ${iso}`, now)).toBe(new Date(2026, 9, 23, 12, 30, 0).getTime())
    expect(parseResetCooldown("retry-after: 30", now)).toBe(now + 30_000)
    expect(parseResetCooldown("retry-after: 2.5", now)).toBe(now + 2_500)
  })
  it.each(["5m", "2h", "30s"]) ("rejects unit-suffixed retry-after %s", (delay) => {
    expect(parseResetCooldown(`retry-after: ${delay}`, now)).toBeUndefined()
  })
  it.each(["5m", "2h", "30s"]) ("uses exponential backoff for unit-suffixed retry-after %s", (delay) => {
    const h: Record<string, ModelHealth> = { "a/1": { failures: 1 } }
    const text = `retry-after: ${delay}`
    recordFailure(h, "a/1", { kind: "rate_limit", retryable: true, permanent: false, switchable: true }, 1000, 60000, text)
    expect(h["a/1"]?.cooldownUntil).toBe(121000)
  })
  it.each(["25:00", "24:00", "17:75", "12:60pm", "0am", "00pm", "13pm"])("rejects invalid reset time %s and keeps exponential backoff", (time) => {
    const text = `usage limit resets at ${time}`
    expect(parseResetCooldown(text, now)).toBeUndefined()
    const h: Record<string, ModelHealth> = { "a/1": { failures: 1 } }
    recordFailure(h, "a/1", { kind: "rate_limit", retryable: true, permanent: false, switchable: true }, now, 60000, text)
    expect(h["a/1"]?.cooldownUntil).toBe(now + 120_000)
  })
  it.each(["00:00", "23:59", "12am", "12pm"])("accepts clock boundary %s", (time) => {
    expect(parseResetCooldown(`resets at ${time}`, now)).toBe(now + RESET_COOLDOWN_MAX_MS)
  })
  it("caps any reset cooldown at 6 h", () => {
    expect(parseResetCooldown("retry-after: 86400", now)).toBe(now + RESET_COOLDOWN_MAX_MS)
    expect(parseResetCooldown("resets at 23:00", now)).toBe(now + RESET_COOLDOWN_MAX_MS)
  })
  it("unsupported wording keeps the exponential backoff", () => {
    expect(parseResetCooldown("slow down", now)).toBeUndefined()
    expect(parseResetCooldown(undefined, now)).toBeUndefined()
    const h: Record<string, ModelHealth> = {}
    recordFailure(h, "a/1", { kind: "rate_limit", retryable: true, permanent: false, switchable: true }, 1000, 60000)
    expect(h["a/1"]?.cooldownUntil).toBe(61000)
  })
  it("recordFailure applies parsed reset wording", () => {
    const h: Record<string, ModelHealth> = {}
    recordFailure(h, "a/1", { kind: "rate_limit", retryable: true, permanent: false, switchable: true }, now, 60000, "usage limit resets at 17:00")
    expect(h["a/1"]?.cooldownUntil).toBe(new Date(2026, 9, 23, 17, 0, 0).getTime())
  })
})

describe("clearSuccess (#64)", () => {
  it("clears cooldown and permanent marks but keeps the failures count", () => {
    const h: Record<string, ModelHealth> = { "a/1": { cooldownUntil: 2000, permanent: true, permanentAt: 1000, failures: 3 } }
    clearSuccess(h, "a/1")
    expect(h["a/1"]).toEqual({ failures: 3 })
  })
  it("is a no-op for an unknown model", () => {
    const h: Record<string, ModelHealth> = {}
    clearSuccess(h, "a/1")
    expect(h).toEqual({})
  })
})

describe("effectiveMaxSwitches (#64)", () => {
  const many = (n: number) => Array.from({ length: n }, (_, k) => `m/${k}`) as any
  it("the default cap scales with the ladder: max(6, levels.length + 1)", () => {
    expect(effectiveMaxSwitches({ ...defaultConfig(), levels: many(3) })).toBe(6)
    expect(effectiveMaxSwitches({ ...defaultConfig(), levels: many(10) })).toBe(11)
  })
  it("an explicit maxSwitchesPerSession always wins", () => {
    expect(effectiveMaxSwitches({ ...defaultConfig(), maxSwitchesPerSession: 3, levels: many(10) })).toBe(3)
    expect(effectiveMaxSwitches({ ...defaultConfig(), maxSwitchesPerSession: 9, levels: [] })).toBe(9)
  })
  it("scales the default switch budget for circular flows", () => {
    expect(effectiveMaxSwitches({ ...defaultConfig(), levels: many(3), maxCircularFlows: 3 })).toBe(9)
    expect(effectiveMaxSwitches({ ...defaultConfig(), levels: many(3), maxCircularFlows: 3, maxSwitchesPerSession: 4 })).toBe(4)
  })
})
