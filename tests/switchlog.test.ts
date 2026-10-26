import { describe, it, expect, vi } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { SwitchLog } from "../src/switchlog"

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), "relay-sl-"))
const rec = (ts: number) => ({ ts, sessionID: "s", from: "a/1", to: "b/2", kind: "quota" as const })
const rows = (d: string) => fs.readFileSync(path.join(d, "switches.jsonl"), "utf8").trim().split("\n").map((x) => JSON.parse(x))
/** A persisted row shape the shared schema accepts, for seeding the file directly like a prior process. */
const seeded = (ts: number) => JSON.stringify({ ts, session: "0123456789abcdef", from: "a/1", to: "b/2", kind: "quota", elapsedMs: 5 })

describe("SwitchLog", () => {
  it("writes JSONL with an HMAC'd, stable session id and no raw id", () => {
    const d = dir(); const l = new SwitchLog(d, true)
    l.append({ ts: 1, sessionID: "ses_abc", from: "a/1", to: "b/2", kind: "rate_limit", helperCostUsd: 0.01 })
    l.append({ ts: 2, sessionID: "ses_abc", from: "b/2", to: "c/3", kind: "quota" })
    const raw = fs.readFileSync(path.join(d, "switches.jsonl"), "utf8")
    expect(raw).not.toContain("ses_abc")
    const [r1, r2] = raw.trim().split("\n").map((x) => JSON.parse(x))
    expect(r1.session).toBe(r2.session)
    expect(r1).toMatchObject({ ts: 1, from: "a/1", to: "b/2", kind: "rate_limit", helperCostUsd: 0.01 })
  })
  it("reuses the salt across instances", () => {
    const d = dir()
    new SwitchLog(d, true).append({ ts: 1, sessionID: "s", from: "a/1", to: "b/2", kind: "quota" })
    new SwitchLog(d, true).append({ ts: 2, sessionID: "s", from: "a/1", to: "b/2", kind: "quota" })
    const r = rows(d)
    expect(r[0].session).toBe(r[1].session)
  })
  it("does nothing when disabled and never throws on write errors", () => {
    const d = dir()
    new SwitchLog(d, false).append({ ts: 1, sessionID: "s", from: "a", to: "b", kind: "unknown" })
    expect(fs.existsSync(path.join(d, "switches.jsonl"))).toBe(false)
    const blocker = path.join(d, "file"); fs.writeFileSync(blocker, "x")
    expect(() => new SwitchLog(path.join(blocker, "sub"), true).append({ ts: 1, sessionID: "s", from: "a", to: "b", kind: "unknown" })).not.toThrow()
  })
  it("creates a 32-byte hex salt, with restrictive mode on POSIX", () => {
    const d = dir()
    new SwitchLog(d, true).append(rec(1))
    expect(fs.readFileSync(path.join(d, "salt"), "utf8")).toMatch(/^[0-9a-f]{64}$/)
    if (process.platform !== "win32") expect(fs.statSync(path.join(d, "salt")).mode & 0o077).toBe(0)
  })
  it("regenerates a corrupt or short salt file", () => {
    for (const bad of ["", "zz", "abcd", "g".repeat(64), "ab".repeat(40)]) {
      const d = dir()
      fs.writeFileSync(path.join(d, "salt"), bad)
      const l = new SwitchLog(d, true)
      l.append(rec(1)); l.append(rec(2))
      expect(fs.readFileSync(path.join(d, "salt"), "utf8")).toMatch(/^[0-9a-f]{64}$/)
      const r = rows(d)
      expect(r[0].session).toBe(r[1].session)
      new SwitchLog(d, true).append(rec(3))
      expect(rows(d)[2].session).toBe(r[0].session)
    }
  })
  it("two instances racing on the same fresh dir agree on one valid salt", () => {
    const d = dir()
    const a = new SwitchLog(d, true), b = new SwitchLog(d, true)
    a.append(rec(1)); b.append(rec(2))
    const r = rows(d)
    expect(r[0].session).toBe(r[1].session)
    expect(fs.readFileSync(path.join(d, "salt"), "utf8")).toMatch(/^[0-9a-f]{64}$/)
  })
  it("never throws when the salt path is unwritable (a directory)", () => {
    const d = dir()
    fs.mkdirSync(path.join(d, "salt"))
    expect(() => new SwitchLog(d, true).append(rec(1))).not.toThrow()
  })
  it("sanitises model ids: strips control chars and caps at 120", () => {
    const d = dir()
    new SwitchLog(d, true).append({ ts: 1, sessionID: "s", from: "a\n\u001b[1m/" + "x".repeat(500), to: "b\u0000" + "y".repeat(500), kind: "quota" })
    const r = rows(d)[0]
    expect(r.from.length).toBe(120); expect(r.to.length).toBe(120)
    expect(r.from).not.toMatch(/[\u0000-\u001f]/); expect(r.to).not.toContain("\u0000")
  })
  it("adopts a salt that becomes valid during the retry window instead of overwriting", () => {
    const d = dir(); const f = path.join(d, "salt")
    fs.writeFileSync(f, "")
    const good = "ab".repeat(32)
    let calls = 0
    const l = new SwitchLog(d, true, () => { if (calls++ === 0) fs.writeFileSync(f, good) })
    l.append(rec(1))
    expect(fs.readFileSync(f, "utf8")).toBe(good)
    expect(calls).toBe(1)
  })
  it("still regenerates a genuinely corrupt salt after retries", () => {
    const d = dir(); const f = path.join(d, "salt")
    fs.writeFileSync(f, "bad")
    let calls = 0
    new SwitchLog(d, true, () => { calls++ }).append(rec(1))
    expect(calls).toBe(3)
    expect(fs.readFileSync(f, "utf8")).toMatch(/^[0-9a-f]{64}$/)
  })
  it("collects older valid rows when malformed lines fill the physical tail", () => {
    const d = dir(); const l = new SwitchLog(d, true)
    l.append(rec(1)); l.append(rec(2)); l.append(rec(3))
    fs.appendFileSync(path.join(d, "switches.jsonl"), "{malformed}\n".repeat(11))

    const read = vi.spyOn(fs, "readSync")
    expect(l.recent(10).map((row) => row.ts)).toEqual([1, 2, 3])
    expect(Math.max(...read.mock.calls.map((call) => (call as any[])[3] as number))).toBeLessThanOrEqual(64 * 1024)
    read.mockRestore()
  })
  it("replaces an over-bound model ref so the newest row stays visible", () => {
    const d = dir(); const l = new SwitchLog(d, true)
    l.append(rec(1))
    l.append({ ts: 2, sessionID: "s", from: "a/" + "x".repeat(70 * 1024), to: "b/2", kind: "quota" })
    const recent = l.recent(10)
    expect(recent.map((r) => r.ts)).toEqual([1, 2])
    expect(recent[1]!.from).toBe("unknown/" + "x".repeat(112))
    expect(recent[1]!.from!.length).toBe(120)
  })
  it("rejects appends the shared row schema invalidates (negative ts)", () => {
    const d = dir()
    new SwitchLog(d, true).append({ ...rec(1), ts: -5 })
    expect(fs.existsSync(path.join(d, "switches.jsonl"))).toBe(false)
  })
  it("skips persisted rows the shared schema invalidates without hiding valid ones", () => {
    const valid = (ts: number) => JSON.stringify({ ts, session: "0123456789abcdef", from: "a/1", to: "b/2", kind: "quota", elapsedMs: 5 })
    const bad: [string, string][] = [
      ["bad kind", JSON.stringify({ ts: 2, session: "0123456789abcdef", kind: "bogus", elapsedMs: 5 })],
      ["dropped without reason", JSON.stringify({ ts: 2, session: "0123456789abcdef", kind: "switch_dropped", elapsedMs: 5 })],
      ["non-dropped with reason", JSON.stringify({ ts: 2, session: "0123456789abcdef", kind: "quota", reason: "lock_held", elapsedMs: 5 })],
      ["bad session", JSON.stringify({ ts: 2, session: "not-hex", kind: "quota", elapsedMs: 5 })],
      ["negative ts", JSON.stringify({ ts: -2, session: "0123456789abcdef", kind: "quota", elapsedMs: 5 })],
      ["negative elapsedMs", JSON.stringify({ ts: 2, session: "0123456789abcdef", kind: "quota", elapsedMs: -5 })],
      ["infinite ts", '{"ts":1e999,"session":"0123456789abcdef","kind":"quota","elapsedMs":5}'],
      ["oversized model ref", JSON.stringify({ ts: 2, session: "0123456789abcdef", from: "a/" + "x".repeat(500), kind: "quota", elapsedMs: 5 })],
    ]
    for (const [name, line] of bad) {
      const d = dir()
      fs.writeFileSync(path.join(d, "switches.jsonl"), [valid(1), line, valid(3)].join("\n") + "\n")
      expect(new SwitchLog(d, true).recent(10).map((r) => r.ts), name).toEqual([1, 3])
    }
  })
  it("skips a partial oversized row at the tail-window start without hiding newer rows", () => {
    const d = dir()
    fs.writeFileSync(path.join(d, "switches.jsonl"), JSON.stringify({ ts: 1, session: "0123456789abcdef", from: "a/" + "x".repeat(70 * 1024), kind: "quota", elapsedMs: 5 }) + "\n")
    const l = new SwitchLog(d, true)
    l.append(rec(2)); l.append(rec(3))
    expect(l.recent(10).map((r) => r.ts)).toEqual([2, 3])
  })
  it("compacts rows older than the 30-day window on append, keeping fresh rows visible to recent()", () => {
    const now = Date.now()
    const d = dir()
    fs.writeFileSync(path.join(d, "switches.jsonl"), [seeded(1), seeded(2), seeded(now - 1000)].join("\n") + "\n")
    const l = new SwitchLog(d, true)
    l.append(rec(now))
    expect(rows(d).map((r) => r.ts)).toEqual([now - 1000, now])
    expect(l.recent(10).map((r) => r.ts)).toEqual([now - 1000, now])
    if (process.platform !== "win32") expect(fs.statSync(path.join(d, "switches.jsonl")).mode & 0o077).toBe(0)
  })
  it("rewrites nothing while the oldest row is inside the window (anchor gate)", () => {
    const now = Date.now()
    const d = dir()
    fs.writeFileSync(path.join(d, "switches.jsonl"), [seeded(now - 1000), seeded(now - 500)].join("\n") + "\n")
    const rename = vi.spyOn(fs, "renameSync")
    new SwitchLog(d, true).append(rec(now))
    expect(rename).not.toHaveBeenCalled()
    expect(rows(d).map((r) => r.ts)).toEqual([now - 1000, now - 500, now])
    rename.mockRestore()
  })
  it("skips malformed lines during compaction", () => {
    const now = Date.now()
    const d = dir()
    fs.writeFileSync(path.join(d, "switches.jsonl"), [seeded(1), "{malformed}", seeded(now - 1000)].join("\n") + "\n")
    new SwitchLog(d, true).append(rec(now))
    expect(rows(d).map((r) => r.ts)).toEqual([now - 1000, now])
  })
  it("no-ops when disabled, even with out-of-window rows on disk", () => {
    const d = dir()
    fs.writeFileSync(path.join(d, "switches.jsonl"), seeded(1) + "\n")
    new SwitchLog(d, false).append(rec(Date.now()))
    expect(fs.readFileSync(path.join(d, "switches.jsonl"), "utf8")).toBe(seeded(1) + "\n")
  })
  it("keeps the appended row, never throws and leaves no temp file when the rewrite rename fails", () => {
    const now = Date.now()
    const d = dir()
    fs.writeFileSync(path.join(d, "switches.jsonl"), [seeded(1), seeded(now - 1000)].join("\n") + "\n")
    const rename = vi.spyOn(fs, "renameSync").mockImplementation(() => { throw new Error("E_PERM") })
    try {
      const l = new SwitchLog(d, true)
      expect(() => l.append(rec(now))).not.toThrow()
      // Compaction is abandoned, not the append: the fresh row must still land after the old ones.
      expect(rows(d).map((r) => r.ts)).toEqual([1, now - 1000, now])
    } finally { rename.mockRestore() }
    expect(fs.readdirSync(d).filter((n) => n.startsWith("switches.jsonl.tmp"))).toEqual([])
  })
})
