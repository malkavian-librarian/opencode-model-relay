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
  it("persists pluginPinned, adoption and circular progress across instances", () => {
    const f = file()
    const a = new StateStore(f); a.load()
    a.set("s1", { pluginPinned: "b/2", adoptedAt: 123, quarantine: { "a/1": 99 }, circularOrigin: "a/1", circularTransitions: 2, circularFlows: 1, switchCount: 1, updated: Date.now() }); a.save()
    const b = new StateStore(f); b.load()
    expect(b.get("s1")).toMatchObject({ pluginPinned: "b/2", adoptedAt: 123, quarantine: { "a/1": 99 }, circularOrigin: "a/1", circularTransitions: 2, circularFlows: 1, switchCount: 1 })
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
  it("validates pluginPinned, adoptedAt and quarantine at load: keeps good values, drops bad ones", () => {
    const f = file()
    const now = Date.now()
    fs.writeFileSync(f, JSON.stringify({ v: 1, sessions: {
      ok: { switchCount: 1, pluginPinned: "b/2", adoptedAt: 2.9, quarantine: { "a/1": 5 }, updated: now },
      badPin: { switchCount: 1, pluginPinned: 42, updated: now },
      negAt: { switchCount: 1, adoptedAt: -1, updated: now },
      strAt: { switchCount: 1, adoptedAt: "soon", updated: now },
      qBad: { switchCount: 1, quarantine: { "a/1": -1, "x/9": "y" }, updated: now },
      judge: { switchCount: 1, judgeCalls: 2.9, lastJudgeAt: -1, updated: now },
      judgeBad: { switchCount: 1, judgeCalls: "9", lastJudgeAt: "then", updated: now },
    } }))
    const s = new StateStore(f); s.load()
    expect(s.get("ok").pluginPinned).toBe("b/2")
    expect(s.get("ok").adoptedAt).toBe(2)
    expect(s.get("ok").quarantine).toEqual({ "a/1": 5 })
    expect(s.get("badPin").pluginPinned).toBeUndefined()
    expect(s.get("negAt").adoptedAt).toBeUndefined()
    expect(s.get("strAt").adoptedAt).toBeUndefined()
    expect(s.get("qBad").quarantine).toBeUndefined()
    expect(s.get("judge")).toMatchObject({ judgeCalls: 2 })
    expect(s.get("judge").lastJudgeAt).toBeUndefined() // negative timestamps are not dateable
    expect(s.get("judgeBad").judgeCalls).toBeUndefined()
    expect(s.get("judgeBad").lastJudgeAt).toBeUndefined()
  })

  it("judgeDaily round trip and hostile validation", () => {
    const f = file()
    const a = new StateStore(f); a.load()
    a.judgeDaily.calls = 2
    a.judgeDaily.costUsd = 0.03
    a.save()
    const b = new StateStore(f); b.load()
    expect(b.judgeDaily.calls).toBe(2)
    expect(b.judgeDaily.costUsd).toBe(0.03)
    fs.writeFileSync(f, JSON.stringify({ v: 1, sessions: {}, judgeDaily: { date: 7, calls: -2, costUsd: "x", extra: "y" } }))
    const c = new StateStore(f); c.load()
    expect(Object.keys(c.judgeDaily)).toEqual([]) // all fields invalid or bogus -> dropped
    expect(() => c.save()).not.toThrow()
    expect(JSON.parse(fs.readFileSync(f, "utf8")).judgeDaily).toEqual({})
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

  describe("model health persistence", () => {
    it("persists health across instances and drops nothing fresh", () => {
      const f = file(); const now = Date.now()
      const a = new StateStore(f); a.load()
      a.health["a/1"] = { permanent: true, permanentAt: now, failures: 2 }
      a.health["b/2"] = { cooldownUntil: now + 1000, failures: 1 }
      a.save()
      const b = new StateStore(f); b.load()
      expect(b.health["a/1"]).toEqual({ permanent: true, permanentAt: now, failures: 2 })
      expect(b.health["b/2"]).toEqual({ cooldownUntil: now + 1000, failures: 1 })
    })

    it("expired cooldowns disappear at load and at save", () => {
      const f = file(); let t = 1_000_000
      const a = new StateStore(f, () => t); a.load()
      a.health["b/2"] = { cooldownUntil: t - 1 }
      a.health["c/3"] = { cooldownUntil: t + 1000 }
      a.save()
      const b = new StateStore(f, () => t); b.load()
      expect(b.health["b/2"]).toBeUndefined()
      expect(b.health["c/3"]).toEqual({ cooldownUntil: t + 1000 })
      t += 1001
      a.save()
      expect(a.health["c/3"]).toBeUndefined()
      expect(JSON.parse(fs.readFileSync(f, "utf8")).health).toEqual({})
    })

    it("a permanent blacklist expires after 24 h, or lifts on a successful turn", () => {
      const f = file(); let t = 1_000_000
      const a = new StateStore(f, () => t); a.load()
      a.health["a/1"] = { permanent: true, permanentAt: t, failures: 1 }
      a.health["b/2"] = { permanent: true, failures: 1 } // no stamp: not dateable, dropped
      a.save()
      const b = new StateStore(f, () => t); b.load()
      expect(b.health["a/1"]).toEqual({ permanent: true, permanentAt: t, failures: 1 })
      expect(b.health["b/2"]).toBeUndefined()
      t += 24 * 3600 * 1000 + 1
      b.save()
      expect(b.health["a/1"]).toBeUndefined()
    })

    it("far-future hostile timestamps are clamped or dropped: a poisoned file cannot blacklist forever", () => {
      const f = file(); const now = 1_000_000
      fs.writeFileSync(f, JSON.stringify({ v: 1, sessions: {}, health: {
        "cool/1": { cooldownUntil: 1e18 },
        "future/1": { permanent: true, permanentAt: now + 5000 },
      } }))
      const s = new StateStore(f, () => now); s.load()
      expect(s.health["cool/1"]!.cooldownUntil).toBe(now + 3_600_000) // the runtime cooldown cap
      expect(s.health["future/1"]).toBeUndefined()
      s.save()
      expect(JSON.parse(fs.readFileSync(f, "utf8")).health["future/1"]).toBeUndefined()
    })

    it("validates hostile health entries: bad shape, bad values, bad keys, cap", () => {
      const f = file()
      const many: Record<string, unknown> = Object.create(null)
      for (let i = 0; i < 210; i++) many["m" + i + "/1"] = { permanent: true, permanentAt: Date.now() }
      fs.writeFileSync(f, JSON.stringify({ v: 1, sessions: {}, health: {
        "ok/1": { permanent: true, permanentAt: Date.now(), failures: 2 },
        "noPing/1": { permanent: true }, // permanent without a timestamp -> dropped
        "neg/1": { failures: -1 },
        "str/1": { failures: "3" },
        "nan/1": { cooldownUntil: Number.NaN },
        "": { permanent: true, permanentAt: Date.now() },
        "with null byte\u0000/1": { permanent: true, permanentAt: Date.now() },
        "new\nline/1": { permanent: true, permanentAt: Date.now() },
        notObject: 5,
        arrModel: [{ permanent: true }],
        ...many,
      } }))
      const s = new StateStore(f); s.load()
      expect(s.health["ok/1"]).toEqual({ permanent: true, permanentAt: expect.any(Number), failures: 2 })
      for (const k of ["noPing/1", "neg/1", "str/1", "nan/1", "", "with null byte\u0000/1", "new\nline/1", "notObject", "arrModel"]) {
        expect(s.health[k]).toBeUndefined()
      }
      expect(Object.keys(s.health).length).toBeLessThanOrEqual(200)
      expect(() => s.save()).not.toThrow()
    })

    it("controls/prototypes keys in health do not pollute", () => {
      const f = file()
      fs.writeFileSync(f, '{"v":1,"sessions":{},"health":{"__proto__":{"permanent":true,"permanentAt":' + Date.now() + '}}}')
      const s = new StateStore(f); s.load()
      expect(({} as Record<string, unknown>).permanent).toBeUndefined()
      expect(Object.keys(s.health)).toEqual(["__proto__"]) // plain data on a null-prototype map
      expect(() => s.save()).not.toThrow()
    })
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
        good: { pluginPinned: "b/2", switchCount: 1, updated: now },
        noUpdated: { switchCount: 1 },
        strUpdated: { switchCount: 1, updated: "yesterday" },
        noCount: { updated: now },
        nullRec: null,
        strRec: "x",
        arrRec: [],
        nanCount: { switchCount: null, updated: now },
        badPinned: { pluginPinned: 42, adoptedAt: {}, quarantine: "no", switchCount: 3, updated: now },
      } }))
      const s = new StateStore(f, () => now); s.load()
      expect(s.get("good")).toMatchObject({ pluginPinned: "b/2", switchCount: 1 })
      for (const k of ["noUpdated", "strUpdated", "noCount", "nullRec", "strRec", "arrRec", "nanCount"]) {
        expect(s.get(k).switchCount).toBe(0)
      }
      const bs = s.get("badPinned")
      expect(bs.switchCount).toBe(3)
      expect(bs.pluginPinned).toBeUndefined()
      expect(bs.adoptedAt).toBeUndefined()
      expect(bs.quarantine).toBeUndefined()
      s.save()
      const saved = JSON.parse(fs.readFileSync(f, "utf8")).sessions
      expect(Object.keys(saved).sort()).toEqual(["badPinned", "good"])
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

  describe("crash-restart windows (#66)", () => {
    it("discards a pending-handover intent on load (never resumes and discards at once)", () => {
      const f = file()
      const now = Date.now()
      fs.writeFileSync(f, JSON.stringify({ v: 1, sessions: {
        s1: { switchCount: 1, pluginPinned: "b/2", pendingHandover: { to: "b/2", at: now }, updated: now },
      } }))
      const s = new StateStore(f); s.load()
      expect(s.get("s1").pendingHandover).toBeUndefined() // discard wins: the intent never survives a reload
      expect(s.get("s1").pluginPinned).toBe("b/2")
    })
    it("validatePinned drops pluginPinned values absent from the configured levels, keeps known ones", () => {
      const f = file()
      const now = Date.now()
      fs.writeFileSync(f, JSON.stringify({ v: 1, sessions: {
        known: { switchCount: 1, pluginPinned: "a/1", updated: now },
        gone: { switchCount: 1, pluginPinned: "z/9", updated: now },
        none: { switchCount: 1, updated: now },
      } }))
      const s = new StateStore(f); s.load()
      s.validatePinned(new Set(["a/1", "b/2"]))
      expect(s.get("known").pluginPinned).toBe("a/1")
      expect(s.get("gone").pluginPinned).toBeUndefined()
      expect(s.get("none").switchCount).toBe(1)
    })
    it("a hostile quarantine map is bounded at load", () => {
      const f = file()
      const now = Date.now()
      const many: Record<string, number> = {}
      for (let i = 0; i < 200; i++) many["m" + i + "/1"] = now
      fs.writeFileSync(f, JSON.stringify({ v: 1, sessions: { s1: { switchCount: 1, quarantine: many, updated: now } } }))
      const s = new StateStore(f); s.load()
      expect(Object.keys(s.get("s1").quarantine ?? {}).length).toBeLessThanOrEqual(64)
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
