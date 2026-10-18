import { describe, it, expect } from "vitest"
import { decidePin } from "../src/pin"
import type { ModelHealth } from "../src/strategy"

describe("decidePin", () => {
  it("does nothing without sticky state", () => {
    expect(decidePin({ switchCount: 0, updated: 0 }, "a/1")).toEqual({ action: "none" })
  })
  it("pins when the session is back on the origin model", () => {
    expect(decidePin({ sticky: "b/2", origin: "a/1", switchCount: 1, updated: 0 }, "a/1")).toEqual({ action: "pin", to: "b/2" })
  })
  it("does nothing when already on the sticky model", () => {
    expect(decidePin({ sticky: "b/2", origin: "a/1", switchCount: 1, updated: 0 }, "b/2")).toEqual({ action: "none" })
  })
  it("clears stickiness when the user explicitly picked a different model", () => {
    expect(decidePin({ sticky: "b/2", origin: "a/1", switchCount: 1, updated: 0 }, "z/9")).toEqual({ action: "clear" })
  })
})

describe("decidePin with recovery inputs", () => {
  const rec = { sticky: "c/3", origin: "a/1", switchCount: 2, updated: 0 }
  const chain = ["a/1", "b/2", "c/3"]
  const opts = (mode: string, health: Record<string, ModelHealth> = {}) => ({ mode: mode as any, chain, health, now: 1000 })
  const rows: { name: string; mode: string; input: string; health?: Record<string, ModelHealth>; want: object }[] = [
    { name: "recover: primary recovered -> back to origin, stickiness cleared", mode: "chain-recover", input: "a/1", health: { "a/1": { cooldownUntil: 1000 } }, want: { action: "recover", to: "a/1", clearSticky: true } },
    { name: "recover: a turn arriving on the sticky model recovers but keeps a pin (TUI may still send it, #19)", mode: "chain-recover", input: "c/3", want: { action: "recover", to: "a/1", clearSticky: false } },
    { name: "recover: primary cooling, secondary healthy -> sticky moves up, not cleared", mode: "chain-recover", input: "a/1", health: { "a/1": { cooldownUntil: 1001 } }, want: { action: "recover", to: "b/2", clearSticky: false } },
    { name: "recover: nothing recovered -> plain pin", mode: "chain-recover", input: "a/1", health: { "a/1": { permanent: true }, "b/2": { cooldownUntil: 9999 } }, want: { action: "pin", to: "c/3" } },
    { name: "recover: nothing recovered on the sticky model -> none", mode: "chain-recover", input: "c/3", health: { "a/1": { permanent: true }, "b/2": { permanent: true } }, want: { action: "none" } },
    { name: "recover: a user-picked model still clears", mode: "chain-recover", input: "z/9", want: { action: "clear" } },
    { name: "sticky mode never recovers", mode: "chain-sticky", input: "a/1", want: { action: "pin", to: "c/3" } },
    { name: "escalate mode never recovers", mode: "escalate", input: "a/1", want: { action: "pin", to: "c/3" } },
  ]
  for (const r of rows) it(r.name, () => expect(decidePin(rec, r.input, opts(r.mode, r.health))).toEqual(r.want))
  it("no sticky state: nothing to recover", () => {
    expect(decidePin({ switchCount: 0, updated: 0 }, "b/2", opts("chain-recover"))).toEqual({ action: "none" })
  })
})
