import { createHmac, randomBytes } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { z } from "zod"
import type { FailureKind } from "./types"

const SALT_BYTES = 32

export type SwitchDropReason = "lock_held" | "marker_guard" | "superseded"

/** A failure-switch logs its FailureKind; a judge switch logs "quality"; a dropped switch logs "switch_dropped" with its reason. */
export type SwitchKind = FailureKind | "switch_dropped" | "manual"

const SWITCH_KINDS = [
  "rate_limit", "quota", "auth", "free_tier_403", "server_5xx", "timeout", "model_not_found",
  "overflow", "user_abort", "unknown", "quality", "switch_dropped", "manual",
] as const satisfies readonly SwitchKind[]
const DROP_REASONS = ["lock_held", "marker_guard", "superseded"] as const satisfies readonly SwitchDropReason[]
const MAX_RECENT_ROWS = 10
const MAX_TAIL_BYTES = 64 * 1024
const MODEL_REF_MAX_CHARS = 120
const MODEL_REF = /^[A-Za-z0-9._:-]+(?:\/[A-Za-z0-9._:-]+)+$/
const OMITTED_MODEL_REF = `unknown/${"x".repeat(112)}`
const RETENTION_MS = 30 * 864e5

/** One schema is the single validation source for both ledger boundaries (append and read), so the two paths cannot drift. */
const switchRowSchema = z.object({
  ts: z.number().finite().nonnegative(),
  session: z.string().regex(/^[0-9a-f]{16}$/),
  from: z.string().regex(MODEL_REF).max(MODEL_REF_MAX_CHARS).optional(),
  to: z.string().regex(MODEL_REF).max(MODEL_REF_MAX_CHARS).optional(),
  kind: z.enum(SWITCH_KINDS),
  reason: z.enum(DROP_REASONS).optional(),
  elapsedMs: z.number().finite().nonnegative(),
  helperCostUsd: z.number().finite().nonnegative().optional(),
}).refine((row) => (row.kind === "switch_dropped") === (row.reason !== undefined), { message: "switch_dropped requires a reason" })

export type SwitchLogRow = z.infer<typeof switchRowSchema>

/** One parse path for compaction: the shared schema, so retained rows cannot drift from recent()'s validation. */
const parseSwitchRow = (line: string): SwitchLogRow | undefined => {
  try {
    const parsed = switchRowSchema.safeParse(JSON.parse(line))
    return parsed.success ? parsed.data : undefined
  } catch { return undefined }
}

function readSalt(f: string): Buffer | null {
  try {
    const txt = fs.readFileSync(f, "utf8").trim()
    if (!/^[0-9a-fA-F]+$/.test(txt)) return null
    const b = Buffer.from(txt, "hex")
    return b.length === SALT_BYTES ? b : null
  } catch {
    return null
  }
}

function defaultSleep(ms: number): void {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) } catch { /* no-op */ }
}

export class SwitchLog {
  private salt: Buffer | null = null
  constructor(private dir: string, private enabled: boolean, private sleep: (ms: number) => void = defaultSleep) {}

  private getSalt(): Buffer {
    if (this.salt) return this.salt
    const f = path.join(this.dir, "salt")
    const existing = readSalt(f)
    if (existing) return (this.salt = existing)

    // A file that exists but is invalid may be mid-creation by a racing instance: retry before overwriting.
    if (fs.existsSync(f)) {
      for (let i = 0; i < 3; i++) {
        this.sleep(15)
        const again = readSalt(f)
        if (again) return (this.salt = again)
      }
    }
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    const fresh = randomBytes(SALT_BYTES)
    try {
      // "wx": exclusive create, so two racing instances cannot both win.
      fs.writeFileSync(f, fresh.toString("hex"), { mode: 0o600, flag: "wx" })
    } catch {
      // Exists: either a racing writer (read back below) or a corrupt/short file (overwrite).
      const raced = readSalt(f)
      if (raced) return (this.salt = raced)
      try { fs.writeFileSync(f, fresh.toString("hex"), { mode: 0o600 }) } catch { /* use in-memory salt */ }
    }
    // Read back so a concurrent writer's value wins consistently; fall back to ours.
    this.salt = readSalt(f) ?? fresh
    return this.salt
  }

  /** Retention: while the file's oldest row is inside the 30-day window no rewrite happens; once it ages out, out-of-window rows and malformed lines are dropped in one atomic rewrite. Never throws. */
  private compactTo(ts: number): void {
    // Earlier of wall clock and the incoming row, so a skewed future ts cannot age out fresh rows.
    const now = Math.min(Date.now(), ts)
    const active = path.join(this.dir, "switches.jsonl")
    let text: string
    try { text = fs.readFileSync(active, "utf8") } catch { return }
    const lines = text.split("\n").filter(Boolean)
    if (lines.length === 0) return
    // Anchor on the oldest row, like EventLog.rotateTo's first-row month gate, so appends never churn the file.
    const anchor = parseSwitchRow(lines[0]!)
    if (anchor && anchor.ts >= now - RETENTION_MS) return
    const floor = now - RETENTION_MS
    const kept = lines.filter((line) => { const row = parseSwitchRow(line); return row !== undefined && row.ts >= floor })
    const tmp = path.join(this.dir, `switches.jsonl.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`)
    try {
      fs.writeFileSync(tmp, kept.length > 0 ? kept.join("\n") + "\n" : "", { mode: 0o600 })
      fs.renameSync(tmp, active)
    } catch { try { fs.unlinkSync(tmp) } catch { /* temp already gone */ } }
  }

  /** Appends metadata with an HMAC session ID and finite non-negative duration; ledger failures never escape. */
  append(r: { ts: number; sessionID: string; from?: string; to?: string; kind: SwitchKind; reason?: SwitchDropReason; elapsedMs?: number; helperCostUsd?: number }): void {
    if (!this.enabled) return
    try {
      const session = createHmac("sha256", this.getSalt()).update(r.sessionID).digest("hex").slice(0, 16)
      // Over-long or malformed refs become the fixed unknown reference so no single row can exceed the bounded read window.
      const row = {
        ts: r.ts, session, kind: r.kind,
        ...(r.from !== undefined ? { from: MODEL_REF.test(r.from) && r.from.length <= MODEL_REF_MAX_CHARS ? r.from : OMITTED_MODEL_REF } : {}),
        ...(r.to !== undefined ? { to: MODEL_REF.test(r.to) && r.to.length <= MODEL_REF_MAX_CHARS ? r.to : OMITTED_MODEL_REF } : {}),
        ...(r.reason !== undefined ? { reason: r.reason } : {}),
        elapsedMs: r.elapsedMs ?? 0,
        ...(r.helperCostUsd !== undefined ? { helperCostUsd: r.helperCostUsd } : {}),
      }
      if (!switchRowSchema.safeParse(row).success) return
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 })
      this.compactTo(row.ts)
      fs.appendFileSync(path.join(this.dir, "switches.jsonl"), JSON.stringify(row) + "\n", { mode: 0o600 })
    } catch { /* logging is best effort */ }
  }

  /** Reads bounded, validated metadata for the status dashboard; untrusted rows never pass through raw. */
  recent(limit = 10): SwitchLogRow[] {
    if (!this.enabled || limit <= 0) return []
    const count = Math.min(MAX_RECENT_ROWS, Math.floor(limit))
    if (count <= 0) return []
    try {
      const file = path.join(this.dir, "switches.jsonl")
      const size = fs.statSync(file).size
      const length = Math.min(size, MAX_TAIL_BYTES)
      const buffer = Buffer.alloc(length)
      const fd = fs.openSync(file, "r")
      try { fs.readSync(fd, buffer, 0, length, size - length) } finally { fs.closeSync(fd) }
      const text = buffer.toString("utf8")
      const lines = (size > length ? text.slice(text.indexOf("\n") + 1) : text).split("\n").filter(Boolean)
      const out: SwitchLogRow[] = []
      for (let i = lines.length - 1; i >= 0 && out.length < count; i--) {
        const line = lines[i]
        if (line === undefined) continue
        let raw: unknown
        try { raw = JSON.parse(line) } catch { continue }
        const parsed = switchRowSchema.safeParse(raw)
        if (!parsed.success) continue
        out.push(parsed.data)
      }
      return out.reverse()
    } catch { return [] }
  }
}

/** Both /relay purge surfaces (relay_purge tool and /relay purge command) clear the switch log; never throws. */
export function clearSwitchLog(dir: string): void {
  try { fs.rmSync(path.join(dir, "switches.jsonl"), { force: true }) } catch { /* absent or FS refused */ }
}
