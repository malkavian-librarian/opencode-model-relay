const PEM = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g
const TOKENS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{16,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /Bearer\s+[A-Za-z0-9._~+/-]{16,}=*/g,
]
// KEY=value assignments. Accepts an optional `export` / `set` / `$env:` prefix (shell, cmd, PowerShell),
// and quoted values that may span several lines.
const KEY_LINE =
  /^([ \t]*(?:(?:export|set)[ \t]+"?|\$env:)?[A-Za-z0-9_]{0,100}(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)[A-Za-z0-9_]{0,100})[ \t]*=[ \t]*(?:"[^"]*"|'[^']*'|.+)$/gim
// HTTP Authorization header: mask the whole value (Basic/Bearer/any scheme).
const AUTH_HEADER = /\b(Authorization["']?[ \t]*:[ \t]*)("[^"\n]*"|'[^'\n]*'|[^\r\n]+)/gi
// Cookie / Set-Cookie header values.
const COOKIE_HEADER = /\b((?:Set-)?Cookie["']?[ \t]*:[ \t]*)("[^"\n]*"|'[^'\n]*'|[^\r\n]+)/gi
// Credentials embedded in URLs (scheme://user:pass@host). Scheme length is bounded to keep scanning linear.
const URL_CREDS = /([a-z][a-z0-9+.-]{0,30}:\/\/)[^\s/:@]*:[^\s/@]+@/gi
// curl -u user:pass / --user user:pass
const CURL_USER = /((?:^|[ \t])(?:-u[ \t]+|--user(?:[ \t]+|=)))("[^"\n]*"|'[^'\n]*'|\S+)/gim
// Query-string params whose name looks secret: ?access_token=..., &api_key=...
const QUERY_PARAM =
  /([?&][A-Za-z0-9_.-]{0,40}(?:key|token|secret|passw(?:or)?d|credential)[A-Za-z0-9_.-]{0,40}=)[^&\s#"']+/gi
// npm .npmrc auth entries: //registry/:_authToken=..., _auth=..., _password=...
const NPMRC = /(_auth(?:Token)?=|_password=)\S+/gi
// JSON / YAML / colon forms. Matching starts at the keyword (no unbounded leading class) and the
// trailing class is bounded, so scanning stays linear. Value is replaced without quotes (idempotent).
const COLON_FORM =
  /((?:key|token|secret|passw(?:or)?d|credential)[A-Za-z0-9_.-]{0,40}["']?[ \t]*:[ \t]*)("[^"\n]*"|'[^'\n]*'|[^\s,}#"']+)/gi
// `setx NAME value` (cmd).
const SETX =
  /\b(setx[ \t]+[A-Za-z0-9_]{0,100}(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)[A-Za-z0-9_]{0,100}[ \t]+)("[^"\n]*"|'[^'\n]*'|\S+)/gi
// CLI flags: --token abc, --api-key=abc, --password "abc".
const CLI_FLAG =
  /(--[A-Za-z0-9-]{0,40}(?:key|token|secret|passw(?:or)?d|credential)[A-Za-z0-9-]{0,40}(?:[ \t]+|[ \t]*=[ \t]*))("[^"\n]*"|'[^'\n]*'|[^\s"']+)/gi

// Contract: callers must truncate input first (<= ~60K chars); a few rules cost ~0.5 ms per 1K chars on adversarial input.
export function redact(text: string): string {
  let out = text.replace(PEM, "[REDACTED PRIVATE KEY]")
  out = out.replace(URL_CREDS, "$1[REDACTED]@")
  for (const re of TOKENS) out = out.replace(re, "[REDACTED]")
  out = out.replace(COOKIE_HEADER, "$1[REDACTED]")
  out = out.replace(CURL_USER, "$1[REDACTED]")
  out = out.replace(QUERY_PARAM, "$1[REDACTED]")
  out = out.replace(NPMRC, "$1[REDACTED]")
  out = out.replace(KEY_LINE, (_m, name: string) => `${name.trim()}=[REDACTED]`)
  out = out.replace(AUTH_HEADER, "$1[REDACTED]")
  out = out.replace(SETX, "$1[REDACTED]")
  out = out.replace(CLI_FLAG, "$1[REDACTED]")
  out = out.replace(COLON_FORM, "$1[REDACTED]")
  return out
}

const SENSITIVE = /(^|[\\/])\.env(\..*)?$|id_rsa|id_ed25519|\.pem$|\.p12$|\.pfx$|(^|[\\/])credentials$|(^|[\\/])\.npmrc$|(^|[\\/])\.netrc$|(^|[\\/])secrets?\.(json|ya?ml)$/i
export function isSensitivePath(p: string): boolean {
  return SENSITIVE.test(p)
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  const half = Math.floor(max / 2)
  return `${text.slice(0, half)}\n[truncated ${text.length - max} chars]\n${text.slice(text.length - half)}`
}
