import type { OcMessage } from "./types"
import { hasRelayMarker } from "./strategy"

/** Suspicion reasons; a empty list means the turn looked healthy and no LLM judge call is needed. */
export type HeuristicReason = "loop" | "repeated_tool_errors" | "no_output"

export interface TurnObservation {
  // The turn contained an assistant message at all; "no_output" only counts when there was one to produce.
  sawAssistant: boolean
  assistantText: boolean
  successfulTool: boolean
  maxRepeatedCalls: number
  maxConsecutiveErrors: number
}

const MAX_TRACKED_CALLS = 100
const REPEATED_THRESHOLD = 3
const CONSECUTIVE_ERRORS = 3

/**
 * Cheap, purely local view of the turn the judge evaluates: everything from the newest real user message
 * on (our own handover prompts carry RELAY_MARKER and belong to the same turn being judged). Never throws.
 */
export function observeTurn(msgs: unknown): TurnObservation {
  const obs: TurnObservation = { sawAssistant: false, assistantText: false, successfulTool: false, maxRepeatedCalls: 0, maxConsecutiveErrors: 0 }
  if (!Array.isArray(msgs)) return obs

  let start = -1
  for (let k = msgs.length - 1; k >= 0; k--) {
    const m = msgs[k] as OcMessage
    if (m?.info?.role === "user" && !hasRelayMarker(m.parts)) { start = k; break }
  }
  if (start === -1) return obs

  // Identical (tool, input) identity is the loop signal: the same call against the same state again and again.
  const identities = new Map<string, number>()
  let errorRun = 0
  for (let i = start; i < msgs.length && identities.size <= MAX_TRACKED_CALLS; i++) {
    const m = msgs[i] as OcMessage
    if (!m || typeof m !== "object" || !Array.isArray(m.parts)) continue
    if (m.info?.role === "assistant") obs.sawAssistant = true
    for (const p of m.parts) {
      if (!p || typeof p !== "object") continue
      const t = p as { type?: unknown; text?: unknown; tool?: unknown; state?: { status?: unknown; input?: unknown } }
      if (t.type === "text" && m.info?.role === "assistant" && typeof t.text === "string" && t.text.trim() !== "")
        obs.assistantText = true
      else if (t.type === "tool" && m.info?.role === "assistant") {
        const name = typeof t.tool === "string" ? t.tool : "unknown"
        const status = t.state && typeof t.state === "object" ? t.state.status : undefined
        if (status === "completed") obs.successfulTool = true

        // Identical repeated calls count as a loop signal whether or not they error; a run of failing
        // tool calls is the other signal ("progress lost").
        let same = name
        try {
          if (t.state && typeof t.state === "object" && t.state.input && typeof t.state.input === "object")
            same = `${name} ${JSON.stringify(t.state.input)}`
        } catch { /* circular or hostile input: compare by tool name only */ }
        identities.set(same, (identities.get(same) ?? 0) + 1)
        obs.maxRepeatedCalls = Math.max(obs.maxRepeatedCalls, identities.get(same) as number)

        if (status === "error") errorRun++
        else errorRun = 0
        obs.maxConsecutiveErrors = Math.max(obs.maxConsecutiveErrors, errorRun)
      }
    }
  }
  // Without an assistant message there was no judging turn at all, so nothing is suspicious.
  return obs
}

export function heuristicReasons(obs: TurnObservation): HeuristicReason[] {
  const out: HeuristicReason[] = []
  if (obs.maxRepeatedCalls >= REPEATED_THRESHOLD) out.push("loop")
  if (obs.maxConsecutiveErrors >= CONSECUTIVE_ERRORS) out.push("repeated_tool_errors")
  if (obs.sawAssistant && !obs.assistantText && !obs.successfulTool) out.push("no_output")
  return out
}
