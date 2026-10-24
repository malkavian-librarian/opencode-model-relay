# Process

How work on `opencode-model-relay` is tracked, groomed, implemented, reviewed and
merged, for any contributor or autonomous agent joining cold.

## Where tasks live

Tasks are GitHub issues in
[`malkavian-librarian/opencode-model-relay`](https://github.com/malkavian-librarian/opencode-model-relay/issues).
The issue is the source of truth for execution status. If the design spec, the
implementation plan and an issue disagree, the issue wins.

Each groomed issue follows `docs/task-template.md`: Goal, Acceptance criteria,
Out of scope, Constraints (including `Files owned`).

## Roles

- **PM** grooms an issue before anyone implements it (`docs/team/pm.md`).
- **Engineer** implements one groomed issue on a branch and opens a PR
  (`docs/team/software-engineer.md`).
- **QA / Reviewer** audits the PR against the acceptance criteria, runs the gates
  and a security pass on sensitive files, and issues a verdict
  (`docs/team/qa-engineer.md`).
- **Orchestrator** is the main session. It dispatches the other roles and merges.
  It does not groom, implement or review itself.

## Lifecycle

1. Pick the next open issue. Issues labelled `needs-owner` are owner-gated; skip them.
2. PM grooms the issue (never skip this step).
3. Engineer works on a branch named `feat|fix|docs/issue-<n>-<slug>`, commits with
   `(#<n>)` in each message, pushes, opens a PR whose body contains `Closes #<n>`,
   and comments a short "what I did" summary on the issue.
4. QA / Reviewer verifies the PR (see Reviewer loop) and posts a verdict:
   `## QA: PASS` or `## QA: FAIL` with findings.
5. On PASS the orchestrator merges (see Merge authority), then confirms the issue closed.
6. Repeat.

## Conventions

- **Branches:** `feat/issue-<n>-<slug>`, `fix/issue-<n>-<slug>`, `docs/issue-<n>-<slug>`.
  Work in a git worktree per issue when running issues in parallel.
- **Commits:** conventional style, issue number last: `feat(handover): cap tool output (#12)`.
- **PRs:** one issue per PR, `Closes #<n>`, template in `.github/pull_request_template.md`.
- **Discovered-in rule:** never leave a deferred bug, leftover, or Minor/Nit finding
  only in chat or a PR comment. File a tracked issue immediately
  (`gh issue create --label bug` or `enhancement`) and write `Discovered in #<n>` in it.
- **Gotchas:** every fixed non-trivial problem is recorded in `AGENTS.md` under
  `## Gotchas` straight away.
- **Docs:** a behaviour or contract change updates the one relevant doc in the same PR.
- **Project board:** every lifecycle step moves the issue's card on the "Relay" GitHub
  project (project 7, `gh project item-edit`): Ready -> In progress -> In review -> Done.
  The board must always reflect live state (owner directive 2026-10-23 - paramount).
- **Ponytail:** keep OpenCode's `ponytail` plugin (lazy senior-dev mode) active for all
  PM grooming, implementation and review work: smallest complete diff, nothing
  built that no criterion or failing test demands, one small test for new non-trivial logic.
  Reviewers run its `ponytail-review` skill as a first pass.

## Handoff rule

Before pausing or running out of context: comment on the issue (done, in flight,
next step, blockers) and add or update an entry in `docs/handoff.md`, newest first.
The issue comment is the detailed record; the log is the index. On pickup, read the
issue (latest comments first), then the matching handoff entry.

## Reviewer loop

- Findings are rated Critical, Important or Minor.
- Critical and Important findings must be fixed in code. A fix round is: Engineer
  fixes, pushes, local gates re-run, Reviewer re-reviews.
- Re-review is scoped to the previous findings plus the lines the fix touched.
- Minor findings are fixed if trivial, otherwise filed as issues (Discovered-in rule).
- Cap: 5 fix rounds. If findings still remain, the orchestrator adjudicates each one
  (fix, defer to a tracked issue, or reject with reason) and records a line
  `Ruling: <finding> -> <decision> because <reason>` on the PR and the issue.
- A failed acceptance criterion returns the work to step 3 with specific findings.

## Merge authority

On 2026-10-18 the repository owner delegated merge authority to the orchestrator (the
main agent session). The orchestrator, never the Engineer or QA/Reviewer subagents, may
run `gh pr merge <n> --squash --delete-branch` only when: CI is green,
the QA/Reviewer verdict is PASS, no Critical/Important finding is unresolved, the PR
links its issue, and (if CodeRabbit is installed) its checks are green. Always squash.

OWNER-ONLY, never done by an agent: npm publish / pushing release tags, creating or
changing repository secrets, changing repository settings or branch protection,
force-pushes, deleting anything other than the merged PR branch, installing GitHub apps.

## Release (owner-only)

Publishing is an owner action; agents never publish or push tags.

- **Dry run (safe, any time):** GitHub -> Actions -> `release` -> Run workflow. A manual
  run executes every step (install, typecheck, test, build, `npm pack --dry-run`) and
  ends with `npm publish --provenance --access public --dry-run`. It can never publish,
  whatever the branch or inputs, and it does not use `NPM_TOKEN`. Use it to check
  setup-node, `registry-url` and the provenance setup before a real release. If the
  provenance dry run turns out to be rejected on the runner, drop `--provenance` from the
  dry-run step only.
- **Real release:** the owner sets the `NPM_TOKEN` repository secret, bumps the version in
  `package.json` and `CHANGELOG.md`, merges, then pushes a `v*` tag. Only the tag push runs
  the real `npm publish`. The full step-by-step runbook, plus the do-it-yourself install
  path for testing on the owner's machine without publishing, is
  [docs/publish-and-install.md](publish-and-install.md).

## Map of docs/

| File | Purpose |
|---|---|
| `AGENTS.md` | Canonical agent file: commands, rules, gates summary, gotchas. |
| `docs/process.md` | This file: lifecycle, conventions, reviewer loop, merge authority. |
| `docs/task-template.md` | The 4-section issue template used when grooming. |
| `docs/team/pm.md` | PM role prompt and definition of done. |
| `docs/team/software-engineer.md` | Engineer role prompt, workflow and definition of done. |
| `docs/team/qa-engineer.md` | QA / Reviewer role prompt, security pass and verdict format. |
| `docs/handoff.md` | Newest-first cross-agent handoff log. |
| `docs/testing.md` | Gates, test rules, fixtures and flaky-timing rule. |
| `docs/publish-and-install.md` | Owner runbook for npm publishing and local machine install for testing. |
| `docs/coderabbit.md` | Installed CodeRabbit reviewer (first review PR #53); update loop. |
| `docs/coderabbit-log.md` | Log of CodeRabbit exchanges. |
| `docs/superpowers/specs/2026-10-18-model-relay-design.md` | Design spec and hard constraints. |
| `docs/superpowers/plans/2026-10-18-v1.0-failover-handover.md` | v1.0 implementation plan. |
| `docs/superpowers/plans/2026-10-23-model-relay-levels-redesign.md` | Epic #62 levels redesign plan and child issue map. |

## Epic #62 child status (2026-10-24 live)

| Child | Scope | Status | Next |
|-------|-------|--------|------|
| #63 | config schema + tiers migration + relay-init template | ✅ Merged (PR #74) | — |
| #64 | strategy: walkFromTop, quarantine, reset-aware cooldowns | ✅ Merged | — |
| #65 | v2 probe: switchModel persistence, retry-veto, synthetic targeting, pick-vs-resolution | ✅ Merged (PR #75) | — |
| #66 | rewiring: adoption under lock, pin-machinery deletion, crash windows, `switch_dropped` | ✅ Merged | — |
| #67 | /relay model + /relay next fast-path commands | ✅ Merged | — |
| #68 | fast failover: plain-tail default, async narrative, latency budget | ✅ Merged | — |
| #69 | find levels: free-model discovery, health-aware resolution, consent gate | ✅ Merged | — |
| #70 | observability: verbose switch-log + /relay status ladder view | ✅ Merged | — |
| #71 | docs sweep: README/spec/SECURITY/CHANGELOG/AGENTS | ⏳ In progress | #72 |
| #72 | deploy & enable plugin on owner machine (re-enable `.disabled`) | ⏳ Pending (`needs-owner`) | #73 |
| #73 | wrap-up: commit all, delete merged branches, worktree audit, push | ⏳ Pending | — |

## Graduated development gotchas

Older guidance moved from `AGENTS.md` to keep its cap; these rules still apply.

- PowerShell `Set-Content -Encoding utf8` writes a BOM -> write files with the editor Write tool or `[System.IO.File]::WriteAllText(path, text, (New-Object System.Text.UTF8Encoding($false)))` (2026-10-18)
- `String.replace` with a string replacement interprets `$&` and `$1` in the replacement -> pass a replacer function `() => value` (2026-10-18)
- `session.prompt` resolves only when the whole model turn ends in v1 -> fire it without `await` and attach `.catch` (2026-10-18)
- `redact()` is roughly linear but must only see bounded input -> truncate first (`maxToolChars`, `maxTranscriptChars` 60000 cap), then redact (2026-10-18)
- zod 3 nested `.default({})` applies inner defaults but zod 4 changes this -> keep zod `^3` (2026-10-18)
- PowerShell 5.1 mangles multiline strings passed to `gh issue create --body $var` -> pipe `$body | gh issue create --body-file -` with `$OutputEncoding` set to UTF8 without BOM (2026-10-18)
- Dependency majors that need code or Node-floor changes (zod 4, vitest 5) -> ignore the major in .github/dependabot.yml with a reason, do not merge them (2026-10-18)
- Judge test failures that look like "the judge is blocked" are usually off-by-one idle expectations: messages are pushed BEFORE the idle, and a turn with assistant text is healthy (heuristics skip it) -> assert in push -> idle -> expect order, and diff against a passing replica test when tallying gates by hand (2026-10-19)
- SessionLock dedup TTL (30 s) is only a cheap pre-filter, never an authorization boundary -> any once-only rule that guards a side effect (judge per-turn) must also be persisted on the state record (2026-10-19)
- OpenCode v2 loads both `~/.config/opencode/plugins/*.js` and `opencode.jsonc` `"plugins"` separately, and `ctx.options`/`ctx.location` can come from an untrusted project tree -> never load from both sources at once, never read relay config/paths from `ctx.options` or `ctx.location`, and map v2 `{providerID, id}` <-> `{providerID, modelID}` (#56) (2026-10-22)
- OpenCode 2's plugin loader silences `console`/`fs` writes during build time (module eval, `server()`, `setup()` body) -> spike/probe logs only persist from hook callbacks or tool `execute` at runtime (docs/spike-v2.md) (2026-10-22)
