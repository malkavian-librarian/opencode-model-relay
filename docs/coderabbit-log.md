# CodeRabbit log

Record of `@coderabbitai` exchanges, so agents do not repeat past mistakes.

## Instructions for agents

- After every `@coderabbitai` exchange (findings, triage, fix or deferral), add an entry
  at the top of Entries.
- Format: `### YYYY-MM-DD - PR #<n> (issue #<m>)` then one line per finding:
  severity, file, what it said, resolution (fixed in <commit> / deferred to #<issue> / rejected: reason).
- Consult this file before touching an area with past findings.

## Entries (newest first)

### 2026-10-27 - PR #123 (issue #122), repair round 1

- Medium, `src/controller.ts`: circular cap handling also intercepted `no_candidates` and skipped the existing exhaustion fallback -> fixed by limiting the early stop to `switch_cap`; circular mode still avoids fallback only at its configured cap.
- Medium, `src/controller.ts`: an owner pick superseding a pending switch retained circular progress -> fixed by clearing origin, transition and completed-flow fields with the existing rollback.
- Medium, `src/strategy.ts`: default switch budget could stop before three configured flows -> fixed by scaling the default budget to the configured flow count while preserving explicit caps.
- Medium, `src/strategy.ts`: filtering out unresolved find entries changed their positions -> fixed by retaining ladder slots and resolving cached find entries by position.
- Medium, `src/strategy.ts`: all candidates in quarantine produced no circular hop -> fixed by a second pass that uses a healthy quarantined model only as last resort. Added status and strategy regressions; full local gates pass on remediation commit.
- Warning, docstring coverage: added the persisted-session sanitizer contract docstring; remaining analyzer feedback is non-blocking if the check remains advisory.

### 2026-10-27 - PR #123 (issue #122), repair round 2

- Minor, `src/strategy.ts`: a resolved find entry could return the current model and waste a switch -> fixed by skipping same-model circular candidates and adding coverage.
- Minor, `src/controller.ts`: invalidating a failed resolved find cache could erase its authored circular position -> fixed by retaining the failed current entry's slot for the active walk; local focused tests and typecheck pass.

### 2026-10-27 - PR #123 (issue #122), repair round 3

- Minor, `src/controller.ts`: an expired find cache could erase the current authored slot -> fixed by persisting the bounded find-entry key with circular progress and reusing it after cache invalidation.
- Minor, `src/controller.ts`: an off-ladder starting model could remain the circular origin forever -> fixed by rebasing the first circular origin to the selected ladder target; persisted progress remains bounded.

### 2026-10-27 - PR #119 (issue #117)

- Three actionable findings on the original head: prioritize the real OpenCode tool field with metadata fallbacks, document the hand-written ToolPart-shaped fixture, and record the zero-stats-cost Gotcha -> fixed in `62f66f3`; the branch was then merged forward with `origin/main` as `42a879c` after #116 landed. Fresh CI and CodeRabbit checks passed on the final head; PR merged as `fea213b`.

### 2026-10-26 - PR #116 (issue #104)

- Minor, `src/switchlog.ts`/`src/v2.ts`: purge surfaces silently ignored a failed switch-log clear (`clearSwitchLog` swallowed the error); report the fixed sanitized warning `Warning: the switch log could not be cleared.` on both surfaces while event purge and the stats refresh proceed -> fixed by owner-ticked CodeRabbit autofix `34367f2` (boolean `clearSwitchLog`, `SWITCH_LOG_CLEAR_WARNING`, a both-surface v2-port test, README wording); all four touched files (`src/switchlog.ts`, `src/v2.ts` purge wiring, `tests/v2-port.test.ts`, `README.md`) are inside #104's Files owned, so no scope exception; Engineer re-ran all gates on the adopted head: typecheck clean, 593/593 tests, build and pack pass (shasum `8c7a6d34`).
- Minor, `src/switchlog.ts`: retention anchor inspected only physical line 1, so a malformed leading line could force an unnecessary rewrite despite a fresh oldest valid row -> fixed by anchoring on the oldest valid parsed row and adding a regression test; the existing clear-failure warning behavior and both-surface coverage remain valid.

### 2026-10-26 - PR #113 (issue #103), repair round 2

- Major, `src/stats.ts`: confirmed repeated numeric day bounds; use shared minimum/maximum constants in advertised schema, Zod validation and command parser, preserving the 1–30-day contract -> fixed by CodeRabbit autofix `4965a32` (owner-ticked checkbox); Engineer re-ran all gates on the adopted head: typecheck clean, 587/587 tests, build and pack pass.
- Minor, `src/ledger.ts`: confirmed a file read error discarded all readable events; skip unreadable files individually. Regression cases cover purge snapshot retention with each of three files unreadable -> fixed by CodeRabbit autofix `4965a32`; `src/ledger.ts` is outside #103's Files owned (read-only reference), so the adoption supersedes the #115 deferral and is flagged to QA/orchestrator for adjudication.
- Warning, docstring coverage: ambiguous; supplied aggregate warning is truncated and identifies no missing functions or analyzer configuration. Public stats entry points already have JSDoc; exact missing-function evidence and a provider rerun are needed to verify the reported threshold -> rejected: non-blocking metric-only feedback, consistent with the PR #111/#112 dispositions.

### 2026-10-26 - PR #113 (issue #103), repair round 1

- Informational, CodeRabbit review at `696f83e`: 2 actionable inline comments (CHILL profile); CI `test` green at that head (runs 40341211313 and 40341415386). Engineer triage: named day-bounds constants fixed, per-file read catch deferred to #115 (ledger source read-only for #103); both then implemented in-branch by the owner-ticked CodeRabbit autofix `4965a32`, superseding the local fix and the deferral.

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
