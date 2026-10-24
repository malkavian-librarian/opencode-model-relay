import { describe, it, expect } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { classify } from "../src/classifier"
import { extractFromMessages } from "../src/handover"
import { RELAY_MARKER } from "../src/defaults"
import { Controller, type Deps } from "../src/controller"
import { ConfigSchema } from "../src/config"
import { SessionLock } from "../src/session-lock"
import { StateStore } from "../src/state"
import { createNarrator } from "../src/narrator"
import type { OcMessage } from "../src/types"

// Real shapes captured from a live OpenCode session (see docs/spike.md); fixtures are sanitised real captures (session ids replaced, secrets redacted).
const FIXTURES = path.join(__dirname, "fixtures")
const readJson = (name: string): any => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), "utf8"))
const errorEvent = readJson("error-401-provider.json")
const realMessages = (): OcMessage[] => readJson("messages-switch-session.json")

const PRIMARY = "openai/gpt-4o-mini"
const SECONDARY = "openrouter/meta-llama/llama-3.1-8b-instruct"
const FIRST_REQUEST = "Reply with exactly one word: pong"
const NEWEST_REQUEST = "Reply with exactly one word: ping"
const OPTS = { maxToolChars: 1500, maxTranscriptChars: 60000 }

function setup(messages: OcMessage[]) {
  const calls = { abort: [] as any[], prompt: [] as any[], chat: [] as any[] }
  const client: any = {
    session: {
      get: async () => ({ data: {} }),
      messages: async () => ({ data: messages }),
      abort: async (a: any) => { calls.abort.push(a); return {} },
      prompt: (a: any) => { calls.prompt.push(a); return Promise.resolve({}) },
    },
    tui: { showToast: async () => ({}) },
  }
  // Mirror loadConfig's tiers->levels migration (#63): the runtime consumes levels only (#66).
  const tiers = { primary: PRIMARY, secondary: [SECONDARY] }
  const cfg = ConfigSchema.parse({ tiers, levels: [tiers.primary, ...tiers.secondary], privacy: { consent: false } })
  const state = new StateStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "relay-rf-")), "state.json"), () => 1_000_000)
  state.load()
  const lock = new SessionLock()
  const d: Deps = {
    client, cfg, lock, state, health: {}, narrate: createNarrator({ verbosity: "normal", tone: "plain" }),
    switchLog: { append: () => {} }, env: {}, now: () => 1_000_000,
    chat: async (a: any) => { calls.chat.push(a); return { text: "SUMMARY" } },
    log: () => {}, switchOpts: { abortTimeoutMs: 20, abortDelayMs: 0 },
  }
  return { c: new Controller(d), d, calls }
}

describe("real fixture: session.error (401 provider auth)", () => {
  it("has the real event shape", () => {
    expect(errorEvent.event).toBe("session.error")
    expect(errorEvent.properties.error.name).toBe("APIError")
    expect(errorEvent.properties.error.data.statusCode).toBe(401)
  })
  it("classifies as permanent, switchable auth failure", () => {
    const c = classify(errorEvent.properties.error)
    expect(c.kind).toBe("auth")
    expect(c.permanent).toBe(true)
    expect(c.switchable).toBe(true)
    expect(c.retryable).toBe(false)
  })
})

describe("real fixture: extractFromMessages on a switched session", () => {
  const msgs = realMessages()

  it("relies on the real field names", () => {
    const users = msgs.filter((m) => m.info.role === "user")
    const assistants = msgs.filter((m) => m.info.role === "assistant")
    expect(users.length).toBeGreaterThan(0)
    expect(assistants.length).toBeGreaterThan(0)
    expect(users[0]!.info.model).toEqual({ providerID: "openai", modelID: "gpt-4o-mini" })
    expect(assistants[0]!.info.providerID).toBe("openai")
    expect(assistants[0]!.info.modelID).toBe("gpt-4o-mini")
    expect(typeof msgs[0]!.info.id).toBe("string")
  })

  it("lastUserText is the newest real request, skipping relay handovers", () => {
    const ex = extractFromMessages(msgs, OPTS)
    expect(ex.lastUserText).toBe(NEWEST_REQUEST)
  })

  it("the real handover message is skipped when it is the newest user message", () => {
    const upToHandover = msgs.slice(0, 4) // user, failed assistant, relay handover user, assistant
    expect(JSON.stringify(upToHandover[2])).toContain(RELAY_MARKER)
    const ex = extractFromMessages(upToHandover, OPTS)
    expect(ex.lastUserText).toBe(FIRST_REQUEST)
  })

  it("records the todowrite call as DONE", () => {
    const ex = extractFromMessages(msgs, OPTS)
    expect(ex.toolCalls.some((t) => t.name === "todowrite" && t.status === "DONE")).toBe(true)
  })

  it("transcript carries no marker text from the earlier handover", () => {
    const ex = extractFromMessages(msgs, OPTS)
    expect(ex.transcript).not.toContain("opencode-model-relay")
    expect(ex.transcript).toContain(NEWEST_REQUEST)
  })

  it("does not throw on any part type present in the real data", () => {
    const types = new Set(msgs.flatMap((m) => m.parts.map((p: any) => p.type)))
    for (const t of ["step-start", "step-finish", "tool", "text"]) expect(types.has(t)).toBe(true)
    expect(() => extractFromMessages(msgs, OPTS)).not.toThrow()
  })
})

describe("real fixture: Controller on the first failing turn", () => {
  const failing = (): OcMessage[] => realMessages().slice(0, 2)

  it("switches openai/gpt-4o-mini to the openrouter llama model with the user's request verbatim", async () => {
    const { c, d, calls } = setup(failing())
    await c.onSessionError("ses_example", errorEvent.properties.error)
    expect(calls.chat).toHaveLength(0) // no consent: nothing leaves the machine
    expect(calls.prompt).toHaveLength(1)
    expect(calls.prompt[0].body.model).toEqual({ providerID: "openrouter", modelID: "meta-llama/llama-3.1-8b-instruct" })
    expect(calls.prompt[0].body.parts[0].text).toContain(FIRST_REQUEST)
    expect(d.state.get("ses_example")).toMatchObject({ pluginPinned: SECONDARY, switchCount: 1 })
  })

  it("dedups on the newest message id", async () => {
    const msgs = failing()
    const { c, d, calls } = setup(msgs)
    await c.onSessionError("ses_example", errorEvent.properties.error)
    expect(d.lock.isDuplicate(`ses_example:${msgs[1]!.info.id}`)).toBe(true)
    await c.onSessionError("ses_example", errorEvent.properties.error)
    expect(calls.prompt).toHaveLength(1)
  })

  it("resolves the current model from the user's info.model when no assistant message exists", async () => {
    const userOnly = realMessages().filter((m) => m.info.role === "user").slice(0, 1)
    expect(userOnly).toHaveLength(1)
    const { c, calls } = setup(userOnly)
    await c.onSessionError("ses_example", errorEvent.properties.error)
    expect(calls.prompt).toHaveLength(1)
    expect(calls.prompt[0].body.model).toEqual({ providerID: "openrouter", modelID: "meta-llama/llama-3.1-8b-instruct" })
    expect(calls.prompt[0].body.parts[0].text).toContain(FIRST_REQUEST)
  })
})
