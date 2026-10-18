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
| `docs/coderabbit.md` | Optional CodeRabbit setup (not installed yet). |
| `docs/coderabbit-log.md` | Log of CodeRabbit exchanges (empty until installed). |
| `docs/superpowers/specs/2026-10-18-model-relay-design.md` | Design spec and hard constraints. |
| `docs/superpowers/plans/2026-10-18-v1.0-failover-handover.md` | v1.0 implementation plan. |
