import os from "node:os"
import { z } from "zod"
import { classify } from "./classifier"
import { INIT_TOOL_DESCRIPTION, RELAY_TOOL_DESCRIPTION, createRelay, listProviderModels } from "./server"
import { initConfig } from "./init"
import { configFile, dataDir } from "./config"
import { STATS_TOOL_INPUT, STATS_USAGE, parseStatsOptions, parseStatsToolInput, purgeAndRefreshStats, statsText } from "./stats"
import { clearSwitchLog } from "./switchlog"
import type { EventLog } from "./ledger"
import { modelKey, parseModel, type ClientLike, type ModelRef, type OcMessage } from "./types"
import type { Controller } from "./controller"
import type { createNarrator } from "./narrator"
import type { StateStore } from "./state"
import type { V2Ctx, V2Event, V2Message, V2SessionInfo } from "./v2-types"

// OpenCode 2 plugin layer (#56). Shapes are structural (src/v2-types.ts) per the live probe in
// docs/spike-v2.md; nothing here may read ctx.options or ctx.location (untrusted project tree).
type Env = Record<string, string | undefined>

export const PLUGIN_ID = "opencode-model-relay"

// Retry budget mirrors v1 session.status semantics (#40): permanent failures switch at once,
// transient ones only from the second attempt, so OpenCode's own first retry is left alone.
const SWITCH_MIN_ATTEMPT = 2
const UNLOADED = "opencode-model-relay: this plugin instance was unloaded"

// The context hook and session.model.selected payloads are untrusted host data: consume them only
// as this validated shape (rule 2); extra fields are stripped, anything else fails safe to a no-op.
const ResolvedModelEvent = z.object({
  sessionID: z.string().min(1).max(256),
  model: z.object({ providerID: z.string().min(1).max(128), id: z.string().min(1).max(128) }),
})

// Bound for the per-session model.selected corroboration map (in memory only).
const MAX_TRACKED_SELECTIONS = 500

interface Core {
  key: string
  controller: Controller
  state: StateStore
  warnings: string[]
  narrate: ReturnType<typeof createNarrator>
  warned: boolean
  ledger: EventLog
  ledgerDir: string
}

// One relay shared by every setup() in the process: the second setup only rebinds which ctx
// performs the calls, so switches are deduplicated through the same controller/lock/state.
const CORE: {
  current?: Core
  client: { current?: ClientLike; epoch: number }
  lastSession: { sid?: string }
  /** Last session.model.selected model per session: probe Q4 corroboration for adoption (#66). */
  modelSelected: Map<string, string>
  /** Latest context-hook pick per session: a stale in-flight lookup must never adopt (#66). */
  lastContextPick: Map<string, string>
} = { client: { current: undefined, epoch: 0 }, lastSession: {}, modelSelected: new Map(), lastContextPick: new Map() }

let moduleActive = false

/** True once a full v2 layer activated; the v1 server() hooks then no-op instead of double-switching. */
export function isV2Active(): boolean { return moduleActive }

const rejected = (method: string): Promise<never> => Promise.reject(new Error(`${UNLOADED} (${method})`))

/** The client the controller talks to: always the newest adapter, rejecting once its owner unloaded. */
function holderClient(): ClientLike {
  // Parameter types mirror ClientLike so a host-provided any stays contained at this boundary.
  type Get = { path: { id: string } }
  type Prompt = Parameters<ClientLike["session"]["prompt"]>[0]
  type Toast = Parameters<ClientLike["tui"]["showToast"]>[0]
  return {
    get session() {
      const c = CORE.client.current
      return {
        get: (a: Get) => (c ? c.session.get(a) : rejected("session.get")),
        messages: (a: Get) => (c ? c.session.messages(a) : rejected("session.messages")),
        abort: (a: Get) => (c ? c.session.abort(a) : rejected("session.abort")),
        prompt: (a: Prompt) => (c ? c.session.prompt(a) : rejected("session.prompt")),
      }
    },
    get config() { return CORE.client.current?.config },
    get tui() {
      const c = CORE.client.current
      return { showToast: (a: Toast) => (c ? c.tui.showToast(a) : rejected("tui.showToast")) }
    },
  }
}

function coreFor(env: Env): Core {
  const key = `${configFile(env)}|${dataDir(env)}`
  const existing = CORE.current
  if (existing && existing.key === key) return existing
  const parts = createRelay(env, holderClient())
  // AC-04: validate persisted pins against the loaded levels once per core creation; the ones that
  // no longer resolve are dropped silently so the next context hook re-syncs to the runtime's model.
  parts.controller.validatePersistedPins()
  const core: Core = {
    key, controller: parts.controller, state: parts.state,
    warnings: parts.warnings, narrate: parts.narrate, ledger: parts.ledger, ledgerDir: parts.ledgerDir, warned: false,
  }
  CORE.current = core
  return core
}

// --- adapter: v2 ctx -> the v1 ClientLike the controller speaks (shapes per docs/spike-v2.md).

function sessionModelOf(info: V2SessionInfo | undefined | null): { providerID: string; modelID: string } | undefined {
  const m = info?.model
  if (!m || typeof m !== "object") return undefined
  if (typeof m.providerID !== "string" || typeof m.id !== "string") return undefined
  return { providerID: m.providerID, modelID: m.id }
}

function toOcMessage(row: unknown, sessionModel: { providerID: string; modelID: string } | undefined): OcMessage | undefined {
  if (!row || typeof row !== "object") return undefined
  const v = row as V2Message
  const id = typeof v.id === "string" ? v.id : ""
  if (!id) return undefined
  const synthetic = v.type === "synthetic" || v.synthetic === true
  if (v.type === "user") {
    return {
      info: { id, role: "user", model: sessionModel },
      parts: [{ type: "text", text: typeof v.text === "string" ? v.text : "", ...(synthetic ? { synthetic: true } : {}) }],
    }
  }
  if (v.type === "assistant") {
    const model = sessionModelOf({ model: v.model as V2SessionInfo["model"] })
    const tokens = v.tokens as { output?: unknown } | undefined
    return {
      info: {
        id,
        role: "assistant",
        ...(model ?? {}),
        ...(typeof v.cost === "number" && Number.isFinite(v.cost) && v.cost >= 0 ? { cost: v.cost } : {}),
        ...(typeof v.agent === "string" ? { agent: v.agent } : {}),
        ...(tokens && typeof tokens.output === "number" && Number.isFinite(tokens.output) ? { tokens: { output: tokens.output } } : {}),
      } as OcMessage["info"],
      parts: Array.isArray(v.content) ? (v.content as OcMessage["parts"]) : [],
    }
  }
  return undefined // "idle" and other status records are not transcript messages
}

/** Synthesizes the v1 providers shape from v2's model.list(); ids only, never options or keys. */
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
  const providers = [...byProvider].map(([id, models]) => ({ id, models: models as Record<string, unknown> }))
  return { data: { providers } }
}

function adaptV2Client(ctx: V2Ctx): ClientLike {
  // Domain presence is guaranteed by domainsPresent(); the proxies still tolerate undefined results.
  const session = ctx.session as Required<V2Ctx>["session"]
  const model = ctx.model as NonNullable<V2Ctx["model"]>
  const messagesFor = async (a: { path: { id: string } }): Promise<OcMessage[]> => {
    // The session model backs user messages (v2 user rows carry none; v1's info.model did).
    const [info, raw] = await Promise.all([
      Promise.resolve(session?.get?.({ sessionID: a.path.id })),
      Promise.resolve(session?.context?.({ sessionID: a.path.id })),
    ])
    const sessionModel = sessionModelOf(info)
    const rows = Array.isArray(raw) ? raw : []
    const out: OcMessage[] = []
    for (const row of rows) {
      const m = toOcMessage(row, sessionModel)
      if (m) out.push(m)
    }
    return out
  }
  return {
    session: {
      get: async (a) => {
        const info = await Promise.resolve(session?.get?.({ sessionID: a.path.id }))
        // A missing session propagates as `data: undefined` so callers can treat it as ineligible.
        return { data: info ? (typeof info.parentID === "string" ? { parentID: info.parentID } : {}) : undefined }
      },
      messages: async (a) => ({ data: await messagesFor(a) }),
      abort: async (a) => Promise.resolve(session?.interrupt?.({ sessionID: a.path.id })),
      prompt: async (a) => {
        const sessionID = a.path.id
        // The v2 prompt has no model field, so the session model is set explicitly before prompting.
        const to = a.body?.model
        if (to && typeof to.providerID === "string" && typeof to.modelID === "string") {
          try {
            await Promise.resolve(session?.switchModel?.({ sessionID, model: { providerID: to.providerID, id: to.modelID } }))
          } catch { /* prompt anyway: stay-put means the session keeps whatever model it holds */ }
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
        // The plugins API has no toast endpoint on v2: surface as a synthetic message, best effort.
        const sid = CORE.lastSession.sid
        if (!sid) return
        await Promise.resolve(session?.synthetic?.({ sessionID: sid, text: a.body.message }))
      },
    },
  }
}

// --- event dispatch (v2 events carry the payload in `data`; the stream spans all projects).

function toV1Error(raw: unknown): { name: "APIError"; data: { message: string; statusCode?: number } } {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}
  const message = typeof r.message === "string" ? r.message : typeof r.type === "string" ? r.type : ""
  const statusCode = typeof r.status === "number" && Number.isFinite(r.status) ? r.status : undefined
  return { name: "APIError", data: { message, ...(statusCode !== undefined ? { statusCode } : {}) } }
}

function relayEvent(raw: unknown, core: Core): void {
  try {
    const ev = raw as V2Event | undefined
    if (!ev || typeof ev.type !== "string") return
    const data = (ev.data && typeof ev.data === "object" ? ev.data : {}) as Record<string, unknown>
    const sessionID = typeof data.sessionID === "string" ? data.sessionID : undefined
    if (!sessionID) return
    CORE.lastSession.sid = sessionID
    const controller = core.controller
    if (core.warnings.length > 0 && !core.warned) {
      core.warned = true // one config toast per process, like the v1 warnOnce behaviour
      void (async () => {
        try {
          const message = core.narrate("config_invalid", { detail: core.warnings[0] })
          if (message) await holderClient().tui.showToast({ body: { message, variant: "warning" } })
        } catch { /* toast is best effort */ }
      })()
    }
    // Probe Q4 corroboration: track the last actual model change per session; the context hook
    // refuses an adoption whose payload disagrees with it (stale context model).
    if (ev.type === "session.model.selected") {
      const parsed = ResolvedModelEvent.safeParse(data)
      if (parsed.success) {
        if (CORE.modelSelected.size >= MAX_TRACKED_SELECTIONS) CORE.modelSelected.clear() // bound the map
        CORE.modelSelected.set(parsed.data.sessionID, `${parsed.data.model.providerID}/${parsed.data.model.id}`)
      }
      return
    }
    if (ev.type === "session.execution.succeeded") {
      void Promise.resolve(controller.onSessionIdle(sessionID)).catch(() => {})
    } else if (ev.type === "session.error" || ev.type === "session.execution.failed") {
      const errObj = data.error && typeof data.error === "object" ? data.error : undefined
      const from = modelRefOf(data.model) ?? modelRefOf((errObj as { model?: unknown } | undefined)?.model)
      void Promise.resolve(controller.onSessionError(sessionID, toV1Error(data.error), from)).catch(() => {})
    }
  } catch { /* events never throw into the stream */ }
}

function startEventLoop(ctx: V2Ctx, core: Core): () => void {
  const ac = new AbortController()
  void (async () => {
    try {
      for await (const ev of ctx.event!.subscribe({ signal: ac.signal })) relayEvent(ev, core)
    } catch { /* aborted on unload, or the host dropped the stream */ }
  })()
  return () => ac.abort()
}

// --- session hooks (prompt = pin/recover on admission, context = user-pick clear, retry = veto+switch).

function sidOf(ev: unknown): string | undefined {
  const sessionID = (ev as { sessionID?: unknown } | undefined)?.sessionID
  return typeof sessionID === "string" ? sessionID : undefined
}

function onPromptHook(ev: unknown): void {
  try {
    const sessionID = sidOf(ev)
    if (!sessionID) return
    CORE.lastSession.sid = sessionID
    // Stay-put (#66, probe Q1): switchModel persists across admissions, so the fabricated-arrival
    // workaround is deleted outright; the hook only keeps the notification target fresh.
  } catch { /* hooks never throw into the host */ }
}

function onContextHook(core: Core, ev: unknown): void {
  try {
    const parsed = ResolvedModelEvent.safeParse(ev)
    if (!parsed.success) return
    const { sessionID, model } = parsed.data
    CORE.lastSession.sid = sessionID
    const pick = `${model.providerID}/${model.id}`
    if (CORE.lastContextPick.size >= MAX_TRACKED_SELECTIONS) CORE.lastContextPick.clear() // bound the map
    CORE.lastContextPick.set(sessionID, pick)
    void (async () => {
      try {
        const session = await holderClient().session.get({ path: { id: sessionID } })
        // No session found, or a child pick: eligibility is unproven — never clear shared health.
        if (!session.data || session.data.parentID) return
        // A newer context event for this session supersedes this (now stale) lookup.
        if (CORE.lastContextPick.get(sessionID) !== pick) return
        const rec = core.state.get(sessionID)
        if (rec.pluginPinned === pick) return // the plugin set this model itself: nothing to adopt
        // Check after the lookup: a newer selection may arrive while session.get is pending.
        const selected = CORE.modelSelected.get(sessionID)
        if (selected !== undefined && selected !== pick) return
        core.controller.adoptPick(sessionID, pick) // under the SessionLock; never enacts a switch
      } catch { /* lookup failures leave session state and shared health intact */ }
    })()
  } catch { /* hooks never throw into the host */ }
}

/** v2 model refs use `{providerID, id}`; the v1 controller model-key uses modelID. */
function modelRefOf(raw: unknown): ModelRef | undefined {
  const m = raw as { providerID?: unknown; id?: unknown; modelID?: unknown } | undefined
  if (!m || typeof m !== "object") return undefined
  const modelID = typeof m.modelID === "string" ? m.modelID : typeof m.id === "string" ? m.id : undefined
  if (typeof m.providerID !== "string" || !modelID) return undefined
  return { providerID: m.providerID, modelID }
}

function onRetryHook(controller: Controller, ev: unknown): Promise<void> {
  // The hook may run async (the host applies the decision afterwards): await the switch outcome so
  // OpenCode's retry is only vetoed when the relay really took the turn over (#56).
  return (async () => {
    try {
      const sessionID = sidOf(ev)
      if (!sessionID) return
      CORE.lastSession.sid = sessionID
      const e = ev as { attempt?: unknown; error?: unknown; decision?: Record<string, unknown>; model?: unknown }
      const from = modelRefOf(e.model)
      // AC-05: retry events for the old, already-failed-over turn are consumed and vetoed; a retry of
      // the plugin-set model is a live failure and flows on.
      if (controller.stormActive(sessionID, from ? modelKey(from) : undefined)) {
        try { if (e.decision) e.decision.retry = false } catch { /* the veto is best effort */ }
        return
      }
      const attempt = typeof e.attempt === "number" && Number.isFinite(e.attempt) && e.attempt >= 1 ? Math.floor(e.attempt) : 1
      const raw = toV1Error(e.error)
      const c = classify(raw)
      if (!c.switchable || !(c.permanent || attempt >= SWITCH_MIN_ATTEMPT)) return
      // A switch can take seconds (abort, handover, helper); veto only once it is actually enacted,
      // otherwise the turn would fail with neither OpenCode's retry nor a handover.
      const enacted = await controller.onSessionError(sessionID, raw, from)
      if (!enacted) return
      try { if (e.decision) e.decision.retry = false } catch { /* the veto is best effort */ }
    } catch { /* hooks never throw into the host */ }
  })()
}

function registerSessionHooks(ctx: V2Ctx, core: Core): Promise<unknown> {
  // The registration calls themselves should not throw synchronously either (hooks never throw).
  const reg = (name: string, cb: (ev: unknown) => unknown): Promise<unknown> => {
    try { return Promise.resolve(ctx.session?.hook?.(name, cb)) } catch { return Promise.resolve() }
  }
  const hooks = [
    reg("prompt", (ev) => onPromptHook(ev)),
    reg("context", (ev) => onContextHook(core, ev)),
    reg("retry", (ev) => onRetryHook(core.controller, ev)),
  ]
  // A failed registration is tolerated: the layer keeps what it got (fail safe, hooks never throw).
  return Promise.all(hooks.map((h) => h.catch(() => {})))
}

function sidInput(input: unknown): string | undefined {
  const sessionID = (input as { sessionID?: unknown } | undefined)?.sessionID
  return typeof sessionID === "string" ? sessionID : undefined
}

function commandArgs(input: unknown): string {
  const prompt = (input as { prompt?: unknown } | undefined)?.prompt
  if (prompt && typeof prompt === "object" && "text" in prompt) {
    const text = (prompt as { text?: unknown }).text
    return typeof text === "string" ? text.trim() : ""
  }
  const args = (input as { arguments?: unknown } | undefined)?.arguments
  return typeof args === "string" ? args.trim() : ""
}

function commandModelArg(args: string): string | undefined {
  if (!args.startsWith("model ")) return undefined
  const raw = args.slice("model ".length).trim()
  if (!raw || /\s|[\u0000-\u001f\u007f]/.test(raw)) return undefined
  try { return modelKey(parseModel(raw)) } catch { return undefined }
}

async function emitSynthetic(ctx: V2Ctx, sessionID: string, text: string): Promise<void> {
  try { await Promise.resolve(ctx.session?.synthetic?.({ sessionID, text })) } catch { /* feedback is best effort */ }
}

function registerTools(env: Env, ctx: V2Ctx, controller: Controller, adapter: ClientLike, ledger: EventLog, ledgerDir: string): Promise<unknown> {
  const emptyInput = { type: "object", properties: {}, additionalProperties: false }
  try {
    return Promise.resolve(ctx.tool!.transform((editor) => {
      editor.add({
        name: "relay_status",
        description: RELAY_TOOL_DESCRIPTION,
        input: emptyInput,
        execute: async (_input: unknown, context: { sessionID?: string }) => ({ content: controller.status(context?.sessionID) }),
      })
      editor.add({
        name: "relay_init",
        description: INIT_TOOL_DESCRIPTION,
        input: emptyInput,
        execute: async () => {
          try {
            return { content: await initConfig({ env, home: os.homedir(), listModels: () => listProviderModels(adapter) }) }
          } catch { return { content: "relay_init failed unexpectedly; no config was written." } }
        },
      })
      editor.add({
        name: "relay_stats",
        description: "Show per-model relay usage statistics (turns, failures by kind, judge rejections, survival, median latency, cost) from the metadata-only ledger over the last 1-30 days (default 30). Optional: days (integer 1-30), kinds (per-model failure-kind breakdown).",
        input: STATS_TOOL_INPUT,
        execute: async (input: unknown) => {
          const query = parseStatsToolInput(input)
          return { content: query ? statsText(ledger, query) : STATS_USAGE }
        },
      })
      editor.add({
        name: "relay_purge",
        description: "Delete all relay ledger event files and clear the switch log (metadata-only usage data; the stats.json snapshot is rebuilt immediately from what remains). This cannot be undone.",
        input: emptyInput,
        execute: async () => {
          clearSwitchLog(ledgerDir)
          return { content: purgeAndRefreshStats(ledger, ledgerDir) }
        },
      })
    }))
  } catch (e) { return Promise.resolve(e) }
}

function registerCommands(env: Env, ctx: V2Ctx, controller: Controller, adapter: ClientLike, ledger: EventLog, ledgerDir: string): Promise<unknown> {
  try {
    return Promise.resolve(ctx.command!.transform((editor) => {
      editor.add({
        name: "relay",
        description: "Show model relay status",
        execute: async (input: unknown) => {
          try {
            const sessionID = sidInput(input)
            const args = commandArgs(input)
            // `stats` alone or with options (whitespace-separated); `status` must not match.
            if (sessionID && /^stats(?:$|\s)/.test(args)) {
              const query = parseStatsOptions(args.slice(5))
              await emitSynthetic(ctx, sessionID, query ? statsText(ledger, query) : STATS_USAGE)
              return input ?? {}
            }
            if (sessionID && args === "purge") {
              clearSwitchLog(ledgerDir)
              await emitSynthetic(ctx, sessionID, purgeAndRefreshStats(ledger, ledgerDir))
              return input ?? {}
            }
            if (sessionID && (args === "next" || args === "model" || args.startsWith("model "))) {
              const requested = args === "next" ? undefined : commandModelArg(args)
              if (args === "model" || (args.startsWith("model ") && requested === undefined)) {
                await emitSynthetic(ctx, sessionID, "Invalid model: expected provider/model.")
                return input ?? {}
              }
              const receipt = requested ? `Switching to ${requested}…` : "Switching to the next model…"
              await emitSynthetic(ctx, sessionID, receipt)
              const result = await controller.manualSwitch(sessionID, requested)
              const text = result.status === "switched"
                ? `Switched to ${result.to ?? requested} (done in ${result.elapsedMs ?? 0}ms).`
                : result.status === "locked"
                  ? "Failover in progress; retry in a moment."
                  : result.status === "bottom"
                    ? "No healthy model below this one; run /relay status for the ladder."
                    : "The manual switch could not be completed; the current model was left unchanged."
              await emitSynthetic(ctx, sessionID, text)
              return input ?? {}
            }
            if (sessionID) await Promise.resolve(ctx.session?.synthetic?.({ sessionID, text: controller.status(sessionID) }))
            return input ?? {}
          } catch { return (input as object | undefined) ?? {} }
        },
      })
      editor.add({
        name: "relay-init",
        description: "Create a commented default model relay config",
        execute: async (input: unknown) => {
          try {
            const text = await initConfig({ env, home: os.homedir(), listModels: () => listProviderModels(adapter) })
            const sessionID = sidInput(input)
            if (sessionID) await Promise.resolve(ctx.session?.synthetic?.({ sessionID, text }))
            return input ?? {}
          } catch { return (input as object | undefined) ?? {} }
        },
      })
    }))
  } catch (e) { return Promise.resolve(e) }
}

/** All the domains the v2 layer calls for. Anything less (e.g. OpenCode 1.x partial ctx) stays dormant. */
function domainsPresent(ctx: V2Ctx): boolean {
  const session = ctx?.session
  return !!(
    ctx?.event?.subscribe &&
    session?.hook && session?.get && session?.context && session?.switchModel && session?.prompt && session?.synthetic && session?.interrupt &&
    ctx?.model?.list && ctx?.tool?.transform && ctx?.command?.transform
  )
}

/** Builds the v2 plugin definition: one setup() per plugin object, see the issue #56 runbook. */
export function createV2Plugin(env: Env): { id: string; setup: (ctx: V2Ctx) => Promise<void | (() => void)> } {
  return {
    id: PLUGIN_ID,
    setup: async (ctx: V2Ctx) => {
      try {
        if (!domainsPresent(ctx)) return // dormant: the v1 server() layer owns the relay on such hosts
        const core = coreFor(env)
        const adapter = adaptV2Client(ctx)
        const epoch = CORE.client.epoch + 1
        CORE.client.epoch = epoch
        CORE.client.current = adapter
        const stopLoop = startEventLoop(ctx, core)
        // AC-04: hooks/tools/commands are registered BEFORE the layer stands the v1 hooks down
        // (moduleActive), so no activation window exists where neither layer handles events.
        await registerSessionHooks(ctx, core)
        await registerTools(env, ctx, core.controller, adapter, core.ledger, core.ledgerDir)
        await registerCommands(env, ctx, core.controller, adapter, core.ledger, core.ledgerDir)
        moduleActive = true // from here the v1 server() hooks stand down; a partial v2 setup must not double-run v1
        return () => {
          try { stopLoop() } catch { /* ignore */ }
          if (CORE.client.epoch === epoch) CORE.client.current = undefined
        }
      } catch { return } // setup never throws into the host; the layer stays dormant
    },
  }
}
