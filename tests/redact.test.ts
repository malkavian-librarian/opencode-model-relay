import { describe, it, expect } from "vitest"
import { redact, isSensitivePath, truncate } from "../src/redact"

describe("redact", () => {
  it("masks common secret shapes", () => {
    const secrets = [
      "sk-abcdefghijklmnopqrstuvwx",
      "ghp_abcdefghijklmnopqrstuvwxyz0123",
      "AKIAABCDEFGHIJKLMNOP",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop",
      "Bearer abcdefghijklmnopqrstuvwx",
    ]
    for (const s of secrets) expect(redact(`x ${s} y`)).not.toContain(s)
  })
  it("masks KEY=value lines but keeps the variable name", () => {
    const out = redact("OPENROUTER_API_KEY=abc123\nDB_PASSWORD = hunter2\nPLAIN=ok")
    expect(out).toContain("OPENROUTER_API_KEY=[REDACTED]")
    expect(out).toContain("DB_PASSWORD=[REDACTED]")
    expect(out).toContain("PLAIN=ok")
    expect(out).not.toContain("hunter2")
  })
  it("removes whole private key blocks", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIabc\ndef\n-----END RSA PRIVATE KEY-----"
    expect(redact(`before\n${pem}\nafter`)).toBe("before\n[REDACTED PRIVATE KEY]\nafter")
  })
  it("leaves ordinary code alone", () => {
    const code = "const sum = (a: number, b: number) => a + b // sk learning"
    expect(redact(code)).toBe(code)
  })

  describe("bypass hardening", () => {
    it("masks export-prefixed and quoted shell assignments with non-token values", () => {
      const out = redact('export OPENAI_API_KEY="plainsecret1"\nexport DB_PASSWORD=\'plainsecret2\'\nexport MY_TOKEN=plainsecret3')
      expect(out).not.toMatch(/plainsecret/)
      expect(out).toContain("OPENAI_API_KEY=[REDACTED]")
      expect(out).toContain("DB_PASSWORD=[REDACTED]")
      expect(out).toContain("MY_TOKEN=[REDACTED]")
    })
    it("masks Windows cmd set and PowerShell $env assignments", () => {
      const out = redact('set API_KEY=plainsecret1\nset "DB_PASSWORD=plainsecret2"\n$env:AUTH_TOKEN = "plainsecret3"\nSET MY_SECRET=plainsecret4')
      expect(out).not.toMatch(/plainsecret/)
      expect(out).toContain("API_KEY=[REDACTED]")
      expect(out).toContain("AUTH_TOKEN=[REDACTED]")
    })
    it("masks multi-line quoted values entirely", () => {
      const out = redact('SERVICE_KEY="line1secret\nline2secret\nline3secret"\nPLAIN=ok')
      expect(out).not.toMatch(/line\dsecret/)
      expect(out).toContain("SERVICE_KEY=[REDACTED]")
      expect(out).toContain("PLAIN=ok")
    })
    it("is case-insensitive on variable names", () => {
      expect(redact("db_password=abc")).not.toContain("abc")
    })
    it("masks bare keyword names", () => {
      for (const l of ["TOKEN=abc", "PASSWORD=abc", "SECRET=abc", "KEY=abc", "password=abc", "token=abc", "password=hunter2 && ls"]) {
        const out = redact(l)
        expect(out, l).not.toMatch(/abc|hunter2/)
        expect(out, l).toContain("[REDACTED]")
      }
    })
    it("masks JSON / YAML / colon forms", () => {
      const out = redact('{"password": "hunter2", \'secret\': \'v4lue\'}\npassword: plainpw\napi_key: abc123\nauth_token: "q w e"')
      expect(out).not.toMatch(/hunter2|v4lue|plainpw|abc123|q w e/)
      expect(out).toContain("[REDACTED]")
    })
    it("masks setx, CLI flags and Authorization headers", () => {
      const out = redact(
        "setx API_KEY setxsecret\nrun --token tokval1 --api-key=keyval2 --password pwval3 --secret=\"sp ace\"\nAuthorization: Basic dXNlcjpwYXNz\nAuthorization: Bearer short",
      )
      expect(out).not.toMatch(/setxsecret|tokval1|keyval2|pwval3|sp ace|dXNlcjpwYXNz|short/)
      expect(out).toContain("--token [REDACTED]")
      expect(out).toContain("--api-key=[REDACTED]")
    })
    it("masks URL credentials", () => {
      const out = redact("DATABASE_URL=postgres://user:pass@host/db\nhttps://user:pass2@github.com/x\nredis://:pw3@h\nmongodb+srv://u:p4@c")
      expect(out).not.toMatch(/pass|pw3|p4/)
      expect(out).toContain("https://[REDACTED]@github.com/x")
      expect(out).toContain("redis://[REDACTED]@h")
      expect(redact("https://example.com/a:b")).toBe("https://example.com/a:b")
    })
    it("masks curl user, query params, npmrc, cookies and short JSON bearer", () => {
      const out = redact(
        [
          "curl -u admin:s3cret https://x.io",
          "curl --user admin2:s3cret2 https://x.io",
          "https://x.io/p?access_token=qtok1&a=1&api_key=qkey2&token=qtok3",
          "//registry.npmjs.org/:_authToken=npmtok4",
          "Cookie: sid=cook5; other=cook6",
          "Set-Cookie: sid=cook7; HttpOnly",
          '{"Authorization": "Bearer abc"}',
        ].join("\n"),
      )
      expect(out).not.toMatch(/s3cret|qtok|qkey|npmtok|cook\d|abc/)
      expect(out).toContain("a=1")
      expect(out).toContain("https://x.io")
    })
    it("is idempotent", () => {
      const once = redact("DATABASE_URL=postgres://u:p@h/db\ncurl -u a:b x\n?token=t&k=1\n_authToken=z\nCookie: a=b\n\"Authorization\": \"Bearer abc\"")
      expect(redact(once)).toBe(once)
    })
    it("is idempotent (base)", () => {
      const once = redact('password: x\nTOKEN=abc\nAuthorization: Basic zzz')
      expect(redact(once)).toBe(once)
    })
    it("leaves unrelated code alone (tokenizer call has no assignment/colon)", () => {
      const code = "const tokenizer = new Tokenizer()"
      expect(redact(code)).toBe(code)
    })
    it("over-redacts max_tokens (documented, safe direction)", () => {
      expect(redact("max_tokens: 100")).toBe("max_tokens: [REDACTED]")
    })
    it("stays fast on adversarial input within the 60K-char contract", () => {
      const cap = (s: string) => s.slice(0, 60_000)
      const inputs = ["a".repeat(60_000), cap('KEY="'.repeat(200_000)), cap('"password":'.repeat(200_000)), cap("key".repeat(500_000)), cap("--".repeat(500_000))]
      for (const s of inputs) {
        const t = performance.now()
        redact(s)
        expect(performance.now() - t).toBeLessThan(250)
      }
    })
    it("smoke: a 5 MB input still completes (generous limit)", () => {
      const t = performance.now()
      redact("a".repeat(5_000_000))
      expect(performance.now() - t).toBeLessThan(5000)
    })
  })
})

describe("isSensitivePath", () => {
  it("flags env files, keys and credential files", () => {
    for (const p of [".env", "app/.env.local", "C:\\proj\\.env.production", "~/.ssh/id_rsa", "id_ed25519", "cert.pem", ".npmrc", ".netrc", "secrets.json", "aws/credentials"])
      expect(isSensitivePath(p), p).toBe(true)
  })
  it("does not flag normal files", () => {
    for (const p of ["src/env.ts", "README.md", "package.json", "src/environment.ts"]) expect(isSensitivePath(p), p).toBe(false)
  })
})

describe("truncate", () => {
  it("keeps head and tail with a marker when too long", () => {
    const big = "a".repeat(5_000_000)
    const t = truncate(big, 100)
    expect(t.length).toBeLessThan(200)
    expect(t).toContain("[truncated")
  })
  it("returns short text unchanged", () => { expect(truncate("hi", 100)).toBe("hi") })
})
