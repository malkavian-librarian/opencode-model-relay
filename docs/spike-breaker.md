# Circuit breaker, provider cooldown and return-to-primary — Phase C design spike

Decision document for #110 (epic #102, Phase C). Docs-only: no runtime change is
made or approved here. Every claim below is checked against the merged source at
`2f10d9f` (Phase B shipped: #108 PR #127 `582d22b`, #109 PR #128 `02ca1e8`,
#107 PR #133 `33ec967`); file:line references are from that tree. Where the
shipped data cannot justify a decision this document says **insufficient
evidence** rather than guessing. Implementation follow-ups are NOT approved by
this document (§8); they require owner approval first (epic #102).

## 1. Evidence baseline (what Phase B actually ships)

| Surface | Shipped shape (verified) | Window / denominator | Known blind spots |
|---|---|---|---|
| Health events | `event: "health"` rows, `what` ∈ {`cooldown_start`, `cooldown_end`, `permanent_mark`, `permanent_expire`, `quarantine_skip`, `exhausted`, `cap_hit`}, plus `model`, `tier`; `untilMs` on `cooldown_start`/`permanent_mark` only (src/ledger.ts:21,56-57,66-70) | event rows, exact `ts`, rolling window 1-30 days, default 30 | emission is best effort and can never change a switching decision (spec §9); expiry rows dedup per session/model/marker, capped 500 (src/controller-health.ts:6,13-22); unmatched end transitions create no downtime (README) |
| `downMs` | merged `cooldown_start→cooldown_end` / `permanent_mark→permanent_expire` intervals, renewals fold into one interval, clipped to the window, split at UTC day (src/stats.ts:169-222; health history read at days+1, src/stats.ts:296) | per-model summed ms over the window; duration, no denominator | only cooldown/permanent intervals count: quarantine skips, `unknown`/`overflow` failures (no health mark) and `exhausted` instants produce no downtime; restarts truncate cooldowns (§6, #136) |
| `offPrimary` | fraction of a model's retained turns with a known tier that ran below ladder tier 1 (`tier > 1`) (src/stats.ts:224-235; window rollup src/stats.ts:313-336) | per model over the window; denominator = turns with a defined `tier` | turns without a tier (model not on the ladder) leave the denominator; no per-session join, so a "stuck on fallback" session is inferred, not measured |
| Unknown share | `unknown` failures / all the model's recorded failures in the window; `–` at zero failures (src/stats.ts:338-345) | per model over the window | denominator = recorded rows only (marker/dedup/adoption-grace-suppressed errors invisible; `user_abort` never recorded); no cause separation (provider vs client) |
| Failure kinds | `failure` rows: `errorKind` enum + bounded `httpStatus` (100-599, src/types.ts:18-19) + `attempt` (≥ 0, retry-observed only) (src/ledger.ts:12-15,46-48,58-59) | per model per UTC day | counts accepted non-quality marks, not raw errors (README); #134 fixed: non-switchable recording holds the session lock, so a late v1 error mid-failover is skipped, never attributed to the freshly-switched model |
| Survival | next same-model turn in the same session within 30 min or 5 turns, no effective (non-`switch_dropped`) switch away in between; else censored (src/stats.ts:10-11,250-271) | per turn; denominator = ok+fail, censored excluded | manual switches away count as fail; heavy censoring in short sessions shrinks the denominator |
| `switchAway` | effective auto switches (kind ∉ {`manual`,`switch_dropped`}) attributed to `sw.from` (src/stats.ts:149-151) | per model per day | sees only enacted switches; drops are visible only as switch-log/health rows |
| Regret | manual switch reversing the latest auto switch back to its source within 5 min, or `sw.regret: true`; attributed to the model the manual pick abandoned (`sw.from`) (src/stats.ts:155-167; src/ledger.ts:33-34) | per model per day | catches only prompt reversals; silent dissatisfaction, later picks or new sessions are invisible |

Also shipped and used below: `turn` rows with `tier`, tokens, latency, cost —
the denominator for every rate (src/ledger.ts:37-44). Judge/heuristic rows
(`judgeCalls`/`judgeRejects`, verdict rows only, src/stats.ts:145-148) are a
quality-path signal and out of this spike's decision scope. `stats.json` is a
best-effort 30-day snapshot rebuilt on startup and purge only — decisions read
`/relay stats`, never the file. Ledger reads are bounded (20 000 lines) with
monthly rotation and HMAC'd session ids (src/ledger.ts:24,104-164).

**Minimum evidence per recommendation** is stated per option in §4. Today no
post-ship real-session snapshot exists (the owner stats check on epic #102 is
open), so every *default-on* claim is **insufficient evidence**: nothing in
this document turns anything on by default.

## 2. Breaker vocabulary (no new ledger surface)

Classic breaker states map onto the shipped vocabulary with zero new fields:

| Breaker concept | Shipped equivalent (verified) |
|---|---|
| closed (healthy) | `isHealthy === true`: no `permanent`, no live `cooldownUntil` (src/strategy.ts:16-23) |
| open, transient | `cooldownUntil > now`; entered via `cooldown_start` (carries `untilMs`), left via `cooldown_end` (src/strategy.ts:65-88; src/ledger.ts:69) |
| open, hard | `permanent === true` with `permanentAt`, 24 h TTL; `permanent_mark`/`permanent_expire` (src/strategy.ts:61,70-73) |
| half-open | the moment `cooldown_end` fires the model is eligible again and **the next real turn is the probe**: success runs `clearSuccess` (emits `cooldown_end`, keeps `failures`), failure runs `recordFailure` and re-opens with escalated backoff (src/controller-health.ts:39-45; src/strategy.ts:65-88,288-295) |
| walk outcomes | `exhausted` (no healthy candidate) and `cap_hit` (switch cap) are session-level instants, not model states; `quarantine_skip` is a preference signal, not a state (src/ledger.ts:21) |

No recommended or deferred option below needs a new event kind, `what` value or
ledger field. The single concrete need identified: if telemetry must distinguish
a *return-to-primary* switch from other automatic switches, that would require
a new `sw.kind` value (e.g. `return`) — not needed now, because `from`/`to`
plus the tier on turn rows already identify a return (destination at ladder
tier 1 after a fallback stint); deferred to measurement evidence (§8).
Provider-wide cooldown likewise needs no new field: model refs carry the
provider as their first path segment (`openai/…`, `opencode/…`,
`openrouter/…`, README "Reading the switch log"), so provider aggregation is a
read-time concern over model-keyed rows.

## 3. Mechanics this design must compose with (verified constants)

| Mechanic | Verified constant / behavior (live source, `2f10d9f`) |
|---|---|
| Reset-aware cooldowns | `parseResetCooldown` — retry-after seconds, future ISO, local "resets at HH:mm"/"resets at 5pm", capped `RESET_COOLDOWN_MAX_MS` = 6 h (src/strategy.ts:60,250-286) |
| Exponential backoff | `cooldownMs` (config default 60000) × 2^min(failures−1, 30), capped `MAX_COOLDOWN_MS` = 1 h (src/strategy.ts:59,62,84-87; README config table) |
| `failures` counter | incremented per accepted failure; `clearSuccess` keeps it (src/strategy.ts:75,288-295) — **but** pruning drops a bare-`failures` entry at the next save once no cooldown/permanent is live, so escalation memory survives only under a live mark (src/state.ts:227-231,244; idle path saves right after clearSuccess: src/controller-health.ts:74-75, src/controller.ts:207); tracked as #136 |
| Permanent marks | `PERMANENT_HEALTH_TTL_MS` = 24 h (src/strategy.ts:61; state TTL src/state.ts:36) |
| Quarantine | `QUARANTINE_MS` = 10 min, preference-not-veto (chosen only when it is the sole healthy candidate), rides the per-session record, ≤ 64 models, sessions kept 14 days (src/strategy.ts:186,188-218; src/state.ts:7,31-32,52) |
| Ladder walks | `walkFromTop` / `walkFromTopAsync` (find levels resolved lazily) / `walkCircular` (`maxCircularFlows` 0-3) (src/strategy.ts:150-248) |
| Switch cap | `AUTO_MAX_SWITCHES` = 6; effective = max(6, levels+1), raised by circular flows; manual commands exempt (src/strategy.ts:297-311; README) |
| Health persistence | health (cooldowns, permanents, failures) IS persisted in `state.json` and survives restarts (src/state.ts:33-36,154,172-174,246) — the groomed brief's "health is in-memory today" is stale against live source; real caveats in §6 |

## 4. Options — ranked, one verdict each

Order = confidence. Defaults are off unless justified.

### 4.1 Opt-in return-to-primary — **RECOMMEND** (build opt-in, default off)

- **What.** When the session's current model sits below ladder tier 1 and the
  tier-1 model is closed (§2), return once at the next idle point — the same
  guarded path that runs `clearSuccess` and the judge today — then keep the
  normal stay-put rule. README today: "the plugin never auto-recovers to a
  higher level"; this option deliberately changes exactly that one behavior,
  opt-in.
- **Config.** `returnToPrimary` (boolean, default `false`). One key, no
  thresholds; validated by the existing config schema when implemented.
- **Enactment guards (live in-memory state only, never telemetry):** current
  tier > 1; tier-1 model `isHealthy` (no live cooldown, no permanent,
  src/strategy.ts:16-23); tier-1 model not in this session's quarantine window
  (`QUARANTINE_MS` = 10 min — the return-to-corpse killer); switch budget left
  (§3). A return is an ordinary enacted switch: consumes budget, takes the
  lock, respects marker/dedup guards, skips subagent sessions
  (src/controller-health.ts:56).
- **Success metrics (measured, never inputs):** tier-1 window `turns` recover
  and fallback-model `offPrimary` falls; `regret` stays ≈ 0; survival share on
  tier-1 after returns ≥ its pre-feature baseline; no `cap_hit` increase.
- **Failure mode:** return-to-corpse oscillation (§6) — bounded by quarantine,
  escalated backoff on re-failure and the switch cap; worst case is a bounded
  number of wasted switches, not an unbounded loop.
- **Rollback:** set `returnToPrimary: false`; no schema or ledger change to
  undo (returns are ordinary switch rows).
- **Interaction with §3:** reuses `isHealthy`, quarantine, walk health
  semantics and the cap; deliberately leaves reset-aware cooldowns, backoff,
  permanents and circular mode untouched (a circular flow's origin logic is
  unaffected; returns are top-down).
- **Rejected alternatives:** stats-driven return (reads telemetry before
  switching — violates the §7 boundary); always-on return (unmeasured benefit +
  oscillation risk: default off is the justified default); TUI-confirmed
  return (deferred: depends on owner-gated #19).
- **Minimum evidence before default-on:** a real `/relay stats` window showing
  fallback models carrying turns (`offPrimary` > 0) while the tier-1 model's
  `downMs` ≈ 0 — sessions stuck below tier 1 with a healthy primary.
  **Insufficient evidence today** (owner check on epic #102 open), so the
  verdict is *build opt-in*, not *turn on*.

### 4.2 Failure-rate thresholds — **DEFER**

- **Sketch.** `breaker.windowMs` + `breaker.failureThreshold` (default off /
  0): open a breaker when a model's accepted failures reach the threshold
  inside the window.
- **Why defer.** The shipped in-memory `failures` counter already gives
  count-based escalation (each failure opens/extends a cooldown with escalating
  backoff, §3); a windowed *rate* adds value only for bursts the per-model
  counter misses — and the ladder walk + switch cap already bound a burst's
  damage (each failure walks on; cap 6). Daily stats buckets are too coarse
  for minute-scale bursts and no aggregation ships over raw `ts`.
- **Missing evidence:** a real ledger window showing clustered failures at
  minute scale that model-keyed cooldowns handled poorly. **Insufficient
  evidence today.**
- **Success metric if built:** fewer `exhausted`/`cap_hit` health rows during
  burst windows. **Failure mode:** threshold flapping on noise. **Rollback:**
  keys default off.
- **Rejected alternative:** per-turn failure rate (denominator is muddy —
  several failures per turn are possible and rows are accepted marks, not raw
  errors).
- **Interaction with §3:** would need durable per-model failure timing that
  `ModelHealth` does not keep (§3 note, #136) — a restart- and prune-safe
  store; that cost is part of the defer. Walks, quarantine and cap untouched.

### 4.3 Provider-wide cooldown after 5xx — **DEFER**

- **Sketch.** `providerCooldown.server5xxThreshold` +
  `providerCooldown.durationMs` (default off; duration capped at
  `MAX_COOLDOWN_MS` = 1 h for symmetry with the restart clamp, §6), keyed on
  the first path segment of the model ref.
- **Why defer.** The trigger signal exists (`failure` rows with
  `errorKind: "server_5xx"` and bounded `httpStatus` ≥ 500), but nothing
  aggregates per provider (stats are model-keyed) and no provider-wide outage
  is recorded in any shipped window. The damage case is real: October evidence
  shows mixed-provider ladders (openai, opencode, openrouter), but a find-level
  ladder resolves entirely under one provider prefix (`openrouter/…`) — a
  provider cooldown there equals whole-ladder exhaustion.
- **Missing evidence:** a real window with ≥ 2 distinct sibling models under
  one provider prefix failing `server_5xx` within minutes. **Insufficient
  evidence today.**
- **Success metric if built:** fewer doomed sibling `server_5xx` failure rows
  during an outage. **Failure mode:** punishing healthy siblings (§6).
  **Rollback:** keys default off.
- **Interaction with §3 (if built):** compose, don't replace — fan out by
  writing ordinary per-model cooldowns (`cooldown_start` rows) to ladder
  siblings; keep model-keyed state (no new ledger field, §2) and
  preference-not-veto semantics rather than a hard provider veto, mirroring
  quarantine's design lesson; walks and cap untouched.

### 4.4 Half-open probes — **REJECT**

- **Sketch (for the record).** `probe.enabled` + `probe.intervalMs`: a
  synthetic request testing a cooled-down model before re-admission.
- **Why reject.** (a) A probe is main-model-shaped traffic: through OpenCode it
  is a real billable turn and pollutes `turn` rows — the denominators of
  survival, `offPrimary` and every rate; direct to the provider it breaks the
  helper boundary (rule 3: helpers are judge, handover and the public catalog
  only). (b) The shipped mechanics already implement half-open for free:
  `cooldown_end` re-admits, the next real turn is the probe, success →
  `clearSuccess`, failure → escalated re-open (§2). A probe buys no decision
  the ladder does not already make, at real cost.
- **Rejected alternatives:** probe-through-OpenCode (billable, denominator
  pollution); direct provider probe (rules 3-5); catalog-availability probe
  (the public catalog says nothing about a model's serving state).
- **Minimum evidence that would reopen:** none identified — the rejection is
  structural, not evidential. No success metric is worth the boundary cost.

### 4.5 Switching on repeated `unknown` — **REJECT**

- **Sketch (for the record).** `unknownSwitch.threshold` +
  `unknownSwitch.windowMs`: switch after N `unknown` failures in a window.
- **Why reject.** `unknown` is by definition unclassified — possibly
  client-side, user-adjacent or transient. #107 (PR #133 `33ec967`)
  deliberately made `unknown`/`overflow` recorded-but-non-switchable: no health
  mark, no switch (recording serialized under the session lock since #134). Switching on repeats inverts that evidence order:
  it reacts to noise with the most expensive action the plugin has. The
  unknown share exists precisely to *watch* whether unknowns cluster per model.
- **Rejected alternative:** count-based unknown breaker — same noise failure
  mode, plus a new dedup namespace to avoid the #107 measurement/switch key
  collision (AGENTS.md gotcha).
- **Minimum evidence that would reopen:** a real window where one model's
  unknown share is high, its unknown rows cluster in time, and sibling models
  survive — then re-file as a new issue under epic #102. **Insufficient
  evidence today**; the default answer stays non-switchable.

## 5. Return-to-primary criteria in shipped numbers

Enactment uses live state (§4.1); these are the **measured** criteria that
justify and then grade the feature, each with its data source:

| Criterion | Shipped number | Data source |
|---|---|---|
| Sessions stuck below tier 1 | `offPrimary` > 0 on fallback models with turns in the window | turn rows with `tier` (src/stats.ts:224-235) |
| Primary actually recovered | tier-1 model's `downMs` ≈ 0 after its last `cooldown_end`/`permanent_expire` | health intervals (src/stats.ts:169-222) |
| Primary stays up after a return | survival share on tier-1 post-return ≥ baseline | turn + switch scan (src/stats.ts:250-271) |
| Returns are not regretted | `regret` count stays ≈ 0 | manual-reversal detection (src/stats.ts:155-167) |
| Return storms don't form | per-session switch counts respect the cap; no `cap_hit` increase | `cap_hit` health rows (src/ledger.ts:21; src/controller-health.ts:33-37) |

**Can't yet decide (current metrics cannot answer):** whether a return
outperforms staying (no survival-after-return data exists until the feature
runs); whether primary downtime and fallback usage coincide per session (no
shipped aggregation joins `downMs` with per-session turn sequences — the ledger
rows contain the join key, the HMAC'd session id, but no view computes it);
how often owners manually return today (regret counts only prompt 5-minute
reversals); whether a return should ask first in the TUI (#19, owner-gated).
Each is **insufficient evidence**; §8 lists the measurement-only follow-up.

## 6. Risks and failure modes

- **Return-to-corpse oscillation** (the failure mode quarantine exists to
  kill, src/strategy.ts:188-196): every option that re-admits a model must
  pass the shipped guards — live cooldown, quarantine window, escalated
  backoff, switch cap. Return-to-primary does (§4.1); a failure-rate breaker
  would need the same guards plus hysteresis (part of its defer).
- **Breaker state across restarts:** health **is persisted** (`state.json`,
  src/state.ts:246) — the spike brief's "health is in-memory today" is stale
  vs live source. Real caveats a breaker must accept or design around
  (tracked as #136): (1) a restart truncates any persisted cooldown to ≤ 1 h
  from load (`MAX_COOLDOWN_MS` clamp, src/state.ts:113-117), so a 6 h
  reset-aware cooldown becomes 1 h across a restart; (2) pruning drops entries
  with no live cooldown/permanent, so the `failures` backoff counter does not
  outlive its mark window (src/state.ts:227-231); (3) saves are best-effort — a
  crash between a failure mark and `save()` loses the newest mark (only
  `pendingHandover` has crash-window handling, and it is discarded on load,
  src/state.ts:8,81-82). No recommended or deferred option needs longer or
  exact memory — return-to-primary reads current marks only.
- **Provider-wide cooldown punishing healthy siblings:** the structural
  failure mode of §4.3 — one sick model can black out healthy ladder
  siblings, and a single-provider (find-level) ladder turns a provider
  cooldown into total exhaustion. Mitigation if ever built: threshold ≥ 2
  distinct failing siblings, ordinary per-model cooldowns (no hard veto),
  1 h cap, default off. Today: defer.
- **Unknown-share noise:** unknown rows carry no cause; reacting with switches
  amplifies noise and burns switch budget (cap 6). The shipped observer-first
  design is correct; watch `--kinds` unknown share on real sessions before
  revisiting (§4.5).
- **Cross-cutting:** `stats.json` is a best-effort snapshot — decisions read
  `/relay stats`, never the file; the event bus is user-wide on OpenCode 2
  (README known limits), so multi-process sessions interleave in the ledger —
  per-session metrics already group by the HMAC'd session id, but any breaker
  reading raw rows must tolerate interleaving.

## 7. Metadata-only boundary (AGENTS.md rules 3-11)

- **Rule 3 (no request proxying):** no option adds main-model traffic outside
  OpenCode; the rejected probe is rejected partly on this rule (helpers remain
  judge, handover, catalog).
- **Rule 4 (key from env only):** no proposed config key carries or names a
  key; all are booleans/integers.
- **Rule 5 (consent-gated egress):** return-to-primary adds zero network
  calls; deferred options add none until separately approved.
- **Rule 6 (redact after truncate):** untouched — no helper-input change in
  any option.
- **Rule 7 (config user-level only):** proposed keys load from the user config
  dir, schema-validated and size-capped, when implemented.
- **Rule 8 (metadata-only logs):** no proposed ledger field carries
  prompt/response text or provider free text; the recommended option needs
  **no** new field (§2); the only identified future need (a `return` switch
  kind) is deferred and would still be an enum, not text.
- **Rule 9 (hooks never throw):** return-to-primary runs inside the same
  best-effort, fail-closed path as `clearSuccess` (src/controller-health.ts:39-45)
  — an internal failure leaves the session on its current model.
- **Rule 10 (skip subagent sessions):** the same `parentID` skip as
  `runSessionIdle` (src/controller-health.ts:56).
- **Rule 11 (security-sensitive files):** an implementation PR would touch the
  controller seams and config — the rule-11 security pass applies then
  (relevant: #135 controller split).
- **Telemetry is not an input:** health-event emission and stats are
  best-effort measurement and can never change a switching decision (spec §9;
  src/strategy.ts:20). Every enactment guard in §4.1 reads live
  ModelHealth/quarantine/ladder state only; stats are the success metric (§5),
  never the trigger. This is the boundary the stats-driven return was
  rejected on (§4.1).

## 8. Follow-ups (candidate scopes only — none opened)

All require owner approval first (epic #102: follow-ups are created from #110
only after owner approval). None is opened, assigned or promised here.

1. Implement opt-in `returnToPrimary` (§4.1; controller seams + config +
   README; rule-11 security pass; also resolve or explicitly accept #136 first
   so its restart caveats are design inputs, not surprises).
2. Distinguish return switches in telemetry (new `sw.kind` value) — only if
   §5's measurements prove ambiguous.
3. Failure-rate breaker (§4.2) — blocked on real-session burst evidence
   (owner stats check, epic #102) and a prune-safe failure-timing store.
4. Provider cooldown (§4.3) — blocked on real outage evidence; includes a
   read-time provider aggregation design.
5. Measurement-only: a per-session `downMs` × `offPrimary` correlation view
   over existing ledger rows (no runtime change; answers §5's "can't yet
   decide" items).

## 9. Deliverable

Docs-only: this PR touches `docs/spike-breaker.md` (new) and one line in
`docs/process.md` (Map of docs/), plus one line in the epic #102 body. No
source, test, config or schema change; CI job `test` is the merge gate for
docs-only PRs per AGENTS.md rule 6.
