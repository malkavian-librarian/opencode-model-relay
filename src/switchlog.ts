import { createHmac, randomBytes } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import type { FailureKind } from "./types"

const SALT_BYTES = 32

export type SwitchDropReason = "lock_held" | "marker_guard" | "superseded"

/** A failure-switch logs its FailureKind; a judge switch logs "quality"; a dropped switch logs "switch_dropped" with its reason. */
export type SwitchKind = FailureKind | "switch_dropped" | "manual"

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

// eslint-disable-next-line no-control-regex
const CONTROL = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f" + String.fromCharCode(0x2028, 0x2029) + "]", "g")
const clean = (s: string, cap: number): string => String(s).replace(CONTROL, "").slice(0, cap)

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

  append(r: { ts: number; sessionID: string; from?: string; to?: string; kind: SwitchKind; reason?: SwitchDropReason; elapsedMs?: number; helperCostUsd?: number }): void {
    if (!this.enabled) return
    try {
      const session = createHmac("sha256", this.getSalt()).update(r.sessionID).digest("hex").slice(0, 16)
      const row = {
        ts: r.ts, session, kind: r.kind,
        ...(r.from !== undefined ? { from: clean(r.from, 120) } : {}),
        ...(r.to !== undefined ? { to: clean(r.to, 120) } : {}),
        ...(r.reason !== undefined ? { reason: r.reason } : {}),
        elapsedMs: typeof r.elapsedMs === "number" && Number.isFinite(r.elapsedMs) && r.elapsedMs >= 0 ? r.elapsedMs : 0,
        ...(r.helperCostUsd !== undefined ? { helperCostUsd: r.helperCostUsd } : {}),
      }
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 })
      fs.appendFileSync(path.join(this.dir, "switches.jsonl"), JSON.stringify(row) + "\n", { mode: 0o600 })
    } catch { /* logging is best effort */ }
  }
}
