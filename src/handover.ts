import type { FailureKind, OcMessage } from "./types"
import type { RelayConfig } from "./config"
import type { orChat } from "./openrouter"
import { RELAY_MARKER } from "./defaults"
import { isSensitivePath, redact, truncate } from "./redact"

export interface Extracted {
  lastUserText: string
  filesTouched: string[]
  toolCalls: { name: string; status: "DONE" | "FAILED" | "UNKNOWN"; target?: string }[]
  todo: string[]
  transcript: string
}

const EDIT_TOOLS = new Set(["edit", "write", "patch", "multiedit", "apply_patch"])
const MAX_LAST_REQUEST = 4000
export const MAX_REDACT_INPUT = 60_000
const neutralizeTags = (s: string): string => s.replace(/<\s*(\/?)\s*transcript/gi, "<\u200b$1transcript")
const statusOf = (s: string): "DONE" | "FAILED" | "UNKNOWN" =>
  s === "completed" ? "DONE" : s === "error" ? "FAILED" : "UNKNOWN"

// Convert arbitrary tool output to a bounded string without throwing (objects, circular refs, huge values).
function outputToString(v: unknown, max: number): string {
  if (v === undefined || v === null) return ""
  if (typeof v === "string") return v
  try {
    const s = typeof v === "object" ? JSON.stringify(v) : String(v)
    if (typeof s !== "string") return ""
    return s.length > max * 10 ? "[object omitted: too large]" : s
  } catch {
    return "[unserializable output]"
  }
}

export function extractFromMessages(msgs: OcMessage[], o: { maxToolChars: number; maxTranscriptChars: number }): Extracted {
  let lastUserText = ""
  const files: string[] = []
  const toolCalls: Extracted["toolCalls"] = []
  let todo: string[] = []
  const lines: string[] = []

  for (const m of Array.isArray(msgs) ? msgs : []) {
    if (!m || typeof m !== "object" || !Array.isArray(m.parts)) continue
    const role = m.info?.role
    for (const p of m.parts) {
      if (!p || typeof p !== "object") continue
      if (p.type === "text") {
        const raw = (p as any).text
        if (typeof raw !== "string") continue
        if (raw.includes(RELAY_MARKER) || (p as any).synthetic || (p as any).ignored) continue
        if (role === "user") lastUserText = raw
        lines.push(`${role === "user" ? "USER" : "ASSISTANT"}: ${redact(truncate(raw, o.maxToolChars * 4))}`)
      } else if (p.type === "tool") {
        const t = p as any
        const st = t.state && typeof t.state === "object" ? t.state : {}
        const input = st.input && typeof st.input === "object" ? st.input : {}
        const name = String(t.tool ?? "unknown")
        const pathVal = input.filePath ?? input.path
        const rawTarget = input.filePath ?? input.path ?? input.command
        const target: string | undefined = rawTarget ? redact(truncate(String(rawTarget), 200)) : undefined
        const status = statusOf(String(st.status))
        toolCalls.push({ name, status, ...(target ? { target } : {}) })
        if (EDIT_TOOLS.has(name) && typeof pathVal === "string") {
          if (!files.includes(pathVal)) files.push(pathVal)
        }
        if (name === "todowrite" && Array.isArray(input.todos))
          todo = input.todos
            .filter((x: any) => x && typeof x === "object" && x.status !== "completed" && x.status !== "cancelled")
            .map((x: any) => `${String(x.status)}: ${String(x.content)}`)
        const sensitive = typeof pathVal === "string" && isSensitivePath(pathVal)
        const out = sensitive
          ? "[output omitted: sensitive file]"
          : redact(truncate(outputToString(st.output ?? st.error, o.maxToolChars), o.maxToolChars))
        lines.push(`TOOL ${name} [${status}]${target ? " " + target.slice(0, 120) : ""}: ${out}`)
      }
    }
  }
  const maxT = Math.min(o.maxTranscriptChars, MAX_REDACT_INPUT)
  let transcript = lines.join("\n")
  if (transcript.length > maxT) transcript = transcript.slice(transcript.length - maxT)
  return { lastUserText, filesTouched: files, toolCalls, todo, transcript }
}

export function renderHandover(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (m, k: string) => (k in vars ? (vars[k] as string) : m))
}

export async function writeNarrative(
  deps: { chat: typeof orChat; cfg: RelayConfig; key: string },
  ex: Extracted,
): Promise<{ summary: string; costUsd?: number } | null> {
  try {
    // redact() contract: truncate first. Keep only the tail of the transcript.
    const max = Math.min(deps.cfg.handover.maxTranscriptChars, MAX_REDACT_INPUT)
    const capped = ex.transcript.length > max ? ex.transcript.slice(ex.transcript.length - max) : ex.transcript
    const r = await deps.chat({
      baseUrl: deps.cfg.openrouter.baseUrl, key: deps.key, model: deps.cfg.handover.model,
      system: deps.cfg.handover.writerPrompt,
      user: `<transcript>\n${neutralizeTags(redact(capped))}\n</transcript>`,
      maxTokens: 900, timeoutMs: 45_000, zdr: deps.cfg.privacy.zdr,
    })
    if (typeof r.text !== "string" || r.text.length === 0 || r.text.length > 6000) return null
    const cost = r.costUsd
    return typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? { summary: r.text, costUsd: cost } : { summary: r.text }
  } catch {
    return null
  }
}

const ZWSP = "\u200b"
const neutralizeDataTags = (s: string): string => s.replace(/<\s*(\/?)\s*handover-data/gi, `<${ZWSP}$1handover-data`)
const SECTION_TITLES = /^([ \t>*_#-]*)(The user's last request|Tool calls so far|Files touched|Todo|Summary)/gim
/** Makes untrusted text unable to open a heading/section of the handover or close the data block. */
function defang(s: string): string {
  return neutralizeDataTags(s)
    .replace(/^([ \t]*)(#{1,6})(?=\s)/gm, `$1${ZWSP}$2`)
    .replace(SECTION_TITLES, `$1${ZWSP}$2`)
}

export function buildHandover(a: { cfg: RelayConfig; ex: Extracted; from: string; to: string; reason: FailureKind; summary: string | null }): string {
  const calls = a.ex.toolCalls.slice(-30).map((t) => `- ${t.status} ${t.name}${t.target ? " " + t.target : ""}`).join("\n") || "- (none)"
  const tail = a.ex.transcript.slice(-3000)
  const text = renderHandover(a.cfg.handover.messageTemplate, {
    from: a.from, to: a.to, reason: a.reason,
    // Both the LLM summary and the raw tail are untrusted: fence them as data the content cannot close.
    summary: `<handover-data>\n${defang(a.summary ?? `(summary unavailable; recent transcript follows)\n${tail}`)}\n</handover-data>`,
    toolCalls: defang(calls),
    files: defang(a.ex.filesTouched.map((f) => `- ${f}`).join("\n") || "- (none)"),
    todo: defang(a.ex.todo.map((t) => `- ${t}`).join("\n") || "- (none)"),
    lastRequest: a.ex.lastUserText ? truncate(a.ex.lastUserText, MAX_LAST_REQUEST) : "(none found)",
  })
  // The marker lets extraction skip our own handovers; a custom template may omit it.
  return text.startsWith(RELAY_MARKER) ? text : `${RELAY_MARKER}\n${text}`
}
