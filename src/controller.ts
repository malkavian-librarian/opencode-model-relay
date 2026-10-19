import type { ClientLike, OcMessage } from "./types"
import { parseModel } from "./types"
import type { RelayConfig } from "./config"
import { classify, classifyRetryMessage } from "./classifier"
import type { Classified } from "./types"
import { buildChain, buildTiers, decideSwitch, hasRelayMarker, recordFailure, tierOf, triedThisTurn, type ModelHealth } from "./strategy"
import { decidePin } from "./pin"
import { heuristicReasons, observeTurn } from "./heuristics"
import { buildJudgeInput, parseVerdict } from "./judge"
import type { SessionLock } from "./session-lock"
import type { StateStore } from "./state"
import type { createNarrator, NarrationEvent } from "./narrator"
import type { SwitchLog } from "./switchlog"
import type { orChat } from "./openrouter"
import { buildHandover, extractFromMessages, writeNarrative } from "./handover"
import { performSwitch } from "./switcher"

// In-memory bound for the judge streak map (one entry per judged session, emptied on restart).
const MAX_JUDGE_STREAKS = 500

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
  // Judge "two consecutive switch:true verdicts" streak, in memory only: a restart resets it (fail safe).
  private judgeStreak = new Map<string, number>()
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
    if (!d.lock.tryAcquire(sessionID)) return
    try {
      // The transcript is read under the lock (#40): a user message arriving while a switch runs must not
      // make this failure handler blame the freshly switched (recovered) model.
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

      if (d.lock.isDuplicate(`${sessionID}:${ni.id}`)) return

      if (c.kind === "quality") {
        // The judge says quality, not failure: the model is not cooled down or blacklisted, it can win the
        // chain back later (or via chain-recover); only the switch itself is triggered.
      } else {
        recordFailure(d.health, current, c, d.now(), d.cfg.cooldownMs)
        d.state.save() // health (cooldowns, blacklists) is persisted together with the session record (#39)
      }
      const rec = { ...d.state.get(sessionID) }
      const decision = decideSwitch({
        cfg: d.cfg, current, health: d.health, now: d.now(), switchCount: rec.switchCount, tried: triedThisTurn(msgs),
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
        ...(rec.recoveries !== undefined ? { recoveries: rec.recoveries } : {}),
        ...(rec.judgeCalls !== undefined ? { judgeCalls: rec.judgeCalls } : {}),
        ...(rec.lastJudgeAt !== undefined ? { lastJudgeAt: rec.lastJudgeAt } : {}),
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

  /**
   * session.idle: a turn completed without a plugin-seen failure. The turn's model proves itself: its
   * blacklist (permanent, 24 h) and cooldown clear, "#39". Reading the transcript outside the lock is safe
   * here: the mark is idempotent (nothing to clear), never switches, and failures only clear after a full
   * turn really ended on that model. Never throws. The quality judge (#26) runs fire-and-forget after the
   * health mark: idle handling is never delayed by the judge's OpenRouter call.
   */
  async onSessionIdle(sessionID: string): Promise<void> {
    try {
      const session = await this.d.client.session.get({ path: { id: sessionID } })
      if (session.data?.parentID) return // failures are recorded on top-level sessions only; keep success symmetric
      const msgs = await this.fetchMessages(sessionID)
      const newest = [...msgs].reverse().find((m) => m.info.role === "assistant" && m.info.providerID && m.info.modelID)
      if (!newest) return
      const model = `${newest.info.providerID}/${newest.info.modelID}`
      if (this.d.health[model] !== undefined) {
        delete this.d.health[model]
        this.d.state.save()
      }
      // The judge runs after the health mark and never delays it; the event hook calls onSessionIdle
      // fire-and-forget, so the idle handling itself is never blocked by the judge's OpenRouter call.
      await this.runJudge(sessionID, model, msgs)
    } catch (e) {
      try { this.d.log(`onSessionIdle failed: ${e instanceof Error ? e.message : String(e)}`) } catch { /* ignore */ }
    }
  }

  /**
   * Quality judge (#26): gate, cheap heuristics, then the OpenRouter call. Fails safe everywhere: a judge
   * error, timeout or invalid JSON never switches; the call counts towards the caps anyway.
   */
  private async runJudge(sessionID: string, current: string, msgs: OcMessage[]): Promise<void> {
    const d = this.d
    try {
      const cfg = d.cfg.judge
      if (!cfg.enabled) return
      const now = d.now()
      // The primary tier never uses the judge; a model in no tier is never judged either.
      if (tierOf(buildTiers(d.cfg), current) <= 0) return
      // Egress is consent-gated like the handover summary; nothing leaves without both consent and key.
      const key = d.env[d.cfg.openrouter.keyEnv]
      if (!d.cfg.privacy.consent || !key) return
      // The turn must be finished: an assistant message last, tokens produced.
      const last = msgs[msgs.length - 1]
      if (!last || last.info.role !== "assistant") return // never switch while a user question is pending
      const output = last.info.tokens?.output
      if (typeof output !== "number" || !Number.isFinite(output) || output <= 0) return
      // The judge never evaluates its own or the handover's turns: the newest real user message must not be ours.
      const lastUser = [...msgs].reverse().find((m) => m.info.role === "user")
      if (!lastUser || hasRelayMarker(lastUser.parts)) return

      // Caps are persisted (#26): per-session calls and last call time ride on the session record, the
      // daily USD budget on the global judgeDaily bucket (reset by save() when the UTC day rolls over).
      const rec = d.state.get(sessionID)
      if ((rec.judgeCalls ?? 0) >= cfg.maxCallsPerSession) return
      if (now < (rec.lastJudgeAt ?? 0) + cfg.minIntervalMs) return
      // Once-per-turn is authoritative and persisted: a TTL map alone would let a re-fired idle
      // (after the TTL, before or even after minIntervalMs) answer the same turn twice, and two
      // switch:true verdicts for one turn would produce a switch.
      if (last.info.id === rec.lastJudgeMessageId) return
      const daily = d.state.judgeDaily
      // The bucket may carry yesterday's counters (file loaded, no save yet): reset it before reading.
      const today = new Date(now).toISOString().slice(0, 10)
      if (daily.date !== today) {
        daily.calls = undefined
        daily.costUsd = undefined
        daily.date = today
      }
      if (daily.costUsd !== undefined && daily.costUsd >= cfg.maxDailyUsd) return
      // Cheap pre-filter: an immediate re-fire of the same idle (same in-memory lock turn).
      if (d.lock.isDuplicate(`${sessionID}:judge:${last.info.id}`)) return

      // Cheap local heuristics first: only suspicious turns may reach the LLM judge.
      const reasons = heuristicReasons(observeTurn(msgs))
      if (reasons.length === 0) { this.judgeStreak.delete(sessionID); return }

      // Count the attempt even if the call fails, then spend.
      const judgeCalls = (rec.judgeCalls ?? 0) + 1
      daily.calls = (daily.calls ?? 0) + 1
      const fresh = d.state.get(sessionID)
      d.state.set(sessionID, { ...fresh, judgeCalls, lastJudgeAt: now, lastJudgeMessageId: last.info.id, updated: now })
      d.state.save()

      const ex = extractFromMessages(msgs, d.cfg.handover)
      const { payload, call } = buildJudgeInput(ex, reasons)
      const r = await d.chat({
        baseUrl: d.cfg.openrouter.baseUrl, key, model: cfg.model, system: cfg.prompt, user: payload,
        maxTokens: call.maxTokens, timeoutMs: call.timeoutMs, zdr: d.cfg.privacy.zdr,
      })
      // Spend counts whenever the call returned a cost: a billed reply that fails to parse is still spent.
      const cost = typeof r.costUsd === "number" && Number.isFinite(r.costUsd) && r.costUsd >= 0 ? r.costUsd : 0
      daily.costUsd = (daily.costUsd ?? 0) + cost
      d.state.save()
      const verdict = parseVerdict(r.text)
      // Invalid JSON / timeout / error => no switch (the verdict object itself carries the decision only).
      if (!verdict) return

      const streak = verdict.switch ? (this.judgeStreak.get(sessionID) ?? 0) + 1 : 0
      if (streak <= 0) { this.judgeStreak.delete(sessionID); return }
      if (this.judgeStreak.size >= MAX_JUDGE_STREAKS) this.judgeStreak.clear() // bound the in-memory map
      this.judgeStreak.set(sessionID, streak)
      if (streak < 2) return // two consecutive switch:true verdicts required
      this.judgeStreak.delete(sessionID)
      // A verdict may outlive its turn: a newer message can arrive during the judge call. Only switch
      // if the judged turn is still the newest one; the newer turn gets a fresh look at the next idle.
      const nowMsgs = await this.fetchMessages(sessionID)
      const newest = nowMsgs[nowMsgs.length - 1]
      if (!newest || newest.info.id !== last.info.id) return
      // Same switch path as a hard failure (lock, dedup, strategy, handover), logged as kind "quality".
      await this.handle(sessionID, { kind: "quality", retryable: false, permanent: false, switchable: true })
    } catch (e) {
      try { d.log(`runJudge failed: ${e instanceof Error ? e.message : String(e)}`) } catch { /* ignore */ }
    }
  }

  /**
   * chat.message: returns the model key the new user turn must run on, or undefined to leave it alone.
   * Pins the sticky model, clears stickiness on an explicit user pick, and in chain-recover returns the session
   * to a recovered higher-priority model. A recovery is not a failure: switchCount is untouched, the switch log
   * gets kind "recover". Never throws; on any error the turn keeps its model.
   */
  onChatMessage(sessionID: string, inputModelKey: string, parts: unknown): string | undefined {
    const d = this.d
    let locked = false
    try {
      const rec = d.state.get(sessionID)
      // Recover only on a real user turn: never on our own handover prompt (same failing turn) and never while
      // a switch holds the lock (the failure path owns the session then).
      // Budget: a recovery is free but the failure switch away from a model that relapses is not, so leave one
      // switch of headroom (never strand the session on a failing model at the cap), and cap recoveries too.
      const max = d.cfg.maxSwitchesPerSession
      const budget = rec.switchCount < max - 1 && (rec.recoveries ?? 0) < max
      locked = d.cfg.mode === "chain-recover" && budget && !!rec.sticky && !hasRelayMarker(parts) && d.lock.tryAcquire(sessionID)
      const p = decidePin(rec, inputModelKey, locked
        ? { mode: d.cfg.mode, chain: buildChain(d.cfg, rec.origin ?? rec.sticky ?? inputModelKey), health: d.health, now: d.now() }
        : undefined)
      if (p.action === "pin") return p.to
      if (p.action === "none") return undefined
      // Drop sticky/origin but keep the switch and helper-call counters (caps must survive).
      const next: typeof rec = { switchCount: rec.switchCount, updated: d.now() }
      if (rec.helperCalls !== undefined) next.helperCalls = rec.helperCalls
      if (rec.recoveries !== undefined) next.recoveries = rec.recoveries
      if (rec.judgeCalls !== undefined) next.judgeCalls = rec.judgeCalls
      if (rec.lastJudgeAt !== undefined) next.lastJudgeAt = rec.lastJudgeAt
      if (p.action === "recover") {
        next.recoveries = (rec.recoveries ?? 0) + 1
        if (!p.clearSticky) {
          // The turn arrived on another model than the recovered one (TUI still showing origin or the old sticky
          // model; which one is unconfirmed, #19): keep pinning that incoming model to the recovered one, so
          // remember it as lastPin (seen by decidePin, not a user pick). Keep the session's origin as the chain
          // anchor (no primary: buildChain puts it first); fallback only when state had none (seeded session).
          next.sticky = p.to
          next.origin = rec.origin ?? inputModelKey
          next.lastPin = inputModelKey
        }
        d.state.set(sessionID, next); d.state.save()
        d.switchLog.append({ ts: d.now(), sessionID, from: rec.sticky as string, to: p.to, kind: "recover" })
        // Fire-and-forget: toast never rejects internally; recovery must not delay the turn.
        void this.toast("recovered", { from: rec.sticky as string, to: p.to })
        return p.to
      }
      d.state.set(sessionID, next); d.state.save()
      return undefined
    } catch (e) {
      try { d.log(`onChatMessage failed: ${e instanceof Error ? e.message : String(e)}`) } catch { /* ignore */ }
      return undefined
    } finally {
      if (locked) d.lock.release(sessionID)
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
      `recoveries: ${rec?.recoveries ?? 0}`,
      `consent: ${d.cfg.privacy.consent ? "on" : "off"}`,
      `key: ${d.env[d.cfg.openrouter.keyEnv] ? "set" : "missing"}`,
    ].join("\n")
  }
}
