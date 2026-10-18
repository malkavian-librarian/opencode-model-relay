import type { SessionRecord } from "./state"
import { recoverTarget, type ModelHealth, type Mode } from "./strategy"

export type PinDecision =
  | { action: "pin"; to: string }
  | { action: "clear" }
  | { action: "none" }
  // chain-recover: send this turn to `to`. clearSticky only when the turn already arrives on `to` (nothing left
  // to pin); otherwise the caller keeps sticky=`to` so later turns on the incoming model stay pinned.
  | { action: "recover"; to: string; clearSticky: boolean }

/**
 * Decides what the chat.message hook does with a new user turn. Without `recovery` (or in any mode other than
 * chain-recover) this is the v1.0 sticky rule. In chain-recover, a turn arriving on the origin, the last
 * re-pinned model or the sticky one returns to the highest-priority healthy model ranked above the sticky one.
 * An explicit pick of any other model still clears stickiness first: the user's choice always wins.
 * Which model the TUI sends after a plugin prompt (origin, sticky or the last pinned-from model) is
 * unconfirmed (#19); all are treated as "the TUI is here", not as a user pick.
 */
export function decidePin(
  rec: SessionRecord, inputModelKey: string,
  recovery?: { mode: Mode; chain: string[]; health: Record<string, ModelHealth>; now: number },
): PinDecision {
  if (!rec.sticky) return { action: "none" }
  // lastPin: the model the turn arrived on when we re-pinned after a recovery (the TUI kept sending it).
  const onSessionModel = inputModelKey === rec.origin || inputModelKey === rec.lastPin
  if (inputModelKey !== rec.sticky && !onSessionModel) return { action: "clear" }
  if (recovery?.mode === "chain-recover") {
    const to = recoverTarget({ chain: recovery.chain, sticky: rec.sticky, health: recovery.health, now: recovery.now })
    if (to) return { action: "recover", to, clearSticky: to === inputModelKey }
  }
  return onSessionModel && inputModelKey !== rec.sticky ? { action: "pin", to: rec.sticky } : { action: "none" }
}
