import type { ClientLike, ModelRef, OcMessage } from "./types"
import { modelKey, parseModel } from "./types"
import type { RelayConfig } from "./config"
import { classify, classifyRetryMessage } from "./classifier"
import type { Classified } from "./types"
import {
  buildLadder, clearSuccess, effectiveMaxSwitches, hasRelayMarker, recordFailure, triedThisTurn,
  isValidDiscoveredModelId, walkCircular, walkFromTopAsync, type FindResolutionInput, type ModelHealth,
} from "./strategy"
import { FIND_CACHE_TTL_MS } from "./state"
import { heuristicReasons, observeTurn } from "./heuristics"
import { buildJudgeInput, parseVerdict } from "./judge"
import type { SessionLock } from "./session-lock"
import type { StateStore } from "./state"
import type { createNarrator, NarrationEvent } from "./narrator"
import type { SwitchLog, SwitchLogRow } from "./switchlog"
import type { orChat } from "./openrouter"
import { buildHandover, extractFromMessages, writeNarrative } from "./handover"
import type { EventInput } from "./ledger"
import { manualSwitch as runManualSwitch } from "./controller-manual"
import { runJudge as runQualityJudge } from "./controller-judge"
import { buildStatus } from "./controller-status"
import { stormActive as isStormActive, validatePersistedPins as validatePins } from "./controller-state"

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
  switchLog: { append: SwitchLog["append"]; recent?: (limit?: number) => SwitchLogRow[] }
  ledger?: { append: (fields: EventInput) => boolean }
  env: Record<string, string | undefined>
  now: () => number
  chat: typeof orChat
  log: (m: string) => void
  switchOpts?: { abortTimeoutMs?: number; abortDelayMs?: number }
  fetchCatalog?: FindResolutionInput["fetchCatalog"]
  openCodeModels?: FindResolutionInput["openCodeModels"]
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

  private findInput(current: string, sessionID: string, now: number): FindResolutionInput {
    return {
      current, health: this.d.health, quarantine: this.d.state.get(sessionID).quarantine, now,
      consent: this.d.cfg.privacy.consent, fetchCatalog: this.d.fetchCatalog,
      openCodeModels: this.d.openCodeModels, cache: this.d.state,
    }
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

  /** Metadata-only ledger append (best effort, #7): never throws and never changes session behavior. */
  private led(fields: EventInput): void {
    try { this.d.ledger?.append(fields) } catch { /* hooks never throw */ }
  }

  private tierOf(model: string): number | undefined {
    const i = buildLadder(this.d.cfg).indexOf(model)
    return i >= 0 ? i + 1 : undefined
  }

  /** Owner escape hatch: the same abort/switchModel seam as failover, but plain-tail and cap-exempt. */
  async manualSwitch(sessionID: string, requested?: string): Promise<ManualSwitchResult> {
    return runManualSwitch({
      d: this.d, sessionID, requested,
      fetchMessages: (id) => this.fetchMessages(id),
      findInput: (current, sid, now) => this.findInput(current, sid, now),
      enactSwitch: (sid, current, options) => this.enactSwitch(sid, current, options),
      led: (fields) => this.led(fields),
    })
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
    const started = d.now()
    // A plugin-caused abort is consumed here; an unmarked abort is the user pressing Esc. Neither switches.
    if (c.kind === "user_abort") { d.lock.consumePluginAbort(sessionID); return false }
    if (!c.switchable) return false

    const session = await d.client.session.get({ path: { id: sessionID } })
    if (session.data?.parentID) return false
    if (!d.lock.tryAcquire(sessionID)) {
      // AC-06: the incident's silent drop class becomes diagnosable (metadata only, rule 8).
      d.switchLog.append({ ts: d.now(), sessionID, ...(from ? { from: modelKey(from) } : {}), kind: "switch_dropped", reason: "lock_held", elapsedMs: Math.max(0, d.now() - started) })
      this.led({ ts: d.now(), sessionID, event: "switch", sw: { kind: "switch_dropped", reason: "lock_held", ...(from ? { from: modelKey(from) } : {}) } })
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
      const ladder = buildLadder(d.cfg)
      const circularCurrentFind = d.cfg.maxCircularFlows > 0
        ? ladder.find((level) => typeof level !== "string" && (d.state.getFindCache(JSON.stringify(level), now) === current || rec.circularFindKey === JSON.stringify(level)))
        : undefined
      // Marker guard (#56, AC-03): marker text is untrusted; a marker newest while the session is not
      // on the plugin-set model is a stale error, and the drop is logged, never silent (AC-06).
      if (hasRelayMarker(newest.parts) && rec.pluginPinned !== current) {
        d.switchLog.append({ ts: now, sessionID, from: current, kind: "switch_dropped", reason: "marker_guard", elapsedMs: Math.max(0, d.now() - started) })
        this.led({ ts: now, sessionID, event: "switch", sw: { kind: "switch_dropped", reason: "marker_guard", from: current } })
        return false
      }

      if (d.lock.isDuplicate(`${sessionID}:${ni.id}`)) return false

      // Adoption grace (AC-01): failures of a just-adopted pick within the window do not re-mark it.
      const inGrace = rec.adoptedAt !== undefined && rec.pluginPinned === current && now - rec.adoptedAt < ADOPTION_GRACE_MS
      if (c.kind === "quality") {
        // The judge says quality, not failure: the model is not cooled down or blacklisted.
      } else if (!inGrace) {
        recordFailure(d.health, current, c, now, d.cfg.cooldownMs, resetText)
        // Count accepted marks, not rejected/graced errors or only successfully enacted switches.
        this.led({ ts: now, sessionID, event: "failure", errorKind: c.kind, model: current, tier: this.tierOf(current) })
        for (const [key, cached] of Object.entries(d.state.findCache)) {
          if (cached.model === current) d.state.invalidateFindCache(key)
        }
        // The per-session quarantine rides the record (#64 wiring): refreshed with every mark.
        d.state.set(sessionID, { ...d.state.get(sessionID), quarantine: { ...(d.state.get(sessionID).quarantine ?? {}), [current]: now }, updated: now })
        d.state.save() // health (cooldowns, blacklists) is persisted together with the session record (#39)
        rec = { ...d.state.get(sessionID) }
      }

      const input = this.findInput(current, sessionID, now)
      const decision = d.cfg.maxCircularFlows > 0
        ? walkCircular({
          ...input, ladder, switchCount: rec.switchCount, maxSwitches: effectiveMaxSwitches(d.cfg), maxCircularFlows: d.cfg.maxCircularFlows,
          circularFlows: rec.circularFlows,
          resolveFind: (entry) => circularCurrentFind && JSON.stringify(entry) === JSON.stringify(circularCurrentFind)
            ? current : d.state.getFindCache(JSON.stringify(entry), now),
        })
        : await walkFromTopAsync({ ...input, ladder, tried: triedThisTurn(msgs), switchCount: rec.switchCount, maxSwitches: effectiveMaxSwitches(d.cfg) })
      let to: string
      if (decision.action === "switch") to = decision.to
      else {
        if (d.cfg.maxCircularFlows > 0 && decision.reason === "switch_cap") {
          await this.toast("cap_reached", {}, "warning", EXHAUSTED_HINT)
          return false
        }
        // AC-07 onExhausted acts: a last-resort hop to the deepest healthy level (even at the cap,
        // P1-F4); none healthy -> the /relay next hint, never a silent no-op.
        const fallback = await walkFromTopAsync({
          ...input, ladder: [...ladder].reverse(), switchCount: 0, maxSwitches: Infinity, allowQuarantined: false,
        })
        if (fallback.action !== "switch") {
          await this.toast(decision.reason === "switch_cap" ? "cap_reached" : "exhausted", {}, "warning", EXHAUSTED_HINT)
          return false
        }
        to = fallback.to
      }

      const ex = extractFromMessages(msgs, d.cfg.handover)
      const key = d.env[d.cfg.openrouter.keyEnv]
      const helperCalls = rec.helperCalls ?? 0
      const narrativeDeferred = d.cfg.privacy.consent && !!key && helperCalls < d.cfg.handover.maxCallsPerSession
      if ((!d.cfg.privacy.consent || !key) && !this.warnedConsent) {
        // no consent, or consent without a key: nothing is sent anywhere; tell the user once
        this.warnedConsent = true
        await this.toast(d.cfg.privacy.consent ? "no_key" : "no_consent")
      }

      const text = buildHandover({ cfg: d.cfg, ex, from: current, to, reason: c.kind, summary: null, narrativeDeferred })
      const agent = [...msgs].reverse().find((m) => m.info.role === "user")?.info.agent
      // AC-04: the plugin-set model and the crash-window intent are persisted BEFORE switchModel; a
      // reload discards the intent and the next context hook re-syncs to whatever the session runs.
      const next: typeof rec = {
        ...d.state.get(sessionID), pluginPinned: to, pendingHandover: { to, at: now },
        switchCount: rec.switchCount + 1, helperCalls, updated: now,
      }
      if (d.cfg.maxCircularFlows > 0) {
        const selectedFindEntry = ladder.find((level) => typeof level !== "string" && d.state.getFindCache(JSON.stringify(level), now) === to)
        const selectedFindKey = selectedFindEntry === undefined ? undefined : JSON.stringify(selectedFindEntry)
        const onLadder = circularCurrentFind !== undefined || ladder.some((level) => level === current)
        const origin = rec.circularOrigin ?? (onLadder ? current : to)
        const transitions = (rec.circularTransitions ?? 0) + 1
        const completed = (rec.circularFlows ?? 0) + (to === origin && transitions >= 2 ? 1 : 0)
        next.circularOrigin = origin
        if (selectedFindKey) next.circularFindKey = selectedFindKey
        else delete next.circularFindKey
        next.circularTransitions = to === origin && transitions >= 2 ? 0 : transitions
        next.circularFlows = completed
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
        delete adopted.circularOrigin; delete adopted.circularFindKey; delete adopted.circularTransitions; delete adopted.circularFlows
        delete adopted.pendingHandover // no switch was enacted; the intent is spent
        d.state.set(sessionID, adopted)
        delete d.health[supersededBy] // the owner chose it: cooldown, blacklist and failure count all clear, once
        d.state.save()
        d.switchLog.append({ ts: d.now(), sessionID, from: current, to: supersededBy, kind: "switch_dropped", reason: "superseded", elapsedMs: Math.max(0, d.now() - started) })
        this.led({ ts: d.now(), sessionID, event: "switch", sw: { kind: "switch_dropped", reason: "superseded", from: current, to: supersededBy } })
        return false
      }
      if (narrativeDeferred) {
        // Only an enacted switch spends an attempt; persist it under the lock before the writer starts.
        d.state.set(sessionID, { ...d.state.get(sessionID), helperCalls: helperCalls + 1, updated: d.now() })
        d.state.save()
      }
      this.storm.set(sessionID, now) // AC-05: retry events for the old turn are consumed from here
      if (this.storm.size >= MAX_SESSION_ENTRIES) this.storm.clear() // bound the in-memory map
      d.switchLog.append({
        ts: now, sessionID, from: current, to, kind: c.kind, elapsedMs: Math.max(0, d.now() - started),
      })
      this.led({ ts: now, sessionID, event: "switch", sw: { kind: c.kind, from: current, to } })
      await this.toast("switch_done", { from: current, to, reason: c.kind })
      if (narrativeDeferred && key) {
        void (async () => {
          // User rows identify turns; assistant rows may grow while the resumed turn runs.
          const resumed = await this.fetchMessages(sessionID)
          const turnID = [...resumed].reverse().find((m) => m.info.role === "user")?.info.id
          const w = await writeNarrative({ chat: d.chat, cfg: d.cfg, key }, ex)
          if (!w) { await this.toast("handover_failed", {}, "warning"); return }
          // Successful helper work is spent even when delivery below is stale or unavailable.
          if (w.costUsd !== undefined) this.led({ ts: d.now(), sessionID, event: "narrative", model: current, tier: this.tierOf(current), helperCostUsd: w.costUsd })
          if (!d.lock.tryAcquire(sessionID)) return
          try {
            const latest = await this.fetchMessages(sessionID)
            const fresh = d.state.get(sessionID)
            const lastUser = [...latest].reverse().find((m) => m.info.role === "user")
            const info = latest[latest.length - 1]?.info
            const model = info?.role === "assistant" ? (info.providerID && info.modelID ? `${info.providerID}/${info.modelID}` : undefined)
              : info?.model ? modelKey(info.model) : undefined
            // The intent identity also rejects a switch away and back to the same model. No await
            // may separate these checks from dispatch; the lock covers all state reads and the prompt.
            if (!turnID || lastUser?.info.id !== turnID || model !== to || fresh.pluginPinned !== to ||
              fresh.pendingHandover !== next.pendingHandover || fresh.adoptedAt !== undefined) return
            const deferred = buildHandover({ cfg: d.cfg, ex, from: current, to, reason: c.kind, summary: w.summary })
            Promise.resolve(d.client.session.prompt({
              path: { id: sessionID },
              body: { model: parseModel(to), ...(agent ? { agent } : {}), parts: [{ type: "text", text: deferred }] },
            })).catch((e: unknown) => { try { d.log(`deferred narrative prompt failed: ${e instanceof Error ? e.message : String(e)}`) } catch { /* ignore */ } })
          } catch (e) {
            try { d.log(`deferred narrative prompt failed: ${e instanceof Error ? e.message : String(e)}`) } catch { /* ignore */ }
          } finally {
            d.lock.release(sessionID)
          }
        })().catch(() => { /* narrative is best effort and never affects the resumed session */ })
      }
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
      // Turn metadata is defensive: only fields the host actually provides survive the zod schema (rule 8).
      const src = newest.info as typeof newest.info & { tokens?: { input?: unknown; output?: unknown }; time?: { running?: unknown } }
      const int = (v: unknown): number | undefined => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined)
      const ms = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined)
      const tin = int(src.tokens?.input); const tout = int(src.tokens?.output)
      const lat = ms(src.time?.running)
      this.led({
        ts: this.d.now(), sessionID, event: "turn", model, tier: this.tierOf(model),
        ...(tin !== undefined && tout !== undefined ? { tokens: { input: tin, output: tout } } : {}),
        ...(lat !== undefined ? { latencyMs: lat } : {}),
        ...(ms(src.cost) !== undefined ? { cost: src.cost } : {}),
      })
      this.storm.delete(sessionID) // the turn is over: the retry storm is spent
      const rec = this.d.state.get(sessionID)
      if (this.d.health[model] !== undefined) {
        clearSuccess(this.d.health, model)
        this.d.state.save()
      }
      if (rec.pendingHandover !== undefined) {
        const { pendingHandover: _spent, circularOrigin: _origin, circularFindKey: _findKey, circularTransitions: _transitions, circularFlows: _flows, ...rest } = rec // the handover turn ended: the intent marker is spent
        this.d.state.set(sessionID, { ...rest, updated: this.d.now() })
        this.d.state.save()
      }
      else if (rec.circularOrigin !== undefined || rec.circularFindKey !== undefined || rec.circularTransitions !== undefined || rec.circularFlows !== undefined) {
        const { circularOrigin: _origin, circularFindKey: _findKey, circularTransitions: _transitions, circularFlows: _flows, ...rest } = rec
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
      const adopted = { ...d.state.get(sessionID), pluginPinned: pick, adoptedAt: now, updated: now }
      delete adopted.circularOrigin; delete adopted.circularFindKey; delete adopted.circularTransitions; delete adopted.circularFlows
      d.state.set(sessionID, adopted)
      delete d.health[pick] // the owner chose it: cooldown, blacklist and failure count all clear, once
      d.state.save()
    } catch {
      /* adoption never throws into the host */
    } finally {
      if (locked) d.lock.release(sessionID)
    }
  }
  stormActive(sessionID: string, fromKey?: string): boolean { return isStormActive(this.d, this.storm, sessionID, fromKey) }
  validatePersistedPins(): void { validatePins(this.d) }
  /** Quality judge wrapper; the policy implementation lives outside the switch controller. */
  private async runJudge(sessionID: string, current: string, msgs: OcMessage[]): Promise<void> {
    await runQualityJudge({
      d: this.d, sessionID, current, msgs, judgeStreak: this.judgeStreak,
      fetchMessages: (id) => this.fetchMessages(id),
      handle: (sid) => this.handle(sid, { kind: "quality", retryable: false, permanent: false, switchable: true }),
      led: (fields) => this.led(fields),
      tierOf: (model) => this.tierOf(model),
    })
  }
  /**
   * chat.message (v1 hook contract, server.ts): stay-put (#66). The pin machinery is gone and the turn
   * always keeps the session's model; v2 adoption lives in the context hook. Never throws.
   */
  onChatMessage(_sessionID: string, _inputModelKey: string, _parts: unknown): string | undefined {
    return undefined
  }
  status(sessionID?: string): string { return buildStatus(this.d, sessionID) }
}
// (No module-scope helpers follow the class: controller policy lives in focused modules.)
