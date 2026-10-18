# Sync resilience review remediation — 2026-10-17

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
