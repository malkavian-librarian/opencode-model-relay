export interface OrChatArgs {
  baseUrl: string; key: string; model: string; system: string; user: string
  maxTokens: number; timeoutMs: number; zdr: boolean; fetchImpl?: typeof fetch
}

const MAX_RESPONSE_BYTES = 1_000_000
const MAX_CATALOG_RESPONSE_BYTES = 2 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 30_000

/** Reads at most maxBytes and cancels the response reader before rejecting overflow. */
async function readBoundedBody(res: Response, maxBytes: number, tooLarge: string): Promise<string> {
  if (!res.body) return ""
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) {
        const body = new Uint8Array(total)
        let offset = 0
        for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength }
        return new TextDecoder().decode(body)
      }
      total += next.value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        throw new Error(tooLarge)
      }
      chunks.push(next.value)
    }
  } catch (e) {
    try { await reader.cancel() } catch { /* best effort */ }
    throw e
  } finally {
    reader.releaseLock()
  }
}

export interface OpenRouterCatalogModel { id: string; pricing?: { prompt?: string } }
export interface OpenRouterCatalogArgs {
  baseUrl: string; allowCustomBaseUrl?: boolean; timeoutMs?: number; fetchImpl?: typeof fetch
}

/** Reads only the public model catalog; it deliberately sends no key or user data. */
export async function fetchOpenRouterModels(a: OpenRouterCatalogArgs): Promise<OpenRouterCatalogModel[]> {
  let parsed: URL
  try { parsed = new URL(a.baseUrl) } catch { throw new Error("OpenRouter baseUrl is invalid") }
  if (parsed.protocol !== "https:") throw new Error("OpenRouter catalog requires https")
  if (!a.allowCustomBaseUrl && parsed.hostname !== "openrouter.ai") throw new Error("OpenRouter catalog host is not allowed")
  const f = a.fetchImpl ?? fetch
  const ctl = new AbortController()
  let timedOut = false
  const timeoutMs = typeof a.timeoutMs === "number" && Number.isFinite(a.timeoutMs) && a.timeoutMs > 0 ? a.timeoutMs : DEFAULT_TIMEOUT_MS
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { timedOut = true; ctl.abort(); reject(new Error("OpenRouter catalog timed out")) }, timeoutMs) })
  timeout.catch(() => {})
  try {
    let res: Response
    try {
      res = await Promise.race([Promise.resolve().then(() => f(`${a.baseUrl.replace(/\/+$/, "")}/models`, {
        method: "GET", redirect: "manual", signal: ctl.signal,
      })), timeout])
    } catch { throw new Error(timedOut ? "OpenRouter catalog timed out" : "OpenRouter catalog request failed") }
    if (!res.ok) throw new Error(`OpenRouter catalog failed: HTTP ${res.status}`)
    const declared = Number(res.headers.get("content-length"))
    if (Number.isFinite(declared) && declared > MAX_CATALOG_RESPONSE_BYTES) throw new Error("OpenRouter catalog response too large")
    let raw: string
    try { raw = await Promise.race([readBoundedBody(res, MAX_CATALOG_RESPONSE_BYTES, "OpenRouter catalog response too large"), timeout]) } catch (e) {
      if (timedOut) throw new Error("OpenRouter catalog timed out")
      if (e instanceof Error && /too large/.test(e.message)) throw e
      throw new Error("OpenRouter catalog read failed")
    }
    let json: unknown
    try { json = JSON.parse(raw) } catch { throw new Error("OpenRouter catalog returned invalid JSON") }
    const rows = json && typeof json === "object" && Array.isArray((json as { data?: unknown }).data) ? (json as { data: unknown[] }).data : []
    return rows.flatMap((row): OpenRouterCatalogModel[] => {
      if (!row || typeof row !== "object") return []
      const r = row as { id?: unknown; pricing?: { prompt?: unknown } }
      return typeof r.id === "string" ? [{ id: r.id, pricing: typeof r.pricing?.prompt === "string" ? { prompt: r.pricing.prompt } : undefined }] : []
    })
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Errors thrown here are deliberately generic: they never include the API key,
 * the response body, or the message of an underlying fetch/parse error (which
 * could echo request headers or body content).
 */
export async function orChat(a: OrChatArgs): Promise<{ text: string; costUsd?: number }> {
  if (!a.baseUrl.startsWith("https://")) throw new Error("OpenRouter baseUrl must be https")
  const f = a.fetchImpl ?? fetch
  const ctl = new AbortController()
  let timedOut = false
  let onTimeout: () => void = () => {}
  // Rejects when the timer fires; races both the request and the body read so a
  // stalled body (headers received, body never ends) also times out.
  const timeout = new Promise<never>((_, reject) => { onTimeout = () => reject(new Error("OpenRouter request timed out")) })
  timeout.catch(() => {})
  const timeoutMs = typeof a.timeoutMs === "number" && Number.isFinite(a.timeoutMs) && a.timeoutMs > 0 ? a.timeoutMs : DEFAULT_TIMEOUT_MS
  const timer = setTimeout(() => { timedOut = true; ctl.abort(); onTimeout() }, timeoutMs)
  let res: Response | undefined
  try {
    const url = `${a.baseUrl.replace(/\/+$/, "")}/chat/completions`
    const init: RequestInit = {
      method: "POST",
      redirect: "manual",
      signal: ctl.signal,
      headers: { Authorization: `Bearer ${a.key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: a.model,
        max_tokens: a.maxTokens,
        provider: { data_collection: "deny", ...(a.zdr ? { zdr: true } : {}) },
        messages: [{ role: "system", content: a.system }, { role: "user", content: a.user }],
      }),
    }
    try {
      res = await Promise.race([Promise.resolve().then(() => f(url, init)), timeout])
    } catch {
      throw new Error(timedOut ? "OpenRouter request timed out" : "OpenRouter request failed: network error")
    }
    if (!res.ok) throw new Error(`OpenRouter request failed: HTTP ${res.status}`)
    const declared = Number(res.headers.get("content-length"))
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error("OpenRouter response too large")
    let raw: string
    try {
      raw = await Promise.race([readBoundedBody(res, MAX_RESPONSE_BYTES, "OpenRouter response too large"), timeout])
    } catch (e) {
      if (timedOut) throw new Error("OpenRouter request timed out")
      if (e instanceof Error && /too large/.test(e.message)) throw e
      throw new Error("OpenRouter request failed: could not read response")
    }
    let json: any
    try {
      json = JSON.parse(raw)
    } catch {
      throw new Error("OpenRouter returned invalid JSON")
    }
    const content = json?.choices?.[0]?.message?.content
    const text = typeof content === "string" ? content.trim() : ""
    if (!text) throw new Error("OpenRouter returned an empty completion")
    const cost = typeof json?.usage?.cost === "number" ? json.usage.cost : undefined
    return cost === undefined ? { text } : { text, costUsd: cost }
  } catch (e) {
    if (res && !res.bodyUsed) res.body?.cancel().catch(() => {})
    throw e
  } finally {
    clearTimeout(timer)
  }
}
