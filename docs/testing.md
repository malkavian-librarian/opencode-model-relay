# Testing and verification gates

The stack is TypeScript with vitest, `tsc --noEmit` and a tsup build. There is no
linter or formatter. CI (`.github/workflows/ci.yml`, job `test`) runs the same gates.

Development and tests need Node >= 20.19 (vitest 4 / vite 8; CI uses 22, see `.node-version`); the published plugin itself runs on Node >= 20.

## Gates

| Gate | Command | When |
|---|---|---|
| Scoped tests | `npx vitest run tests/<name>.test.ts` | While developing |
| Full tests | `npm test` | Before every commit and PR |
| Types | `npm run typecheck` | Before every commit and PR |
| Build | `npm run build` | Before every PR |
| Package contents | `npm pack --dry-run` | When `package.json` `files`, build output or entry points change |

All four of typecheck, tests, build and pack must pass in CI job `test` before merge.
Chain locally in PowerShell: `npm run typecheck; if ($?) { npm test }; if ($?) { npm run build }`.

## Unit test rules

- Tests live in `tests/<module>.test.ts`, one file per `src/<module>.ts`.
- Test behaviour through the module's public exports. No network, no real OpenCode
  session, no real filesystem outside a temp directory; stub `fetch` and the SDK client.
- Test error paths and the fail-safe rule: a hook given bad input must resolve, not throw.
- Security-relevant code (redaction, key handling, consent gate, config confinement)
  needs a test per rule, including a negative case that proves nothing is sent or leaked.
- A bug fix starts with a failing test that reproduces it.
- Ponytail rule: new non-trivial logic (a branch, loop, parser, money or security
  code, or a new script) needs one small test; trivial changes need none.

### Harness gotchas

- `ConfigSchema.parse({ tiers })` leaves `levels` empty: `loadConfig` performs the
  tiers-to-levels migration. Harnesses that bypass the loader must derive levels
  from their merged tiers so controller switch tests exercise the configured ladder.
- Seed state timestamps and cooldowns relative to `Date.now()`. Values near 1970
  (`updated: 1`, `cooldownUntil: 4_000_000`) expire during `StateStore.load()` and
  its health sweep, so the intended fixture state disappears before assertions.
- Persisted session fixtures must include a finite `switchCount`; otherwise the
  state sanitizer drops the whole record, including quarantine entries.
- Context adoption must resolve session eligibility before clearing shared health;
  test child sessions and failed lookups as well as successful top-level adoption.
- Removing a runtime config key must preserve valid sibling settings on upgrade;
  test legacy migration and invalid siblings to keep strict validation intact.
- `CORE`'s corroboration map is module-scope state shared by every test in a file:
  a test that reuses a sessionID after another test emitted a contradicting
  `session.model.selected` gets its adoption silently vetoed. Use a fresh
  sessionID per adoption test.

## Fixtures

Hand-written fixtures encode our assumptions about OpenCode and OpenRouter payloads,
so they can pass while the real API differs. Prefer fixtures captured from a real
session or response (live in `tests/fixtures/`, exercised by `tests/real-fixtures.test.ts`),
with secrets removed. Mark hand-written fixtures as such in a comment and revisit them
after each real capture (new captures tracked in #18).

## Flaky timing

Wall-clock assertions flake across machines and CI runners. For performance-style
tests, bound the input to the documented contract size (for example the 60000-char
transcript cap) and use generous limits. Prefer fake timers for cooldown and timeout
logic. Never assert tight millisecond bounds.

- Void context hooks can outlive fixed sleeps -> gate racing lookups with deferred
  promises and drain their promise continuations with `setImmediate` before asserting
  state; keep the older lookup blocked until the newer adoption is observed (2026-10-24).
