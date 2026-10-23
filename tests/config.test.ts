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
    expect(c.levels).toEqual([])
  })
  it("missing file -> defaults, no warning", () => {
    const r = loadConfig(path.join(tmp(), "nope.jsonc"))
    expect(r.warnings).toEqual([])
    expect(r.config.cooldownMs).toBe(60000)
    expect(r.config.levels).toEqual([])
  })
  it("parses JSONC with comments and trailing commas", () => {
    const f = path.join(tmp(), "c.jsonc")
    fs.writeFileSync(f, `{ // hi\n "tiers": { "secondary": ["opencode/a", "openrouter/z-ai/b",], }, }`)
    const r = loadConfig(f)
    // tiers present, levels absent -> auto-migration plus one deprecation warning (AC-03)
    expect(r.warnings).toHaveLength(1)
    expect(r.warnings[0]).toMatch(/tiers is deprecated/)
    expect(r.config.tiers.secondary).toEqual(["opencode/a", "openrouter/z-ai/b"])
    expect(r.config.levels).toEqual(["opencode/a", "openrouter/z-ai/b"])
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
  it("mode is removed (#66): a config that still sets it is rejected with one warning and falls to defaults", () => {
    const d = tmp()
    for (const mode of ["chain-sticky", "chain-recover", "escalate", "round-robin"]) {
      fs.writeFileSync(path.join(d, `${mode}.jsonc`), JSON.stringify({ mode, cooldownMs: 5 }))
      const r = loadConfig(path.join(d, `${mode}.jsonc`))
      expect(r.warnings).toHaveLength(1)
      expect(r.warnings[0]).toMatch(/mode/)
      expect(r.config.cooldownMs).toBe(60000)
    }
  })
  it("a config without mode is clean", () => {
    const f = path.join(tmp(), "c.jsonc")
    fs.writeFileSync(f, JSON.stringify({ cooldownMs: 5 }))
    expect(loadConfig(f).warnings).toEqual([])
    expect(loadConfig(f).config.cooldownMs).toBe(5)
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

describe("levels ladder (issue #63)", () => {
  const loadLevels = (...levels: unknown[]) => {
    const f = path.join(tmp(), "l.jsonc")
    fs.writeFileSync(f, JSON.stringify({ levels }))
    return loadConfig(f)
  }
  // The owner's ladder (plan Appendix A); strings plus find matchers.
  const LADDER = [
    "openai/gpt-6.1-sol",
    "opencode-go/glm-5.3",
    "opencode/glm-5.2",
    "opencode/muse-spark-1.3",
    { find: { match: "glm-5\\.[23]", free: true } },
    { find: { match: "glm-5\\.[23]", free: true, via: "openrouter" } },
    "openrouter/z-ai/glm-5.3",
    "openrouter/google/gemini-3.1-pro",
  ]
  it("U-01 parses a mixed ladder (strings and find matchers) to the exact structure", () => {
    const r = loadLevels(...LADDER)
    expect(r.warnings).toEqual([])
    expect(r.config.levels).toEqual(LADDER)
  })
  it("U-02 dedupes duplicate entries, first occurrence wins", () => {
    const r = loadLevels("a/b", { find: { match: "x" } }, "a/b", { find: { match: "x" } }, { find: { match: "x", free: true } })
    expect(r.config.levels).toEqual(["a/b", { find: { match: "x" } }, { find: { match: "x", free: true } }])
  })
  it("U-03 tiers present, levels absent -> migrates with one deprecation warning", () => {
    const f = path.join(tmp(), "t.jsonc")
    fs.writeFileSync(f, JSON.stringify({ tiers: { primary: "a/1", secondary: ["b/2", "c/3"], tertiary: ["d/4"] } }))
    const r = loadConfig(f)
    expect(r.warnings).toHaveLength(1)
    expect(r.warnings[0]).toMatch(/tiers is deprecated/)
    expect(r.config.levels).toEqual(["a/1", "b/2", "c/3", "d/4"])
    // tiers keeps parsing this release (the rewiring child removes it)
    expect(r.config.tiers.primary).toBe("a/1")
  })
  it("U-03 both present -> levels skips migration and warns that failover still uses tiers", () => {
    const f = path.join(tmp(), "t.jsonc")
    fs.writeFileSync(f, JSON.stringify({ tiers: { primary: "a/1" }, levels: ["z/9"] }))
    const r = loadConfig(f)
    expect(r.warnings).toHaveLength(1)
    expect(r.warnings[0]).toBe("tiers is deprecated: levels is set, so migration is skipped; current failover still uses tiers")
    expect(r.config.levels).toEqual(["z/9"])
    expect(r.config.tiers.primary).toBe("a/1")
  })
  it("caps migrated tiers after deduplication and falls back to safe defaults on overflow", () => {
    const f = path.join(tmp(), "t.jsonc")
    const secondary = Array.from({ length: 31 }, (_, i) => `p/m${i}`)
    for (const overflow of [false, true]) {
      fs.writeFileSync(f, JSON.stringify({
        tiers: { primary: "p/primary", secondary, tertiary: overflow ? ["p/extra"] : secondary },
        privacy: { consent: true },
      }))
      const r = loadConfig(f)
      expect(r.warnings).toHaveLength(1)
      if (overflow) {
        expect(r.warnings[0]).toBe("invalid config (levels[32]: more than 32 levels); using defaults")
        expect(r.config).toEqual(defaultConfig())
      } else {
        expect(r.warnings[0]).toMatch(/auto-migrated/)
        expect(r.config.levels).toEqual(["p/primary", ...secondary])
      }
    }
  })
  it("U-04 an invalid entry drops the config to defaults with a warning naming the level index", () => {
    const r = loadLevels("a/1", "b/2", "c/3", "d/4", 42)
    expect(r.warnings).toHaveLength(1)
    expect(r.warnings[0]).toMatch(/levels\[4\]/)
    expect(r.config.levels).toEqual([])
  })
  it("U-05 an over-length or invalid find.match warns naming the index and the field", () => {
    for (const bad of [{ find: { match: "x".repeat(65) } }, { find: { match: "a[b" } }]) {
      const r = loadLevels("a/1", "b/2", "c/3", "d/4", bad)
      expect(r.warnings).toHaveLength(1)
      expect(r.warnings[0]).toMatch(/levels\[4\]/)
      expect(r.warnings[0]).toMatch(/find\.match/)
      expect(r.config.levels).toEqual([])
    }
  })
  it("U-06 more than 32 levels falls back to defaults with a warning naming the cap", () => {
    const r = loadLevels(...Array.from({ length: 33 }, (_, i) => `p/m${i}`))
    expect(r.warnings).toHaveLength(1)
    expect(r.warnings[0]).toMatch(/32/)
    expect(r.config.levels).toEqual([])
  })
})
