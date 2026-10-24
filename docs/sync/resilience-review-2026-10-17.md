# Sync resilience review remediation — 2026-10-17

Current acceptance update (2026-10-18, third review): baseline `4299910e` had five
remaining production gaps. They are repaired in five ordered commits plus the
focused cross-check `02567012`. The **Third-review completion** at the end records
current evidence and limits; earlier completion claims are historical.

Current status (2026-10-18): all eight second-review tasks are implemented and
individually committed from the clean `f3612b9d` baseline. The final cross-review
follow-up and current verification receipt are at the end of this document.
The first-review material below is retained as history, not current acceptance.

| Second-review task | Commit | Main production change |
|---|---|---|
| 1 | `2155b7de` | Original authority/scope fences through command delivery, preview and confirm. |
| 2 | `540d7823` | Snapshot retains all unresolved issue closures, identities and anti-upload evidence. |
| 3 | `bdd3913b` | Concrete identity/placement issues isolate locally; old freezes require fresh evidence and CAS. |
| 4 | `aa1daf09` | Durable deletion decisions permit independent later Pull pages and Ack. |
| 5 | `ad735ca7` | Real authoritative effects cross only the conflicts they resolve; release freshly recaptures. |
| 6 | `4c60c6a0` | Subjectful codec isolation at Snapshot and ingress boundaries, with explicit bounded quarantine. |
| 7 | `2dac77d0` | Unified open-fact ceiling (>200), accurate stop reason and started-native recovery. |
| 8 | `6a9ec450` | Browser/live-server Retry/Rebuild closure and production-fed conformance. |

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

P3 (bounded circuit breaker) and P4 (protocol/conformance completion) are now
implemented; the completion evidence follows below. Authority denials and unknown
external failures use the durable breaker and automatic cooldown probes. Rebuild is v1: it archives unsent data and opens setup
for a new replica; automatic re-import or v2 single-node repair is not implemented.
The Pull-apply ceiling uses the shared issue total; a separate push-only global
issue-ceiling trigger has not been added or certified by this review.

The requested task document at
`/home/whiten/known/colp-server/15-sync-resilience-2026-10-17.md` is outside any Git
repository. It was updated directly; its changes are not part of this repository's
commits. No repository was created there.

## P3 — bounded automatic recovery (2026-10-17)

The engine now persists a per-code, sliding thirty-minute denial window across
worker restarts. Five authority denials without logical server-revision or queue-head
progress stop the engine and report the original reason through the existing health
channel. Session cursor capability rotation alone does not reset the counter.
Unknown external codes share a bounded counter so rotating unknown names cannot
hide a loop. Network, 429 and 5xx failures remain transient.

Stopped engines continue health reporting. Automatic probes start after one minute
and double to a thirty-minute ceiling; startup/online wakes cannot bypass that
deadline. Explicit Retry probes immediately. A successful pass or actual progress
clears the breaker; permanent local/integrity stops retain their existing exits.
Writes retain compare-and-swap protection and recovery writes inherit the ledger.

Targeted validation: 105 tests in six engine, health, classifier and CAS files;
extension typecheck, changed-source ESLint and development build. The source-size
check still reports pre-existing overruns in outbound-push-worker.ts (601),
pull-apply-runtime.ts (601) and bookmark-event-repository.ts (610 vs 609); none was
changed by P3. No browser E2E or temporary service was needed.


## P4 — protocol and executable conformance (2026-10-17)

`03-sync.md` now specifies consumed-conflict isolation and fresh recapture, durable
Pull not-applied records and Ack warnings, integrity fail-closed rules, protected
subtree members, and five standard warning codes. The optional COLP 0.2
`syncReplicaHealth` capability describes the existing POST report envelope and
installation-possession authority, unchanged Sync authority, bounded issue totals,
last-writer-wins reports, command expiry/deduplication and durable result delivery.
This intentionally records the deployed POST/body-replicaId shape rather than
introducing the proposal's second PUT route or a nonexistent client reportedAt.

The versioned schema, generated schema modules/types and examples include the
optional endpoint and closed report/command contracts. Older 0.1 schemas stay
unchanged. The capability's schema definition does not claim that the current
server advertises it: the deployed extension still uses its configured helper.

The separate `colp-sync-resilience` CLI/API runs isolated adapter scenarios;
`protocol/sync-resilience-cases.json` maps SYNC-0032–0037 to specification anchors
and production fixtures. Existing extension/IndexedDB tests feed actual conflict,
Pull/Ack, integrity, deletion and command observations into the same verifiers.
The PostgreSQL health fixture verifies installation isolation, warning retention,
last-writer-wins and unchanged lease/last-seen/cursor/checkpoint/lifecycle. Deliberate
regression and malformed-observation cases prove that each verifier fails closed.
Unsupported cases are explicit skips and make the CLI exit nonzero. This optional
suite is separate from bundled reference-package Profile evidence; no existing
Profile certificate or live-browser acceptance is silently expanded.

Targeted validation passed 69 tests: 31 runner/report/CLI tests, 23 schema and
backward-compatibility tests, 14 extension fixture tests, and one PostgreSQL health
integration test (the six unrelated tests in its file were filtered out). Node,
extension and server typechecks passed, as did changed extension test lint,
protocol/generated-type consistency, the Node build and diff checks. Python
example validation could not run because the system Python lacks `referencing`;
the changed script was syntax-checked, and the new wire examples were validated
by the Node schema suite. No Playwright or browser E2E ran. HTTP fixtures and the
disposable PostgreSQL container closed normally.

P2 browser/live-server acceptance and the separate Push-only issue-ceiling
certification remain outside these two completion tasks.

## Second review remediation (baseline f3612b9d, 2026-10-18)

### Task 1 — bind remote commands to their authorized target

Root cause: response handling reused its pre-request health projection and the
runner looked up the global current rebuilder. A delayed A response could rebuild B.
Rebuild preview now carries a digest of the complete scope and authority generation;
confirm checks it against freshly inspected facts. Remote Rebuild also compares
preview with the original scope. The reporter rereads actions inside the engine
lane, whose captured authority/scope is checked after network and queue waits.
Retry and issue recapture use the same fence. Task 8 below completes the engine
pass as `retry_completed`; legacy `retry_scheduled` remains scheduling-only. Interrupted Rebuild
retains the existing archive/outbox delivery path.

Before: all six initial permanent target/action tests failed (wrong replica was
rebuilt, stale action executed). After: 28 tests in replica-command-target,
replica-health-report, replica-rebuild, replica-health-outbox and pull-issue-rebuild
passed. Includes full target changes, authority change, delayed real Rebuild,
redelivery, archive-based restart and response-loss delivery. Extension typecheck
and changed-source/test ESLint passed. No service started.

### Task 2 — Snapshot preserves unresolved evidence

Root causes: overlay protection only read live queue targets; virtual projection
omitted protected identities absent from Snapshot; cutover deleted all Pull/local
issues. Shared bounded issue closure now protects descendants and required
ancestors in projection and transactional mapping cutover, including rejected
uploads and ingress/native waits. Missing Snapshot identities retain mappings and
anti-upload exclusions. Unresolved native wait evidence survives cutover; blocked
page subjects become durable Pull issues before obsolete page bookkeeping retires.
Resumed delete intents reread protection and retain their original recovery state.
Finalize allows extra identities only when existing issue evidence proves protection.

Before: both supplied Snapshot reproductions failed against production modules.
After: six permanent real-Pull/Snapshot regressions pass, including ordinary and
virtual cutover, IDB reopen before projection/commit, local folder descendants,
independent siblings and an already executing delete intent. The six affected
Snapshot/delete/Rebuild suites passed 64 tests; the final issue-helper check passed
11 tests. Typecheck and changed-file ESLint passed. Explicit Rebuild still archives
old evidence and creates a clean new replica (pull-issue-rebuild tests).

### Task 3 — localize mapped identity and placement failures

Root cause: recovery and reconciliation emitted subjectless identity freezes and
the engine's old gate could never re-enter recovery. Fresh native reads now record
concrete local subjects for observed absence or ambiguous ID responses. Permission,
managed and transient/empty API reads retain their own failure semantics. Shared
issue closure holds dependent work; reconciliation cannot infer a delete for an
identity already under protection. Pre-native Snapshot content/placement identity
checks carry subjects and retain retryable intents while independent projection
continues. Unknown/started native calls keep their original recovery path.

Old mapped-identity freezes can hand back to authority recovery only after fresh
reads identify missing/ambiguous subjects and an IDB transaction checks the engine
revision, complete mapping digest and durable issue facts. Other corruption codes
and unknown projection owners are not released. The previous local-save receipt
migration remains intact.

Before: the new real-module regression threw recovery_identity_unproven before
independent Pull could run. After: eight affected suites passed 86 tests, including
concrete missing/ambiguous identities, real independent Pull, worker reopen, old
freeze wake, permission rejection, existing placement/native recovery and classifier
checks. Typecheck and changed-file lint passed. Existing tests that expected the
old permanent identity freeze were corrected; empty API reads now retain the
projection owner and can retry instead of falsely asserting identity loss.

### Task 4 — pending remote deletion is independent of Pull progress

Root cause: awaiting_confirmation was both the decision ledger and a global page/
engine barrier; health never projected remote-delete decisions. Validated remote
deletes and their dependent events now retain separate durable deferral bindings.
Page completion accounts for those facts without claiming native application;
subsequent pages and Ack continue. Deferred events retain their page/effect/native
identity evidence across pruning, Snapshot and restart. User decisions resume the
original native executor; detached completion publishes its mapping facts without
rewinding cursors or stale parent baselines. Restore's own bound operation can
cross its decision hold, while independent issues still protect the target.

The same open decision facts feed Status, health, Snapshot/deletion and queue
protection. Local Keep/Delete/Restore controls retain their CAS/generation checks;
health shows remote_delete_confirmation_required and a repair exit.

Before: supplied real-engine regression requested only one page and reported
syncing/zero issues. After: two permanent real-engine/two-page regressions prove
unrelated create, related restore hold, both Acks, accurate Status/health, decision
execution, deferred restore convergence, pruning and worker/IDB restart. Existing
same-page tests now require the advanced cursor. Ten affected suites passed 44
tests; typecheck and changed-file lint passed. No service started.

### Task 5 — authoritative conflict effects can resolve their own holds

Root cause: the Pull dependency check treated the conflict and all its derived
holds as unrelated open problems. It therefore set the resolution effect aside
before applying it; the old fixture bypassed that stage with authority_committed.
Receipt-validated resolution bindings now identify only the consumed conflicts
and derived conflict holds the effect supersedes. The ordinary issue projection
still includes independent local/Pull/upload/deletion problems. The same receipt
validation is used at settlement, including already-terminal redelivery.

Replaced push-conflict-hold's synthetic completion with real Push worker, real
Pull stager/applier and IndexedDB. Both original scenarios failed with
parent_set_aside before the fix. All five scenarios now pass, including separate
open-fact/effect pages, later resolved facts, IDB reopen and an independent local
issue on the same target. Release rereads native state and authors new opId,
sequence, digest and idempotency identity; old bytes remain recaptured history.
The retained authoritative content observation supplies the new upload base.
Five affected suites passed 20 tests; typecheck and changed-file lint passed.

### Task 6 — subjectful codec isolation across Snapshot and local ingress

Root cause: Snapshot validated the entire record without an item handler; ingress
could fail before creating durable event evidence. Mapping, queue and ingress codec
emissions now carry actual subjects. Snapshot validates stream/graph identities
before isolating content failures. It retains a bounded, explicitly quarantined
remote identity sidecar with the original payload digest and graph edges, never a
claimed native identity or invented content baseline. Atomic staging creates the
Pull issue; dependent projection remains blocked while independent branches apply.
Ordinary Snapshot does not clear that issue. Local pre-write codec isolation saves
its native subject, evidence digest and anti-upload exclusion atomically.

Before: real-engine Snapshot regression entered error; restoring the old ingress
module made the permanent 8-KiB codec-boundary regression fail record_too_large.
After: 110 tests in ten affected suites passed. Dedicated tests cover large title
and description, blocked descendants, independent native projection, staging crash/
IDB reopen, another real engine recovery of the same bad content, bounded evidence,
actual mapping/queue/ingress emissions, and graph-integrity rejection. Typecheck
and changed-file ESLint passed. Existing started native mutation recovery is
preserved; only failures proved to precede a native call are isolated.

### Task 7 — unified global open-issue ceiling

The admission limit is now strictly more than 200 open facts from the common
projection, including Push-only, local-only, Pull, waits, decisions and mixtures.
Engine entry/restart, Push admission/settlement, Pull event/page completion and
Snapshot projection check the same total. The crossing item is persisted first;
no extra Pull issue is needed to trigger the stop. Repeated subjects and resolved/
recaptured history follow the common ledger semantics. Health and Status report
sync_issue_ceiling with an accurate explanation and the existing v1 Rebuild exit.

A ceiling stop preserves projection ownership and pending native evidence. A
limited recovery pass may finish only already-started native calls and publish
already-accounted facts; it cannot admit the next staged mutation. Existing
integrity stops retain their stronger original reason. Dropping below the limit
removes only this admission stop, retaining Snapshot/native recovery work.

Before: all three new local/Push/mixed restart cases failed without the ceiling.
After: the review run passed 155 tests in ten relevant files; subsequent fact/
health/native-recovery checks passed 96 tests and final native-boundary checks
passed 14 tests. Includes exactly 200 vs 201, repeated subjects, 201 real Pull
issues, pure Push/local/mixed, Status/health, restart, closed recapture history and
a real interrupted Chrome call with the next mutation still staged. Web reason
projection passed its targeted test. Extension/web typechecks and changed-file
lint passed. Relevant responsibilities were extracted from large engine/Push/Pull/
ingress files: all 665 production files pass source-size checks, with zero remaining
grandfathered oversize exceptions. No temporary service started.

### Task 8 — real browser/server acceptance and executable conformance

Added `mv3-sync-resilience.spec.ts`. It uses Chromium under xvfb, real native
bookmark events, the production first-run UI (no fabricated mappings), real TLS
Fastify routes, Better Auth, PostgreSQL command/health storage, and the built web
Sync center. The only injected failures are an authority denial, a dropped HTTP
response after server settlement, and a held command response; no success response
or final client state is fabricated. The evidence entrypoint only forces the real
health scheduler to report immediately.

Final browser command (from packages/extension):
`node ../server/scripts/with-postgres.mjs -- node scripts/with-xvfb.mjs npx playwright test e2e/mv3-sync-resilience.spec.ts`
Result: **2 passed, 54.6 s**. Web Retry → extension execution → server receipt →
Sync-center result survives a lost response and browser/profile restart. Pending
delete → unrelated upload continues. Placement anchored to the pending deletion
stays held. A delayed web Rebuild rejects the locally replaced target and reports
failure under the archived original replica, without resetting the replacement.
A subsequent normal web Rebuild archives, rotates and displays setup-required;
bookmarks remain native and setup is chosen/reviewed through the actual UI.

The live test exposed a real missed dependency: a create anchored after a
pending-deletion sibling repeatedly received position_context_stale. Anchors now
participate in the shared queue/Pull dependency check. Its permanent capture test
failed pending vs set_aside before repair. Another permanent test proved that a
local Rebuild during HTTP wait previously lost the stale command's result; its
actual archive now enables final delivery. Retry now completes its checked engine
pass in the serialized command context; its result says retry_completed. Legacy
retry_scheduled UI explicitly describes scheduling only. A rejected command remains
visible alongside an independent local reset. Snapshot Ack now warns about its
explicitly quarantined, unapplied subjects.

Conformance adds SYNC-0038–0043, each fed by actual permanent production-module
regressions. SYNC-0032 now requires the real authoritative effect receipt instead
of a synthetic precommitted conflict fact. The runner's separate malformed/
regression tests passed 17 cases. Twelve extension fixture suites passed 57 tests;
web Sync/result semantics passed 24 tests. Extension typecheck, web production
build/typecheck, changed-file lint, i18n, source-size and diff checks passed.
All test HTTP servers, browsers/profiles and disposable PostgreSQL containers
closed. No development server was started and nothing was pushed remotely.

### Final cross-review follow-up (commit containing this section)

Cross-review found and repaired five additional connection failures. Each new
behavior regression was observed failing before its repair:

- Pending Rebuild resume adopted the current generation instead of verifying the
  journal's original or precisely registered replacement generation. It now also
  rechecks the journal's authority fence before retirement. A response explicitly
  naming another replica is rejected before result settlement or command execution.
  Both permanent target tests failed by executing/adopting the wrong authority.
- A real native create interrupted after Chrome mutation, before evidence commit,
  has no live mapping. Snapshot previously created a second copy. Protection now
  combines complete old/incoming graphs; staging, projection, finalize and commit
  keep the original wait and identity, create only the independent node, and do not
  synthesize successful native evidence. The regression counted two creates where
  only one independent create was permitted (and three after full cutover).
- A deletion parked immediately before page completion could survive Snapshot but
  later delete only Chrome, leaving its mapping behind. Snapshot now marks the old
  page as accounted by this cutover, retaining pending event/decision/native facts.
  Detached decision publication removes the mapping without changing the newer
  cursor. The real Pull + interrupted completion + Snapshot + user Apply test
  failed with the old mapping still present before repair.
- Retaining an issue-held local placement exposed a second graph interpretation:
  independent work was overprotected, then a following wake rejected the preserved
  mapping as snapshot_graph_incomplete. Canonical Snapshot graph structure and
  parent revisions are now retained separately from local protected placement.
  Validation allows only issue-backed retention with matching native identity and
  projection digest; full remote graph, kind and cycle checks remain mandatory.
  Held intents retain their records while independent work can own projection.
  The real-engine regression failed first on independent folder content, then on
  the next startup freeze; both now pass.

The final identity regression additionally combines observed absence or ambiguous
lookup, a real independent Pull effect, actual native content capture/queue commit,
then the real Push worker reaching dispatch. Restoring the exact pre-task-3
production identity-freeze branch made both composed regressions fail with
recovery_identity_unproven; restoring the fix passed all 8 identity tests.
Its deliberately failing transport
proves upload admission and retained attempt evidence; it does not claim successful
server application. The separate browser/live-server scenario proves actual
independent upload completion. No success mock or final-state injection is used
to certify either boundary. The Pure-Push ceiling fixture uses one production
batch transaction for 201 holds, avoiding quadratic test setup without weakening
any count/threshold/restart assertions.

Final verification commands (relative to packages/extension unless stated):

```sh
npx vitest run tests/replica-command-target.test.ts tests/replica-rebuild.test.ts tests/replica-health-outbox.test.ts tests/replica-health-report.test.ts tests/snapshot-issue-preservation.test.ts tests/snapshot-existing-native-placement.test.ts tests/snapshot-existing-native-content.test.ts tests/snapshot-codec-isolation.test.ts tests/recovery-store.test.ts tests/recovery-overlay.test.ts tests/recovery-projection-executor.test.ts tests/recovery-projection-siblings.test.ts tests/local-projection-recovery.test.ts tests/identity-item-recovery.test.ts tests/local-save-freeze-recovery.test.ts tests/remote-delete-page-progress.test.ts tests/remote-delete-policy.test.ts tests/srg-t02-native-executor.test.ts tests/issue-anchor-dependency.test.ts tests/issue-dependency-closure.test.ts tests/push-conflict-hold.test.ts tests/queue-native-recapture.test.ts tests/pull-mutation-failure-boundary.test.ts tests/global-issue-ceiling.test.ts tests/codec-subject-emission.test.ts tests/local-codec-isolation.test.ts tests/unified-sync-issues.test.ts tests/sync-failure-class.test.ts tests/durable-sync-engine-bootstrap.test.ts tests/durable-sync-engine.test.ts
npx vitest run tests/identity-item-recovery.test.ts
npm run build -- --config config/e2e-fixture.json
node ../server/scripts/with-postgres.mjs -- node scripts/with-xvfb.mjs npx playwright test e2e/mv3-sync-resilience.spec.ts
npm run build
npm run build:development
node scripts/verify-release-artifact.mjs dist/production
npm run typecheck
npm run check:source-size
npm run check:i18n
# packages/web:
npx vitest run src/pages/Sync.test.tsx src/pages/sync/health-reasons.test.ts
# packages/conformance:
node --test test/sync-resilience.test.mjs
```

Receipt: 30 relevant extension files passed 299 tests. The strengthened identity
suite subsequently passed all 8 tests (one additional absence/ambiguity case).
The final xvfb Chromium + TLS Fastify/Better Auth + disposable PostgreSQL run
passed both live-server tests, **2 passed (1.0m)**. Web tests passed 24; conformance
runner passed 17. Extension typecheck and changed-file ESLint passed. Default
production and development builds passed; release artifact scan passed (36 files,
no source maps/secrets/test fixture inclusion). All 665 production source files
pass source-size with zero exceptions; i18n and git diff checks passed. The task-8
web production build/typecheck also passed. Only relevant tests were run.

Evidence-based goals:

| Goal | Judgment and evidence |
|---|---|
| G1 visibility | Met for reviewed paths: shared open facts feed Status/health/Sync center; two-page pending deletion, quarantine warnings, ceiling reason and real command results are asserted. |
| G2 local isolation | Met for concrete reviewed subjects: independent Pull, capture/Push dispatch, live upload and Snapshot siblings continue; self-resolution crosses only its own conflict. |
| G3 usable exit | Met within v1: decision Keep/Delete/Restore, fresh recapture and Retry run the real executors; browser Rebuild archives/rotates and requires reviewed setup. Old identity gates have evidence/CAS recovery. |
| G4 data protection | Met for reviewed recovery boundaries: issues/mappings/exclusions survive ordinary Snapshot/restart; ambiguous or started native calls retain evidence; commands fence target/authority; stream/graph integrity still fails closed. |

Limits: this certifies the named scenarios and real paths, not every fault timing
or all browsers. Rebuild retains v1 semantics: archive unsynchronized data and
enter setup for a new replica; it does not silently re-import the archive or claim
sync restoration. Retry completion means its checked engine pass finished, not
that all open issues were solved. Reporting requires connectivity. Permissions,
unknown native outcomes and genuine replica/stream corruption retain their
specific recovery/stop semantics. No remote push was performed. The test-created
HTTP servers, browsers/profiles and disposable databases were closed; existing
user services were left untouched. The supplied original reproduction directory
was preserved. The external plan is updated directly, without creating a Git repo.


## Third-review completion — five resilience gaps (2026-10-18)

This receipt supersedes the earlier broad “G2 met” judgment for baseline `4299910e`.
That baseline still had all six counterexamples described in
`/tmp/colp-sync-review-20261018-4d8f_okz/reproduction.log`. The five source tests and
`reproduce.sh` were read and preserved. Acceptance now uses permanent repository
tests, with no runtime dependency on those temporary files.

Work began at `4299910edf172b6dc37d146dd36b4aa3a3fe92ff` with an empty worktree.
All five repairs were implemented, checked and committed in the requested order
in `/home/whiten/known/colp`, before starting the next repair. Other work concurrently
committed web changes in this same worktree; those changes were preserved and are
not attributed to this remediation.

| Item | Production repair and commit | Permanent acceptance |
|---|---|---|
| 1 — settled conflict holds were unreachable | `ed26398e`: after Pull the engine also schedules the real Push worker for an empty lane with held uploads. The worker supplies fresh native recapture; the settled-release API requires that capability. Old history remains, and fresh operations get new identities, sequences, digests and idempotency keys. | `push-conflict-hold.test.ts`: real engine + worker + applier + IDB; engine itself pulls the resolution; close/reopen, no unrelated edit or manual recovery drain; another conflict remains held, an independent local issue prevents self-release, unrelated Pull still applies. Existing fresh-capture/strict-sequence tests remain. Initial item check: 5 files / 93 tests passed. |
| 2 — one unknown Chrome result stopped later pages | `a67bc9ad`: typed native-result versus remote-delete deferrals retain original event/page/intent/generation and native evidence. Only verified durable bindings permit page accounting; unknown calls remain unknown. Dependents defer under the original intent and resume after confirmation. Parked invocation correlation no longer blocks an independent identical create. Pruning and Snapshot preserve the evidence chain. | `native-wait-page-progress.test.ts`: Chrome mutation then interruption before evidence, IDB reopen, same-page and later-page work/Ack, descendant and grandchild/anchor/delete protection, no automatic duplicate create, Status/health, confirmation through real engine wakes. `snapshot-issue-preservation.test.ts`: ordinary Snapshot and pruning retain the original wait. Initial item check: 8 files / 56 tests passed. |
| 3 — repeated corrupt Snapshot retried forever and reported syncing | `2d2ed8c5`: replica integrity refresh remains fail-closed, counts across worker restarts, stops automatic probes after five failures, and offers explicit Retry/Rebuild. An ordinary active Session cannot bypass an unresolved integrity failure. A valid Snapshot clears the freeze, counter and old recovery code. Status and health retain the cause; Sync center explains Snapshot integrity failures. | `snapshot-integrity-stop.test.ts`: repeated real-engine malformed responses, durable bound, startup/online/alarm after a day do not probe, health still sends while stopped, explicit valid recovery succeeds. Existing authority cooldown, transient and normal Snapshot tests pass. Initial item check: 45 extension tests, 3 web reason tests; additional Status checks passed. |
| 4 — identity replacement rewrote user text | `f5ee7a12`: schema-specific rebinding for operation target/base/dependencies and create/move/restore/reorder identity fields, plus explicit mapping identity/revision fields. User content and native IDs are retained; sent attempts remain immutable. The related ingress token resolver now accepts scalar identities rather than recursively rewriting data. | `queue-recapture-content.test.ts`, `queue-identity-rebind.test.ts`, `queue-native-recapture.test.ts`: independent and related text equal to old identities, mapping content/digest retention, correct references and queue digest, unchanged sent attempt, actual IDB constraint abort rolls back queue/mappings/evidence/sequence allocation. Item check: 6 files / 27 tests passed. |
| 5 — malformed HTTP 200 consumed command results | `50b3b22f`: ordinary and final reports share bounded strict receipt validation (16 KiB, 10 s default body deadline), required replica/revision/accepted/command fields and valid command structures. Accepted reports must echo the submitted revision; `accepted=false` requires a current revision at least as new, and still receipts command results per server semantics. Unconfirmed final reports no longer expire. | `replica-health-receipt.test.ts`: malformed/empty/truncated/HTML, missing fields, wrong target/revision, illegal fields/commands, oversized and stalled body; ordinary results survive restart and valid stale-revision settlement. Actual Rebuild rotates the replica; invalid final receipts survive reporter/IDB restart and nine days; identical final body retransmits until valid receipt; no duplicate command execution. Existing account isolation/fresh credential/archive recovery tests pass. Item check: 7 files / 57 tests passed. |

### Focused cross-check and follow-up

`02567012` fixes an associated failure observed in a new regression: confirming an
old native create after a newer Snapshot overwrote the newer mapping revision with
the old event revision. Confirmation now retains mapping metadata and the original
create identity, then uses current Snapshot authority and the existing native
content/placement barriers. Parent baselines and the advanced cursor do not rewind.
A crash after the native content update is recovered by verifying its post-state;
the test proves one create and one update, including reopen.

The follow-up also enrolls legacy persisted unknown waits using their real
intent/event/generation facts, preserves a durable issue when the user declines
placement (closing a prompt does not establish an unknown call's result), and
corrects English/Chinese Status copy to describe only related items as held.
The engine conflict tests now fetch the actual resolution within the wake and
exercise the unrelated/conflict/independent-issue paths. No authority-committed
success state is injected to certify these paths.

### Final focused verification

From `packages/extension`, the final command was:

```sh
npx vitest run tests/push-conflict-hold.test.ts tests/push-item-hold.test.ts tests/queue-native-recapture.test.ts tests/queue-recapture-content.test.ts tests/queue-identity-rebind.test.ts tests/sync-state-store-set-aside.test.ts tests/bookmark-event-resolve.test.ts tests/native-wait-page-progress.test.ts tests/srg-t02-native-executor.test.ts tests/sw-native-wait-routing.test.ts tests/native-wait-ui.test.ts tests/native-wait-view.test.ts tests/remote-delete-page-progress.test.ts tests/pull-workset-reads.test.ts tests/pull-history-prune.test.ts tests/pull-mutation-failure-boundary.test.ts tests/snapshot-issue-preservation.test.ts tests/snapshot-existing-native-content.test.ts tests/snapshot-existing-native-placement.test.ts tests/recovery-store.test.ts tests/snapshot-integrity-stop.test.ts tests/sync-circuit-breaker.test.ts tests/sync-failure-class.test.ts tests/sync-attention-ui.test.ts tests/replica-health-receipt.test.ts tests/replica-health-report.test.ts tests/replica-health-outbox.test.ts tests/replica-health-byte-budget.test.ts tests/replica-command-target.test.ts tests/durable-sync-engine.test.ts tests/durable-sync-engine-bootstrap.test.ts tests/global-issue-ceiling.test.ts
npm run typecheck
npm run check:source-size
npm run check:i18n
```

Result: **32 files / 277 tests passed**; extension typecheck passed; source-size
checked **670 production files with zero exceptions**; i18n catalog and Chinese
translations current. Changed extension TypeScript files passed ESLint, including
the new modules and strengthened tests. `git diff --check` passed.

From `packages/web`:

```sh
npx vitest run src/pages/Sync.test.tsx src/pages/sync/health-reasons.test.ts
npm run typecheck
npx eslint src/pages/sync/health.tsx src/pages/sync/health-reasons.test.ts
```

Result: **2 files / 25 tests passed**; typecheck and changed-file lint passed.
These are related module/IDB/native API substitute tests; no browser E2E or live
server/database test was run for this receipt. Historical browser receipts above
remain historical and are not claimed as rerun evidence.

### Current boundaries and remaining limits

- The five named gaps have production repairs and permanent behavior tests. No
  known item-specific global Pull barrier remains in these reviewed paths: native
  waits, deletion decisions, bad content and conflict closures hold their actual
  dependencies while independent work proceeds. Declining an uncertain placement
  preserves an item issue and evidence, with the existing v1 repair exit.
- Push can skip unsent held work, but an **already-sent operation with an unknown
  server result** retains its exact attempt and sequence until settlement. That
  ordered-lane barrier is required by protocol identity/sequence safety; the
  client does not pretend the call was not sent or allocate around it.
- Genuine stream/Snapshot/graph corruption remains a global fail-closed stop.
  Integrity refresh is bounded and requires an explicit probe after tripping;
  unrecoverable local integrity/identity damage and the >200 open-fact ceiling
  retain their documented stop/repair semantics. Invalid deferral authority is
  not accepted as proof that advancing a page is safe.
- This receipt certifies the named crash boundaries and composed production paths,
  not every fault timing or browser. Reports still require network/authentication.
  Rebuild archives unsynchronized evidence and enters setup for a new replica;
  it does not silently restore sync or re-import the archive. Explicit “Keep both”
  authorizes a fresh native create; unknown results are never recreated automatically.
- No temporary service, browser or external database was started by this task.
  Existing services and concurrent work were preserved. The supplied reproduction
  directory is unchanged. No remote push was performed.

## Fourth round (2026-10-18): re-check after the third review

Three production gaps found by probing `e62dfd53` with real-module tests, each with a
permanent test that failed before its repair:

- `b51061e0` — the circuit breaker's progress signal used the scope checkpoint's server
  revision, which a renewed Session rebases onto the collection head; any edit on another
  device reset the window, so a denial loop never tripped while anyone else was active.
  Progress is now committed work (cursor evidence plus push head); a rebase that only dropped
  evidence matches the window it continues. `tests/sync-circuit-breaker.test.ts`.
- `334eb2a1` — a never-sent change failing locally before any request was retried at the
  lane head forever and reported nowhere. After five identical local failures it is set aside
  with that code and offered Retry; pause/authority codes never blame the change; a sent change
  keeps its attempt. `src/push-local-failure.ts`, `tests/push-local-failure-hold.test.ts`.
- `da3edeb5` — a sent change the server kept unsettled (unreadable answer, failed result
  processing, endless deferral, sequence gap) blocked the lane silently. After eight tries it is
  projected as a stalled upload in Status and in the health report (degraded), without becoming
  an item. Push authority/connectivity settlement codes are registered in the failure table.
  `tests/push-stalled-head.test.ts`.

Stale tests that already failed at `e62dfd53` were brought to the current contract in
`ef5d9d79` and `94e5cd9a` (ghost native ids, repair-pass stub, parked-scope copy; T-04
blocked-page exits are Rebuild / fail-closed integrity). Receipt: 56 affected extension suites,
512 tests; web Sync tests 28; typecheck, changed-file lint, source-size, i18n and
`git diff --check` passed. No browser E2E or service was started.

Limits kept: `mapping_identity_conflict` stops the replica until Rebuild; a sent-unsettled head
still holds the lane (now visible); uncaught engine exceptions at wake start are not reflected in
health; the server infers activity only for replicas that are behind.

## Fifth round — a second device (2026-10-18, night)

The earlier rounds were tested with one browser against the server. Read with two browsers in
mind, the push and pull lanes each had a case where one device's ordinary edit made the other
device's ordinary delete a permanent item.

- **A delete the other device raced was lost.** `delete_node`/`delete_subtree` is refused with
  `409 revision_conflict` as soon as the other device edited or moved the node, or touched any
  member of the folder (observation digest). The Problem is `retryable: false`, so the worker
  settled the row `rejected`; Retry recaptured the native node, found it gone and threw
  `deletion_identity_unproven`; the mapping had been dropped at capture, so every later remote
  change to that node became a set-aside item. The only exit was Rebuild.
  - Protocol: the `revision_conflict` Problem for a stale delete now carries `currentRevision`
    and, for `delete_subtree`, `currentSubtree` `{version, count, digest, memberIdsDigest}`
    (`03-sync.md` §13.1, `09-problem-registry.md` §3, schema `subtreeObservationSummary`;
    `subtreeMemberIdsDigest()`/`subtreeObservationSummary()` in `@know-n/colp`).
  - Server: `evaluateCanonicalNodeDelete` attaches those facts
    (`sync-stale-delete-facts.ts`); `sync-push-routes` first dropped `currentSubtree` while the
    pinned `@know-n/colp` predated it, never a 500 (the pin has moved since, see Limits).
    `tests/unit/sync/sync-push-http.test.ts`,
    `tests/support/sync-data-safety-cases.ts` (PostgreSQL, 1 case).
  - Extension: a single delete is rebased on the named revision and sent again on the same
    sequence (deletion dominates, §10.2). A subtree delete is rebased the same way when the
    member-ID digest recorded at capture (`subtreeMemberIdsDigest` in the removal event) equals
    the server's; otherwise, or when the server names no members, it leaves the lane as the
    decide item `delete_subtree_changed`, already carrying the current facts, and Retry
    re-authors that deletion at the tail ("delete anyway"). The lane behind it keeps going.
    `src/push-delete-rebase.ts`, `queue-recapture.ts`, `sync-push-wire.ts`,
    `tests/outbound-push-worker-stale-delete.test.ts` (8), `ds-04-subtree-observation.test.ts`.
    Web copy for the new code in `health.tsx`.
- **Changes to a node this browser deleted were filed as items.** With the mapping gone, a
  foreign update, a foreign delete of the same node, or a bookmark saved elsewhere into the
  deleted folder each failed preflight and stayed a set-aside item after the local delete had
  landed. `pull-local-delete-supersede.ts`: when every node the event needs is unmapped and named
  by a removal this browser still stands behind (pending, in the lane, held, applied or
  recaptured; never one the server refused for good), the event is committed as
  `local_removal` with no browser change, parent children revisions still advance. Subtree
  removals record their member IDs (`subtreeMemberIds`, ≤ 2,000) so changes deeper in the folder
  qualify. A move *out* of a deleted folder keeps its item: the rescued bookmark is not lost here
  silently. `tests/pull-local-delete-supersede.test.ts` (9); the foreign/unreceipted/unconfirmed
  cases in `pull-self-content-local-removal.test.ts` now expect this.

- **Both devices deleting the same bookmark left two items.** The second delete came back
  `404 resource_not_found` and settled `rejected` (an open item for good); the other device's
  tombstone then failed preflight on the unmapped node and became a set-aside item, for a node
  gone everywhere. A delete refused with `resource_not_found` now settles as the history code
  `target_already_deleted` (`settleAlreadyDeleted` in `push-delete-rebase.ts`,
  `SETTLED_REJECTION_CODES` in `open-issue-facts.ts`): no open issue, no rejected banner, a hole
  the lane realigns over, and the removal still counts as this browser's authority, so the
  remote tombstone is superseded. Tests in the two files above.

Receipt: extension 78 pull/delete/issue files (565 tests) and 38 push/queue/issue files (326)
passed; node schema audits updated for the new definition (192 definitions, 170 closed) and the
subtree-observation test (3); server push HTTP/delete units (28) and the DS-04 PostgreSQL case
passed in a Testcontainers Postgres; typecheck in node, server, extension and web; changed-file
lint, source-size, i18n and `git diff --check`. No browser E2E or long-lived service.

Limits: `currentSubtree` now reaches the wire. The server pins `@know-n/colp` 0.2.2 (the vendored
tarball, moved in `9366587a`, 2026-10-23) and `sync-push-routes` passes the facts through without
the old drop guard, so a stale subtree delete whose member-ID digest matches is rebased and sent
again; only one that does not match (or a folder deleted by an older server) is still the decide
item. When this round was written the facts were dropped and every stale subtree delete became the
decide item. A device cannot
yet take in a bookmark moved out of a folder it deleted; the member-ID list is bounded, a larger
folder's deeper members still become items; second-device bootstrap (03 §5.3) was not reviewed.
