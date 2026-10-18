import { describe, it, expect } from "vitest"
import { createNarrator } from "../src/narrator"

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
  it("tone british falls back to plain wording in v1.0", () => {
    const a = createNarrator({ verbosity: "normal", tone: "british" })("exhausted")
    expect(a).toBeTruthy()
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
