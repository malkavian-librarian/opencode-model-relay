# opencode-model-relay — Levels Redesign Plan

> **Status:** v2 — adversarial panel round 1 integrated (2026-10-23); **epic #62 filed
> with children #63–#73** (see §8 for the mapping).
> After approval-by-filing, the **issues win** if this doc and an issue disagree
> (docs/process.md). Baseline for all work: a fresh fetch of origin/main — the v2 port
> (PRs #57/#58) and the #59 usage-limit fix (PR #61) are merged there; the local checkout
> is behind and predates both. **The plugin is currently DISABLED on the owner machine**
> (`~/.config/opencode/plugins/opencode-model-relay.js.disabled`) — re-enabling is a
> tracked epic task, not an afterthought.

**Date:** 2026-10-23 · **Spec to amend:** `docs/superpowers/specs/2026-10-18-model-relay-design.md` (sections 4–5)

---

## 1. Goal (owner's words, formalized)

1. **Free manual switching at any moment.** Whatever model the owner picks — TUI, `/relay`
   command, config — the plugin adopts it and never fights it. It runs until it goes down
   or runs out of tokens.
2. **Failover = walk the ladder from the top.** On failure: try level #1 (skip it if it is
   the model that just died), then #2, then #3 … first *healthy* candidate wins.
3. **Limitless ordered levels** replace `primary / secondary / tertiary`.
4. **Some levels are matchers, not models** ("find a free GLM 5.2/5.3"). They resolve at
   failover time; nothing matches → skip the level, continue down.
5. **Switch fast.** A dead session must resume on a working model in seconds, not tens of
   seconds. The LLM handover narrative must never sit in the resume critical path.
6. **Keep the switch log and be verbose in its usage** (§4.8) — it is the instrument that
   cracked the October incident and it stays first-class.

---

## 2. Evidence: what actually happened (facts, then labeled inference)

The plugin's own metadata-only artifacts, `~/.local/share/opencode-model-relay/`:

**Facts — `switches.jsonl` (12 entries, all local time UTC+2):**

| When | Switch | Kind |
|---|---|---|
| Oct 19 17:49 | `openai/gpt-6.1-sol` → `opencode/glm-5.3-flash-free` | rate_limit |
| Oct 19–22 (×5 more) | `openai/gpt-6.1-sol` → `opencode/glm-5.3-flash-free` | rate_limit |
| Oct 20–22 (×3) | `opencode/muse-spark-1.3` → `openai/gpt-6.1-sol` | quota |
| Oct 22 ~22:00 | `openrouter/meta/muse-wonder` → `openai/gpt-6.1-sol` | auth |
| Oct 22 23:35 (last 2) | `opencode/glm-5.3-flash-free` → `openai/gpt-6.1-sol` | rate_limit |

**Facts — `state.json` (last write Oct 23 10:02:49 local):**

- `health`: `openai/gpt-6.1-sol` marked **`permanent: true`** at exactly 10:02:49.
- Latest session records: `sticky: openai/gpt-6.1-sol`, `origin: opencode/glm-5.3-flash-free`,
  `switchCount` 1–3 — the relay had been pinning sessions **back onto Sol**.
- **No switch logged after the permanent mark.** The failure was recorded, the failover
  never happened. No session record from that window exists (a failed switch writes none).

**Facts — repo/CI:** PR #61 (usage-limit classifier fix, #59) merged 2026-10-23 05:50 UTC —
~2 hours *before* the 10:02 permanent mark, but the incident ran Oct 22 evening → Oct 23
morning on a build that almost certainly predates the fix (which build was installed is
not verifiable from here). PR #59's fix confirmed: usage-limit wording was only handled on
the retry-event path pre-fix, not the `session.error` path.

**Facts — runtime (probe-verified):** `-m` / TUI manual model picks are blocked by
agent-config hardening on v2 ("internal model hardening") — the "I can't switch it
manually" half of the incident is a runtime constraint the plugin must work around with
its own commands. v2 has **no toast API**; notifications are `ctx.session.synthetic`
messages.

**Inference (labeled, not proven from metadata-only logs):**

- The log shows a **two-model oscillation**: Sol rate-limits → switch to free GLM → free
  GLM rate-limits → switch back to Sol. An effective ladder of ~2–3 reachable models plus
  short cooldowns (60 s default) makes this ping-pong inevitable.
- Why no failover followed the 10:02 permanent mark — candidates, all post-`recordFailure`:
  (a) `decideSwitch` returned `exhausted` (everything else `triedThisTurn` or cooling —
  consistent with the 23:35 glm→sol switches seeding `tried`), (b) the handover/switch
  itself failed silently, (c) a failure event arrived while the lock was held and was
  dropped silently (a class the panel confirmed is still unaddressed — §6 P1-F5). The log
  cannot distinguish.

---

## 3. Why the current design behaves this way (code refs)

### 3.1 "Primary is a must" — gravity, by design

- `src/strategy.ts:20-29` `buildChain` always puts the primary first; `:47-58` `nextModel`
  walks **from the top**, so the primary is the first failover target for a failure on *any*
  model. The moment its 60 s cooldown expires — or one successful turn clears all its health
  marks (`src/controller.ts:169-187` `onSessionIdle` deletes the **entire** entry, resetting
  backoff) — the session gravitates back to it.
- `chain-recover` mode (`src/strategy.ts:98-102`) auto-returns the session **up** to the
  highest-priority healthy model — primary gravity as a feature.
- `src/pin.ts:24-32` `decidePin`: a turn arriving on `origin` or `lastPin` is treated as
  "the TUI is here", never as the owner's pick, and gets re-pinned to `sticky`. You cannot
  even manually go *back* to the origin model.
- v2 `onPromptHook` (`src/v2.ts`, origin/main) passes `rec.origin ?? rec.sticky` as the
  *assumed* arrival model — a manual switch landing on those is invisible by construction.

### 3.2 "No escape when it's dead"

- Unmatched error wording → `unknown` → `switchable: false` → stay on the dead model.
  #59 narrowed this for usage-limit phrasing; any novel provider text still strands you.
- `maxSwitchesPerSession` default **6** (src/config.ts:60) — smaller than the ladder.
- `onExhausted: "stop"` — a toast, no action (src/config.ts:61).
- No plugin command can force a model switch; only the relay's own `switchModel` calls
  work under agent-config hardening.
- Failure events arriving while the SessionLock is held return **silently** — no ledger
  entry, no toast (controller `handle`, `tryAcquire` early return).

### 3.3 Config ceiling

- `tiers: { primary?, secondary[], tertiary[] }` (src/config.ts:15-22) — exactly 3 levels;
  no way to express "any free GLM 5.2/5.3 via OpenRouter".

---

## 4. Proposed design — "the ladder"

### 4.1 Config schema

```jsonc
"levels": [
  "openai/gpt-6.1-sol",                                   // #1  (id from switches.jsonl)
  "opencode-go/glm-5.3",                                   // #2  exact id via model.list()
  "opencode/glm-5.2",                                      // #3  NOT in current enabled pool — resolve or substitute at impl
  "opencode/muse-spark-1.3",                               // #4  (id from switches.jsonl)
  { "find": { "match": "glm-5\\.[23]", "free": true } },   // #5  OpenCode providers (-free suffix)
  { "find": { "match": "glm-5\\.[23]", "free": true, "via": "openrouter" } }, // #5.5
  "openrouter/z-ai/glm-5.3",                               // #6  key shape per AGENTS.md:26
  "openrouter/<gemini-pro-latest>"                         // #7  exact id from OR catalog
]
```

- Entries: plain `"provider/model"` strings, or `{ find: { match, free?, via? } }` matcher
  objects (zod union). Deduped, first occurrence wins.
- **Levels count capped (32)** and `find.match` **length-capped (64 chars)**, compiled once
  at load; invalid regex or entry → defaults + warning **naming the level index**
  (e.g. `levels[4]: …`). No silent whole-config discard without being told exactly where.
- **`tiers` auto-migrates** (`primary → L1`, `secondary[] → L2..`, `tertiary[] → …`) with a
  deprecation warning; `tiers` + `levels` both present → `levels` wins + warning (no silent
  merge). `mode` is deprecated but still honored by the existing runtime in the config issue,
  then **removed** in the rewiring issue. This preserves current strategy behavior between the two;
  `levels` is now the runtime ladder; the implementation children below record the shipped
  walk, rewiring, command, failover, discovery and observability dispositions.
- `maxSwitchesPerSession` default auto-scales: **max(6, levels.length + 1)**; an explicit
  user value always wins. Manual switches (`/relay`) are **exempt** from the cap.

### 4.2 Runtime semantics

1. **Stay-put.** The plugin calls `switchModel` *only* on failover or an explicit `/relay`
   command. No re-pins, no auto-recovery. The entire pin apparatus dies: `src/pin.ts`,
   `decidePin`, `recoverTarget`, `chain-recover`, `escalate`, `buildTiers`/`tierOf`,
   SessionRecord fields `sticky/origin/lastPin/recoveries`, the v2 `onPromptHook`
   fabricated-arrival workaround, and the `mode` config field.
2. **Manual pick always wins — with lock discipline** (panel P1-F1). The v2 context hook
   reports the session's resolved model. If it differs from `pluginPinned` (what the plugin
   itself last set) → it is the owner's pick:
   - Adoption runs **under the same SessionLock** (never lock-free next to a failover);
     session records are **merged, never whole-record overwritten**.
   - The failover re-reads the session's resolved model **after abort, before `switchModel`**,
     and **abandons the switch** if it changed (the pick supersedes the failover — this is
     how "never overridden" survives the race instead of being violated by the plugin's own
     pending `switchModel`).
   - Adoption writes `pluginPinned := pick` in **both §5 branches** (so a re-asserting
     runtime cannot drag the next admission back to the agent default), clears the pick's
     cooldown and failure count **once**, and persists `adoptedAt` starting a **grace window
     (~30 s)** during which failure events for that model do not re-mark it (retry-storm
     ordering, panel P1-F7).
3. **Failover walk.** On a switchable failure of the current model: walk levels from the
   top, skipping (a) the failed current model, (b) unhealthy (cooldown/blacklist),
   (c) models already tried this turn (`triedThisTurn` stays), (d) **quarantined** models —
   see §4.5. First healthy wins. Find levels resolve during the walk (§4.4).
4. **Marker guard replacement** (panel P1-F5): the v2 controller guard that today anchors on
   `rec.sticky` anchors on the new current-model record (`pluginPinned`) — preserved
   behavior (no switching on top of a running handover, the #56 regression), no dropped or
   broken guard.
5. **No silent drops.** Failures arriving while the lock is held, marker-guarded events, and
   superseded switches append a metadata-only ledger entry `kind: "switch_dropped"` with an
   enum reason (`lock_held` | `marker_guard` | `superseded`) — the exact silent class from
   the incident becomes diagnosable (§4.8).
6. **`onExhausted` acts.** When the walk is exhausted: fall back to the deepest healthy
   level; if none, emit a synthetic hint to run `/relay next` (consent/verbosity rules
   apply). A stranded session always tells the owner why and what to do.
7. **Crash/restart windows** (panel P1-F6): `pluginPinned` is persisted **before**
   `switchModel`; on load it is validated against `levels` (dropped silently if absent); a
   pending-handover intent is persisted and resumed-or-discarded on load; setup ordering
   guarantees **no dormant window** (hooks/tools/commands registered before `moduleActive`).

### 4.3 Escape hatches (the real fix for "I can't switch")

Two commands (v2 `ctx.command.transform`, same registry as `/relay`):

- **`/relay model <provider/model>`** — force an immediate switch to a specific model.
  Uses the same `switchModel` call failovers use → works even under agent-config hardening
  that blocks TUI picks. Clears that model's marks like an adoption. **Fast path**: no LLM
  narrative, plain-tail handover (§4.7).
- **`/relay next`** — force one hop down the ladder now (walk rules apply). Fast path too.

Both: logged `kind: "manual"`, counted separately from auto-switches, **exempt from the
switch cap**, never throw into the host, and give **immediate synthetic feedback**
("switching to X … done"), including the **bottom-of-ladder** case (explicit message + the
status hint). If a failover holds the lock: immediate "failover in progress; retry in a
moment" feedback — never a silent no-op (panel P3-F4).

### 4.4 Find levels (free-model discovery)

- Resolved **lazily at failover time**, never at config load.
- **#5.5 (OpenRouter):** `GET /api/v1/models` (public catalog, no key, no user data),
  filtered by `match` regex + free pricing (`pricing.prompt == "0"`), response size-capped,
  https/openrouter.ai host rules identical to `orChat` (it lives in `src/openrouter.ts`,
  a security-sensitive file). **Health-aware resolution** (panel P1-F8): the
  current/unhealthy/tried/quarantine skips apply to the *candidates* at resolution time —
  the first *healthy* match wins, not the first match; a find level never "switches" the
  session onto its own corpse. Result cached in `state.json` (TTL 60 min; the cache entry
  is invalidated when its resolved model fails). No match or fetch failure → skip the level.
- **#5 (OpenCode side):** `model.list()` exposes ids but no pricing; free detection is
  id-convention based (`-free` suffix — real precedent: `opencode/glm-5.3-flash-free` in
  the switch log). Same health-aware skips. Fallback: a static `-free` entry.
- **Discovered ids are untrusted external data**: validated (charset `[A-Za-z0-9._:-]`,
  length ≤ 128) before they reach `switchModel` or handover text.
- **Egress gate placement** (rule 5): without `privacy.consent`, a find level resolves to
  **nothing** and is skipped — the gate sits at resolution entry, so no code path (walk,
  `/relay next`, status rendering, cache refresh) can fetch pre-consent. Status shows
  find levels as `unresolved (consent off)`.

### 4.5 Health & quota handling

- #59's classifier work stays as merged.
- **Reset-aware cooldowns:** parse reset wording ("usage limit resets at 5pm") and
  `retry-after` into a real cooldown until the reset time, capped by a new
  `RESET_COOLDOWN_MAX` (**6 h**; today `MAX_COOLDOWN_MS` = 1 h truncates multi-hour usage
  windows — one of the thrash drivers in the log).
- **Per-session recent-failure quarantine** (panel P1-F3, P3-F3): a model that failed in
  this session within `QUARANTINE_MS` (**10 min**) is skipped by the walk *unless no other
  candidate is healthy* (preference, not veto). This is what actually kills the observed
  oscillation — `triedThisTurn` protects only within one turn, and cooldown expiry plus
  walk-from-top re-enters the corpse. Quarantine rides the session record, not the global
  health map.
- **Success clears less** (panel P1-F3): a successful turn on a model clears its
  `cooldownUntil` **and any `permanent` mark** (a full successful turn is real evidence),
  but **keeps the `failures` count** so backoff does not reset to 60 s after one lucky turn.
- Permanent quota/auth blacklist stays (24 h TTL, src/state.ts:18).

### 4.6 Judge

- Never judges level 1 (replaces the "tier 0" rule, src/controller.ts:199-200). All deeper
  levels judged as today. No other judge changes.

### 4.7 Performance budget — "switch fast" is a requirement, not a hope (panel P3-F1/F2)

- **The plain-tail handover is the DEFAULT resume path.** The OpenRouter narrative
  (~$0.005/call, up to a 45 s timeout in `handover.ts:102` today) moves **out of the
  critical path**: the switch proceeds immediately; the narrative, when consent+key allow,
  is **asynchronous** (patched into the session after resume, or skipped — owner-config
  gate). This amends this plan's own earlier YAGNI line: handover/narrator internals ARE in
  scope for latency, nothing else.
- **Latency budget:** failure event → resumed turn re-admission ≤ **6 s hard, ≤ 2 s typical**
  (abort race ≤ 5 s + 300 ms delay + no narrative). Manual commands: same budget plus
  immediate feedback on receipt.
- Every switch emits its elapsed time as metadata in the ledger (enum-free numeric field,
  no text) so the budget is measurable from `switches.jsonl` alone.

### 4.8 Observability — keep the switch log, be verbose in its usage

`switches.jsonl` is the instrument that reconstructed the October incident (the oscillation
table and the 10:02 stranding in §2 came from it). It stays **on by default**, strictly
metadata-only (rule 8: enums, HMAC'd session ids, models, numeric costs/durations — never
prompt, response, or free provider text), and its usage gets louder, not quieter:

- **New ledger kinds:** `manual` (owner command), `switch_dropped` with enum reason
  (`lock_held` | `marker_guard` | `superseded`), plus a numeric `elapsedMs` on switches.
- **`/relay status` becomes the dashboard**: ordered ladder (find levels shown as
  `unresolved`/`consent-gated`/`resolved → id (cached, age)`), per-level health (cooldown
  remaining, blacklisted-until), `pluginPinned`, recent `adoptedAt`, last ~10 ledger
  entries including drops, manual/auto switch counts.
- **README documents how to read the log** — field-by-field, with the October incident as
  the worked example (real entries, no invented data).
- Analytics beyond this (aggregation, stats.json) remain the already-tracked follow-up
  issue #7 — explicitly out of scope here.

### 4.9 What gets deleted (net simplification)

`src/pin.ts` (whole file), `decidePin`, `chain-recover` + `escalate` modes + their strategy
functions, SessionRecord fields `sticky/origin/lastPin/recoveries`, the v2 prompt-hook
fabricated-arrival workaround, the #19 TUI-behavior ambiguity (the plugin stops caring
where the TUI sends from), and the `mode` config field. Roughly one module deleted, two of
three modes gone, one new small module (find resolution).

---

## 5. Open probe questions (all resolved by the probe issue BEFORE the rewiring)

1. Does `switchModel` persist across subsequent user turns, or does the runtime re-assert
   the agent-config model on every admission? (Determines whether the prompt hook must
   re-assert `pluginPinned` per admission; adoption writes `pluginPinned := pick` either way.)
2. Is the retry hook's `e.decision.retry = false` mutation honored by the host? (If not,
   the storm-token consumption in §4.2 becomes the only guard.)
3. Does a synthetic message reliably land in the *intended* session during multi-session
   episodes (the port's `lastSession.sid` fallback), or must notifications be re-targeted?
4. Can the context hook's model report distinguish a genuine user pick from runtime-internal
   resolution (agent reload, another plugin, provider fallback)? (Guards wrong adoptions.)

The sandbox: `.opencode-v2-probe` (existing). Answers land in `docs/spike-levels.md` and
amend the rewiring issue before it is implemented.

---

## 6. Adversarial panel — round 1 (2026-10-23)

Three distinct models as subagents, three adversarial lenses, mandate: break the design on
paper so switching ends up fast, reliable, smooth.

| Panelist | Model | Lens | Outcome |
|---|---|---|---|
| 1 | `opencode-go/glm-5.3` | Reliability & concurrency | **8 findings** (1 CRITICAL, 4 HIGH, 3 MEDIUM) — all integrated below |
| 2 | `opencode/muse-spark-1.3` | Security & privacy | **Failed to run** (insufficient account funds) — mitigated: §7 constraints + mandatory QA security pass on every PR touching `config.ts`/`controller.ts`/`openrouter.ts` (AGENTS rule 11); its attack list was folded into §4.4/§7 and the discovery issue's ACs |
| 3 | `opencode/glm-5.3-flash-free` | Performance / UX / ops | **8 findings** (2 CRITICAL, 3 HIGH, 2 MEDIUM, 1 LOW) — all integrated below |

**Disposition (finding → where it landed):**

- P1-F1 adoption race / record overwrite → §4.2.2 (lock discipline, re-read-before-switch,
  merge-not-overwrite, pluginPinned in both branches) + rewiring issue ACs.
- P1-F2 incomplete §5 fallback → §4.2.2 + §5 (both branches specified).
- P1-F3 oscillation survives across turns → §4.5 quarantine + success-clears-less.
- P1-F4 cap exhaustion still strands → §4.1 (cap scale + manual exemption) + §4.2.6
  (`onExhausted` acts).
- P1-F5 "removes every candidate cause" was not true → §4.2.4 (marker guard), §4.2.5
  (switch_dropped ledger), §2 updated inference (c).
- P1-F6 crash/restart windows → §4.2.7 (persist-before-switch, validate-on-load,
  pending-handover intent, setup ordering).
- P1-F7 retry storm × adoption × veto → §4.2.2 grace window + storm token in rewiring ACs.
- P1-F8 find resolution ignores health → §4.4 health-aware resolution + cache invalidation.
- P3-F1 narrative in critical path (≤45 s!) → §4.7 (plain-tail default, async narrative,
  budget) + dedicated fast-failover issue.
- P3-F2 manual commands inherit slow pipeline → §4.3 fast path + feedback spec.
- P3-F3 no per-session quarantine → §4.5 (same as P1-F3).
- P3-F4 lock contention swallows escape hatch → §4.3 immediate feedback, never silent.
- P3-F5 no deploy step → dedicated deploy issue (build → plugins dir → re-enable the
  currently-`.disabled` plugin → restart → verify, SHA-256 recorded).
- P3-F6 relay-init generates deprecated tiers shape → config issue AC (init template +
  warnings naming level index).
- P3-F7 status frozen blind → §4.8 + observability issue.
- P3-F8 v2 notification surface unspecified (synthetic noise, multi-hop aggregation,
  targeting) → §4.8 verbosity contract + probe question 3; aggregation optional in the
  observability issue.

Probe questions from the panel (both panelists): §5 items 1-4.

---

## 7. Decisions D1–D6 (proposed → adopted for grooming)

Owner direction 2026-10-23 ("integrate the improvement ideas… file it as an epic")
adopts the recommendations below for grooming; an override raised during epic review
amends the affected issue (process: the issue wins).

| # | Question | Adopted |
|---|---|---|
| D1 | On failure: walk from **level #1** vs downward from the failed position | **From the top**, now safe via §4.5 quarantine (P1-F3/P3-F3) |
| D2 | Manual pick of a blacklisted/cooling model: clear marks or keep | **Clear, once**, under lock + grace window (P1-F1/F7 refinements) |
| D3 | Delete `chain-recover` + `escalate` entirely | **Yes** — single semantics |
| D4 | Add `/relay model` + `/relay next` | **Yes** — fast path, feedback, cap-exempt |
| D5 | Discovery catalog GET consent-gated? | **Yes** — gate at resolution entry; without consent find levels skip (§4.4) |
| D6 | `tiers` auto-migrate vs hard break | **Auto-migrate** with deprecation warning |

Also adopted unless overridden: auto-scaling cap (§4.1), reset-aware cooldowns 6 h cap
(§4.5), quarantine 10 min (§4.5), judge skips level 1 only (§4.6), plain-tail default +
async narrative (§4.7), ledger verbosity additions (§4.8).

---

## 8. The epic — granular issues, one shared worktree

Filed 2026-10-23: **epic #62** with children **#63–#73** (native sub-issue links and
blocked-by dependencies verified on GitHub). **One shared
worktree** (`.worktrees/levels-redesign`) for the entire epic, created once from a fresh
`origin/main` fetch; each issue gets its own `feat/issue-<n>-<slug>` branch cut inside that
worktree, one PR per issue (`Closes #<n>`), merge advances the worktree base; the worktree
is removed by the wrap-up issue. The PM → Engineer → QA loop, gates and merge authority per
`docs/process.md` unchanged.

| # | Issue (one-line scope) | Depends on | Priority |
|---|---|---|---|
| A → #63 | `levels` config schema, find entries, tiers migration, relay-init template (+ commits this plan doc) | — | P0 |
| B → #64 | Ladder walk from top, stay-put, per-session quarantine, reset-aware cooldowns, cap scale | #63 | P0 |
| C → #65 | v2 probe: switchModel persistence, retry-veto honoring, synthetic targeting, pick-vs-resolution | — | P0 |
| D → #66 | Rewiring: manual-pick adoption under lock, pin-machinery deletion, crash windows, storm token, `switch_dropped`, `onExhausted` acts | #64, #65 | P0 |
| E → #67 | `/relay model` + `/relay next` fast-path escape hatches | #66 | P0 |
| F → #68 | Fast failover: plain-tail default, async narrative, latency budget | #66 | P1 |
| G → #69 | Find levels: free-model discovery, health-aware resolution, consent gate, cache | #63, #66 | P1 |
| H → #70 | Observability: verbose switch-log usage + `/relay status` ladder view | #63, #66 | P1 |
| I → #71 | Docs sweep: README, spec, SECURITY, CHANGELOG, AGENTS (cap-aware) | #68, #69, #70 | P1 |
| J → #72 | Deploy & enable on the owner machine (re-enable `.disabled` plugin, restart, verify) | #71 | P0 |
| K → #73 | Wrap-up: commit all, cleanup merged branches + worktrees, push | #72 | P2 |

Crawler/GEO/AEO: N/A — this is a developer-tool plugin with no public UI or content
surfaces.

---

## 9. Constraints unchanged (hard rules, AGENTS.md)

No request proxying (rule 3); key from env only (4); consent-gated egress (5);
redact-after-truncate (6); user-level config only, never the project tree (7);
metadata-only logs (8); hooks never throw (9); skip subagent sessions (10); security pass
on diffs touching `src/redact.ts`, `src/openrouter.ts`, `src/config.ts`, `src/handover.ts`,
`src/controller.ts` (11 — issues D, F, G do; every such PR gets the QA security pass).
v2-port constraints carry over: no reads from `ctx.options`/`ctx.location`, exclusive
loading (`plugins/` dir XOR `opencode.jsonc` `plugins` array), synthetic-marker checks,
process-wide singleton core.

---

## 10. Out of scope (YAGNI — amended)

~~No changes to handover/narrator internals~~ → **in scope for latency only** (§4.7,
issue F). Still out: preflight health probing, cost-based routing, per-provider budget
tracking, judge redesign, TUI work beyond the two commands, npm publish (owner-gated;
NPM_TOKEN pending; analytics remains issue #7).

---

## Appendix A — the ladder with evidence status per entry

| Level | Entry | ID status |
|---|---|---|
| #1 | `openai/gpt-6.1-sol` | verified (switches.jsonl; enabled in workspace pool 2026-10-23) |
| #2 | GLM-5.3 via OpenCode Go | `opencode-go/glm-5.3` — enabled (workspace pool + this session's own model) |
| #3 | GLM-5.2 via OpenCode | **NOT in the current enabled pool** (pool has glm-5.3/-flash/-flash-free only) — enable or substitute at impl; do not invent |
| #4 | `opencode/muse-spark-1.3` | verified (switches.jsonl; enabled in pool) |
| #5 | find free GLM 5.2/5.3, OpenCode side | matcher; `-free` suffix precedent: `opencode/glm-5.3-flash-free` (in pool) |
| #5.5 | find free GLM 5.2/5.3 via OpenRouter | matcher; catalog lookup at failover |
| #6 | `openrouter/z-ai/glm-5.3` | key shape per AGENTS.md:26 + handover default `z-ai/glm-5.2` |
| #7 | Gemini Pro "latest" via OpenRouter | resolve exact id from catalog at impl (pool has gemini-3.1-pro etc.; no id invented here) |

No model ids were invented; unresolved ids are marked for lookup at implementation time.

## Appendix B — worked incident example for the log docs (issue H)

Two real entries (§2 table) plus the 10:02 stranding: `gpt-6.1-sol` marked
`permanent: true` with no subsequent ledger entry — the gap that `switch_dropped`
(§4.2.5) and the observability issue make impossible to miss next time.
