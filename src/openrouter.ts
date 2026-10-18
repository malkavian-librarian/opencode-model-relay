export interface OrChatArgs {
  baseUrl: string; key: string; model: string; system: string; user: string
  maxTokens: number; timeoutMs: number; zdr: boolean; fetchImpl?: typeof fetch
}

const MAX_RESPONSE_BYTES = 1_000_000
const DEFAULT_TIMEOUT_MS = 30_000

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
      raw = await Promise.race([res.text(), timeout])
    } catch {
      throw new Error(timedOut ? "OpenRouter request timed out" : "OpenRouter request failed: could not read response")
    }
    if (raw.length > MAX_RESPONSE_BYTES) throw new Error("OpenRouter response too large")
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
