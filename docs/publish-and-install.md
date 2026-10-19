# Publishing and installing for local testing

Two flows, kept separate. Publishing is OWNER-ONLY (agents must not publish, tag or
touch repository secrets - see `docs/process.md`, "Merge authority"). Local testing
is what you do on your own machine before and while the package is unpublished.

## 1. Install on this machine to test (no npm publishing needed)

The build is self-contained: `dist/index.js` bundles `zod` and `jsonc-parser`, so a
single file is enough and OpenCode loads it straight from the plugin directory.

### Build

From the repo (`C:\Users\FlyerOne\Desktop\vibeCode\model-relay`):

```powershell
npm ci
npm run build   # writes dist/index.js (self-contained) and dist/index.d.ts
```

Check free disk space before installing/building on this machine. If dependencies
are already installed and unchanged, `npm run build` is enough to refresh the bundle.

### Place the plugin (pick one)

- **Global** (every project on the machine; recommended here):
  copy `dist\index.js` to `%USERPROFILE%\.config\opencode\plugins\opencode-model-relay.js`.
  The `plugins` directory may not exist yet - create it (`New-Item -ItemType Directory
  -Force "$env:USERPROFILE\.config\opencode\plugins"`); OpenCode then auto-loads every
  `.js`/`.ts` in it at startup.
- **Project-local** (test one project, zero global impact):
  copy it to `<project>\.opencode\plugins\opencode-model-relay.js`.

Do not copy `node_modules`. Keep the file name `opencode-model-relay.js` so logs are
obvious. Re-copy after every `npm run build` when testing the plugin itself.

Load only one copy: global OR project-local OR an explicit `plugin` entry in
`opencode.json`/`opencode.jsonc`. Disable other automatic failover plugins (such as
`opencode-auto-fallback`) while testing, so two plugins cannot race to switch.
Preserve unrelated plugin entries, such as Honcho.

### Configure

The plugin reads ONE config file, user-level only:
`%USERPROFILE%\.config\opencode\opencode-model-relay.jsonc` (JSONC, max 64 KB).
`XDG_CONFIG_HOME` overrides the base directory. Run `/relay-init` inside OpenCode to
write an annotated default (consent off, never overwrites), or write by hand:

```jsonc
{
  "tiers": {
    "primary": "openai/gpt-6.1-sol",                 // replace with your normal model
    "secondary": ["opencode/deepseek-v4.1-flash-free"] // verify availability first
  },
  // "mode": "chain-sticky",                           // or chain-recover / escalate
  // "privacy": { "consent": false },                  // true  => redacted transcript may go to OpenRouter
  // "judge": { "enabled": false }                     // true  => opt-in quality judge (also needs consent)
}
```

Direct helper egress needs BOTH `"privacy.consent": true` and the key in an environment variable
(default name `OPENROUTER_API_KEY`; set with `$env:OPENROUTER_API_KEY = "..."` per
shell, or `setx` for permanence). Without both, failover still works but the handover
uses the redacted plain tail and the judge never runs. Main-model requests still
go through OpenCode and its configured providers, including paid providers in your chain.

Quit and restart OpenCode after changing the bundle, relay config or OpenCode plugin
list. A running instance keeps its previously loaded settings. Relay settings belong
in `opencode-model-relay.jsonc`, not as extra top-level keys in `opencode.jsonc`.

### Verify it loaded and works

1. Run `opencode models` in PowerShell and pick exact ids from that installation.
   Only the first `/` separates provider and model; for example,
   `openrouter/z-ai/glm-5.3` uses provider `openrouter`. Being listed is not proof
   that credentials, credits or model capacity are currently usable.
2. Start OpenCode, select a working model, and run `/relay` (one model turn).
   The report lists `chain`, `mode`, `sticky`, `switches`, `recoveries`, `consent`
   and `key`. `sticky: none` means no relay pin, not that no model is selected.
   `/relay` asks the model to call `relay_status`, so it can fail on a broken model.
3. Run the healthy-turn and basic-failover scenarios below in a fresh session.
4. Check the local ledger after a switch:
   `%USERPROFILE%\.local\share\opencode-model-relay\`
   - `switches.jsonl` - one row per switch (metadata only, HMAC'd session id)
   - `state.json` - sticky model, counters, model health
   - `salt` - the per-install HMAC salt
   Files are created as needed; an untouched install need not have all three yet.
   `XDG_DATA_HOME` changes the base to `$XDG_DATA_HOME/opencode-model-relay`.

The status tool reports key presence only, never the key or whether it is valid.
It does not report judge activity or independently verify the actual model behind
the TUI selector. Use assistant-message model metadata and the ledger as evidence.

To uninstall a local copy: delete the plugin file from the plugins directory and
restart OpenCode.

## 2. Settings how-to

Examples below use model ids available during local setup on 2026-10-19; recheck
with `opencode models`. Each JSONC block is a complete config unless described as
a fragment. Edit your existing config rather than appending a second JSON object.
The complete field reference is in [README configuration](../README.md#configuration).

### Start with a free-only failover chain

Use this for reproducing the GLM failure without automatically reaching a paid
fallback. Select GLM in OpenCode too: `tiers.primary` ranks the chain; it does not
change OpenCode's selected/default model.

```jsonc
{
  "mode": "chain-sticky",
  "tiers": {
    "primary": "opencode/glm-5.3-flash-free",
    "secondary": [
      "opencode/deepseek-v4.1-flash-free",
      "opencode/beam-free"
    ]
  },
  "privacy": { "consent": false },
  "judge": { "enabled": false },
  "maxSwitchesPerSession": 2,
  "narrator": { "verbosity": "chatty", "tone": "plain" }
}
```

Free models can share an outage or account limit. Successful fallback is possible
only if at least one eligible candidate actually works. A two-switch cap permits
GLM -> DeepSeek -> Beam, then stops further switching in that session.

### Choose the switching mode

For `primary: A`, `secondary: [B1, B2]`, `tertiary: [C]` (replace letters with real ids):

| Setting | Failure path | On later user messages |
|---|---|---|
| `"mode": "chain-sticky"` | A -> B1 -> B2 -> C when earlier candidates remain unhealthy or already tried in that turn. | Keep the fallback; no automatic return. |
| `"mode": "chain-recover"` | Same failure selection as sticky. | Return to the highest-ranked healthy model above the sticky fallback. |
| `"mode": "escalate"` | A -> B1 -> C; B2 is a sibling, so it is skipped. | Keep the fallback; no automatic return. |

Flat-chain modes scan from the start for the first healthy, untried candidate;
they do not simply advance one index. With GPT as an explicit healthy primary,
manually selecting GLM and making it fail can switch back to GPT before DeepSeek.
For a GLM -> DeepSeek test, use the free-only config above. Omitting `tiers.primary`
instead puts the currently failing model first when constructing a flat chain.

Use `chain-recover` for temporary rate limits, not for forcing a return after quota
or auth failures. Recovery is evaluated on a new user message, not a background
timer. It does not increase `switches`, but increases `recoveries`; recovery stops
one switch before the switch cap and has its own count bounded by that cap.

### Tune timing, limits and visibility

These are top-level config fields/fragments:

| Setting | How to use it during testing |
|---|---|
| `"cooldownMs": 10000` | Shorten the base transient cooldown from 60000 ms for a recovery experiment. Repeated failures double it, up to one hour; a supplied `Retry-After` takes precedence. |
| `"maxSwitchesPerSession": 2` | Bound a short experiment. Default is 6; the cap counts switches, not models, retries or money. |
| `"narrator": { "verbosity": "chatty", "tone": "plain" }` | Make relay events visible. `normal` is the everyday default; `quiet` hides normal switch/recovery messages; `off` hides all narration. |
| `"ledger": { "enabled": true }` | Keep metadata evidence in `switches.jsonl`. Setting it false disables the switch log, not persisted state. |
| `"handover": { "maxToolChars": 1500, "maxTranscriptChars": 12000 }` | Bound handover input. Maximums are 15000 per tool and 60000 for the transcript. |

Permanent failures (auth, quota, missing model, matched free-tier restriction) are
blacklisted for 24 hours, not governed by `cooldownMs`. A clean completed turn on
that model clears its health record. Health is shared across sessions and persisted
across restarts; a fresh session resets session counters, not global model health.

### Enable optional OpenRouter summaries

Merge this fragment into your config:

```jsonc
{
  "privacy": { "consent": true, "zdr": false },
  "handover": { "model": "z-ai/glm-5.2", "maxCallsPerSession": 1 }
}
```

The helper uses an OpenRouter slug (`z-ai/glm-5.2`), not the OpenCode id
`openrouter/z-ai/glm-5.2`. Judge model names likewise use OpenRouter slugs.
Set `OPENROUTER_API_KEY` in the launching process environment and start OpenCode
from that process. A key stored in OpenCode's provider authentication is not
automatically the helper's environment key. Use Windows environment settings for
persistence, then open a new terminal and restart OpenCode; do not put keys in JSONC.
Check presence without printing the value:

```powershell
[bool]$env:OPENROUTER_API_KEY
opencode
```

`privacy.zdr: true` requests zero-data-retention endpoints and may reduce available
routes. Helper failure or its per-session call cap falls back to the redacted plain
tail; it should not prevent ordinary failover. Set `handover.maxCallsPerSession: 0`
to disable summary calls while testing the judge separately.

### Enable the quality judge separately

After ordinary failover works, merge this fragment (also needs consent and the key):

```jsonc
{
  "privacy": { "consent": true },
  "judge": {
    "enabled": true,
    "model": "google/gemini-2.5-flash-lite",
    "maxCallsPerSession": 3,
    "minIntervalMs": 60000,
    "maxDailyUsd": 0.5
  }
}
```

The judge checks only finished, token-producing turns on configured secondary or
tertiary models. It skips primary, unlisted models and relay handover turns. Local
signals are three identical tool calls, three consecutive tool errors, or an
assistant turn with neither text nor a successful tool. A weak answer alone is
not a trigger. Two consecutive `switch: true` judgments are needed to switch;
healthy turns or a negative judgment reset the streak, and a restart resets it.
Judge errors/invalid replies do not switch. Newer messages invalidate a stale
switch decision. Failed judge attempts still consume the per-session call cap.

`maxDailyUsd` gates new judge calls using recorded returned costs across sessions
for the UTC day. It is not a prepaid hard spending limit: an in-flight call can
overshoot it, missing provider costs are not known, and summary/main-model calls
are outside it. Use provider-side budgets too when testing paid helpers.

## 3. Testing scenarios and ideas

### Repeatable test workflow

1. Save your normal config before an experiment. Use a disposable project with
   harmless files and a new top-level session for each independent scenario.
2. Change one variable, restart OpenCode, and confirm `/relay` using a working model.
3. Note the OpenCode version, model ids, mode, consent, caps and starting counters.
4. Run a small task: ask it to read a sample file and report a unique marker plus
   the next step. After fallback, check that the marker and task intent survive.
5. Compare assistant-message model metadata, the handover, counters and new log
   rows. A toast alone is not proof that the fallback successfully answered.
6. Record pass/fail with expected versus actual results. Restore the normal config
   and restart when done. Do not treat an untriggered failure as a passing test.

### Manual test matrix

| Scenario | Procedure | Expected evidence |
|---|---|---|
| Healthy baseline | With helpers off, send two ordinary prompts on a working model. | No relay handover, switch count unchanged, normal answers. |
| Basic GLM fallback | Use the free-only config, select GLM, and send a short prompt while its failure is reproducible. | Recognized failure causes a handover to the first healthy untried fallback; counter/log row increases and fallback answers. If GLM works, only the healthy path was tested. |
| Sticky continuation | After successful fallback, send another real user prompt. | The answering model remains the sticky fallback without another switch. |
| Explicit model choice | After fallback, select a different model that is neither the sticky model nor the original model. | The old pin clears; counters are retained. Selecting the original model can be interpreted as stale TUI state, so is not a reliable pin-reset test. |
| Recovery after transient error | Use `chain-recover`, allow a real rate-limit/timeout cooldown to expire, then send a new prompt. | A healthy higher-ranked model takes over; `recoveries` increases, `switches` does not; log kind is `recover`. Not applicable to a permanent auth failure. |
| Tier escalation | Configure A / [B1, B2] / [C] and `escalate`; reproduce failures on A then B1. | C is next, not B2. Prefer stubbed events for repeatability. |
| Exhaustion / cap | Set cap to 1, trigger a fallback, then a recognized failure on that fallback. Separately try an unhealthy/exhausted chain. | Cap/exhaustion warning; no extra switch or infinite handover loop. The plugin leaves the current model selected. |
| User cancellation | Start a long harmless response and press Esc. | No relay switch or new switch-log row. Test the real keypress, not just an API abort. |
| Restart persistence | After fallback, quit and restart, reopen the same session and inspect status. | Sticky state and session counts survive; health still affects candidate selection. |
| No helper consent | Keep consent false even if an environment key exists; trigger fallback. | Redacted plain-tail handover; no direct summary/judge requests. Main-model continuation still uses its provider. |
| Summary success/failure | With consent/key and one summary call allowed, trigger fallback; repeat in a fresh session with an invalid helper slug. | Success includes a generated summary (optional cost metadata); helper failure still produces a plain-tail handover and continuation. |
| Judge healthy path | Enable judge; finish an ordinary secondary-model turn with useful text and no suspicious tool activity. | No judge call or quality switch; inspect persisted judge counters, not just `/relay`. |
| Judge suspicious path | In a disposable task, ask for three identical harmless reads or reproduce repeated tool errors on a secondary model. Repeat on a later eligible turn after the interval. | Heuristics may allow judging; two affirmative verdicts can cause a `quality` switch. Prompting cannot guarantee a verdict. Use controller tests for deterministic coverage. |
| Invalid config | Back up config, temporarily add an unknown key or invalid mode, then restart. | Warning and whole-config fallback to defaults, not a partial merge; OpenCode stays usable. Restore promptly. |
| Subagent isolation | Run a task that creates a child session; reproduce a failure there if feasible. | Relay does not switch the child session; its `parentID` excludes it. |

### Reproducing failures without guesswork

- **Live provider experiment:** use a model already returning a recognized error.
  Do not hammer providers to manufacture 429s. Retry-status transient failures are
  eligible from attempt 2; permanent retry failures are eligible immediately.
  A terminal `session.error` follows its own classification path.
- **Controlled auth failure:** the existing [headless E2E report](e2e-v1.0.md)
  used a configured primary with a deliberately invalid credential and a working
  secondary. Recreate only in an isolated test provider/config; do not replace
  your everyday provider credentials. This proves permanent-failure handling,
  not transient cooldown recovery.
- **Missing model:** a bogus provider/model can be rejected before any usable
  session event. Also, changing `tiers.primary` alone does not select that model.
  Treat missing-model injection as exploratory, not a guaranteed failover recipe;
  keep a known-working destination when testing continuation.
- **Deterministic checks:** use the existing suites for timing, repeated events,
  stale judge verdicts, caps, redaction and hostile payloads. No live spend needed:

  ```powershell
  npx vitest run tests/classifier.test.ts tests/strategy.test.ts tests/controller.test.ts tests/pin.test.ts
  ```

  Full developer gates and fixture rules: [testing.md](testing.md). A green unit
  suite does not prove TUI behavior. Existing headless evidence predates some
  features; real TUI checks and captured error shapes remain tracked in #19/#18.

### Best practices and troubleshooting

- Keep chains short and intentional. In flat modes, tertiary is just later in
  the list; in `escalate`, it is a strictly higher tier. Do not add paid models
  unless you intend automatic paid continuation. Switch caps are not cost caps.
- Use one OpenCode instance for stateful experiments. Stop all instances before
  backing up/resetting relay data; running instances can overwrite your changes.
  There is no reset command. For a completely clean experiment, move the relay
  data directory aside while stopped, then restore it after testing. This resets
  counters, health and the HMAC salt; log hashes will differ, so do not mix runs.
- For isolation, `XDG_CONFIG_HOME` and `XDG_DATA_HOME` must be set before launch.
  Config goes in `<config-base>/opencode/`; relay state goes in
  `<data-base>/opencode-model-relay/`. An isolated config base needs its own plugin
  installation and usable provider setup. A project-local plugin still reads
  user-level relay config and shares relay data unless you change these bases.
- If `/relay` is missing, check plugin placement, duplicate copies, startup errors
  and whether you restarted. A copy directly in `.opencode/index.js` is not the
  documented auto-discovered `.opencode/plugins/` location.
- If the chain is empty/default, check the actual config base, file name, JSONC
  syntax, unknown fields and warning toast. A config error discards all its values.
- If no switch happens, check caps, shared cooldowns/blacklists, a child session,
  or an unrecognized error. Context overflow, Esc/user abort and unknown failures
  intentionally do not switch. Real free-tier error wording may not match yet.
- If the TUI still names the old model, inspect the assistant model metadata and
  sticky/log evidence. Selector synchronization and visible toasts need manual
  verification; `/relay` itself can create an additional model turn.
- If `key: missing`, launch from the environment where you set the variable and
  check `openrouter.keyEnv`. `key: set` does not guarantee helper authentication.
- Use fake secret-shaped markers in disposable fixtures to inspect redaction,
  not real secrets. Share sanitized error shapes, version, model ids and metadata
  when reporting failures; omit keys, auth headers and private transcript content.

## 4. Publish to npm (owner-only runbook)

### One-time setup

1. npm account with rights to the package name `opencode-model-relay`; log in on the
   machine once with `npm login` if you want to verify 2FA by hand (publishing itself
   happens in CI).
2. GitHub repository: Settings -> Secrets and variables -> Actions -> New repository
   secret `NPM_TOKEN`. Use a scoped, automation-only npm access token. This is an
   owner action; agents never touch secrets.
3. Dry-run the pipeline without publishing: GitHub -> Actions -> `release` -> Run
   workflow (this is always a dry run; it ends at `npm publish --dry-run` and uses no
   `NPM_TOKEN`). Confirm it goes green.

### Release procedure

1. Bring `main` up to date and make sure the last PR is merged (squash).
2. Bump `package.json` `version` (`0.0.0` -> e.g. `1.0.0`) and retitle the
   `CHANGELOG.md` `## Unreleased` section to `## 1.0.0 - <date>`, adding a new empty
   `## Unreleased` above it. Update the README status line.
3. Commit `chore(release): v1.0.0`, push to `main`.
4. Tag and push the tag (this, and only this, triggers the real publish):

   ```powershell
   $git -C C:\Users\FlyerOne\Desktop\vibeCode\model-relay tag v1.0.0
   $git -C C:\Users\FlyerOne\Desktop\vibeCode\model-relay push origin v1.0.0
   ```

5. Watch the Actions run; on green check the result:

   ```powershell
   npm view opencode-model-relay dist.tarball dist.integrity
   ```

### After publishing: switch your machine to the real package

1. Delete the plugin file(s) copied into the plugins directories (both project and
   global copies) so nothing loads twice.
2. Add the package to `%USERPROFILE%\.config\opencode\opencode.json`:

   ```jsonc
   { "$schema": "https://opencode.ai/config.json", "plugin": ["opencode-model-relay"] }
   ```

   OpenCode installs it automatically (with Bun) at startup into
   `~/.cache/opencode/node_modules/`. The config file and data directory from step 1
   above are unchanged, so nothing moves.
3. Restart OpenCode, run `/relay`, and verify the chain and counters are intact.
   Future updates ship by pushing a new `v*` tag; OpenCode picks the new version on
   its next start.

### Rollback

The release workflow is tag-only and re-runnable: delete the bad tag locally and on
the remote, fix, re-tag. Deprecating or unpublishing a broken version is manual:
`npm deprecate opencode-model-relay@<version> "use <newer>"`.
