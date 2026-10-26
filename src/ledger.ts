import { createHmac, randomBytes } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { z } from "zod"
import type { FailureKind } from "./types"

/** UTC month of a timestamp, as YYYYMM (rotation suffix and window math). */
export function utcMonth(ts: number): string {
  return new Date(ts).toISOString().slice(0, 7).replace("-", "")
}

const SWITCH_KINDS = [
  "rate_limit", "quota", "auth", "free_tier_403", "server_5xx", "timeout", "model_not_found",
  "overflow", "user_abort", "unknown", "quality", "switch_dropped", "manual",
] as const
const DROP_REASONS = ["lock_held", "marker_guard", "superseded"] as const
const EVENT_KINDS = ["turn", "failure", "judge", "switch", "narrative"] as const
const MAX_MODEL_CHARS = 120
const MODEL_REF = /^[A-Za-z0-9._:-]+(?:\/[A-Za-z0-9._:-]+)+$/
const MAX_LINES = 20000

/** "There was a switch" is recorded once per enact/drop/manual, by kind; nothing free-provider-text survives here. */
const swSchema = z.object({
  kind: z.enum(SWITCH_KINDS),
  reason: z.enum(DROP_REASONS).optional(),
  from: z.string().regex(MODEL_REF).max(MAX_MODEL_CHARS).optional(),
  to: z.string().regex(MODEL_REF).max(MAX_MODEL_CHARS).optional(),
}).refine((s) => (s.kind === "switch_dropped") === (s.reason !== undefined), { message: "dropped switches must carry a reason" })

/** One schema is the single validation source for every ledger boundary (append and read), like the switch log. */
export const ledgerEventSchema = z.object({
  ts: z.number().finite().nonnegative(),
  session: z.string().regex(/^[0-9a-f]{16}$/),
  event: z.enum(EVENT_KINDS),
  model: z.string().regex(MODEL_REF).max(MAX_MODEL_CHARS).optional(),
  tier: z.number().int().min(1).optional(),
  latencyMs: z.number().finite().nonnegative().optional(),
  tokens: z.object({ input: z.number().int().nonnegative(), output: z.number().int().nonnegative() }).optional(),
  cost: z.number().finite().nonnegative().optional(),
  errorKind: z.enum(SWITCH_KINDS).optional(),
  verdict: z.enum(["switch", "stay"]).optional(),
  sw: swSchema.optional(),
  helperCostUsd: z.number().finite().nonnegative().optional(),
}).refine((e) => (e.event === "failure") === (e.errorKind !== undefined), { message: "failure events need an errorKind" })
  .refine((e) => (e.event === "judge") === (e.verdict !== undefined), { message: "judge events need a verdict" })
  .refine((e) => (e.event === "switch") === (e.sw !== undefined), { message: "switch events need their sw detail" })
  .refine((e) => e.event !== "narrative" || (e.model !== undefined && e.helperCostUsd !== undefined), { message: "narrative events need model and helperCostUsd" })

export type LedgerEvent = z.infer<typeof ledgerEventSchema>
export type EventInput = Omit<LedgerEvent, "session"> & { sessionID: string }

const SALT_BYTES = 32

function readSalt(f: string): Buffer | null {
  try {
    const txt = fs.readFileSync(f, "utf8").trim()
    if (!/^[0-9a-fA-F]+$/.test(txt)) return null
    const b = Buffer.from(txt, "hex")
    return b.length === SALT_BYTES ? b : null
  } catch { return null }
}

/** Append-only per-turn metadata journal; parses back with the same schema whose discipline it wrote by. */
export class EventLog {
  private salt: Buffer | null = null
  constructor(private dir: string, private enabled: boolean, private pid = process.pid) {}

  /** Same salt file as the switch log (same directory, same format): the HMAC identities line up. */
  private getSalt(): Buffer | null {
    if (this.salt) return this.salt
    const f = path.join(this.dir, "salt")
    const existing = readSalt(f)
    if (existing) return (this.salt = existing)
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 })
      try { fs.writeFileSync(f, randomBytes(SALT_BYTES).toString("hex"), { flag: "wx", mode: 0o600 }) } catch { /* lost a race or FS refused: fall through */ }
      return (this.salt = readSalt(f))
    } catch { return null }
  }

  /** Monthly rotation: appends whose month differs from the active file's first row rotate it to events-<pid>-<YYYYMM>.jsonl. */
  private rotateTo(ts: number): void {
    const active = path.join(this.dir, `events-${this.pid}.jsonl`)
    if (!fs.existsSync(active)) return
    let anchorMonth: string
    try {
      const head = fs.readFileSync(active, { flag: "r" }).toString("utf8").split("\n", 1)[0] ?? ""
      const first = ledgerEventSchema.safeParse(JSON.parse(head))
      if (first.success) anchorMonth = utcMonth(first.data.ts)
      else anchorMonth = utcMonth(fs.statSync(active).mtimeMs)
    } catch { return }
    if (anchorMonth === utcMonth(ts)) return
    const rotated = path.join(this.dir, `events-${this.pid}-${anchorMonth}.jsonl`)
    if (!fs.existsSync(rotated)) fs.renameSync(active, rotated)
  }

  /** Metadata-only append; returns false when disabled, invalid or the FS refuses. Never throws (hooks must not). */
  append(fields: EventInput): boolean {
    if (!this.enabled) return false
    try {
      const salt = this.getSalt() ?? randomBytes(SALT_BYTES)
      this.salt = salt
      const session = createHmac("sha256", salt).update(fields.sessionID).digest("hex").slice(0, 16)
      const row: Record<string, unknown> = { ...fields }
      delete row.sessionID
      row.session = session
      const parsed = ledgerEventSchema.safeParse(row)
      if (!parsed.success) return false
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 })
      this.rotateTo(parsed.data.ts)
      fs.appendFileSync(path.join(this.dir, `events-${this.pid}.jsonl`), JSON.stringify(parsed.data) + "\n", { mode: 0o600 })
      return true
    } catch { return false }
  }

  /** Backward bounded scan of active + rotated files, skipping corrupt lines, windowed to `days`. Never throws. */
  read(days = 30, now = Date.now()): LedgerEvent[] {
    if (!this.enabled) return []
    try {
      const names = fs.readdirSync(this.dir)
        .filter((n) => /^events-\d+.*\.jsonl$/.test(n) || n === `events-${this.pid}.jsonl`)
        .sort((a, b) => monthOf(b).localeCompare(monthOf(a)))
      const floor = now - days * 864e5
      const out: LedgerEvent[] = []
      for (const name of names) {
        if (out.length >= MAX_LINES) break
        const lines = fs.readFileSync(path.join(this.dir, name), "utf8").split("\n")
        for (let i = lines.length - 1; i >= 0 && out.length < MAX_LINES; i--) {
          try {
            const parsed = ledgerEventSchema.safeParse(JSON.parse(lines[i] as string))
            if (parsed.success && parsed.data.ts >= floor && parsed.data.ts <= now) out.push(parsed.data)
          } catch { continue }
        }
      }
      // newest-first per file, oldest month first in list: re-sort ascending by ts for consumers.
      return out.sort((a, b) => a.ts - b.ts)
    } catch { return [] }
  }

  /** Deletes every events-*.jsonl strictly inside the ledger dir; returns how many files it removed. */
  purge(): number {
    try {
      const names = fs.readdirSync(this.dir).filter((n) => /^events-.*\.jsonl$/.test(n))
      for (const n of names) fs.rmSync(path.join(this.dir, n), { force: true })
      return names.length
    } catch { return 0 }
  }
}

function monthOf(name: string): string {
  const m = name.match(/events-\d+-(\d{6})\.jsonl$/)
  return m ? m[1]! : "999999"
}
