import type { RelayConfig } from "./config"
import type { Classified } from "./types"

export interface ModelHealth { permanent?: boolean; cooldownUntil?: number; failures?: number }

export type Decision =
  | { action: "switch"; to: string }
  | { action: "exhausted"; reason: "no_candidates" | "switch_cap" }

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

export function nextModel(i: {
  chain: string[]; current: string; health: Record<string, ModelHealth>
  now: number; switchCount: number; maxSwitches: number
}): Decision {
  if (i.switchCount >= i.maxSwitches) return { action: "exhausted", reason: "switch_cap" }
  for (const m of i.chain) {
    if (m === i.current) continue
    const h = i.health[m]
    if (h?.permanent) continue
    if (h?.cooldownUntil !== undefined && h.cooldownUntil > i.now) continue
    return { action: "switch", to: m }
  }
  return { action: "exhausted", reason: "no_candidates" }
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
