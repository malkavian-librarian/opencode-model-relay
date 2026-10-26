import fs from "node:fs"
import path from "node:path"
import { MAX_COOLDOWN_MS, type ModelHealth } from "./strategy"

// pluginPinned: the model the plugin itself last set (failover target or adopted pick); the marker guard and
// adoption anchor on it (#66). adoptedAt opens the grace window in which a failing pick is not re-marked.
// quarantine: per-session recent-failure map (model -> last failure at) riding the record (#64/#66).
// pendingHandover: crash-window intent persisted before switchModel; deliberately discarded on load.
// judgeCalls/lastJudgeAt: quality-judge usage counters; both persist so the caps survive a restart (#26).
export interface SessionRecord {
  pluginPinned?: string
  adoptedAt?: number
  quarantine?: Record<string, number>
  pendingHandover?: { to: string; at: number }
  circularOrigin?: string
  circularTransitions?: number
  circularFlows?: number
  switchCount: number
  helperCalls?: number
  judgeCalls?: number
  lastJudgeAt?: number
  lastJudgeMessageId?: string
  updated: number
}

/** Global per-day judge budget, keyed by UTC date so it resets itself at midnight. */
export interface JudgeDaily { date?: string; calls?: number; costUsd?: number }
export interface FindCacheEntry { model: string; resolvedAt: number }

const TTL_MS = 14 * 24 * 3600 * 1000
const MAX_SESSIONS = 500
// Model health survives restarts: a permanent failure expires after 24 h (or a successful turn on that
// model, see controller.onSessionIdle); cooldowns expire by their own timestamp.
const MAX_HEALTH = 200
const PERMANENT_TTL_MS = 24 * 3600 * 1000
export const FIND_CACHE_TTL_MS = 60 * 60 * 1000
const MAX_FIND_CACHE = 64

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v)

// Model keys are "provider/model" ids from config or OpenCode's own provider list; never transcript text.
function isModelKey(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= 256 && !/[\u0000-\u001f\u007f\u0080-\u009f]/.test(v)
}

function isDiscoveredModel(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= 128 && /^[A-Za-z0-9._:-]+(?:\/[A-Za-z0-9._:-]+)*$/.test(v)
}

// A hostile quarantine map is bounded: entries beyond MAX_QUARANTINE_MODELS are dropped at load.
const MAX_QUARANTINE_MODELS = 64

function sanitizeQuarantine(raw: unknown): Record<string, number> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
  const out: Record<string, number> = Object.create(null)
  let kept = 0
  for (const [model, at] of Object.entries(raw)) {
    if (kept >= MAX_QUARANTINE_MODELS) break
    if (!isModelKey(model) || !isNum(at) || at < 0) continue
    out[model] = at
    kept++
  }
  return kept > 0 ? out : undefined
}

function sanitize(v: unknown): SessionRecord | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined
  const r = v as Record<string, unknown>
  if (!isNum(r.switchCount) || !isNum(r.updated)) return undefined
  const out: SessionRecord = { switchCount: r.switchCount, updated: r.updated }
  if (isModelKey(r.pluginPinned)) out.pluginPinned = r.pluginPinned
  if (isModelKey(r.circularOrigin)) out.circularOrigin = r.circularOrigin
  if (isNum(r.circularTransitions) && Number.isInteger(r.circularTransitions) && r.circularTransitions >= 0 && r.circularTransitions <= 64) out.circularTransitions = r.circularTransitions
  if (isNum(r.circularFlows) && Number.isInteger(r.circularFlows) && r.circularFlows >= 0 && r.circularFlows <= 3) out.circularFlows = r.circularFlows
  if (isNum(r.adoptedAt) && r.adoptedAt >= 0) out.adoptedAt = Math.floor(r.adoptedAt)
  const quarantine = sanitizeQuarantine(r.quarantine)
  if (quarantine) out.quarantine = quarantine
  // pendingHandover is never copied: a reload discards the crash-window intent (AC-04) and the
  // next context hook re-syncs to whatever the session actually runs.
  if (isNum(r.helperCalls) && r.helperCalls >= 0) out.helperCalls = Math.floor(r.helperCalls)
  if (isNum(r.judgeCalls) && r.judgeCalls >= 0) out.judgeCalls = Math.floor(r.judgeCalls)
  if (isNum(r.lastJudgeAt) && r.lastJudgeAt >= 0) out.lastJudgeAt = Math.floor(r.lastJudgeAt)
  if (typeof r.lastJudgeMessageId === "string" && r.lastJudgeMessageId.length <= 200) {
    out.lastJudgeMessageId = r.lastJudgeMessageId
  }
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

function sanitizeFindCache(raw: unknown, now: number): Record<string, FindCacheEntry> {
  const out: Record<string, FindCacheEntry> = Object.create(null)
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out
  for (const [key, value] of Object.entries(raw).slice(0, MAX_FIND_CACHE)) {
    if (key.length > 512 || !value || typeof value !== "object" || Array.isArray(value)) continue
    const r = value as Record<string, unknown>
    if (isDiscoveredModel(r.model) && isNum(r.resolvedAt) && r.resolvedAt >= 0 && r.resolvedAt <= now && now - r.resolvedAt <= FIND_CACHE_TTL_MS) {
      out[key] = { model: r.model, resolvedAt: Math.floor(r.resolvedAt) }
    }
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
  readonly findCache: Record<string, FindCacheEntry> = Object.create(null)
  constructor(private file: string, private now: () => number = Date.now) {}

  load(): void {
    this.sessions = Object.create(null)
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(this.file, "utf8"))
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        const o = raw as { v?: unknown; sessions?: unknown; health?: unknown; judgeDaily?: unknown; findCache?: unknown }
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
        for (const k of Object.keys(this.findCache)) delete this.findCache[k]
        Object.assign(this.findCache, sanitizeFindCache(o.findCache, this.now()))
      }
    } catch {
      this.sessions = Object.create(null)
      for (const k of Object.keys(this.health)) delete this.health[k]
      for (const k of Object.keys(this.judgeDaily) as (keyof JudgeDaily)[]) delete this.judgeDaily[k]
      for (const k of Object.keys(this.findCache)) delete this.findCache[k]
    }
    this.prune()
  }

  get(id: string): SessionRecord {
    return this.sessions[id] ?? { switchCount: 0, updated: 0 }
  }
  set(id: string, r: SessionRecord): void { this.sessions[id] = r }

  getFindCache(key: string, now = this.now()): string | undefined {
    const entry = this.findCache[key]
    if (!entry || entry.resolvedAt > now || now - entry.resolvedAt > FIND_CACHE_TTL_MS || !isDiscoveredModel(entry.model)) {
      delete this.findCache[key]
      return undefined
    }
    return entry.model
  }

  setFindCache(key: string, model: string, resolvedAt = this.now()): void {
    if (key.length > 512 || !isDiscoveredModel(model) || !isNum(resolvedAt) || resolvedAt < 0) return
    if (this.findCache[key] === undefined && Object.keys(this.findCache).length >= MAX_FIND_CACHE) delete this.findCache[Object.keys(this.findCache)[0] as string]
    this.findCache[key] = { model, resolvedAt: Math.floor(resolvedAt) }
  }

  invalidateFindCache(key: string): void { delete this.findCache[key] }

  /** Drops persisted pluginPinned values that no longer resolve to a configured level (config change or hostile file). */
  validatePinned(known: ReadonlySet<string>): void {
    for (const r of Object.values(this.sessions)) {
      if (r.pluginPinned !== undefined && !known.has(r.pluginPinned)) delete r.pluginPinned
    }
  }

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
      fs.writeFileSync(tmp, JSON.stringify({ v: 1, sessions: this.sessions, health: this.health, judgeDaily: this.judgeDaily, findCache: this.findCache }), { mode: 0o600 })
      fs.renameSync(tmp, this.file)
    } catch {
      /* state is best effort; never affect the session */
      try { fs.rmSync(tmp, { force: true }) } catch { /* ignore */ }
    }
  }
}
