import { buildLadder, hasRelayMarker } from "./strategy"
import { heuristicReasons, observeTurn } from "./heuristics"
import { buildJudgeInput, parseVerdict } from "./judge"
import { extractFromMessages } from "./handover"
import type { Deps } from "./controller"
import type { OcMessage } from "./types"
import type { EventInput } from "./ledger"

const MAX_SESSION_ENTRIES = 500

/** Runs the quality policy independently of switch orchestration while preserving persisted caps. */
export async function runJudge(input: {
  d: Deps
  sessionID: string
  current: string
  msgs: OcMessage[]
  judgeStreak: Map<string, number>
  fetchMessages: (id: string) => Promise<OcMessage[]>
  handle: (sessionID: string, kind: "quality") => Promise<boolean>
  led: (fields: EventInput) => void
  tierOf: (model: string) => number | undefined
}): Promise<void> {
  const { d, sessionID, current, msgs, judgeStreak, fetchMessages, handle, led, tierOf } = input
  try {
    const cfg = d.cfg.judge
    if (!cfg.enabled || buildLadder(d.cfg)[0] === current) return
    const key = d.env[d.cfg.openrouter.keyEnv]
    if (!d.cfg.privacy.consent || !key) return
    const last = msgs[msgs.length - 1]
    if (!last || last.info.role !== "assistant") return
    const output = last.info.tokens?.output
    if (typeof output !== "number" || !Number.isFinite(output) || output <= 0) return
    const lastUser = [...msgs].reverse().find((m) => m.info.role === "user")
    if (!lastUser || hasRelayMarker(lastUser.parts)) return
    const rec = d.state.get(sessionID)
    if ((rec.judgeCalls ?? 0) >= cfg.maxCallsPerSession) return
    const now = d.now()
    if (now < (rec.lastJudgeAt ?? 0) + cfg.minIntervalMs || last.info.id === rec.lastJudgeMessageId) return
    const daily = d.state.judgeDaily
    const today = new Date(now).toISOString().slice(0, 10)
    if (daily.date !== today) { daily.calls = undefined; daily.costUsd = undefined; daily.date = today }
    if (daily.costUsd !== undefined && daily.costUsd >= cfg.maxDailyUsd) return
    if (d.lock.isDuplicate(`${sessionID}:judge:${last.info.id}`)) return
    const reasons = heuristicReasons(observeTurn(msgs))
    if (reasons.length === 0) { judgeStreak.delete(sessionID); return }
    const judgeCalls = (rec.judgeCalls ?? 0) + 1
    daily.calls = (daily.calls ?? 0) + 1
    d.state.set(sessionID, { ...d.state.get(sessionID), judgeCalls, lastJudgeAt: now, lastJudgeMessageId: last.info.id, updated: now })
    d.state.save()
    const ex = extractFromMessages(msgs, d.cfg.handover)
    const { payload, call } = buildJudgeInput(ex, reasons)
    const r = await d.chat({ baseUrl: d.cfg.openrouter.baseUrl, key, model: cfg.model, system: cfg.prompt, user: payload, maxTokens: call.maxTokens, timeoutMs: call.timeoutMs, zdr: d.cfg.privacy.zdr })
    const cost = typeof r.costUsd === "number" && Number.isFinite(r.costUsd) && r.costUsd >= 0 ? r.costUsd : 0
    daily.costUsd = (daily.costUsd ?? 0) + cost
    d.state.save()
    const verdict = parseVerdict(r.text)
    if (!verdict) return
    led({ ts: d.now(), sessionID, event: "judge", verdict: verdict.switch ? "switch" : "stay", tier: tierOf(current), model: current, helperCostUsd: cost > 0 ? cost : undefined })
    const streak = verdict.switch ? (judgeStreak.get(sessionID) ?? 0) + 1 : 0
    if (streak <= 0) { judgeStreak.delete(sessionID); return }
    if (judgeStreak.size >= MAX_SESSION_ENTRIES) judgeStreak.clear()
    judgeStreak.set(sessionID, streak)
    if (streak < 2) return
    judgeStreak.delete(sessionID)
    const nowMsgs = await fetchMessages(sessionID)
    if (nowMsgs[nowMsgs.length - 1]?.info.id !== last.info.id) return
    await handle(sessionID, "quality")
  } catch (e) {
    try { d.log(`runJudge failed: ${e instanceof Error ? e.message : String(e)}`) } catch { /* ignore */ }
  }
}
