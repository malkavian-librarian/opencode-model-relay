import { describe, it, expect, vi } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import plugin, { server } from "../src/index"
import { createServer } from "../src/server"

function env() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-i-"))
  fs.mkdirSync(path.join(root, "cfg", "opencode"), { recursive: true })
  return { root, env: { XDG_CONFIG_HOME: path.join(root, "cfg"), XDG_DATA_HOME: path.join(root, "data") } }
}
const client = (toasts: string[]): any => ({
  session: { get: async () => ({ data: {} }), messages: async () => ({ data: [] }), abort: async () => ({}), prompt: async () => ({}) },
  tui: { showToast: async (a: any) => { toasts.push(a.body.message); return {} } },
})

describe("plugin entry", () => {
  it("exports a plugin module with an id", () => {
    expect(plugin.id).toBe("opencode-model-relay")
    expect(plugin.server).toBe(server)
  })
  it("loads with no config file and registers /relay", async () => {
    const e = env()
    const hooks: any = await createServer(e.env)({ client: client([]), directory: e.root })
    const cfg: any = {}
    await hooks.config(cfg)
    expect(cfg.command.relay).toBeTruthy()
  })
  it("an invalid config still loads, with one toast on first event", async () => {
    const e = env()
    fs.writeFileSync(path.join(e.root, "cfg", "opencode", "opencode-model-relay.jsonc"), `{ "bogus": true }`)
    const toasts: string[] = []
    const hooks: any = await createServer(e.env)({ client: client(toasts), directory: e.root })
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s" } } })
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s" } } })
    expect(toasts.filter((t) => /config problem/i.test(t))).toHaveLength(1)
  })
  it("a tiers-only config migrates to levels and toasts the deprecation exactly once", async () => {
    const e = env()
    fs.writeFileSync(path.join(e.root, "cfg", "opencode", "opencode-model-relay.jsonc"), JSON.stringify({ tiers: { primary: "a/1", secondary: ["b/2"] } }))
    const toasts: string[] = []
    const hooks: any = await createServer(e.env)({ client: client(toasts), directory: e.root })
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s" } } })
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s" } } })
    const t = toasts.filter((x) => /config problem/i.test(x))
    expect(t).toHaveLength(1)
    expect(t[0]).toMatch(/tiers is deprecated/)
  })
  it("an escaping ledger.dir loads, falls back, and is reported by the one-time config toast", async () => {
    const e = env()
    fs.writeFileSync(path.join(e.root, "cfg", "opencode", "opencode-model-relay.jsonc"), JSON.stringify({ ledger: { dir: path.join(e.root, "elsewhere") } }))
    const toasts: string[] = []
    const hooks: any = await createServer(e.env)({ client: client(toasts), directory: e.root })
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s" } } })
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s" } } })
    const t = toasts.filter((x) => /config problem/i.test(x))
    expect(t).toHaveLength(1)
    expect(t[0]).toContain("ledger.dir")
  })
  it("the exported server uses process.env (default export unchanged)", async () => {
    expect(Object.keys(plugin).sort()).toEqual(["id", "server", "setup"])
    const hooks: any = await (server as any)({ client: client([]), directory: "x" })
    await expect(hooks.config({})).resolves.toBeUndefined()
  })
  it("/relay command template tells the model to call relay_status", async () => {
    const e = env()
    const hooks: any = await createServer(e.env)({ client: client([]), directory: e.root })
    const cfg: any = {}
    await hooks.config(cfg)
    expect(cfg.command.relay.template).toContain("relay_status")
    expect(cfg.command.relay.description).toBeTruthy()
  })
  it("registers /relay-init whose template asks the model to call relay_init", async () => {
    const e = env()
    const hooks: any = await createServer(e.env)({ client: client([]), directory: e.root })
    const cfg: any = {}
    await hooks.config(cfg)
    expect(cfg.command["relay-init"].template).toContain("relay_init")
    expect(cfg.command["relay-init"].description).toBeTruthy()
    expect(cfg.command.relay).toBeTruthy()
  })
  it("registers relay_init as a plain tool, writes the config via client.config.providers and never leaks the key", async () => {
    const e = env()
    const c: any = client([])
    c.config = { providers: async () => ({ data: { providers: [{ id: "anthropic", key: "sk-LEAK", models: { "claude-x": {} } }] } }) }
    const hooks: any = await createServer({ ...e.env, XDG_CONFIG_HOME: path.join(e.root, "cfg2"), OPENROUTER_API_KEY: "sk-or-SECRETVALUE" })({ client: c, directory: e.root })
    const t = hooks.tool.relay_init
    expect(typeof t.description).toBe("string")
    expect(t.args).toEqual({})
    const out = await t.execute({}, { sessionID: "s1" })
    expect(out).toContain("anthropic/claude-x")
    expect(out).not.toMatch(/SECRETVALUE|sk-LEAK/)
    const file = path.join(e.root, "cfg2", "opencode", "opencode-model-relay.jsonc")
    expect(fs.existsSync(file)).toBe(true)
    expect(await t.execute({}, { sessionID: "s1" })).toMatch(/already exists/)
  })
  it("relay_init still writes the file when the client has no config API", async () => {
    const e = env()
    const hooks: any = await createServer(e.env)({ client: client([]), directory: e.root })
    const out = await hooks.tool.relay_init.execute({}, { sessionID: "s1" })
    expect(out).toMatch(/Could not list/)
    expect(fs.existsSync(path.join(e.root, "cfg", "opencode", "opencode-model-relay.jsonc"))).toBe(true)
  })
  it("no longer registers a command.execute.before hook", async () => {
    const e = env()
    const hooks: any = await createServer(e.env)({ client: client([]), directory: e.root })
    expect(hooks["command.execute.before"]).toBeUndefined()
  })
  it("registers relay_status as a plain tool definition and returns the status string", async () => {
    const e = env()
    const hooks: any = await createServer(e.env)({ client: client([]), directory: e.root })
    const t = hooks.tool.relay_status
    expect(typeof t.description).toBe("string")
    expect(t.description).toMatch(/status/i)
    expect(t.args).toEqual({})
    const out = await t.execute({}, { sessionID: "s1" })
    expect(typeof out).toBe("string")
    expect(out).toContain("chain:")
  })
  it("relay_status never reveals the API key value", async () => {
    const e = env()
    const hooks: any = await createServer({ ...e.env, OPENROUTER_API_KEY: "sk-or-SECRETVALUE" })({ client: client([]), directory: e.root })
    const out = await hooks.tool.relay_status.execute({}, { sessionID: "s1" })
    expect(out).toContain("key: set")
    expect(out).not.toContain("SECRETVALUE")
  })
  it("relay_status reports a missing key", async () => {
    const e = env()
    const hooks: any = await createServer(e.env)({ client: client([]), directory: e.root })
    expect(await hooks.tool.relay_status.execute({}, { sessionID: "s1" })).toContain("key: missing")
  })
  it("ignores unrelated events without throwing", async () => {
    const e = env()
    const hooks: any = await createServer(e.env)({ client: client([]), directory: e.root })
    await expect(hooks.event({ event: { type: "file.edited", properties: {} } })).resolves.toBeUndefined()
    await expect(hooks.event({ event: { type: "session.error", properties: {} } })).resolves.toBeUndefined()
  })
  it("session.error is dispatched without blocking the event hook", async () => {
    const e = env()
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const getCalled = vi.fn()
    const c: any = client([])
    c.session.get = async () => { getCalled(); await gate; return { data: { parentID: "p" } } }
    const hooks: any = await createServer(e.env)({ client: c, directory: e.root })
    const err = { name: "APIError", data: { message: "rate limited", statusCode: 429, isRetryable: true } }
    await hooks.event({ event: { type: "session.error", properties: { sessionID: "s1", error: err } } })
    await vi.waitFor(() => expect(getCalled).toHaveBeenCalled())
    release()
  })
  it("session.idle is dispatched to the controller without blocking the event hook", async () => {
    const e = env()
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const getCalled = vi.fn()
    const c: any = client([])
    c.session.get = async () => { getCalled(); await gate; return { data: {} } }
    const hooks: any = await createServer(e.env)({ client: c, directory: e.root })
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s9" } } })
    await vi.waitFor(() => expect(getCalled).toHaveBeenCalled())
    release()
  })
  it("never throws when setup fails (state dir unusable / bad input)", async () => {
    const hooks: any = await createServer({})({ client: undefined, directory: "x" })
    await expect(hooks.event({ event: { type: "session.error", properties: { sessionID: "s" } } })).resolves.toBeUndefined()
    await expect(hooks["chat.message"]({ sessionID: "s", model: { providerID: "a", modelID: "1" } }, { message: {} })).resolves.toBeUndefined()
    await expect(hooks.config({})).resolves.toBeUndefined()
  })
  it("chat.message pins the sticky model when the session is back on the origin model", async () => {
    const e = env()
    fs.mkdirSync(path.join(e.root, "data", "opencode-model-relay"), { recursive: true })
    fs.writeFileSync(path.join(e.root, "data", "opencode-model-relay", "state.json"),
      JSON.stringify({ v: 1, sessions: { s1: { sticky: "b/2", origin: "a/1", switchCount: 1, updated: Date.now() } } }))
    const hooks: any = await createServer(e.env)({ client: client([]), directory: e.root })
    const out: any = { message: { model: { providerID: "a", modelID: "1" } }, parts: [] }
    await hooks["chat.message"]({ sessionID: "s1", model: { providerID: "a", modelID: "1" } }, out)
    expect(out.message.model).toEqual({ providerID: "b", modelID: "2" })
  })
  it("chat.message clear keeps switchCount and helperCalls", async () => {
    const e = env()
    const file = path.join(e.root, "data", "opencode-model-relay", "state.json")
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ v: 1, sessions: { s1: { sticky: "b/2", origin: "a/1", switchCount: 2, helperCalls: 5, updated: Date.now() } } }))
    const hooks: any = await createServer(e.env)({ client: client([]), directory: e.root })
    const out: any = { message: { model: { providerID: "z", modelID: "9" } }, parts: [] }
    await hooks["chat.message"]({ sessionID: "s1", model: { providerID: "z", modelID: "9" } }, out)
    expect(out.message.model).toEqual({ providerID: "z", modelID: "9" })
    const saved = JSON.parse(fs.readFileSync(file, "utf8")).sessions.s1
    expect(saved.sticky).toBeUndefined()
    expect(saved.origin).toBeUndefined()
    expect(saved.switchCount).toBe(2)
    expect(saved.helperCalls).toBe(5)
  })
  it("chain-recover: chat.message returns a recovered origin and passes the parts through (handover is never recovered)", async () => {
    const e = env()
    fs.writeFileSync(path.join(e.root, "cfg", "opencode", "opencode-model-relay.jsonc"), JSON.stringify({ mode: "chain-recover", tiers: { primary: "a/1", secondary: ["b/2"] } }))
    const file = path.join(e.root, "data", "opencode-model-relay", "state.json")
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ v: 1, sessions: { s1: { sticky: "b/2", origin: "a/1", switchCount: 1, updated: Date.now() } } }))
    const hooks: any = await createServer(e.env)({ client: client([]), directory: e.root })
    const input = { sessionID: "s1", model: { providerID: "b", modelID: "2" } }
    const handover: any = { message: { model: { providerID: "b", modelID: "2" } }, parts: [{ type: "text", text: "<!-- opencode-model-relay -->\nx" }] }
    await hooks["chat.message"](input, handover)
    expect(handover.message.model).toEqual({ providerID: "b", modelID: "2" })
    const out: any = { message: { model: { providerID: "b", modelID: "2" } }, parts: [{ type: "text", text: "next" }] }
    await hooks["chat.message"](input, out)
    expect(out.message.model).toEqual({ providerID: "a", modelID: "1" }) // no health recorded in this process: primary is healthy
    expect(JSON.parse(fs.readFileSync(file, "utf8")).sessions.s1).toMatchObject({ switchCount: 1 })
    // the last message arrived on the old sticky model (b/2): it is re-pinned to the recovered origin (#49)
    expect(JSON.parse(fs.readFileSync(file, "utf8")).sessions.s1.sticky).toBe("a/1")
  })
})

describe("session.status retry events", () => {
  const retry = (message: string, attempt: number) => ({ event: { type: "session.status", properties: { sessionID: "s1", status: { type: "retry", attempt, message, next: 0 } } } })
  const seeded = (c: any) => {
    c.session.messages = async () => ({ data: [{ info: { id: "u1", role: "user", model: { providerID: "a", modelID: "1" } }, parts: [] }] })
    return c
  }
  it("quota text switches at attempt 1, fire-and-forget; rate limit waits for attempt 2; busy/idle ignored", async () => {
    const e = env()
    fs.writeFileSync(path.join(e.root, "cfg", "opencode", "opencode-model-relay.jsonc"), JSON.stringify({ tiers: { primary: "a/1", secondary: ["b/2"] } }))
    const c: any = seeded(client([]))
    const prompts: any[] = []
    c.session.prompt = (a: any) => { prompts.push(a); return Promise.resolve({}) }
    const hooks: any = await createServer(e.env)({ client: c, directory: e.root })
    await hooks.event({ event: { type: "session.status", properties: { sessionID: "s1", status: { type: "busy" } } } })
    await hooks.event(retry("rate limit hit", 1))
    await new Promise((r) => setTimeout(r, 30))
    expect(prompts).toHaveLength(0)
    await hooks.event(retry("You exceeded your current quota", 1))
    await vi.waitFor(() => expect(prompts).toHaveLength(1), { timeout: 3000 })
    await hooks.event(retry("You exceeded your current quota", 2))
    await new Promise((r) => setTimeout(r, 30))
    expect(prompts).toHaveLength(1)
  })
})
