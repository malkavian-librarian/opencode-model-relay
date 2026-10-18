# Task template

Every groomed GitHub issue uses these four sections. The PM fills them in; the
Engineer treats the acceptance criteria as the spec (if the description conflicts
with a criterion, the criterion wins).

## Goal

One or two sentences on what should be true when this is done.

## Acceptance criteria

- [ ] A statement you can check by reading the result or running a command
- [ ] One line per case, including edge cases and error paths
- [ ] Plugin invariants hold where relevant: no request proxying, key only from env, consent-gated egress, redact after truncate, hooks never throw
- [ ] `npm run typecheck`, `npm test` and `npm run build` pass; CI job `test` is green
- [ ] Docs updated, or "no doc impact" stated with a reason

## Out of scope

- Something that does not belong in this task, moved to #<issue-number>

## Constraints

- **Files owned:** explicit list of files this task may create or modify, including the doc and `AGENTS.md` Gotchas edits it is expected to make. Nothing outside the list without stopping and flagging it on the issue.
- **Dependencies:** prerequisite issues; whether the issue is owner-gated (`needs-owner`)
- **Libraries and boundaries:** stdlib plus `zod` and `jsonc-parser` only unless a failing test proves otherwise; Zod validation at boundaries
- **Security:** state whether any security-sensitive file is touched (`src/redact.ts`, `src/openrouter.ts`, `src/config.ts`, `src/handover.ts`, `src/controller.ts`, workflows)
- **Verification gates:** the commands from `docs/testing.md` that apply
