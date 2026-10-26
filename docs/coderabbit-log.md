# CodeRabbit log

Record of `@coderabbitai` exchanges, so agents do not repeat past mistakes.

## Instructions for agents

- After every `@coderabbitai` exchange (findings, triage, fix or deferral), add an entry
  at the top of Entries.
- Format: `### YYYY-MM-DD - PR #<n> (issue #<m>)` then one line per finding:
  severity, file, what it said, resolution (fixed in <commit> / deferred to #<issue> / rejected: reason).
- Consult this file before touching an area with past findings.

## Entries (newest first)

### 2026-10-26 - PR #112 (issue #106)

- Informational, CodeRabbit review at `65aaf727`: SUCCESS; no actionable or inline findings. Independent QA/security and required gates PASS at that head.
- Warning, docstring coverage (0%, target 80%): rejected by QA as non-blocking metric-only feedback on the existing test harness/helper, not a product defect; no source repair.
- Informational, Linked Issues check: independent QA/security evidence requested; satisfied by the exact-head QA PASS comment on PR #112 (6417721559).
- Informational, supplemental auto-fix notice: no code changes or gates run; pending-readiness note superseded by completed CodeRabbit review and independent gates.

### 2026-10-26 - PR #111 (issue #105)

- Informational, CodeRabbit review at `7143e8a`: no actionable or inline findings; check SUCCESS. Independent QA/security and required gates PASS at that head.
- Warning, docstring coverage (50%, target 80%): rejected by QA as non-blocking metric-only feedback on existing private adapter code, not a correctness/security defect or deferred finding; no source repair.
- Informational, Auto-fix pending-review ambiguity: superseded by the completed successful review; no source changes requested or made.

### 2026-10-24 - PR #85 (issue #68), repair round 1

- Minor, `AGENTS.md`: graduated older guidance to `docs/process.md` to meet the 120-line cap.
- Minor, `src/controller.ts`: reserve helper attempts only after enactment, preserving the budget when a pick supersedes the switch.
- Major, `src/controller.ts`: discard deferred narratives when the resumed model, user turn or handover intent changes; check under the session lock.
- Minor, `src/handover.ts`: label only scheduled narratives deferred; other plain tails use the neutral unavailable label.
- Docstring warning: documented `buildHandover` and `SwitchLog.append`; controller entry points already have JSDoc. Provider coverage percentage requires a new provider check.

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
