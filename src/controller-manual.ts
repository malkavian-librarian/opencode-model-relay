import { buildLadder, isValidDiscoveredModelId, triedThisTurn, walkFromTopAsync, type FindResolutionInput } from "./strategy"
import { buildHandover, extractFromMessages } from "./handover"
import { modelKey, parseModel, type ModelRef, type OcMessage } from "./types"
import type { Deps, ManualSwitchResult } from "./controller"

export async function manualSwitch(input: {
  d: Deps
  sessionID: string
  requested?: string
  fetchMessages: (id: string) => Promise<OcMessage[]>
  findInput: (current: string, sessionID: string, now: number) => FindResolutionInput
  enactSwitch: (sessionID: string, current: string, options: { to: ModelRef; handoverText: string }) => Promise<string | undefined>
  led: (fields: import("./ledger").EventInput) => void
}): Promise<ManualSwitchResult> {
  const { d, sessionID, requested, fetchMessages, findInput, enactSwitch, led } = input
  const started = d.now()
  let target: string | undefined
  try {
    if (requested !== undefined) target = modelKey(parseModel(requested))
    if (!d.lock.tryAcquire(sessionID)) return { status: "locked" }
    try {
      const session = await d.client.session.get({ path: { id: sessionID } })
      if (session.data?.parentID) return { status: "unavailable" }
      const msgs = await fetchMessages(sessionID)
      const newest = [...msgs].reverse().find((m) => m.info.role === "assistant" ? !!(m.info.providerID && m.info.modelID) : !!m.info.model?.providerID && !!m.info.model.modelID)
      if (!newest) return { status: "unavailable" }
      const i = newest.info
      const current = i.role === "assistant" ? `${i.providerID}/${i.modelID}` : `${i.model!.providerID}/${i.model!.modelID}`
      if (target === undefined) {
        const ladder = buildLadder(d.cfg)
        let start = ladder.indexOf(current)
        if (start < 0) start = ladder.findIndex((l) => {
          if (typeof l === "string") return false
          if (d.state.getFindCache(JSON.stringify(l), started) === current) return true
          const remote = l.find.via === "openrouter"
          const id = remote ? (current.startsWith("openrouter/") ? current.slice("openrouter/".length) : undefined) : current
          return isValidDiscoveredModelId(id) && (remote || !l.find.free || id.endsWith("-free")) && new RegExp(l.find.match).test(id)
        })
        const decision = await walkFromTopAsync({ ...findInput(current, sessionID, started), ladder: ladder.slice(start + 1), tried: triedThisTurn(msgs), switchCount: 0, maxSwitches: Infinity, allowQuarantined: false })
        if (decision.action === "switch") target = decision.to
      }
      if (target === undefined || target === current) return { status: "bottom", from: current }
      const ex = extractFromMessages(msgs, d.cfg.handover)
      const text = buildHandover({ cfg: d.cfg, ex, from: current, to: target, reason: "quality", summary: null })
      const rec = d.state.get(sessionID)
      const next = { ...rec, pluginPinned: target, pendingHandover: { to: target, at: started }, updated: started }
      delete next.circularOrigin; delete next.circularFindKey; delete next.circularTransitions; delete next.circularFlows
      d.state.set(sessionID, next)
      delete d.health[target]
      d.state.save()
      const superseded = await enactSwitch(sessionID, current, { to: parseModel(target), handoverText: text })
      if (superseded !== undefined) return { status: "unavailable", from: current, to: superseded }
      d.switchLog.append({ ts: started, sessionID, from: current, to: target, kind: "manual", elapsedMs: Math.max(0, d.now() - started) })
      led({ ts: started, sessionID, event: "switch", sw: { kind: "manual", from: current, to: target } })
      return { status: "switched", from: current, to: target, elapsedMs: Math.max(0, d.now() - started) }
    } finally { d.lock.release(sessionID) }
  } catch (e) {
    try { d.log(`manual switch failed: ${e instanceof Error ? e.message : String(e)}`) } catch { /* ignore */ }
    return { status: "unavailable", ...(target ? { to: target } : {}) }
  }
}
