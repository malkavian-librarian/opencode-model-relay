import { describe, it, expect } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { SwitchLog } from "../src/switchlog"

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), "relay-sl-"))
const rec = (ts: number) => ({ ts, sessionID: "s", from: "a/1", to: "b/2", kind: "quota" as const })
const rows = (d: string) => fs.readFileSync(path.join(d, "switches.jsonl"), "utf8").trim().split("\n").map((x) => JSON.parse(x))

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
})
