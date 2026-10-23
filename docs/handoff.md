# Cross-agent handoff log

Per-issue log that lets any agent resume interrupted work with minimal research. The
GitHub issue comments hold the detailed notes; this file indexes the latest state.

## Instructions for agents

- On pickup: read the GitHub issue first (latest comments are the current state), then
  the matching entry here.
- Before pausing or running out of context: comment progress on the issue (done, in
  flight, next step, blockers) and add or update an entry here.
- Entries are newest first. Format: date, issue or topic, status, next step, blockers.
- Keep each entry short (under 10 lines). Link to the issue and PR instead of pasting.
- Remove nothing but obsolete detail; when an issue closes, mark the entry `closed`.

## Entries (newest first)

### 2026-10-23 - #59 usage-limit failover implemented locally (Engineer) - awaiting review

- Status: TDD classifier/marker-attribution fix on `fix/issue-59-usage-limit`; no commits/push/deployment.
  Typecheck, 453 tests, build and pack dry-run passed independently; synthetic coverage only, no live failover (#18).
- Next: push for CI/CodeRabbit; independent QA found no blocking code/security defect; final verdict awaits CI.
  Gotcha recorded in the existing design spec under AGENTS append guard. Dependency findings: #55/#60.
- Limits: switcher reports dispatch, not prompt admission/completed continuation; no active sessions disturbed.
  Existing oversized controller test file remains unsplit to avoid unauthorized new files/cleanup.

### 2026-10-22 - #56 OpenCode v2 port merged (opencode) - closed

- Status: PR #57 squash-merged as `9706629` after the CodeRabbit loop (2 Majors + 1 Minor fixed in
  `7edf2e0`: leftover debug in the prompt hook, veto-after-enactment retry semantics, handover-target
  attribution, doc path placeholder) and a QA/security pass. Gates: 413 tests, typecheck/build/pack
  green, CI green; live smokes passed on real OpenCode 1.18.32 and 2.1.3 binaries (`relay_status` on
  both paths). Dual export `{id, server, setup}`; v1 hooks stand down when the v2 layer is live.
- Next step: none from #56. Left needs-owner: live v2 failover E2E (real provider error; v2 silently
  re-selects a fallback model on invalid models) and v2 TUI toast / native-command ergonomics,
  tracked under #18/#19; the probed contract lives in `docs/spike-v2.md`.

### 2026-10-22 - #56 v2 port implemented, live-verified on 2.1.3; PR open (opencode) - superseded

- Status: Implemented the v2 layer (`src/v2.ts`, `src/v2-types.ts`) with dual export
  `{id, server, setup}`, all-or-nothing activation, module-scope singleton core (`createRelay`
  extracted in `src/server.ts`), v1 stand-down via `isV2Active`, `hasRelayMarker` relaxed to
  synthetic marker parts, late-error no-double-switch guard in `controller.handle`. Smoke: v1
  1.18.32 and v2.1.3 binaries both load the installed build and serve `relay_status` with the
  live chain. Gates green: typecheck, 410 tests (20 files), build, `npm pack --dry-run`.
- Next step: PR `feat/issue-56-v2-port` -> CI -> CodeRabbit review loop + QA security pass
  (controller.ts, strategy.ts touched) -> squash-merge (authorized) -> comment on #56.
- Blockers: live v2 failover E2E (real provider error) remains needs-owner (v2 silently
  re-selects a fallback model on invalid models); documented in docs/spike-v2.md.

### 2026-10-22 - #56 OpenCode v2 port groomed (3-critic panel) & backlog updated (opencode)

- Status: Filed and groomed #56 (`feat: port relay to OpenCode v2 plugin API`) after a 3-subagent critique panel (V2 API/Runtime, Security/Invariants, TDD/Concurrency/Rollout). Closed obsolete #1 (shipped in `aaf5a10`); reworked #7, #18, #19 for OpenCode v2; groomed #45 and #55 into `docs/task-template.md`; updated #5 (tag `v1.0.0` pushed; release run `39312093779` passed gates and stopped at `ENEEDAUTH` pending owner `NPM_TOKEN` secret).
- Next step: Implement #56 (`docs/spike-v2.md` + `tests/v2-port.test.ts` + v2 `ClientLike` adapter in `src/server.ts`), or pick up #45 / #55.
- Blockers: #5 (`NPM_TOKEN` secret is owner-only); live v2 verification in #56 / #19 / #18 is `needs-owner`.

### 2026-10-19 - #26 quality judge merged; housekeeping done (opencode) - closed

- Status: PR #53 (#26) squash-merged as 65421a3: opt-in quality judge (`judge.enabled`) with
  local heuristics (src/heuristics.ts), strict-JSON LLM verdicts (src/judge.ts), two-consecutive-
  verdict switching logged as `quality`, no cooldown recorded; all caps persisted.
- Security review found 1 HIGH (`judge.enabled` never read) + 1 MEDIUM (TTL-bounded dedup let one
  turn be judged twice) + 4 LOW; all fixed in the same PR (commits 112ae20, 23187b0), CI green 393
  tests, CodeRabbit review done (its Major: stale-verdict switch - also fixed).
- Housekeeping: stale worktrees and branches removed; issues #39, #6 closed as shipped (#52, #53);
  dependabot majors #42 ts 7, #43 @types/node 26, #44 tsup 9 closed with ignore-with-reason rules
  added to .github/dependabot.yml.
- Next step: none pending from the sprint; owner-gated remain #5 (release), #19 (TUI), #18
  (real error payloads), #45 (workflow_dispatch scope); v1.2 stats #7 awaits grooming.

### 2026-10-18 - #36, #37, #25, #40 merged; recover hardening queued (opencode)

- Status: four PRs squash-merged to `main` this session, each with QA/security PASS and CI green:
  #41 (#36 dependabot ignore), #46 (#37 workflow hardening, LOW advisory tracked as #45), #47 (#25 modes),
  #48 (#40 tried-model rule in chain-sticky + transcript read under the lock). Recover hardening WIP lives
  on branch `wip/recover-hardening` and is groomed as #49 (not started).
- Next: #49 (implement, reuse the WIP; rebase onto `main`), then #38/#39/#26 in that order; #26 needs #25 done, now satisfied.
- Blockers: #45 (workflow_dispatch scope) is an owner decision; #5 release and #19 TUI checks remain owner-gated.
- Note: CodeRabbit is enabled on the repo (CHILL profile) but returned no review on this session's PRs; internal QA/security subagent review remains the effective gate.

### 2026-10-18 - #2 spike and #4 e2e done (orchestrator)

- Status: live-session spike and recorded end-to-end run are done by the orchestrator.
  Results: `docs/spike.md` (#2) and `docs/e2e-v1.0.md` (#4). Real captured shapes live in
  `tests/fixtures/` and are exercised by `tests/real-fixtures.test.ts`.
- Next: #3 (plugin entry implementation).
- Blockers: #5 (npm publish) remains owner-gated (`needs-owner`).

### 2026-10-18 - v1.0 code merged; process adopted

- Status: v1.0 code is on `main` via PR #10 (squash, 236 tests, CI green, independent
  security review with no CRITICAL/HIGH). Issue #1 stays open until #2 and #4 are done.
  Issue #9 (this process) is in review on `docs/issue-9-agent-process`.
- Next: #8 (narrow billing wording in `classifyRetryMessage`) and #11 (vitest upgrade for
  dev-dependency advisories) can start now. #3 waits for #2.
- Owner-gated (`needs-owner`): #2 (live-session spike), #4 (recorded end-to-end run),
  #5 (npm release with provenance). Agents do not start these.
- Blockers: none for #8.
