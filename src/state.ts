import fs from "node:fs"
import path from "node:path"

// recoveries: chain-recover returns so far; capped separately because a recovery is not a failure switch.
export interface SessionRecord { sticky?: string; origin?: string; switchCount: number; helperCalls?: number; recoveries?: number; updated: number }

const TTL_MS = 14 * 24 * 3600 * 1000
const MAX_SESSIONS = 500

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v)

function sanitize(v: unknown): SessionRecord | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined
  const r = v as Record<string, unknown>
  if (!isNum(r.switchCount) || !isNum(r.updated)) return undefined
  const out: SessionRecord = { switchCount: r.switchCount, updated: r.updated }
  if (typeof r.sticky === "string") out.sticky = r.sticky
  if (typeof r.origin === "string") out.origin = r.origin
  if (isNum(r.helperCalls) && r.helperCalls >= 0) out.helperCalls = Math.floor(r.helperCalls)
  if (isNum(r.recoveries) && r.recoveries >= 0) out.recoveries = Math.floor(r.recoveries)
  return out
}

export class StateStore {
  // null-prototype so ids like "constructor" / "__proto__" are plain keys
  private sessions: Record<string, SessionRecord> = Object.create(null)
  constructor(private file: string, private now: () => number = Date.now) {}

  load(): void {
    this.sessions = Object.create(null)
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(this.file, "utf8"))
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        const o = raw as { v?: unknown; sessions?: unknown }
        if (o.v === 1 && o.sessions && typeof o.sessions === "object" && !Array.isArray(o.sessions)) {
          for (const [id, rec] of Object.entries(o.sessions)) {
            const clean = sanitize(rec)
            if (clean) this.sessions[id] = clean
          }
        }
      }
    } catch { this.sessions = Object.create(null) }
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
  }

  save(): void {
    // per-process temp name so concurrent instances never clobber each other's temp file
    const tmp = `${this.file}.${process.pid}.tmp`
    try {
      this.prune()
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 })
      fs.writeFileSync(tmp, JSON.stringify({ v: 1, sessions: this.sessions }), { mode: 0o600 })
      fs.renameSync(tmp, this.file)
    } catch {
      /* state is best effort; never affect the session */
      try { fs.rmSync(tmp, { force: true }) } catch { /* ignore */ }
    }
  }
}
