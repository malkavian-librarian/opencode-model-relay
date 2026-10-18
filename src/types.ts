export interface ModelRef { providerID: string; modelID: string }

export function parseModel(s: string): ModelRef {
  const i = s.indexOf("/")
  if (i <= 0 || i === s.length - 1) throw new Error(`Invalid model "${s}": expected "provider/model"`)
  return { providerID: s.slice(0, i), modelID: s.slice(i + 1) }
}
export function modelKey(m: ModelRef): string { return `${m.providerID}/${m.modelID}` }

export type FailureKind =
  | "rate_limit" | "quota" | "auth" | "free_tier_403" | "server_5xx"
  | "timeout" | "model_not_found" | "overflow" | "user_abort" | "unknown"

export interface Classified {
  kind: FailureKind
  retryable: boolean
  retryAfterMs?: number
  permanent: boolean
  switchable: boolean
}

export type OcPart =
  | { type: "text"; text: string; synthetic?: boolean }
  | { type: "tool"; tool: string; state: { status: string; input?: any; output?: string; error?: string } }
  | { type: string; [k: string]: unknown }

export interface OcMessage {
  info: { id: string; role: "user" | "assistant"; providerID?: string; modelID?: string; agent?: string; mode?: string; model?: { providerID: string; modelID: string } }
  parts: OcPart[]
}

export interface ClientLike {
  session: {
    get(a: { path: { id: string } }): Promise<{ data?: { parentID?: string } }>
    messages(a: { path: { id: string } }): Promise<{ data?: OcMessage[] }>
    abort(a: { path: { id: string } }): Promise<unknown>
    prompt(a: {
      path: { id: string }
      body: { model: ModelRef; agent?: string; parts: { type: "text"; text: string }[] }
    }): Promise<unknown>
  }
  config?: { providers(): Promise<{ data?: { providers?: { id: string; models?: Record<string, unknown> }[] } }> }
  tui: { showToast(a: { body: { message: string; variant?: "info" | "success" | "warning" | "error" } }): Promise<unknown> }
}
