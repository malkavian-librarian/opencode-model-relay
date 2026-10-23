import { z } from "zod"
import { parse, type ParseError } from "jsonc-parser"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { DEFAULT_TEMPLATE, DEFAULT_WRITER_PROMPT, DEFAULT_JUDGE_PROMPT } from "./defaults"

const modelStr = z.string().regex(/^[^/\s]+\/\S+$/, 'expected "provider/model"')

const MAX_LEVELS = 32
const FIND_MATCH_MAX = 64
const LEVELS_CAP_MSG = `more than ${MAX_LEVELS} levels`

/** Rejects malformed matcher sources before configuration reaches runtime consumers. */
const isValidRegexSource = (m: string): boolean => { try { void new RegExp(m); return true } catch { return false } }

// A find level resolves to the first matching model at failover time (strategy child); here it is
// only validated: the matcher is a regex source of bounded length.
const findEntry = z
  .object({
    find: z
      .object({
        match: z.string().min(1).max(FIND_MATCH_MAX).refine(isValidRegexSource, "invalid regex"),
        free: z.boolean().optional(),
        via: z.literal("openrouter").optional(),
      })
      .strict(),
  })
  .strict()
const LEVEL_ENTRY = z.union([modelStr, findEntry])
type LevelEntry = z.infer<typeof LEVEL_ENTRY>

export const ConfigSchema = z
  .object({
    // Deprecated failover strategy: still parsed so the controller compiles; loadConfig warns when
    // it is present and the rewiring child (#66) removes the field.
    mode: z.enum(["chain-sticky", "chain-recover", "escalate"]).default("chain-sticky"),
    tiers: z
      .object({
        primary: modelStr.optional(),
        secondary: z.array(modelStr).default([]),
        tertiary: z.array(modelStr).default([]),
      })
      .strict()
      .default({}),
    // Ordered failover ladder (levels redesign plan section 4.1): tried top to bottom. Entries are
    // "provider/model" strings or find matchers resolved at failover time (strategy child, #64).
    // Capped and deduped in loadConfig; any invalid entry drops the whole config to defaults with a
    // warning naming the level index, so the failure is actionable instead of silently discarded.
    levels: z.array(LEVEL_ENTRY).max(MAX_LEVELS, LEVELS_CAP_MSG).default([]),
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

/** Formats indexed validation paths so users can locate invalid configuration entries. */
const fmtPath = (p: readonly (string | number)[]): string => {
  let out = ""
  for (const seg of p) out += typeof seg === "number" ? `[${seg}]` : (out === "" ? seg : `.${seg}`)
  return out
}

/** Names the authored level index and invalid field; returns null for unrelated issues. */
function levelIssueMessage(issue: z.ZodIssue): string | null {
  if (issue.path[0] !== "levels") return null
  const index = issue.path[1]
  if (typeof index !== "number") return null
  const restOf = (p: readonly (string | number)[]): string => fmtPath(p.slice(2))
  if (issue.path.length > 2) return `levels[${index}]: invalid ${restOf(issue.path)}`
  if (issue.code === "invalid_union") {
    // A total entry mismatch collapses member errors into one union issue; dig out the deepest member field.
    let rest = ""
    for (const member of issue.unionErrors)
      for (const memberIssue of member.issues) {
        const r = restOf(memberIssue.path)
        if (r.length > rest.length) rest = r
      }
    return rest !== "" ? `levels[${index}]: invalid ${rest}` : `levels[${index}]: invalid entry`
  }
  return `levels[${index}]: invalid entry`
}

/** Identifies equivalent schema-normalized entries for ladder deduplication. */
const levelKey = (l: LevelEntry): string => (typeof l === "string" ? l : JSON.stringify(l))

/** Dedupes the ladder, keeping the first occurrence of each distinct entry. */
const dedupeLevels = (ls: LevelEntry[]): LevelEntry[] =>
  [...new Map(ls.map((l) => [levelKey(l), l] as [string, LevelEntry])).values()]

/** Loads bounded JSONC, validates and migrates it, or returns safe defaults on invalid input. */
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
    const msg = r.error.issues
      .map((i) => levelIssueMessage(i) ?? `${fmtPath(i.path)}: ${i.message}`)
      .join("; ")
    return { config: defaultConfig(), warnings: [`invalid config (${msg}); using defaults`] }
  }
  const c = r.data
  // Presence checks use the raw object: schema defaults are not user-authored, so they must not
  // trigger deprecation or migration paths.
  const hasKey = (k: string): boolean => { const o: unknown = raw; return typeof o === "object" && o !== null && !(o instanceof Array) && k in o }
  const levelsPresent = hasKey("levels")
  const tiersPresent = hasKey("tiers")
  const warnings: string[] = []
  if (levelsPresent) {
    c.levels = dedupeLevels(c.levels)
    // Explicit levels skip migration; the existing runtime still consumes tiers until rewiring.
    if (tiersPresent) warnings.push("tiers is deprecated: levels is set, so migration is skipped; current failover still uses tiers")
  } else if (tiersPresent) {
    const walk = [c.tiers.primary, ...c.tiers.secondary, ...c.tiers.tertiary]
    const migratedLevels = dedupeLevels(walk.filter((m): m is string => m !== undefined))
    if (migratedLevels.length > MAX_LEVELS)
      return { config: defaultConfig(), warnings: [`invalid config (levels[${MAX_LEVELS}]: ${LEVELS_CAP_MSG}); using defaults`] }
    c.levels = migratedLevels
    warnings.push("tiers is deprecated: auto-migrated to levels (primary -> levels[0], then secondary and tertiary)")
  }
  if (hasKey("mode"))
    warnings.push("mode is deprecated: accepted but still honored; remove it from the config")
  return { config: c, warnings }
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
