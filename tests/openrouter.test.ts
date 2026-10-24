import { describe, it, expect, vi } from "vitest"
import { fetchOpenRouterModels, orChat } from "../src/openrouter"

const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
const args = (fetchImpl: typeof fetch) => ({
  baseUrl: "https://openrouter.ai/api/v1", key: "sk-or-SECRETKEY123456", model: "z-ai/glm-5.2",
  system: "sys", user: "usr", maxTokens: 500, timeoutMs: 1000, zdr: false, fetchImpl,
})

describe("fetchOpenRouterModels", () => {
  it("reads the public catalog without an authorization header", async () => {
    let seen: { url: string; init: RequestInit } | undefined
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, init }
      return ok({ data: [{ id: "fake-org/glm-5.3:free", pricing: { prompt: "0" } }] })
    }) as typeof fetch
    await expect(fetchOpenRouterModels({ baseUrl: "https://openrouter.ai/api/v1", fetchImpl })).resolves.toEqual([
      { id: "fake-org/glm-5.3:free", pricing: { prompt: "0" } },
    ])
    expect(seen?.url).toBe("https://openrouter.ai/api/v1/models")
    expect(seen?.init.method).toBe("GET")
    expect(seen?.init.redirect).toBe("manual")
    expect(seen?.init.headers).toBeUndefined()
  })

  it("fails safely for an oversized catalog and a non-OpenRouter host", async () => {
    const oversized = (async () => new Response("{}", { status: 200, headers: { "content-length": "2097153" } })) as typeof fetch
    await expect(fetchOpenRouterModels({ baseUrl: "https://openrouter.ai/api/v1", fetchImpl: oversized })).rejects.toThrow(/too large/)
    let called = false
    const fetchImpl = (async () => { called = true; return ok({ data: [] }) }) as typeof fetch
    await expect(fetchOpenRouterModels({ baseUrl: "https://evil.example/api/v1", fetchImpl })).rejects.toThrow(/host/)
    expect(called).toBe(false)
  })

  it("rejects an HTTP catalog URL before sending a request", async () => {
    const fetchImpl = vi.fn(async () => ok({ data: [] }))
    await expect(fetchOpenRouterModels({ baseUrl: "http://openrouter.ai/api/v1", fetchImpl })).rejects.toThrow(/https/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("rejects catalog redirects without following them", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://evil.example" } }))
    await expect(fetchOpenRouterModels({ baseUrl: "https://openrouter.ai/api/v1", fetchImpl })).rejects.toThrow(/302/)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl.mock.calls[0]).toEqual([expect.any(String), expect.objectContaining({ redirect: "manual" })])
  })

  it("times out and aborts catalog requests even when fetch ignores cancellation", async () => {
    vi.useFakeTimers()
    let signal: AbortSignal | null | undefined
    const fetchImpl: typeof fetch = async (_url, init) => {
      signal = init?.signal
      return new Promise<Response>(() => {})
    }
    try {
      const result = expect(fetchOpenRouterModels({ baseUrl: "https://openrouter.ai/api/v1", fetchImpl, timeoutMs: 20 })).rejects.toThrow(/timed out/)
      await vi.advanceTimersByTimeAsync(20)
      await result
      expect(signal?.aborted).toBe(true)
    } finally { vi.useRealTimers() }
  })

  it("rejects an oversized catalog body without a content-length header", async () => {
    const fetchImpl = async () => new Response("a".repeat(2_097_153), { status: 200 })
    await expect(fetchOpenRouterModels({ baseUrl: "https://openrouter.ai/api/v1", fetchImpl })).rejects.toThrow(/too large/)
  })
})

describe("orChat", () => {
  it("posts the right request and parses text and cost", async () => {
    let seen: any
    const f = (async (url: string, init: any) => { seen = { url, init }; return ok({ choices: [{ message: { content: " hello " } }], usage: { cost: 0.002 } }) }) as any
    const r = await orChat(args(f))
    expect(r).toEqual({ text: "hello", costUsd: 0.002 })
    expect(seen.url).toBe("https://openrouter.ai/api/v1/chat/completions")
    expect(seen.init.redirect).toBe("manual")
    expect(seen.init.headers.Authorization).toBe("Bearer sk-or-SECRETKEY123456")
    const body = JSON.parse(seen.init.body)
    expect(body.provider.data_collection).toBe("deny")
    expect(body.messages).toEqual([{ role: "system", content: "sys" }, { role: "user", content: "usr" }])
  })
  it("adds zdr when requested", async () => {
    let body: any
    const f = (async (_u: string, init: any) => { body = JSON.parse(init.body); return ok({ choices: [{ message: { content: "x" } }] }) }) as any
    await orChat({ ...args(f), zdr: true })
    expect(body.provider.zdr).toBe(true)
  })
  it("refuses non-https base urls before any request", async () => {
    let called = false
    const f = (async () => { called = true; return ok({}) }) as any
    await expect(orChat({ ...args(f), baseUrl: "http://openrouter.ai/api/v1" })).rejects.toThrow(/https/)
    expect(called).toBe(false)
  })
  it("errors never contain the key or the response body", async () => {
    const f = (async () => ok({ error: "your key sk-or-SECRETKEY123456 is bad" }, 401)) as any
    const err = await orChat(args(f)).catch((e) => e as Error) as Error
    expect(err.message).toMatch(/401/)
    expect(err.message).not.toContain("SECRETKEY")
  })
  it("treats redirects as errors and never follows them", async () => {
    const f = (async () => new Response(null, { status: 302, headers: { location: "https://evil.example" } })) as any
    await expect(orChat(args(f))).rejects.toThrow(/302/)
  })
  it("times out", async () => {
    const f = ((_u: string, init: any) => new Promise((_res, rej) => init.signal.addEventListener("abort", () => rej(new Error("aborted"))))) as any
    await expect(orChat({ ...args(f), timeoutMs: 20 })).rejects.toThrow()
  })
  it("rejects empty completions", async () => {
    const f = (async () => ok({ choices: [{ message: { content: "  " } }] })) as any
    await expect(orChat(args(f))).rejects.toThrow(/empty/)
  })

  // --- additional hardening tests (not in the brief) ---
  it("does not leak the key through network-level fetch rejections", async () => {
    const f = (async () => { throw new Error("connect ECONNREFUSED while sending Bearer sk-or-SECRETKEY123456") }) as any
    const err = await orChat(args(f)).catch((e) => e as Error) as Error
    expect(err).toBeInstanceOf(Error)
    expect(err.message).not.toContain("SECRETKEY")
    expect(String((err as any).cause ?? "")).not.toContain("SECRETKEY")
  })
  it("handles fetch implementations that throw synchronously without leaking the key", async () => {
    const f = ((): never => { throw new Error("sync boom sk-or-SECRETKEY123456") }) as any
    const err = await orChat(args(f)).catch((e) => e as Error) as Error
    expect(err).toBeInstanceOf(Error)
    expect(err.message).not.toContain("SECRETKEY")
  })
  it("does not leak the key or body through JSON parse errors on a 200", async () => {
    const f = (async () => new Response("<html>sk-or-SECRETKEY123456 oops</html>", { status: 200 })) as any
    const err = await orChat(args(f)).catch((e) => e as Error) as Error
    expect(err.message).toMatch(/invalid|JSON/i)
    expect(err.message).not.toContain("SECRETKEY")
    expect(err.message).not.toContain("oops")
  })
  it("times out when headers arrive but the body never finishes", async () => {
    const f = (async () => new Response(new ReadableStream({ start() { /* never enqueue or close */ } }), { status: 200 })) as any
    const t0 = Date.now()
    await expect(orChat({ ...args(f), timeoutMs: 50 })).rejects.toThrow(/timed out/)
    expect(Date.now() - t0).toBeLessThan(1000)
  })
  it("rejects when choices is missing or malformed", async () => {
    await expect(orChat(args((async () => ok({})) as any))).rejects.toThrow(/empty/)
    await expect(orChat(args((async () => ok({ choices: "nope" })) as any))).rejects.toThrow(/empty/)
    await expect(orChat(args((async () => ok({ choices: [{ message: { content: { a: 1 } } }] })) as any))).rejects.toThrow(/empty/)
    await expect(orChat(args((async () => ok(null)) as any))).rejects.toThrow(/empty/)
  })
  it("normalizes a trailing slash on baseUrl", async () => {
    let url = ""
    const f = (async (u: string) => { url = u; return ok({ choices: [{ message: { content: "x" } }] }) }) as any
    await orChat({ ...args(f), baseUrl: "https://openrouter.ai/api/v1/" })
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions")
  })
  it("rejects a response whose content-length exceeds 1 MB without reading it", async () => {
    let read = false
    const f = (async () => {
      const r = new Response("{}", { status: 200, headers: { "content-length": "1000001" } })
      r.text = async () => { read = true; return "{}" }
      return r
    }) as any
    const err = await orChat(args(f)).catch((e) => e as Error) as Error
    expect(err.message).toMatch(/too large/)
    expect(read).toBe(false)
  })
  it("rejects a body longer than 1M chars even without a content-length header", async () => {
    const big = "SECRETBODY" + "a".repeat(1_000_001)
    const f = (async () => new Response(big, { status: 200 })) as any
    const err = await orChat(args(f)).catch((e) => e as Error) as Error
    expect(err.message).toMatch(/too large/)
    expect(err.message).not.toContain("SECRETBODY")
  })
  it("falls back to a 30s default for an invalid timeoutMs", async () => {
    const f = (async () => ok({ choices: [{ message: { content: "x" } }] })) as any
    for (const bad of [NaN, -5, 0, Infinity, "5" as any]) {
      expect(await orChat({ ...args(f), timeoutMs: bad })).toEqual({ text: "x" })
    }
  })
  it("ignores a non-numeric cost", async () => {
    const f = (async () => ok({ choices: [{ message: { content: "x" } }], usage: { cost: "free" } })) as any
    expect(await orChat(args(f))).toEqual({ text: "x" })
  })
})
