import { buildLadder } from "./strategy"
import type { Deps } from "./controller"

const RETRY_STORM_MS = 30_000

/** Reports whether a recent automatic switch should consume an old retry event. */
export function stormActive(d: Deps, storm: Map<string, number>, sessionID: string, fromKey?: string): boolean {
  const at = storm.get(sessionID)
  if (at === undefined) return false
  if (d.now() - at >= RETRY_STORM_MS) { storm.delete(sessionID); return false }
  if (fromKey !== undefined && fromKey === d.state.get(sessionID).pluginPinned) return false
  return true
}

/** Drops persisted pins that no longer resolve in the configured ladder. */
export function validatePersistedPins(d: Deps): void {
  const known = new Set(buildLadder(d.cfg).filter((l): l is string => typeof l === "string"))
  d.state.validatePinned(known)
  d.state.save()
}
