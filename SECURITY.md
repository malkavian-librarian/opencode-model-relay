# Security policy

## Supported versions

Only the latest minor release receives security fixes. v1.0 is in development and has not been published yet.

## Reporting a vulnerability

Please report privately using GitHub's "Report a vulnerability" button:
https://github.com/malkavian-librarian/opencode-model-relay/security/advisories/new

Do not open a public issue for security problems. Include the version, a description, and reproduction steps if you have them.

## Scope

In scope:

- Leakage of the OpenRouter API key (into config, logs, the switch log, errors or requests to other hosts).
- Unintended data egress: anything sent off the machine without `privacy.consent: true`, to a host other than the configured OpenRouter base URL, or without passing through redaction.
- Config and path handling: reading config from outside the user config directory, `ledger.dir` escaping the data directory, oversized or malformed config.
- Prompt-injection paths where transcript or tool output could be treated as user instructions in the handover or the quality judge.

Out of scope: vulnerabilities in OpenCode itself, OpenRouter, or the models; and secrets that the best-effort redaction patterns do not recognise.

## Data flow summary

- Main-model traffic always goes through OpenCode. The plugin does not proxy it.
- Direct network calls to OpenRouter are the optional handover summary and, when `judge.enabled` is true, the optional quality judge. Both happen only when `privacy.consent` is true and the key environment variable is set; the judge additionally never runs with the transcript's last user message carrying the plugin's own handover marker. The URL must be `https` on `openrouter.ai` unless `openrouter.allowCustomBaseUrl` is true; redirects are not followed.
- The transcript is redacted and truncated before being sent, output of sensitive files is dropped, and requests carry `provider.data_collection: "deny"`. Verdicts returned by the judge are parsed as strict JSON: free text or keys outside the expected schema are ignored, so model output cannot inject behaviour.
- Local files in `~/.local/share/opencode-model-relay`: `switches.jsonl` (metadata only, session ids HMAC'd with a random per-install salt), `state.json` (sticky sessions, cooldowns, judge/helper call counters, the daily judge spend bucket; no prompt or response text), and `salt`.
- The API key is read from an environment variable only. The `relay_status` tool and `/relay` report only whether the key is set or missing.
- The published package has no runtime dependencies: `zod` and `jsonc-parser` are bundled into `dist/index.js` at build time (`@opencode-ai/plugin` is a peer dependency provided by OpenCode).
