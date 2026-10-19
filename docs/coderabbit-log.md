# CodeRabbit log

Record of `@coderabbitai` exchanges, so agents do not repeat past mistakes.

## Instructions for agents

- After every `@coderabbitai` exchange (findings, triage, fix or deferral), add an entry
  at the top of Entries.
- Format: `### YYYY-MM-DD - PR #<n> (issue #<m>)` then one line per finding:
  severity, file, what it said, resolution (fixed in <commit> / deferred to #<issue> / rejected: reason).
- Consult this file before touching an area with past findings.

## Entries (newest first)

### 2026-10-19 - PR #53 (issue #26)

- Major, src/controller.ts:266 "match the verdict to the turn before switching" (a stale verdict could trigger
  a switch after a newer turn arrived during the judge call) -> fixed in 23187b0: after the call resolves, the
  judged turn must still be the newest message; new controller test covers it.
- Nitpick, tests/judge.test.ts "assert that the judge payload contains no secret token" (length assertion cannot
  detect a skipped redact) -> fixed in 23187b0: the secret sits in both retained inputs and `not.toContain` runs.
- Suggestion, tests/controller.test.ts: the no-key test should judge a real suspicious turn -> applied.
- Suggestion, controller.ts:225: compare `(daily.costUsd ?? 0)` against `maxDailyUsd` -> rejected: reset
  semantics clear `costUsd` on rollover, and the undefined-check matches the configured intent; reasoned in the
  PR comment.
