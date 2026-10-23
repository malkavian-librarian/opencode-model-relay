import { describe, it, expect } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { buildDefaultConfigText, cleanModelIds, initConfig } from "../src/init"
import { configDir, configFile, loadConfig } from "../src/config"

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-init-"))
  const env = { XDG_CONFIG_HOME: path.join(root, "cfg") }
  return { root, env, home: root, file: configFile(env, root) }
}
const models = (...m: string[]) => async () => m

describe("buildDefaultConfigText", () => {
  it("U-08: round-trips through loadConfig with no warnings and mentions levels (with and without models)", () => {
    for (const list of [[], ["a/1"], ["a/1", "b/2"], ["a/1", "b/2", "c/3", "d/4"]]) {
      const s = setup()
      fs.mkdirSync(configDir(s.env, s.home), { recursive: true })
      fs.writeFileSync(s.file, buildDefaultConfigText(list))
      const { config, warnings } = loadConfig(s.file)
      expect(warnings).toEqual([])
      expect(config.privacy.consent).toBe(false)
      // The ladder ships fully commented out: parses to defaults until the user edits it.
      expect(config.levels).toEqual([])
      expect(config.tiers).toEqual({ secondary: [], tertiary: [] })
      expect(config.tiers.primary).toBeUndefined()
    }
    expect(buildDefaultConfigText([])).toMatch(/"levels"/)
  })
  it("resolves the owner's ladder ids from the listed models and keeps every ladder line commented", () => {
    const text = buildDefaultConfigText(["openai/gpt-6.1-sol", "opencode-go/glm-5.3", "opencode/glm-5.2", "opencode/muse-spark-1.3", "openrouter/google/gemini-3.1-pro"])
    expect(text).toContain('"openai/gpt-6.1-sol"')
    expect(text).toContain('"opencode-go/glm-5.3"')
    expect(text).toContain('"opencode/glm-5.2"')
    expect(text).toContain('"openrouter/google/gemini-3.1-pro"')
    expect(text).toContain('{"find":{"match":"glm-5\\\\.[23]","free":true}}')
    expect(text).toContain('{"find":{"match":"glm-5\\\\.[23]","free":true,"via":"openrouter"}}')
    for (const marker of ['"openai/gpt-6.1-sol"', '"opencode-go/glm-5.3"', '"openrouter/google/gemini-3.1-pro"', '{"find":{"match":"glm-5\\\\.[23]"'])
      for (const line of text.split("\n").filter((l) => l.includes(marker)))
        expect(line.trimStart().startsWith("//")).toBe(true)
  })
  it("unresolvable ladder ids stay commented with a not-found note; ids are never invented", () => {
    const text = buildDefaultConfigText(["zzz/only"])
    expect((text.match(/not in your configured models/g) ?? []).length).toBeGreaterThanOrEqual(2)
    expect(text).toContain("openrouter/google/<gemini-pro-id>")
    expect(text).not.toContain("flash") // no id variant is ever fabricated
  })
  it("lists discovered ids only inside comment lines, max 10, ignoring malformed ids", () => {
    const many = Array.from({ length: 15 }, (_, i) => `prov/model${i}`)
    const text = buildDefaultConfigText(["a/1", "bad id\n// x", "b/2", ...many])
    expect(text).not.toContain("bad id")
    expect(text).toContain("Models configured in your OpenCode (pick your own chain)")
    for (const id of ["a/1", "b/2", "prov/model0"]) {
      const lines = text.split("\n").filter((l) => l.includes(id))
      expect(lines.length).toBeGreaterThan(0)
      for (const l of lines) expect(l.trimStart().startsWith("//")).toBe(true)
    }
    expect(text).not.toContain("prov/model9")
    expect(text).toMatch(/consent[\s\S]*OpenRouter/)
  })
  it("bounds work: drops ids over 128 chars and examines at most 200 entries", () => {
    expect(cleanModelIds(["a/" + "x".repeat(5000), "a/ok"])).toEqual(["a/ok"])
    const big = [...Array.from({ length: 200 }, () => "a/same"), "z/late"]
    expect(cleanModelIds(big)).toEqual(["a/same"])
    expect(buildDefaultConfigText(["a/" + "x".repeat(5000)])).not.toContain("xxxxxxxx")
  })
  it("contains no secrets", () => {
    expect(buildDefaultConfigText(["a/1"])).not.toMatch(/sk-[A-Za-z0-9]|Bearer/)
  })
})

describe("initConfig", () => {
  it("creates the file (0600 exclusive), lists models and gives next steps", async () => {
    const s = setup()
    const msg = await initConfig({ env: s.env, home: s.home, listModels: models("anthropic/claude-x", "openrouter/z-ai/glm-5.2") })
    expect(fs.existsSync(s.file)).toBe(true)
    expect(msg).toContain(s.file)
    expect(msg).toContain("- anthropic/claude-x")
    expect(msg).toContain("OPENROUTER_API_KEY")
    expect(loadConfig(s.file).warnings).toEqual([])
    if (process.platform !== "win32") expect(fs.statSync(s.file).mode & 0o777).toBe(0o600)
  })
  it("never overwrites an existing file and names its path", async () => {
    const s = setup()
    fs.mkdirSync(configDir(s.env, s.home), { recursive: true })
    fs.writeFileSync(s.file, "{ /* mine */ }")
    const msg = await initConfig({ env: s.env, home: s.home, listModels: models("a/1") })
    expect(msg).toMatch(/already exists/)
    expect(msg).toContain(s.file)
    expect(fs.readFileSync(s.file, "utf8")).toBe("{ /* mine */ }")
  })
  it("reports an unwritable directory without throwing", async () => {
    const s = setup()
    fs.mkdirSync(s.env.XDG_CONFIG_HOME, { recursive: true })
    fs.writeFileSync(configDir(s.env, s.home), "i am a file, not a directory")
    const msg = await initConfig({ env: s.env, home: s.home, listModels: models() })
    expect(msg).toMatch(/Could not create the config directory/)
  })
  it("handles no providers", async () => {
    const s = setup()
    const msg = await initConfig({ env: s.env, home: s.home, listModels: models() })
    expect(msg).toMatch(/No configured providers/)
    expect(fs.existsSync(s.file)).toBe(true)
  })
  it("a listing failure is non-fatal and noted", async () => {
    const s = setup()
    const msg = await initConfig({ env: s.env, home: s.home, listModels: async () => { throw new Error("boom sk-SECRET") } })
    expect(fs.existsSync(s.file)).toBe(true)
    expect(msg).toMatch(/Could not list/)
    expect(msg).not.toContain("SECRET")
  })
  it("caps the listed models at 40 and says how many more", async () => {
    const s = setup()
    const many = Array.from({ length: 45 }, (_, i) => `p/m${i}`)
    const msg = await initConfig({ env: s.env, home: s.home, listModels: models(...many) })
    expect(msg).toContain("- p/m39")
    expect(msg).not.toContain("- p/m40")
    expect(msg).toContain("5 more")
  })
  it("refuses a config path that resolves outside the config dir (symlinked dir entry)", async () => {
    const s = setup()
    const dir = configDir(s.env, s.home)
    fs.mkdirSync(dir, { recursive: true })
    const outside = path.join(s.root, "outside")
    fs.mkdirSync(outside)
    try { fs.symlinkSync(path.join(outside, "target.jsonc"), s.file) } catch { return } // symlinks need privileges on Windows
    const msg = await initConfig({ env: s.env, home: s.home, listModels: models() })
    expect(msg).toMatch(/Refusing|already exists/)
    expect(fs.existsSync(path.join(outside, "target.jsonc"))).toBe(false)
  })
  it("never leaks the API key", async () => {
    const s = setup()
    const msg = await initConfig({ env: { ...s.env, OPENROUTER_API_KEY: "sk-or-SECRETVALUE" }, home: s.home, listModels: models("a/1") })
    expect(msg).not.toContain("SECRETVALUE")
    expect(fs.readFileSync(s.file, "utf8")).not.toContain("SECRETVALUE")
  })
})
