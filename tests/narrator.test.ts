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
    // One explicit condition phrase per variant, in pool order.
    const facts: Partial<Record<NarrationEvent, string[]>> = {
      exhausted: ["No healthy model left in the chain", "Every model in the chain is unavailable", "No healthy model available", "No healthy model left"],
      cap_reached: ["Switch limit for this session reached", "Too many switches this session (limit reached)", "Switch limit reached", "switch limit for this session"],
      no_consent: ["set privacy.consent to allow LLM handover summaries", "Handover summaries are off (no consent)", "No consent given, so no LLM handover summaries", "privacy.consent is not set"],
      no_key: ["No OpenRouter key found", "the OpenRouter key is missing (see openrouter.keyEnv)", "need an OpenRouter key and none turned up (openrouter.keyEnv)", "no OpenRouter key (see openrouter.keyEnv)"],
      handover_failed: ["Handover summary failed; I do apologise", "handover summary could not be written", "Handover summary failed. Using the recent transcript", "Handover summary failed, rather a shame"],
    }
    for (const [ev, phrases] of Object.entries(facts) as [NarrationEvent, string[]][]) {
      const pool = BRITISH_POOLS[ev]
      expect(phrases).toHaveLength(pool.length)
      for (let i = 0; i < pool.length; i++) {
        const m = createNarrator({ verbosity: "normal", tone: "british" }, pick(i, pool.length))(ev)!
        expect(m).toBe(pool[i])
        expect(m).toContain(phrases[i])
        expect(m).not.toMatch(/\{[a-z]+\}/)
        expect(m.length).toBeLessThanOrEqual(LINE_CAP)
      }
    }
  })
  it("does not promise recovery and keeps each joke to one event", () => {
    const all = EVENTS.flatMap((ev) => BRITISH_POOLS[ev].map((l) => [ev, l] as const))
    expect(all.filter(([, l]) => /recover/i.test(l))).toEqual([])
    for (const word of [/kettle/i, /Plan B/]) {
      const hits = all.filter(([, l]) => word.test(l))
      expect(hits).toHaveLength(1)
      expect(hits[0]![0]).toBe("switch_done")
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
    // Snapshot of the origin/main pools; plain must never change silently.
    expect(PLAIN_POOLS).toEqual({
      switch_done: [
        "[relay] {from} stopped ({reason}). Continuing on {to}.",
        "[relay] Switched {from} -> {to} ({reason}).",
      ],
      exhausted: [
        "[relay] No healthy model left in the chain. Staying put.",
        "[relay] No healthy model available: every model in the chain is unavailable right now.",
      ],
      cap_reached: [
        "[relay] Switch limit for this session reached. Not switching again.",
        "[relay] Too many switches in this session (limit reached); stopping here.",
      ],
      no_consent: [
        "[relay] Running local-only: set privacy.consent to enable LLM handover summaries.",
        "[relay] Handover summaries are off (no consent). Using the plain transcript tail.",
      ],
      no_key: [
        "[relay] Handover summaries need an OpenRouter key: set the environment variable named in openrouter.keyEnv.",
        "[relay] Consent is on but no OpenRouter key was found (see openrouter.keyEnv). Using the plain transcript tail.",
      ],
      handover_failed: [
        "[relay] Handover summary failed; used the plain transcript tail instead.",
        "[relay] Handover summary failed (could not write one); passing the recent transcript instead.",
      ],
      config_invalid: ["[relay] Config problem: {detail}"],
    })
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
