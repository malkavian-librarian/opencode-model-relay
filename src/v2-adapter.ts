import type { ClientLike, OcMessage } from "./types"
import type { V2Ctx, V2Message, V2SessionInfo } from "./v2-types"

export interface V2AdapterSession { sid?: string }

function sessionModelOf(info: V2SessionInfo | undefined | null): { providerID: string; modelID: string } | undefined {
  const m = info?.model
  if (!m || typeof m !== "object" || typeof m.providerID !== "string" || typeof m.id !== "string") return undefined
  return { providerID: m.providerID, modelID: m.id }
}

function toOcMessage(row: unknown, sessionModel: { providerID: string; modelID: string } | undefined): OcMessage | undefined {
  if (!row || typeof row !== "object") return undefined
  const v = row as V2Message
  if (typeof v.id !== "string" || !v.id) return undefined
  const synthetic = v.type === "synthetic" || v.synthetic === true
  if (v.type === "user") return { info: { id: v.id, role: "user", model: sessionModel }, parts: [{ type: "text", text: typeof v.text === "string" ? v.text : "", ...(synthetic ? { synthetic: true } : {}) }] }
  if (v.type !== "assistant") return undefined
  const model = sessionModelOf({ model: v.model as V2SessionInfo["model"] })
  const tokens = v.tokens as { output?: unknown } | undefined
  return {
    info: {
      id: v.id, role: "assistant", ...(model ?? {}),
      ...(typeof v.cost === "number" && Number.isFinite(v.cost) && v.cost >= 0 ? { cost: v.cost } : {}),
      ...(typeof v.agent === "string" ? { agent: v.agent } : {}),
      ...(tokens && typeof tokens.output === "number" && Number.isFinite(tokens.output) ? { tokens: { output: tokens.output } } : {}),
    } as OcMessage["info"],
    parts: Array.isArray(v.content) ? (v.content as OcMessage["parts"]) : [],
  }
}

function synthProviders(rows: unknown): { data: { providers: { id: string; models: Record<string, unknown> }[] } } {
  const byProvider = new Map<string, Record<string, unknown>>()
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== "object") continue
    const m = row as { providerID?: unknown; modelID?: unknown; id?: unknown }
    if (typeof m.providerID !== "string") continue
    const modelID = typeof m.modelID === "string" ? m.modelID : typeof m.id === "string" ? m.id : ""
    if (!modelID) continue
    const models = byProvider.get(m.providerID) ?? Object.create(null)
    if (!(modelID in models)) models[modelID] = {}
    byProvider.set(m.providerID, models)
  }
  return { data: { providers: [...byProvider].map(([id, models]) => ({ id, models })) } }
}

export function adaptV2Client(ctx: V2Ctx, lastSession: V2AdapterSession): ClientLike {
  const session = ctx.session as Required<V2Ctx>["session"]
  const model = ctx.model as NonNullable<V2Ctx["model"]>
  const messagesFor = async (a: { path: { id: string } }): Promise<OcMessage[]> => {
    const [info, raw] = await Promise.all([
      Promise.resolve(session?.get?.({ sessionID: a.path.id })),
      Promise.resolve(session?.context?.({ sessionID: a.path.id })),
    ])
    const sessionModel = sessionModelOf(info)
    const out: OcMessage[] = []
    for (const row of Array.isArray(raw) ? raw : []) {
      const message = toOcMessage(row, sessionModel)
      if (message) out.push(message)
    }
    return out
  }
  return {
    session: {
      get: async (a) => {
        const info = await Promise.resolve(session?.get?.({ sessionID: a.path.id }))
        return { data: info ? (typeof info.parentID === "string" ? { parentID: info.parentID } : {}) : undefined }
      },
      messages: async (a) => ({ data: await messagesFor(a) }),
      abort: async (a) => Promise.resolve(session?.interrupt?.({ sessionID: a.path.id })),
      prompt: async (a) => {
        const sessionID = a.path.id
        const to = a.body?.model
        if (to && typeof to.providerID === "string" && typeof to.modelID === "string") {
          try { await Promise.resolve(session?.switchModel?.({ sessionID, model: { providerID: to.providerID, id: to.modelID } })) } catch { /* prompt anyway */ }
        }
        const text = (Array.isArray(a.body?.parts) ? a.body.parts : [])
          .map((p) => (p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text : ""))
          .join("\n\n")
        await Promise.resolve(session?.prompt?.({ sessionID, ...(a.body?.agent ? { agent: a.body.agent } : {}), text }))
      },
    },
    config: {
      providers: async () => {
        const res = await Promise.resolve(model?.list?.())
        const rows = res && typeof res === "object" && "data" in res ? (res as { data?: unknown }).data : res
        return synthProviders(rows)
      },
    },
    tui: {
      showToast: async (a) => {
        if (!lastSession.sid) return
        await Promise.resolve(session?.synthetic?.({ sessionID: lastSession.sid, text: a.body.message }))
      },
    },
  }
}
