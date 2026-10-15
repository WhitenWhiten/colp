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

## Web delivery on `main` (2026-10-14)

Each web task is committed separately. The commit column is filled in by the next task's commit.

| Task | Status | Commit / evidence |
| --- | --- | --- |
| AW-12 | Done locally (mocked API; no hosted run) | `979dd9e`, [Automations page, editor, preview, bookmark history](evidence/aw-12.md) |
| AW-34 | Done locally (mocked API; no hosted run) | `db0f7e3`, [rule and run pages, waiting work, allowance](evidence/aw-34.md) |
| AW-52 | Done locally (mocked API; no hosted run) | `5e410ac`, [automation plan approvals and effect-specific Undo](evidence/aw-52.md) |
| AW-53 | Done locally (mocked API; no hosted run) | `c549fb9`, [agent opt-ins, worker pairing, connection guide](evidence/aw-53.md) |
| AW-45 | Done locally (mocked API; no hosted run) | `5b45543`, [Digests and run text output](evidence/aw-45.md) |
| AW-59 | Done locally (mocked API; no hosted run) | `f35d610`, [run-once preview and explicit start](evidence/aw-59.md) |

## Extension delivery on `main` (2026-10-14)

Each extension task is committed separately. The commit column is filled in by the next task's commit.

| Task | Status | Commit / evidence |
| --- | --- | --- |
| AW-49 | Done locally (unit tests, xvfb screenshots with stubbed messages; no real server run) | `921a7ef`, [bundle installation and binding projection](evidence/aw-49.md) |
| AW-50 | Done locally (unit tests with server golden digests, xvfb screenshots; no real server run) | `0cf80c3`, [canonical-only placement receipts](evidence/aw-50.md) |
| AW-19 | Done locally (unit tests on every save path, xvfb screenshots with stubbed messages; AC-01/02/04 not run in a real browser) | `635ca19`, [pre-save rule path](evidence/aw-19.md) |
| AW-20 | Done locally (unit tests, real Chromium under xvfb for AC-09/AC-49 and projection echo; server-side intake join not run) | `06c3ba9`, [observed creates and echo suppression](evidence/aw-20.md) |
| AW-21 | Done locally (unit tests, local-first lifecycle suite, real Chromium under xvfb for AC-10 across worker kill and browser restart; server-side join not run) | `81abe4c`, [durable rule and receipt lifecycle](evidence/aw-21.md) |
| AW-54 | Done locally (unit tests against contract-valid DTOs, happy-dom pane tests, xvfb screenshots in en and zh_CN; no live server read) | `2b42346`, [server run status, apart from placement](evidence/aw-54.md) |
| AW-60 | Done locally (unit tests for the projection, badge ownership and popup line; xvfb screenshots; AW-20/21 e2e re-run; badge not run against a live server) | `39e557f`, [digest unread indicator and navigation](evidence/aw-60.md) |

## Browser rules on `main` (2026-10-14)

Q7 was decided by the owner: rules made in the extension work with no server, below the account's rules
(design [01 §7.5](design/01-architecture.md#75-browser-rules-adr-a24-au-34), ADR-A24, AU-34).
Each packet is committed separately; the commit column is filled in by the next packet's commit.

| Task | Status | Commit / evidence |
| --- | --- | --- |
| AW-67 | Done locally (unit and worker tests; production bundle checked; no Options UI or real browser yet) | `5998368e`, [browser rules at save, below the account's](evidence/aw-67.md) |
| AW-68 | Done locally (happy-dom pane tests; real Chromium under xvfb for AC-69 with no server; screenshots in en and zh_CN) | `c1168c59`, [write and manage browser rules in Options](evidence/aw-68.md) |
| AW-69 | Done locally (unit, worker and pane tests against the server's bundle shape; screenshots; no real server run) | `e0ad3583`, [review browser rules against the account's](evidence/aw-69.md) |
| AW-70 | Done locally (mocked API; no hosted run) | `f4057029`, [fill the web rule editor from a browser rule](evidence/aw-70.md) |
| AW-71 | Done locally (unit, worker and pane tests; bundle install retires a moved rule in the worker test; no real server round trip) | `d0d7a229`, [move a browser rule to the account](evidence/aw-71.md) |
| AW-72 | Done locally (the real logout handler over fake-indexeddb; no real browser sign-out run) | [disconnect keeps browser rules](evidence/aw-72.md) |
