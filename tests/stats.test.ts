import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { buildStats, parseStatsOptions, parseStatsToolInput, purgeAndRefreshStats, renderStatsTable, statsText, STATS_REFRESH_WARNING, writeStats } from "../src/stats"
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
  it("attributes manual regret only within five minutes to the switched-from model", () => {
    const ev = [
      { ts: NOW - 1000, session: S, event: "switch", sw: { kind: "timeout", from: "prov/a", to: "prov/b" } },
      { ts: NOW - 500, session: S, event: "switch", sw: { kind: "manual", from: "prov/b", to: "prov/a" } },
      { ts: NOW - 100, session: S, event: "switch", sw: { kind: "manual", from: "prov/a", to: "prov/b" } },
    ] as LedgerEvent[]
    const s = buildStats(ev, NOW)
    expect(s.models["prov/b"]![new Date(NOW).toISOString().slice(0, 10)]!.regret).toBe(1)
    expect(s.models["prov/a"]![new Date(NOW).toISOString().slice(0, 10)]!.regret).toBe(0)
  })
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
  it("derives cooldown downtime and off-primary share from health and turn events", () => {
    const ev = [
      turn(NOW - 1000, "prov/a", { tier: 1 }),
      turn(NOW - 900, "prov/b", { tier: 2 }),
      { ts: NOW - 800, session: S, event: "health", model: "prov/b", tier: 2, what: "cooldown_start", untilMs: NOW - 300 },
      { ts: NOW - 200, session: S, event: "health", model: "prov/b", tier: 2, what: "cooldown_end" },
    ] as LedgerEvent[]
    const b = buildStats(ev, NOW).models["prov/b"]![new Date(NOW).toISOString().slice(0, 10)]!
    expect(b.down).toBe(500)
    expect(b.offPrimary).toBe(1)
  })
  it("clips downtime to the selected window and keeps zero metrics for missing health data", () => {
    const ev = [{ ts: NOW - 1000, session: S, event: "health", model: "prov/a", what: "cooldown_start", untilMs: NOW + 1000 }] as LedgerEvent[]
    const s = buildStats(ev, NOW, 1)
    expect(s.models["prov/a"]![new Date(NOW).toISOString().slice(0, 10)]!.down).toBe(1000)
    expect(s.models["prov/a"]![new Date(NOW).toISOString().slice(0, 10)]!.offPrimary).toBe(0)
  })
  it("extends one downtime interval across renewals and consumes each end at most once", () => {
    const ev = [
      { ts: NOW - 1000, session: S, event: "health", model: "prov/a", what: "cooldown_start", untilMs: NOW - 500 },
      { ts: NOW - 900, session: S, event: "health", model: "prov/a", what: "cooldown_start", untilMs: NOW - 100 },
      { ts: NOW - 800, session: S, event: "health", model: "prov/a", what: "cooldown_end" },
      { ts: NOW - 700, session: S, event: "health", model: "prov/a", what: "cooldown_end" },
    ] as LedgerEvent[]
    const b = buildStats(ev, NOW).models["prov/a"]![new Date(NOW).toISOString().slice(0, 10)]!
    expect(b.down).toBe(200)
  })

  it("uses the latest cooldown deadline when a renewal shortens an active cooldown", () => {
    const ev = [
      { ts: NOW - 1000, session: S, event: "health", model: "prov/a", what: "cooldown_start", untilMs: NOW + 1000 },
      { ts: NOW - 500, session: S, event: "health", model: "prov/a", what: "cooldown_start", untilMs: NOW - 100 },
      { ts: NOW, session: S, event: "health", model: "prov/a", what: "cooldown_end" },
    ] as LedgerEvent[]
    const b = buildStats(ev, NOW).models["prov/a"]![new Date(NOW).toISOString().slice(0, 10)]!
    expect(b.down).toBe(900)
  })
  it("uses health starts before the window and unions cooldown with permanent downtime", () => {
    const ev = [
      { ts: NOW - 2 * DAY, session: S, event: "health", model: "prov/a", what: "cooldown_start", untilMs: NOW - 500 } as LedgerEvent,
      { ts: NOW - 900, session: S, event: "health", model: "prov/a", what: "permanent_mark", untilMs: NOW + 500 } as LedgerEvent,
      { ts: NOW - 100, session: S, event: "health", model: "prov/a", what: "cooldown_end" } as LedgerEvent,
      turn(NOW - 100, "prov/a", { tier: 1 }),
      turn(NOW - 50, "prov/a"),
    ]
    const b = buildStats(ev, NOW, 1).models["prov/a"]![new Date(NOW).toISOString().slice(0, 10)]!
    expect(b.down).toBe(DAY / 2)
    expect(b.offPrimary).toBe(0)
  })
  it("excludes unknown tiers from the off-primary denominator per day", () => {
    const ev = [
      turn(NOW - DAY, "prov/a", { tier: 2 }),
      turn(NOW - DAY, "prov/a"),
      turn(NOW, "prov/a", { tier: 1 }),
    ]
    const s = buildStats(ev, NOW)
    expect(s.models["prov/a"]!["2026-10-19"]!.offPrimary).toBe(1)
    expect(s.models["prov/a"]!["2026-10-20"]!.offPrimary).toBe(0)
  })
  it("aggregates shared health across sessions while isolating models and clipping window boundaries", () => {
    // Synthetic metadata: model health is shared even when another session observes recovery.
    const other = "fedcba9876543210"
    const floor = NOW - DAY
    const ev: LedgerEvent[] = [
      { ts: floor - 100, session: S, event: "health", model: "prov/a", what: "cooldown_start", untilMs: floor + 200 },
      { ts: floor + 100, session: other, event: "health", model: "prov/a", what: "cooldown_end" },
      { ts: NOW - 300, session: other, event: "health", model: "prov/a", what: "permanent_mark", untilMs: NOW + 100 },
      { ts: NOW - 100, session: S, event: "health", model: "prov/a", what: "permanent_expire" },
      { ts: NOW - 250, session: S, event: "health", model: "prov/b", what: "cooldown_start", untilMs: NOW + 250 },
      { ts: NOW + 50, session: other, event: "health", model: "prov/b", what: "cooldown_end" },
      { ts: NOW + 1, session: S, event: "health", model: "prov/future", what: "permanent_mark", untilMs: NOW + DAY },
      { ts: floor - 200, session: S, event: "health", model: "prov/old", what: "cooldown_start", untilMs: floor },
      turn(floor, "prov/a", { tier: 1 }),
      turn(floor + 1, "prov/a", { session: other, tier: 2 }),
      turn(NOW, "prov/a", { session: other, tier: 2 }),
      turn(NOW + 1, "prov/a", { tier: 1 }),
      turn(floor - 1, "prov/a", { tier: 1 }),
      turn(NOW, "prov/b", { session: other }),
    ]
    const s = buildStats(ev, NOW, 1)
    expect(Object.keys(s.models).sort()).toEqual(["prov/a", "prov/b"])
    expect(s.models["prov/a"]!["2026-10-19"]).toMatchObject({ turns: 2, down: 100, offPrimary: 0.5 })
    expect(s.models["prov/a"]!["2026-10-20"]).toMatchObject({ turns: 1, down: 200, offPrimary: 1 })
    expect(s.models["prov/b"]!["2026-10-20"]).toMatchObject({ turns: 1, down: 250, offPrimary: 0 })
  })
})

describe("stats.json write", () => {
  it("writes atomically: the file parses back and no temp residue remains", () => {
    const d = dir()
    const s = buildStats([turn(NOW - DAY)], NOW)
    expect(writeStats(s, d)).toBe(true)
    // Temp file must be gone: atomic temp+rename left no residue beyond stats.json.
    expect(fs.readdirSync(d).filter((f) => !f.endsWith(".jsonl") && f !== "stats.json")).toEqual([])
    expect(JSON.parse(fs.readFileSync(path.join(d, "stats.json"), "utf8"))).toEqual(s)
  })
  it("removes the temp file when the atomic rename fails", () => {
    const d = dir()
    const spy = vi.spyOn(fs, "renameSync").mockImplementation(() => { throw new Error("locked") })
    try {
      expect(writeStats(buildStats([turn(NOW - DAY)], NOW), d)).toBe(false)
    } finally { spy.mockRestore() }
    expect(fs.readdirSync(d)).toEqual([])
  })
})

describe("renderStatsTable", () => {
  it("uses all known-tier turns in the window instead of the highest daily off-primary share", () => {
    const ev = [
      turn(NOW - DAY, "prov/a", { tier: 2 }),
      turn(NOW - 3, "prov/a", { tier: 1 }),
      turn(NOW - 2, "prov/a", { tier: 1 }),
      turn(NOW - 1, "prov/a", { tier: 1 }),
      turn(NOW, "prov/a"),
      turn(NOW, "prov/unknown"),
    ]
    const rows = renderStatsTable(buildStats(ev, NOW), ev).split("\n")
    expect(rows.find((row) => row.startsWith("prov/a |"))?.split(" | ")[6]).toBe("25%")
    expect(rows.find((row) => row.startsWith("prov/unknown |"))?.split(" | ")[6]).toBe("0%")
  })

  it("renders per-model rows with overhead $ and no free text", () => {
    const ev = [turn(NOW - DAY, "prov/a", { cost: 0.2 }), { ts: NOW - DAY, session: S, event: "judge", verdict: "switch", tier: 2, model: "prov/a", helperCostUsd: 0.02 } as LedgerEvent]
    const txt = renderStatsTable(buildStats(ev, NOW), ev)
    expect(txt).toContain("prov/a")
    expect(txt).toMatch(/\$0\.02/)
    expect(txt).toContain("turns")
    expect(txt).toContain("survival")
  })
  it("medians all window samples instead of daily medians: [10,20,30]+[1000] shows 25ms (#103)", () => {
    const ev = [
      turn(NOW - DAY, "prov/a", { latencyMs: 10 }),
      turn(NOW - DAY, "prov/a", { latencyMs: 20 }),
      turn(NOW - DAY, "prov/a", { latencyMs: 30 }),
      turn(NOW - 2 * DAY, "prov/a", { latencyMs: 1000 }),
    ]
    expect(renderStatsTable(buildStats(ev, NOW), ev)).toContain("prov/a | 4 | 0 | – | 0 | 0 | 0% | 100% | 25ms | 0/0 | $0.00 | $0.00")
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
    const events = l.read(30, now)
    const stats = buildStats(events, now)
    expect(Object.keys(stats.models)).toEqual(["prov/a"])
    expect(stats.models["prov/a"]!["2026-10-19"]).toEqual(baseline.models["prov/a"]!["2026-10-19"])
    expect(stats.models["prov/a"]!["2026-10-20"]).toEqual({ turns: 0, failures: {}, judgeCalls: 0, judgeRejects: 0, switchAway: 0, down: 0, offPrimary: 0, survivalOk: 0, survivalFail: 0, survivalCensored: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, helperCostUsd: 0.03 })
    expect(renderStatsTable(stats, events).split("\n").find((r) => r.startsWith("prov/a |"))).toBe("prov/a | 1 | 0 | 100% | 1 | 0 | 0% | 0% | 100ms | 1/2 | $0.20 | $0.05 | 0")
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

describe("stats options (command and tool)", () => {
  it("accepts defaults, explicit values and both flag orders with normal inter-token whitespace", () => {
    expect(parseStatsOptions("")).toEqual({ days: 30, kinds: false })
    expect(parseStatsOptions("   ")).toEqual({ days: 30, kinds: false })
    expect(parseStatsOptions("--days 1")).toEqual({ days: 1, kinds: false })
    expect(parseStatsOptions("--days 30")).toEqual({ days: 30, kinds: false })
    expect(parseStatsOptions("--kinds")).toEqual({ days: 30, kinds: true })
    expect(parseStatsOptions("--days 1 --kinds")).toEqual({ days: 1, kinds: true })
    expect(parseStatsOptions("--kinds\t--days  1")).toEqual({ days: 1, kinds: true })
  })
  it("rejects every invalid option class with null (the caller prints the usage line)", () => {
    for (const bad of [
      "--days", "--days 0", "--days 31", "--days -1", "--days 1.5", "--days 1e1", "--days abc",
      "--days 999999999999999999999", "--days=7", "--kinds true", "--days 1 --days 2", "--kinds --kinds",
      "--week 3", "--Kinds", "--days 1 extra", "foo", "7",
    ]) expect(parseStatsOptions(bad)).toBeNull()
  })
  it("tool input: undefined and {} keep defaults; valid values pass; every wrong shape resolves to null", () => {
    expect(parseStatsToolInput(undefined)).toEqual({ days: 30, kinds: false })
    expect(parseStatsToolInput({})).toEqual({ days: 30, kinds: false })
    expect(parseStatsToolInput({ days: 1 })).toEqual({ days: 1, kinds: false })
    expect(parseStatsToolInput({ days: 30, kinds: true })).toEqual({ days: 30, kinds: true })
    expect(parseStatsToolInput({ kinds: true })).toEqual({ days: 30, kinds: true })
    for (const bad of [{ days: "7" }, { days: null }, { days: 0 }, { days: 31 }, { days: 1.5 }, { days: NaN }, { days: Infinity }, { days: -1 }, { kinds: "yes" }, { kinds: 1 }, { days: 1, extra: 2 }, [], null, "x", 7, true])
      expect(parseStatsToolInput(bad)).toBeNull()
  })
})

describe("stats window, kinds and sample median", () => {
  it("uses the exact ts window: inclusive floor and now; 1ms outside either end is excluded", () => {
    const ev = [
      turn(NOW - 2 * DAY, "prov/in", { latencyMs: 100 }),
      turn(NOW, "prov/now", { latencyMs: 200 }),
      turn(NOW - 2 * DAY - 1, "prov/out", { latencyMs: 300 }),
      turn(NOW + 1, "prov/fut", { latencyMs: 400 }),
    ]
    const txt = renderStatsTable(buildStats(ev, NOW, 2), ev)
    expect(txt).toContain("prov/in | 1 | 0 | – | 0 | 0 | 0% | – | 100ms | 0/0 | $0.00 | $0.00")
    expect(txt).toContain("prov/now | 1 | 0 | – | 0 | 0 | 0% | – | 200ms | 0/0 | $0.00 | $0.00")
    expect(txt).not.toContain("prov/out")
    expect(txt).not.toContain("prov/fut")
  })
  it("a same-UTC-day sample just outside the days=1 cutoff is excluded (real statsText path)", () => {
    const d = dir()
    const l = new EventLog(d, true)
    const T = Date.UTC(2026, 9, 26, 12)
    l.append({ ts: T - DAY, sessionID: "s", event: "turn", model: "prov/a", latencyMs: 10 })
    l.append({ ts: T - DAY - 1, sessionID: "s", event: "turn", model: "prov/a", latencyMs: 9999 })
    l.append({ ts: T - 1000, sessionID: "s", event: "turn", model: "prov/a", latencyMs: 20 })
    // T-DAY-1 shares the cutoff edge's UTC day but sits 1ms below the days=1 floor: excluded from
    // buckets and samples alike; the two kept turns are a day apart, so both are censored.
    expect(statsText(l, { days: 1, kinds: false }, T)).toContain("prov/a | 2 | 0 | – | 0 | 0 | 0% | – | 15ms | 0/0 | $0.00 | $0.00")
  })
  it("median covers odd, even, zero and absent samples across models", () => {
    const ev = [
      turn(NOW - DAY, "prov/odd", { latencyMs: 10 }), turn(NOW - DAY, "prov/odd", { latencyMs: 20 }), turn(NOW - DAY, "prov/odd", { latencyMs: 90 }),
      turn(NOW - DAY, "prov/even", { latencyMs: 10 }), turn(NOW - DAY, "prov/even", { latencyMs: 40 }),
      turn(NOW - DAY, "prov/zero", { latencyMs: 0 }),
      turn(NOW - DAY, "prov/none"),
    ]
    const txt = renderStatsTable(buildStats(ev, NOW), ev)
    expect(txt).toContain("prov/odd | 3 | 0 | – | 0 | 0 | 0% | 100% | 20ms | 0/0 | $0.00 | $0.00")
    expect(txt).toContain("prov/even | 2 | 0 | – | 0 | 0 | 0% | 100% | 25ms | 0/0 | $0.00 | $0.00")
    expect(txt).toContain("prov/zero | 1 | 0 | – | 0 | 0 | 0% | – | 0ms | 0/0 | $0.00 | $0.00")
    expect(txt).toContain("prov/none | 1 | 0 | – | 0 | 0 | 0% | – | – | 0/0 | $0.00 | $0.00")
  })
  it("--kinds adds one breakdown line per model in lexicographic kind order; none when failure-free", () => {
    const ev = [
      turn(NOW - DAY, "prov/a"),
      { ts: NOW - DAY, session: S, event: "failure", errorKind: "timeout", model: "prov/a" },
      { ts: NOW - DAY, session: S, event: "failure", errorKind: "quota", model: "prov/a" },
      { ts: NOW - DAY, session: S, event: "failure", errorKind: "quota", model: "prov/a" },
      turn(NOW - DAY, "prov/clean"),
    ] as LedgerEvent[]
    const txt = renderStatsTable(buildStats(ev, NOW), ev, true)
    expect(txt).toContain("prov/a | 1 | 3 | – | 0 | 0 | 0% | – | – | 0/0 | $0.00 | $0.00")
    expect(txt).toContain("prov/a failure kinds: quota 2, timeout 1")
    expect(txt).toContain("prov/clean failure kinds: none")
    expect(renderStatsTable(buildStats(ev, NOW), ev, false).split("\n")).toHaveLength(3) // header + 2 rows, no breakdown
    expect(renderStatsTable(buildStats([], NOW), [], true)).toBe("model | turns | fails | judgeRej | switchAway | downMs | offPrimary | survival | medianLat | tok in/out | cost$ | helper$ | regret")
  })
  it("statsText renders a real ledger's mixed events inside the exact window with costs", () => {
    const d = dir()
    const l = new EventLog(d, true)
    const T = Date.UTC(2026, 9, 26, 12)
    l.append({ ts: T - 5000, sessionID: "s", event: "narrative", model: "prov/b", helperCostUsd: 0.03 })
    l.append({ ts: T - 4000, sessionID: "s", event: "switch", sw: { kind: "rate_limit", from: "prov/a", to: "prov/b" } })
    l.append({ ts: T - 3000, sessionID: "s", event: "judge", model: "prov/a", verdict: "switch", helperCostUsd: 0.02 })
    l.append({ ts: T - 2000, sessionID: "s", event: "failure", model: "prov/a", errorKind: "quota" })
    l.append({ ts: T - 1000, sessionID: "s", event: "turn", model: "prov/a", latencyMs: 100, tokens: { input: 3, output: 4 }, cost: 0.1 })
    l.append({ ts: T - 2 * DAY - 1, sessionID: "s", event: "turn", model: "prov/a", latencyMs: 999 })
    const txt = statsText(l, { days: 2, kinds: true }, T)
    expect(txt).toContain("prov/a | 1 | 1 | 100% | 1 | 0 | 0% | – | 100ms | 3/4 | $0.10 | $0.02")
    expect(txt).toContain("prov/a failure kinds: quota 1")
    expect(txt).toContain("prov/b | 0 | 0 | – | 0 | 0 | 0% | – | – | 0/0 | $0.00 | $0.03")
    expect(txt).toContain("prov/b failure kinds: none")
    expect(statsText(l, { days: 30, kinds: false }, T)).toContain("prov/a | 2 | 1 | 100% | 1 | 0 | 0% | – | 550ms | 3/4 | $0.10 | $0.02")
  })
})

describe("purge refreshes the stats snapshot", () => {
  it("rebuilds an empty version-1 snapshot immediately and keeps the file-count feedback", () => {
    const d = dir()
    const l = new EventLog(d, true)
    const T = Date.UTC(2026, 9, 26, 12)
    expect(l.append({ ts: T - 1000, sessionID: "s", event: "turn", model: "prov/a" })).toBe(true)
    expect(purgeAndRefreshStats(l, d, T)).toBe("Purged 1 ledger file(s).")
    expect(JSON.parse(fs.readFileSync(path.join(d, "stats.json"), "utf8"))).toEqual({ version: 1, generatedAt: T, models: {} })
  })
  it("a zero-file purge still refreshes the snapshot; a disabled ledger stays best-effort", () => {
    const d = dir()
    const l = new EventLog(d, true)
    expect(purgeAndRefreshStats(l, d, Date.UTC(2026, 9, 26, 12))).toBe("Purged 0 ledger file(s).")
    expect(JSON.parse(fs.readFileSync(path.join(d, "stats.json"), "utf8"))).toMatchObject({ version: 1, models: {} })
    const off = new EventLog(d, false)
    expect(purgeAndRefreshStats(off, d, Date.UTC(2026, 9, 26, 12))).toBe("Purged 0 ledger file(s).")
  })
  it("a purge whose deletion fails reflects the remaining rows instead of inventing an empty snapshot", () => {
    const d = dir()
    const l = new EventLog(d, true)
    const T = Date.UTC(2026, 9, 26, 12)
    l.append({ ts: T - 1000, sessionID: "s", event: "turn", model: "prov/a" })
    const spy = vi.spyOn(fs, "rmSync").mockImplementation(() => { throw new Error("locked") })
    try {
      expect(purgeAndRefreshStats(l, d, T)).toBe("Purged 0 ledger file(s).") // existing best-effort file count
      expect(JSON.parse(fs.readFileSync(path.join(d, "stats.json"), "utf8")).models["prov/a"]).toBeTruthy()
    } finally { spy.mockRestore() }
  })
  it.each([4401, 4402, 4403])("retains readable events in the purge snapshot when file %i cannot be read", (unreadablePid) => {
    const d = dir()
    const T = Date.UTC(2026, 9, 26, 12)
    const pids = [4401, 4402, 4403]
    const l = new EventLog(d, true)
    for (const pid of pids) {
      expect(new EventLog(d, true, pid).append({ ts: T - pid, sessionID: "s", event: "turn", model: `prov/${pid}`, cost: 0.2 })).toBe(true)
    }
    expect(writeStats(buildStats(l.read(30, T), T), d)).toBe(true)
    const readFile = fs.readFileSync
    const removeSpy = vi.spyOn(fs, "rmSync").mockImplementation(() => { throw new Error("locked") })
    const readSpy = vi.spyOn(fs, "readFileSync").mockImplementation((file, options) => {
      if (file === path.join(d, `events-${unreadablePid}.jsonl`)) throw new Error("unreadable")
      return readFile(file, options)
    })
    try {
      expect(purgeAndRefreshStats(l, d, T)).toBe("Purged 0 ledger file(s).")
      const expectedEvents = pids.filter((pid) => pid !== unreadablePid)
        .map((pid) => turn(T - pid, `prov/${pid}`, { cost: 0.2 }))
      expect(JSON.parse(readFile(path.join(d, "stats.json"), "utf8"))).toEqual(buildStats(expectedEvents, T))
    } finally { readSpy.mockRestore(); removeSpy.mockRestore() }
  })
  it("a failed snapshot write preserves the prior stats.json and adds only the fixed sanitized warning", () => {
    const d = dir()
    const l = new EventLog(d, true)
    const T = Date.UTC(2026, 9, 26, 12)
    l.append({ ts: T - 1000, sessionID: "s", event: "turn", model: "prov/a" })
    expect(writeStats(buildStats(l.read(30, T), T), d)).toBe(true)
    const before = fs.readFileSync(path.join(d, "stats.json"), "utf8")
    const spy = vi.spyOn(fs, "renameSync").mockImplementation(() => { throw new Error("E_PERM secret /C:/users/path") })
    try {
      expect(purgeAndRefreshStats(l, d, T)).toBe(`Purged 1 ledger file(s). ${STATS_REFRESH_WARNING}`)
    } finally { spy.mockRestore() }
    expect(fs.readFileSync(path.join(d, "stats.json"), "utf8")).toBe(before) // prior valid destination preserved byte-for-byte
  })
})
