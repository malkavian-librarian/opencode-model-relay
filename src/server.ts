import path from "node:path"
import { Controller } from "./controller"
import { configFile, confineToDir, dataDir, loadConfig } from "./config"
import { StateStore } from "./state"
import { SessionLock } from "./session-lock"
import { SwitchLog } from "./switchlog"
import { createNarrator } from "./narrator"
import { orChat } from "./openrouter"
import { decidePin } from "./pin"
import { modelKey, parseModel, type ClientLike } from "./types"

/** Hooks that do nothing; returned when setup fails so OpenCode keeps working untouched. */
function noopHooks(): Record<string, (...a: any[]) => Promise<void>> {
  const noop = async () => {}
  return { config: noop, event: noop, "command.execute.before": noop, "chat.message": noop }
}

/** Internal factory: builds the plugin function for a given environment (tests inject env here). */
export function createServer(env: Record<string, string | undefined>): (input: any, options?: unknown) => Promise<any> {
  return (async (input: any, _options?: unknown) => {
  try {
    const client = input.client as ClientLike
    const { config: cfg, warnings } = loadConfig(configFile(env))
    const dir = dataDir(env)
    const state = new StateStore(path.join(dir, "state.json")); state.load()
    // ledger.dir (if set) must stay inside the data dir; otherwise fall back to it and say so.
    let ledgerDir = dir
    if (cfg.ledger.dir) {
      const confined = confineToDir(cfg.ledger.dir, dir)
      if (confined) ledgerDir = confined
      else warnings.push("ledger.dir must stay inside the relay data directory; using the default")
    }
    const log = (_m: string) => { /* v1.0: no file logging; keep silent to avoid leaking content */ }
    const narrate = createNarrator(cfg.narrator)
    const controller = new Controller({
      client, cfg, lock: new SessionLock(), state, health: {}, narrate,
      switchLog: new SwitchLog(ledgerDir, cfg.ledger.enabled), env, now: Date.now, chat: orChat, log,
    })
    let warned = false
    const warnOnce = async () => {
      if (warned || warnings.length === 0) return
      warned = true
      const message = narrate("config_invalid", { detail: warnings[0] })
      if (message) try { await client.tui.showToast({ body: { message, variant: "warning" } }) } catch { /* ignore */ }
    }

    return {
      config: async (c: any) => {
        try {
          c.command = { ...(c.command ?? {}), relay: { template: "relay status", description: "opencode-model-relay: show status" } }
        } catch { /* ignore */ }
      },
      event: async ({ event }: any) => {
        try {
          await warnOnce()
          if (event?.type === "session.error") {
            const { sessionID, error } = event.properties ?? {}
            // Fire and forget: a switch can take a long time and must not block OpenCode's event loop.
            if (typeof sessionID === "string") void controller.onSessionError(sessionID, error).catch(() => {})
          } else if (event?.type === "session.status") {
            // OpenCode retries retryable errors itself and only emits session.error after many retries.
            const { sessionID, status } = event.properties ?? {}
            if (typeof sessionID === "string" && status?.type === "retry" && typeof status.message === "string") {
              const attempt = typeof status.attempt === "number" ? status.attempt : 1
              void controller.onRetryStatus(sessionID, attempt, status.message).catch(() => {})
            }
          }
        } catch { /* hooks must never throw */ }
      },
      "command.execute.before": async (i: any, out: any) => {
        try {
          if (i?.command !== "relay") return
          out.parts = []
          const message = controller.status(i.sessionID)
          await client.tui.showToast({ body: { message, variant: "info" } })
        } catch { /* ignore */ }
      },
      "chat.message": async (i: any, out: any) => {
        try {
          if (!i?.sessionID || !i.model) return
          const rec = state.get(i.sessionID)
          const d = decidePin(rec, modelKey(i.model))
          if (d.action === "pin") out.message.model = parseModel(d.to)
          else if (d.action === "clear") {
            // Drop sticky/origin but keep the switch and helper-call counters (caps must survive).
            const next: typeof rec = { switchCount: rec.switchCount, updated: Date.now() }
            if (rec.helperCalls !== undefined) next.helperCalls = rec.helperCalls
            state.set(i.sessionID, next); state.save()
          }
        } catch { /* ignore */ }
      },
    }
  } catch {
    return noopHooks()
  }
  })
}
