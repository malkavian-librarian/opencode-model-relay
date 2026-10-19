# Publishing and installing for local testing

Two flows, kept separate. Publishing is OWNER-ONLY (agents must not publish, tag or
touch repository secrets - see `docs/process.md`, "Merge authority"). Local testing
is what you do on your own machine before and while the package is unpublished.

## 1. Install on this machine to test (no npm needed)

The build is self-contained: `dist/index.js` bundles `zod` and `jsonc-parser`, so a
single file is enough and OpenCode loads it straight from the plugin directory.

### Build

From the repo (`C:\Users\FlyerOne\Desktop\vibeCode\model-relay`):

```powershell
npm ci
npm run build   # writes dist/index.js (self-contained) and dist/index.d.ts
```

### Place the plugin (pick one)

- **Project-local** (recommended for testing one project; zero global impact):
  copy `dist\index.js` to `<project>\.opencode\plugins\opencode-model-relay.js`.
- **Global** (every project on the machine):
  copy it to `%USERPROFILE%\.config\opencode\plugins\opencode-model-relay.js`.
  OpenCode loads every `.js`/`.ts` in that directory at startup.

Do not copy `node_modules`. Keep the file name `opencode-model-relay.js` so logs are
obvious. Re-copy after every `npm run build` when testing the plugin itself.

### Configure

The plugin reads ONE config file, user-level only:
`%USERPROFILE%\.config\opencode\opencode-model-relay.jsonc` (JSONC, max 64 KB).
`XDG_CONFIG_HOME` overrides the base directory. Run `/relay-init` inside OpenCode to
write an annotated default (consent off, never overwrites), or write by hand:

```jsonc
{
  "tiers": {
    "primary": "anthropic/claude-sonnet-4-5",        // the model you normally use
    "secondary": ["openrouter/z-ai/glm-5.2"]          // provider/model, exactly as configured in OpenCode
  },
  // "mode": "chain-sticky",                           // or chain-recover / escalate
  // "privacy": { "consent": false },                  // true  => redacted transcript may go to OpenRouter
  // "judge": { "enabled": false }                     // true  => opt-in quality judge (also needs consent)
}
```

Egress needs BOTH `"privacy.consent": true` and the key in an environment variable
(default name `OPENROUTER_API_KEY`; set with `$env:OPENROUTER_API_KEY = "..."` per
shell, or `setx` for permanence). Without both, failover still works but the handover
uses the plain tail and the judge never runs.

### Verify it loaded and works

1. Start OpenCode and run `/relay` (costs one small model turn): the report should
   list your chain, the current model, switch/recovery counters and `key: set|missing`.
2. Force a failure cheaply: point `tiers.secondary` at a model name that does not
   exist, then make the primary fail (or set `primary` to a bogus provider) - you
   should see the failure toast and a handover message, and the session continues.
3. Check the local ledger after a turn:
   `%USERPROFILE%\.local\share\opencode-model-relay\`
   - `switches.jsonl` - one row per switch (metadata only, HMAC'd session id)
   - `state.json` - sticky model, counters, model health
   - `salt` - the per-install HMAC salt
4. `relay_status` output sections: chain, mode, sticky, switches, recoveries,
   consent, key. It never prints the key itself.

To uninstall a local copy: delete the plugin file from the plugins directory and
restart OpenCode.

## 2. Publish to npm (owner-only runbook)

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
