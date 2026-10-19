import { z } from "zod"
import { parse, type ParseError } from "jsonc-parser"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { DEFAULT_TEMPLATE, DEFAULT_WRITER_PROMPT, DEFAULT_JUDGE_PROMPT } from "./defaults"

const modelStr = z.string().regex(/^[^/\s]+\/\S+$/, 'expected "provider/model"')

export const ConfigSchema = z
  .object({
    // Failover strategy (spec section 4; semantics in src/strategy.ts and src/pin.ts). An unknown value fails
    // validation, so the whole config falls back to defaults with the usual warning.
    mode: z.enum(["chain-sticky", "chain-recover", "escalate"]).default("chain-sticky"),
    tiers: z
      .object({
        primary: modelStr.optional(),
        secondary: z.array(modelStr).default([]),
        tertiary: z.array(modelStr).default([]),
      })
      .strict()
      .default({}),
    privacy: z
      .object({ consent: z.boolean().default(false), zdr: z.boolean().default(false) })
      .strict()
      .default({}),
    openrouter: z
      .object({
        keyEnv: z.string().min(1).default("OPENROUTER_API_KEY"),
        baseUrl: z.string().url().default("https://openrouter.ai/api/v1"),
        allowCustomBaseUrl: z.boolean().default(false),
      })
      .strict()
      .default({}),
    handover: z
      .object({
        model: z.string().min(1).default("z-ai/glm-5.2"),
        writerPrompt: z.string().min(1).default(DEFAULT_WRITER_PROMPT),
        messageTemplate: z.string().min(1).default(DEFAULT_TEMPLATE),
        maxToolChars: z.number().int().positive().max(15000).default(1500),
        maxTranscriptChars: z.number().int().positive().max(60000).default(60000),
        maxCallsPerSession: z.number().int().nonnegative().default(3),
      })
      .strict()
      .default({}),
    // Quality judge: an LLM decides after a finished turn whether a secondary/tertiary model is degraded
    // (spec section 4). Off by default; runs only with privacy.consent and the OpenRouter key.
    judge: z
      .object({
        enabled: z.boolean().default(false),
        model: modelStr.default("google/gemini-2.5-flash-lite"),
        prompt: z.string().min(1).default(DEFAULT_JUDGE_PROMPT),
        maxCallsPerSession: z.number().int().nonnegative().default(3),
        minIntervalMs: z.number().int().nonnegative().default(60000),
        maxDailyUsd: z.number().max(100).nonnegative().default(0.5),
      })
      .strict()
      .default({}),
    cooldownMs: z.number().int().positive().default(60000),
    maxSwitchesPerSession: z.number().int().positive().default(6),
    onExhausted: z.literal("stop").default("stop"),
    narrator: z
      .object({
        verbosity: z.enum(["off", "quiet", "normal", "chatty"]).default("normal"),
        tone: z.enum(["plain", "british"]).default("plain"),
      })
      .strict()
      .default({}),
    ledger: z
      .object({ enabled: z.boolean().default(true), dir: z.string().optional() })
      .strict()
      .default({}),
  })
  .strict()
  .superRefine((c, ctx) => {
    let u: URL
    try { u = new URL(c.openrouter.baseUrl) } catch { return }
    if (u.protocol !== "https:")
      ctx.addIssue({ code: "custom", path: ["openrouter", "baseUrl"], message: "must be https" })
    else if (!c.openrouter.allowCustomBaseUrl && u.hostname !== "openrouter.ai")
      ctx.addIssue({ code: "custom", path: ["openrouter", "baseUrl"], message: "host must be openrouter.ai unless allowCustomBaseUrl is true" })
  })

export type RelayConfig = z.infer<typeof ConfigSchema>
export function defaultConfig(): RelayConfig { return ConfigSchema.parse({}) }

const MAX_CONFIG_BYTES = 64 * 1024

export function loadConfig(file: string): { config: RelayConfig; warnings: string[] } {
  let text: string
  try {
    if (fs.statSync(file).size > MAX_CONFIG_BYTES)
      return { config: defaultConfig(), warnings: ["config too large; using defaults"] }
    text = fs.readFileSync(file, "utf8")
  } catch { return { config: defaultConfig(), warnings: [] } }
  const errors: ParseError[] = []
  const raw = parse(text, errors, { allowTrailingComma: true })
  if (errors.length) return { config: defaultConfig(), warnings: ["config is not valid JSONC; using defaults"] }
  const r = ConfigSchema.safeParse(raw)
  if (!r.success) {
    const msg = r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
    return { config: defaultConfig(), warnings: [`invalid config (${msg}); using defaults`] }
  }
  return { config: r.data, warnings: [] }
}

type Env = Record<string, string | undefined>
export function configDir(env: Env = process.env, home = os.homedir()): string {
  return path.join(env.XDG_CONFIG_HOME ?? path.join(home, ".config"), "opencode")
}
export function dataDir(env: Env = process.env, home = os.homedir()): string {
  return path.join(env.XDG_DATA_HOME ?? path.join(home, ".local", "share"), "opencode-model-relay")
}
export function configFile(env: Env = process.env, home = os.homedir()): string {
  return path.join(configDir(env, home), "opencode-model-relay.jsonc")
}

const MAX_LINK_HOPS = 40
const splitPath = (abs: string): { root: string; segs: string[] } => {
  const root = path.parse(abs).root
  return { root, segs: abs.slice(root.length).split(path.sep).filter(Boolean) }
}

/**
 * Resolves a path component by component. Existing components are resolved with realpath;
 * a dangling symlink (target missing, so realpath fails) is followed manually via readlink
 * so its eventual target is still checked. Missing tails are appended verbatim.
 * Throws on a symlink loop (callers treat that as "outside").
 */
function realOrResolve(p: string): string {
  let { root: cur, segs: queue } = splitPath(path.resolve(p))
  let hops = 0
  while (queue.length) {
    const seg = queue[0] as string
    queue = queue.slice(1)
    if (seg === ".") continue
    if (seg === "..") { cur = path.dirname(cur); continue }
    const next = path.join(cur, seg)
    try { cur = fs.realpathSync(next); continue } catch { /* missing or dangling: inspect below */ }
    let st: fs.Stats
    try { st = fs.lstatSync(next) } catch { return path.join(next, ...queue) }
    if (!st.isSymbolicLink()) { cur = next; continue }
    if (++hops > MAX_LINK_HOPS) throw new Error("too many symbolic links")
    const target = path.resolve(cur, fs.readlinkSync(next))
    const parts = splitPath(target)
    cur = parts.root
    queue = [...parts.segs, ...queue]
  }
  return cur
}
export function confineToDir(candidate: string, root: string): string | null {
  let r: string, resolved: string
  try {
    r = realOrResolve(root)
    resolved = realOrResolve(path.resolve(root, candidate))
  } catch { return null }
  const rel = path.relative(r, resolved)
  const outside = rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)
  return outside ? null : resolved
}
