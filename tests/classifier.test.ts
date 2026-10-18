import { describe, it, expect } from "vitest"
import { classify, classifyRetryMessage } from "../src/classifier"

const api = (statusCode: number, responseBody = "", message = "", responseHeaders?: Record<string, string>) =>
  ({ name: "APIError", data: { statusCode, isRetryable: false, message, responseBody, responseHeaders } })

describe("classify", () => {
  it("never throws on odd input and returns unknown/not switchable", () => {
    for (const bad of [null, undefined, "boom", 42, [], {}, { name: 5 }, { data: null }]) {
      const c = classify(bad)
      expect(c.kind).toBe("unknown")
      expect(c.switchable).toBe(false)
    }
  })
  it("MessageAbortedError is a user abort", () => {
    const c = classify({ name: "MessageAbortedError", data: { message: "aborted" } })
    expect(c).toMatchObject({ kind: "user_abort", switchable: false })
  })
  it("gateway free-tier 403 is permanent and switchable", () => {
    const c = classify(api(403, `OpenCode's free tier can only be used from within OpenCode. Download it at https://opencode.ai`))
    expect(c).toMatchObject({ kind: "free_tier_403", permanent: true, switchable: true })
    expect(classify(api(403, "FreeTierError")).kind).toBe("free_tier_403")
  })
  it("429 is a transient rate limit and honours retry-after seconds", () => {
    const c = classify(api(429, "slow down", "", { "retry-after": "12" }))
    expect(c).toMatchObject({ kind: "rate_limit", retryable: true, permanent: false, switchable: true, retryAfterMs: 12000 })
  })
  it("429 with credit/quota wording, and 402, are permanent quota errors", () => {
    expect(classify(api(429, "You exceeded your current quota, check your billing")).kind).toBe("quota")
    expect(classify(api(402, "insufficient credits")).kind).toBe("quota")
    expect(classify(api(429, "insufficient_quota")).permanent).toBe(true)
  })
  it("auth: ProviderAuthError and 401/403 are permanent", () => {
    expect(classify({ name: "ProviderAuthError", data: { message: "no key" } })).toMatchObject({ kind: "auth", permanent: true, switchable: true })
    expect(classify(api(401, "bad key")).kind).toBe("auth")
    expect(classify(api(403, "forbidden")).kind).toBe("auth")
  })
  it("404 / model not found is permanent", () => {
    expect(classify(api(404, "")).kind).toBe("model_not_found")
    expect(classify(api(400, "The model `x` does not exist")).kind).toBe("model_not_found")
  })
  it("5xx and timeouts are transient and switchable", () => {
    expect(classify(api(503, "overloaded"))).toMatchObject({ kind: "server_5xx", permanent: false, switchable: true })
    expect(classify({ name: "UnknownError", data: { message: "connect ETIMEDOUT 1.2.3.4" } })).toMatchObject({ kind: "timeout", switchable: true })
  })
  it("context overflow is not switchable", () => {
    const c = classify(api(400, "This model's maximum context length is 128000 tokens"))
    expect(c).toMatchObject({ kind: "overflow", switchable: false })
    expect(classify({ name: "UnknownError", data: { message: "prompt is too long" } }).kind).toBe("overflow")
  })
  it("unrecognised failures are unknown and not switchable", () => {
    expect(classify(api(418, "teapot"))).toMatchObject({ kind: "unknown", switchable: false })
  })
  it("precision fixes", () => {
    expect(classify(api(429, "see your billing settings")).kind).toBe("rate_limit")
    expect(classify(api(429, "too many tokens per minute")).kind).toBe("rate_limit")
    expect(classify(api(400, "insufficient_quota"))).toMatchObject({ kind: "quota", permanent: true, switchable: true })
    expect(classify(api(403, "credit balance is too low")).kind).toBe("quota")
    expect(classify(api(429, "x", "", { "RETRY-AFTER": "7" })).retryAfterMs).toBe(7000)
    expect(classify(api(429, "x", "", { "retry-after": "-5" })).retryAfterMs ?? 0).toBe(0)
    expect(classify(api(429, "x", "", { "retry-after": "soon" })).retryAfterMs).toBeUndefined()
  })
})

describe("classifyRetryMessage", () => {
  it("maps retry status text", () => {
    expect(classifyRetryMessage("Rate limit exceeded").kind).toBe("rate_limit")
    expect(classifyRetryMessage("Too Many Requests").permanent).toBe(false)
    expect(classifyRetryMessage("usage limit reached").kind).toBe("quota")
    expect(classifyRetryMessage("Free tier can only be used from within opencode").kind).toBe("free_tier_403")
    expect(classifyRetryMessage("context length exceeded").switchable).toBe(false)
    expect(classifyRetryMessage("weird").switchable).toBe(false)
  })
})
