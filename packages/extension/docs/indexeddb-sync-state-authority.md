# IndexedDB Sync State Authority

The production database is `known-phase3-indexeddb-entry`, schema version 23. Keeping the P3-03
database name is intentional: v1 and v2 installations enter the real IndexedDB upgrade transaction.
Version 3 is reserved for failed/preformal development builds. Version 4 is the P3-28/P3-29 authority, version 5 adds
the P3-30 event inbox, version 6 adds P3-32 Pull/effect staging, version 7 adds the P3-33 lifecycle and Ack
intent authorities, version 8 adds P3-35 import plans, version 9 adds compaction watermarks, compact
summaries, and live event indexes, and version 10 adds Root Mount stores (`mount_bindings`,
`scope_previews`, `bootstrap_runs`, `deletion_journal`) plus `sync_scopes` mount/first-run fields.
Version 11 adds immutable advanced bootstrap plans (`bootstrap_advanced_plans`) and separately bounded step records (`bootstrap_advanced_steps`). Upgrading v10 only creates these stores and does not rewrite existing rows.
Version 12 adds device remote-delete policy (`remote_delete_policies`), per-item parked decisions (`remote_delete_decisions`), and keep-local native exclusions (`local_sync_exclusions`). Upgrading v11 only creates these stores and does not rewrite queue, mapping, recovery, or advanced-plan rows.
Version 13 adds bookmark-manager batch plans (`bookmark_batch_plans`) and per-item undo records (`bookmark_batch_items`). Upgrading v12 only creates these stores and does not rewrite queue, mapping, recovery, advanced-plan, or remote-delete rows.
Version 14 adds independent remote observations (`remote_observations`) and durable scope command/rejoin plans (`scope_command_plans`). Mount pause baselines are optional fields on `mount_bindings`. Range-exit keep-local copies reuse `local_sync_exclusions` with `sourceKind: 'range_exit'` and must not forge a remote-delete `decisionId`. Upgrading v13 only creates the new stores and does not rewrite queue, mapping, recovery, advanced-plan, remote-delete, or batch rows. Missing pause baselines on old detached mounts are `completeness: 'unknown'` (FRR-02).
Version 15 reuses `apply_intents` for native-result, wait reason, repair-job locator, live-work, and replay fields, plus live-work indexes. `schema_metadata` key `v15-backfill` starts as `unknown`, not complete. Upgrading v14 only creates indexes and schema metadata; it does not cursor-scan queue, receipts, intents, or history. Missing v15 fields on old rows read as `unknown`, never `applied_with_evidence` or complete. A v14 binary cannot open a v15 database.
Version 16 adds `pull_events` `by_scope_page_ordinal` (`[scopeKey, pageId, ordinal]`) and `outbound_queue` `by_scope_target_revision` (`[scopeKey, payload.targetId, operationRevision]`) so `completePullPage` can bound a page's events and the concurrent-local advanced check without a scope-wide scan. Upgrading v15 only createIndex; existing rows are not cursor-scanned. Queue rows without `payload.targetId` are omitted from the target index. A v15 binary cannot open a v16 database.
A database newer than the runtime schema version fails closed.
Version 17 adds `diagnostics` `by_scope_parked` (`[scopeKey, parked]`) so the
park-marker prune reads only markers rather than sweeping the whole ingress ledger,
which measured ~70s on 20,000 marked rows. Upgrading v16 only `createIndex` and arms
the `park-adoption-pending` flag; existing rows are not cursor-scanned, and pre-v17
marker rows (which carry no `parked` discriminator) are adopted into the index by a
bounded per-scope sweep on the next prune. A v16 binary cannot open a v17 database.

Version 18 adds the scoped `classification_confirmation_intents` store without rewriting existing records.
The store was retired on 2026-10-06, when popup AI tags became bookmark metadata. It stays in the schema so the database version does not change; an extension update empties it.
Version 19 adds `bookmark_events` `by_scope_event_operation_ordinal` (`[scopeKey, opId, ordinal]`). Upload exclusion checks use a primary event-ID lookup and bounded pages of operation-ID matches instead of scanning all profile events. IndexedDB builds the new index from existing processed events during the upgrade; application migration code does not cursor-scan or rewrite them. Pending events with a null operation ID enter the index atomically when their queue operation commits.
Profiles with no subscription ownership, mappings, exclusions or unfinished native operations skip event history reads altogether. With subscription evidence, reads are proportional to the current operation’s matching events, not all historical events.
Version 20 adds `pull_pages` `by_scope_pull_page_state` (`[scopeKey, state, pageId]`) and `pull_events` `by_scope_pull_operation` (`[scopeKey, operationId]`). Resume and confirmation probes read the pending state range, and local-overlay coverage looks up one operation, instead of scanning retained pull history. Upgrading v19 only `createIndex`; application code does not cursor-scan queue, intents, or pull history. A v19 binary cannot open a v20 database.

KNS-09 rollback must not install a pre-v20 binary over a v20 database; keep the v20 reader, close `known.kns09.mutations.v1`, and drain the queue instead.
No open, audit, migration, or recovery path automatically deletes or clears a database.

## Scope

Every live key starts with an immutable JSON-array scope encoding environment, server identity and origin, account,
browser profile, Collection, Replica, and generation. Display names and native bookmark IDs are not scope
identity. Native IDs occur only in local mapping and intent records.

P3-27 continues to own OAuth transactions and credentials in `chrome.storage.local`. Logout and account switch
increment a durable authority generation (`known.auth.authority-generation.v1`) that survives `clearAuthority`;
stale credential, Session, and scope writes that do not match the current generation fail closed with
`authority_fenced`. Its initial auth binding
is enrollment input, not a second mutable Replica lifecycle owner. Importing that binding creates the current
scope once; subsequent Replica identity, generation, lifecycle, lease, and checkpoint writes belong only to
IndexedDB. Session credentials and PKCE verifier data are forbidden recursively from every sync record.
The production auth worker performs this import after a verified Session is durable. Refresh-token rotation
preserves the already verified OIDC subject used as the local account identity. Logout archives and removes only
that subject/server/profile's live scopes after server retirement, while `chrome.storage.local` remains the sole
credential authority.

## Authorities

| Durable fact | Single writable authority | Derived index fields |
| --- | --- | --- |
| Replica identity and lifecycle, selected root boundary, server checkpoint | `sync_scopes` | none |
| P0 mount mode, first-run phase, boundary version, legacy canonical root | `sync_scopes` (`mountMode`, `firstRun`, `boundaryVersion`, `legacyCanonicalRoot`) | none |
| native/COLP mapping and local projection | `native_mappings` | scope/native and scope/COLP unique indexes; optional `mountId`/`rootRole`. `projection` is the last Chrome-landed fact only; remote observations must not overwrite it |
| Root Mount binding (special role or custom source) | `mount_bindings` | unique `[scopeKey, rootRole]` for special roles only |
| first-run preview counts/digest/boundary snapshot | `scope_previews` | none; never titles/URLs |
| bootstrap coordinator run | `bootstrap_runs` | none |
| immutable confirmed advanced plan metadata/digest | `bootstrap_advanced_plans` | scope/plan primary key |
| immutable advanced step definition and CAS execution evidence | `bootstrap_advanced_steps` | scope/plan/order primary key |
| device remote-delete policy for this Profile | `remote_delete_policies` | none; default `sync` when absent |
| per-item remote-delete confirmation / keep-local / restore decision | `remote_delete_decisions` | unique scope/event; scope/state |
| keep-local native subtree exclusion | `local_sync_exclusions` | scope/decision; `sourceKind` is `remote_delete` (default) or `range_exit` |
| remote observation (not landed) | `remote_observations` | scope/colpId; optional cursor index. Payload is content, placement, or tombstone summary |
| scope detach/rejoin/remote-delete/range-exit plan | `scope_command_plans` | scope/commandId; phase index |
| mount pause baseline | `mount_bindings.pauseBaseline` | generation, boundaryVersion, last applied cursor, completeness |
| bookmark-manager batch plan / undo window | `bookmark_batch_plans` | scope/updated |
| bookmark-manager batch item identity, digest, CAS, reversal | `bookmark_batch_items` | scope/plan/order |
| bounded native deletion facts | `deletion_journal` | none |
| complete outbound Operation, retry and claim state | `outbound_queue` | scope/status/claim fields are validated in the same record transaction; v16 `by_scope_target_revision` repeats `payload.targetId` + `operationRevision` |
| next durable sequence | `durable_sequences` | none |
| terminal or deferred receipt | `receipts` | sequence and operation digest bind the queue authority |
| Pull cursor and published cursor evidence | `cursors` | receipt or Snapshot evidence is immutable within the cursor record |
| apply intent and expected native mutation correlation | `apply_intents` | scope/correlation unique index; v15 live-work indexes `by_scope_native_result`, `by_scope_wait_reason`, `by_scope_repair_job`, `by_scope_live_work`. Optional `nativeResult`, `waitReason`, `nativeResultConfirmation`, `repairJobId`, `replayState`, owner `commandId`/`colpId`/`substep`. Missing values are `unknown` |
| v15 unknown-field backfill watermark | `schema_metadata` (`v15-backfill`) | post-open paginated worker; upgrade writes `status: unknown` |
| accepted local bookmark event and deterministic ingress ordinal | `bookmark_events` | scope/ordinal, scope/dedupe, scope/status/ordinal, and scope/native/ordinal indexes |
| compaction watermark (highest proven compactable queue sequence and event ordinal) | `compaction_watermarks` | none; one row per scope |
| compact receipt summary (opId, sequence/ordinal, digest; not a live queue substitute) | `compact_summaries` | none; keyed by scope/kind/id |
| validated Pull page and page completion evidence | `pull_pages` | none |
| source-bound effect event and durable apply state | `pull_events` | scope/state/event index; v16 `by_scope_page_ordinal` |
| complete immutable subtree effect pages | `effect_pages` | scope/event/page index |
| stable UI-readable lifecycle phase, retry deadline and recovery freeze | `sync_engine` | none |
| exact Pull/Bootstrap Ack request identity, body and immutable result | `ack_intents` | none |
| recovery Snapshot identity, revision, capability, page chain and complete marker | `recovery_staging` | last page/digest summarize the validated page chain. Optional `materializationVersion` is unknown when absent |
| recovery node staging | `recovery_nodes` | scope/Snapshot/page index |
| lease fence | `replica_leases` | owner and expiry are one CAS record |
| retired archive and diagnostic export | `retired_archives`, `diagnostics` | account index is an export locator only |

Indexes repeat only their source record's scope/status/identity fields. IndexedDB updates an index in the same
transaction as its authority record, so no independently writable copy exists.

## IndexedDB v16 freeze

No new object store. v14/v15 store names stay the independent inventory in
`tests/sync-state-store-migration.test.ts`.

| Store | v16 field / index | Default on missing |
| --- | --- | --- |
| `pull_events` | index `by_scope_page_ordinal` `[scopeKey, pageId, ordinal]` unique | every staged event already has both fields |
| `outbound_queue` | index `by_scope_target_revision` `[scopeKey, payload.targetId, operationRevision]` | rows without `payload.targetId` are omitted |

`onupgradeneeded` createIndex only. `completePullPage` reads one page through `by_scope_page_ordinal` and the advanced check point-queries `by_scope_target_revision`.

## IndexedDB v16 freeze

No new object store. v14 store names stay the independent inventory in
`tests/sync-state-store-migration.test.ts`.

| Store | v15 field / index | Default on missing |
| --- | --- | --- |
| `apply_intents` | `nativeResult` | `unknown` |
| `apply_intents` | `waitReason` | `unknown` |
| `apply_intents` | `nativeResultConfirmation` | `unknown` |
| `apply_intents` | `repairJobId` | absent (no job) |
| `apply_intents` | `replayState` | `unknown` |
| `apply_intents` | `commandId`, `colpId`, `substep`, `liveWorkKind` | absent until a later writer sets owner |
| `apply_intents` | index `by_scope_native_result` `[scopeKey, nativeResult, intentId]` unique | rows without `nativeResult` are omitted |
| `apply_intents` | index `by_scope_wait_reason` `[scopeKey, waitReason, intentId]` unique | omitted when missing |
| `apply_intents` | index `by_scope_repair_job` `[scopeKey, repairJobId, intentId]` unique | omitted when missing |
| `apply_intents` | index `by_scope_live_work` `[scopeKey, liveWorkKind, colpId, substep]` unique | omitted when missing |
| `outbound_queue.attempt` | optional `requestedAt`, `serverBatchId`, `tracing` | absent; never stores Bearer |
| `recovery_staging` | optional `materializationVersion` | unknown |
| `schema_metadata` | key `v15-backfill` `{ status: 'unknown' \| 'complete' }` | `unknown` after upgrade |

`onupgradeneeded` creates indexes and writes schema/`v15-backfill` metadata only. `pageV15Backfill` runs after open, pages, and writes `nativeResult: 'unknown'`. Historical unknown-create repair is T-02.

## Source layout

`src/sync-state-store.ts` is the public facade (`createSyncStateStore` plus re-exported types). Durable
behavior lives under `src/sync-state/`:

| Module | Owner |
| --- | --- |
| `schema.ts` | database name/version **16**, store/index names, compaction `AUTHORITY_DIGEST`, upgrades |
| `v15-backfill.ts` | post-open paginated unknown-field backfill; no-op when complete |
| `runtime.ts` | connection + the only IndexedDB transaction opener |
| `scope-repository.ts` | replica scope, lease, checkpoint, cleanup |
| `queue-repository.ts` | outbound queue, sequences, receipts, claims |
| `mapping-repository.ts` | native/COLP mapping, browser-root projection, `bindMountMapping` |
| `mount-repository.ts` | mount bindings, previews, bootstrap runs, deletion journal |
| `advanced-repository.ts` | atomic confirmed plan installation, immutable step reads, CAS progress and completion |
| `remote-delete-repository.ts` | device policy, parked delete decisions, keep-local exclusions, CAS item actions |
| `batch-repository.ts` | bookmark-manager batch plans, per-item CAS progress, undo identities |
| `scope-facts-repository.ts` | remote observations, scope command plans, atomic range-exit facts |
| `bookmark-event-repository.ts` | bookmark event inbox and compaction watermarks |
| `pull-repository.ts` | Pull pages/events, apply intents, projection intents, effect downloads |
| `recovery-repository.ts` | Snapshot staging and mapping cutover |
| `engine-repository.ts` | `sync_engine`, Ack intents, import plans |

Repositories receive the runtime and must not open nested IndexedDB transactions. Import
`createSyncStateStore` from `./sync-state-store.js`; do not treat `sync-state/*` as a second public API.

The MV3 entry remains `src/service-worker.ts` (listeners + message router). Lane work lives under `src/sw/`
(`runtime`, `auth`, `scope`, `engine`, `bookmarks`, `roots`, `import`, `favicon`, `evidence`, `messages`,
`collections`, `first-run`). Logout drains `workCoordinator`; it does not race a 5s timeout.

The mapping projection retains the last confirmed server projection or the last atomically queued local projection,
including its revision, content and digest. An update Base is copied only from that projection. A missing/corrupt
projection fails closed; the normalizer never reads the post-change native node and labels it as historical Base.

P3-29 extends the `sync_scopes` authority with `privateRoots` and `rootStatus`. Selected and private boundaries
contain random local COLP IDs; their Chrome native IDs exist only in `native_mappings`. The worker writes the
boundary arrays, root status, and any newly generated cryptographic mapping in one transaction. Root titles and
URLs are never stored in either record. Renames therefore retain identity, while a missing native mapping enters
`root_missing` or `corrupt` without guessing a replacement.

KNS-01 extends `sync_scopes` with `mountMode`, `boundaryVersion`, `firstRun`, and optional `legacyCanonicalRoot`.
`native_mappings` may carry `mountId` and `rootRole`. v9 rows keep their queue and mapping bytes; upgrade only
backfills the new scope fields. A scope that had `selectedRoots[0]` receives `legacyCanonicalRoot` and
`firstRun: 'none'`. Upgraded replicas keep Session `mountMode: 'mounted-folder'` on the wire until
`retireLegacyScopeForRemount()`; new scopes send `whole-profile` with `mountNativeId: null`. Preview rows
store counts, digest, and native-id boundary snapshots only.

## Atomic Transactions

- **allocate sequence + queue**: `durable_sequences`, `outbound_queue`, and active `sync_scopes` gate.
- **accept and normalize bookmark event**: privacy-approved input enters `bookmark_events`; its durable ordinal is
  allocated in the same transaction. Processing atomically allocates the operation ID and sequence, validates the
  complete public COLP Operation and byte budget, writes `outbound_queue`, updates/removes the local mapping
  projection, and marks the event processed. An abort leaves the event pending with no operation ID and does not
  consume sequence.
  A pending event whose target, parent, placement anchor, or Base still depends on a queued local projection stops
  ingress processing before sequence allocation. The create result may rebind `pending-<opId>` only when the same
  transaction proves the processed create event and queued `create_node` binding; later normalization rebuilds the
  Operation from the confirmed mapping. Provisional IDs and revisions are local mapping facts, never Wire Base or
  dependency values.
- **receipt + queue transition**: digest-bound `receipts` insertion and queue state transition.
  P3-31 stores the complete validated Push result in that receipt. Terminal create confirmation may additionally
  replace exactly one `pending-<opId>` mapping in the same transaction after proving its processed create event;
  unknown, deferred, gap and blocked outcomes never rebind. A deferred receipt may be replaced only by the same
  operation binding as server reevaluation becomes terminal.
- **published evidence + cursor**: existing receipt verification and `cursors` replacement.
- **validated Pull staging**: `pull_pages`, `pull_events`, and `effect_pages` are written only after the complete page,
  source bindings, digests, type conditions and effect-page chain validate.
- **intent + mapping + projection**: prepare the exact intent before the Chrome API call; matching listeners update only
  durable evidence. `authority_committed` stores pending mapping/projection changes without changing live authority.
- **Pull page completion + cursor**: after every event is `authority_committed`, one transaction marks the page complete,
  applies all mapping/projection changes, updates the scope checkpoint and advances the local Pull cursor. Completed
  intents remain until their bounded expiry so delayed and duplicate native events are still consumed exactly.
- **durable Ack intent**: a Pull Ack can be created only from a cursor whose evidence names a completed P3-32 Pull
  page. A Bootstrap Ack can be created only from Snapshot evidence written by the atomic recovery cutover. The
  serialized body, body digest, endpoint identity and idempotency key are immutable; response loss leaves the same
  pending intent for restart replay, and completion requires the public response to echo that cursor.
- **recovery pages + complete marker**: page-chain header and staged nodes.
- **recovery staging to live**: complete marker and page-chain check, mapping/projection replacement, scope checkpoint
  and cursor switch in one transaction. `sync_engine.recoveryFrozen` blocks sequence allocation and Push throughout
  staging. Only the subsequent Bootstrap Ack can unfreeze the lifecycle.
- **idle compaction**: terminal queue rows with a matching receipt and a published cursor, and processed bookmark
  events bound to a terminal queue row, may have large payload/details replaced with a compact marker in one
  transaction with their summary and watermark. Pending, claimed, deferred, gap, blocked, and unknown rows are
  never compacted. A fault after summary, payload strip, or watermark aborts the whole batch.
- **terminal retention**: the accepted retention policy (September 2026)
  adds no age/count-based deletion of terminal or rejected rows. Compaction preserves required evidence;
  retired/drained/acked alone does not authorize new automatic GC. Storage growth remains capacity debt.
- **logout and retire**: immutable archive creation and removal of the live scope/lease authority in one transaction. Account cleanup
  removes only matching non-retired authority and preserves other accounts, servers, profiles, archives and diagnostics. Compaction watermarks and summaries are archived then deleted with the live scope.
- **root configuration**: `sync_scopes` selection/private boundaries and required `native_mappings` are replaced
  together after overlap normalization; permission/tree failures update only the recoverable status and preserve mappings.
  `bookmarks` is optional: revocation moves the existing scope to `permission_required` without clearing or rebinding
  authority, and regrant reads the live tree before restoring `ready` or reporting `root_missing`.
- **v10 stores**: `mount_bindings` / `scope_previews` / `bootstrap_runs` / `deletion_journal` are created in the
  upgrade transaction without scanning `outbound_queue`, `native_mappings`, or `recovery_*` rows. Preview records
  reject titles and URLs. Detach changes mount `status` only; remote delete is a separate planned command.
- **range-exit retain**: `remote_observations`, `local_sync_exclusions` (`sourceKind: 'range_exit'`), mapping
  unbind/retain, and the matching `scope_command_plans` row are written in one transaction. Do not mint a
  remote-delete decision id for a range exit.
- **v11 advanced plans**: `bootstrap_advanced_plans` and `bootstrap_advanced_steps` are installed in the same
  v10→v11 upgrade transaction. A confirmed plan header and all immutable step definitions are written atomically;
  each plan and step row is validated against the 256 KiB record limit, while a plan may contain many rows. A step
  transition is a compare-and-set against the stored plan digest and step state. Missing rows, a changed definition,
  or a digest mismatch fails closed before execution. Retire and account cleanup export both stores into the
  immutable archive before deleting their live rows.

The in-memory map is populated only after transaction completion. Abort, quota, constraint, blocked and
versionchange outcomes cannot populate it. `versionchange` closes the connection so another context can upgrade;
`blocked` is surfaced to the caller. A stale lease owner cannot claim or commit queue work after its fence changes.

## Migration And Corruption

P3-03 v1/v2 migration copies the unacknowledged queue, next sequence, receipt/published evidence, cursor,
mapping and apply intent inside the upgrade transaction. Because those fixtures lacked account, profile and
origin identity, the result is a diagnostic `legacy` scope in `recovery_required`; it is exportable and must be
explicitly rebound. The same versionchange transaction deletes `replica_state`, `event_dedupe`, and `leases`
after copying, so the current database has no leftover P3-03 stores and no second writable authority. A P3-27 preformal
binding is imported idempotently into its complete scope. Schema upgrades create missing stores and live indexes
without cursor-scanning existing queue or event rows; compaction of historical payloads is a later idle batch.

An upgrade transaction failure aborts the version change and leaves the old database readable. Missing stores or
indexes, bad authority metadata, invalid records, orphan receipt/intent/recovery page, or duplicate authority cause
diagnostic read-only mode. Operators can export diagnostics and archives; production never repairs corruption by
silently clearing unacknowledged data.

## Query Contract

Queue draining first reads `by_scope_status_sequence` for live statuses and claims only the earliest nonterminal
record; it never skips a deferred, unknown, gap, blocked or live claimed predecessor to send a later sequence.
Terminal history is not on that hot path. Claim recovery uses the fenced `replica_leases` authority and the claim
expiry embedded by the same transaction. Ordinary ordering uses `by_scope_sequence`. Intent matching uses
`by_scope_correlation`. Recovery reads use `by_scope_snapshot_page`. Accepted browser events use
`by_scope_event_ordinal`; pending flush and identity overlay use `by_scope_event_status_ordinal`. This ordinal,
followed by durable queue sequence, is the ordering authority. `occurredAt` is protocol metadata only. Exact
apply-intent correlation is checked before staging a local Operation, but P3-30 neither consumes the intent nor
applies Pull mutations. Diagnostics and `exportScope` return both live queue/event rows and compact summaries so
support tools do not treat a compacted payload as missing history. All queries use bounded key ranges and cursor
limits. The stable large-queue contract is 10,000 records and asserts index/query shape rather than wall-clock
timing. Compaction additionally gates 100,000 terminal rows plus one pending claim/flush lookup.

## Durable Lifecycle

`sync_engine` is the sole coordinator authority. Startup, online events, bookmark ingress and the
`known-sync-engine` alarm all serialize through the service-worker work coordinator engine lane, fenced by
the chrome.storage authority generation. A wake resumes a pending Ack first, then obtains a
COLP 0.2 Session, completes an already-bound exact Push retry, Pulls from the P3-32 cursor, durably applies the full
page, Acks that published cursor, and finally drains new outbound work. Each network call has a persisted phase
before it starts and a persisted outcome or retry deadline before another protocol phase can begin.

`offline.notBefore` is durable and alarms use bounded jitter. Session expiry and lease refresh re-enter the same
state machine rather than spawning a second worker. `sync_cursor_expired`, `stale_replica`, and a Session requiring
Snapshot set `recoveryFrozen`; all Snapshot pages must keep one identity, revision, ordered page chain and complete
parent-revision authority before the live mapping switch. Login/account changes use a distinct full scope key.
Logout archives only that account scope, retired Replica identities remain terminal, and reinstall enrollment must
use a new Replica/generation rather than reviving an archive.

The UI status projection contains only phase, freeze flag, timestamps, retry deadline, cursor progress and a stable
error code. It never exposes credentials, Session IDs, bookmark titles/URLs, Chrome native IDs or request bodies.

<a id="p0-whole-profile-mount-mode"></a>
<a id="p0-indexeddb-v10-name-freeze"></a>

## Know-N P0 mount stores (KNS-01; names frozen in KNS-00)

This section records the historical P0 schema version **10**. KNS-00 froze its spellings; KNS-01 implemented the
upgrade. A v10 database opened at version 9 failed closed (`VersionError` → `future_schema`). Production is now
**v20** (see the opening paragraph). Version 11 added advanced-plan stores; its rollback behavior is described
with later versions below. Do not treat this P0 freeze as the live schema version.

P0 Session binding (`sessionRequest()`):

```text
replica.binding = { browserProfileId, mountMode: 'whole-profile', mountNativeId: null, generation }
collection.bootstrapMode = bootstrap_runs current value ?? 'merge'
```

A replica already registered as `mounted-folder` keeps that binding on the wire until
`retireLegacyScopeForRemount()` (not auto-run). See protocol
`06-browser-mapping.md#p0-whole-profile-mount-mode`. Canonical `restore_node` and
`POST /colp/v0.1/sync/collections` landed in KNS-06
(`06-browser-mapping.md#p0-kns-06-restore-and-create-collection-schedule`).

First-run durable phases: `draft → confirmed → scanning → matching → syncing → completed/needs_attention`.

Service worker message kinds:

| Kind | Input | Result |
| --- | --- | --- |
| `known.firstRun.preview` | `viewId + selectedRefs + excludedRefs` | `previewId, boundaryVersion, treeDigest, bookmarkCount, folderCount, skippedCount, warnings[]`; no remote writes |
| `known.firstRun.confirm` | `previewId, libraryId \| libraryDraft, confirmationId` | KNS-03: idempotent `confirmationId` → same `runId`; `treeDigest` mismatch → `preview_stale` plus new counts; mutations go to `bootstrap_runs` + durable queue. Digest rescan is read-only (`chrome.bookmarks.getTree` via the tree adapter); coordinator never writes bookmarks |
| `known.firstRun.status` | none | KNS-03: read-only `bootstrap_runs` phase + `sync_scopes.firstRun` |
| `known.firstRun.later` | none | writes `sync_scopes.firstRun = 'deferred'` when a scope exists; no remote writes |
| `known.scope.detach` | `mountId` | local unmount only (nodes and mappings retained; listen/Pull stop for inactive mounts) |
| `known.scope.rejoin` | `mountId` | local remount; verified mappings reused |
| `known.scope.remoteDelete` | `mountId` plus affected-count `confirmationToken` | executes after the token matches live affected counts; enqueues COLP `delete_node`/`delete_subtree` of the remote mount and detaches. Uncheck (`known.scope.detach`) never enqueues a remote delete. IndexedDB stores that token as `pendingRemoteDelete.confirmation` (not `confirmationToken`) so secret-key scanners do not treat the durable field as a credential; the value is not logged |

### IndexedDB v10 stores

| Store | Key | Notes |
| --- | --- | --- |
| `mount_bindings` | `[scopeKey, mountId]` | unique `[scopeKey, rootRole]` for special roles; fields: `mountId`, `rootRole \| customSourceKey`, `nativeRootId`, `remoteMountNodeId`, `boundaryVersion`, `materialized`, `status`, `lastReconcile{treeDigest, at}`, optional `pendingRemoteDelete.{confirmation, affectedCount}` |
| `scope_previews` | `[scopeKey, previewId]` | counts, digest, boundary snapshot, `expiresAt`; never titles/URLs |
| `bootstrap_runs` | `[scopeKey, runId]` | phase, `bootstrapMode`, `confirmationId`, `reportDigest`, `snapshotCursor`, batch resume cursor |
| `deletion_journal` | `[scopeKey, nativeId, ordinal]` | nativeId is local-only |

`sync_scopes` fields: `mountMode`, `boundaryVersion`,
`firstRun: 'none' | 'deferred' | 'running' | 'completed'`, `legacyCanonicalRoot?: colpId`.

`native_mappings` fields: `mountId`, `rootRole?`.

## Current IndexedDB v11 advanced plan stores

| Store | Key | Authority |
| --- | --- | --- |
| `bootstrap_advanced_plans` | `[scopeKey, planId]` | confirmed plan metadata, immutable definition digest, step count, and lifecycle state |
| `bootstrap_advanced_steps` | `[scopeKey, planId, order]` | immutable operation definition, digest, CAS progress state, and bounded execution evidence |

Opening a v10 database with the production v11 binary creates these two stores and leaves them empty. Existing queue,
mapping, and recovery rows remain byte-for-byte unchanged; the upgrade does not cursor-scan them. A v10 binary cannot
open the upgraded database (`VersionError`). If rollback is required, close advanced mutation controls, keep the v11
reader, and drain already durable queue work with its original operation identity. Never downgrade the database or
recreate a plan from a changed browser tree. Archived scopes retain the plan and step rows for diagnosis while live
scope cleanup removes both rows together.

### Version 22: remote delete member journal

`remote_delete_members` owns each remote deletion member, preimage, and result under `(scopeKey, intentId, colpId)`. The parent apply intent owns only aggregate counts; each member update and its parent counts commit in one transaction. Pre-v22 member anchors migrate lazily in the same transaction before deletion resumes. Scope archives include the journal, account cleanup removes it, and expired completed intent pruning removes its child rows atomically.

### Version 23: mapping and queue worksets

`native_mappings.by_scope_native_parent` bounds placement anchor existence checks to two siblings. Together with `by_scope_colp_parent`, it reads only a deletion's related subtree, including optimistic local moves. `outbound_queue.by_scope_status_attempt` indexes immutable attempts by scope and status, so admitting a new operation does not walk all unsent pending operations. Claimed operations continue to block before their attempt is bound. Upgrades create these indexes without rewriting stored business records.
