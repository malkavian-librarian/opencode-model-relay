# CodeRabbit (optional)

**Status: not installed.** CodeRabbit is an optional AI PR reviewer, free for
open-source repositories. Installing the GitHub app is an owner action (see
`docs/process.md`); agents must not install it.

Until it is installed, the QA / Reviewer subagent review (`docs/team/qa-engineer.md`)
is the review gate, together with CI job `test`.

## Configuration

`.coderabbit.yaml` is already committed and takes effect once the app is installed:
chill review profile, plus path instructions for `src/**` (the plugin's hard
constraints), `tests/**`, and `.github/workflows/**` (SHA-pinned actions, least
privilege).

## When installed

1. The owner installs the CodeRabbit GitHub app on the repository and edits the
   Status line above to `installed (YYYY-MM-DD)`.
2. On each PR the Reviewer waits for CodeRabbit's check, then inspects it:
   `gh pr checks <pr>`, `gh pr view <pr> --json reviews,comments`,
   `gh api repos/malkavian-librarian/opencode-model-relay/pulls/<pr>/comments`.
3. Medium, Major and Critical findings are fixed in code, gates re-run
   (`npm run typecheck`, `npm test`, `npm run build`; CI job `test` green), pushed, and
   the thread is answered with `@coderabbitai`.
4. Minor and Nit findings that are not fixed are filed as issues (`Discovered in #<n>`).
5. Every exchange is appended newest-first to `docs/coderabbit-log.md`; consult it
   before touching an area with past findings.
6. Merge rules are unchanged: see Merge authority in `docs/process.md`. CodeRabbit
   checks must be green in addition to CI.
