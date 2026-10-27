import { buildLadder } from "./strategy"
import { FIND_CACHE_TTL_MS } from "./state"
import type { Deps } from "./controller"
import type { SwitchLogRow } from "./switchlog"

/** Formats one model's current health without exposing provider content. */
function healthStatus(d: Deps, model: string, now: number): string {
  const health = d.health[model]
  if (health?.permanent) return `blacklisted-until: ${health.permanentAt === undefined ? "unknown" : health.permanentAt + 24 * 60 * 60 * 1000}`
  if (health?.cooldownUntil !== undefined && health.cooldownUntil > now) return `cooldown ${health.cooldownUntil - now}ms`
  return "healthy"
}

/** Formats one metadata-only switch row for the existing status surface. */
function formatLedgerRow(row: SwitchLogRow): string {
  return [
    `ts=${row.ts}`, `session=${row.session}`, `kind=${row.kind}`,
    ...(row.reason === undefined ? [] : [`reason=${row.reason}`]),
    `elapsedMs=${row.elapsedMs}`,
    ...(row.from === undefined ? [] : [`from=${row.from}`]),
    ...(row.to === undefined ? [] : [`to=${row.to}`]),
    ...(row.helperCostUsd === undefined ? [] : [`helperCostUsd=${row.helperCostUsd}`]),
  ].join(" ")
}

/** Builds the existing human-readable relay status output. */
export function buildStatus(d: Deps, sessionID?: string): string {
  try {
    const now = d.now()
    const rec = sessionID ? d.state.get(sessionID) : undefined
    const ladder = buildLadder(d.cfg)
    const chain = ladder.map((level) => typeof level === "string" ? level : "(unresolved find)").join(" -> ")
    const levels = ladder.map((level, index) => {
      if (typeof level === "string") return `${index + 1}. ${level} ${healthStatus(d, level, now)}`
      if (!d.cfg.privacy.consent) return `${index + 1}. find [consent-gated]`
      const cached = d.state.findCache[JSON.stringify(level)]
      if (!cached || cached.resolvedAt > now || now - cached.resolvedAt > FIND_CACHE_TTL_MS) return `${index + 1}. find [unresolved]`
      return `${index + 1}. find [resolved -> ${cached.model} (cached, ageMs: ${Math.max(0, now - cached.resolvedAt)})] ${healthStatus(d, cached.model, now)}`
    })
    const rows = (d.switchLog.recent?.(10) ?? []).slice(-10)
    const manual = rows.filter((row) => row.kind === "manual").length
    const auto = rows.filter((row) => row.kind !== "manual" && row.kind !== "switch_dropped").length
    return [
      `chain: ${chain || "(no levels configured)"}`,
      `ladder:\n${levels.join("\n") || "(no levels configured)"}`,
      `pluginPinned: ${rec?.pluginPinned ?? "none"}`,
      `pinned: ${rec?.pluginPinned ?? "none"}`,
      `adoptedAt: ${rec?.adoptedAt ?? "none"}`,
      `switches: ${rec?.switchCount ?? 0}`,
      `circular: ${d.cfg.maxCircularFlows} (completed ${rec?.circularFlows ?? 0})`,
      `consent: ${d.cfg.privacy.consent ? "on" : "off"}`,
      `key: ${d.env[d.cfg.openrouter.keyEnv] ? "set" : "missing"}`,
      `counts: manual ${manual}, auto ${auto}`,
      "last 10 ledger entries:",
      ...(rows.length ? rows.map(formatLedgerRow) : ["(none)"]),
    ].join("\n")
  } catch { return "relay status unavailable" }
}
