# Automation backend execution status

The first half keeps the actual BE-03 delivery record; the per-item commits and acceptance for BE-4/5 are in the second half.
The design pack's task list is not delivery evidence. `done` means the local implementation scope bounded by the evidence below; it does not mean the whole batch or M2 acceptance is complete.

| Task | Status | Commit and evidence |
| --- | --- | --- |
| AW-22 | done | `eabf2c8`, [execution policy](evidence/aw-22.md) |
| AW-23 | done | `4bfd189`, [lease](evidence/aw-23.md) |
| AW-24 | done | `f5c2d37`, [typed results](evidence/aw-24.md) |
| AW-25 | done | `ac79c62`, [approval and Undo](evidence/aw-25.md) |
| AW-26 | done | `5f9fbd2`, [pairing](evidence/aw-26.md) |
| AW-30 | done | `3bb4fd1`, [conditional catalog](evidence/aw-30.md) |
| AW-31 | done | `84e8239`, [HTTP/MCP orchestration](evidence/aw-31.md) |
| AW-32 | done | `cae18f6`, [polling reference worker](evidence/aw-32.md) |
| AW-55 | done | `e334e34`, [waiting work and budget read model](evidence/aw-55.md) |
| AW-64 | done | [backend polling and process-recovery acceptance](evidence/aw-64.md), committed separately |

On 2026-10-13 the seven executed tasks were reviewed for code, tests, boundaries, complexity and semantics, and the problems found were fixed directly.
The fix list, the verification commands actually run, migration impact and remaining boundaries are in the [BE-03 review record](evidence/be3-review.md).
This round completed AW-32 → AW-55 → AW-64 in order, each committed separately; the BE-03 list is delivered.
The final AW-64 Node 22 + xvfb gate passed 8 cases and the reference-worker transport tests passed 7;
single-task, three-task and M1 receipt/Sync were verified separately. The actual scope and the AW-35 hand-over are in
[release evidence](release-evidence.md). This does not mean the full M2 product, a real browser or hosted Events acceptance is complete.
Unexecuted scope recorded in historical reviews is kept as the conclusion of that time.

An independent re-review based on `1db76fe` reproduced and fixed six convergence problems in preview, daily-budget recovery,
submission state and pause/approval; see [this round's fixes and counterexamples](evidence/be3-review.md#independent-re-review-and-fixes-after-aw-325564).

A joint BE-01/02/03 review based on `70bf27f` fixed eight more problems in catalog authorization, conflict scheduling, quota, source intent,
health, queue backlog and reference-worker recovery; see
[joint review and required verification](evidence/be3-review.md#be-010203-joint-review-baseline-70bf27f).
That round passed 24 distinct integration cases, 15 unit cases and 9 worker-transport cases; it did not extend to later batches' acceptance.

## BE-4 / BE-5 local backend delivery (2026-10-13)

This round implemented, tested and committed each item in the order below on `feat/colp-automation`; real dot acceptance is explicitly excluded.
AW-02 uses the evidence already on the branch, does not repeat remote operations, and does not stretch the old spike result into production-adapter acceptance.

| Task | Status this round | Commit / evidence |
| --- | --- | --- |
| AW-02 | Existing spike; real dot not re-run this round | [existing evidence](evidence/aw-02.md) |
| AW-27 | Done locally | `1e2c40a`, [protocol and durable subscriptions](evidence/aw-27.md) |
| AW-28 | Done locally | `662044e`, [callback verification and signing encryption](evidence/aw-28.md) |
| AW-29 | Done locally | `20b7880`, [durable delivery](evidence/aw-29.md) |
| AW-44 | Done locally | `e3a98de`, [retention, recovery, load](evidence/aw-44.md) |
| AW-46 | Local protocol/database lifecycle done; real host gate retained | `9a282b5`, [lifecycle](evidence/aw-46.md) |
| AW-41 | Done locally | `015b3bb`, [immutable run-once](evidence/aw-41.md) |
| AW-57 | Done locally | `1133a94`, [exact count batches](evidence/aw-57.md) |
| AW-58 | Done locally | `e712f4e`, [outputs and unread state](evidence/aw-58.md) |

The final cross-check and regression results are in the [BE-4/5 close-out record](evidence/be45-review.md).
Web, extension, model-provider calls, the real dot lifecycle and remote publishing are outside this round's delivery.

## Post-review fixes (2026-10-13)

A review of BE-1..BE-5 found high, medium, code, test, documentation and low-severity issues;
each fix is a separate commit. The [post-review record](evidence/post-review-fixes.md) maps every
finding to its commit, lists the earlier R1–R16 round, and gives the reasons for the findings
left unchanged.

## AC-39 capacity follow-up (2026-10-14 UTC)

The s2 load experiment **failed saving availability** at 100 run-once members.
See [AC-39 evidence](evidence/ac-39.md) for the environment, raw measurements,
concurrency controls and unexecuted scope. This does not extend the backend
delivery claims into release acceptance or authorize larger capacity defaults.

The subsequent [local small-workload optimization](evidence/ac-39-local-optimization.md)
records before/after measurements and passing rollback, authority and worker
regressions. The [s2 re-verification of `75d921c`](evidence/ac-39-s2-reverification.md)
passed rule scaling and finite queue recovery, but both 100-member manual saving
scenarios still failed. AC-39 remains failed; the reduced manual query count has
not resolved the long collection-lock hold.

The subsequent [canonical SQL optimization and s2 test](evidence/ac-39-canonical-sql.md)
(`1c168ad`) reduced the single-save 100-member run from 12.87 to 10.57 seconds and
queries from 4368 to 3568. Same-collection saving still timed out, and burst saving
still failed. Rule scaling passed; queue recovery completed all 51 jobs, but save
p95 was 1.10 seconds and failed its 1-second limit. **AC-39 remains failed.**

The [bounded manual continuation follow-up](evidence/ac-39-manual-continuation.md)
(`f64a546`) commits large selections in resumable slices, as authorized by the Owner.
Final s2 100-member verification completed all placements and all 60 concurrent
saves without errors; same-collection save p95 was 3.366 seconds and still failed
the latency gate. **AC-39 remains open.** Start returns before completion for large
runs, and completed effects are retained on interruption. Larger final capacity
and complete dispatcher acceptance remain unverified.
