import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"
import { EventLog } from "../src/ledger"

const tmpDirs: string[] = []
function dir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "relay-ledger-"))
  tmpDirs.push(d)
  return d
}
let pidCount = 0
function nextPid(): number {
  return 4242 + ++pidCount
}
const base = { ts: 1, sessionID: "s" } as const

beforeEach(() => { tmpDirs.length = 0; pidCount = 0 })
afterEach(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }) })

describe("EventLog", () => {
  it("round-trips narrative costs including zero, strips unknown text and preserves HMAC identity", () => {
    const d = dir(); const l = new EventLog(d, true, nextPid())
    for (const helperCostUsd of [0, 0.03]) expect(l.append({ ...base, event: "narrative", model: "prov/a", tier: 1, helperCostUsd, text: "must not persist" } as never)).toBe(true)
    const rows = l.read(30, 2)
    expect(rows.map((r) => r.helperCostUsd).sort()).toEqual([0, 0.03])
    expect(rows[0]!.session).toMatch(/^[0-9a-f]{16}$/)
    expect(rows[1]!.session).toBe(rows[0]!.session)
    expect(Object.keys(rows[0]!).sort()).toEqual(["event", "helperCostUsd", "model", "session", "tier", "ts"])
  })
  it("rejects malformed narrative metadata on both append and read", () => {
    const d = dir(); const l = new EventLog(d, true, nextPid())
    const valid = { ...base, event: "narrative", model: "prov/a", helperCostUsd: 0.03 }
    const bad = [
      { model: undefined }, { helperCostUsd: undefined }, { model: "bad model" }, { model: "p/" + "x".repeat(119) },
      ...[null, "0.03", -1, NaN, Infinity, -Infinity].map((helperCostUsd) => ({ helperCostUsd })),
      { sw: { kind: "manual" } }, { verdict: "stay" }, { errorKind: "quota" },
    ]
    for (const override of bad) {
      const row = { ...valid, ...override }
      expect(l.append(row as never)).toBe(false)
      fs.appendFileSync(path.join(d, "events-4243.jsonl"), JSON.stringify({ ...row, session: "0123456789abcdef" }) + "\n")
    }
    expect(l.read(30, 0)).toEqual([])
  })
  it("keeps historical event kinds readable with and without optional costs and retains refinements", () => {
    const l = new EventLog(dir(), true, nextPid())
    const old = [{ event: "turn" }, { event: "failure", errorKind: "quota" }, { event: "judge", verdict: "stay" }, { event: "switch", sw: { kind: "manual" } }]
    for (const row of old) for (const costs of [{}, { cost: 0.2, helperCostUsd: 0.02 }]) expect(l.append({ ...base, ...row, ...costs } as never)).toBe(true)
    expect(l.read(30, 2)).toHaveLength(8)
    for (const event of ["failure", "judge", "switch"]) expect(l.append({ ...base, event } as never)).toBe(false)
  })
  it("failure rows accept bounded optional httpStatus and attempt; historical rows without them still parse (#107)", () => {
    const d = dir(); const pid = nextPid(); const l = new EventLog(d, true, pid)
    const rows = [
      { ts: 1, httpStatus: 100, attempt: 0 },
      { ts: 2, httpStatus: 418 },
      { ts: 3, attempt: 2 },
      { ts: 4, httpStatus: 599, attempt: 7 },
    ]
    for (const r of rows) expect(l.append({ ...base, ...r, event: "failure", errorKind: "unknown", model: "prov/a" })).toBe(true)
    expect(l.read(30, 5).map((r) => [r.httpStatus, r.attempt])).toEqual([[100, 0], [418, undefined], [undefined, 2], [599, 7]])
    // a historical row without the fields parses at the read boundary: no migration, no startup order change
    fs.appendFileSync(path.join(d, `events-${pid}.jsonl`), JSON.stringify({ ts: 5, session: "0123456789abcdef", event: "failure", errorKind: "quota" }) + "\n")
    expect(l.read(30, 5)).toHaveLength(5)
    expect(l.read(30, 5).at(-1)).toMatchObject({ event: "failure", errorKind: "quota" })
  })
  it("rejects out-of-range, non-integer and non-finite httpStatus/attempt, and both fields on non-failure rows (#107)", () => {
    const d = dir(); const l = new EventLog(d, true, nextPid())
    const bad = [
      ...[99, 600, 1000, 418.5, "418", NaN, Infinity, -Infinity].map((httpStatus) => ({ httpStatus })),
      ...[-1, 1.5, "2", NaN, Infinity].map((attempt) => ({ attempt })),
    ]
    for (const override of bad) {
      expect(l.append({ ...base, event: "failure", errorKind: "unknown", model: "prov/a", ...override } as never), JSON.stringify(override)).toBe(false)
    }
    for (const row of [
      { event: "turn", model: "prov/a" },
      { event: "health", model: "prov/a", what: "cooldown_start", untilMs: 101 },
      { event: "judge", model: "prov/a", verdict: "stay" },
      { event: "switch", sw: { kind: "manual" } },
    ]) {
      expect(l.append({ ...base, ...row, httpStatus: 418 } as never)).toBe(false)
      expect(l.append({ ...base, ...row, attempt: 2 } as never)).toBe(false)
    }
    expect(l.read(30, 2)).toEqual([])
  })
  it("round-trips every judge outcome and deterministic heuristic evidence", () => {
    const l = new EventLog(dir(), true, nextPid())
    const rows = [
      { outcome: "error" }, { outcome: "timeout" }, { outcome: "unparseable" },
      { outcome: "skipped_cap" }, { outcome: "skipped_no_heuristic" },
      { verdict: "switch", reason: "loop", confidence: 0.8, latencyMs: 12, heuristicReasons: ["loop", "no_output"] },
    ]
    for (const row of rows) expect(l.append({ ...base, event: "judge", model: "prov/a", ...row } as never)).toBe(true)
    expect(l.read(30, 2)).toHaveLength(rows.length)
  })
  it("round-trips validated health transitions and rejects invalid timing fields", () => {
    const l = new EventLog(dir(), true, nextPid())
    expect(l.append({ ...base, event: "health", model: "prov/a", what: "cooldown_start", untilMs: 101 } as never)).toBe(true)
    expect(l.append({ ...base, event: "health", model: "prov/a", what: "cooldown_end", untilMs: 101 } as never)).toBe(false)
    expect(l.append({ ...base, event: "health", model: "prov/a", what: "quarantine_skip", untilMs: 101 } as never)).toBe(false)
    expect(l.append({ ...base, event: "health", model: "prov/a", what: "exhausted", cost: 1 } as never)).toBe(false)
    expect(l.read(30, 0)).toEqual([])
    expect(l.read(30, 101)).toMatchObject([{ event: "health", model: "prov/a", what: "cooldown_start", untilMs: 101 }])
  })
  it("appends a metadata-only row with an HMAC session and 0600 mode", () => {
    const d = dir(); const l = new EventLog(d, true, nextPid())
    l.append({ ...base, event: "turn", model: "prov/a" })
    const f = path.join(d, `events-4243.jsonl`)
    const rows = fs.readFileSync(f, "utf8").trim().split("\n").map((r) => JSON.parse(r))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ ts: 1, event: "turn", model: "prov/a" })
    expect(rows[0].session).toMatch(/^[0-9a-f]{16}$/)
    expect(Boolean(fs.statSync(f).mode & 0o600)).toBe(true)
    expect(Object.keys(rows[0]).sort()).toEqual(["event", "model", "session", "ts"])
  })
  it("rejects free-text and out-of-bound fields (no prompt/response surface)", () => {
    const d = dir(); const l = new EventLog(d, true, nextPid())
    const bad = [
      { ...base, event: "turn", model: "a/" + "x".repeat(200) },
      { ...base, event: "turn", model: "PROV A", msg: "hello world reply text" },
      { ...base, event: "failure", errorKind: "bogus" },
      { ...base, event: "judge", verdict: "maybe" },
      { ...base, event: "switch", sw: { kind: "switch_dropped" } },
      { ...base, event: "turn", latencyMs: -5 },
      { ...base, event: "turn", model: "prov/a", what: "exhausted" },
    ]
    for (const b of bad) expect(l.append(b as never), JSON.stringify(b).slice(0, 40)).toBe(false)
    expect(fs.existsSync(path.join(d, `events-4243.jsonl`))).toBe(false)
  })
  it("rotates the active file when a new month begins", () => {
    const d = dir(); const pid = nextPid(); const f = path.join(d, `events-${pid}.jsonl`)
    const l = new EventLog(d, true, pid)
    l.append({ ts: Date.UTC(2026, 8, 1), sessionID: "s", event: "turn", model: "prov/a" })
    // Next write lands in the next UTC month: the September file must be renamed, not merged.
    expect(l.append({ ts: Date.UTC(2026, 9, 1), sessionID: "s", event: "turn", model: "prov/a" })).toBe(true)
    const names = fs.readdirSync(d).filter((n) => n.endsWith(".jsonl"))
    // Active file holds only the November row; the September row lives in exactly one rotated file.
    expect(fs.readFileSync(path.join(d, `events-${pid}.jsonl`), "utf8").trim().split("\n")).toHaveLength(1)
    expect(names.filter((n) => n !== `events-${pid}.jsonl`)).toHaveLength(1)
    expect(fs.readFileSync(f, "utf8").trim().split("\n")).toHaveLength(1)
  })
  it("reads the 30-day window across rotated files, skipping corrupt lines, newest last", () => {
    const d = dir(); const pid = nextPid()
    const l = new EventLog(d, true, pid)
    const now = Date.UTC(2026, 9, 20, 12)
    l.append({ ts: now - 40 * 864e5, sessionID: "s", event: "turn", model: "prov/old" }) // outside window
    l.append({ ts: now - 120, sessionID: "s", event: "turn", model: "prov/a" })
    l.append({ ts: now - 60, sessionID: "s", event: "failure", errorKind: "quota" })
    fs.appendFileSync(path.join(d, `events-${pid}.jsonl`), "this is not json\n")
    l.append({ ts: now - 10, sessionID: "s", event: "switch", sw: { kind: "manual", from: "prov/a", to: "prov/b" } })
    const out = l.read(30, now)
    expect(out.map((e) => e.ts)).toEqual([now - 120, now - 60, now - 10])
    expect(out[2]!.sw).toMatchObject({ kind: "manual", from: "prov/a", to: "prov/b" })
  })
  it("purges only event files inside the confined dir and reports the count", () => {
    const d = dir(); const pid = nextPid()
    fs.writeFileSync(path.join(d, `events-${pid}.jsonl`), "\n")
    fs.writeFileSync(path.join(d, `events-${pid}-202609.jsonl`), "\n")
    fs.writeFileSync(path.join(d, "keep.txt"), "x")
    const outside = path.join(d, "sub", `events-${pid}.jsonl`)
    fs.mkdirSync(path.dirname(outside)); fs.writeFileSync(outside, "\n")
    const n = new EventLog(d, true, pid).purge()
    expect(n).toBe(2)
    expect(fs.readdirSync(d).sort()).toEqual(["keep.txt", "sub"])
  })
  it("never throws: disabled log and unwritable dir are best effort", () => {
    const ro = dir(); fs.chmodSync(ro, 0o444)
    expect(() => new EventLog(ro, true, nextPid()).append({ ...base, event: "turn", model: "prov/a" })).not.toThrow()
    expect(new EventLog(dir(), false, nextPid()).append({ ...base, event: "turn" })).toBe(false)
    expect(new EventLog(dir(), false, nextPid()).read(30)).toEqual([])
  })
})
