import { describe, it, expect } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { parseModel, modelKey } from "../src/types"
import { defaultConfig, loadConfig, confineToDir, configFile, dataDir } from "../src/config"

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "relay-cfg-"))

describe("parseModel", () => {
  it("splits on the first slash only", () => {
    expect(parseModel("openrouter/z-ai/glm-5.3")).toEqual({ providerID: "openrouter", modelID: "z-ai/glm-5.3" })
    expect(modelKey(parseModel("opencode/x"))).toBe("opencode/x")
  })
  it("rejects strings without provider or model", () => {
    for (const bad of ["", "nomodel", "/x", "x/"]) expect(() => parseModel(bad)).toThrow(/provider\/model/)
  })
})

describe("config", () => {
  it("defaults are valid and safe", () => {
    const c = defaultConfig()
    expect(c.privacy.consent).toBe(false)
    expect(c.openrouter.keyEnv).toBe("OPENROUTER_API_KEY")
    expect(c.narrator.tone).toBe("plain")
    expect(c.tiers.secondary).toEqual([])
  })
  it("missing file -> defaults, no warning", () => {
    const r = loadConfig(path.join(tmp(), "nope.jsonc"))
    expect(r.warnings).toEqual([])
    expect(r.config.mode).toBe("chain-sticky")
  })
  it("parses JSONC with comments and trailing commas", () => {
    const f = path.join(tmp(), "c.jsonc")
    fs.writeFileSync(f, `{ // hi\n "tiers": { "secondary": ["opencode/a", "openrouter/z-ai/b",], }, }`)
    const r = loadConfig(f)
    expect(r.warnings).toEqual([])
    expect(r.config.tiers.secondary).toEqual(["opencode/a", "openrouter/z-ai/b"])
  })
  it("invalid JSONC or schema -> defaults + one warning", () => {
    const d = tmp()
    fs.writeFileSync(path.join(d, "a.jsonc"), `{ "tiers": `)
    expect(loadConfig(path.join(d, "a.jsonc")).warnings).toHaveLength(1)
    fs.writeFileSync(path.join(d, "b.jsonc"), `{ "tiers": { "secondary": ["bad model"] } }`)
    const r = loadConfig(path.join(d, "b.jsonc"))
    expect(r.warnings[0]).toMatch(/tiers\.secondary/)
    expect(r.config.tiers.secondary).toEqual([])
  })
  it("accepts every mode; an unknown mode falls back to defaults with one warning", () => {
    const d = tmp()
    for (const mode of ["chain-sticky", "chain-recover", "escalate"]) {
      fs.writeFileSync(path.join(d, `${mode}.jsonc`), JSON.stringify({ mode, cooldownMs: 5 }))
      const r = loadConfig(path.join(d, `${mode}.jsonc`))
      expect(r.warnings).toEqual([])
      expect(r.config.mode).toBe(mode)
    }
    fs.writeFileSync(path.join(d, "bad.jsonc"), JSON.stringify({ mode: "round-robin", cooldownMs: 5 }))
    const r = loadConfig(path.join(d, "bad.jsonc"))
    expect(r.warnings).toHaveLength(1)
    expect(r.warnings[0]).toMatch(/^invalid config \(mode: /)
    expect(r.config.mode).toBe("chain-sticky")
    expect(r.config.cooldownMs).toBe(60000)
  })
  it("rejects unknown keys (strict)", () => {
    const f = path.join(tmp(), "c.jsonc")
    fs.writeFileSync(f, `{ "bogus": 1 }`)
    expect(loadConfig(f).warnings).toHaveLength(1)
  })
  it("rejects oversized config", () => {
    const f = path.join(tmp(), "c.jsonc")
    fs.writeFileSync(f, " ".repeat(70 * 1024))
    expect(loadConfig(f).warnings[0]).toMatch(/too large/)
  })
  it("measures size in bytes, not characters", () => {
    const f = path.join(tmp(), "c.jsonc")
    fs.writeFileSync(f, "é".repeat(33 * 1024)) // 33K chars, 66 KB
    expect(loadConfig(f).warnings[0]).toMatch(/too large/)
  })
  it("blocks a non-openrouter baseUrl unless allowed, and non-https always", () => {
    const d = tmp()
    const w = (name: string, body: string) => { fs.writeFileSync(path.join(d, name), body); return loadConfig(path.join(d, name)) }
    expect(w("a.jsonc", `{"openrouter":{"baseUrl":"https://evil.example/v1"}}`).warnings).toHaveLength(1)
    expect(w("b.jsonc", `{"openrouter":{"baseUrl":"https://evil.example/v1","allowCustomBaseUrl":true}}`).warnings).toEqual([])
    expect(w("c.jsonc", `{"openrouter":{"baseUrl":"http://openrouter.ai/api/v1"}}`).warnings).toHaveLength(1)
  })
})

describe("dirs and confinement", () => {
  it("uses XDG-style dirs on every platform", () => {
    expect(configFile({}, "/home/u").replace(/\\/g, "/")).toBe("/home/u/.config/opencode/opencode-model-relay.jsonc")
    expect(dataDir({ XDG_DATA_HOME: "/x" }, "/home/u").replace(/\\/g, "/")).toBe("/x/opencode-model-relay")
  })
  it("confineToDir allows children and rejects traversal", () => {
    const root = tmp()
    expect(confineToDir("sub/file.jsonl", root)).toBe(path.resolve(root, "sub/file.jsonl"))
    expect(confineToDir("../outside", root)).toBeNull()
    expect(confineToDir(path.resolve(root, "..", "x"), root)).toBeNull()
  })
  it("allows a non-existent leaf under a real subdir", () => {
    const root = tmp()
    fs.mkdirSync(path.join(root, "real"))
    expect(confineToDir("real/new.jsonl", root)).toBe(path.join(fs.realpathSync(root), "real", "new.jsonl"))
  })
  it("allows a child named ..foo", () => {
    const root = tmp()
    expect(confineToDir("..foo", root)).toBe(path.join(fs.realpathSync(root), "..foo"))
  })
  it("rejects a symlink/junction escaping root even for a non-existent leaf", (ctx) => {
    const root = tmp()
    const outside = tmp()
    try { fs.symlinkSync(outside, path.join(root, "link"), "junction") }
    catch (e) { console.warn(`skipping: cannot create symlink/junction: ${(e as Error).message}`); ctx.skip(); return }
    expect(confineToDir("link/new.jsonl", root)).toBeNull()
  })
  it("rejects a dangling symlink/junction whose missing target is outside root", (ctx) => {
    const root = tmp()
    const outside = tmp()
    const missing = path.join(outside, "not-yet")
    try { fs.symlinkSync(missing, path.join(root, "dangling"), "junction") }
    catch (e) { console.warn(`skipping: cannot create symlink/junction: ${(e as Error).message}`); ctx.skip(); return }
    expect(fs.existsSync(missing)).toBe(false)
    expect(confineToDir("dangling", root)).toBeNull()
    expect(confineToDir("dangling/new.jsonl", root)).toBeNull()
  })
  it("allows a dangling symlink/junction whose missing target stays inside root", (ctx) => {
    const root = tmp()
    const missing = path.join(root, "later")
    try { fs.symlinkSync(missing, path.join(root, "dangling"), "junction") }
    catch (e) { console.warn(`skipping: cannot create symlink/junction: ${(e as Error).message}`); ctx.skip(); return }
    expect(confineToDir("dangling/new.jsonl", root)).toBe(path.join(fs.realpathSync(root), "later", "new.jsonl"))
  })
  it("rejects a symlink loop instead of hanging", (ctx) => {
    const root = tmp()
    try {
      fs.symlinkSync(path.join(root, "b"), path.join(root, "a"), "junction")
      fs.symlinkSync(path.join(root, "a"), path.join(root, "b"), "junction")
    } catch (e) { console.warn(`skipping: cannot create symlink/junction: ${(e as Error).message}`); ctx.skip(); return }
    expect(confineToDir("a/x", root)).toBeNull()
  })
})

describe("handover size limits", () => {
  it("caps maxToolChars at 15000 and maxTranscriptChars at 60000", () => {
    const f = path.join(tmp(), "c.jsonc")
    for (const [k, v, ok] of [["maxToolChars", 15000, true], ["maxToolChars", 15001, false], ["maxTranscriptChars", 60000, true], ["maxTranscriptChars", 60001, false]] as const) {
      fs.writeFileSync(f, JSON.stringify({ handover: { [k]: v } }))
      const r = loadConfig(f)
      expect(r.warnings.length === 0).toBe(ok)
    }
  })
})
