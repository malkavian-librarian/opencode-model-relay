import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { buildStats, writeStats, readStats, renderStatsTable } from "../src/stats"
import type { LedgerEvent } from "../src/ledger"
import { EventLog } from "../src/ledger"

const DAY = 864e5
const S = "0123456789abcdef"
const turn = (ts: number, model = "prov/a", over: Partial<LedgerEvent> = {}): LedgerEvent =>
  ({ ts, session: S, event: "turn", model, ...over } as LedgerEvent)

const tmpDirs: string[] = []
function dir(): string { const d = fs.mkdtempSync(path.join(os.tmpdir(), "relay-stats-")); tmpDirs.push(d); return d }
beforeEach(() => { tmpDirs.length = 0 })
afterEach(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }) })

const NOW = Date.UTC(2026, 9, 20, 12) // 2026-10-20T12:00Z

describe("buildStats", () => {
  it("buckets per model per UTC day over the rolling 30-day window and prunes by ts", () => {
    const ev = [
      turn(NOW - 40 * DAY, "prov/old"),
      turn(NOW - DAY, "prov/a", { tier: 1 }),
      turn(NOW - DAY, "prov/a", { tokens: { input: 10, output: 20 }, cost: 0.3, latencyMs: 100 }),
      turn(NOW - 2 * DAY, "prov/b"),
    ]
    const s = buildStats(ev, NOW)
    expect(Object.keys(s.models)).toEqual(["prov/a", "prov/b"])
    expect(s.models["prov/a"]!["2026-10-19"]).toMatchObject({ turns: 2, tokensIn: 10, tokensOut: 20, costUsd: 0.3 })
    expect(s.models["prov/a"]!["2026-09-10"]).toBeUndefined()
    expect(s.models["prov/b"]!["2026-10-18"]).toMatchObject({ turns: 1 })
  })
  it("counts failures by kind and the tier-2/3 judge rejection rate", () => {
    const ev = [
      turn(NOW - DAY, "prov/a", { tier: 2 }),
      { ts: NOW - DAY, session: S, event: "failure", errorKind: "quota", model: "prov/a", tier: 2 },
      { ts: NOW - DAY, session: S, event: "failure", errorKind: "quota", model: "prov/a", tier: 2 },
      { ts: NOW - DAY, session: S, event: "failure", errorKind: "timeout", model: "prov/a", tier: 2 },
      { ts: NOW - DAY, session: S, event: "judge", verdict: "switch", tier: 2, model: "prov/a" },
      { ts: NOW - DAY, session: S, event: "judge", verdict: "stay", tier: 2, model: "prov/a" },
    ] as LedgerEvent[]
    const b = buildStats(ev, NOW).models["prov/a"]!["2026-10-19"]!
    expect(b.failures).toEqual({ quota: 2, timeout: 1 })
    expect(b.judgeCalls).toBe(2); expect(b.judgeRejects).toBe(1)
  })
  it("computes survival: same-session next turn on the same model within 30min/5 turns, switch kills it, window-close censors", () => {
    const M = "prov/a"
    const mk = (ts: number, model: string): LedgerEvent => ({ ts, session: S, event: "turn", model })
    const ev: LedgerEvent[] = [
      mk(NOW - 500, M), // succeeded: next same-model turn 100ms later
      mk(NOW - 400, M),
      mk(NOW - 300, M), // switch happens before the next same-model turn -> survival failure
      { ts: NOW - 250, session: S, event: "switch", sw: { kind: "timeout", from: M, to: "prov/b" } },
      mk(NOW - 200, "prov/b"),
      mk(NOW - 100, M), // censored: no next turn at all
    ]
    const b = buildStats(ev, NOW).models[M]![new Date(NOW - 500).toISOString().slice(0, 10)]!
    // turn@-500 success; turn@-400 success (also 100ms); turn@-100 unclosed -> censored at same-day bucket
    expect(b.survivalOk).toBe(2)
    expect(b.survivalCensored).toBe(1)
  })
  it("median latency: even count averages the two middle samples", () => {
    const ev = [turn(NOW - DAY, "prov/a", { latencyMs: 10 }), turn(NOW - DAY, "prov/a", { latencyMs: 20 }),
      turn(NOW - DAY, "prov/a", { latencyMs: 30 }), turn(NOW - DAY, "prov/a", { latencyMs: 40 })]
    expect(buildStats(ev, NOW).models["prov/a"]!["2026-10-19"]!.medianLatencyMs).toBe(25)
  })
  it("derives switch-away per model-day from switch events' from field, helper cost summed", () => {
    const ev = [
      turn(NOW - DAY, "prov/a"),
      { ts: NOW - DAY, session: S, event: "switch", sw: { kind: "rate_limit", from: "prov/a", to: "prov/b" } },
      { ts: NOW - DAY, session: S, event: "judge", verdict: "switch", tier: 2, model: "prov/b", helperCostUsd: 0.01 },
    ] as LedgerEvent[]
    const s = buildStats(ev, NOW)
    expect(s.models["prov/a"]!["2026-10-19"]!.switchAway).toBe(1)
    expect(s.models["prov/b"]!["2026-10-19"]!).toMatchObject({ judgeCalls: 1, judgeRejects: 1, helperCostUsd: 0.01 })
  })
})

describe("stats.json write/read", () => {
  it("writes atomically and reads back; a corrupt or foreign stats.json parses to null", () => {
    const d = dir()
    const s = buildStats([turn(NOW - DAY)], NOW)
    writeStats(s, d)
    // Temp file must be gone: atomic temp+rename left no residue beyond stats.json.
    expect(fs.readdirSync(d).filter((f) => !f.endsWith(".jsonl") && f !== "stats.json")).toEqual([])
    expect(readStats(d)).toEqual(s)
    fs.writeFileSync(path.join(d, "stats.json"), "{broken")
    expect(readStats(d)).toBeNull()
  })
})

describe("renderStatsTable", () => {
  it("renders per-model rows with overhead $ and no free text", () => {
    const s = buildStats([turn(NOW - DAY, "prov/a", { cost: 0.2 }), { ts: NOW - DAY, session: S, event: "judge", verdict: "switch", tier: 2, model: "prov/a", helperCostUsd: 0.02 } as LedgerEvent], NOW)
    const txt = renderStatsTable(s)
    expect(txt).toContain("prov/a")
    expect(txt).toMatch(/\$0\.02/)
    expect(txt).toContain("turns")
    expect(txt).toContain("survival")
  })
})

describe("ledger->stats integration", () => {
  it("counts known narrative spend at completion across UTC midnight without phantom activity", () => {
    const l = new EventLog(dir(), true, 4402)
    const midnight = Date.UTC(2026, 9, 20)
    const now = midnight + 1000
    l.append({ ts: midnight - 3, sessionID: "s", event: "turn", model: "prov/a", cost: 0.20, latencyMs: 100, tokens: { input: 1, output: 2 } })
    l.append({ ts: midnight - 2, sessionID: "s", event: "judge", model: "prov/a", verdict: "switch", helperCostUsd: 0.02 })
    l.append({ ts: midnight - 1, sessionID: "s", event: "switch", sw: { kind: "quota", from: "prov/a", to: "prov/b" } })
    const baseline = buildStats(l.read(30, now), now)
    expect(l.append({ ts: midnight, sessionID: "s", event: "narrative", model: "prov/a", helperCostUsd: 0.03 })).toBe(true)
    l.append({ ts: now + 1, sessionID: "s", event: "narrative", model: "prov/future", helperCostUsd: 1 })
    l.append({ ts: now - 31 * DAY, sessionID: "s", event: "narrative", model: "prov/old", helperCostUsd: 1 })
    const stats = buildStats(l.read(30, now), now)
    expect(Object.keys(stats.models)).toEqual(["prov/a"])
    expect(stats.models["prov/a"]!["2026-10-19"]).toEqual(baseline.models["prov/a"]!["2026-10-19"])
    expect(stats.models["prov/a"]!["2026-10-20"]).toEqual({ turns: 0, failures: {}, judgeCalls: 0, judgeRejects: 0, switchAway: 0, survivalOk: 0, survivalFail: 0, survivalCensored: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, helperCostUsd: 0.03 })
    expect(renderStatsTable(stats).split("\n").find((r) => r.startsWith("prov/a |"))).toBe("prov/a | 1 | 0 | 100% | 1 | 0% | 100ms | 1/2 | $0.20 | $0.05")
    // buildStats also independently prunes future and expired events, without relying on EventLog.read.
    expect(buildStats(l.read(100, now + 1), now)).toEqual(stats)
  })
  it("a real EventLog round-trips into buckets", () => {
    const d = dir(); const pid = 4401
    const l = new EventLog(d, true, pid)
    l.append({ ts: NOW - DAY, sessionID: "s", event: "turn", model: "prov/a" })
    const s = buildStats(l.read(30, NOW), NOW)
    expect(s.models["prov/a"]!["2026-10-19"]!.turns).toBe(1)
  })
})
