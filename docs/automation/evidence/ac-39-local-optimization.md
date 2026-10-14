# AC-39 follow-up — local small-workload optimization

The local baseline was recorded **before changing production code**, using the
production source from `f6beff6` and the evidence runner introduced in `e310f74`.
The optimized source is the commit introducing this report. Only workload-size
configuration was added to the runner before the baseline; the same runner and
parameters were used afterwards.

## Measured comparison

Node 22.23.2, PostgreSQL 16.15, Ryzen 5 9600X with six visible virtual CPUs and
approximately 12 GiB RAM. A dedicated local container used 128 MiB shared buffers,
40 PostgreSQL connections and the fixture's six-connection application pool.
The baseline and optimized runs were sequential, with no concurrent test suite.
Each case used an isolated schema. Values below are **medians of three runs**.

| Workload / observation | Before | After |
| --- | ---: | ---: |
| 20-member run-once time | 775.6 ms | 600.3 ms |
| Run-once query count | 1,197 | 928 |
| Observed replica-gate hold, lower bound | 746.1 ms | 587.1 ms |
| One concurrent same-collection save | 812.3 ms | 642.3 ms |
| 1-rule preview / queries | 27.6 ms / 45 | 28.1 ms / 45 |
| 10-rule preview / queries | 142.8 ms / 261 | 43.8 ms / 68 |
| 30-rule preview / queries | 389.6 ms / 741 | 44.9 ms / 68 |
| 10-rule admission drain | 142.2 ms | 71.7 ms |
| 30-rule admission drain | 397.9 ms | 163.0 ms |

Run-once time decreased about 23%; 30-rule preview time decreased about 88%, and
admission drain time about 59%. Query counts, unlike wall-clock timings, were
identical across each workload's three repetitions. All measured saves succeeded
before and after. Twenty bookmarks were created through canonical commands;
manual load used one concurrent save in each of the same-collection, same-Owner
other-collection, and foreign-Owner groups. Each capture-disabled/enabled baseline
used 20 saves to the same-Owner control collection in a separate phase. These
individual concurrent-save observations are not percentile SLA measurements.

## Changes and preserved guarantees

- Competing-rule inspection reuses each binding/collection/folder read during
  that read-only pass. Cache keys include the actor and full folder identity;
  each rule still evaluates its own role and ancestor constraints. A new pass
  re-reads current authority. Worker readiness and credential expiry are not
  cached. Admission similarly reuses folder reads while preparing its rules,
  before executing canonical effects.
- Run-once validates all snapshot members in one query and inserts its parent and
  child runs together. Canonical mutation still rechecks each moved resource;
  a previous mutation's rebalance cannot bypass resource-revision fencing.
- Run-once uses the existing explicit atomic capacity-batch facility. The exact
  Snapshot capacity ledger is reconciled before/after the batch, with the final
  capacity decision inside the same transaction. Canonical resource writes,
  revisions, operation payloads, audit, facts, outbox and Sync invalidation still
  use the established canonical mutation application.
- Placement-only manual runs persist verified effect receipts in a batch. Receipts
  retain each operation's original facts, content revision and digest. Replay
  preserves the original receipt IDs. A pending count-batch consumer gets a
  durable collection wake when new receipts are inserted. When worker tasks run,
  each receipt is still available before that child's successor inputs are pinned.

No feature flag, quota, lock timeout, connection-pool size, immutable-preview rule
or all-or-nothing transaction requirement was relaxed. No database migration or
public contract change is required.

## Correctness verification

All relevant E2E/integration commands ran under xvfb, using the disposable local
database. Across focused runs, **43 distinct integration cases and 3 unit cases
passed**:

- `manual-batch`, `rule-inspection`, `placement-undo`, `count-batch-device`,
  `server-intake`, `worker-pipeline`: 6 files, 35 cases passed together.
- Existing `run-once`: 8 cases passed in the preceding focused run.
- `inspection-reads` and `binding-semantics`: 3 unit cases passed.
- Source typecheck, lint of changed files, import boundaries and diff whitespace:
  clean.

New regressions verify bounded queries even with distinct binding sets sharing
folders, separation of actors/servers/read passes, rule-specific ancestor
constraints, stale activation after a canonical folder move, exact capacity
accounting, stable receipt replay, and complete rollback after an injected receipt
failure (nodes, runs, reservations and outbox).
The capacity case was also re-run successfully after strengthening it to require
an empty dirty ledger before any readback could reconcile it.

The first focused run exposed two incorrect new assertions: database failures
carry the injected message in their private cause, and folder renames intentionally
do not change placement authority. The assertions were corrected to inspect the
cause and use an actual folder move; both corrected cases passed in the final
35-case run. Production behavior was not changed to satisfy those assertions.

## Reproduction and evidence

[Environment and runner hash](fixtures/ac-39-local/environment.json),
[baseline JSONL](fixtures/ac-39-local/before.jsonl), and
[optimized JSONL](fixtures/ac-39-local/after.jsonl) preserve the measurements.

From `packages/server`, with Node 22 and an isolated `KNOWN_TEST_DATABASE_URL`:

```sh
export AC39_ROUNDS=3 AC39_SAVE_COUNT=1 AC39_CANONICAL_SEED=1
export AC39_SIZES=20 AC39_RULE_SIZES=1,10,30
export AC39_OUTPUT=/absolute/path/results.jsonl
AC39_STAGE=manual timeout 240 xvfb-run -a node --import tsx tests/support/ac39-capacity.ts
AC39_STAGE=rules timeout 240 xvfb-run -a node --import tsx tests/support/ac39-capacity.ts

xvfb-run -a node node_modules/vitest/vitest.mjs run --project unit \
  tests/unit/automation/inspection-reads.test.ts tests/unit/automation/binding-semantics.test.ts
xvfb-run -a node node_modules/vitest/vitest.mjs run --project postgres \
  --fileParallelism=false --testTimeout=60000 --hookTimeout=120000 \
  tests/integration/automation/manual-batch.integration.test.ts \
  tests/integration/automation/rule-inspection.integration.test.ts \
  tests/integration/automation/run-once.integration.test.ts \
  tests/integration/automation/placement-undo.integration.test.ts \
  tests/integration/automation/count-batch-device.integration.test.ts \
  tests/integration/automation/server-intake.integration.test.ts \
  tests/integration/automation/worker-pipeline.integration.test.ts
```

This is a small local comparison, **not a new s2 AC-39 pass**. The original
[s2 failure](ac-39.md) was subsequently rechecked against `75d921c`; the
[re-verification](ac-39-s2-reverification.md) still failed manual saving availability,
despite passing rule scaling and finite queue recovery.
Large manual batches still execute their canonical moves in one transaction;
less work under the lock does not prove that 100 or 1,000 members meet s2's save
availability requirement. Large-batch and sustained-load limits remain unvalidated.
