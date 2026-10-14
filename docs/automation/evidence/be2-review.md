# BE-2 independent implementation, test and semantic review

Review baseline `6cc7d8a`, covering the nine BE-2 tasks and the M1 boundary of the corresponding design. This is not just a re-run of existing tests:
lifecycle, receipt authority, bundle ordering, recovery and test oracles were re-examined, and defects were reproduced before being fixed.

## Findings and fixes

| Problem | Impact | Fix and evidence |
| --- | --- | --- |
| Global resume cleared explicit run holds | Work without an explicit continuePinned could execute | Global pause blocks effects only through settings; resume only wakes waiting runs that are not held. A server-intake regression verifies explicit holds are kept. |
| Old pinned work whose current rule was paused got no resume wake | Work explicitly marked continuePinned could wait forever | Global resume sends a durable wake to all of the owner's eligible waiting runs, without filtering by the current desiredState. |
| continuePinned only changed the current rule revision | Holds on revisions from before an edit could not be resumed | pendingRuns covers all immutable revisions by owner and logical rule; execution still pins the original definition/binding. A new old-revision test failed first, then passed. |
| Receipts did not verify source scope and competing rules | An out-of-scope or equal-priority conflicting placement matching the URL could be accepted | Reuses the preview/server scope, binding and priority arbitration; together with the current activation ordinal and bundle pins, only placed can satisfy intake. Two negative tests failed first, then passed. |
| settingsRevision only followed the Pause ETag | Reordered rule snapshots could not be ordered reliably | A separate owner configuration epoch covers rules, bindings and pause; receipts reject stale configuration sequence numbers. The Pause API ETag is unchanged. |
| Configuration-only composition exposed the device runtime | An active bundle could be issued without the runtime installed | Device routes and the manifest exclusion are both controlled by the runtime flag (now `KNOWN_FEATURE_AUTOMATION_ADMISSION`); a composition test covers configuration on, runtime off. |
| Some tests depended on the previous test's state; both sides of the digest shared an oracle | Unreliable when run alone; common drift hard to detect | admission/source-position/device negative cases use separate fixtures; the M1 continuous journey is explicitly a single test; added a digest golden pinned by the public contract. |

The configuration epoch uses forward-only `202610300900_automation_configuration_epoch.ts`,
after the five earlier BE-2 migrations. The upgrade starts above the maximum of the old settings and already-issued bundle sequence numbers;
the actual deploy restore pause SQL also advances the sequence, and old schemas stay compatible through an existence check.

## Executed validation

All PostgreSQL integration commands ran as `xvfb-run -a npm --prefix packages/server run
test:integration:file -- …` on actual Testcontainers PostgreSQL; undiscovered tests are not counted as passing.

- First round of new receipt-semantics/server-intake counterexamples: 5 failed, 3 skipped by the filter.
  After the fixes both files passed 8. After adding the configuration-epoch upgrade and restore cases, receipt-semantics
  alone passed 5. The added old-revision continuePinned counterexample first failed 1 with 5 filtered; after the fix
  server-intake alone passed all 6.
- Seven related integration files (M1 backend gate, device receipts, placement Undo, admission, source position, bundles,
  persistence): 18 passed. The M1 gate includes real pg_dump/pg_restore,
  rollback before commit, replay after commit without ack, the real API/canonical Outbox worker and Undo.
- Automation/MCP unit, six files: 13 passed; after finally adding the independent digest golden and the composition gate,
  the two files passed 6. Each run verifies the change; counts are not added up to pose as distinct cases.
- server typecheck, ESLint on changed source files, check:imports, build, openapi:ci,
  runtime:manifest:check, check:migrations (relative to `6cc7d8a`), shell syntax and git diff whitespace passed.
- The original task's broader canonical/shared-core regression is in [AW-66](aw-66.md); unrelated tests were not repeated this time.

Test resources are reclaimed through the wrapper, fixtures and app.close; no service started by this task is kept.

## Semantic boundary

Nothing was extended to M2 jobs/targets/model/Events or the Web, Extension or native implementation; this report does not claim browser-store,
real offline device execution or online deployment verification. Unknown Sync/default intent still keeps the current location; explicit choices, imports
and restores do not invent automatic classification authority. The receipt's rulePlacement decision only describes an already verified canonical placement
and does not authorize another move; the pre-save advisory beforeFolder still cannot produce an Undo. Historical snapshots keep the 2,000-member limit.

When an offline device sees a pause is still bounded by the 7-day bundle validity; the 5-minute refresh is a recommendation, not an instant revocation guarantee.
All implementation and test defects found in this review were fixed; no failure was worked around by widening scope, replacing pins, inferring intent or adding M2
semantics. BE-2's completed scope remains this repository's executable, recoverable M1 backend gate.
