# Zod compatibility spike (#94)

**Decision date:** 2026-10-27  
**Scope:** documentation only. This spike does not change dependencies, runtime
code, tests, configuration, or workflows.

## Current repository evidence

- `package.json` declares direct dev dependency `zod: ^3.23.8`.
- `package-lock.json` resolves the direct `node_modules/zod` entry to **3.25.76**.
- `@opencode-ai/plugin` declares the nested `zod: 4.1.8` requirement. This is
  not an OpenTUI declaration, is not the relay's direct Zod version, and does
  not constitute a relay migration.
- Clean install environment: Windows, Node **v24.13.0**, npm **11.6.2**.
  `npm ci` completed on 2026-10-27, adding 114 packages and auditing 115. npm
  emitted an `EBADENGINE` warning for `ini@7.0.0` (it requests Node
  `^22.22.2 || ^24.15.0 || >=26.0.0`); this was not changed here.
- After that clean install, `npm ls zod --all` showed direct Zod **3.25.76** and
  `@opencode-ai/plugin@1.19.0`'s nested Zod **4.1.8**.
- `npm audit --omit=dev` reported **0 vulnerabilities** (0 high, 0 critical,
  0 total) on 2026-10-27. The unfiltered `npm audit` reported **2 high**:
  GHSA-mrhx-c7xc-m3w5 (`zod`, range `<4.6.6`) affecting both installed Zod
  nodes, and its high-severity effect on `@opencode-ai/plugin`. npm offered
  Zod **4.6.7** as a major-version fix and did not change package files.
  Therefore “0 with `--omit=dev`” and “2 without omission” are both exact
  current results; neither claims the advisory is fixed for Zod 3.
- `dist/index.js` bundles the direct Zod **3.25.76** copy. `npm audit
  --omit=dev` excludes that shipped copy because it is bundled from the dev
  dependency tree, so the clean production-scope result does not establish
  that the bundled code is outside the advisory.

## Validation boundary inventory

### Configuration: Zod 3 (`src/config.ts`)

`ConfigSchema` is the trust boundary after bounded JSONC parsing. It uses strict
nested objects, selected bounds on arrays and strings, finite/non-negative numeric values,
model-reference and URL constraints, and a `superRefine` HTTPS/OpenRouter-host
policy. `loadConfig` calls `safeParse`; invalid or oversized user-level config
falls back to defaults and a warning. The schema also supplies nested defaults
and supports the existing `tiers` to `levels` migration.

Relevant tests are in `tests/config.test.ts`, including strict keys, defaults,
size limits, URL policy, invalid input fallback, and path confinement.

The 64 KiB limit is a cap on the JSONC file read by `loadConfig`, not a bound
on every parsed field. The selected field bounds include at most 32 `levels`
entries and at most 64 characters for a matcher source; `tiers.secondary`
and `tiers.tertiary` use unbounded `z.array` schemas, and other arrays/strings
are not thereby bounded. Consequently, the file cap does not prove that the
advisory trigger is blocked: the advisory specifies no size threshold.

**Compatibility concern:** this schema deliberately relies on nested
`.default({})` behavior. The repository's process gotcha records that Zod 3
applies inner defaults in this pattern while Zod 4 changes the behavior. A v4
change must therefore compare `defaultConfig()` and partial-config results,
not only compile the schema.

### Persisted metadata: ledger and switch log

`src/ledger.ts` uses `ledgerEventSchema` for both append and read paths. It
validates event kinds, HMAC-shaped session IDs, bounded model references,
finite numeric fields, token/cost values, and event-specific relationships.
Input is bounded by the read window and `MAX_LINES` before/while scanning.

`src/switchlog.ts` uses one `switchRowSchema` for append, recent reads, and
compaction. It bounds the tail to 64 KiB, limits recent rows to 10, caps model
references at 120 characters, and drops malformed/untrusted rows. These are
metadata-only logs; raw provider text is not accepted by these schemas.

Existing coverage is in `tests/ledger.test.ts`, `tests/switchlog.test.ts`, and
the ledger/statistics integration tests. The current implementation and tests
were not executed by substituting Zod 4 into the runtime modules in this
documentation spike.

### OpenRouter responses

`src/openrouter.ts` does **not** currently use Zod. Its manual parsing is the
current contract: it bounds response bodies
(1,000,000 bytes (decimal 1 MB) for chat and 2 MiB for the public catalog), parses JSON, then manually
projects only the expected catalog IDs/pricing and chat completion text/cost.
It rejects invalid JSON, oversized bodies, empty completions, bad status and
unsafe URLs with generic errors. Tests are in `tests/openrouter.test.ts`.

This is an important migration distinction: a Zod 4 plan must not claim an
OpenRouter Zod boundary exists. Any future Zod schema requires a separate
contract decision and tests that preserve the currently accepted response
shape and secret-safe errors, including bounded input, unknown fields,
missing/invalid choices, and numeric cost.

Other existing Zod boundaries include the judge verdict, handover tool parts,
stats persistence/query input, and the OpenCode v2 resolved-model event. They
are additional compatibility surfaces, but are not a reason to expand this
issue into a runtime change.

## Temporary Zod 4 compatibility probe

On 2026-10-27, a non-committed Node probe used the lockfile-installed nested
Zod **4.1.8** beside direct Zod **3.25.76**. The probe reproduced the current
config default/strict-object constructs and representative ledger and
switchlog schemas from `src/config.ts`, `src/ledger.ts`, and `src/switchlog.ts`.
The temporary file was removed and no repository file was changed.

Results:

| Boundary | Zod 3.25.76 | Zod 4.1.8 | Assessment |
|---|---|---|---|
| Config `{}` | Nested defaults materialize (`tiers.secondary`, `tiers.tertiary`, and privacy defaults) | Nested objects remain empty; inner defaults do not materialize when the parent is absent | **Behavioral incompatibility confirmed**; `defaultConfig()` output must be preserved explicitly before migration |
| Config `{ privacy: {} }` | Privacy defaults materialize | Privacy defaults materialize | Same for this partial-input case |
| Strict unknown config key | Rejected as `unrecognized_keys` | Rejected as `unrecognized_keys` | Same observed behavior |
| Switchlog valid row / invalid `switch_dropped` row | Accepted / rejected by refinement | Accepted / rejected by refinement | Same observed result |
| Ledger valid failure / missing `errorKind` | Accepted / rejected by refinement | Accepted / rejected by refinement | Same observed result |
| OpenRouter responses | No Zod schema exists | No Zod schema to execute | Manual bounded parsing needs a separate contract decision |

This is a compatibility probe of the existing schema expressions, not a full
runtime substitution: the production TypeScript modules import direct Zod 3,
and changing that import or dependency graph is outside this docs-only issue.
It establishes a real v4 behavioral difference and identifies the first
required migration fix, but does not claim that every source schema and test
passes under Zod 4.

### Amended AC-02 result

The amended AC-02 is satisfied by this documented non-committed compatibility
probe: it inventories the config, switchlog/ledger, and OpenRouter response
boundaries; compares equivalent schema expressions with representative
valid/invalid fixtures under the installed Zod 3.25.76 and candidate Zod 4.1.8
APIs; records the observed behavioral difference; and identifies that
OpenRouter response handling is not Zod-backed.

The probe is intentionally not a full runtime substitution. Production
TypeScript modules still import direct Zod 3, and full source substitution plus
migration tests remain deferred to the separate implementation issue.

## Zod 4 assessment and decision

The advisory makes a major-version migration a compatibility project rather
than an emergency patch. The repository should **retain direct Zod 3 for now**.
No Zod 4 migration, compatibility install, or v4 test run is claimed here.

Before a migration is approved, the follow-up must specifically assess:

1. nested object defaults in `ConfigSchema` and the resulting `RelayConfig`;
2. `z.record(...)` calls in handover/stats and any changed key/value semantics;
3. `ZodIssue` typing and formatted warning paths in `config.ts`;
4. strict-object unknown-key behavior and all `.refine`/`.superRefine`
   invariants;
5. inferred TypeScript types and error behavior at every existing boundary;
6. package-tree duplication: the direct relay dependency must be intentionally
   selected, rather than relying on the unrelated nested Zod 4 entry.

The OpenRouter response code should remain manual unless a separate design
decision establishes a Zod schema. A migration must not silently broaden the
accepted response shape or expose response/body/key data in errors.

## Risks and rollback

**Risks:** changed default materialization can alter effective configuration;
record/object semantics can reject valid persisted stats or tool metadata;
error/type changes can alter warning text or fail-safe paths; a transitive Zod 4
entry can hide an incomplete direct dependency migration; and response parsing
changes can weaken size or secret-safety guarantees.

**Rollback:** keep this issue docs-only and leave the direct `^3` dependency and
lockfile unchanged. If a follow-up migration is attempted, isolate it in its
own PR, revert that PR (including its lockfile), and verify the prior Zod 3
lockfile plus the full gates before release. Do not mix a rollback with a
runtime behavior change.

## Exact follow-up gates

Create a separate implementation issue/PR only after a v4 compatibility plan
names the affected schemas and expected outputs. In that PR:

1. install and lock the selected supported Zod 4 version deliberately;
2. add/update focused RED tests for config defaults, ledger/switchlog malformed
   and oversized input, all existing Zod boundaries, and any newly introduced
   OpenRouter schema;
3. run `npm run typecheck`;
4. run `npm test`;
5. run `npm run build`;
6. run `npm pack --dry-run`;
7. run `npm audit --omit=dev` and record the result;
8. inspect package contents and dependency tree for accidental duplicate or
   unintended Zod versions;
9. perform an independent QA/security review, including secret-safe errors,
   user-level config confinement, metadata-only logs, and fail-safe hooks;
10. require green CI and CodeRabbit before the orchestrator considers merge.

Until those gates pass and the compatibility behavior is reviewed, the
documented decision remains: **retain Zod 3.25.76**.
