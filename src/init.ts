import fs from "node:fs"
import { configDir, configFile, confineToDir, defaultConfig } from "./config"

type Env = Record<string, string | undefined>

const MAX_LISTED_MODELS = 40
const CONFIG_DIR_MODE = 0o700
const CONFIG_FILE_MODE = 0o600
// Provider data is untrusted: only plain "provider/model" ids may reach the file or the tool result.
const SAFE_MODEL_ID = /^[A-Za-z0-9][\w.:@+-]*\/[\w.:@+/-]+$/
const EXAMPLE_PRIMARY = "anthropic/claude-sonnet-4-5"
const EXAMPLE_SECONDARY = "openrouter/z-ai/glm-5.2"
const EXAMPLE_TERTIARY = "openrouter/deepseek/deepseek-chat"

/** Keeps only well-formed, de-duplicated "provider/model" ids. */
export function cleanModelIds(raw: readonly unknown[]): string[] {
  const seen = new Set<string>()
  for (const m of raw) if (typeof m === "string" && SAFE_MODEL_ID.test(m)) seen.add(m)
  return [...seen]
}

interface TierLine { text: string; active: boolean }

/** Renders tier lines; commas only between active entries, so commented examples keep the file valid JSONC. */
function renderTierLines(lines: TierLine[]): string {
  const lastActive = lines.map((l) => l.active).lastIndexOf(true)
  return lines.map((l, i) => `    ${l.active ? "" : "// "}${l.text}${l.active && i < lastActive ? "," : ""}`).join("\n")
}

/**
 * Builds the commented default config. Tiers use the user's real models when known; otherwise
 * they are commented-out examples, so the file stays valid and has no effect until edited.
 */
export function buildDefaultConfigText(models: string[]): string {
  const real = cleanModelIds(models)
  const tier = (name: string, real1: string | undefined, example: string, array: boolean): TierLine => {
    const value = real1 ?? example
    return { text: `"${name}": ${array ? `[${JSON.stringify(value)}]` : JSON.stringify(value)}`, active: real1 !== undefined }
  }
  const tiers = renderTierLines([
    tier("primary", real[0], EXAMPLE_PRIMARY, false),
    tier("secondary", real[1], EXAMPLE_SECONDARY, true),
    tier("tertiary", real[2], EXAMPLE_TERTIARY, true),
  ])
  return `{
  // opencode-model-relay config. Written by relay_init; edit freely.
  // Models are "provider/model". Only the first "/" splits them.

  "tiers": {
    // Failover order: primary first, then secondary, then tertiary.
    // Lines starting with // are examples; remove the // after replacing the model.
${tiers}
  },

  "privacy": {
    // consent = false: nothing is ever sent off this machine by the plugin.
    // consent = true: after a failover the plugin sends a redacted, truncated copy of your
    // session transcript (your prompts, tool calls and tool output) directly to OpenRouter
    // (openrouter.ai) so a helper model can write the handover summary. It needs the
    // OPENROUTER_API_KEY environment variable. Requests ask for no data collection.
    // Redaction is best effort, not a guarantee. Set true only if you accept this.
    "consent": false,
    // true limits helper requests to zero-data-retention OpenRouter endpoints.
    "zdr": false
  },

  "handover": {
    // OpenRouter model that writes the handover summary (only used with consent = true).
    "model": ${JSON.stringify(defaultConfig().handover.model)}
  },

  "narrator": {
    // off | quiet | normal | chatty
    "verbosity": "normal",
    "tone": "plain"
  },

  "ledger": {
    // Local metadata-only log of switches (no prompt or response text).
    "enabled": true
  }
}
`
}

export interface InitDeps {
  env: Env
  home: string
  listModels: () => Promise<string[]>
}

async function safeList(listModels: InitDeps["listModels"]): Promise<{ models: string[]; failed: boolean }> {
  try {
    return { models: cleanModelIds(await listModels()), failed: false }
  } catch {
    return { models: [], failed: true }
  }
}

function modelSection(models: string[], failed: boolean): string {
  if (failed) return "Could not list your OpenCode models (the config file was still written). Use `opencode models` to find provider/model ids."
  if (models.length === 0) return "No configured providers were found, so the tiers are commented-out examples. Use `opencode models` to find provider/model ids."
  const shown = models.slice(0, MAX_LISTED_MODELS)
  const more = models.length - shown.length
  return `Models from your configured providers:\n${shown.map((m) => `- ${m}`).join("\n")}${more > 0 ? `\n...and ${more} more (run \`opencode models\`)` : ""}`
}

const NEXT_STEPS = [
  "Next steps:",
  "1. Edit the tiers (primary, secondary, tertiary) to the models you want in your failover chain.",
  "2. Leave privacy.consent false unless you accept sending a redacted transcript to OpenRouter for handover summaries.",
  "3. For those summaries also set the OPENROUTER_API_KEY environment variable (the key is never written to this file).",
].join("\n")

/** Creates the default config if absent. Never overwrites; never throws; returns a message for the user. */
export async function initConfig(deps: InitDeps): Promise<string> {
  const dir = configDir(deps.env, deps.home)
  const file = configFile(deps.env, deps.home)
  const confined = confineToDir(file, dir)
  if (confined === null) return `Refusing to write ${file}: it resolves outside the config directory ${dir}.`
  const { models, failed } = await safeList(deps.listModels)
  try {
    fs.mkdirSync(dir, { recursive: true, mode: CONFIG_DIR_MODE })
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code
    return `Could not create the config directory ${dir} (${typeof code === "string" ? code : "error"}). Check that it is a writable directory.`
  }
  try {
    // "wx" = exclusive create: fails if the path exists (even as a symlink), so a concurrent run cannot clobber it.
    fs.writeFileSync(confined, buildDefaultConfigText(models), { flag: "wx", mode: CONFIG_FILE_MODE })
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code
    if (code === "EEXIST") return `Config already exists at ${confined}; left untouched. Delete or edit it yourself to change it.`
    return `Could not create ${confined} (${typeof code === "string" ? code : "write error"}). Check that the directory exists and is writable.`
  }
  return [`Created ${confined} with commented defaults (privacy.consent is false).`, modelSection(models, failed), NEXT_STEPS].join("\n\n")
}
