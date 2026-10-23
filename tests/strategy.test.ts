import { describe, it, expect } from "vitest"
import { defaultConfig } from "../src/config"
import {
  buildChain, buildLadder, buildTiers, clearSuccess, decideSwitch, effectiveMaxSwitches, hasRelayMarker, nextModel,
  parseResetCooldown, recordFailure, recoverTarget, tierOf, triedThisTurn, walkFromTop,
  QUARANTINE_MS, RESET_COOLDOWN_MAX_MS,
  type Decision, type ModelHealth,
} from "../src/strategy"
import { RELAY_MARKER } from "../src/defaults"
import type { Classified, OcMessage } from "../src/types"

const cfg = (t: object) => ({ ...defaultConfig(), tiers: { secondary: [], tertiary: [], ...t } as any })
const base = { now: 1000, switchCount: 0, maxSwitches: 6 }

describe("buildChain", () => {
  it("orders primary, secondary, tertiary and dedupes", () => {
    const c = cfg({ primary: "a/1", secondary: ["b/2", "a/1"], tertiary: ["c/3"] })
    expect(buildChain(c, "a/1")).toEqual(["a/1", "b/2", "c/3"])
  })
  it("without a configured primary, the current model leads the chain", () => {
    expect(buildChain(cfg({ secondary: ["b/2"] }), "x/0")).toEqual(["x/0", "b/2"])
    expect(buildChain(cfg({ secondary: ["x/0", "b/2"] }), "x/0")).toEqual(["x/0", "b/2"])
  })
  it("dedupes across tiers and keeps first occurrence order", () => {
    const c = cfg({ primary: "a/1", secondary: ["b/2", "b/2"], tertiary: ["b/2", "c/3", "a/1"] })
    expect(buildChain(c, "a/1")).toEqual(["a/1", "b/2", "c/3"])
  })
  it("with a primary set, a current model outside the chain is not injected", () => {
    expect(buildChain(cfg({ primary: "a/1", secondary: ["b/2"] }), "z/9")).toEqual(["a/1", "b/2"])
  })
})

describe("nextModel", () => {
  const chain = ["a/1", "b/2", "c/3"]
  it("picks the first healthy model that is not current", () => {
    expect(nextModel({ ...base, chain, current: "a/1", health: {} })).toEqual({ action: "switch", to: "b/2" })
  })
  it("skips permanent and cooling models, accepts expired cooldowns", () => {
    const health: Record<string, ModelHealth> = { "b/2": { permanent: true }, "c/3": { cooldownUntil: 2000 } }
    expect(nextModel({ ...base, chain, current: "a/1", health })).toEqual({ action: "exhausted", reason: "no_candidates" })
    expect(nextModel({ ...base, now: 2001, chain, current: "a/1", health })).toEqual({ action: "switch", to: "c/3" })
  })
  it("a one-model chain is exhausted", () => {
    expect(nextModel({ ...base, chain: ["a/1"], current: "a/1", health: {} })).toEqual({ action: "exhausted", reason: "no_candidates" })
  })
  it("stops at the switch cap", () => {
    expect(nextModel({ ...base, chain, current: "a/1", health: {}, switchCount: 6 })).toEqual({ action: "exhausted", reason: "switch_cap" })
  })
  it("allows a switch one below the cap and blocks beyond it", () => {
    expect(nextModel({ ...base, chain, current: "a/1", health: {}, switchCount: 5 })).toEqual({ action: "switch", to: "b/2" })
    expect(nextModel({ ...base, chain, current: "a/1", health: {}, switchCount: 7 })).toEqual({ action: "exhausted", reason: "switch_cap" })
  })
  it("a cooldown ending exactly now counts as expired", () => {
    expect(nextModel({ ...base, now: 2000, chain, current: "a/1", health: { "b/2": { cooldownUntil: 2000 } } })).toEqual({ action: "switch", to: "b/2" })
  })
  it("current model not in chain still switches to the first healthy entry", () => {
    expect(nextModel({ ...base, chain, current: "z/9", health: {} })).toEqual({ action: "switch", to: "a/1" })
  })
  it("never returns the current model even with duplicate chain entries", () => {
    expect(nextModel({ ...base, chain: ["a/1", "a/1", "b/2"], current: "a/1", health: {} })).toEqual({ action: "switch", to: "b/2" })
  })
  it("ignores health entries for unknown models", () => {
    const health: Record<string, ModelHealth> = { "q/7": { permanent: true } }
    expect(nextModel({ ...base, chain, current: "a/1", health })).toEqual({ action: "switch", to: "b/2" })
  })
  it("a permanently blacklisted current model does not block switching away", () => {
    const health: Record<string, ModelHealth> = { "a/1": { permanent: true } }
    expect(nextModel({ ...base, chain, current: "a/1", health })).toEqual({ action: "switch", to: "b/2" })
  })
  it("an empty chain is exhausted", () => {
    expect(nextModel({ ...base, chain: [], current: "a/1", health: {} })).toEqual({ action: "exhausted", reason: "no_candidates" })
  })
})

describe("buildTiers / tierOf", () => {
  it("keeps tiers separate, dedupes across tiers into the cheapest tier, never injects the current model", () => {
    const t = buildTiers(cfg({ primary: "a/1", secondary: ["b/2", "a/1", "b/2"], tertiary: ["c/3", "b/2"] }))
    expect(t).toEqual([["a/1"], ["b/2"], ["c/3"]])
    expect(tierOf(t, "b/2")).toBe(1)
    expect(tierOf(t, "z/9")).toBe(-1)
  })
  it("an unset primary is an empty tier 0", () => {
    expect(buildTiers(cfg({ secondary: ["b/2"] }))).toEqual([[], ["b/2"], []])
  })
})

type Row = { name: string; current: string; health?: Record<string, ModelHealth>; now?: number; switchCount?: number; tried?: string[]; want: Decision }
const tierCfg = { primary: "a/1", secondary: ["b/2", "b/3"], tertiary: ["c/3", "c/4"] }
const sw = (to: string): Decision => ({ action: "switch", to })
const NONE: Decision = { action: "exhausted", reason: "no_candidates" }
const CAP: Decision = { action: "exhausted", reason: "switch_cap" }
const run = (mode: string, t: object, r: Row) => decideSwitch({
  cfg: { ...cfg(t), mode: mode as any }, current: r.current, health: r.health ?? {}, now: r.now ?? 1000,
  switchCount: r.switchCount ?? 0, tried: r.tried ?? [],
})

describe("decideSwitch: chain-sticky (flat chain, tried models excluded)", () => {
  const rows: Row[] = [
    { name: "primary fails -> first secondary", current: "a/1", want: sw("b/2") },
    { name: "walks the flat list incl. same-tier siblings", current: "b/2", health: { "a/1": { permanent: true } }, want: sw("b/3") },
    { name: "goes back up the list to a healthy primary", current: "b/2", want: sw("a/1") },
    { name: "a model tried for the same failing turn is never re-chosen, even after its cooldown ran out", current: "b/2", tried: ["a/1", "b/2"], want: sw("b/3") },
    { name: "cooldown ending exactly now is expired", current: "a/1", health: { "b/2": { cooldownUntil: 1000 } }, want: sw("b/2") },
    { name: "cooldown ending after now is skipped", current: "a/1", health: { "b/2": { cooldownUntil: 1001 } }, want: sw("b/3") },
    { name: "switch cap", current: "a/1", switchCount: 6, want: CAP },
    { name: "all others blacklisted -> exhausted", current: "a/1", health: { "b/2": { permanent: true }, "b/3": { permanent: true }, "c/3": { permanent: true }, "c/4": { permanent: true } }, want: NONE },
  ]
  for (const r of rows) it(r.name, () => expect(run("chain-sticky", tierCfg, r)).toEqual(r.want))
  it("one-model chain is exhausted", () => expect(run("chain-sticky", { primary: "a/1" }, { name: "", current: "a/1", want: NONE })).toEqual(NONE))
})

describe("decideSwitch: chain-recover (flat chain, tried models excluded)", () => {
  const rows: Row[] = [
    { name: "primary fails -> first secondary", current: "a/1", want: sw("b/2") },
    { name: "a primary tried this turn is never re-chosen, even with an expired cooldown", current: "b/2", tried: ["a/1", "b/2"], health: { "a/1": { cooldownUntil: 500 } }, want: sw("b/3") },
    { name: "a primary not tried this turn and recovered is chosen first", current: "b/2", tried: ["b/2"], health: { "a/1": { cooldownUntil: 1000 } }, want: sw("a/1") },
    { name: "a still-cooling primary is skipped", current: "b/2", tried: ["b/2"], health: { "a/1": { cooldownUntil: 1001 } }, want: sw("b/3") },
    { name: "a blacklisted primary is skipped", current: "b/2", health: { "a/1": { permanent: true } }, want: sw("b/3") },
    { name: "everything tried -> exhausted", current: "c/4", tried: ["a/1", "b/2", "b/3", "c/3", "c/4"], want: NONE },
    { name: "switch cap wins over candidates", current: "a/1", switchCount: 7, want: CAP },
    { name: "current outside the chain -> first healthy entry", current: "z/9", tried: ["z/9"], want: sw("a/1") },
  ]
  for (const r of rows) it(r.name, () => expect(run("chain-recover", tierCfg, r)).toEqual(r.want))
  it("one-model chain is exhausted", () => expect(run("chain-recover", { primary: "a/1" }, { name: "", current: "a/1", want: NONE })).toEqual(NONE))
})

describe("decideSwitch: escalate (tiers cheap -> strong, only upwards)", () => {
  const rows: Row[] = [
    { name: "tier 0 fails -> first of tier 1", current: "a/1", want: sw("b/2") },
    { name: "tier 1 fails -> tier 2, never the tier-1 sibling", current: "b/2", want: sw("c/3") },
    { name: "never moves down to a healthy primary", current: "b/3", want: sw("c/3") },
    { name: "a tier with no healthy candidate is skipped", current: "a/1", health: { "b/2": { cooldownUntil: 2000 }, "b/3": { permanent: true } }, want: sw("c/3") },
    { name: "cooldown ending exactly now is expired", current: "a/1", health: { "b/2": { cooldownUntil: 1000 } }, want: sw("b/2") },
    { name: "first healthy candidate inside the next tier", current: "b/2", health: { "c/3": { cooldownUntil: 1001 } }, want: sw("c/4") },
    { name: "tried models are never re-chosen", current: "a/1", tried: ["a/1", "b/2"], want: sw("b/3") },
    { name: "top tier fails -> exhausted", current: "c/3", want: NONE },
    { name: "top tier blacklisted -> exhausted", current: "b/2", health: { "c/3": { permanent: true }, "c/4": { permanent: true } }, want: NONE },
    { name: "switch cap", current: "a/1", switchCount: 6, want: CAP },
    { name: "current in no tier starts below tier 0", current: "z/9", want: sw("a/1") },
  ]
  for (const r of rows) it(r.name, () => expect(run("escalate", tierCfg, r)).toEqual(r.want))
  it("empty tiers are skipped", () => {
    expect(run("escalate", { primary: "a/1", tertiary: ["c/3"] }, { name: "", current: "a/1", want: NONE })).toEqual(sw("c/3"))
    expect(run("escalate", { secondary: ["b/2"] }, { name: "", current: "z/9", want: NONE })).toEqual(sw("b/2"))
  })
  it("one-model chain is exhausted", () => expect(run("escalate", { primary: "a/1" }, { name: "", current: "a/1", want: NONE })).toEqual(NONE))
})

describe("recoverTarget", () => {
  const chain = ["a/1", "b/2", "c/3"]
  const rows: { name: string; sticky: string; health: Record<string, ModelHealth>; want: string | undefined }[] = [
    { name: "primary recovered (cooldown expired exactly now)", sticky: "b/2", health: { "a/1": { cooldownUntil: 1000 } }, want: "a/1" },
    { name: "primary still cooling", sticky: "b/2", health: { "a/1": { cooldownUntil: 1001 } }, want: undefined },
    { name: "primary permanently blacklisted", sticky: "b/2", health: { "a/1": { permanent: true } }, want: undefined },
    { name: "primary cooling, secondary recovered", sticky: "c/3", health: { "a/1": { cooldownUntil: 5000 } }, want: "b/2" },
    { name: "highest priority wins", sticky: "c/3", health: {}, want: "a/1" },
    { name: "already on the primary", sticky: "a/1", health: {}, want: undefined },
    { name: "sticky outside the chain ranks last", sticky: "z/9", health: { "a/1": { permanent: true } }, want: "b/2" },
  ]
  for (const r of rows) it(r.name, () => expect(recoverTarget({ chain, sticky: r.sticky, health: r.health, now: 1000 })).toBe(r.want))
})

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
  it("a quarantined model is skipped while a healthy alternative exists, chosen when it is the only candidate", () => {
    expect(w({ current: "b/2", quarantine: { "a/1": 950 } })).toEqual(sw("c/3"))
    expect(w({ current: "b/2", health: { "c/3": { permanent: true } }, quarantine: { "a/1": 950 } })).toEqual(sw("a/1"))
  })
  it("a quarantine older than QUARANTINE_MS no longer skips", () => {
    expect(w({ current: "b/2", quarantine: { "a/1": 1000 - QUARANTINE_MS } })).toEqual(sw("a/1"))
  })
  it("exhaustion reasons match nextModel outcomes", () => {
    expect(w({ switchCount: 6 })).toEqual(CAP)
    expect(w({ current: "c/3", health: { "a/1": { permanent: true }, "b/2": { permanent: true } } })).toEqual(NONE)
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
})
