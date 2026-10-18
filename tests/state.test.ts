import { describe, it, expect } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { StateStore } from "../src/state"

const file = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "relay-st-")), "state.json")

describe("StateStore", () => {
  it("returns a blank record for unknown sessions", () => {
    const s = new StateStore(file()); s.load()
    expect(s.get("x")).toMatchObject({ switchCount: 0 })
  })
  it("persists sticky state across instances", () => {
    const f = file()
    const a = new StateStore(f); a.load()
    a.set("s1", { sticky: "b/2", origin: "a/1", switchCount: 1, updated: Date.now() }); a.save()
    const b = new StateStore(f); b.load()
    expect(b.get("s1")).toMatchObject({ sticky: "b/2", origin: "a/1", switchCount: 1 })
  })
  it("expires entries older than 14 days and caps at 500 sessions", () => {
    const f = file(); let t = 0
    const a = new StateStore(f, () => t); a.load()
    a.set("old", { switchCount: 1, updated: 0 })
    t = 15 * 24 * 3600 * 1000
    for (let i = 0; i < 510; i++) a.set("s" + i, { switchCount: 1, updated: t + i })
    a.save()
    const b = new StateStore(f, () => t); b.load()
    expect(b.get("old").switchCount).toBe(0)
    expect(Object.keys(JSON.parse(fs.readFileSync(f, "utf8")).sessions).length).toBeLessThanOrEqual(500)
  })
  it("validates recoveries at load: keeps a non-negative count (floored), drops bad values", () => {
    const f = file()
    const now = Date.now()
    fs.writeFileSync(f, JSON.stringify({ v: 1, sessions: {
      ok: { switchCount: 1, recoveries: 2.7, updated: now },
      neg: { switchCount: 1, recoveries: -1, updated: now },
      str: { switchCount: 1, recoveries: "3", updated: now },
      pin: { switchCount: 1, lastPin: 5, updated: now },
    } }))
    const s = new StateStore(f); s.load()
    expect(s.get("ok").recoveries).toBe(2)
    expect(s.get("neg").recoveries).toBeUndefined()
    expect(s.get("str").recoveries).toBeUndefined()
    expect(s.get("ok").lastPin).toBeUndefined()
    expect(s.get("pin").lastPin).toBeUndefined()
  })
  it("survives a corrupt file", () => {
    const f = file(); fs.writeFileSync(f, "{not json")
    const s = new StateStore(f); s.load()
    expect(s.get("x").switchCount).toBe(0)
  })
  it("save never throws when the directory is unwritable", () => {
    const s = new StateStore(path.join(os.tmpdir(), "relay-nonexistent-" + Date.now(), "a", "state.json")); s.load()
    s.set("x", { switchCount: 1, updated: Date.now() })
    expect(() => s.save()).not.toThrow()
  })

  describe("wrong-shape files", () => {
    const bad: Array<[string, unknown]> = [
      ["null", null],
      ["array root", []],
      ["number root", 5],
      ["sessions as array", { v: 1, sessions: [{ switchCount: 1, updated: 1 }] }],
      ["sessions null", { v: 1, sessions: null }],
      ["sessions string", { v: 1, sessions: "x" }],
      ["wrong version", { v: 2, sessions: { a: { switchCount: 1, updated: Date.now() } } }],
    ]
    for (const [name, content] of bad) {
      it(`ignores ${name} and later saves stay valid`, () => {
        const f = file(); fs.writeFileSync(f, JSON.stringify(content))
        const s = new StateStore(f); s.load()
        expect(s.get("a").switchCount).toBe(0)
        s.set("n", { switchCount: 2, updated: Date.now() }); s.save()
        const again = new StateStore(f); again.load()
        expect(again.get("n").switchCount).toBe(2)
      })
    }

    it("drops malformed records but keeps valid ones", () => {
      const now = 1_000_000
      const f = file()
      fs.writeFileSync(f, JSON.stringify({ v: 1, sessions: {
        good: { sticky: "b/2", switchCount: 1, updated: now },
        noUpdated: { switchCount: 1 },
        strUpdated: { switchCount: 1, updated: "yesterday" },
        noCount: { updated: now },
        nullRec: null,
        strRec: "x",
        arrRec: [],
        nanCount: { switchCount: null, updated: now },
        badSticky: { sticky: 42, origin: {}, switchCount: 3, updated: now },
      } }))
      const s = new StateStore(f, () => now); s.load()
      expect(s.get("good")).toMatchObject({ sticky: "b/2", switchCount: 1 })
      for (const k of ["noUpdated", "strUpdated", "noCount", "nullRec", "strRec", "arrRec", "nanCount"]) {
        expect(s.get(k).switchCount).toBe(0)
      }
      const bs = s.get("badSticky")
      expect(bs.switchCount).toBe(3)
      expect(bs.sticky).toBeUndefined()
      expect(bs.origin).toBeUndefined()
      s.save()
      const saved = JSON.parse(fs.readFileSync(f, "utf8")).sessions
      expect(Object.keys(saved).sort()).toEqual(["badSticky", "good"])
    })

    it("prototype-ish ids do not leak or pollute", () => {
      const f = file()
      fs.writeFileSync(f, '{"v":1,"sessions":{"__proto__":{"switchCount":9,"updated":' + Date.now() + '}}}')
      const s = new StateStore(f); s.load()
      expect(s.get("constructor").switchCount).toBe(0)
      expect(s.get("toString").switchCount).toBe(0)
      expect(({} as Record<string, unknown>).switchCount).toBeUndefined()
      expect(() => s.save()).not.toThrow()
    })
  })

  describe("atomic writes", () => {
    it("writes via a pid-unique temp file and leaves no temp behind", () => {
      const f = file()
      const s = new StateStore(f); s.load()
      const renames: Array<[string, string]> = []
      const orig = fs.renameSync
      ;(fs as { renameSync: typeof fs.renameSync }).renameSync = ((a: fs.PathLike, b: fs.PathLike) => {
        renames.push([String(a), String(b)]); return orig(a, b)
      }) as typeof fs.renameSync
      try {
        s.set("x", { switchCount: 1, updated: Date.now() }); s.save()
      } finally {
        ;(fs as { renameSync: typeof fs.renameSync }).renameSync = orig
      }
      expect(renames).toHaveLength(1)
      expect(renames[0]![0]).toContain(String(process.pid))
      expect(renames[0]![1]).toBe(f)
      expect(fs.readdirSync(path.dirname(f))).toEqual(["state.json"])
    })

    it("cleans up the temp file when the rename fails", () => {
      const f = file()
      const s = new StateStore(f); s.load()
      const orig = fs.renameSync
      ;(fs as { renameSync: typeof fs.renameSync }).renameSync = (() => { throw new Error("EPERM") }) as typeof fs.renameSync
      try {
        s.set("x", { switchCount: 1, updated: Date.now() })
        expect(() => s.save()).not.toThrow()
      } finally {
        ;(fs as { renameSync: typeof fs.renameSync }).renameSync = orig
      }
      expect(fs.readdirSync(path.dirname(f))).toEqual([])
    })

    it("two instances overwriting each other never throw and leave valid JSON", () => {
      const f = file()
      const a = new StateStore(f); a.load()
      const b = new StateStore(f); b.load()
      a.set("a", { switchCount: 1, updated: Date.now() })
      b.set("b", { switchCount: 2, updated: Date.now() })
      expect(() => { a.save(); b.save(); a.save() }).not.toThrow()
      const c = new StateStore(f); c.load()
      // last writer wins; the file is always well-formed
      expect(c.get("a").switchCount).toBe(1)
      expect(fs.readdirSync(path.dirname(f))).toEqual(["state.json"])
    })

    it("save before load works and a save over a corrupt file repairs it", () => {
      const f = file(); fs.writeFileSync(f, "garbage")
      const s = new StateStore(f)
      s.set("x", { switchCount: 1, updated: Date.now() })
      s.save()
      const t = new StateStore(f); t.load()
      expect(t.get("x").switchCount).toBe(1)
    })
  })
})
