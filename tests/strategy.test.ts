import { describe, it, expect } from "vitest"
import { defaultConfig } from "../src/config"
import { buildChain, nextModel, recordFailure, type ModelHealth } from "../src/strategy"
import type { Classified } from "../src/types"

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
  it("clamps an absurd retry-after to 1h", () => {
    const h: Record<string, ModelHealth> = {}
    recordFailure(h, "a/1", c({ retryAfterMs: 10 * 365 * 24 * 3_600_000 }), 1000, 60000)
    expect(h["a/1"]?.cooldownUntil).toBe(1000 + 3_600_000)
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
