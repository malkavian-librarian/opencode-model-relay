import os from "node:os"
import path from "node:path"
import { initConfig } from "./init"
import { Controller } from "./controller"
import { configFile, confineToDir, dataDir, loadConfig } from "./config"
import { StateStore } from "./state"
import { SessionLock } from "./session-lock"
import { SwitchLog } from "./switchlog"
import { createNarrator } from "./narrator"
import { orChat } from "./openrouter"
import { modelKey, parseModel, type ClientLike } from "./types"

// Spike (docs/spike.md): clearing command parts does not stop the model turn, so /relay asks the model to call the tool.
const RELAY_COMMAND_TEMPLATE = "Call the relay_status tool and print its output verbatim in a code block. Do nothing else."
const RELAY_TOOL_DESCRIPTION = "Show the opencode-model-relay failover status (model chain, current model, switch count, API key set or missing). Use it when the user asks for relay or failover status."

const INIT_COMMAND_TEMPLATE = "Call the relay_init tool and print its output verbatim. Do nothing else."
const INIT_TOOL_DESCRIPTION = "Create a commented default opencode-model-relay config file (never overwrites an existing one) and list the configured models. Use it only when the user asks to set up or initialise the relay."

/** Lists "provider/model" ids from OpenCode's configured providers. Reads only ids, never provider options or keys. */
async function listProviderModels(client: ClientLike): Promise<string[]> {
  if (!client.config) throw new Error("client.config unavailable")
  const res = await client.config.providers()
  const out: string[] = []
  for (const p of res?.data?.providers ?? []) {
    if (typeof p?.id !== "string") continue
    for (const modelId of Object.keys(p.models ?? {})) out.push(`${p.id}/${modelId}`)
  }
  return out
}

/** Hooks that do nothing; returned when setup fails so OpenCode keeps working untouched. */
function noopHooks(): Record<string, (...a: any[]) => Promise<void>> {
  const noop = async () => {}
  return { config: noop, event: noop, "chat.message": noop }
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
      tool: {
        relay_status: {
          description: RELAY_TOOL_DESCRIPTION,
          args: {},
          execute: async (_args: unknown, ctx: { sessionID: string }) => controller.status(ctx.sessionID),
        },
        relay_init: {
          description: INIT_TOOL_DESCRIPTION,
          args: {},
          execute: async () => {
            try { return await initConfig({ env, home: os.homedir(), listModels: () => listProviderModels(client) }) }
            catch { return "relay_init failed unexpectedly; no config was written." }
          },
        },
      },
      config: async (c: any) => {
        try {
          c.command = {
            ...(c.command ?? {}),
            relay: { template: RELAY_COMMAND_TEMPLATE, description: "Show model relay status" },
            "relay-init": { template: INIT_COMMAND_TEMPLATE, description: "Create a commented default model relay config" },
          }
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
      "chat.message": async (i: any, out: any) => {
        try {
          if (!i?.sessionID || !i.model) return
          // Pin / clear / chain-recover decisions live in the controller (it owns model health and the switch log).
          const to = controller.onChatMessage(i.sessionID, modelKey(i.model), out?.parts)
          if (to) out.message.model = parseModel(to)
        } catch { /* ignore */ }
      },
    }
  } catch {
    return noopHooks()
  }
  })
}
