import type { Classified, FailureKind } from "./types"

const RE = {
  freeTier: /free tier can only be used from within opencode|FreeTierError/i,
  quota: /insufficient[_ ]?(credit|quota|funds)|exceeded your current quota|billing (hard )?limit|check your plan and billing details|credit balance|out of credits/i,
  overflow: /context (length|window)|maximum context|too many tokens in (the )?(prompt|request|context)|prompt is too long|exceeds the (model'?s )?(context|limit)/i,
  notFound: /model\b[^.\n]{0,60}(not found|does not exist)|unknown model/i,
  timeout: /timed? ?out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|socket hang up/i,
  usageLimit: /\busage limit (?:(?:has been |is )?(?:reached|exceeded|hit)|resets?\b)|\b(reached|exceeded|hit) (your |the )?usage limit\b/i,
  freeUsageLimit: /\bfree usage limit\b/i,
  resetHint: /resets?\b|try again|retry/i,
}

const unknown: Classified = { kind: "unknown", retryable: false, permanent: false, switchable: false }
const mk = (kind: FailureKind, permanent: boolean, extra: Partial<Classified> = {}): Classified => ({
  kind, retryable: !permanent, permanent, switchable: true, ...extra,
})

export function classify(err: unknown): Classified {
  try {
    if (typeof err !== "object" || err === null) return unknown
    const e = err as Record<string, any>
    const name = typeof e.name === "string" ? e.name : ""
    const data = (typeof e.data === "object" && e.data !== null ? e.data : e) as Record<string, any>
    const status = typeof data.statusCode === "number" ? data.statusCode : undefined
    const text = `${data.responseBody ?? ""} ${data.message ?? ""}`

    if (name === "MessageAbortedError") return { kind: "user_abort", retryable: false, permanent: false, switchable: false }
    if (name === "ProviderAuthError") return mk("auth", true)
    if (status !== 429 && RE.overflow.test(text)) return { kind: "overflow", retryable: false, permanent: false, switchable: false }
    if (RE.freeTier.test(text)) return mk("free_tier_403", true)
    if (status === 402 || (status !== 429 && RE.quota.test(text))) return mk("quota", true)
    if (status === 429 && RE.quota.test(text)) return mk("quota", true)
    if (status === 401 || status === 403) return mk("auth", true)
    // Usage exhaustion is weaker evidence than explicit auth/quota. Reset hints must be
    // checked here, before classifyRetryMessage delegates, to avoid permanent blacklisting.
    const usageLimit = RE.usageLimit.test(text)
    if (usageLimit && !RE.resetHint.test(text)) return mk(RE.freeUsageLimit.test(text) ? "free_tier_403" : "quota", true)
    if (status === 429 || usageLimit) {
      const h = data.responseHeaders as Record<string, string> | undefined
      const key = h && typeof h === "object" ? Object.keys(h).find((k) => k.toLowerCase() === "retry-after") : undefined
      const raw = key !== undefined ? String(h![key]).trim() : ""
      const secs = /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : NaN
      return mk("rate_limit", false, Number.isFinite(secs) ? { retryAfterMs: Math.max(0, secs * 1000) } : {})
    }
    if (status === 404 || RE.notFound.test(text)) return mk("model_not_found", true)
    if (status !== undefined && status >= 500) return mk("server_5xx", false)
    if (RE.timeout.test(text)) return mk("timeout", false)
    return unknown
  } catch {
    return unknown
  }
}

// Why this wording: a retry message is free text and a permanent verdict blacklists the model
// until restart, so a false "permanent" is far costlier than a false "transient". Bare
// "billing" / "usage limit" show up in transient rate-limit hints ("see your billing page",
// "usage limit resets at 5pm"), so only specific exhaustion phrases are permanent.
const RETRY_TEXT = {
  permanent: /quota exceeded|credit balance|check your plan and billing|billing hard limit|update your billing/i,
  transient: /rate.?limit|too many requests|overloaded|capacity exceeded/i,
}

/**
 * Classifies the human-readable `message` of an OpenCode `session.status` retry event
 * (no status code is available there). Text-only, so only quota/rate-limit wording is added on top of classify().
 */
export function classifyRetryMessage(message: string): Classified {
  const c = classify({ name: "UnknownError", data: { message } })
  if (c.kind !== "unknown") return c
  if (RETRY_TEXT.permanent.test(message)) return mk("quota", true)
  if (RETRY_TEXT.transient.test(message)) return mk("rate_limit", false)
  return unknown
}
