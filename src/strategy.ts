import type { RelayConfig } from "./config"
import type { Classified, OcMessage } from "./types"
import type { OpenRouterCatalogModel } from "./openrouter"
import type { StateStore } from "./state"
import { RELAY_MARKER } from "./defaults"

export interface ModelHealth { permanent?: boolean; permanentAt?: number; cooldownUntil?: number; failures?: number }
export type HealthTransition = "cooldown_start" | "permanent_mark"
export type HealthExpiry = "cooldown_end" | "permanent_expire"

export type Decision =
  | { action: "switch"; to: string }
  | { action: "exhausted"; reason: "no_candidates" | "switch_cap" }

/** Healthy = not permanently blacklisted and no cooldown running; a cooldown ending exactly at `now` has expired. */
export function isHealthy(h: ModelHealth | undefined, now: number, onExpiry?: (what: HealthExpiry) => void): boolean {
  try {
    if (h?.cooldownUntil !== undefined && h.cooldownUntil <= now) onExpiry?.("cooldown_end")
    if (h?.permanent === true && h.permanentAt !== undefined && now - h.permanentAt >= PERMANENT_HEALTH_TTL_MS) onExpiry?.("permanent_expire")
  } catch { /* health telemetry never changes the decision */ }
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
export const PERMANENT_HEALTH_TTL_MS = 24 * 3_600_000
const MAX_BACKOFF_EXPONENT = 30

/** Records a permanent blacklist or transient cooldown, preferring reset hints over exponential backoff. */
export function recordFailure(
  health: Record<string, ModelHealth>, model: string, c: Classified, now: number, cooldownMs: number,
  resetText?: string, onTransition?: (what: HealthTransition, untilMs?: number) => void,
): void {
  const h = (health[model] ??= {})
  if (c.permanent) {
    h.permanent = true; h.permanentAt = now
    onTransition?.("permanent_mark", now + PERMANENT_HEALTH_TTL_MS)
    return
  }
  h.failures = (h.failures ?? 0) + 1
  // Reset wording (retry-after text, ISO, "resets at HH:mm") and a numeric retry-after become a
  // real cooldown to the reset time, capped at 6 h; anything else keeps the exponential backoff.
  const until = parseResetCooldown(resetText, now) ?? retryAfterUntil(c.retryAfterMs, now)
  if (until !== undefined) {
    h.cooldownUntil = until
    onTransition?.("cooldown_start", until)
    return
  }
  const exp = Math.min(h.failures - 1, MAX_BACKOFF_EXPONENT)
  const deadline = now + Math.min(cooldownMs * 2 ** exp, MAX_COOLDOWN_MS)
  h.cooldownUntil = deadline
  onTransition?.("cooldown_start", deadline)
}

/** Converts a finite, nonnegative retry delay to a deadline capped at the reset cooldown maximum. */
function retryAfterUntil(ra: number | undefined, now: number): number | undefined {
  if (typeof ra !== "number" || !Number.isFinite(ra) || ra < 0) return undefined
  return now + Math.min(ra, RESET_COOLDOWN_MAX_MS)
}

// --- Levels ladder (redesign plan sections 4.1/4.2.3/4.5, #64) ---

export type LevelEntry = RelayConfig["levels"][number]

export interface FindResolutionInput {
  current: string; health: Record<string, ModelHealth>; tried?: readonly string[]
  quarantine?: Readonly<Record<string, number>>; now: number; consent: boolean
  openCodeModels?: readonly string[] | (() => Promise<readonly string[]>); fetchCatalog?: () => Promise<OpenRouterCatalogModel[]>
  cache?: Pick<StateStore, "getFindCache" | "setFindCache" | "invalidateFindCache">
  failed?: string
  allowQuarantined?: boolean
  onHealthExpiry?: (model: string, what: HealthExpiry) => void
}

const DISCOVERED_ID = /^[A-Za-z0-9._:-]+(?:\/[A-Za-z0-9._:-]+)*$/
const FIND_CACHE_KEY = (entry: LevelEntry): string => JSON.stringify(entry)

/** External model ids may contain provider separators, but no control or URL/shell characters. */
export function isValidDiscoveredModelId(id: unknown): id is string {
  return typeof id === "string" && id.length > 0 && id.length <= 128 && DISCOVERED_ID.test(id)
}

/** Resolves one matcher only when walked; consent is checked before either local or remote discovery. */
export async function resolveFindLevel(entry: Exclude<LevelEntry, string>, i: FindResolutionInput): Promise<string | undefined> {
  if (!i.consent) return undefined
  const key = FIND_CACHE_KEY(entry)
  if (i.failed !== undefined && i.cache) i.cache.invalidateFindCache(key)
  const cached = i.cache?.getFindCache(key, i.now)
  const quarantined = (m: string): boolean => {
    const at = i.quarantine?.[m]
    return at !== undefined && i.now - at < QUARANTINE_MS
  }
  const usable = (m: string): boolean => m !== i.current && !i.tried?.includes(m) && isHealthy(i.health[m], i.now, (what) => i.onHealthExpiry?.(m, what)) && (i.allowQuarantined !== false || !quarantined(m))
  if (cached && usable(cached) && !quarantined(cached)) return cached
  if (cached) i.cache?.invalidateFindCache(key)
  let candidates: string[] = []
  try {
    const re = new RegExp(entry.find.match)
    if (entry.find.via === "openrouter") {
      const rows = i.fetchCatalog ? await i.fetchCatalog() : []
      candidates = rows.filter((m) => isValidDiscoveredModelId(m.id) && (!entry.find.free || m.pricing?.prompt === "0") && re.test(m.id))
        .map((m) => `openrouter/${m.id}`)
    } else {
      const models = typeof i.openCodeModels === "function" ? await i.openCodeModels() : i.openCodeModels ?? []
      candidates = models.filter((m) => isValidDiscoveredModelId(m) && (!entry.find.free || m.endsWith("-free")) && re.test(m))
    }
  } catch { return undefined }
  const healthy = candidates.filter(usable)
  const pick = healthy.find((m) => !quarantined(m)) ?? healthy[0]
  if (pick !== undefined) i.cache?.setFindCache(key, pick, i.now)
  return pick
}

/** Async ladder walk used by failover/command callers so find entries stay lazy. */
export async function walkFromTopAsync(i: {
  ladder: readonly LevelEntry[]; current: string; health: Record<string, ModelHealth>
  tried?: readonly string[]; quarantine?: Readonly<Record<string, number>>; now: number
  switchCount: number; maxSwitches: number; consent: boolean; openCodeModels?: FindResolutionInput["openCodeModels"]
  fetchCatalog?: () => Promise<OpenRouterCatalogModel[]>; cache?: FindResolutionInput["cache"]
  allowQuarantined?: boolean
  onQuarantineSkip?: (model: string) => void
  onHealthExpiry?: (model: string, what: HealthExpiry) => void
}): Promise<Decision> {
  if (i.switchCount >= i.maxSwitches) return { action: "exhausted", reason: "switch_cap" }
  let fallback: string | undefined
  const quarantined = (m: string): boolean => {
    const at = i.quarantine?.[m]
    return at !== undefined && i.now - at < QUARANTINE_MS
  }
  for (const level of i.ladder) {
    const model = typeof level === "string" ? level : await resolveFindLevel(level, i)
    if (model === undefined || model === i.current || i.tried?.includes(model) || !isHealthy(i.health[model], i.now, (what) => i.onHealthExpiry?.(model, what))) continue
    if (quarantined(model)) { i.onQuarantineSkip?.(model); if (i.allowQuarantined === false) continue }
    if (!quarantined(model)) return { action: "switch", to: model }
    if (i.allowQuarantined !== false) fallback ??= model
  }
  return fallback === undefined ? { action: "exhausted", reason: "no_candidates" } : { action: "switch", to: fallback }
}

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
  onQuarantineSkip?: (model: string) => void
  onHealthExpiry?: (model: string, what: HealthExpiry) => void
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
    if (!isHealthy(i.health[l], i.now, (what) => i.onHealthExpiry?.(l, what))) continue
    candidates.push(l)
  }
  for (const model of candidates) if (quarantined(model)) i.onQuarantineSkip?.(model)
  const pick = candidates.find((m) => !quarantined(m)) ?? candidates[0]
  return pick === undefined ? { action: "exhausted", reason: "no_candidates" } : { action: "switch", to: pick }
}

/** Deterministic cyclic walk: move forward from the current resolved ladder entry, never from the top. */
export function walkCircular(i: {
  ladder: readonly LevelEntry[]; current: string; health: Record<string, ModelHealth>
  quarantine?: Readonly<Record<string, number>>; now: number; switchCount: number; maxSwitches: number
  maxCircularFlows: number; circularFlows?: number
  resolveFind?: (entry: Exclude<LevelEntry, string>) => string | undefined
  onQuarantineSkip?: (model: string) => void
  onHealthExpiry?: (model: string, what: HealthExpiry) => void
}): Decision {
  if (i.switchCount >= i.maxSwitches || (i.circularFlows ?? 0) >= i.maxCircularFlows) return { action: "exhausted", reason: "switch_cap" }
  const levels = i.ladder.map((entry) => typeof entry === "string" ? entry : i.resolveFind?.(entry))
  const start = levels.indexOf(i.current)
  if (start < 0 || levels.length < 2) return { action: "exhausted", reason: "no_candidates" }
  const quarantined = (model: string): boolean => {
    const at = i.quarantine?.[model]
    return at !== undefined && i.now - at < QUARANTINE_MS
  }
  for (const allowQuarantined of [false, true]) {
    for (let offset = 1; offset < levels.length; offset++) {
      const model = levels[(start + offset) % levels.length]
      if (model !== undefined && model !== i.current && isHealthy(i.health[model], i.now, (what) => i.onHealthExpiry?.(model, what))) {
        if (quarantined(model)) { i.onQuarantineSkip?.(model); if (!allowQuarantined) continue }
        return { action: "switch", to: model }
      }
    }
  }
  return { action: "exhausted", reason: "no_candidates" }
}

const RETRY_AFTER_TEXT = /retry-after[:\s]+(\d+(?:\.\d+)?)(?![\d.a-z])/i
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
  const normal = cfg.maxSwitchesPerSession === AUTO_MAX_SWITCHES
    ? Math.max(AUTO_MAX_SWITCHES, cfg.levels.length + 1)
    : cfg.maxSwitchesPerSession
  return cfg.maxCircularFlows > 0 && cfg.maxSwitchesPerSession === AUTO_MAX_SWITCHES
    ? Math.max(normal, cfg.maxCircularFlows * Math.max(2, cfg.levels.length))
    : normal
}
