import type { ClientLike, ModelRef, OcMessage } from "./types"
import { modelKey, parseModel } from "./types"
import type { RelayConfig } from "./config"
import { classify, classifyRetryMessage } from "./classifier"
import type { Classified } from "./types"
import {
  buildLadder, clearSuccess, effectiveMaxSwitches, hasRelayMarker, isHealthy, recordFailure, triedThisTurn,
  walkFromTop, QUARANTINE_MS, type LevelEntry, type ModelHealth,
} from "./strategy"
import { heuristicReasons, observeTurn } from "./heuristics"
import { buildJudgeInput, parseVerdict } from "./judge"
import type { SessionLock } from "./session-lock"
import type { StateStore } from "./state"
import type { createNarrator, NarrationEvent } from "./narrator"
import type { SwitchLog } from "./switchlog"
import type { orChat } from "./openrouter"
import { buildHandover, extractFromMessages, writeNarrative } from "./handover"

// In-memory bounds for the per-session maps (judge streaks, retry-storm tokens): one entry per
// session, emptied on restart (fail safe) and cleared wholesale when the bound is hit.
const MAX_SESSION_ENTRIES = 500
// Failures of a freshly adopted pick within this window do not re-mark it (retry-storm ordering, panel P1-F7).
const ADOPTION_GRACE_MS = 30_000
// Retry events for a session are consumed for this long after an enacted switch (AC-05 storm token).
const RETRY_STORM_MS = 30_000
// Absorbed switcher defaults: the abort race timeout and the pre-prompt delay; the AC-02 re-read
// sits between the abort and the prompt (switchModel), the only seam where a pick can be honoured.
const ABORT_TIMEOUT_MS = 5000
const ABORT_DELAY_MS = 300
const EXHAUSTED_HINT = " Run /relay next to retry the ladder now."

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

export interface ManualSwitchResult {
  status: "switched" | "locked" | "bottom" | "invalid" | "unavailable"
  from?: string
  to?: string
  elapsedMs?: number
}

/** The raw provider message is reset-wording input for recordFailure; it is only ever regex-matched, never executed. */
const errorText = (raw: unknown): string | undefined => {
  const r = raw as { data?: { message?: unknown } } | undefined
  return typeof r?.data?.message === "string" ? r.data.message : undefined
}

/** The deepest healthy, unquarantined level other than the current model: the onExhausted last resort (AC-07). */
function fallbackLevel(
  ladder: readonly LevelEntry[], health: Record<string, ModelHealth>,
  quarantine: Readonly<Record<string, number>> | undefined, current: string, now: number,
): string | undefined {
  for (let i = ladder.length - 1; i >= 0; i--) {
    const l = ladder[i]
    if (typeof l !== "string" || l === current) continue
    if (!isHealthy(health[l], now)) continue
    const qAt = quarantine?.[l]
    if (qAt !== undefined && now - qAt < QUARANTINE_MS) continue
    return l
  }
  return undefined
}

export class Controller {
  private warnedConsent = false // controller-global (one toast per process), not per session
  // Judge "two consecutive switch:true verdicts" streak, in memory only: a restart resets it (fail safe).
  private judgeStreak = new Map<string, number>()
  // Retry-storm tokens: sessionID -> switch enacted at. In memory only: a restart is fail safe because
  // the transcript re-read and the attribution guard reject stale events on their own.
  private storm = new Map<string, number>()
  constructor(private d: Deps) {}

  private async toast(ev: NarrationEvent, v?: Parameters<Deps["narrate"]>[1], variant: "info" | "warning" = "info", suffix = "") {
    try {
      const message = this.d.narrate(ev, v)
      if (!message) return
      await this.d.client.tui.showToast({ body: { message: message + suffix, variant } })
    } catch { /* toast is best effort */ }
  }

  private async fetchMessages(id: string): Promise<OcMessage[]> {
    const r = await this.d.client.session.messages({ path: { id } })
    return r.data ?? []
  }

  async onSessionError(sessionID: string, rawError: unknown, from?: ModelRef): Promise<boolean> {
    try {
      return await this.handle(sessionID, classify(rawError), from, errorText(rawError))
    } catch (e) {
      try { this.d.log(`onSessionError failed: ${e instanceof Error ? e.message : String(e)}`) } catch { /* ignore */ }
      return false
    }
  }

  /**
   * OpenCode retries retryable errors itself and reports them as session.status "retry" events; session.error
   * only follows after many retries. Permanent failures (quota, auth, ...) switch at once; transient ones
   * only from the second attempt, so a one-off blip is left to OpenCode.
   */
  async onRetryStatus(sessionID: string, attempt: number, message: string): Promise<void> {
    try {
      if (this.stormActive(sessionID)) return // AC-05: the old turn's retries are consumed, not re-handled
      const c = classifyRetryMessage(message)
      if (!c.switchable) return
      if (!c.permanent && !(attempt >= 2)) return
      await this.handle(sessionID, c, undefined, message)
    } catch (e) {
      try { this.d.log(`onRetryStatus failed: ${e instanceof Error ? e.message : String(e)}`) } catch { /* ignore */ }
    }
  }

  /** Owner escape hatch: the same abort/switchModel seam as failover, but plain-tail and cap-exempt. */
  async manualSwitch(sessionID: string, requested?: string): Promise<ManualSwitchResult> {
    const started = this.d.now()
    let target: string | undefined
    try {
      if (requested !== undefined) target = modelKey(parseModel(requested))
      if (!this.d.lock.tryAcquire(sessionID)) return { status: "locked" }
      try {
        const session = await this.d.client.session.get({ path: { id: sessionID } })
        if (session.data?.parentID) return { status: "unavailable" }
        const msgs = await this.fetchMessages(sessionID)
        const newest = [...msgs].reverse().find((m) => {
          const i = m.info
          return i.role === "assistant" ? !!(i.providerID && i.modelID) : !!i.model?.providerID && !!i.model.modelID
        })
        if (!newest) return { status: "unavailable" }
        const i = newest.info
        const current = i.role === "assistant" ? `${i.providerID}/${i.modelID}` : `${i.model!.providerID}/${i.model!.modelID}`
        if (target === undefined) {
          const ladder = buildLadder(this.d.cfg).filter((l): l is string => typeof l === "string")
          const start = ladder.indexOf(current)
          const tried = new Set(triedThisTurn(msgs))
          const candidates = ladder.slice(start + 1).filter((m) => m !== current && !tried.has(m) && isHealthy(this.d.health[m], started))
          target = candidates.find((m) => {
            const at = this.d.state.get(sessionID).quarantine?.[m]
            return at === undefined || started - at >= QUARANTINE_MS
          })
        }
        if (target === undefined || target === current) return { status: "bottom", from: current }

        const ex = extractFromMessages(msgs, this.d.cfg.handover)
        const text = buildHandover({ cfg: this.d.cfg, ex, from: current, to: target, reason: "quality", summary: null })
        const rec = this.d.state.get(sessionID)
        this.d.state.set(sessionID, { ...rec, pluginPinned: target, pendingHandover: { to: target, at: started }, updated: started })
        delete this.d.health[target]
        this.d.state.save()
        const superseded = await this.enactSwitch(sessionID, current, { to: parseModel(target), handoverText: text })
        if (superseded !== undefined) return { status: "unavailable", from: current, to: superseded }
        this.d.switchLog.append({ ts: started, sessionID, from: current, to: target, kind: "manual" })
        return { status: "switched", from: current, to: target, elapsedMs: Math.max(0, this.d.now() - started) }
      } finally {
        this.d.lock.release(sessionID)
      }
    } catch (e) {
      try { this.d.log(`manual switch failed: ${e instanceof Error ? e.message : String(e)}`) } catch { /* ignore */ }
      return { status: "unavailable", ...(target ? { to: target } : {}) }
    }
  }

  /**
   * Runs the switch decision. Returns whether a handover was enacted: the v2 retry hook may only veto
   * OpenCode's own retry when the relay actually took the turn over (#56). `from` (optional) is the model
   * the failure is attributed to (v2 retry events carry it); it must agree with the current turn, never
   * poison a newer model. `resetText` is the raw provider message: reset wording in it becomes a
   * reset-aware cooldown (#64 wiring).
   */
  private async handle(sessionID: string, c: Classified, from?: ModelRef, resetText?: string): Promise<boolean> {
    const d = this.d
    // A plugin-caused abort is consumed here; an unmarked abort is the user pressing Esc. Neither switches.
    if (c.kind === "user_abort") { d.lock.consumePluginAbort(sessionID); return false }
    if (!c.switchable) return false

    const session = await d.client.session.get({ path: { id: sessionID } })
    if (session.data?.parentID) return false
    if (!d.lock.tryAcquire(sessionID)) {
      // AC-06: the incident's silent drop class becomes diagnosable (metadata only, rule 8).
      d.switchLog.append({ ts: d.now(), sessionID, ...(from ? { from: modelKey(from) } : {}), kind: "switch_dropped", reason: "lock_held" })
      return false
    }
    try {
      // The transcript is read under the lock (#40): a user message arriving while a switch runs must not
      // make this failure handler blame the freshly switched (recovered) model.
      const msgs = await this.fetchMessages(sessionID)
      // The newest message identifies the failing turn: an assistant message carries the model that ran; if the
      // error came before any assistant reply (first turn, model resolution), the user message carries the model.
      const newest = msgs[msgs.length - 1]
      if (!newest) return false
      const ni = newest.info
      // The title/summary agent produces assistant messages without provider/model: ignore.
      const m = ni.role === "assistant" ? (ni.providerID && ni.modelID ? { providerID: ni.providerID, modelID: ni.modelID } : undefined) : ni.model
      if (!m?.providerID || !m.modelID) return false
      const current = `${m.providerID}/${m.modelID}`
      // Explicit attribution must agree with the current turn, never poison a newer model.
      if (from && modelKey(from) !== current) return false
      const now = d.now()
      let rec = { ...d.state.get(sessionID) } // session records are merged, never whole-record overwritten (AC-01)
      // Marker guard (#56, AC-03): marker text is untrusted; a marker newest while the session is not
      // on the plugin-set model is a stale error, and the drop is logged, never silent (AC-06).
      if (hasRelayMarker(newest.parts) && rec.pluginPinned !== current) {
        d.switchLog.append({ ts: now, sessionID, from: current, kind: "switch_dropped", reason: "marker_guard" })
        return false
      }

      if (d.lock.isDuplicate(`${sessionID}:${ni.id}`)) return false

      // Adoption grace (AC-01): failures of a just-adopted pick within the window do not re-mark it.
      const inGrace = rec.adoptedAt !== undefined && rec.pluginPinned === current && now - rec.adoptedAt < ADOPTION_GRACE_MS
      if (c.kind === "quality") {
        // The judge says quality, not failure: the model is not cooled down or blacklisted.
      } else if (!inGrace) {
        recordFailure(d.health, current, c, now, d.cfg.cooldownMs, resetText)
        // The per-session quarantine rides the record (#64 wiring): refreshed with every mark.
        d.state.set(sessionID, { ...d.state.get(sessionID), quarantine: { ...(d.state.get(sessionID).quarantine ?? {}), [current]: now }, updated: now })
        d.state.save() // health (cooldowns, blacklists) is persisted together with the session record (#39)
        rec = { ...d.state.get(sessionID) }
      }

      const ladder = buildLadder(d.cfg)
      const decision = walkFromTop({
        ladder, current, health: d.health, tried: triedThisTurn(msgs),
        quarantine: rec.quarantine, now, switchCount: rec.switchCount, maxSwitches: effectiveMaxSwitches(d.cfg),
      })
      let to: string
      if (decision.action === "switch") to = decision.to
      else {
        // AC-07 onExhausted acts: a last-resort hop to the deepest healthy level (even at the cap,
        // P1-F4); none healthy -> the /relay next hint, never a silent no-op.
        const fallback = fallbackLevel(ladder, d.health, rec.quarantine, current, now)
        if (fallback === undefined) {
          await this.toast(decision.reason === "switch_cap" ? "cap_reached" : "exhausted", {}, "warning", EXHAUSTED_HINT)
          return false
        }
        to = fallback
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

      const text = buildHandover({ cfg: d.cfg, ex, from: current, to, reason: c.kind, summary })
      const agent = [...msgs].reverse().find((m) => m.info.role === "user")?.info.agent
      // AC-04: the plugin-set model and the crash-window intent are persisted BEFORE switchModel; a
      // reload discards the intent and the next context hook re-syncs to whatever the session runs.
      const next: typeof rec = {
        ...d.state.get(sessionID), pluginPinned: to, pendingHandover: { to, at: now },
        switchCount: rec.switchCount + 1, helperCalls, updated: now,
      }
      delete next.adoptedAt // the grace window belongs to an adopted pick, never to the plugin's own switch
      d.state.set(sessionID, next)
      d.state.save()

      const supersededBy = await this.enactSwitch(sessionID, current, { to: parseModel(to), ...(agent ? { agent } : {}), handoverText: text })
      if (supersededBy !== undefined) {
        // AC-02: the pick supersedes the pending switch; adopt it under the still-held lock (merged
        // write, marks cleared once, the switchCount rolled back: nothing was enacted).
        const adopted: typeof rec = {
          ...d.state.get(sessionID), pluginPinned: supersededBy, adoptedAt: d.now(),
          switchCount: rec.switchCount, updated: d.now(),
        }
        delete adopted.pendingHandover // no switch was enacted; the intent is spent
        d.state.set(sessionID, adopted)
        delete d.health[supersededBy] // the owner chose it: cooldown, blacklist and failure count all clear, once
        d.state.save()
        d.switchLog.append({ ts: d.now(), sessionID, from: current, to: supersededBy, kind: "switch_dropped", reason: "superseded" })
        return false
      }
      this.storm.set(sessionID, now) // AC-05: retry events for the old turn are consumed from here
      if (this.storm.size >= MAX_SESSION_ENTRIES) this.storm.clear() // bound the in-memory map
      d.switchLog.append({
        ts: now, sessionID, from: current, to, kind: c.kind,
        ...(helperCost !== undefined ? { helperCostUsd: helperCost } : {}),
      })
      await this.toast("switch_done", { from: current, to, reason: c.kind })
      return true
    } finally {
      d.lock.release(sessionID)
    }
  }

  /**
   * The switch enactment, absorbed from the switcher so the AC-02 re-read can sit between the abort
   * and switchModel: abort (plugin-marked), wait, re-read the session's resolved model, then fire the
   * handover prompt without awaiting it (a prompt resolves only when the whole model turn is over).
   * Returns the pick that superseded the switch, or undefined when the prompt was fired.
   */
  private async enactSwitch(
    sessionID: string, current: string,
    a: { to: ModelRef; agent?: string; handoverText: string },
  ): Promise<string | undefined> {
    const d = this.d
    d.lock.markPluginAbort(sessionID)

    let timer: ReturnType<typeof setTimeout> | undefined
    let outcome: "ok" | "rejected" | "timeout"
    try {
      // async wrapper so a synchronous throw from abort() becomes a rejection; the
      // .then(ok, rejected) handlers also swallow a late rejection after the timeout fired.
      const abortP = (async () => d.client.session.abort({ path: { id: sessionID } }))()
        .then(() => "ok" as const, () => "rejected" as const)
      const timeoutP = new Promise<"timeout">((r) => { timer = setTimeout(() => r("timeout"), d.switchOpts?.abortTimeoutMs ?? ABORT_TIMEOUT_MS) })
      outcome = await Promise.race([abortP, timeoutP])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
    // The abort mark stays set on ok/timeout (handle() swallows the resulting MessageAbortedError);
    // cleared only when abort was rejected (no abort error will arrive).
    if (outcome === "rejected") d.lock.consumePluginAbort(sessionID)

    const delay = d.switchOpts?.abortDelayMs ?? ABORT_DELAY_MS
    if (delay > 0) await new Promise<void>((r) => { setTimeout(r, delay) })

    // AC-02: re-read the session's resolved model after the abort and before switchModel. In v2 every
    // user row carries the session's current model, so a pick that landed mid-failover is visible here.
    // In v1 user rows carry the model they were sent with, so an absent model just means "unchanged".
    const msgs = await this.fetchMessages(sessionID)
    const newestUser = [...msgs].reverse().find((m) => m.info.role === "user")
    const um = newestUser?.info.model
    if (um?.providerID && um.modelID) {
      const resolved = `${um.providerID}/${um.modelID}`
      if (resolved !== current) return resolved // the pick supersedes the pending switch
    }

    try {
      Promise.resolve(
        d.client.session.prompt({
          path: { id: sessionID },
          body: {
            model: a.to,
            ...(a.agent ? { agent: a.agent } : {}),
            parts: [{ type: "text", text: a.handoverText }],
          },
        }),
      ).catch((e: unknown) => { try { d.log(`prompt failed: ${e instanceof Error ? e.message : String(e)}`) } catch { /* ignore */ } })
    } catch (e) {
      try { d.log(`prompt failed: ${e instanceof Error ? e.message : String(e)}`) } catch { /* ignore */ }
    }
    return undefined
  }

  /**
   * session.idle: a turn completed without a plugin-seen failure. The turn's model proves itself: its
   * cooldown and blacklist clear but the failures count stays (#64 success-clears-less, wired here);
   * the entry then drops out at the next save's prune. The storm token and any pending-handover marker
   * are spent. Never throws. The quality judge (#26) runs fire-and-forget after the health mark.
   */
  async onSessionIdle(sessionID: string): Promise<void> {
    try {
      const session = await this.d.client.session.get({ path: { id: sessionID } })
      if (session.data?.parentID) return // failures are recorded on top-level sessions only; keep success symmetric
      const msgs = await this.fetchMessages(sessionID)
      const newest = [...msgs].reverse().find((m) => m.info.role === "assistant" && m.info.providerID && m.info.modelID)
      if (!newest) return
      const model = `${newest.info.providerID}/${newest.info.modelID}`
      this.storm.delete(sessionID) // the turn is over: the retry storm is spent
      const rec = this.d.state.get(sessionID)
      if (this.d.health[model] !== undefined) {
        clearSuccess(this.d.health, model)
        this.d.state.save()
      }
      if (rec.pendingHandover !== undefined) {
        const { pendingHandover: _spent, ...rest } = rec // the handover turn ended: the intent marker is spent
        this.d.state.set(sessionID, { ...rest, updated: this.d.now() })
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
   * Adopts the owner's manually picked model (AC-01): merges the record under the SessionLock (never
   * lock-free next to a failover), sets pluginPinned := pick, clears the pick's marks once and opens
   * the grace window. When the lock is held the adoption is skipped: the failover's post-abort re-read
   * adopts the pick instead (or its switch supersedes it). Never throws.
   */
  adoptPick(sessionID: string, pick: string): void {
    const d = this.d
    let locked = false
    try {
      locked = d.lock.tryAcquire(sessionID)
      if (!locked) return
      const now = d.now()
      d.state.set(sessionID, { ...d.state.get(sessionID), pluginPinned: pick, adoptedAt: now, updated: now })
      delete d.health[pick] // the owner chose it: cooldown, blacklist and failure count all clear, once
      d.state.save()
    } catch {
      /* adoption never throws into the host */
    } finally {
      if (locked) d.lock.release(sessionID)
    }
  }

  /**
   * True when a switch was enacted for this session within RETRY_STORM_MS and the retrying model is
   * not the plugin-set one: the event belongs to the old, already-failed-over turn and is consumed (AC-05).
   */
  stormActive(sessionID: string, fromKey?: string): boolean {
    const at = this.storm.get(sessionID)
    if (at === undefined) return false
    if (this.d.now() - at >= RETRY_STORM_MS) { this.storm.delete(sessionID); return false }
    if (fromKey !== undefined && fromKey === this.d.state.get(sessionID).pluginPinned) return false
    return true
  }

  /**
   * Load-time crash-window validation (AC-04): pluginPinned values that no longer resolve to a
   * configured level are dropped silently; the next context hook re-syncs to the runtime's model.
   */
  validatePersistedPins(): void {
    const known = new Set(buildLadder(this.d.cfg).filter((l): l is string => typeof l === "string"))
    this.d.state.validatePinned(known)
    this.d.state.save()
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
      // The judge never evaluates level 1 (AC-09): that model is the owner's chosen primary, and
      // judging it would risk switching the session away from it on one bad turn.
      if (buildLadder(d.cfg)[0] === current) return
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
      if (this.judgeStreak.size >= MAX_SESSION_ENTRIES) this.judgeStreak.clear() // bound the in-memory map
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
   * chat.message (v1 hook contract, server.ts): stay-put (#66). The pin machinery is gone and the turn
   * always keeps the session's model; v2 adoption lives in the context hook. Never throws.
   */
  onChatMessage(_sessionID: string, _inputModelKey: string, _parts: unknown): string | undefined {
    return undefined
  }

  status(sessionID?: string): string {
    const d = this.d
    const rec = sessionID ? d.state.get(sessionID) : undefined
    const chain = buildLadder(d.cfg).map((l) => (typeof l === "string" ? l : "(unresolved find)")).join(" -> ")
    return [
      `chain: ${chain || "(no levels configured)"}`,
      `pinned: ${rec?.pluginPinned ?? "none"}`,
      `switches: ${rec?.switchCount ?? 0}`,
      `consent: ${d.cfg.privacy.consent ? "on" : "off"}`,
      `key: ${d.env[d.cfg.openrouter.keyEnv] ? "set" : "missing"}`,
    ].join("\n")
  }
}

// (No module-scope helpers follow the class: the judge reads the clock through the local `now` above.)
