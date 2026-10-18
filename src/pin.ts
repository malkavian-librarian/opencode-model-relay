import type { SessionRecord } from "./state"
import { recoverTarget, type ModelHealth, type Mode } from "./strategy"

export type PinDecision =
  | { action: "pin"; to: string }
  | { action: "clear" }
  | { action: "none" }
  // chain-recover: send this turn to `to`; clearSticky when `to` is the session's origin (nothing left to pin).
  | { action: "recover"; to: string; clearSticky: boolean }

/**
 * Decides what the chat.message hook does with a new user turn. Without `recovery` (or in any mode other than
 * chain-recover) this is the v1.0 sticky rule. In chain-recover, a turn arriving on the origin or the sticky
 * model returns to the highest-priority healthy model ranked above the sticky one. An explicit pick of any
 * other model still clears stickiness first: the user's choice always wins over recovery.
 */
export function decidePin(
  rec: SessionRecord, inputModelKey: string,
  recovery?: { mode: Mode; chain: string[]; health: Record<string, ModelHealth>; now: number },
): PinDecision {
  if (!rec.sticky) return { action: "none" }
  const onOrigin = inputModelKey === rec.origin
  if (inputModelKey !== rec.sticky && !onOrigin) return { action: "clear" }
  if (recovery?.mode === "chain-recover") {
    const to = recoverTarget({ chain: recovery.chain, sticky: rec.sticky, health: recovery.health, now: recovery.now })
    if (to) return { action: "recover", to, clearSticky: to === rec.origin }
  }
  return onOrigin && inputModelKey !== rec.sticky ? { action: "pin", to: rec.sticky } : { action: "none" }
}
