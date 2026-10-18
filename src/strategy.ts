import type { RelayConfig } from "./config"
import type { Classified, OcMessage } from "./types"
import { RELAY_MARKER } from "./defaults"

export interface ModelHealth { permanent?: boolean; cooldownUntil?: number; failures?: number }

export type Decision =
  | { action: "switch"; to: string }
  | { action: "exhausted"; reason: "no_candidates" | "switch_cap" }

export type Mode = RelayConfig["mode"]

/** Healthy = not permanently blacklisted and no cooldown running; a cooldown ending exactly at `now` has expired. */
export function isHealthy(h: ModelHealth | undefined, now: number): boolean {
  if (h?.permanent) return false
  return !(h?.cooldownUntil !== undefined && h.cooldownUntil > now)
}

/** Flat chain primary -> secondary -> tertiary, deduped (first occurrence wins). Used by chain-sticky and chain-recover. */
export function buildChain(cfg: RelayConfig, current: string): string[] {
  const list = [...(cfg.tiers.primary ? [cfg.tiers.primary] : []), ...cfg.tiers.secondary, ...cfg.tiers.tertiary]
  const seen = new Set<string>()
  const chain = list.filter((m) => (seen.has(m) ? false : (seen.add(m), true)))
  if (!cfg.tiers.primary) {
    const rest = chain.filter((m) => m !== current)
    return [current, ...rest]
  }
  return chain
}

/**
 * Tier-aware view for escalate: [primary, secondary, tertiary], each deduped across tiers (first occurrence
 * wins, so a model listed twice belongs to its cheapest tier). An unset primary gives an empty tier 0; the
 * current model is not injected (unlike buildChain), a model outside every tier counts as below tier 0.
 */
export function buildTiers(cfg: RelayConfig): string[][] {
  const seen = new Set<string>()
  const uniq = (ms: string[]) => ms.filter((m) => (seen.has(m) ? false : (seen.add(m), true)))
  return [uniq(cfg.tiers.primary ? [cfg.tiers.primary] : []), uniq(cfg.tiers.secondary), uniq(cfg.tiers.tertiary)]
}

/** Index of the tier holding `model`, or -1 when it is in no tier. */
export function tierOf(tiers: string[][], model: string): number {
  return tiers.findIndex((t) => t.includes(model))
}

export function nextModel(i: {
  chain: string[]; current: string; health: Record<string, ModelHealth>
  now: number; switchCount: number; maxSwitches: number; tried?: readonly string[]
}): Decision {
  if (i.switchCount >= i.maxSwitches) return { action: "exhausted", reason: "switch_cap" }
  for (const m of i.chain) {
    if (m === i.current || i.tried?.includes(m)) continue
    if (!isHealthy(i.health[m], i.now)) continue
    return { action: "switch", to: m }
  }
  return { action: "exhausted", reason: "no_candidates" }
}

/**
 * escalate: tiers read cheap -> strong. A failure in tier T moves UP to the first healthy, untried candidate of
 * tier T+1; a tier with no such candidate (empty, cooling, blacklisted) is skipped for T+2. Siblings in tier T
 * and every lower tier are never tried, so the session never moves down or sideways. A model outside every tier
 * starts below tier 0. Exhausted once the top tier is passed.
 */
export function escalateModel(i: {
  tiers: string[][]; current: string; health: Record<string, ModelHealth>
  now: number; switchCount: number; maxSwitches: number; tried?: readonly string[]
}): Decision {
  if (i.switchCount >= i.maxSwitches) return { action: "exhausted", reason: "switch_cap" }
  for (const tier of i.tiers.slice(tierOf(i.tiers, i.current) + 1)) {
    for (const m of tier) {
      if (m === i.current || i.tried?.includes(m)) continue
      if (isHealthy(i.health[m], i.now)) return { action: "switch", to: m }
    }
  }
  return { action: "exhausted", reason: "no_candidates" }
}

/**
 * The failure-switch decision per mode. A model already tried for the same failing turn is never re-chosen,
 * even when its cooldown has run out meanwhile.
 */
export function decideSwitch(i: {
  cfg: RelayConfig; current: string; health: Record<string, ModelHealth>
  now: number; switchCount: number; tried: readonly string[]
}): Decision {
  const base = { current: i.current, health: i.health, now: i.now, switchCount: i.switchCount, maxSwitches: i.cfg.maxSwitchesPerSession }
  if (i.cfg.mode === "escalate") return escalateModel({ ...base, tiers: buildTiers(i.cfg), tried: i.tried })
  if (i.cfg.mode === "chain-recover") return nextModel({ ...base, chain: buildChain(i.cfg, i.current), tried: i.tried })
  return nextModel({ ...base, chain: buildChain(i.cfg, i.current), tried: i.tried })
}

/**
 * chain-recover: the highest-priority healthy model ranked above the sticky model, or undefined. A sticky model
 * missing from the chain (config changed) ranks below every chain model.
 */
export function recoverTarget(i: { chain: string[]; sticky: string; health: Record<string, ModelHealth>; now: number }): string | undefined {
  const rank = i.chain.indexOf(i.sticky)
  const above = rank === -1 ? i.chain : i.chain.slice(0, rank)
  return above.find((m) => m !== i.sticky && isHealthy(i.health[m], i.now))
}

/** True when parts hold a relay handover (our own prompt), recognised by RELAY_MARKER in a text part. */
export function hasRelayMarker(parts: unknown): boolean {
  if (!Array.isArray(parts)) return false
  return parts.some((p) => {
    const t = p && typeof p === "object" ? (p as { type?: unknown; text?: unknown }) : undefined
    return t?.type === "text" && typeof t.text === "string" && t.text.includes(RELAY_MARKER)
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

const MAX_COOLDOWN_MS = 3_600_000
const MAX_BACKOFF_EXPONENT = 30
export function recordFailure(
  health: Record<string, ModelHealth>, model: string, c: Classified, now: number, cooldownMs: number,
): void {
  const h = (health[model] ??= {})
  if (c.permanent) { h.permanent = true; return }
  h.failures = (h.failures ?? 0) + 1
  const exp = Math.min(h.failures - 1, MAX_BACKOFF_EXPONENT)
  const ra = c.retryAfterMs
  const wait = typeof ra === "number" && Number.isFinite(ra) && ra >= 0
    ? Math.min(ra, MAX_COOLDOWN_MS)
    : Math.min(cooldownMs * 2 ** exp, MAX_COOLDOWN_MS)
  h.cooldownUntil = now + wait
}
