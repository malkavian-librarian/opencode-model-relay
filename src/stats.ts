import fs from "node:fs"
import path from "node:path"
import { z } from "zod"
import type { LedgerEvent } from "./ledger"

const DAY = 864e5
const WINDOW_MS = 30 * DAY
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

/**
 * Per-model UTC daily buckets over the rolling 30 days, derived from metadata-only ledger events.
 * Survival (per turn): the same session's next turn on the same model completes with no effective
 * switch in between, within 30 minutes or 5 turns; when the scan runs out of data instead, the turn
 * is censored and excluded from the survival denominator.
 */
export function buildStats(events: LedgerEvent[], now: number): StatsDoc {
  const floor = now - WINDOW_MS
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
  try {
    const validated = statsSchema.parse(doc)
    const tmp = path.join(dir, `stats.json.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`)
    fs.writeFileSync(tmp, JSON.stringify(validated), { mode: 0o600 })
    fs.renameSync(tmp, path.join(dir, "stats.json"))
    return true
  } catch { return false }
}

/** Zod-validated read; a corrupt, foreign or missing stats.json parses to null (rebuild on next start). */
export function readStats(dir: string): StatsDoc | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, "stats.json"), "utf8"))
    const parsed = statsSchema.safeParse(raw)
    return parsed.success ? parsed.data : null
  } catch { return null }
}

/** The /relay stats table: per-model window totals with derived rates; metadata only. */
export function renderStatsTable(stats: StatsDoc): string {
  const rows: string[] = ["model | turns | fails | judgeRej | switchAway | survival | medianLat | tok in/out | cost$ | helper$"]
  for (const [model, days] of Object.entries(stats.models)) {
    let turns = 0, fails = 0, jc = 0, jr = 0, sw = 0, ok = 0, fail = 0, tokIn = 0, tokOut = 0, cost = 0, helper = 0
    const lats: number[] = []
    for (const b of Object.values(days)) {
      turns += b.turns; jc += b.judgeCalls; jr += b.judgeRejects; sw += b.switchAway
      ok += b.survivalOk; fail += b.survivalFail
      tokIn += b.tokensIn; tokOut += b.tokensOut; cost += b.costUsd; helper += b.helperCostUsd
      fails += Object.values(b.failures).reduce((a, c) => a + c, 0)
      if (b.medianLatencyMs !== undefined) lats.push(b.medianLatencyMs)
    }
    const pct = (n: number, d: number): string => (d > 0 ? `${Math.round((100 * n) / d)}%` : "–")
    const med = lats.length ? `${Math.round(median(lats)!)}ms` : "–"
    rows.push(`${model} | ${turns} | ${fails} | ${pct(jr, jc)} | ${sw} | ${pct(ok, ok + fail)} | ${med} | ${tokIn}/${tokOut} | $${cost.toFixed(2)} | $${helper.toFixed(2)}`)
  }
  return rows.join("\n")
}
