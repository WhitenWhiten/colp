# AC-39 — bounded manual continuation (2026-10-14 UTC)

Implementation: `b20bdda`, `0546067`, `3093188`, `ad3c7f5`, `f64a546`.
The Owner explicitly accepted partial commits to prioritize saving availability.

Canonical bookmark moves now use bulk row sets and reuse locked reads. Large manual
selections (>20 placement-only members, or >1 with tasks) atomically reserve the
fixed selection, consume the preview and enqueue existing Outbox delivery. Start
returns a running parent. Each continuation commits at most 10 members (one with
tasks), then defers 250 ms. No new queue or database migration is introduced.

Each slice rechecks authority, pinned bindings and original member revisions.
Stale members need review. Receipts, progress and placements commit together under
the delivery lease fence. Failure rolls back that slice; completed effects remain.
Cancellation stops pending work; redelivery resumes without duplicate effects.
Small selections keep their synchronous atomic path. Per-effect Undo is retained.

## Verification

Node 22 / xvfb: manual-continuation, manual-batch and run-once integration suites:
**17 passed**. Covers slice rollback/retry, stale lease, pause/resume, changed member,
cancellation, authority loss, immutable selection and worker task admission.
Server typecheck, affected-file ESLint and import boundary checks passed.
Earlier canonical/capacity/lock-order regressions also passed during optimization.

One final s2 run only: Node 22.23.2, isolated PostgreSQL 16.15, original services
stopped, 100 bookmarks, three groups of 20 saves at 5 saves/s each. Uses production
application/database transactions and the real continuation route/consumer with a
test lease driver respecting available_at; this is not full dispatcher/HTTP evidence.
See [raw results](fixtures/ac-39-s2-f64a546/burst.jsonl).

| Metric | Result |
| --- | --- |
| Start return | 0.768 s |
| Full completion / committed slices | 12.675 s / 10 |
| Moved members | 100 / 100 |
| Same collection save p95 / max / errors | 3.366 s / 3.554 s / 0 of 20 |
| Same owner, other collection p95 / errors | 2.791 s / 0 of 20 |
| Other owner p95 / errors | 2.821 s / 0 of 20 |

The user-provided historical comparison remains the 12.9-second run with same-
collection lock timeout and 20/20 burst failures. This run eliminates failures in
that 100-member scenario, but **fails the unchanged save p95 <=1 s / max <=2 s
thresholds**. Even the runner's existing capture-enabled control had p95 1.412 s.
That observation alone does not isolate hardware from software cost.

The runner now reports start latency and asynchronous completion separately;
the 10-second start gate and 120-second completion safety bound do not claim the
old end-to-end 10-second gate passed. gateObservationSpanMs spans multiple separate
lock acquisitions and is not a continuous lock hold. Traffic lasts four seconds;
this is not sustained-load evidence throughout completion.

Earlier [atomic-batch smoke fixtures](fixtures/ac-39-s2-b20bdda/) are retained as
historical evidence, not substituted for the final result. Intermediate larger-
selection trials still showed contention. No final 500/1000-member, rule-scaling,
queue-recovery or full-dispatcher acceptance was repeated in this close-out.
**AC-39 remains open; this evidence does not establish release/merge readiness.**

The isolated test database is stopped after verification. Original s2 services
remain stopped per the Owner's instruction; their volumes are retained.

## Dispatcher and contention follow-up (2026-10-16 UTC)

Manual continuation now limits PostgreSQL lock waits to 50 ms. A busy account,
collection gate or later row lock rolls back the entire current slice, releases
its locks and requests an ordinary Outbox continuation after 250 ms. Deferral
rechecks the original live delivery lease in a separate transaction. It does not
consume a failed attempt or retain a partially committed slice. Ten-member
placement batches, authority checks and the original canonical mutation path stay
in force. Foreground work can delay background completion under contention.

The capacity runner now uses `VersionedOutboxWorker`, the real lease repository,
manual and ingest routes, and durable collection projections. It respects the
real polling/availability clocks. Four groups each submit five writes/second from
admission until completion (at least 20 per group): same-collection canonical
saves, same-owner other-collection saves, foreign-owner saves and same-owner
separate-collection Sync Push. The latter uses a valid independent session:
canonical product changes require recovery of a replica in the changed collection.
This run does not claim same-collection Sync recovery or external HTTP latency.

Node 24.14.0, PostgreSQL 16.4, Ryzen 5 9600X, six visible CPUs, about 12 GiB RAM,
six application connections; dispatcher concurrency/batch size 1/1. Runs were
sequential with no concurrent test suite, under xvfb, in disposable schemas and
containers. Baseline uses the prior consumer at `8f191d73` (unchanged from
`9774d723`); the same final runner was used before and after. Values below are
one baseline round and the final three-round range; all times are milliseconds.

| Metric | Baseline | Final bounded lock wait |
| --- | ---: | ---: |
| Same collection save p95 | 63.1 | 61.5–80.6 |
| Same owner other collection save p95 | 52.0 | 49.6–58.7 |
| Foreign owner save p95 | 51.9 | 49.5–54.4 |
| Sync Push p95 | 163.1 | 150.1–170.2 |
| Start return | 80.6 | 68.6–86.8 |
| Full completion | 8,740.5 | 5,339.9–10,442.6 |
| Moved members / save or sync errors | 100 / 0 | 100 / 0 each round |

All four groups passed the unchanged p95 <=1 s / max <=2 s gates; final worst
save latency was 122.9 ms and worst Sync latency 204.7 ms. Each group produced
28–54 observations per final round. The baseline also passed locally: these
numbers do not show that the older s2 regression has disappeared. An intermediate
account-NOWAIT candidate passed foreground gates but varied from 9.5 to 39.3 s
completion; bounded waiting gives background work a chance to acquire the account.
No capacity defaults were increased. The s2 environment, 500/1000 members, real
provider/host and full production bootstrap/HTTP acceptance remain unverified;
**AC-39 remains open for release acceptance.**

Raw [baseline](fixtures/ac39-dispatcher-20261016/baseline.jsonl),
[final three rounds](fixtures/ac39-dispatcher-20261016/bounded.jsonl),
[NOWAIT candidate](fixtures/ac39-dispatcher-20261016/nowait.jsonl),
[environment](fixtures/ac39-dispatcher-20261016/environment.json) and
[source hashes](fixtures/ac39-dispatcher-20261016/source-sha256.json) are retained.

Focused PostgreSQL correctness checks passed: manual continuation (5), manual
batch (4), and new contention cases (2). Contention tests keep an account or
collection gate locked externally, verify prompt rollback/deferral with no effects,
verify that a stale lease cannot defer, then release the foreground lock and
complete all 25 effects exactly once. Server typecheck, changed-file lint and
module import checks passed. All temporary database services were stopped.
