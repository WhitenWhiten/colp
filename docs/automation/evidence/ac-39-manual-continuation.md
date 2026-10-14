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
