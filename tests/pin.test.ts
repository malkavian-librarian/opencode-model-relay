import { describe, it, expect } from "vitest"
import { decidePin } from "../src/pin"

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
