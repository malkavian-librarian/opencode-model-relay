import fs from "node:fs"
import path from "node:path"
import { z } from "zod"
import type { EventLog, LedgerEvent } from "./ledger"

const DAY = 864e5
const MIN_STATS_DAYS = 1
const MAX_STATS_DAYS = 30
const DEFAULT_STATS_DAYS = MAX_STATS_DAYS
const SURVIVAL_WINDOW_MS = 30 * 60 * 1000
const SURVIVAL_MAX_TURNS = 5

export const bucketSchema = z.object({
  turns: z.number().int().nonnegative(),
  failures: z.record(z.number().int().nonnegative()),
  judgeCalls: z.number().int().nonnegative(),
  judgeRejects: z.number().int().nonnegative(),
  switchAway: z.number().int().nonnegative(),
  survivalOk: z.number().int().nonnegative(),
  survivalFail: z.number().int().nonnegative(),
  survivalCensored: z.number().int().nonnegative(),
  medianLatencyMs: z.number().finite().nonnegative().optional(),
  tokensIn: z.number().int().nonnegative(),
  tokensOut: z.number().int().nonnegative(),
  costUsd: z.number().finite().nonnegative(),
  helperCostUsd: z.number().finite().nonnegative(),
})

const statsSchema = z.object({
  version: z.literal(1),
  generatedAt: z.number().finite().nonnegative(),
  models: z.record(z.record(bucketSchema)),
})

export type StatsBucket = z.infer<typeof bucketSchema>
export type StatsDoc = z.infer<typeof statsSchema>

const emptyBucket = (): StatsBucket => ({
  turns: 0, failures: {}, judgeCalls: 0, judgeRejects: 0, switchAway: 0,
  survivalOk: 0, survivalFail: 0, survivalCensored: 0,
  tokensIn: 0, tokensOut: 0, costUsd: 0, helperCostUsd: 0,
})

const bkey = (model: string, ts: number): string => `${model}|${new Date(ts).toISOString().slice(0, 10)}`

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined
  const s = [...values].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 1 ? s[mid]! : (s[mid! - 1]! + s[mid]!) / 2
}

/** A validated stats request shared by the /relay stats command and the relay_stats tool. */
export interface StatsQuery { days: number; kinds: boolean }

export const STATS_USAGE = "Usage: /relay stats [--days N] [--kinds]"
export const STATS_REFRESH_WARNING = "Warning: the stats snapshot could not be refreshed."

/** JSON Schema the host advertises for the relay_stats tool; runtime validation is the zod schema below. */
export const STATS_TOOL_INPUT = {
  type: "object",
  properties: {
    days: { type: "integer", minimum: MIN_STATS_DAYS, maximum: MAX_STATS_DAYS },
    kinds: { type: "boolean" },
  },
  additionalProperties: false,
}

const statsToolQuery = z.object({
  days: z.number().int().min(MIN_STATS_DAYS).max(MAX_STATS_DAYS).optional(),
  kinds: z.boolean().optional(),
}).strict()

/** Option tokens after the `stats` subcommand; null means the caller prints STATS_USAGE instead of a table. */
export function parseStatsOptions(text: string): StatsQuery | null {
  const tokens = text.trim().split(/\s+/).filter((t) => t !== "")
  let days = DEFAULT_STATS_DAYS
  let kinds = false
  let daysSeen = false
  let kindsSeen = false
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!
    if (t === "--kinds") {
      if (kindsSeen) return null
      kinds = true; kindsSeen = true
    } else if (t === "--days") {
      if (daysSeen) return null
      const value = tokens[++i]
      if (value === undefined || !/^[0-9]+$/.test(value)) return null
      const n = Number(value)
      if (n < MIN_STATS_DAYS || n > MAX_STATS_DAYS) return null
      days = n; daysSeen = true
    } else return null // unknown flag, --days=7, a value after --kinds, or a stray positional
  }
  return { days, kinds }
}

/** Tool input to a stats query: undefined keeps defaults; anything invalid is null (usage), never a throw. */
export function parseStatsToolInput(input: unknown): StatsQuery | null {
  if (input === undefined) return { days: DEFAULT_STATS_DAYS, kinds: false }
  if (input === null || typeof input !== "object" || Array.isArray(input)) return null
  const parsed = statsToolQuery.safeParse(input)
  return parsed.success ? { days: parsed.data.days ?? DEFAULT_STATS_DAYS, kinds: parsed.data.kinds ?? false } : null
}

/**
 * Per-model UTC daily buckets over the rolling window (default 30 days), derived from metadata-only ledger events.
 * Survival (per turn): the same session's next turn on the same model completes with no effective
 * switch in between, within 30 minutes or 5 turns; when the scan runs out of data instead, the turn
 * is censored and excluded from the survival denominator.
 */
export function buildStats(events: LedgerEvent[], now: number, days = DEFAULT_STATS_DAYS): StatsDoc {
  const floor = now - days * DAY
  const pruned = events.filter((e) => e.ts >= floor && e.ts <= now)
  const bySession = new Map<string, LedgerEvent[]>()
  for (const e of pruned) {
    const a = bySession.get(e.session) ?? []
    a.push(e)
    bySession.set(e.session, a)
  }
  for (const a of bySession.values()) a.sort((x, y) => x.ts - y.ts)

  const models: StatsDoc["models"] = {}
  const bucketFor = (model: string, ts: number): StatsBucket => {
    const k = bkey(model, ts)
    const i = k.indexOf("|")
    const perModel = (models[k.slice(0, i)!] ??= {})
    return (perModel[k.slice(i + 1)!] ??= emptyBucket())
  }

  for (const e of pruned) {
    // Switches are attributed to the model they left (sw.from); everything else to its model field.
    const model = e.event === "switch" ? e.sw?.from : e.model
    if (model === undefined) continue
    const b = bucketFor(model, e.ts)
    if (e.event === "turn") {
      b.turns++
      if (e.tokens) { b.tokensIn += e.tokens.input; b.tokensOut += e.tokens.output }
      if (e.cost !== undefined) b.costUsd += e.cost
    } else if (e.event === "failure" && e.errorKind) {
      b.failures[e.errorKind] = (b.failures[e.errorKind] ?? 0) + 1
    } else if (e.event === "judge") {
      b.judgeCalls++
      if (e.verdict === "switch") b.judgeRejects++
    } else if (e.event === "switch" && e.sw && e.sw.kind !== "manual" && e.sw.kind !== "switch_dropped") {
      b.switchAway++ // an effective auto switch IS the model being switched away from
    }
    if ((e.event === "judge" || e.event === "narrative") && e.helperCostUsd !== undefined) b.helperCostUsd += e.helperCostUsd
  }

  // Median latency per bucket from the turn samples in it.
  const latency = new Map<string, number[]>()
  for (const e of pruned) {
    if (e.event !== "turn" || e.latencyMs === undefined || e.model === undefined) continue
    const k = bkey(e.model, e.ts)
    ;(latency.get(k) ?? latency.set(k, []).get(k)!).push(e.latencyMs)
  }
  for (const [k, samples] of latency) {
    const i = k.indexOf("|")
    const b = models[k.slice(0, i)!]?.[k.slice(i + 1)!]
    if (b && samples.length) b.medianLatencyMs = median(samples)
  }

  // Survival scan per turn event.
  for (const [session, seq] of bySession) {
    void session
    for (let i = 0; i < seq.length; i++) {
      const t = seq[i]!
      if (t.event !== "turn" || t.model === undefined) continue
      const b = bucketFor(t.model, t.ts)
      let counted = false
      let turnsAfter = 0
      for (let j = i + 1; j < seq.length; j++) {
        const e = seq[j]!
        if (e.ts > t.ts + SURVIVAL_WINDOW_MS) break
        if (e.event === "switch" && e.sw && e.sw.kind !== "switch_dropped" && e.sw.from === t.model) {
          b.survivalFail++; counted = true; break
        }
        if (e.event !== "turn") continue
        if (++turnsAfter > SURVIVAL_MAX_TURNS) break
        if (e.model === t.model) { b.survivalOk++; counted = true; break }
      }
      if (!counted) b.survivalCensored++
    }
  }
  return { version: 1, generatedAt: now, models }
}

/** Atomic temp+rename write inside the ledger dir; returns false instead of throwing when the FS refuses. */
export function writeStats(doc: StatsDoc, dir: string): boolean {
  let tmp: string | undefined
  try {
    const validated = statsSchema.parse(doc)
    tmp = path.join(dir, `stats.json.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`)
    fs.writeFileSync(tmp, JSON.stringify(validated), { mode: 0o600 })
    fs.renameSync(tmp, path.join(dir, "stats.json"))
    return true
  } catch {
    if (tmp) {
      try { fs.rmSync(tmp, { force: true }) } catch { /* cleanup is best effort */ }
    }
    return false
  }
}

/** The stats view for both v2 surfaces: fresh from the metadata-only ledger, one consistent now per request. */
export function statsText(ledger: EventLog, query: StatsQuery, now = Date.now()): string {
  try {
    const events = ledger.read(query.days, now)
    return renderStatsTable(buildStats(events, now, query.days), events, query.kinds)
  } catch { return "Relay stats unavailable (ledger unreadable)." }
}

/** Both purge surfaces: delete the event files, then best-effort rebuild the default 30-day stats.json. */
export function purgeAndRefreshStats(ledger: EventLog, dir: string, now = Date.now()): string {
  const base = `Purged ${ledger.purge()} ledger file(s).`
  return writeStats(buildStats(ledger.read(DEFAULT_STATS_DAYS, now), now), dir) ? base : `${base} ${STATS_REFRESH_WARNING}`
}

/** The /relay stats table: per-model window totals with derived rates; metadata only.
 *  `events` are the same retained-window events `stats` was built from (statsText passes ledger.read's
 *  output): the latency column medians their turn samples directly, never the daily bucket medians. */
export function renderStatsTable(stats: StatsDoc, events: readonly LedgerEvent[], kinds = false): string {
  const rows: string[] = ["model | turns | fails | judgeRej | switchAway | survival | medianLat | tok in/out | cost$ | helper$"]
  const samples = new Map<string, number[]>()
  for (const e of events) {
    if (e.event !== "turn" || e.model === undefined || e.latencyMs === undefined) continue
    ;(samples.get(e.model) ?? samples.set(e.model, []).get(e.model)!).push(e.latencyMs)
  }
  for (const [model, days] of Object.entries(stats.models)) {
    let turns = 0, fails = 0, jc = 0, jr = 0, sw = 0, ok = 0, fail = 0, tokIn = 0, tokOut = 0, cost = 0, helper = 0
    for (const b of Object.values(days)) {
      turns += b.turns; jc += b.judgeCalls; jr += b.judgeRejects; sw += b.switchAway
      ok += b.survivalOk; fail += b.survivalFail
      tokIn += b.tokensIn; tokOut += b.tokensOut; cost += b.costUsd; helper += b.helperCostUsd
      fails += Object.values(b.failures).reduce((a, c) => a + c, 0)
    }
    const pct = (n: number, d: number): string => (d > 0 ? `${Math.round((100 * n) / d)}%` : "–")
    const lats = samples.get(model)
    const med = lats && lats.length ? `${Math.round(median(lats)!)}ms` : "–"
    rows.push(`${model} | ${turns} | ${fails} | ${pct(jr, jc)} | ${sw} | ${pct(ok, ok + fail)} | ${med} | ${tokIn}/${tokOut} | $${cost.toFixed(2)} | $${helper.toFixed(2)}`)
    if (kinds) {
      const counts = new Map<string, number>()
      for (const b of Object.values(days)) for (const [k, c] of Object.entries(b.failures)) counts.set(k, (counts.get(k) ?? 0) + c)
      const listed = [...counts.keys()].sort().map((k) => `${k} ${counts.get(k)}`).join(", ")
      rows.push(`${model} failure kinds: ${listed || "none"}`)
    }
  }
  return rows.join("\n")
}
