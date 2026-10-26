import type { FailureKind, OcMessage } from "./types"
import type { RelayConfig } from "./config"
import type { orChat } from "./openrouter"
import { RELAY_MARKER } from "./defaults"
import { isSensitivePath, redact, truncate } from "./redact"
import { z } from "zod"

export interface Extracted {
  lastUserText: string
  filesTouched: string[]
  toolCalls: { name: string; status: "DONE" | "FAILED" | "UNKNOWN"; target?: string }[]
  todo: string[]
  transcript: string
}

const MAX_LAST_REQUEST = 4000
const MAX_TOOL_NAME = 128
export const MAX_REDACT_INPUT = 60_000
const neutralizeTags = (s: string): string => s.replace(/<\s*(\/?)\s*transcript/gi, "<\u200b$1transcript")
const statusOf = (s: string): "DONE" | "FAILED" | "UNKNOWN" =>
  s === "completed" || s === "done" ? "DONE" : s === "error" || s === "failed" ? "FAILED" : "UNKNOWN"

const ToolPartSchema = z.object({
  type: z.literal("tool"),
  name: z.string().optional(),
  tool: z.string().optional(),
  toolName: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
  state: z.object({
    status: z.string().optional(),
    tool: z.string().optional(),
    input: z.unknown().optional(),
    output: z.unknown().optional(),
    error: z.unknown().optional(),
    content: z.unknown().optional(),
    metadata: z.record(z.unknown()).optional(),
  }).passthrough().optional(),
}).passthrough()

function toolNameOf(part: unknown): string {
  const parsed = ToolPartSchema.safeParse(part)
  if (!parsed.success) return "unknown"
  const t = parsed.data
  const metadata = t.metadata
  const stateMetadata = t.state?.metadata
  for (const candidate of [t.name, t.toolName, metadata?.name, metadata?.toolName, metadata?.tool, stateMetadata?.name, stateMetadata?.toolName, stateMetadata?.tool, t.state?.tool, t.tool]) {
    const valid = z.string().min(1).max(MAX_TOOL_NAME).safeParse(candidate)
    if (valid.success) return valid.data
  }
  return "unknown"
}

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
        // Same rule as hasRelayMarker: only a text part that STARTS with the marker (ours) is dropped;
        // a user message merely mentioning it stays visible (it may not impersonate the handover).
        if (raw.startsWith(RELAY_MARKER) || (p as any).synthetic || (p as any).ignored) continue
        if (role === "user") lastUserText = raw
        lines.push(`${role === "user" ? "USER" : "ASSISTANT"}: ${redact(truncate(raw, o.maxToolChars * 4))}`)
      } else if (p.type === "tool") {
        const t = p as any
        const st = t.state && typeof t.state === "object" ? t.state : {}
        const input = st.input && typeof st.input === "object" ? st.input : {}
        const name = toolNameOf(p)
        const pathVal = input.filePath ?? input.path
        const rawTarget = input.filePath ?? input.path ?? input.command
        const target: string | undefined = rawTarget ? redact(truncate(String(rawTarget), 200)) : undefined
        const status = statusOf(String(st.status))
        toolCalls.push({ name, status, ...(target ? { target } : {}) })
        if (typeof pathVal === "string" && !files.includes(pathVal)) files.push(pathVal)
        if (Array.isArray(input.todos))
          todo = input.todos
            .filter((x: any) => x && typeof x === "object" && x.status !== "completed" && x.status !== "cancelled")
            .map((x: any) => `${String(x.status)}: ${String(x.content)}`)
        const sensitive = typeof pathVal === "string" && isSensitivePath(pathVal)
        const out = sensitive
          ? "[output omitted: sensitive file]"
          : redact(truncate(outputToString(st.output ?? st.error ?? st.content, o.maxToolChars), o.maxToolChars))
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

/** Builds a marked handover with fenced, untrusted context; only scheduled narratives are labeled deferred. */
export function buildHandover(a: { cfg: RelayConfig; ex: Extracted; from: string; to: string; reason: FailureKind; summary: string | null; narrativeDeferred?: boolean }): string {
  const calls = a.ex.toolCalls.slice(-30).map((t) => `- ${t.status} ${t.name}${t.target ? " " + t.target : ""}`).join("\n") || "- (none)"
  const tail = a.ex.transcript.slice(-3000)
  const text = renderHandover(a.cfg.handover.messageTemplate, {
    from: a.from, to: a.to, reason: a.reason,
    // Both the LLM summary and the raw tail are untrusted: fence them as data the content cannot close.
    summary: `<handover-data>\n${defang(a.summary ?? `(summary unavailable; ${a.narrativeDeferred ? "narrative deferred; " : ""}recent transcript follows)\n${tail}`)}\n</handover-data>`,
    toolCalls: defang(calls),
    files: defang(a.ex.filesTouched.map((f) => `- ${f}`).join("\n") || "- (none)"),
    todo: defang(a.ex.todo.map((t) => `- ${t}`).join("\n") || "- (none)"),
    lastRequest: a.ex.lastUserText ? truncate(a.ex.lastUserText, MAX_LAST_REQUEST) : "(none found)",
  })
  // The marker lets extraction skip our own handovers; a custom template may omit it.
  return text.startsWith(RELAY_MARKER) ? text : `${RELAY_MARKER}\n${text}`
}
