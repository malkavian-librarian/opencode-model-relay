import { describe, it, expect } from "vitest"
import { SessionLock } from "../src/session-lock"

describe("SessionLock", () => {
  it("is single-flight per session", () => {
    const l = new SessionLock()
    expect(l.tryAcquire("s1")).toBe(true)
    expect(l.tryAcquire("s1")).toBe(false)
    expect(l.tryAcquire("s2")).toBe(true)
    l.release("s1")
    expect(l.tryAcquire("s1")).toBe(true)
  })
  it("plugin-abort marks are consumed once and expire", () => {
    let t = 0
    const l = new SessionLock(() => t, 1000)
    l.markPluginAbort("s1")
    expect(l.consumePluginAbort("s1")).toBe(true)
    expect(l.consumePluginAbort("s1")).toBe(false)
    l.markPluginAbort("s1"); t = 1500
    expect(l.consumePluginAbort("s1")).toBe(false)
  })
  it("an unmarked abort is not a plugin abort (i.e. the user pressed Esc)", () => {
    expect(new SessionLock().consumePluginAbort("never-marked")).toBe(false)
  })
  it("dedups identical keys within the window only", () => {
    let t = 0
    const l = new SessionLock(() => t, 1000, 100)
    expect(l.isDuplicate("k")).toBe(false)
    expect(l.isDuplicate("k")).toBe(true)
    t = 101
    expect(l.isDuplicate("k")).toBe(false)
  })
  it("releasing a never-acquired id is a harmless no-op", () => {
    const l = new SessionLock()
    expect(() => l.release("ghost")).not.toThrow()
    expect(l.tryAcquire("ghost")).toBe(true)
    l.release("ghost"); l.release("ghost")
    expect(l.tryAcquire("ghost")).toBe(true)
  })
  it("prunes expired dedup keys so the map does not grow unbounded", () => {
    let t = 0
    const l = new SessionLock(() => t, 1000, 100)
    for (let i = 0; i < 50; i++) l.isDuplicate("k" + i)
    t = 1000
    l.isDuplicate("fresh")
    expect((l as unknown as { seen: Map<string, number> }).seen.size).toBe(1)
  })
  it("prunes expired abort marks that were never consumed", () => {
    let t = 0
    const l = new SessionLock(() => t, 1000)
    for (let i = 0; i < 20; i++) l.markPluginAbort("s" + i)
    t = 5000
    l.markPluginAbort("late")
    expect((l as unknown as { aborts: Map<string, number> }).aborts.size).toBe(1)
  })
  it("ids like constructor/__proto__ behave like any other id", () => {
    const l = new SessionLock()
    expect(l.tryAcquire("__proto__")).toBe(true)
    expect(l.tryAcquire("__proto__")).toBe(false)
    expect(l.consumePluginAbort("constructor")).toBe(false)
  })
})
