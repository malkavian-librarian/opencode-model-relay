import type { RelayConfig } from "./config"
import type { Classified, OcMessage } from "./types"
import { RELAY_MARKER } from "./defaults"

export interface ModelHealth { permanent?: boolean; permanentAt?: number; cooldownUntil?: number; failures?: number }

export type Decision =
  | { action: "switch"; to: string }
  | { action: "exhausted"; reason: "no_candidates" | "switch_cap" }

/** Healthy = not permanently blacklisted and no cooldown running; a cooldown ending exactly at `now` has expired. */
export function isHealthy(h: ModelHealth | undefined, now: number): boolean {
  if (h?.permanent) return false
  return !(h?.cooldownUntil !== undefined && h.cooldownUntil > now)
}

/**
 * True when parts hold a relay handover (our own prompt): any text part that STARTS with RELAY_MARKER
 * (buildHandover always puts it first). A marker pasted mid-message by the user does not count. The
 * synthetic flag is not required: on OpenCode 2 the handover prompt is delivered through a runtime that
 * may hand it to hooks as a synthetic part (#56).
 */
export function hasRelayMarker(parts: unknown): boolean {
  if (!Array.isArray(parts)) return false
  return parts.some((p) => {
    const t = p && typeof p === "object" ? (p as { type?: unknown; text?: unknown }) : undefined
    return t?.type === "text" && typeof t.text === "string" && t.text.startsWith(RELAY_MARKER)
  })
}

/**
 * Models already tried for the failing turn: every model seen from the newest real user message on (relay
 * handover prompts carry RELAY_MARKER and continue the same turn). Read from the transcript, so it needs no state.
 */
export function triedThisTurn(msgs: OcMessage[]): string[] {
  let start = 0
  for (let k = msgs.length - 1; k >= 0; k--) {
    const m = msgs[k]
    if (m?.info?.role === "user" && !hasRelayMarker(m.parts)) { start = k; break }
  }
  const tried = new Set<string>()
  for (const m of msgs.slice(start)) {
    const i = m?.info
    if (!i) continue
    if (i.providerID && i.modelID) tried.add(`${i.providerID}/${i.modelID}`)
    if (i.model?.providerID && i.model.modelID) tried.add(`${i.model.providerID}/${i.model.modelID}`)
  }
  return [...tried]
}

export const MAX_COOLDOWN_MS = 3_600_000
export const RESET_COOLDOWN_MAX_MS = 6 * 3_600_000 // 6 h: multi-hour usage windows were truncated to 1 h (an October thrash driver)
const MAX_BACKOFF_EXPONENT = 30

/** Records a permanent blacklist or transient cooldown, preferring reset hints over exponential backoff. */
export function recordFailure(
  health: Record<string, ModelHealth>, model: string, c: Classified, now: number, cooldownMs: number,
  resetText?: string,
): void {
  const h = (health[model] ??= {})
  if (c.permanent) { h.permanent = true; h.permanentAt = now; return }
  h.failures = (h.failures ?? 0) + 1
  // Reset wording (retry-after text, ISO, "resets at HH:mm") and a numeric retry-after become a
  // real cooldown to the reset time, capped at 6 h; anything else keeps the exponential backoff.
  const until = parseResetCooldown(resetText, now) ?? retryAfterUntil(c.retryAfterMs, now)
  if (until !== undefined) { h.cooldownUntil = until; return }
  const exp = Math.min(h.failures - 1, MAX_BACKOFF_EXPONENT)
  h.cooldownUntil = now + Math.min(cooldownMs * 2 ** exp, MAX_COOLDOWN_MS)
}

/** Converts a finite, nonnegative retry delay to a deadline capped at the reset cooldown maximum. */
function retryAfterUntil(ra: number | undefined, now: number): number | undefined {
  if (typeof ra !== "number" || !Number.isFinite(ra) || ra < 0) return undefined
  return now + Math.min(ra, RESET_COOLDOWN_MAX_MS)
}

// --- Levels ladder (redesign plan sections 4.1/4.2.3/4.5, #64) ---

export type LevelEntry = RelayConfig["levels"][number]

/** Ordered, deduped ladder (first occurrence wins); find entries are carried unresolved — the discovery child (#69) resolves them. */
export function buildLadder(cfg: RelayConfig): LevelEntry[] {
  const seen = new Set<string>()
  return cfg.levels.filter((l) => {
    const key = typeof l === "string" ? l : JSON.stringify(l)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export const QUARANTINE_MS = 10 * 60_000

/**
 * Failover walk over the ladder from the top: skips the current model, unresolved find entries,
 * models tried this turn and unhealthy models (cooldown/blacklist). A model that failed this
 * session within QUARANTINE_MS is skipped too — a preference, not a veto: it is still chosen
 * when it is the only healthy candidate. That quarantine kills the October oscillation:
 * triedThisTurn protects only within one turn, and cooldown expiry plus walk-from-top
 * re-enters the corpse. Quarantine is per-session input (model -> last failure at); the
 * rewiring child (#66) wires the session record.
 */
export function walkFromTop(i: {
  ladder: readonly LevelEntry[]; current: string; health: Record<string, ModelHealth>
  tried?: readonly string[]; quarantine?: Readonly<Record<string, number>>
  now: number; switchCount: number; maxSwitches: number
}): Decision {
  if (i.switchCount >= i.maxSwitches) return { action: "exhausted", reason: "switch_cap" }
  const quarantined = (m: string): boolean => {
    const at = i.quarantine?.[m]
    return at !== undefined && i.now - at < QUARANTINE_MS
  }
  const candidates: string[] = []
  for (const l of i.ladder) {
    if (typeof l !== "string") continue // find entries stay unresolved (discovery child #69)
    if (l === i.current || i.tried?.includes(l)) continue
    if (!isHealthy(i.health[l], i.now)) continue
    candidates.push(l)
  }
  const pick = candidates.find((m) => !quarantined(m)) ?? candidates[0]
  return pick === undefined ? { action: "exhausted", reason: "no_candidates" } : { action: "switch", to: pick }
}

const RETRY_AFTER_TEXT = /retry-after[:\s]+(\d+(?:\.\d+)?)/i
const ISO_TIMESTAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/
const RESETS_AT = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i
const HOURS_PER_DAY = 24
const HOURS_PER_HALF_DAY = HOURS_PER_DAY / 2
const MINUTES_PER_HOUR = 60

/**
 * Parses reset wording into a cooldown-until timestamp capped by RESET_COOLDOWN_MAX_MS:
 * "retry-after: 30" (seconds), ISO timestamps (only future ones), and "usage limit resets at
 * HH:mm" / "resets at 5pm" local time — tomorrow when that time already passed today.
 * Returns undefined for unsupported wording so the caller keeps the exponential backoff.
 */
export function parseResetCooldown(text: string | undefined, now: number): number | undefined {
  if (!text) return undefined
  const cap = now + RESET_COOLDOWN_MAX_MS
  const ra = RETRY_AFTER_TEXT.exec(text)
  if (ra) return Math.min(now + Number(ra[1]) * 1000, cap)
  const iso = ISO_TIMESTAMP.exec(text)
  if (iso) {
    const t = Date.parse(iso[0])
    if (Number.isFinite(t) && t > now) return Math.min(t, cap)
  }
  const at = RESETS_AT.exec(text)
  if (at) {
    const rawHour = Number(at[1])
    const minute = Number(at[2] ?? 0)
    if (minute >= MINUTES_PER_HOUR || (at[3] ? rawHour < 1 || rawHour > HOURS_PER_HALF_DAY : rawHour >= HOURS_PER_DAY)) return undefined
    // With am/pm the hour is 12-based ("5pm" -> 17); without it, plain 24-hour ("17:00").
    const hour = at[3] ? rawHour % HOURS_PER_HALF_DAY + (at[3].toLowerCase() === "pm" ? HOURS_PER_HALF_DAY : 0) : rawHour
    const target = new Date(now)
    target.setHours(hour, minute, 0, 0)
    if (target.getTime() <= now) target.setDate(target.getDate() + 1)
    return Math.min(target.getTime(), cap)
  }
  return undefined
}

/** Success clears cooldown and permanent marks but keeps the failures count: one lucky turn must not reset backoff. */
export function clearSuccess(health: Record<string, ModelHealth>, model: string): void {
  const h = health[model]
  if (!h) return
  delete h.cooldownUntil
  delete h.permanent
  delete h.permanentAt
}

const AUTO_MAX_SWITCHES = 6

/**
 * Effective switch cap: the schema default doubles as the "auto" sentinel because the parsed
 * config cannot distinguish an explicit 6 from the default — and max(6, levels + 1) is never
 * below 6, so only an explicit 6 is affected. Any other explicit value always wins.
 */
export function effectiveMaxSwitches(cfg: RelayConfig): number {
  return cfg.maxSwitchesPerSession === AUTO_MAX_SWITCHES
    ? Math.max(AUTO_MAX_SWITCHES, cfg.levels.length + 1)
    : cfg.maxSwitchesPerSession
}
