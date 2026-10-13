# Upstream

Moved from Know-N commit `28acb4965e1ec950e8f91998fcc2275429e8aab6` (`Known-Extension/`) on 2026-10-12. Unlike `packages/server` and `packages/web`, this is a move, not a fork: Know-N removed its copy, and the extension is developed here. Its git history before the move stays in Know-N.

## Changes made at import

- **Sibling packages.** The build and tests no longer read Know-N's `Known-Backend`, `Known-Frontend` or `Known-Sdk`:
  - `design/` holds Know-N web's `tokens.css`, `global.css`, `shared-chrome.css`, `capture.css`, `icon-paths.ts`, `scopedRefresh.ts`, `brand-wordmark.svg` and `apple-touch-icon.png`, copied from `Known-Frontend/web` at the same commit. The extension keeps Know-N's look; `packages/web` has since diverged and is not a substitute.
  - `src/capture/statistics.ts` is Know-N SDK's `capture-statistics.ts`; the `@known/sdk` dependency is gone.
  - Product API types come from `packages/server/generated/openapi/product-v1.ts` (type-only imports).
  - `scripts/phase3-marker-scan.mjs` (with its `.d.mts`) is copied from `Known-Backend/scripts`.
  - `tests/fixtures/credits-ledger-golden.json` is the classification-credits wire contract from Know-N's planning docs.
  - `docs/kns-09-runbook.md` is Know-N's KNS-09 release runbook, with paths and CI job names updated.
- **Classification.** `src/generated/classification/` stays generated from the Know-N server's policy. The build no longer runs Know-N's generator check; Know-N runs it against this package, together with the two checks that compare these files with the server: the browser-versus-server parity case from `classification-local.test.ts` and `classification-local-provider-types.test.ts`. The rest of `classification-local.test.ts` stays here.
- **Browser harness.** `e2e/real-stack.ts` and the other harness files import COLP Server from `../server` and run against it by default. `scripts/with-know-n-backend.mjs` maps those imports to a Know-N backend checkout instead; it replaces `with-colp-server.mjs`, which did the opposite. Capture, classification, credits, favicon-helper and digest-reader specs need Know-N-only routes: they skip unless that script sets `KNOWN_E2E_BACKEND_ROOT`, and `e2e/cloud-product-fixtures.ts` declares their fixture types so `capture-product-stack.ts` and `classification-product-stack.ts` can stay out of `npm run typecheck`. Capture evidence goes to `test-results/automatic-bookmark-capture` instead of Know-N's `docs/verification`.
- **CI.** The extension jobs are in `.github/workflows/colp-ci.yml` (`extension`, `extension-coverage`, `extension-mv3`, `extension-sync-real-stack`, `extension-kns-09-release`, `extension-kns-09-e2e`) and on `ci-gate`. The contract tests that pin them read that workflow. The KNS-08/KNS-09 scripts resolve paths from the repository root, and their evidence lands in the root `test-results/`.
- **Release.** `npm run package` and `.github/workflows/colp-extension-release.yml` build the store zip here; Know-N's `known-ctrl.sh extension` now builds this package from a `../colp` checkout. The extension keeps its own version and [CHANGELOG](CHANGELOG.md).
- **Removed.** `acceptance-probes/` (observational review probes with recorded failures and local paths), the `diagnose:`/`evidence:phase3-multi-device-recovery` scripts (Know-N's runner owns that acceptance and points at this package), links into Know-N's private plans and audits, and a personal address in `scripts/shots-stub.mjs`.

## Known failures at import

Nine unit tests in seven files already failed on the Know-N commit above, and several browser tests (critical MV3, first-run sync, trash restore) failed against both COLP Server and the Know-N backend. All were fixed here after the move:

- The unit tests had not followed deliberate code changes: the alarm scheduler's `alarms.get`, the recovery chain's `captureMissingRemovals`, the error-phase guard on the unfrozen engine wake, and a discarded Pull Ack that now freezes for a Session refresh instead of Pulling in the same wake.
- Know-N `c9895d6e3` started recording bookmark creates, moves and reorders while the scope was recovery-frozen, which includes the projection of a first-sync Snapshot. A second browser therefore uploaded every bookmark it downloaded. Unmapped snapshot creates are deferred while frozen. Mapped moves, reorders, removals and content changes are kept, with projection echoes suppressed.
- Every `known.firstRun.status` read woke the engine. The sync label reads it on each render, so an open Options page queued engine runs back to back. Status now wakes the engine only while the first sync is running.
