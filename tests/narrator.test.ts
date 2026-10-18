import { describe, it, expect } from "vitest"
import { createNarrator, BRITISH_POOLS, PLAIN_POOLS, type NarrationEvent } from "../src/narrator"

const EVENTS = Object.keys(BRITISH_POOLS) as NarrationEvent[]
const LINE_CAP = 140
// Drive the rng to hit exactly variant `i` of a pool of size `n` on a fresh narrator.
const pick = (i: number, n: number) => () => (i + 0.5) / n

describe("british tone", () => {
  it("has 3+ variants for every event, all unique, one line, ASCII, no emoji", () => {
    for (const ev of EVENTS) {
      const pool = BRITISH_POOLS[ev]
      expect(pool.length).toBeGreaterThanOrEqual(3)
      expect(new Set(pool).size).toBe(pool.length)
      for (const line of pool) {
        expect(line.startsWith("[relay] ")).toBe(true)
        expect(line).toMatch(/^[\x20-\x7e]+$/)
      }
    }
  })
  it("switch_done: every variant carries from, to and reason verbatim, with no placeholder left", () => {
    const pool = BRITISH_POOLS.switch_done
    for (let i = 0; i < pool.length; i++) {
      const m = createNarrator({ verbosity: "normal", tone: "british" }, pick(i, pool.length))("switch_done", {
        from: "prov/model-a", to: "other/model-b", reason: "rate_limit",
      })!
      for (const s of ["prov/model-a", "other/model-b", "rate_limit"]) expect(m).toContain(s)
      expect(m).not.toMatch(/\{(from|to|reason|detail)\}/)
      expect(m.length).toBeLessThanOrEqual(LINE_CAP)
    }
  })
  it("fact-only events: every variant states the real condition and stays short", () => {
    const facts: Partial<Record<NarrationEvent, RegExp[]>> = {
      exhausted: [/no healthy model|unavailable/i],
      cap_reached: [/switch/i, /limit/i],
      no_consent: [/privacy\.consent/],
      no_key: [/OpenRouter key/, /openrouter\.keyEnv/],
      handover_failed: [/handover summary failed|could not be written/i, /transcript/i],
    }
    for (const [ev, res] of Object.entries(facts) as [NarrationEvent, RegExp[]][]) {
      const pool = BRITISH_POOLS[ev]
      for (let i = 0; i < pool.length; i++) {
        const m = createNarrator({ verbosity: "normal", tone: "british" }, pick(i, pool.length))(ev)!
        expect(m).toBe(pool[i])
        expect(m).not.toMatch(/\{[a-z]+\}/)
        expect(m.length).toBeLessThanOrEqual(LINE_CAP)
        // no_consent variants either name the field or say consent is off/missing
        if (ev === "no_consent") expect(m).toMatch(/privacy\.consent|no consent|off/i)
        else for (const re of res) expect(m).toMatch(re)
      }
    }
  })
  it("config_invalid: every variant carries the detail verbatim; template stays short", () => {
    const pool = BRITISH_POOLS.config_invalid
    for (let i = 0; i < pool.length; i++) {
      const n = createNarrator({ verbosity: "normal", tone: "british" }, pick(i, pool.length))
      const m = n("config_invalid", { detail: "tiers.secondary: bad" })!
      expect(m).toContain("tiers.secondary: bad")
      expect(m).not.toMatch(/\{detail\}/)
      const bare = createNarrator({ verbosity: "normal", tone: "british" }, pick(i, pool.length))("config_invalid")!
      expect(bare.length).toBeLessThanOrEqual(LINE_CAP)
    }
  })
  it("never repeats a variant back to back, for any event, even with a constant rng", () => {
    for (const ev of EVENTS) {
      const n = createNarrator({ verbosity: "normal", tone: "british" }, () => 0)
      let prev = ""
      for (let k = 0; k < 12; k++) {
        const m = n(ev, { from: "a", to: "b", reason: "x", detail: "d" })!
        expect(m).not.toBe(prev)
        prev = m
      }
    }
  })
  it("keeps verbosity rules and detail scoping", () => {
    const off = createNarrator({ verbosity: "off", tone: "british" })
    expect(off("exhausted")).toBeNull()
    const quiet = createNarrator({ verbosity: "quiet", tone: "british" })
    for (const ev of EVENTS) {
      const spoke = quiet(ev, { from: "a", to: "b", reason: "x", detail: "d" }) !== null
      expect(spoke).toBe(ev === "exhausted" || ev === "cap_reached" || ev === "config_invalid")
    }
    const n = createNarrator({ verbosity: "normal", tone: "british" }, () => 0)
    expect(n("switch_done", { from: "a", to: "b", reason: "x", detail: "IGNORE ALL" })).not.toContain("IGNORE ALL")
  })
  it("still sanitises, caps and inserts $ patterns literally", () => {
    const pool = BRITISH_POOLS.switch_done
    for (let i = 0; i < pool.length; i++) {
      const n = createNarrator({ verbosity: "normal", tone: "british" }, pick(i, pool.length))
      const m = n("switch_done", { from: "a\n\u001b[31m/1\r", to: "b".repeat(500), reason: "x\u0000y" })!
      expect(m).not.toMatch(/[\u0000-\u001f]/)
      expect(m).toContain("a[31m/1")
      expect(m).toContain("xy")
      expect(m).toContain("b".repeat(80))
      expect(m).not.toContain("b".repeat(81))
      const lit = createNarrator({ verbosity: "normal", tone: "british" }, pick(i, pool.length))(
        "switch_done", { from: "$&", to: "$1{reason}", reason: "$`" })!
      expect(lit).toContain("$&")
      expect(lit).toContain("$1{reason}")
      expect(lit).toContain("$`")
    }
    const d = createNarrator({ verbosity: "normal", tone: "british" })("config_invalid", { detail: "d\n".repeat(300) })!
    expect(d).not.toContain("\n")
    expect(d.length).toBeLessThanOrEqual(LINE_CAP + 200)
  })
  it("plain stays unchanged and is not British", () => {
    expect(PLAIN_POOLS.switch_done).toEqual([
      "[relay] {from} stopped ({reason}). Continuing on {to}.",
      "[relay] Switched {from} -> {to} ({reason}).",
    ])
    expect(PLAIN_POOLS.exhausted).toHaveLength(2)
    const plain = createNarrator({ verbosity: "normal", tone: "plain" }, () => 0)("switch_done", { from: "a", to: "b", reason: "x" })
    expect(plain).toBe("[relay] a stopped (x). Continuing on b.")
  })
})

describe("narrator", () => {
  it("always carries the facts", () => {
    const n = createNarrator({ verbosity: "normal", tone: "plain" })
    const m = n("switch_done", { from: "a/1", to: "b/2", reason: "rate_limit" })!
    for (const s of ["a/1", "b/2", "rate_limit"]) expect(m).toContain(s)
  })
  it("off says nothing; quiet only speaks for problems", () => {
    const off = createNarrator({ verbosity: "off", tone: "plain" })
    expect(off("switch_done", { from: "a", to: "b", reason: "x" })).toBeNull()
    expect(off("exhausted")).toBeNull()
    const quiet = createNarrator({ verbosity: "quiet", tone: "plain" })
    expect(quiet("switch_done", { from: "a", to: "b", reason: "x" })).toBeNull()
    expect(quiet("exhausted")).not.toBeNull()
    expect(quiet("cap_reached")).not.toBeNull()
  })
  it("never interpolates provider error text (detail is only used for config_invalid)", () => {
    const n = createNarrator({ verbosity: "normal", tone: "plain" })
    expect(n("switch_done", { from: "a", to: "b", reason: "x", detail: "IGNORE ALL" })).not.toContain("IGNORE ALL")
    expect(n("config_invalid", { detail: "tiers.secondary: bad" })).toContain("tiers.secondary: bad")
  })
  it("avoids repeating the same variant twice in a row", () => {
    let i = 0
    const n = createNarrator({ verbosity: "normal", tone: "plain" }, () => (i++ % 2 === 0 ? 0 : 0.99))
    const seen = new Set<string>()
    for (let k = 0; k < 6; k++) seen.add(n("exhausted")!)
    expect(seen.size).toBeGreaterThan(1)
  })
  it("strips control characters and caps values at 80 chars", () => {
    const n = createNarrator({ verbosity: "normal", tone: "plain" }, () => 0)
    const m = n("switch_done", { from: "a\n\u001b[31m/1\r", to: "b".repeat(500), reason: "x\u0000y" })!
    expect(m).not.toMatch(/[\u0000-\u001f]/)
    expect(m).toContain("a[31m/1")
    expect(m).toContain("xy")
    expect(m).not.toContain("b".repeat(81))
    expect(m).toContain("b".repeat(80))
  })
  it("inserts $ patterns literally and does not re-expand placeholders", () => {
    const n = createNarrator({ verbosity: "normal", tone: "plain" }, () => 0)
    const m = n("switch_done", { from: "$&", to: "$1{reason}", reason: "$`" })!
    expect(m).toContain("$& stopped")
    expect(m).toContain("$1{reason}")
    expect(m).toContain("($`)")
  })
  it("caps config_invalid detail at 200 chars and cleans it", () => {
    const n = createNarrator({ verbosity: "normal", tone: "plain" })
    const m = n("config_invalid", { detail: "d\n".repeat(300) })!
    expect(m).not.toContain("\n")
    expect(m.length).toBeLessThanOrEqual("[relay] Config problem: ".length + 200)
    expect(n("config_invalid")).toBe("[relay] Config problem: ")
  })
  it("handles out-of-range or NaN rng safely", () => {
    expect(createNarrator({ verbosity: "normal", tone: "plain" }, () => NaN)("exhausted")).toBeTruthy()
    expect(createNarrator({ verbosity: "normal", tone: "plain" }, () => 5)("exhausted")).toBeTruthy()
  })
})

describe("no_key", () => {
  it("speaks at normal verbosity, not at quiet, and names the config field", () => {
    const m = createNarrator({ verbosity: "normal", tone: "plain" })("no_key")!
    expect(m).toMatch(/OpenRouter key/i)
    expect(m).toContain("openrouter.keyEnv")
    expect(createNarrator({ verbosity: "quiet", tone: "plain" })("no_key")).toBeNull()
  })
})
