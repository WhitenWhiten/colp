# KNS-08 acceptance evidence

Owner: KNS-08 (QA). This directory is the replay entry for first-run and trash-restore dual-Profile evidence. It does not change Merge/Delete/mount product semantics.

## Stable IDs

Every AC for KNS-00…07, 10, 11 is listed in `e2e/kns-08-ids.ts`. New specs stamp `kns08:<ID>` in the file header. Failures write a minimal replay fixture to `test-results/kns-08-replay/<id>.json` and must not be rerun until flake-green.

KNS-09 / AC-10 release contracts, receipt, and rollback drill: `npm run evidence:kns-09-release`. Runbook: [kns-09-runbook.md](kns-09-runbook.md).

Earlier acceptance receipts were recorded against commits made before the extension moved to this
repository. They are not proof of the current tree; new browser runs are separate evidence.

## Commands (host, no full-shard act)

From the repository root, with the same `evidence:*` shape as phase-3:

```bash
npm --prefix packages/extension run evidence:first-run-sync
npm --prefix packages/extension run evidence:trash-restore
```

For actual Microsoft Edge, reuse those same specs with Node 22 and a locally installed Edge:

```bash
KNS_08_BROWSER=msedge npm --prefix packages/extension run evidence:first-run-sync
KNS_08_BROWSER=msedge npm --prefix packages/extension run evidence:trash-restore
```

For an extracted official Linux package, also set `KNS_08_EDGE_EXECUTABLE` to its absolute
`msedge` binary path. Each launch creates/reopens only the test's temporary Profile and records
CDP product/user-agent metadata; an Edge run fails if the runtime does not identify as `Edg/`.
There is no Chromium fallback. Edge artifacts use `<commit>/msedge/<suite>/`, separate from
Chromium. Package version and SHA256 must be recorded with any published evidence. This tests
Linux Edge with the fixture extension and local real backend, not Windows, store installation,
production deployment or multi-day offline use.

Before deleting `test-results`, copy the successful suite archives and command execution logs
to a versioned audit directory, generate SHA256SUMS there, verify it, and commit it with the
report. Preserve the observed tested SHA; do not relabel a run with the later documentation SHA.

Each script runs:

1. `npm run build -- --config config/e2e-fixture.json`
2. `packages/server/scripts/with-postgres.mjs`
3. `scripts/with-xvfb.mjs npx playwright test <spec>`
4. `scripts/verify-release-artifact.mjs dist/production`
5. `scripts/verify-bookmark-privacy-artifacts.mjs test-results`

Output lands in `test-results/known-extension-first-run-sync/<commit>/`. Logs are redacted (no URL, title, token, or full user id).

`with-postgres.mjs` uses `KNOWN_TEST_DATABASE_URL` or `DATABASE_URL` when it is reachable and otherwise starts a Testcontainers PostgreSQL. Playwright must run on **Node 22** (same as CI). Node 24's `require(esm)` breaks `sanitize-html` → `htmlparser2` (`request for './Parser.js' is not in cache`) so specs fail to load.

## Release permission pin (HEAD `87b428f8`)

KNS-07 aligned the release pins with the shipped manifest: `["cookies", "storage", "alarms", "activeTab", "favicon", "contextMenus"]` in `manifest.base.json`, `scripts/build.mjs`, and `scripts/verify-release-artifact.mjs`. Dual-Profile evidence can run on this SHA. KNS-08 does not change that product contract.

Unit/contract IDs reuse existing tests:

```bash
npm --prefix packages/extension exec vitest run tests/kns-08-acceptance-matrix.contract.test.ts
npm --prefix packages/extension exec vitest run tests/kns-01-mount-scope.test.ts tests/bookmark-boundary.test.ts tests/kns-03-merge.test.ts tests/kns-04-push.test.ts tests/kns-05-pull.test.ts tests/kns-10-recovery.test.ts
npm --prefix packages/extension exec vitest run tests/kns-00-golden-fixtures.test.ts
```

## Harness reuse (F-09)

- Dual persistent Chromium profiles: `profileA`/`profileB` mkdtemp + `launchPersistentContext` restart, same shape as `e2e/mv3-multi-device-recovery.spec.ts`.
- Real stack: `e2e/real-stack.ts` `startRealStack()` / `PushFault`. Profile management is not copied.

## Matrix

dual Root Mount, nested boundary, empty/nonempty bootstrap, A/B fork, duplicate candidates, field conflict, concurrent Move, delete+restore, parent delete, offline, lost Push response, Pull interrupt, permission revoke/restore, unselected range not uploaded.

## Replay

If a spec fails, open `test-results/kns-08-replay/<id>.json`. Failures must include exported queue/mapping/engine facts, not a guessed owner. Do not rerun until the owning KNS task is flake-green. Quarantine, `.skip`, and raising baselines are forbidden.

`waitQueueQuiet` must not treat an empty outbound queue as success during first-run. Empty queue plus `recoveryFrozen` is still not quiet. AC-01 waits via `waitFirstRunProductQuiet` (no resume-confirm / evidence-wake loop), matching `session-binding` nonterminal statuses and existing `waitForTerminalCount` / `syncEngineState` barriers. Coordinator enqueue is skipped while frozen (`queue_recovery_frozen`); mappings are written on Push receipt, not at `bindMounts`.

## Independent QA measurement (superseded)

The mid-fix dump (“product sequence still fails”: confirm does not enqueue, engine stays in replica-bootstrap recovery freeze) is superseded. Dual-Profile evidence was replayed on `3767997e`.

Current product handshake: first-run confirm/status wake the engine; login/select wake if a collection is bound (not `selectedRoots`); `hasActiveMounts` is false on an empty list; leftover inbox keeps bootstrap `syncing`; AC-01 uses `waitFirstRunProductQuiet`; trash parent-delete requires Recovered placement. Options/popup keep first-run chrome while `running`; popup never shows 已同步 on an idle engine. Concurrent-move rebase uses the authored source parent after optimistic dest mapping.
