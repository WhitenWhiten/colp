/**
 * IndexedDB identity for `known-phase3-indexeddb-entry`.
 *
 * | Version | Authority |
 * | --- | --- |
 * | 20 | `pull_pages` `by_scope_pull_page_state`; `pull_events` `by_scope_pull_operation`.
 *     Upgrade from v19 is createIndex only. Queue, intents, and pull history are
 *     not cursor-scanned. |
 * | 21 | `apply_intents` `by_scope_native_target` and `by_scope_completed_expiry`.
 *     Upgrade from v20 is createIndex only. Intent rows are not cursor-scanned. |
 * | 19 | Bookmark event operation/ordinal index for bounded upload evidence reads. |
 * | 18 | Durable Product classification confirmation intents; scoped cleanup. |
 * | 9 | compaction watermarks / compact summaries |
 * | 10 | `mount_bindings`, `scope_previews`, `bootstrap_runs`, `deletion_journal`; `sync_scopes` mount/first-run fields |
 * | 11 | Immutable advanced bootstrap plans and individual resumable steps |
 * | 12 | Device remote-delete policy, per-item decisions, keep-local exclusions |
 * | 13 | Bookmark-manager batch plans and per-item undo records |
 * | 14 | Remote observations, scope command/rejoin plans; optional mount pause
 *     baseline and range-exit exclusion source fields; authorityDigest
 *     `p3-36-compaction-v1` |
 * | 15 | apply_intents native-result / wait / repair / live-work indexes and
 *     optional fields; schema_metadata `v15-backfill`. No new object store.
 *     authorityDigest `srg-v15-native-result-v1`. |
 * | 16 | `pull_events` `by_scope_page_ordinal`; `outbound_queue`
 *     `by_scope_target_revision`. No new object store. Upgrade from v15 only
 *     createIndex; queue/history rows are not cursor-scanned.
 * | 17 | `diagnostics` `by_scope_parked`: a `parked` discriminator plus an index
 *     over it, so pruning quarantine markers costs the markers rather than the
 *     whole ingress ledger (20_000 marked rows cost ~70s when the prune walked
 *     `by_scope`). Upgrade from v16 is createIndex only, like v16; the value is
 *     a string because IndexedDB index keys cannot be booleans. Pre-v17 marker
 *     rows lack the field, so the prune adopts them on its next pass instead of
 *     the upgrade walking history. |
 *
 * Upgrade from v14/v15 only creates indexes and schema metadata. Queue, mapping,
 * recovery, intent, receipt, and cursor rows are not cursor-scanned. A newer
 * database opened by an older binary fails closed (`oldVersion > DATABASE_VERSION`).
 *
 * Superseded authority digests, kept so past releases stay identifiable:
 * `srg-v16-pull-page-index-v1`, `srg-v17-diagnostic-park-index-v1`,
 * `clf-v18-confirmation-intents-v1`, `bsr-v19-bookmark-operation-index-v1`,
 * `u18-v20-pull-workset-index-v1`.
 */

/** Set by the v16→v17 upgrade; clears once the adoption sweep has completed. */
export const PARK_ADOPTION_PENDING_KEY = 'park-adoption-pending';
import { type LegacyState, type SyncScope } from './types.js';
import { boundedString, safeInteger } from './codec.js';
import { stableCode } from './errors.js';
import { scopeKey, validateScopeRecord } from './scope-key.js';

export const DATABASE_NAME = 'known-phase3-indexeddb-entry';
export const DATABASE_VERSION = 21;
export const LARGE_QUEUE_CONTRACT_SIZE = 10_000;
export const AUTHORITY_DIGEST = 'u21-apply-intent-target-index-v1';
export const V15_BACKFILL_KEY = 'v15-backfill';
/**
 * The `parked` discriminator, and the key value of `by_scope_parked`.
 *
 * A string rather than `true`: IndexedDB rejects a boolean as an index key, so a
 * boolean discriminator would make the index throw on every marker write.
 */
export const PARKED_DIAGNOSTIC = 'marker';

export const STORES = Object.freeze({
  // Retired; kept so the database version does not change (see classification-repository.ts).
  classificationIntents: 'classification_confirmation_intents',
  scopes: 'sync_scopes', mappings: 'native_mappings', queue: 'outbound_queue',
  sequences: 'durable_sequences', receipts: 'receipts', cursors: 'cursors',
  intents: 'apply_intents', recovery: 'recovery_staging', recoveryNodes: 'recovery_nodes',
  leases: 'replica_leases', archives: 'retired_archives', diagnostics: 'diagnostics',
  metadata: 'schema_metadata', bookmarkEvents: 'bookmark_events',
  pullPages: 'pull_pages', pullEvents: 'pull_events', effectPages: 'effect_pages',
  engine: 'sync_engine', ackIntents: 'ack_intents',
  importPlans: 'import_plans', importNodes: 'import_nodes',
  compactionWatermarks: 'compaction_watermarks', compactSummaries: 'compact_summaries',
  mounts: 'mount_bindings', previews: 'scope_previews', bootstrapRuns: 'bootstrap_runs',
  deletionJournal: 'deletion_journal',
  advancedPlans: 'bootstrap_advanced_plans', advancedSteps: 'bootstrap_advanced_steps',
  remoteDeletePolicies: 'remote_delete_policies', remoteDeleteDecisions: 'remote_delete_decisions',
  localSyncExclusions: 'local_sync_exclusions',
  batchPlans: 'bookmark_batch_plans', batchItems: 'bookmark_batch_items',
  remoteObservations: 'remote_observations', scopeCommandPlans: 'scope_command_plans',
});
export const INDEXES = Object.freeze({
  queueBySequence: 'by_scope_sequence', queueByOpId: 'by_scope_op_id',
  queueByStatusSequence: 'by_scope_status_sequence', queueByClaimSequence: 'by_scope_claim_sequence',
  mappingByNativeId: 'by_scope_native_id', mappingByColpId: 'by_scope_colp_id',
  intentByCorrelation: 'by_scope_correlation',
  intentByNativeResult: 'by_scope_native_result', intentByWaitReason: 'by_scope_wait_reason',
  intentByRepairJob: 'by_scope_repair_job', intentByLiveWork: 'by_scope_live_work',
  intentByNativeTarget: 'by_scope_native_target', intentByCompletedExpiry: 'by_scope_completed_expiry',
  recoveryByPage: 'by_scope_snapshot_page',
  eventByOrdinal: 'by_scope_event_ordinal', eventByDedupe: 'by_scope_event_dedupe',
  eventByStatusOrdinal: 'by_scope_event_status_ordinal', eventByNativeId: 'by_scope_event_native_ordinal',
  eventByOperationOrdinal: 'by_scope_event_operation_ordinal',
  archiveByAccount: 'by_account', diagnosticByScope: 'by_scope',
  diagnosticByPark: 'by_scope_parked',
  pullEventByState: 'by_scope_pull_state', pullEventByPage: 'by_scope_page_ordinal',
  pullEventByOperation: 'by_scope_pull_operation', pullPageByState: 'by_scope_pull_page_state',
  queueByTargetRevision: 'by_scope_target_revision', effectPageByEvent: 'by_scope_event_page',
  importNodeByPlanOrder: 'by_scope_plan_order', importPlanByUpdated: 'by_scope_updated',
  mountByRootRole: 'by_scope_root_role',
  remoteDeleteByState: 'by_scope_remote_delete_state', remoteDeleteByEvent: 'by_scope_remote_delete_event',
  localExclusionByDecision: 'by_scope_exclusion_decision',
  batchPlanByUpdated: 'by_scope_batch_updated', batchItemByPlanOrder: 'by_scope_batch_order',
  observationByCursor: 'by_scope_observation_cursor', commandByPhase: 'by_scope_command_phase',
});
export const SCOPE_ROW_STORES = Object.freeze([
  STORES.classificationIntents,
  STORES.scopes, STORES.mappings, STORES.queue, STORES.sequences, STORES.receipts,
  STORES.cursors, STORES.intents, STORES.recovery, STORES.recoveryNodes, STORES.leases,
  STORES.bookmarkEvents, STORES.pullPages, STORES.pullEvents, STORES.effectPages,
  STORES.engine, STORES.ackIntents, STORES.importPlans, STORES.importNodes,
  STORES.compactionWatermarks, STORES.compactSummaries, STORES.mounts, STORES.previews,
  STORES.bootstrapRuns, STORES.deletionJournal, STORES.advancedPlans, STORES.advancedSteps,
  STORES.remoteDeletePolicies, STORES.remoteDeleteDecisions, STORES.localSyncExclusions,
  STORES.batchPlans, STORES.batchItems, STORES.remoteObservations, STORES.scopeCommandPlans,
]);

export function structuralProblems(db: IDBDatabase): string[] {
  const problems = Object.values(STORES).filter((name) => !db.objectStoreNames.contains(name)).map((name) => `missing:${name}`);
  const allowed = new Set<string>(Object.values(STORES));
  for (const name of Array.from(db.objectStoreNames)) if (!allowed.has(name)) problems.push(`unexpected:${name}`);
  if (problems.length) return problems;
  const tx = db.transaction([STORES.queue, STORES.mappings, STORES.receipts, STORES.intents,
    STORES.recoveryNodes, STORES.archives, STORES.diagnostics, STORES.bookmarkEvents, STORES.pullPages, STORES.pullEvents,
    STORES.effectPages, STORES.importPlans, STORES.importNodes, STORES.compactionWatermarks,
    STORES.compactSummaries, STORES.mounts, STORES.remoteDeleteDecisions, STORES.localSyncExclusions,
    STORES.batchPlans, STORES.batchItems, STORES.remoteObservations, STORES.scopeCommandPlans], 'readonly');
  const expected: Array<[string, readonly string[]]> = [
    [STORES.queue, [INDEXES.queueBySequence, INDEXES.queueByOpId, INDEXES.queueByStatusSequence,
      INDEXES.queueByClaimSequence, INDEXES.queueByTargetRevision]],
    [STORES.mappings, [INDEXES.mappingByNativeId, INDEXES.mappingByColpId]],
    [STORES.mounts, [INDEXES.mountByRootRole]],
    [STORES.receipts, [INDEXES.queueBySequence]],
    [STORES.intents, [INDEXES.intentByCorrelation, INDEXES.intentByNativeResult, INDEXES.intentByWaitReason,
      INDEXES.intentByRepairJob, INDEXES.intentByLiveWork, INDEXES.intentByNativeTarget,
      INDEXES.intentByCompletedExpiry]], [STORES.recoveryNodes, [INDEXES.recoveryByPage]],
    [STORES.bookmarkEvents, [INDEXES.eventByOrdinal, INDEXES.eventByDedupe, INDEXES.eventByStatusOrdinal,
      INDEXES.eventByNativeId, INDEXES.eventByOperationOrdinal]],
    [STORES.pullPages, [INDEXES.pullPageByState]],
    [STORES.pullEvents, [INDEXES.pullEventByState, INDEXES.pullEventByPage, INDEXES.pullEventByOperation]],
    [STORES.effectPages, [INDEXES.effectPageByEvent]],
    [STORES.archives, [INDEXES.archiveByAccount]],
    [STORES.diagnostics, [INDEXES.diagnosticByScope, INDEXES.diagnosticByPark]],
    [STORES.importPlans, [INDEXES.importPlanByUpdated]], [STORES.importNodes, [INDEXES.importNodeByPlanOrder]],
    [STORES.remoteDeleteDecisions, [INDEXES.remoteDeleteByState, INDEXES.remoteDeleteByEvent]],
    [STORES.localSyncExclusions, [INDEXES.localExclusionByDecision]],
    [STORES.batchPlans, [INDEXES.batchPlanByUpdated]],
    [STORES.batchItems, [INDEXES.batchItemByPlanOrder]],
    [STORES.remoteObservations, [INDEXES.observationByCursor]],
    [STORES.scopeCommandPlans, [INDEXES.commandByPhase]],
  ];
  for (const [store, indexes] of expected) for (const index of indexes) {
    if (!tx.objectStore(store).indexNames.contains(index)) problems.push(`missing:${store}:${index}`);
  }
  return problems;
}

export function upgrade(db: IDBDatabase, tx: IDBTransaction, oldVersion: number, maxBytes: number) {
  if (oldVersion > DATABASE_VERSION) { tx.abort(); return; }
  createStores(db);
  ensureLiveIndexes(tx);
  tx.objectStore(STORES.metadata).put({ key: 'schema', version: DATABASE_VERSION, authorityDigest: AUTHORITY_DIGEST });
  if (oldVersion < 15) {
    tx.objectStore(STORES.metadata).put({ key: V15_BACKFILL_KEY, status: 'unknown' });
  }
  if (oldVersion > 0 && oldVersion < 17) {
    // Only a database that PREDATES v17 can hold marker rows without the
    // `parked` discriminator. Recording that here lets the prune skip its
    // adoption sweep entirely everywhere else — a fresh install, or a database
    // already upgraded, has nothing to adopt, and sweeping it anyway cost
    // minutes on a large ledger (20,050 markerless rows measured ~195s).
    tx.objectStore(STORES.metadata).put({ key: 'park-adoption-pending', pending: true });
  }
  if (oldVersion === 1 || oldVersion === 2) migrateP303(tx, maxBytes);
  if (oldVersion > 0 && oldVersion < 10) backfillSyncScopesV10(tx);
}

function createStores(db: IDBDatabase) {
  const create = (name: string, options: IDBObjectStoreParameters) => db.objectStoreNames.contains(name)
    ? null : db.createObjectStore(name, options);
  create(STORES.classificationIntents, { keyPath: ['scopeKey', 'intentId'] });
  create(STORES.scopes, { keyPath: 'scopeKey' });
  const mappings = create(STORES.mappings, { keyPath: ['scopeKey', 'nativeId'] });
  mappings?.createIndex(INDEXES.mappingByNativeId, ['scopeKey', 'nativeId'], { unique: true });
  mappings?.createIndex(INDEXES.mappingByColpId, ['scopeKey', 'colpId'], { unique: true });
  const queue = create(STORES.queue, { keyPath: ['scopeKey', 'sequence'] });
  queue?.createIndex(INDEXES.queueBySequence, ['scopeKey', 'sequence'], { unique: true });
  queue?.createIndex(INDEXES.queueByOpId, ['scopeKey', 'opId'], { unique: true });
  queue?.createIndex(INDEXES.queueByStatusSequence, ['scopeKey', 'status', 'sequence'], { unique: true });
  queue?.createIndex(INDEXES.queueByClaimSequence, ['scopeKey', 'retry.ownerId', 'retry.fence', 'sequence']);
  queue?.createIndex(INDEXES.queueByTargetRevision, ['scopeKey', 'payload.targetId', 'operationRevision']);
  create(STORES.sequences, { keyPath: 'scopeKey' });
  create(STORES.receipts, { keyPath: ['scopeKey', 'receiptId'] })?.createIndex('by_scope_sequence',
    ['scopeKey', 'sequence'], { unique: true });
  create(STORES.cursors, { keyPath: 'scopeKey' });
  const intents = create(STORES.intents, { keyPath: ['scopeKey', 'intentId'] });
  intents?.createIndex(INDEXES.intentByCorrelation, ['scopeKey', 'correlationId'], { unique: true });
  intents?.createIndex(INDEXES.intentByNativeResult, ['scopeKey', 'nativeResult', 'intentId'], { unique: true });
  intents?.createIndex(INDEXES.intentByWaitReason, ['scopeKey', 'waitReason', 'intentId'], { unique: true });
  intents?.createIndex(INDEXES.intentByRepairJob, ['scopeKey', 'repairJobId', 'intentId'], { unique: true });
  intents?.createIndex(INDEXES.intentByLiveWork, ['scopeKey', 'liveWorkKind', 'colpId', 'substep'], { unique: true });
  intents?.createIndex(INDEXES.intentByNativeTarget, ['scopeKey', 'nativeTargetId', 'intentId'], { unique: true });
  intents?.createIndex(INDEXES.intentByCompletedExpiry, ['scopeKey', 'state', 'expiresAt', 'intentId'], { unique: true });
  create(STORES.recovery, { keyPath: ['scopeKey', 'snapshotId'] });
  const recoveryNodes = create(STORES.recoveryNodes, { keyPath: ['scopeKey', 'snapshotId', 'colpId'] });
  recoveryNodes?.createIndex(INDEXES.recoveryByPage, ['scopeKey', 'snapshotId', 'page', 'colpId'], { unique: true });
  create(STORES.leases, { keyPath: 'scopeKey' });
  const archives = create(STORES.archives, { keyPath: ['scopeKey', 'retiredAt'] });
  archives?.createIndex(INDEXES.archiveByAccount, ['environment', 'serverId', 'accountId', 'browserProfileId',
    'replicaId', 'generation', 'retiredAt'], { unique: true });
  const diagnostics = create(STORES.diagnostics, { keyPath: 'id' });
  diagnostics?.createIndex(INDEXES.diagnosticByScope, ['scopeKey', 'id']);
  // Only rows carrying a quarantine marker are in this index, so the marker
  // prune reads the markers rather than the ingress ledger they live on.
  diagnostics?.createIndex(INDEXES.diagnosticByPark, ['scopeKey', 'parked']);
  const bookmarkEvents = create(STORES.bookmarkEvents, { keyPath: ['scopeKey', 'eventId'] });
  bookmarkEvents?.createIndex(INDEXES.eventByOrdinal, ['scopeKey', 'ordinal'], { unique: true });
  bookmarkEvents?.createIndex(INDEXES.eventByDedupe, ['scopeKey', 'dedupeKey'], { unique: true });
  bookmarkEvents?.createIndex(INDEXES.eventByStatusOrdinal, ['scopeKey', 'status', 'ordinal'], { unique: true });
  bookmarkEvents?.createIndex(INDEXES.eventByNativeId, ['scopeKey', 'nativeId', 'ordinal']);
  bookmarkEvents?.createIndex(INDEXES.eventByOperationOrdinal, ['scopeKey', 'opId', 'ordinal']);
  const pullPages = create(STORES.pullPages, { keyPath: ['scopeKey', 'pageId'] });
  pullPages?.createIndex(INDEXES.pullPageByState, ['scopeKey', 'state', 'pageId'], { unique: true });
  const pullEvents = create(STORES.pullEvents, { keyPath: ['scopeKey', 'eventId'] });
  pullEvents?.createIndex(INDEXES.pullEventByState, ['scopeKey', 'state', 'eventId'], { unique: true });
  pullEvents?.createIndex(INDEXES.pullEventByPage, ['scopeKey', 'pageId', 'ordinal'], { unique: true });
  pullEvents?.createIndex(INDEXES.pullEventByOperation, ['scopeKey', 'operationId']);
  const effectPages = create(STORES.effectPages, { keyPath: ['scopeKey', 'eventId', 'pageNumber'] });
  effectPages?.createIndex(INDEXES.effectPageByEvent, ['scopeKey', 'eventId', 'pageNumber'], { unique: true });
  create(STORES.metadata, { keyPath: 'key' });
  create(STORES.engine, { keyPath: 'scopeKey' });
  create(STORES.ackIntents, { keyPath: ['scopeKey', 'intentId'] });
  create(STORES.importPlans, { keyPath: ['scopeKey', 'planId'] })?.createIndex(INDEXES.importPlanByUpdated,
    ['scopeKey', 'updatedAt', 'planId'], { unique: true });
  create(STORES.importNodes, { keyPath: ['scopeKey', 'planId', 'sourceNodeId'] })?.createIndex(INDEXES.importNodeByPlanOrder,
    ['scopeKey', 'planId', 'order'], { unique: true });
  create(STORES.compactionWatermarks, { keyPath: 'scopeKey' });
  create(STORES.compactSummaries, { keyPath: ['scopeKey', 'kind', 'id'] });
  create(STORES.mounts, { keyPath: ['scopeKey', 'mountId'] })?.createIndex(INDEXES.mountByRootRole,
    ['scopeKey', 'rootRole'], { unique: true });
  create(STORES.previews, { keyPath: ['scopeKey', 'previewId'] });
  create(STORES.bootstrapRuns, { keyPath: ['scopeKey', 'runId'] });
  create(STORES.deletionJournal, { keyPath: ['scopeKey', 'nativeId', 'ordinal'] });
  create(STORES.advancedPlans, { keyPath: ['scopeKey', 'planId'] });
  create(STORES.advancedSteps, { keyPath: ['scopeKey', 'planId', 'order'] });
  create(STORES.remoteDeletePolicies, { keyPath: 'scopeKey' });
  const decisions = create(STORES.remoteDeleteDecisions, { keyPath: ['scopeKey', 'decisionId'] });
  decisions?.createIndex(INDEXES.remoteDeleteByState, ['scopeKey', 'state', 'decisionId'], { unique: true });
  decisions?.createIndex(INDEXES.remoteDeleteByEvent, ['scopeKey', 'eventId'], { unique: true });
  create(STORES.localSyncExclusions, { keyPath: ['scopeKey', 'nativeId'] })
    ?.createIndex(INDEXES.localExclusionByDecision, ['scopeKey', 'decisionId']);
  create(STORES.batchPlans, { keyPath: ['scopeKey', 'planId'] })
    ?.createIndex(INDEXES.batchPlanByUpdated, ['scopeKey', 'updatedAt', 'planId'], { unique: true });
  create(STORES.batchItems, { keyPath: ['scopeKey', 'planId', 'itemId'] })
    ?.createIndex(INDEXES.batchItemByPlanOrder, ['scopeKey', 'planId', 'order'], { unique: true });
  create(STORES.remoteObservations, { keyPath: ['scopeKey', 'colpId'] })
    ?.createIndex(INDEXES.observationByCursor, ['scopeKey', 'cursor', 'colpId'], { unique: true });
  create(STORES.scopeCommandPlans, { keyPath: ['scopeKey', 'commandId'] })
    ?.createIndex(INDEXES.commandByPhase, ['scopeKey', 'phase', 'commandId'], { unique: true });
}

function ensureLiveIndexes(tx: IDBTransaction) {
  const bookmarkEvents = tx.objectStore(STORES.bookmarkEvents);
  if (!bookmarkEvents.indexNames.contains(INDEXES.eventByStatusOrdinal)) {
    bookmarkEvents.createIndex(INDEXES.eventByStatusOrdinal, ['scopeKey', 'status', 'ordinal'], { unique: true });
  }
  if (!bookmarkEvents.indexNames.contains(INDEXES.eventByNativeId)) {
    bookmarkEvents.createIndex(INDEXES.eventByNativeId, ['scopeKey', 'nativeId', 'ordinal']);
  }
  if (!bookmarkEvents.indexNames.contains(INDEXES.eventByOperationOrdinal)) {
    // IndexedDB populates the index for existing processed rows. Pending rows
    // have a null opId and enter it atomically when commitBookmarkEvent assigns one.
    bookmarkEvents.createIndex(INDEXES.eventByOperationOrdinal, ['scopeKey', 'opId', 'ordinal']);
  }
  const diagnostics = tx.objectStore(STORES.diagnostics);
  if (!diagnostics.indexNames.contains(INDEXES.diagnosticByPark)) {
    // Index only. Stamping `parked` onto the pre-v17 rows would mean walking the
    // ingress ledger during an upgrade, which this schema forbids for history
    // stores; `pruneParkDiagnostics` adopts them on its next pass instead.
    diagnostics.createIndex(INDEXES.diagnosticByPark, ['scopeKey', 'parked']);
  }
  const intents = tx.objectStore(STORES.intents);
  if (!intents.indexNames.contains(INDEXES.intentByNativeResult)) {
    intents.createIndex(INDEXES.intentByNativeResult, ['scopeKey', 'nativeResult', 'intentId'], { unique: true });
  }
  if (!intents.indexNames.contains(INDEXES.intentByWaitReason)) {
    intents.createIndex(INDEXES.intentByWaitReason, ['scopeKey', 'waitReason', 'intentId'], { unique: true });
  }
  if (!intents.indexNames.contains(INDEXES.intentByRepairJob)) {
    intents.createIndex(INDEXES.intentByRepairJob, ['scopeKey', 'repairJobId', 'intentId'], { unique: true });
  }
  if (!intents.indexNames.contains(INDEXES.intentByLiveWork)) {
    intents.createIndex(INDEXES.intentByLiveWork, ['scopeKey', 'liveWorkKind', 'colpId', 'substep'], { unique: true });
  }
  if (!intents.indexNames.contains(INDEXES.intentByNativeTarget)) {
    intents.createIndex(INDEXES.intentByNativeTarget, ['scopeKey', 'nativeTargetId', 'intentId'], { unique: true });
  }
  if (!intents.indexNames.contains(INDEXES.intentByCompletedExpiry)) {
    intents.createIndex(INDEXES.intentByCompletedExpiry, ['scopeKey', 'state', 'expiresAt', 'intentId'], { unique: true });
  }
  const pullEvents = tx.objectStore(STORES.pullEvents);
  if (!pullEvents.indexNames.contains(INDEXES.pullEventByPage)) {
    pullEvents.createIndex(INDEXES.pullEventByPage, ['scopeKey', 'pageId', 'ordinal'], { unique: true });
  }
  if (!pullEvents.indexNames.contains(INDEXES.pullEventByOperation)) {
    // IndexedDB fills the index. The upgrade does not cursor-scan pull history.
    pullEvents.createIndex(INDEXES.pullEventByOperation, ['scopeKey', 'operationId']);
  }
  const pullPages = tx.objectStore(STORES.pullPages);
  if (!pullPages.indexNames.contains(INDEXES.pullPageByState)) {
    pullPages.createIndex(INDEXES.pullPageByState, ['scopeKey', 'state', 'pageId'], { unique: true });
  }
  const queue = tx.objectStore(STORES.queue);
  if (!queue.indexNames.contains(INDEXES.queueByTargetRevision)) {
    queue.createIndex(INDEXES.queueByTargetRevision, ['scopeKey', 'payload.targetId', 'operationRevision']);
  }
}

function backfillSyncScopesV10(tx: IDBTransaction) {
  const scopes = tx.objectStore(STORES.scopes);
  const cursor = scopes.openCursor();
  cursor.onsuccess = () => {
    const current = cursor.result;
    if (!current) return;
    const row = current.value as Record<string, unknown>;
    const selected = Array.isArray(row.selectedRoots) ? row.selectedRoots as string[] : [];
    const patched: Record<string, unknown> = { ...row };
    // Upgraded replicas were registered as mounted-folder; keep that on the
    // wire until KNS-03 remount. New scopes default to whole-profile.
    if (typeof patched.mountMode !== 'string') patched.mountMode = 'mounted-folder';
    if (typeof patched.boundaryVersion !== 'string') patched.boundaryVersion = '0';
    if (typeof patched.firstRun !== 'string') patched.firstRun = 'none';
    if (typeof patched.legacyCanonicalRoot !== 'string' && selected[0]) patched.legacyCanonicalRoot = selected[0];
    current.update(patched);
    current.continue();
  };
}

function migrateP303(tx: IDBTransaction, maxBytes: number) {
  if (!tx.objectStoreNames.contains('replica_state')) return;
  const cursor = tx.objectStore('replica_state').openCursor();
  cursor.onsuccess = () => {
    const current = cursor.result;
    if (!current) {
      for (const name of ['replica_state', 'event_dedupe', 'leases']) {
        if (tx.db.objectStoreNames.contains(name)) tx.db.deleteObjectStore(name);
      }
      return;
    }
    const legacy = current.value as LegacyState;
    try {
      const scope: SyncScope = { environment: 'legacy', serverId: boundedString(legacy.serverId, 'serverId'),
        serverOrigin: 'https://legacy.invalid', accountId: 'legacy-unbound', browserProfileId: 'legacy-unbound',
        collectionId: boundedString(legacy.collectionId, 'collectionId'), replicaId: boundedString(legacy.replicaId, 'replicaId'),
        generation: safeInteger(legacy.generation, 'generation', 1) };
      const key = scopeKey(scope); const scopeRecord = validateScopeRecord({ ...scope, lifecycle: 'recovery_required',
        lease: { leaseId: 'legacy-unbound', expiresAt: 1 }, checkpoint: { serverRevision: 'legacy-unknown',
          cursor: boundedString(legacy.cursor, 'cursor') }, selectedRoots: [] }, maxBytes);
      tx.objectStore(STORES.scopes).put(scopeRecord); tx.objectStore(STORES.sequences).put({ scopeKey: key,
        next: safeInteger(legacy.nextSequence, 'nextSequence', 1) });
      const queued = legacy.queuedOperation; tx.objectStore(STORES.queue).put({ scopeKey: key,
        sequence: safeInteger(queued.sequence, 'sequence', 1), opId: boundedString(queued.opId, 'opId'),
        batchId: `legacy:${queued.sequence}`, idempotencyKey: `legacy:${queued.opId}`, digest: boundedString(queued.digest, 'digest'),
        endpointIdentity: 'syncPush', mediaType: 'application/json', baseRevision: null, operationRevision: 'legacy-unknown',
        status: 'deferred', retry: { attempt: 0, notBefore: 0 }, payload: { legacyEventId: queued.eventId } });
      const receipt = legacy.receipt; tx.objectStore(STORES.receipts).put({ scopeKey: key,
        receiptId: boundedString(receipt.receiptId, 'receiptId'), sequence: receipt.sequence, opId: receipt.opId,
        operationDigest: receipt.digest, kind: 'deferred', resultDigest: `legacy:${receipt.receiptId}` });
      tx.objectStore(STORES.cursors).put({ scopeKey: key, cursor: legacy.cursor, checkpoint: 'legacy-unknown',
        evidence: { receiptId: receipt.receiptId, operationDigest: receipt.digest, publishedCursor: receipt.publishedCursor } });
      tx.objectStore(STORES.mappings).put({ scopeKey: key, nativeId: legacy.nativeMapping.nativeId,
        colpId: legacy.nativeMapping.colpId, rootNativeId: 'legacy-unbound', projection: { revision: 'legacy-unknown',
          digest: `legacy:${legacy.nativeMapping.colpId}` } });
      tx.objectStore(STORES.intents).put({ scopeKey: key, ...legacy.applyIntent, operationId: `legacy:${legacy.applyIntent.intentId}`,
        expected: { kind: legacy.applyIntent.expectedMutation, nativeId: legacy.nativeMapping.nativeId }, expiresAt: 1 });
      tx.objectStore(STORES.diagnostics).put({ id: 'legacy-migration', scopeKey: key, kind: 'legacy_scope_requires_binding', scope });
    } catch (error) {
      tx.objectStore(STORES.diagnostics).put({ id: `legacy-failure:${String(current.primaryKey)}`, scopeKey: null,
        kind: 'migration_failed', error: stableCode(error) }); tx.abort(); return;
    }
    current.continue();
  };
}
