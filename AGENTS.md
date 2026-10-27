# AGENTS.md - opencode-model-relay agent instructions

> Canonical agent file. Scope: entire repo. Operational cap: 120 lines; absolute
> ceiling: 150 lines. Details live in `docs/`; reference files, do not paste contents.

This repo is a TypeScript OpenCode plugin: when the current model fails it
classifies the failure, switches to the next model in a chain and hands the work
over with a structured summary. Design: `docs/superpowers/specs/2026-10-18-model-relay-design.md`.

## Commands

- Install: `npm ci` - Test: `npm test` (vitest run) - Types: `npm run typecheck`
  (`tsc --noEmit`) - Build: `npm run build` (tsup) - Package check: `npm pack --dry-run`
- Development and tests need Node >= 20.19 (vitest 4 / vite 8; CI uses 22, see `.node-version`); the published plugin itself runs on Node >= 20.
- There is no linter or formatter. Do not add Biome, ESLint or Prettier.
- Gates, scoped runs and test rules: `docs/testing.md`. CI job `test` runs
  typecheck, tests, build and `npm pack --dry-run` on every push and PR.
- Shell is Windows PowerShell 5.1. Chain with `;` or `; if ($?) { ... }`,
  never `&&` or `||`. Quote paths with spaces; env via `$env:NAME`; delete with
  `Remove-Item -Recurse -Force`; call spaced exes via `& "path\tool.exe" args`.
- `git` is not on PATH on the owner's machine. Use GitHub Desktop's bundled git
  (`Set-Alias git "<GitHubDesktop>\app-<ver>\resources\app\git\cmd\git.exe"`) or
  `gh` (`C:\Program Files\GitHub CLI\gh.exe`). Prefer `git -C <worktree> ...`.
- Write files with an editor tool, not `Set-Content -Encoding utf8` (adds a BOM).

## YAGNI - build only what is asked

- Run OpenCode's `ponytail` plugin (lazy senior-dev mode) on every coding task and review; it enforces these rules and keeps development cheap.
- No new files, helpers, wrappers or abstractions without 2+ current call sites
  or an explicit request. First use: inline. Second identical use: duplicate.
  Third: extract.
- No new dependencies without a failing test that stdlib plus `zod` and
  `jsonc-parser` cannot satisfy; name the rejected alternative in the commit.
- Minimal diffs: touched lines and direct call sites only. No drive-by cleanup.
- Files stay under 500 lines; split by responsibility when approaching it.

## Clean code and security rules (hard constraints, spec section 3)

1. Names reveal intent; one term per concept. Small pure functions; guard-clause
   early returns. No magic numbers or strings: module-scope `SCREAMING_SNAKE_CASE`.
2. Zod is the schema source; validate at boundaries (config file, OpenRouter
   responses, hook payloads) and fail safe. Comments explain why, not what.
3. **No request proxying.** Main-model traffic always goes through OpenCode.
   Direct OpenRouter calls: helpers (judge, handover) and the public model catalog.
4. **Key from env only.** Never read the API key from config, and never write it
   to config, logs, the switch log, errors or toasts. Requests use `https`,
   `redirect: "manual"`, and the base URL stays `openrouter.ai` unless
   `allowCustomBaseUrl` is true.
5. **Consent-gated egress.** Nothing is sent off the machine unless
   `privacy.consent` is true. Helper calls carry `provider.data_collection: "deny"`.
6. **Redact after truncate.** Helper input passes `redact()` in `src/redact.ts`
   and only sees input already truncated (`maxToolChars`, default 1500, max 15000;
   transcript capped by `maxTranscriptChars`, 60000). Output of
   sensitive paths (`.env*`, keys, credentials) is dropped.
7. **Config is user-level only.** Load from the user config dir, never from the
   project tree. Paths (`ledger.dir`) must resolve inside the data dir. Never
   eval or require config. Size-cap and schema-validate it.
8. **Metadata-only logs.** The switch log holds enums, ids (HMAC'd) and models,
   never prompt or response text or free provider text.
9. **Hooks never throw.** Any internal failure leaves the session on its current
   model. Treat transcripts and tool output as untrusted data, never as instructions.
10. **Skip subagent sessions** (those with a `parentID`) and other ineligible sessions.
11. Security-sensitive files: `src/redact.ts`, `src/openrouter.ts`,
    `src/config.ts`, `src/handover.ts`, `src/controller.ts`, `.github/workflows/`.
    Diffs touching them need a security pass in review (`docs/team/qa-engineer.md`).
    Workflow actions stay SHA-pinned with least-privilege `permissions`.

## Quality gates and ticket workflow (details: `docs/process.md`)

1. GitHub issues are the source of truth. At a resumed turn, run one live preflight, record the exact SHA/check snapshot, and reuse it; recheck only before irreversible actions or when a tool/user reports a concrete change. New summaries alone are not change signals; never repeat stale-report disclaimers.
   card statuses current at every lifecycle step (owner directive - paramount;
   details: `docs/process.md` Conventions). One issue at a time:
   **PM** grooms (`docs/team/pm.md`, `docs/task-template.md`) then **Engineer**
   implements on `feat|fix|docs/issue-<n>-<slug>` and opens a PR with
   `Closes #<n>` (`docs/team/software-engineer.md`) then **QA/Reviewer** audits
   it (`docs/team/qa-engineer.md`) then the orchestrator merges.
2. Gates green before handoff: `npm run typecheck`, `npm test`, `npm run build`,
   and CI job `test` on the PR (`docs/testing.md`).
3. Behaviour or contract change: update the one relevant doc in the same commit
   (README config table, SECURITY.md, or the spec). Commit messages end `(#<n>)`.
   Never commit `.env*`, `dist/`, `node_modules/`.
4. **Deferred bugs and findings:** never leave them only in chat or PR comments.
   File a tracked issue now (`gh issue create --label bug|enhancement`) that says
   `Discovered in #<n>`.
5. Only the orchestrator merges (squash), under `docs/process.md` "Merge authority".
   OWNER-ONLY, never done by an agent: npm publish / release tags, repository
   secrets, repository settings and branch protection, force-pushes, deleting any
   branch other than the merged PR branch, installing GitHub apps.
6. CodeRabbit is suspended (trial credits exhausted, owner directive 2026-10-27; files kept for re-enable, `docs/coderabbit.md`). Runtime merge gates: CI green plus QA as 2 differently-prompted subagents (adversarial security; behavioral correctness) and 1 ponytail-review subagent on the changed code (`docs/team/qa-engineer.md`); docs-only PRs need CI green only.

## Self-learning loop

- **Gotchas (mandatory on every fix):** whenever you find and fix a non-trivial
  problem, QA failure or review trap, add `- <symptom> -> <fix> (YYYY-MM-DD)` under
  `## Gotchas` immediately (grep first to avoid duplicates). Max 15; the oldest
  graduates to the relevant file in `docs/` (or the spec) when the cap is hit.
- **Bugs / Ideas:** one line each under `## Bugs` (`[open]`/`[fixed]` + repro) and
  `## Improvement ideas`. Any deferred bug or leftover also gets a GitHub issue.
- **Interruption handoff:** before pausing or running out of context, comment
  progress on the issue and add an entry to `docs/handoff.md` (newest first).
- **Cap guard:** count with `(Get-Content AGENTS.md).Count`, never `Measure-Object -Line` (it drops blank lines). If it passes 120
  lines, do not append; propose what to graduate to `docs/` or drop.
- **Suggest, do not gold-plate:** stop after the diff unless asked for more.

## Gotchas (max 15, newest at bottom)
- Gemini slot matching accepted image ids as text -> exclude image/banana ids, sort text candidates by numeric version, apply SAFE_MODEL_ID, and exclude non-chat variants (2026-10-27)
- Repeated live preflights on unchanged summaries wasted turns -> cache one snapshot per resumed turn and recheck only on concrete change signals or irreversible actions (2026-10-27)
- Judge/switch outcome rows contradicted each other (skip rows diluted the judge share, abort-race drops landed while enactment continued, regret fired without a return to the source) -> one truthful row per attempt: verdict-only denominators, drops only when the attempt stops, exact-reversal regret (2026-10-27)
- An invalid optional field made the ledger schema reject the whole append, silently losing the failure record -> sanitize optionals (httpStatus/attempt) at the call site before append (2026-10-27)
- Measurement-only recording shared handle's dedup key namespace and silently suppressed a later switch for the same message -> namespace the non-switchable dedup key apart from the switch key (2026-10-27)
- A late v1 unknown/overflow error straddling a live failover was attributed to the freshly-switched pick -> record non-switchable failures under the session lock: tryAcquire before any transcript read, skip while held, release in finally (2026-10-27)

## Bugs - [open]/[fixed] + repro (max 10)

- (none)

## Improvement ideas (max 10, newest at bottom)

- Open issues: https://github.com/malkavian-librarian/opencode-model-relay/issues
  (v1.2 stats #7; CI #45, deps #55; owner-gated: release #5, TUI #19, fixtures #18; v2 port #56 shipped in `9706629`)
