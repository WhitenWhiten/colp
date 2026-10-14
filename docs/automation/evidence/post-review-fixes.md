# Post-review fixes (2026-10-13)

A code, test and semantics review of BE-1..BE-5 on `feat/colp-automation` raised high (H),
medium (M), code-quality (C), test (T), documentation (D) and low (L) findings. Each fix is
its own commit. This record lists them, the earlier R1–R16 round that the review found
undocumented, and the findings deliberately left unchanged.

## Earlier review round R1–R16

These commits came before the review, and no evidence or status document recorded them.

| Item | Commit | Change |
| --- | --- | --- |
| R1 | `76fd987` | Retain verified OAuth connections across token refresh |
| R2 | `58707fa` | Feed verified intake evidence to task successors |
| R3 | `c46fbbb` | Acquire the replica gate before manual configuration reads |
| R4 | `c19e385` | Separate aggregation identity from labels and budgets |
| R5 | `4d2e275` | Share partition and distinct semantics with previews |
| R6 | `b61b5df` | Keep active delivery paths during subscription renewal |
| R7 | `969797a` | Emit durable wakes for each readiness generation |
| R8 | `e4da0bc` | Resume daily budget holds through durable wakes |
| R9 | `5f1c8da` | Validate canonical output constraints before planning |
| R10 | `63fdf61` | Bound and hash manual snapshots by member |
| R11 | `3e100d9` | Reject unenforceable monetary policy limits |
| R12 | `790c8c6` | Expose explicit Owner tag rejection commands |
| R13 | `47c93fb` | Count live subscriptions independently of retained identities |
| R14 | `f32fdf4` | Batch snapshot ancestry and run history reads |
| R15 | `b1b7aab` | Isolate fair concurrent delivery from housekeeping |
| R16 | `33b8f59` | Type plan construction and use stable state reasons (the indentation it introduced is reverted by C1) |

## Fixes from this review

| Finding | Commit | Change |
| --- | --- | --- |
| H3 | `7dc943d` | Every automation migration has its own G9 prefix; the migration-order check now passes against both merge parents. Earlier evidence that reported this check as passing predates the duplicate prefixes. |
| H2 | `f1d838f` | Rollout flags follow the design: `KNOWN_FEATURE_AUTOMATION_RULES/CAPTURE/ADMISSION/WORK`. The pre-design `CONFIGURATION/RUNTIME` names are rejected at start-up. This adopts the design, so it needs no contract adjustment. |
| H1 | `4ba0fa0` | Fact capture and the ingest outbox run only under `KNOWN_FEATURE_AUTOMATION_CAPTURE`. |
| H4 | `25cf867` | The device bundle selects rules per collection, so one unsupported collection no longer fails the whole Owner bundle. |
| D1, D2 | `b60d74c` | README provenance and OpenAPI source facts corrected. |
| D4 | `ce7f81c` | Evidence translated to English, with agent-process prose removed. |
| — | `284ffe6` | The late-receipt replay test no longer compares the read-time usage window. |
| H5 | `2088635` | The server applies Owner-approved proposals; it no longer waits for the worker to resubmit. |
| H6 | `95fff2f` | Summaries go to a separate automation note and are never appended to the Owner's note. |
| H7 | `943be4d` | MCP bindings stay token-specific; the automation connection id is carried separately. |
| H8 | `2802966` | The unreleased SDK is vendored as `0.2.0-automation.0` instead of reusing `0.1.3`. |
| M1 | `f69d905` | Rule path and host values are normalized like bookmark URLs, so non-ASCII and space-containing paths match. |
| M2 | `179d94b` | `event.changedFields` predicates report an unsupported capability instead of a type error. |
| M3 | `58da366` | Non-http bookmarks still evaluate title, tag and event predicates. |
| — | `f749f23` | Hand-built MCP test contexts pass the automation connection id (follow-up to H7). |
| M4 | `394d453` | Run-once uses the shared intake roots, the competing-rule check and the per-run cap. |
| M5 | `9a5d680` | countBatch derives URL identity from the shared core normalizer. |
| M6 | `2d79e1c` | The Owner can propose a retained output again after its plan expired. |
| C4 | `3f72581` | Removed the dead `appendCountBatch` and corrected stale wording. |
| C5 | `b49d3ac` | Receipt and export contract versions come from the core constant. |
| C6 | `d0cfa7d` | The per-Owner rule limit is enforced with a count and reports `automation_rule_conflict`. |
| M7 | `74bba90` | Targets are unpaired only when their identity or data terms change; a rename keeps Events subscriptions. |
| M8 | `f7a88db` | Output is withheld only for jobs that read a deleted bookmark; batch runs are listed for every member. |
| M9 | `7d723e7` | Health revalidation is isolated from start-up and from the core projection. |
| M11 | `6208237` | The worker HTTP routes are rate-limited like pairing. |
| C1 | `aa50c99` | Restored 2-space indentation in the files R16 reformatted (`git diff -w` is empty). |
| M14 | `12d885e` | Owner erasure cascades, SQL-built Events bodies are checked before delivery, and migration code is frozen. |
| C3 | `87f1297` | Bindings are imported statically, and stores are no longer called through `this`. |
| M15 | `6c7dd63` | The tool generator fails when the MCP catalog's copy of a definition shadows the canonical one. |
| L7 (format) | `b9897e4` | Dropped the unused `format` field from automation plan operations. |
| L6 | `267cff2` | Role-graph issues point at roles by array index. |
| L4 | `c5e9827` | Events subscription failures map to specific JSON-RPC codes instead of one invalid-params message. |
| L7 (clock) | `8669a30` | Delivery retries, bundle expiry and secret grace use the database clock. |
| T1 | `ac0fb4d` | Lease tests use a job admitted by the real pipeline and real target authorization. |
| T5 | `689c0ce` | Fixtures are read by repository path, not the working directory. |
| T6 | `efae5ab` | The upgrade test is named for what it covers. |
| T2 | `538bd35` | The production worker route composition is covered. |
| T3 | `0c36304` | The M1 gate worker runs with the real projection routes. |
| T4 | `aeb387a` | Pause goes through the API, and INSERTs name their columns. |
| C2 | `9b7a5d0`, `49ddd47` | The run output store and the worker read store were expanded from the dense one-line style. |
| M12 | `5cd7f4d` | Rule, run and job GETs no longer write. Convergence moved to the worker maintenance sweep. |
| L3 | `973a60c` | Every Owner route checks path identities with one shared check. |
| L7 (key rotation) | `c415c4d` | The webhook master key can be rotated with `AUTOMATION_WEBHOOK_PREVIOUS_MASTER_KEY`. |
| L2 | `59dce95` | `heldJobs` counts only jobs under a run hold or the global pause. |
| T7 | `578f5cd` | Exact revalidation and contested counts replace `toBeGreaterThan(0)`. |
| M12 (sweep) | `ed78e7e` | The maintenance sweep advances pending tasks that nothing else schedules: the successor of a task that finished while paused, and runs whose plan the sweep reconciled. Events-mode work no longer waits for a worker to list jobs. |

T8's missing tests ship with their fixes: `fact-capture` (H1), `bundles` (H4),
`worker-pipeline` (H5) and core `normalization` (M1).

## Deliberately unchanged

- **M10:** Placement keeps the collection-version prerequisite, and run-once stays atomic. AC-50 and AC-64 require this, so the 2,000-node placement bound and the 1,000-item run-once bound are documented limits, not defects.
- **M12 (worker list):** The worker's job list still advances its own target's queue, so a polling worker sees new work without waiting for the sweep. It is no longer the only scheduler for pending runs: the maintenance sweep also advances them (`ed78e7e`). Every other read is now write-free.
- **M13:** The per-Owner account lock orders every automation transaction for that Owner, and authorization and stale-marking upgrade to write locks. Switching reads to `FOR SHARE` would require lock upgrades that can deadlock, so the lock stays. The global claim lock and the server daily cap are how the design enforces cross-Owner caps. Per-Owner fairness is left to the per-rule and per-Owner caps.
- **M13 (preview and admission):** Preview still loads bindings and resolves folders for each competing rule, and admission still resolves bindings while it holds the run locks. Both are bounded by the 500-rule limit per Owner (C6). Batching them is left until AC-39 shows they matter.
- **M14 (remainder):** The English backfill strings match the exact earlier constants. The legacy-decode error stays fail-loud.
- **M15 (remainder):** Events types stay in core, and the interface-only services stay where they are. Moving them changes the package surface without changing behavior.
- **M16:** Typing the remaining automation tables in Kysely is low value. The `McpStoredPlan` cast is one isolated, commented boundary.
- **T1 (remainder):** `automation-job-fixture` still inserts jobs with SQL for tests that only need a job row. Lease and pipeline behavior is covered through real admission (`ac0fb4d`, `worker-pipeline`).
- **L1:** A user-chosen pause returns 503 `automation_paused`, as the design's API error table specifies.
- **L5:** `automation-catalog` throws `TypeError('Invalid Resource URI.')` because the MCP read adapter maps exactly that error to InvalidParams, as the existing facade does. Another error type would break that mapping.
- **L7 (redundant checks):** This finding named no specific sites, so there was nothing concrete to change.

## Open before release

AC-39 (load and evaluator budgets) was subsequently attempted on s2 and **failed**;
see [the measurements and evidence boundaries](ac-39.md). A 100-bookmark run-once
already held the Sync replica gate for over 19 seconds and caused concurrent saves
to fail. Larger manual loads were stopped. M10 and M13 remain release concerns;
the documented upper bounds are not validated deployment capacity.
The [local optimization follow-up](ac-39-local-optimization.md) addresses repeated
inspection reads and manual batch overhead with a measured small-workload baseline.
The [s2 re-verification](ac-39-s2-reverification.md) confirms the rule-read improvement,
but manual saving still times out and the release gate remains open.
The [canonical SQL follow-up](ac-39-canonical-sql.md) further reduces queries, but
the next s2 verification still fails manual saving; queue save p95 also exceeds
its limit. The release gate remains open.

## Verification

Each commit ran its typecheck, lint and the integration or unit files it touched, under
Node 22. At `578f5cd`, also under Node 22:

- Server typecheck, import boundaries and the runtime manifest check: clean.
- Automation unit tests: server 60/60, core 41/41.
- Full automation integration suite: 48 files, 231/231 tests passed (`npm run test:integration:file`, about 34 minutes).

For `ed78e7e`, the new worker-pipeline test failed without the fix (the successor stayed pending),
and `worker-pipeline` plus `approval-undo` passed 27/27 with it under Node 22, with a clean typecheck.

The SDK tarball was
re-vendored in several commits (H8, M5, L4), so a squash merge keeps only the final tarball
in history.
