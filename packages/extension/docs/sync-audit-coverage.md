# Sync audit coverage owners [S22]

The existing 55 owners retain every reviewed lines, branches, functions, and statements floor. The audit adds executable owners across the actual options/service-worker entry points, range/onboarding authority, native capture/upload boundaries, rejoin decisions and restoration, and durable state repositories. Type-only `src/types.ts` and `src/sync-state/types.ts` have no executable coverage; runtime schemas and codecs remain included.

New owners start with an explicit **80% requirement for each of the four metrics**. These numbers are admission floors, not claimed measurements. A complete V8 run must satisfy them and the old per-file floors; the baseline writer can only increase floors from real measurements. No aggregate average substitutes for any owner. Browser journey execution is independently required by the PostgreSQL + xvfb lifecycle lanes.

Production entry points are listed even when their bootstrap work makes coverage harder. Tests must drive these entry points through their actual message/DOM interfaces and mock external browser/HTTP ports, rather than replace the production owners with test copies.

## Added owners

This pass adds 134 executable owners, for 189 total.

The recovery owners include the native content and placement barriers, ordinary range moves,
and confirmation of an earlier unknown native create after a newer Snapshot. Their behavior
tests preserve the original native result, current canonical authority, and durable item
decisions across IDB reopen; a recovered cursor alone is not evidence of correct native state.
Create, restore, and range materialization adapters are included because they retain distinct
API receipts, user confirmations, and unresolved results while deciding whether another native
write is permitted. Their tests exercise actual Chrome-port results and durable recovery.
The final native write and create checks, range-copy wait decisions, atomic confirmation
authority, and service-worker dispatch are separately measured. User-selected candidates
remain explicit confirmation evidence; they never become fabricated API return receipts.

The manifest capability parser, advanced first-run execution, native event codec, and Reset
confirmation UI are executable owners too. The generated browser title validator is measured
through real ingress calls; generated provenance does not exempt its runtime branches.

The queue read repository is included because bounded reads must retain one coherent view
of each requested operation and its receipt while bootstrap checks fresh durable state.
The Pull mapping read repository is separately measured because shadow events, page order,
and the durable mapping must come from one fresh readonly transaction. Its four 80% floors
leave the original mapping-view owner's four 100% floors unchanged. The local placement
owner covers captured drag evidence and the guarded admission of a later retry.

The provisional self-create owner is measured separately from the runtime that calls it.
Its replay paths retain operation binding and native identity checks while deferring an
unused parent read; prepare still supplies an already-read parent. Its four 80% admission
floors leave all 188 previously registered owners unchanged and require a real V8 measurement.

- `src/advanced-first-run-ui.ts`
- `src/bookmark-boundary.ts`
- `src/bookmark-child-order.ts`
- `src/bookmark-content-capture.ts`
- `src/bookmark-event-codec.ts`
- `src/bookmark-event-ingress.ts`
- `src/bookmark-event-projection.ts`
- `src/bookmark-move-echo.ts`
- `src/bookmark-own-create-repair.ts`
- `src/bookmark-subscriptions/guards.ts`
- `src/bootstrap/advanced-run.ts`
- `src/bootstrap/local-facts.ts`
- `src/bootstrap/upload-rejection.ts`
- `src/browser-root-identity.ts`
- `src/chrome-bookmark-tree.ts`
- `src/cloud-capability.ts`
- `src/first-run-confirmation-session.ts`
- `src/first-run-draft.ts`
- `src/first-run-preview-copy.ts`
- `src/first-run-ui.ts`
- `src/generated/browser-ingress-title.ts`
- `src/kns-09-release.ts`
- `src/manifest-client.ts`
- `src/metadata-sync-policy.ts`
- `src/native-call-result.ts`
- `src/native-wait-materialization.ts`
- `src/options.ts`
- `src/outbound-push-batch.ts`
- `src/outbound-push-encoding.ts`
- `src/personal-sync-fetch.ts`
- `src/public-server-manifest.ts`
- `src/pull-child-order.ts`
- `src/pull-create-evidence.ts`
- `src/pull-delete-apply.ts`
- `src/pull-item-set-aside.ts`
- `src/pull-local-placement.ts`
- `src/pull-native-content-barrier.ts`
- `src/pull-native-create-boundary.ts`
- `src/pull-native-snapshot-resume.ts`
- `src/pull-native-write-boundary.ts`
- `src/pull-range-materialize.ts`
- `src/pull-range-move.ts`
- `src/pull-restore-apply.ts`
- `src/pull-self-create.ts`
- `src/push-recovery-barrier.ts`
- `src/queued-upload-batch-boundary.ts`
- `src/queued-upload-boundary.ts`
- `src/range-confirmation-session.ts`
- `src/range-ui.ts`
- `src/recovery-content.ts`
- `src/recovery-delete.ts`
- `src/recovery-placement.ts`
- `src/rejoin-decisions-ui.ts`
- `src/remote-delete-apply.ts`
- `src/remote-delete-local-work.ts`
- `src/replica-rebuild-ui.ts`
- `src/replica-repair-capability.ts`
- `src/replica-retirement.ts`
- `src/scope-range.ts`
- `src/scope-rejoin-authority.ts`
- `src/scope-rejoin-boundary.ts`
- `src/scope-rejoin-decisions.ts`
- `src/scope-rejoin-deletion.ts`
- `src/scope-rejoin-echo.ts`
- `src/scope-rejoin-materialize.ts`
- `src/scope-rejoin-members.ts`
- `src/scope-rejoin-mutation.ts`
- `src/scope-rejoin-order-progress.ts`
- `src/scope-rejoin-order.ts`
- `src/scope-rejoin-parents.ts`
- `src/scope-rejoin-placement.ts`
- `src/scope-rejoin-reconcile.ts`
- `src/scope-rejoin-rejection.ts`
- `src/scope-rejoin-remote-delete.ts`
- `src/scope-rejoin-restore.ts`
- `src/scope-rejoin-upload.ts`
- `src/server-account-ui.ts`
- `src/server-edition.ts`
- `src/service-worker.ts`
- `src/snapshot-create-boundary.ts`
- `src/snapshot-mounted-deletes.ts`
- `src/snapshot-native-boundary.ts`
- `src/sw/advanced-first-run.ts`
- `src/sw/auth.ts`
- `src/sw/bookmarks.ts`
- `src/sw/boundary-attempt.ts`
- `src/sw/boundary-confirmation.ts`
- `src/sw/first-run-browser-roots.ts`
- `src/sw/first-run.ts`
- `src/sw/messages.ts`
- `src/sw/native-chrome.ts`
- `src/sw/native-wait.ts`
- `src/sw/range-command.ts`
- `src/sw/range-remote-commands.ts`
- `src/sw/range.ts`
- `src/sw/rejoin-decisions.ts`
- `src/sw/rejoin-native.ts`
- `src/sw/roots.ts`
- `src/sw/scope-rebuild.ts`
- `src/sw/scope.ts`
- `src/sw/sync-attention.ts`
- `src/sw/sync-progress.ts`
- `src/sync-attention-ui.ts`
- `src/sync-effect-authority.ts`
- `src/sync-failure-class.ts`
- `src/sync-fetch-boundary.ts`
- `src/sync-folders.ts`
- `src/sync-issues.ts`
- `src/sync-label.ts`
- `src/sync-state/advanced-repository.ts`
- `src/sync-state/bookmark-event-child-order.ts`
- `src/sync-state/bookmark-event-dedupe.ts`
- `src/sync-state/bookmark-event-repository.ts`
- `src/sync-state/boundary-command-repository.ts`
- `src/sync-state/issue-dependencies.ts`
- `src/sync-state/materialization-wait-authority.ts`
- `src/sync-state/mount-repository.ts`
- `src/sync-state/pull-mapping-read-repository.ts`
- `src/sync-state/pull-mapping-writes.ts`
- `src/sync-state/pull-workset.ts`
- `src/sync-state/queue-hold.ts`
- `src/sync-state/queue-issue-repository.ts`
- `src/sync-state/queue-live-work.ts`
- `src/sync-state/queue-read-repository.ts`
- `src/sync-state/queued-upload-boundary-repository.ts`
- `src/sync-state/recovery-repository.ts`
- `src/sync-state/rejoin-decision-repository.ts`
- `src/sync-state/rejoin-queue-resolution.ts`
- `src/sync-state/rejoin-resolution-repository.ts`
- `src/sync-state/schema.ts`
- `src/sync-state/scope-command-evidence.ts`
- `src/sync-state/scope-command-record.ts`
- `src/sync-state/scope-facts-repository.ts`
- `src/sync-status-queue.ts`
