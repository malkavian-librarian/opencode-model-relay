import { describe, it, expect } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { buildDefaultConfigText, initConfig } from "../src/init"
import { configDir, configFile, loadConfig } from "../src/config"

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-init-"))
  const env = { XDG_CONFIG_HOME: path.join(root, "cfg") }
  return { root, env, home: root, file: configFile(env, root) }
}
const models = (...m: string[]) => async () => m

describe("buildDefaultConfigText", () => {
  it("round-trips through loadConfig with no warnings (with and without models)", () => {
    for (const list of [[], ["a/1"], ["a/1", "b/2"], ["a/1", "b/2", "c/3", "d/4"]]) {
      const s = setup()
      fs.mkdirSync(configDir(s.env, s.home), { recursive: true })
      fs.writeFileSync(s.file, buildDefaultConfigText(list))
      const { config, warnings } = loadConfig(s.file)
      expect(warnings).toEqual([])
      expect(config.privacy.consent).toBe(false)
      expect(config.tiers.primary).toBe(list[0])
    }
  })
  it("with no models, tiers are commented out examples", () => {
    const s = setup()
    fs.mkdirSync(configDir(s.env, s.home), { recursive: true })
    fs.writeFileSync(s.file, buildDefaultConfigText([]))
    const { config } = loadConfig(s.file)
    expect(config.tiers).toEqual({ secondary: [], tertiary: [] })
    expect(buildDefaultConfigText([])).toMatch(/\/\/ "primary"/)
  })
  it("uses real models, ignores malformed ids, and explains consent", () => {
    const text = buildDefaultConfigText(["a/1", "bad id\n// x", "b/2"])
    expect(text).toContain('"primary": "a/1"')
    expect(text).toContain('"secondary": ["b/2"]')
    expect(text).not.toContain("bad id")
    expect(text).toMatch(/consent[\s\S]*OpenRouter/)
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
