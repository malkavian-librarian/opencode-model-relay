import type { SessionRecord } from "./state"

export function decidePin(rec: SessionRecord, inputModelKey: string):
  { action: "pin"; to: string } | { action: "clear" } | { action: "none" } {
  if (!rec.sticky) return { action: "none" }
  if (inputModelKey === rec.sticky) return { action: "none" }
  if (inputModelKey === rec.origin) return { action: "pin", to: rec.sticky }
  return { action: "clear" }
}
