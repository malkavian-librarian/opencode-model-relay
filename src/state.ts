import fs from "node:fs"
import path from "node:path"
import { MAX_COOLDOWN_MS, type ModelHealth } from "./strategy"

// recoveries: chain-recover returns so far; capped separately because a recovery is not a failure switch.
// lastPin: the model the TUI kept sending after a re-pin (see decidePin); not the chain anchor.
// judgeCalls/lastJudgeAt: quality-judge usage counters; both persist so the caps survive a restart (#26).
export interface SessionRecord { sticky?: string; origin?: string; switchCount: number; helperCalls?: number; recoveries?: number; lastPin?: string; judgeCalls?: number; lastJudgeAt?: number; updated: number }

/** Global per-day judge budget, keyed by UTC date so it resets itself at midnight. */
export interface JudgeDaily { date?: string; calls?: number; costUsd?: number }

const TTL_MS = 14 * 24 * 3600 * 1000
const MAX_SESSIONS = 500
// Model health survives restarts: a permanent failure expires after 24 h (or a successful turn on that
// model, see controller.onSessionIdle); cooldowns expire by their own timestamp.
const MAX_HEALTH = 200
const PERMANENT_TTL_MS = 24 * 3600 * 1000

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v)

// Model keys are "provider/model" ids from config or OpenCode's own provider list; never transcript text.
function isModelKey(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= 256 && !/[\u0000-\u001f\u007f\u0080-\u009f]/.test(v)
}

function sanitize(v: unknown): SessionRecord | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined
  const r = v as Record<string, unknown>
  if (!isNum(r.switchCount) || !isNum(r.updated)) return undefined
  const out: SessionRecord = { switchCount: r.switchCount, updated: r.updated }
  if (typeof r.sticky === "string") out.sticky = r.sticky
  if (typeof r.origin === "string") out.origin = r.origin
  if (typeof r.lastPin === "string") out.lastPin = r.lastPin
  if (isNum(r.helperCalls) && r.helperCalls >= 0) out.helperCalls = Math.floor(r.helperCalls)
  if (isNum(r.recoveries) && r.recoveries >= 0) out.recoveries = Math.floor(r.recoveries)
  if (isNum(r.judgeCalls) && r.judgeCalls >= 0) out.judgeCalls = Math.floor(r.judgeCalls)
  if (isNum(r.lastJudgeAt) && r.lastJudgeAt >= 0) out.lastJudgeAt = Math.floor(r.lastJudgeAt)
  return out
}

/** Hostile judge-daily section: only the rebuildable counters are kept, anything else is dropped. */
export function sanitizeJudgeDaily(raw: unknown): JudgeDaily {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}
  const r = raw as Record<string, unknown>
  const out: JudgeDaily = {}
  if (typeof r.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.date)) out.date = r.date
  if (isNum(r.calls) && r.calls >= 0) out.calls = Math.floor(r.calls)
  if (isNum(r.costUsd) && r.costUsd >= 0) out.costUsd = Math.min(r.costUsd, 1e6)
  return out
}

/** Drops dead entries: expired cooldowns (no permanent), permanent failures older than 24 h. */
function sanitizeHealth(raw: unknown, now: number): Record<string, ModelHealth> {
  const out: Record<string, ModelHealth> = Object.create(null)
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out
  let read = 0
  for (const [model, h] of Object.entries(raw)) {
    if (read >= MAX_HEALTH) break
    if (!isModelKey(model) || !h || typeof h !== "object" || Array.isArray(h)) continue
    const r = h as Record<string, unknown>
    const clean: ModelHealth = Object.create(null)
    if (r.cooldownUntil !== undefined) {
      if (!isNum(r.cooldownUntil)) continue
      // Clamp a hostile far-future cooldown to the runtime cap (MAX_COOLDOWN_MS): a poisoned file must not
      // be able to keep a model unhealthy longer than a real failure could.
      clean.cooldownUntil = Math.min(r.cooldownUntil, now + MAX_COOLDOWN_MS)
    }
    if (r.permanent === true) {
      // A permanent entry without a timestamp is not dateable: drop it; the next failure re-marks it.
      // A stamp in the future is equally not trustable: drop it so the model is not blacklisted forever.
      if (!isNum(r.permanentAt) || r.permanentAt > now || now - r.permanentAt > PERMANENT_TTL_MS) continue
      clean.permanent = true
      clean.permanentAt = r.permanentAt
    } else if (r.permanent !== undefined) { continue }
    if (r.failures !== undefined) {
      if (!isNum(r.failures) || r.failures < 0) continue
      clean.failures = Math.floor(r.failures)
    }
    if (clean.cooldownUntil === undefined && clean.permanent === undefined && clean.failures === undefined) continue
    out[model] = clean
    read++
  }
  return out
}

export class StateStore {
  // null-prototype so ids like "constructor" / "__proto__" are plain keys
  private sessions: Record<string, SessionRecord> = Object.create(null)
  // The controller (and strategy) mutate this map in place; save() persists it.
  readonly health: Record<string, ModelHealth> = Object.create(null)
  // Global judge budget of the current UTC day; the controller writes, this class owns persistence.
  readonly judgeDaily: JudgeDaily = Object.create(null)
  constructor(private file: string, private now: () => number = Date.now) {}

  load(): void {
    this.sessions = Object.create(null)
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(this.file, "utf8"))
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        const o = raw as { v?: unknown; sessions?: unknown; health?: unknown; judgeDaily?: unknown }
        if (o.v === 1 && o.sessions && typeof o.sessions === "object" && !Array.isArray(o.sessions)) {
          for (const [id, rec] of Object.entries(o.sessions)) {
            const clean = sanitize(rec)
            if (clean) this.sessions[id] = clean
          }
        }
        const loadedHealth = sanitizeHealth(o.health, this.now())
        for (const k of Object.keys(this.health)) delete this.health[k]
        Object.assign(this.health, loadedHealth)
        Object.assign(this.judgeDaily, sanitizeJudgeDaily(o.judgeDaily))
      }
    } catch {
      this.sessions = Object.create(null)
      for (const k of Object.keys(this.health)) delete this.health[k]
      for (const k of Object.keys(this.judgeDaily) as (keyof JudgeDaily)[]) delete this.judgeDaily[k]
    }
    this.prune()
  }

  get(id: string): SessionRecord {
    return this.sessions[id] ?? { switchCount: 0, updated: 0 }
  }
  set(id: string, r: SessionRecord): void { this.sessions[id] = r }

  private prune(): void {
    const t = this.now()
    for (const [id, r] of Object.entries(this.sessions)) if (t - r.updated > TTL_MS) delete this.sessions[id]
    const entries = Object.entries(this.sessions)
    if (entries.length > MAX_SESSIONS) {
      entries.sort((a, b) => b[1].updated - a[1].updated)
      const kept: Record<string, SessionRecord> = Object.create(null)
      for (const [id, r] of entries.slice(0, MAX_SESSIONS)) kept[id] = r
      this.sessions = kept
    }
    for (const [model, h] of Object.entries(this.health)) {
      const cooldownLive = h.cooldownUntil !== undefined && h.cooldownUntil > t
      const permanentLive = h.permanent === true && h.permanentAt !== undefined && t - h.permanentAt <= PERMANENT_TTL_MS
      if (!cooldownLive && !permanentLive) delete this.health[model]
    }
    const healthEntries = Object.entries(this.health)
    if (healthEntries.length > MAX_HEALTH) {
      const kept: Record<string, ModelHealth> = Object.create(null)
      for (const [model, h] of healthEntries.slice(0, MAX_HEALTH)) kept[model] = h
      for (const model of Object.keys(this.health)) if (kept[model] === undefined) delete this.health[model]
    }
  }

  save(): void {
    // per-process temp name so concurrent instances never clobber each other's temp file
    const tmp = `${this.file}.${process.pid}.tmp`
    try {
      this.prune()
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 })
      fs.writeFileSync(tmp, JSON.stringify({ v: 1, sessions: this.sessions, health: this.health, judgeDaily: this.judgeDaily }), { mode: 0o600 })
      fs.renameSync(tmp, this.file)
    } catch {
      /* state is best effort; never affect the session */
      try { fs.rmSync(tmp, { force: true }) } catch { /* ignore */ }
    }
  }
}
