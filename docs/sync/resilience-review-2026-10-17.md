# Sync resilience review remediation — 2026-10-17

Baseline: `1c50c49502a453436e2fe1653e6abbf56630f828`; clean worktree on entry.
Reviewed implementation: `ea61d74b` through `1c50c495` (H1–H4, C0–C4, P1, P2).
The eight supplied reproductions all failed before repair. Their scenarios are
now covered in permanent tests, with native recapture and actual replica rotation
replacing the original projection-only release and success-only rebuild mocks.

| Review item | Repair commit | Behavior and targeted evidence |
|---|---|---|
| Shared foundation | `a9553599` | Shared durable issue roots and bounded ancestry; 3 initial issue tests. |
| 1 | `fb486718` | Per-member remote delete retains Pull/upload/local/native-wait issue closures and necessary ancestors, deletes independent members, preserves exclusions and virtual tombstone mappings; 7 protection and 25 delete-policy/recovery/content tests. |
| 2 | `eb8cdac8` | Started/observed/uncertain native calls cannot be committed as unapplied; repository rejects existing native evidence or pending authority writes; 17 mutation-boundary/Pull/delete recovery tests. |
| 3 | `4a10d05d` | Fresh native identity/content/placement/privacy/permission checks; new tail identities, sequence, digest and idempotency; atomic dependency/provisional-map rebinding; 14 initial native/strict-lane/conflict/queue tests. Final integration also rejects circular identity proof from an originally unproven reservation and isolates individual recapture failures. |
| 4 | `0e0105de` | Unfrozen issues offer v1 Rebuild in web and Status; execution rechecks, confirms and archives before actual replica rotation; 31 extension and 22 web UI tests. |
| 5 | `4541f871` | Existing multi-level descendants, source/destination move relationships and cross-direction issues share closure; independent siblings continue; 24 initial closure/queue/conflict/delete tests. |
| 6 | `c7f1ee54` | Classifier-controlled staging of missing anchors; forward-created dependencies and page integrity remain rejected; 125 then-current Pull/classifier/contract tests. |
| 7 | `73080f38` | Exact final UTF-8 JSON budget, deterministic issue prefix, true total, preserved state/results; shared generated limits and independent server body limit; 12 extension and 3 server route tests. |
| 8 | `31750a25` | Persistent scope-separated final reports/results; same-body retry after response loss, refreshed matching credentials, real archive-based interrupted Rebuild completion; 18 health/rotation/outbox/budget tests. |
| 9 | `adbe0759` | Installation possession plus current credential/epoch, transactionally checked before reports/delivery/settlement; prevents Session-based proof minting by another device credential; 3 PostgreSQL HTTP integration tests, 23 server unit tests, 48 extension credential/session/outbox tests. |
| 10 | `ec953d06` | Typed local failure emissions and explicit role registration; TypeScript syntax audit of over 250 actual sync/store constructor codes; no broad prefix item privilege, no subjectless item class or fictional retry bound. Pull/engine/health and push/recovery targeted suites, plus Snapshot recheck. |
| 11 | This commit | Shared open-issue facts now also project live ingress parks and blocked Pull pages. Status, health, repair, upload/deletion protection consume the same semantics; stale diagnostics and recaptured history are closed. Completes browser entrypoint, retained account-scoped report-proof and recapture consistency checks, including missing subtree-root mappings and ancestor exclusions. |

## Final rules

`readOpenSyncIssues` is the common issue projection. Queue set-aside rows,
server rejections, consumed conflicts, unresolved Pull/local records, live native
confirmation waits, parked ingress events with a still-pending source, and blocked
Pull pages are open. Processed/reopened ingress markers and `recaptured` rejected
rows are history. Historical diagnostic rows alone do not reopen an issue.

An issue protects its target, existing descendants and operations placed under it.
Moves consider the existing target ancestry and destination, and upload records
retain source-parent evidence. Missing intermediate ancestry, cycles or more than
256 hops cannot prove independence. Siblings with a proven independent chain
continue. Local ancestor deletions are held. Remote deletion uses the fixed member
ledger: protected members and needed ancestors remain; allowed siblings are
processed. Native survivors receive exclusions and virtual tombstone mappings; unmapped necessary native ancestors are excluded as well, without inventing a remote/native identity;
issue evidence survives remote tombstones until explicit repair/Rebuild.

A browser call that started is never assumed unapplied, including first attempts,
retries and restarted workers. Completed delete-member ledgers and create/update
receipts retain their original recovery path. A direct set-aside commit refuses
pending mappings, observations, deletes or native evidence.

Release requires a new native capture. Old operation bytes remain refused history;
new operation IDs, sequences, digests and idempotency keys enter the tail. Retiring a deleted/out-of-range create also removes its dangling provisional mapping while keeping audit evidence. Unsent
references and provisional identities rebind atomically; the existing proven gap
realignment closes vacated slots. A deleted/out-of-scope create produces no stale
upload. An originally unproven identity cannot prove itself by its own provisional
mapping; v1 Rebuild remains its safe exit. Failed automatic recapture stays held
without preventing unrelated dependants from being recaptured.

Device authorization is documented in
[the server authority design](../../packages/server/docs/sync-replica-health-authority.md).
A fresh matching credential plus an opaque server-issued possession proof is
required. Proofs bind device/profile/generation/epoch and survive token/Session
expiry. No report issues a Session or changes lease, last-seen, cursor or checkpoint.
The old replica's final report uses its own proof. A switched account cannot read
or send it; fresh matching authority can resume delivery after switching back.
Final reports and command deduplication evidence persist for eight days, covering
the seven-day server command lifetime. Proofs are bearer capabilities, not hardware
attestation.

## Verification and boundaries

Permanent review suites include `sync-delete-issue-protection`,
`pull-mutation-failure-boundary`, `queue-native-recapture`, `pull-issue-rebuild`,
`pull-issue-status-ui`, `issue-dependency-closure`, `pull-missing-anchor-staging`,
`replica-health-byte-budget`, `replica-health-outbox`, `replica-report-proof`,
`unified-sync-issues` and `sync-failure-class`. Existing affected queue, Pull,
recovery, Status, engine, server route and web Sync tests were run as needed.

The final review-focused run passed 83 tests in 19 files; a further 198 affected
engine/Pull/push/recovery tests passed in eight files. The additional missing-root
delete scenario and its policy/recovery regressions were subsequently verified.

Final artifact checks include extension development/production builds, extension
and web typechecks, server build (including the new migration), generated-limit
consistency, migration order, changed extension source lint and i18n checks.
The PostgreSQL tests used disposable PostgreSQL 16 containers; test HTTP servers
and containers were closed by their fixtures/wrappers. No dev server was started.
No Playwright/E2E process was run, so no combined real-browser/live-server web →
extension → server E2E completion is claimed. Actual IDB archives and replica
switches are exercised across extension modules, and actual server authorization,
command settlement and unchanged authority fields are tested in PostgreSQL.

P3 (bounded circuit breaker) and P4 (protocol/conformance completion) remain
unimplemented. Unknown external failures retain the existing retry path; no finite
retry guarantee is claimed. Rebuild is v1: it archives unsent data and opens setup
for a new replica; automatic re-import or v2 single-node repair is not implemented.
The Pull-apply ceiling uses the shared issue total; a separate push-only global
issue-ceiling trigger has not been added or certified by this review.

The requested task document at
`/home/whiten/known/colp-server/15-sync-resilience-2026-10-17.md` is outside any Git
repository. It was updated directly; its changes are not part of this repository's
commits. No repository was created there.
