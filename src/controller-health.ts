import type { EventInput } from "./ledger"
import { clearSuccess as clearHealthSuccess, isHealthy, type HealthExpiry, type ModelHealth } from "./strategy"
import type { Deps } from "./controller"
import type { OcMessage } from "./types"

const MAX_EMITTED_EVENTS = 500

export class HealthEvents {
  private emittedExpiry = new Set<string>()

  constructor(private readonly led: (fields: EventInput) => void, private readonly tierOf: (model: string) => number | undefined) {}

  expiry(sessionID: string, model: string, what: HealthExpiry, health: ModelHealth | undefined, ts: number): void {
    try {
      const marker = what === "cooldown_end" ? health?.cooldownUntil : health?.permanentAt
      const key = `${sessionID}:${model}:${what}:${marker ?? "unknown"}`
      if (this.emittedExpiry.has(key)) return
      if (this.emittedExpiry.size >= MAX_EMITTED_EVENTS) this.emittedExpiry.clear()
      this.emittedExpiry.add(key)
      this.led({ ts, sessionID, event: "health", model, tier: this.tierOf(model), what })
    } catch { /* health telemetry never changes the decision */ }
  }

  outcome(sessionID: string, model: string, what: "quarantine_skip" | "exhausted" | "cap_hit", ts: number, seen: Set<string>): void {
    if (seen.has(`${what}:${model}`)) return
    seen.add(`${what}:${model}`)
    this.led({ ts, sessionID, event: "health", model, tier: this.tierOf(model), what })
  }

  clearSuccess(sessionID: string, model: string, health: Record<string, ModelHealth>, ts: number): void {
    const entry = health[model]
    if (!entry) return
    if (entry.cooldownUntil !== undefined) this.expiry(sessionID, model, "cooldown_end", entry, ts)
    if (entry.permanent) this.expiry(sessionID, model, "permanent_expire", entry, ts)
    clearHealthSuccess(health, model)
  }
}

export async function runSessionIdle(
  d: Deps, sessionID: string, fetchMessages: (id: string) => Promise<OcMessage[]>,
  healthEvents: HealthEvents, led: (fields: EventInput) => void, tierOf: (model: string) => number | undefined,
  runJudge: (id: string, model: string, messages: OcMessage[]) => Promise<void>, clearStorm: () => void,
): Promise<void> {
  try {
    const session = await d.client.session.get({ path: { id: sessionID } })
    if (session.data?.parentID) return
    const msgs = await fetchMessages(sessionID)
    const newest = [...msgs].reverse().find((m) => m.info.role === "assistant" && m.info.providerID && m.info.modelID)
    if (!newest) return
    const model = `${newest.info.providerID}/${newest.info.modelID}`
    const src = newest.info as typeof newest.info & { tokens?: { input?: unknown; output?: unknown }; time?: { running?: unknown } }
    const int = (v: unknown): number | undefined => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined)
    const ms = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined)
    const tin = int(src.tokens?.input); const tout = int(src.tokens?.output); const lat = ms(src.time?.running)
    led({
      ts: d.now(), sessionID, event: "turn", model, tier: tierOf(model),
      ...(tin !== undefined && tout !== undefined ? { tokens: { input: tin, output: tout } } : {}),
      ...(lat !== undefined ? { latencyMs: lat } : {}), ...(ms(src.cost) !== undefined ? { cost: src.cost } : {}),
    })
    const rec = d.state.get(sessionID)
    clearStorm()
    const health = d.health[model]
    isHealthy(health, d.now(), (what) => healthEvents.expiry(sessionID, model, what, health, d.now()))
    healthEvents.clearSuccess(sessionID, model, d.health, d.now())
    if (d.health[model] !== undefined) d.state.save()
    if (rec.pendingHandover !== undefined) {
      const { pendingHandover: _spent, circularOrigin: _origin, circularFindKey: _findKey, circularTransitions: _transitions, circularFlows: _flows, ...rest } = rec
      d.state.set(sessionID, { ...rest, updated: d.now() }); d.state.save()
    } else if (rec.circularOrigin !== undefined || rec.circularFindKey !== undefined || rec.circularTransitions !== undefined || rec.circularFlows !== undefined) {
      const { circularOrigin: _origin, circularFindKey: _findKey, circularTransitions: _transitions, circularFlows: _flows, ...rest } = rec
      d.state.set(sessionID, { ...rest, updated: d.now() }); d.state.save()
    }
    await runJudge(sessionID, model, msgs)
  } catch (e) {
    try { d.log(`onSessionIdle failed: ${e instanceof Error ? e.message : String(e)}`) } catch { /* ignore */ }
  }
}
