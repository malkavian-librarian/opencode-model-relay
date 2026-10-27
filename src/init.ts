import fs from "node:fs"
import { configDir, configFile, confineToDir, defaultConfig } from "./config"

type Env = Record<string, string | undefined>

const MAX_LISTED_MODELS = 40
const CONFIG_DIR_MODE = 0o700
const CONFIG_FILE_MODE = 0o600
// Provider data is untrusted: only plain "provider/model" ids may reach the file or the tool result.
const SAFE_MODEL_ID = /^[A-Za-z0-9][\w.:@+-]*\/[\w.:@+/-]+$/
const MAX_COMMENTED_MODELS = 10
const MAX_MODEL_ID_LENGTH = 128
const MAX_IDS_EXAMINED = 200
// The owner's 7-level ladder (levels redesign plan, Appendix A). Ids marked "verified" there may
// ship; runtime-resolvable targets resolve from the live model list, and anything absent stays a
// commented "not in your configured models" entry — the template never invents a model id.
const LADDER_GO_GLM = "opencode-go/glm-5.3"
const LADDER_OC_GLM52 = "opencode/glm-5.2"
const LADDER_SOL = "openai/gpt-6.1-sol"
const LADDER_MUSE = "opencode/muse-spark-1.3"
const LADDER_OR_GLM = "openrouter/z-ai/glm-5.3"
const LADDER_FIND_MATCH = "glm-5\\.[23]"
const LADDER_GEMINI_RE = /^openrouter\/google\/gemini/i
const LADDER_GEMINI_IMAGE_RE = /(?:image|banana|flash-tts|tts)/i
const LADDER_GEMINI_VERSION_RE = /gemini-(\d+)(?:\.(\d+))?/i

/** Resolves an exact id or same-provider slug variant; returns null when unavailable. */
function resolveLadderId(models: string[], target: string): string | null {
  if (models.includes(target)) return target
  const provider = target.slice(0, target.indexOf("/"))
  const model = target.slice(provider.length + 1)
  return models.find((m) => m.startsWith(`${provider}/`) && m.slice(provider.length + 1).startsWith(model)) ?? null
}

/** Keeps image-generation ids out and orders text Gemini candidates by numeric model version. */
function newestTextGemini(models: string[]): string | null {
  return models
    .filter((m) => SAFE_MODEL_ID.test(m) && LADDER_GEMINI_RE.test(m) && !LADDER_GEMINI_IMAGE_RE.test(m))
    .sort((a, b) => {
      const av = a.match(LADDER_GEMINI_VERSION_RE)
      const bv = b.match(LADDER_GEMINI_VERSION_RE)
      const major = Number(bv?.[1] ?? -1) - Number(av?.[1] ?? -1)
      if (major !== 0) return major
      const minor = Number(bv?.[2] ?? -1) - Number(av?.[2] ?? -1)
      return minor !== 0 ? minor : a.localeCompare(b)
    })[0] ?? null
}

/** Builds a fully commented ladder, marking explicit targets absent from the live model list. */
function buildLadderText(models: string[]): string {
  const sol = resolveLadderId(models, LADDER_SOL)
  const go = resolveLadderId(models, LADDER_GO_GLM)
  const oc52 = resolveLadderId(models, LADDER_OC_GLM52)
  const muse = resolveLadderId(models, LADDER_MUSE)
  const orGlm = resolveLadderId(models, LADDER_OR_GLM)
  const gemini = newestTextGemini(models)
  const j = (v: unknown): string => JSON.stringify(v)
  return [
    sol === null
      ? `    // ${j(LADDER_SOL)}, // #1 — not in your configured models; enable it or replace the id`
      : `    // ${j(sol)}, // #1 — resolved from your configured models`,
    go === null
      ? `    // ${j(LADDER_GO_GLM)}, // #2 — not in your configured models; enable it or replace the id`
      : `    // ${j(go)}, // #2 — resolved from your configured models`,
    oc52 === null
      ? `    // ${j(LADDER_OC_GLM52)}, // #3 — not in your configured models; enable it or replace the id`
      : `    // ${j(oc52)}, // #3 — resolved from your configured models`,
    muse === null
      ? `    // ${j(LADDER_MUSE)}, // #4 — not in your configured models; enable it or replace the id`
      : `    // ${j(muse)}, // #4 — resolved from your configured models`,
    `    // ${j({ find: { match: LADDER_FIND_MATCH, free: true } })}, // #5 — first free GLM 5.2/5.3 in OpenCode`,
    `    // ${j({ find: { match: LADDER_FIND_MATCH, free: true, via: "openrouter" } })}, // #5.5 — the same via OpenRouter`,
    orGlm === null
      ? `    // ${j(LADDER_OR_GLM)}, // #6 — not in your configured models; enable it or replace the id`
      : `    // ${j(orGlm)}, // #6 — resolved from your configured models`,
    gemini === null
       ? `    // ${j("openrouter/google/<gemini-text-id>")}, // #7 — latest Gemini text model; add one from \`opencode models\``
       : `    // ${j(gemini)}, // #7 — latest Gemini text model, resolved from your configured models`,
  ].join("\n")
}

/** Keeps only well-formed, de-duplicated "provider/model" ids; bounded work and length per id. */
export function cleanModelIds(raw: readonly unknown[]): string[] {
  const seen = new Set<string>()
  for (const m of raw.slice(0, MAX_IDS_EXAMINED)) {
    if (typeof m === "string" && m.length <= MAX_MODEL_ID_LENGTH && SAFE_MODEL_ID.test(m)) seen.add(m)
  }
  return [...seen]
}

/**
 * Builds the commented default config. The failover ladder ("levels") wraps the maintainer's
 * example (Appendix A) resolved against the live model list; everything is commented out, so the
 * file is valid and harmless until edited; discovered models only appear in a comment block.
 */
export function buildDefaultConfigText(models: string[]): string {
  const discovered = cleanModelIds(models).slice(0, MAX_COMMENTED_MODELS)
  const discoveredBlock = discovered.length === 0 ? "" :
    `    // Models configured in your OpenCode (pick your own chain):\n${discovered.map((m) => `    //   ${m}`).join("\n")}\n`
  return `{
  // opencode-model-relay config. Written by relay_init; edit freely.
  // Models are "provider/model". Only the first "/" splits them.

  // The levels ladder is not active yet; current failover still uses tiers.
  // Keep this future ladder commented. To enable failover now, add a tiers object with
  // primary, secondary and tertiary model ids (see the README).
  // Future ordered failover ladder ("levels"): top to bottom, first healthy model wins.
  // An entry is a "provider/model" id, or { "find": { "match": "<regex>", "free": true } } to resolve
  // the first matching free model at failover time ("via": "openrouter" searches the OpenRouter
  // catalog instead of your OpenCode models). The ladder below is the maintainer's example.
  // Entries marked "not in your configured models" did not resolve from this
  // machine's model list — enable the model or replace the id with one from \`opencode models\`.
${discoveredBlock}  // "levels": [
${buildLadderText(models)}
  // ],

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

/** Formats the bounded model listing, including discovery failures without provider error text. */
function modelSection(models: string[], failed: boolean): string {
  if (failed) return "Could not list your OpenCode models (the config file was still written). Use `opencode models` to find provider/model ids."
  if (models.length === 0) return "No configured providers were found, so the levels ladder is a commented-out example. Use `opencode models` to find provider/model ids."
  const shown = models.slice(0, MAX_LISTED_MODELS)
  const more = models.length - shown.length
  return `Models from your configured providers:\n${shown.map((m) => `- ${m}`).join("\n")}${more > 0 ? `\n...and ${more} more (run \`opencode models\`)` : ""}`
}

const NEXT_STEPS = [
  "Next steps:",
  "1. The levels ladder is not active yet. For failover now, configure tiers (primary, secondary, tertiary) with your own model ids; keep levels commented (see the README).",
  "2. Leave privacy.consent false unless you accept sending a redacted transcript to OpenRouter for handover summaries.",
  "3. For those summaries also set the OPENROUTER_API_KEY environment variable (the key is never written to this file).",
].join("\n")

/** Creates the default config if absent. Never overwrites; never throws; returns a message for the user. */
export async function initConfig(deps: InitDeps): Promise<string> {
  const dir = configDir(deps.env, deps.home)
  const file = configFile(deps.env, deps.home)
  const { models, failed } = await safeList(deps.listModels)
  try {
    fs.mkdirSync(dir, { recursive: true, mode: CONFIG_DIR_MODE })
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code
    return `Could not create the config directory ${dir} (${typeof code === "string" ? code : "error"}). Check that it is a writable directory.`
  }
  // Checked after the directory exists, so the final (real) directory is what gets confined.
  const confined = confineToDir(file, dir)
  if (confined === null) return `Refusing to write ${file}: it resolves outside the config directory ${dir}.`
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
