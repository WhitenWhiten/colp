# BE-1 + BE-2 foundation review

Review baseline: `544d732`. The two batches of `13-backend-first.md` were checked together rather than accepted again separately.
Covers the shared finite core, binding/preview/lifecycle/health, canonical facts, Outbox/admission,
pinned runs, device bundle/receipt, placement/Undo, recovery and API contracts; does not extend to BE-3/M2.

## Confirmed findings

| Severity | Problem and reproduction | Fix |
| --- | --- | --- |
| High | Submitting resume again while already unpaused rebuilt the activation fence, skipping committed events still queued for consumption. | A same-state Pause request returns the current state after checking If-Match, without advancing the sequence or rebuilding the admission interval. A real resume still takes a new high-water mark. |
| High | Submitting a new preview and a same-state lifecycle request while already enabled could likewise lose sources awaiting consumption. | The current activation interval is kept; the exact preview and current authority are still verified and the explicit pendingRuns policy applied. |
| Medium | BE-1 let editors configure/preview, while BE-2 only executes collection-Owner rules; with runtime on, editor rules were wrongly reported active. | The collection snapshot distinguishes the current Owner; runtime enable rejects missing Owner authority, health reports blocked, validate/preview explain it, and the device bundle checks the Owner too. Existing editor configuration and preview are kept. |
| Medium | The Run API lost the execution explanation in the private record and could not distinguish an explicit hold from ordinary waiting. | Optional held/explanation were added through a contract adjustment; the server returns a bounded business explanation without exposing private facts or explanation_json. List, detail and cancel responses are covered. |
| Medium | A cancelled run receiving real late Sync placement evidence added an effect without changing the Run revision. | The Run revision advances only when a new effect is inserted; it stays cancelled and is not re-executed; a new receipt identity for the same effect neither duplicates the effect nor advances the revision. |
| Low | Preview text left by BE-1 still claimed runtime unavailable after BE-2 was installed. | Made explicit as preview only / no effect; run capability is still decided by capabilities/health. |

The new Run fields are generated from `contract-adjustments.json` into the shared schema/types and the Product
OpenAPI; the local packed dependency, lockfiles and runtime manifest are synced, and the frozen baseline is not modified.
No new database migration, no changes to old event evidence and no change to the placement authorization model.

## Review of cross-batch invariants

| Invariant | Review scope and where it is verified |
| --- | --- |
| One finite language and decision model | schema, compiler, normalizer, digest, role graph; preview/admission/receipt use the same scope, binding and priority arbitration. Shared-core positive/negative cases and server semantic suites. |
| Configuration cannot implicitly start new semantics | Exact unexpired preview, immutable rule/binding revisions, semantic edits pause, pending work pins the old pin, Owner vs editor authority boundary. api/health/foundation/server-intake. |
| Transaction boundaries of capture, consumption and effects | Private event-time before/after, per-ordinal inspection, per-source receipts, atomic effect/cursor commit, Outbox generation/expiry commit fence. fact-capture/source-position/admission/M1 gate. |
| Pause, resume and retry neither lose nor duplicate work | A real resume skips the paused interval; same-state requests do not reset it; an explicit hold is not released by a global resume; continuePinned on an old revision does not rebind. foundation/admission/server-intake. |
| Device claims are not authorization | bearer/session/Origin, current generation, canonical Sync create/move, authenticated bundle pins, scope/priority, input/result digest; classify.root only. device-receipts/receipt-semantics/late-receipt-review. |
| History and Undo do not amplify effects | Real canonical operations, stable effect identity, the original folder must be proven, current Owner/resource/content fences, single-bookmark compensating move. placement-undo/M1 gate; late history updates advance the ETag correctly. |
| Recovery and package contracts do not drift | Real pg_dump/pg_restore and deploy pause SQL, configuration epoch, closed DTOs, generation checks and compatibility with the old OpenAPI baseline, actual local package build. persistence/M1 gate and contract checks. |

Test-quality improvements: each test in the new foundation suite builds its own database; the late-receipt test uses real Sync
operations to move the bound folder, create a bookmark, produce a blocked admission, cancel, repair the folder and submit placement,
without writing fabricated effects/runs directly. source-position adds a separate connection that replaces the lease after the consumer writes,
proving the consumer writes and the source cursor roll back together while the replaced lease remains.
The configuration API, run API and bundle suites also moved to a separate database/application per test; previously they only truncated
configuration tables or shared a bundle counter, leaving canonical nodes behind or depending on execution order. These three files additionally
ran a fixed-seed shuffled regression.

## Executed evidence

- First round of four foundation tests: the two admission watermark defects and the missing API explanation failed as expected; the editor case
  first failed because the fixture lacked a required reason, and after fixing it a separate re-run truly reproduced the active/blocked error. Fixture errors are not treated as product evidence.
- After the fixes, the foundation and source-position files: 7 passed.
- The first late-receipt fixture used an Owner canonical move, which correctly triggered revocation of the existing Sync session;
  after switching to a real same-device Sync move it reproduced the revision-stays-at-2 defect. The fix covers the cancelled state and duplicate receipts.
- Shared core: 6 files, 22 passed; server automation unit: 6 files, 11 passed.
- `xvfb-run -a npm --prefix packages/server run test:integration:file -- tests/integration/automation`:
  16 files, 84 passed, including the late-receipt fix above and the check that duplicate evidence does not change the revision.
- After isolating fixtures, the api, runs and bundles files additionally ran with `--sequence.shuffle --sequence.seed=20261012`
  under xvfb/PostgreSQL: 3 files, 39 passed. This count is a shuffled regression and is not added to the 84.
- typecheck, build, ESLint on changed src and test files, check:imports, openapi:ci,
  runtime:manifest:check, shared check:automation/source-size/traceability/protocol and git diff --check passed.
  OpenAPI has no breaking change against the frozen 1.95.0 baseline.
  PostgreSQL, Xvfb and Fastify/worker resources created by tests are reclaimed by the wrapper/fixture lifecycle.

## Remaining scope

These results are evidence for this repository's M1 backend foundation, not native browser, MV3/store, online load or deployment acceptance.
AW-44's full retention/load work still belongs to a later batch. Current limits stay explicit: 500 rules per Owner,
at most 10 sources/placements per slice, historical snapshots of at most 2,000 live members; an offline device's pause exposure is still bounded
by the 7-day bundle expiry, with a recommended 5-minute refresh. M2 policy/target/job/Events/model paths are not yet enabled.
