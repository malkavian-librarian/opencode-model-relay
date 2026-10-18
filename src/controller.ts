import type { ClientLike, OcMessage } from "./types"
import { parseModel } from "./types"
import type { RelayConfig } from "./config"
import { classify, classifyRetryMessage } from "./classifier"
import type { Classified } from "./types"
import { buildChain, nextModel, recordFailure, type ModelHealth } from "./strategy"
import type { SessionLock } from "./session-lock"
import type { StateStore } from "./state"
import type { createNarrator, NarrationEvent } from "./narrator"
import type { SwitchLog } from "./switchlog"
import type { orChat } from "./openrouter"
import { buildHandover, extractFromMessages, writeNarrative } from "./handover"
import { performSwitch } from "./switcher"

export interface Deps {
  client: ClientLike
  cfg: RelayConfig
  lock: SessionLock
  state: StateStore
  health: Record<string, ModelHealth>
  narrate: ReturnType<typeof createNarrator>
  switchLog: { append: SwitchLog["append"] }
  env: Record<string, string | undefined>
  now: () => number
  chat: typeof orChat
  log: (m: string) => void
  switchOpts?: { abortTimeoutMs?: number; abortDelayMs?: number }
}

export class Controller {
  private warnedConsent = false // controller-global (one toast per process), not per session
  constructor(private d: Deps) {}

  private async toast(ev: NarrationEvent, v?: Parameters<Deps["narrate"]>[1], variant: "info" | "warning" = "info") {
    try {
      const message = this.d.narrate(ev, v)
      if (!message) return
      await this.d.client.tui.showToast({ body: { message, variant } })
    } catch { /* toast is best effort */ }
  }

  private async fetchMessages(id: string): Promise<OcMessage[]> {
    const r = await this.d.client.session.messages({ path: { id } })
    return r.data ?? []
  }

  async onSessionError(sessionID: string, rawError: unknown): Promise<void> {
    try {
      await this.handle(sessionID, classify(rawError))
    } catch (e) {
      try { this.d.log(`onSessionError failed: ${e instanceof Error ? e.message : String(e)}`) } catch { /* ignore */ }
    }
  }

  /**
   * OpenCode retries retryable errors itself and reports them as session.status "retry" events; session.error
   * only follows after many retries. Permanent failures (quota, auth, ...) switch at once; transient ones
   * only from the second attempt, so a one-off blip is left to OpenCode.
   */
  async onRetryStatus(sessionID: string, attempt: number, message: string): Promise<void> {
    try {
      const c = classifyRetryMessage(message)
      if (!c.switchable) return
      if (!c.permanent && !(attempt >= 2)) return
      await this.handle(sessionID, c)
    } catch (e) {
      try { this.d.log(`onRetryStatus failed: ${e instanceof Error ? e.message : String(e)}`) } catch { /* ignore */ }
    }
  }

  private async handle(sessionID: string, c: Classified): Promise<void> {
    const d = this.d
    // A plugin-caused abort is consumed here; an unmarked abort is the user pressing Esc. Neither switches.
    if (c.kind === "user_abort") { d.lock.consumePluginAbort(sessionID); return }
    if (!c.switchable) return

    const session = await d.client.session.get({ path: { id: sessionID } })
    if (session.data?.parentID) return

    const msgs = await this.fetchMessages(sessionID)
    // The newest message identifies the failing turn: an assistant message carries the model that ran; if the
    // error came before any assistant reply (first turn, model resolution), the user message carries the model.
    const newest = msgs[msgs.length - 1]
    if (!newest) return
    const ni = newest.info
    // The title/summary agent produces assistant messages without provider/model: ignore.
    const m = ni.role === "assistant" ? (ni.providerID && ni.modelID ? { providerID: ni.providerID, modelID: ni.modelID } : undefined) : ni.model
    if (!m?.providerID || !m.modelID) return
    const current = `${m.providerID}/${m.modelID}`

    // Acquire first so an event dropped because a switch is running does not poison the dedup cache.
    if (!d.lock.tryAcquire(sessionID)) return
    try {
      if (d.lock.isDuplicate(`${sessionID}:${ni.id}`)) return

      recordFailure(d.health, current, c, d.now(), d.cfg.cooldownMs)
      const rec = { ...d.state.get(sessionID) }
      const decision = nextModel({
        chain: buildChain(d.cfg, current), current, health: d.health, now: d.now(),
        switchCount: rec.switchCount, maxSwitches: d.cfg.maxSwitchesPerSession,
      })
      if (decision.action === "exhausted") {
        await this.toast(decision.reason === "switch_cap" ? "cap_reached" : "exhausted", {}, "warning")
        return
      }

      const ex = extractFromMessages(msgs, d.cfg.handover)
      const key = d.env[d.cfg.openrouter.keyEnv]
      let summary: string | null = null
      let helperCost: number | undefined
      let helperCalls = rec.helperCalls ?? 0
      if (d.cfg.privacy.consent && key) {
        // Per-session cap: once reached, use the plain tail silently (no toast).
        if (helperCalls < d.cfg.handover.maxCallsPerSession) {
          helperCalls++ // count the attempt even if it fails
          const w = await writeNarrative({ chat: d.chat, cfg: d.cfg, key }, ex)
          if (w) { summary = w.summary; helperCost = w.costUsd } else await this.toast("handover_failed", {}, "warning")
        }
      } else if (!this.warnedConsent) {
        // no consent, or consent without a key: nothing is sent anywhere; tell the user once
        this.warnedConsent = true
        await this.toast(d.cfg.privacy.consent ? "no_key" : "no_consent")
      }

      const text = buildHandover({ cfg: d.cfg, ex, from: current, to: decision.to, reason: c.kind, summary })
      const agent = [...msgs].reverse().find((m) => m.info.role === "user")?.info.agent
      await performSwitch(
        { client: d.client, lock: d.lock, log: d.log, ...(d.switchOpts ?? {}) },
        { sessionID, to: parseModel(decision.to), ...(agent ? { agent } : {}), handoverText: text },
      )

      d.state.set(sessionID, {
        sticky: decision.to, origin: rec.origin ?? current, switchCount: rec.switchCount + 1, helperCalls, updated: d.now(),
      })
      d.state.save()
      d.switchLog.append({
        ts: d.now(), sessionID, from: current, to: decision.to, kind: c.kind,
        ...(helperCost !== undefined ? { helperCostUsd: helperCost } : {}),
      })
      await this.toast("switch_done", { from: current, to: decision.to, reason: c.kind })
    } finally {
      d.lock.release(sessionID)
    }
  }

  status(sessionID?: string): string {
    const d = this.d
    const rec = sessionID ? d.state.get(sessionID) : undefined
    const chain = buildChain(d.cfg, rec?.sticky ?? d.cfg.tiers.primary ?? "(current model)")
    return [
      `chain: ${chain.join(" -> ")}`,
      `mode: ${d.cfg.mode}`,
      `sticky: ${rec?.sticky ?? "none"}`,
      `switches: ${rec?.switchCount ?? 0}`,
      `consent: ${d.cfg.privacy.consent ? "on" : "off"}`,
      `key: ${d.env[d.cfg.openrouter.keyEnv] ? "set" : "missing"}`,
    ].join("\n")
  }
}
