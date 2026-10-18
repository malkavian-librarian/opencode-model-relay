export type NarrationEvent = "switch_done" | "exhausted" | "cap_reached" | "no_consent" | "no_key" | "handover_failed" | "config_invalid"
type Vars = { from?: string; to?: string; reason?: string; detail?: string }
type Verbosity = "off" | "quiet" | "normal" | "chatty"

const POOLS: Record<NarrationEvent, string[]> = {
  switch_done: [
    "[relay] {from} stopped ({reason}). Continuing on {to}.",
    "[relay] Switched {from} -> {to} ({reason}).",
  ],
  exhausted: [
    "[relay] No healthy model left in the chain. Staying put.",
    "[relay] No healthy model available: every model in the chain is unavailable right now.",
  ],
  cap_reached: [
    "[relay] Switch limit for this session reached. Not switching again.",
    "[relay] Too many switches in this session (limit reached); stopping here.",
  ],
  no_consent: [
    "[relay] Running local-only: set privacy.consent to enable LLM handover summaries.",
    "[relay] Handover summaries are off (no consent). Using the plain transcript tail.",
  ],
  no_key: [
    "[relay] Handover summaries need an OpenRouter key: set the environment variable named in openrouter.keyEnv.",
    "[relay] Consent is on but no OpenRouter key was found (see openrouter.keyEnv). Using the plain transcript tail.",
  ],
  handover_failed: [
    "[relay] Handover summary failed; used the plain transcript tail instead.",
    "[relay] Handover summary failed (could not write one); passing the recent transcript instead.",
  ],
  config_invalid: ["[relay] Config problem: {detail}"],
}
const QUIET_OK = new Set<NarrationEvent>(["exhausted", "cap_reached", "config_invalid"])

const CONTROL = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f"+String.fromCharCode(0x2028,0x2029)+"]", "g")
const VALUE_CAP = 80
const DETAIL_CAP = 200

/** Strip control characters (incl. newlines, ANSI escape lead-in) and cap length. */
function clean(s: string | undefined, cap: number): string {
  if (s === undefined) return "?"
  // eslint-disable-next-line no-control-regex
  const t = String(s).replace(CONTROL, "")
  return t.length > cap ? t.slice(0, cap) : t
}

export function createNarrator(
  opts: { verbosity: Verbosity; tone: "plain" | "british" },
  rng: () => number = Math.random,
): (ev: NarrationEvent, v?: Vars) => string | null {
  const last = new Map<NarrationEvent, number>()
  return (ev, v = {}) => {
    if (opts.verbosity === "off") return null
    if (opts.verbosity === "quiet" && !QUIET_OK.has(ev)) return null
    const pool = POOLS[ev]
    let idx = Math.min(pool.length - 1, Math.floor(rng() * pool.length))
    if (!(idx >= 0)) idx = 0
    if (pool.length > 1 && last.get(ev) === idx) idx = (idx + 1) % pool.length
    last.set(ev, idx)
    const vals: Record<string, string> = {
      from: clean(v.from, VALUE_CAP),
      to: clean(v.to, VALUE_CAP),
      reason: clean(v.reason, VALUE_CAP),
      detail: ev === "config_invalid" ? (v.detail === undefined ? "" : clean(v.detail, DETAIL_CAP)) : "",
    }
    // Single pass with a replacer function: values are inserted literally ($&, $1 etc. are not interpreted)
    // and substituted text is never re-scanned for placeholders.
    return (pool[idx] as string).replace(/\{(from|to|reason|detail)\}/g, (_m, k: string) => vals[k] ?? "")
  }
}
