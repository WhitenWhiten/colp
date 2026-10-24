import {
  SyncStateError, type AckIntentRecord, type BookmarkEventRecord, type DurableSyncEngineState,
  type ImportNodeRecord, type ImportPlanRecord, type IntentRecord, type LegacyState, type LeaseRecord,
  type QueueOperation, type ReceiptRecord, type RecoveryHeader, type RecoveryNodeRecord, type ScopeRecord,
  type SyncScope, type UnknownRecord, type MountBindingRecord, type ScopePreviewRecord, type BootstrapRunRecord,
  type DeletionJournalRecord, type RemoteObservationRecord, type ScopeCommandPlanRecord,
} from './types.js';
import { boundedString, clone, safeInteger, strictObject, validateRecord } from './codec.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import {
  cursorPage, deleteScopeRows, iterateCursor, requestValue, requireActiveScope, runTransaction,
  scopeRowsRange, transactionDone,
} from './idb.js';
import { AUTHORITY_DIGEST, DATABASE_NAME, DATABASE_VERSION, INDEXES, SCOPE_ROW_STORES, STORES, structuralProblems } from './schema.js';
import {
  SCOPE_FIELDS, scopeKey, validLifecycleTransition, validateAccountScope, validateScope, validateScopeRecord,
} from './scope-key.js';
import { validateMapping, validateMappingRecord } from './mapping-repository.js';
import { validateBookmarkEventRecord } from './bookmark-event-repository.js';
import { validateAckIntent, validateEngineState, validateImportNode, validateImportPlan, validateIntent } from './pull-validate.js';
import { validateQueueRecord, validateReceipt } from './queue-validate.js';
import type { SyncStoreRuntime } from './runtime.js';

/** Bounded corruption evidence: enough records to repair a cluster, never a ledger dump. */
export const INTEGRITY_DETAIL_LIMIT = 32;
const INTEGRITY_PAGE_STATES: ReadonlySet<string> = new Set(['staged', 'blocked', 'page_complete']);
const INTEGRITY_EVENT_STATES: ReadonlySet<string> = new Set(['staged', 'intent_prepared', 'browser_call_started',
  'native_event_observed', 'awaiting_confirmation', 'authority_committed', 'page_complete', 'blocked']);

/** Account/server identity is not corruption evidence; a stable digest still separates scopes. */
function integrityScope(scopeKeyValue: unknown): string {
  if (typeof scopeKeyValue !== 'string') return 'no-scope';
  return bytesToHex(sha256(new TextEncoder().encode(scopeKeyValue))).slice(0, 16);
}

function integrityField(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0 && value.length <= 4_096) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  return undefined;
}

/** Only the durable key/id fields: never titles, URLs, bodies, or notes. */
export function integrityRecordKey(store: string, record: UnknownRecord): string {
  const fields = (names: readonly string[]) => names.flatMap((name) => {
    const value = integrityField(record[name]);
    return value === undefined ? [] : [`${name}=${value}`];
  }).join(',');
  switch (store) {
    case STORES.scopes: return record.scopeKey === undefined ? 'scopeKey=?'
      : `scopeKey=${integrityScope(record.scopeKey)}`;
    case STORES.queue: return fields(['sequence', 'opId']) || 'sequence=?';
    case STORES.receipts: return fields(['receiptId', 'sequence']) || 'receiptId=?';
    case STORES.bookmarkEvents: return fields(['eventId']) || 'eventId=?';
    case STORES.mappings: return fields(['nativeId', 'colpId']) || 'mapping=?';
    case STORES.pullPages: return fields(['pageId']) || 'pageId=?';
    case STORES.pullEvents: return fields(['eventId']) || 'eventId=?';
    case STORES.effectPages: return fields(['eventId', 'pageNumber']) || 'effectPage=?';
    case STORES.engine: return 'engine';
    case STORES.ackIntents: return fields(['intentId']) || 'intentId=?';
    case STORES.importPlans: return fields(['planId']) || 'planId=?';
    case STORES.importNodes: return fields(['planId', 'sourceNodeId']) || 'importNode=?';
    case STORES.recovery: return fields(['snapshotId']) || 'snapshotId=?';
    case STORES.recoveryNodes: return fields(['snapshotId', 'colpId']) || 'recoveryNode=?';
    default: return fields(['id']) || 'key=?';
  }
}

function integrityCode(error: unknown): string {
  if (error instanceof SyncStateError) return error.code;
  if (error instanceof DOMException) return error.name;
  if (error instanceof Error) {
    const code = (error as { readonly code?: unknown }).code;
    return typeof code === 'string' ? code : 'record_invalid';
  }
  return 'record_invalid';
}

function integrityDetail(store: string, record: unknown, error: unknown) {
  const value = record && typeof record === 'object' && !Array.isArray(record) ? record as UnknownRecord : {};
  return { store, key: integrityRecordKey(store, value), scope: integrityScope(value.scopeKey), code: integrityCode(error) };
}

/** One record's validation failure never stops the remaining critical record types. */
function validateIntegrityRecord<T>(store: string, record: T, validate: (record: T) => void,
  failures: { count: number; details: unknown[] }) {
  try { validate(record); } catch (error) {
    failures.count += 1;
    if (failures.details.length < INTEGRITY_DETAIL_LIMIT) failures.details.push(integrityDetail(store, record, error));
  }
}

function validatePullPageIntegrity(record: UnknownRecord, maxBytes: number): void {
  validateRecord(record, maxBytes);
  if (typeof record.scopeKey !== 'string' || typeof record.pageId !== 'string'
      || !INTEGRITY_PAGE_STATES.has(String(record.state))
      || typeof record.previousCursor !== 'string' || typeof record.nextCursor !== 'string'
      || typeof record.pageDigest !== 'string') throw new SyncStateError('pull_page_invalid');
}

function validatePullEventIntegrity(record: UnknownRecord, maxBytes: number): void {
  validateRecord(record, maxBytes);
  if (typeof record.scopeKey !== 'string' || typeof record.eventId !== 'string' || typeof record.pageId !== 'string'
      || !INTEGRITY_EVENT_STATES.has(String(record.state)) || !Number.isSafeInteger(record.ordinal)
      || typeof record.payload !== 'object' || record.payload === null || Array.isArray(record.payload)) {
    throw new SyncStateError('pull_event_invalid');
  }
}

function validateEffectPageIntegrity(record: UnknownRecord, maxBytes: number): void {
  validateRecord(record, maxBytes);
  if (typeof record.scopeKey !== 'string' || typeof record.eventId !== 'string'
      || !Number.isSafeInteger(record.pageNumber) || (record.pageNumber as number) < 1
      || typeof record.pageDigest !== 'string'
      || (record.previousPageDigest !== null && typeof record.previousPageDigest !== 'string')) {
    throw new SyncStateError('effect_page_invalid');
  }
}

function validateRecoveryHeaderIntegrity(record: UnknownRecord, maxBytes: number): void {
  validateRecord(record, maxBytes);
  if (typeof record.scopeKey !== 'string' || typeof record.snapshotId !== 'string'
      || typeof record.revision !== 'string' || typeof record.syncCursor !== 'string'
      || typeof record.identityDigest !== 'string' || typeof record.rootNodeId !== 'string'
      || !Number.isSafeInteger(record.lastPage) || (record.lastPage as number) < 0
      || typeof record.lastPageDigest !== 'string' || typeof record.complete !== 'boolean'
      || (record.nextCursor !== null && typeof record.nextCursor !== 'string')
      || (record.sessionId !== null && record.sessionId !== undefined && typeof record.sessionId !== 'string')) {
    throw new SyncStateError('recovery_header_invalid');
  }
}

function validateRecoveryNodeIntegrity(record: UnknownRecord, maxBytes: number): void {
  validateRecord(record, maxBytes);
  if (typeof record.scopeKey !== 'string' || typeof record.snapshotId !== 'string'
      || !Number.isSafeInteger(record.page) || (record.page as number) < 0 || typeof record.colpId !== 'string'
      || (record.parentId !== null && typeof record.parentId !== 'string') || typeof record.position !== 'string'
      || !['Folder', 'Bookmark', 'Separator'].includes(String(record.kind))
      || typeof record.payloadDigest !== 'string' || !record.mapping || typeof record.mapping !== 'object'
      || Array.isArray(record.mapping)) throw new SyncStateError('recovery_node_invalid');
  validateMappingRecord(record.scopeKey, record.mapping, maxBytes);
}

/**
 * Stored intents carry `scopeKey` as their primary-key component, while
 * `validateIntent` takes the scope separately and applies the full domain
 * shape. Strip only that routing field and validate the rest strictly.
 */
function validateIntentIntegrity(record: UnknownRecord, maxBytes: number): void {
  if (typeof record.scopeKey !== 'string') throw new SyncStateError('intent_scope_invalid');
  const { scopeKey, ...input } = record;
  validateIntent(scopeKey, input, maxBytes);
}

export function legacyDiagnosticRecord(state: LegacyState, maxBytes: number) {
  validateRecord(state, maxBytes);
  const serverId = boundedString(state.serverId, 'serverId'); const collectionId = boundedString(state.collectionId, 'collectionId');
  const replicaId = boundedString(state.replicaId, 'replicaId'); safeInteger(state.generation, 'generation', 1);
  const queued = state.queuedOperation; const receipt = state.receipt; const intent = state.applyIntent;
  const scope = { serverId, collectionId, replicaId, generation: state.generation };
  return { queue: { ...scope, sequence: safeInteger(queued.sequence, 'sequence', 1), opId: boundedString(queued.opId, 'opId'),
    digest: boundedString(queued.digest, 'digest'), acknowledged: queued.acknowledged === true },
  receipt: { ...scope, sequence: safeInteger(receipt.sequence, 'receipt sequence', 1), receiptId: boundedString(receipt.receiptId, 'receiptId'),
    opId: boundedString(receipt.opId, 'receipt opId'), operationDigest: boundedString(receipt.digest, 'receipt digest') },
  intent: { ...scope, intentId: boundedString(intent.intentId, 'intentId'), correlationId: boundedString(intent.correlationId, 'correlationId'),
    status: boundedString(intent.status, 'intent status') } };
}
export function validCursorAuthority(record: UnknownRecord, scopeKeys: ReadonlySet<string>,
  receipts: ReadonlyMap<string, ReceiptRecord>, pullPages: ReadonlyMap<string, unknown>) {
  if (typeof record.scopeKey !== 'string' || !scopeKeys.has(record.scopeKey)
    || typeof record.cursor !== 'string' || typeof record.checkpoint !== 'string') return false;
  const evidence = record.evidence;
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return false;
  const value = evidence as UnknownRecord;
  if (typeof value.receiptId === 'string' && typeof value.operationDigest === 'string') {
    return receipts.get(`${record.scopeKey}\u001f${value.receiptId}`)?.operationDigest === value.operationDigest;
  }
  if (typeof value.pullPageId === 'string' && typeof value.pageDigest === 'string') {
    return pullPages.get(`${record.scopeKey}\u001f${value.pullPageId}`) === value.pageDigest;
  }
  return typeof value.snapshotId === 'string' && typeof value.pageDigest === 'string';
}
export async function collectExport(tx: IDBTransaction, key: string) { const scope = await requestValue(tx.objectStore(STORES.scopes).get(key)) as ScopeRecord | undefined;
  const sequence = await requestValue(tx.objectStore(STORES.sequences).get(key)); const cursor = await requestValue(tx.objectStore(STORES.cursors).get(key));
  const engine = await requestValue(tx.objectStore(STORES.engine).get(key));
  const rows = async <T>(name: string) => { const values: T[] = []; await iterateCursor(tx.objectStore(name), scopeRowsRange(key),
    (value) => { values.push(value as T); }); return values; };
  const [mappings, queue, receipts, intents, recoveryHeaders, recoveryNodes, bookmarkEvents, pullPages, pullEvents,
    effectPages, ackIntents, importPlans, importNodes, compactSummaries, mountBindings, scopePreviews, bootstrapRuns,
    deletionJournal, advancedPlans, advancedSteps, remoteDeleteDecisions, localSyncExclusions,
    batchPlans, batchItems, remoteObservations, scopeCommandPlans, deleteMembers] = await Promise.all([
    rows<ReturnType<typeof validateMapping>>(STORES.mappings), rows<QueueOperation>(STORES.queue),
    rows<ReceiptRecord>(STORES.receipts), rows<IntentRecord>(STORES.intents), rows<RecoveryHeader>(STORES.recovery),
    rows<RecoveryNodeRecord>(STORES.recoveryNodes), rows<BookmarkEventRecord>(STORES.bookmarkEvents),
    rows<UnknownRecord>(STORES.pullPages), rows<UnknownRecord>(STORES.pullEvents), rows<UnknownRecord>(STORES.effectPages),
    rows<AckIntentRecord>(STORES.ackIntents), rows<ImportPlanRecord>(STORES.importPlans),
    rows<ImportNodeRecord>(STORES.importNodes), rows<UnknownRecord>(STORES.compactSummaries),
    rows<MountBindingRecord>(STORES.mounts), rows<ScopePreviewRecord>(STORES.previews),
    rows<BootstrapRunRecord>(STORES.bootstrapRuns), rows<DeletionJournalRecord>(STORES.deletionJournal),
    rows<UnknownRecord>(STORES.advancedPlans), rows<UnknownRecord>(STORES.advancedSteps),
    rows<UnknownRecord>(STORES.remoteDeleteDecisions), rows<UnknownRecord>(STORES.localSyncExclusions),
    rows<UnknownRecord>(STORES.batchPlans), rows<UnknownRecord>(STORES.batchItems),
    rows<RemoteObservationRecord>(STORES.remoteObservations),
    rows<ScopeCommandPlanRecord>(STORES.scopeCommandPlans), rows<UnknownRecord>(STORES.deleteMembers)]);
  const compactionWatermark = await requestValue(tx.objectStore(STORES.compactionWatermarks).get(key));
  const diagnostics = await requestValue<UnknownRecord[]>(tx.objectStore(STORES.diagnostics)
    .index(INDEXES.diagnosticByScope).getAll(IDBKeyRange.bound([key, ''], [key, '\uffff'])));
  const remoteDeletePolicy = await requestValue(tx.objectStore(STORES.remoteDeletePolicies).get(key));
  return { diagnostics, scope: scope ?? null, sequence: sequence ?? null, mappings, queue, receipts, cursor: cursor ?? null, intents,
    recovery: recoveryHeaders[0] ?? null, recoveryNodes, bookmarkEvents, pullPages, pullEvents, effectPages,
    engine: engine ?? null, ackIntents, importPlans, importNodes,
    compactionWatermark: compactionWatermark ?? null, compactSummaries, mountBindings, scopePreviews, bootstrapRuns,
    deletionJournal, advancedPlans, advancedSteps, remoteDeletePolicy: remoteDeletePolicy ?? null,
    remoteDeleteDecisions, localSyncExclusions, batchPlans, batchItems, remoteObservations, scopeCommandPlans, deleteMembers };
}

export function createScopeRepository(ctx: SyncStoreRuntime) {
  const maxRecordBytes = ctx.maxRecordBytes;
  const durableCache = ctx.durableCache;
  const open = () => ctx.open();
  const writableDatabase = () => ctx.writableDatabase();
  const assertWritable = () => ctx.assertWritable();
  const readOne = (storeName: string, key: IDBValidKey) => ctx.readOne(storeName, key);
  const factory = ctx.factory;
  const close = () => ctx.close();
  async function registerScope(input: Omit<ScopeRecord, 'scopeKey'>): Promise<ScopeRecord> {
    assertWritable(); let scope = validateScopeRecord(input, maxRecordBytes); const db = await writableDatabase();
    await runTransaction(db, [STORES.scopes, STORES.sequences, STORES.archives, STORES.cursors,
      STORES.ackIntents, STORES.recovery, STORES.engine, STORES.metadata], 'readwrite', async (tx) => {
      const scopes = tx.objectStore(STORES.scopes); const existing = await requestValue(scopes.get(scope.scopeKey));
      const retired = await cursorPage(tx.objectStore(STORES.archives), scopeRowsRange(scope.scopeKey), 1);
      if (retired.length) throw new SyncStateError('scope_retired');
      if (existing) {
        const prior = validateScopeRecord(existing, maxRecordBytes);
        if (prior.lifecycle === 'retired') throw new SyncStateError('scope_retired');
        if (prior.replicaId !== scope.replicaId || prior.generation !== scope.generation) throw new SyncStateError('identity_conflict');
        if (!validLifecycleTransition(prior.lifecycle, scope.lifecycle)) throw new SyncStateError('lifecycle_transition_invalid');
        scope = { ...scope, selectedRoots: prior.selectedRoots, privateRoots: prior.privateRoots,
          rootStatus: prior.rootStatus, mountMode: prior.mountMode, boundaryVersion: prior.boundaryVersion,
          firstRun: prior.firstRun,
          ...(prior.legacyCanonicalRoot === undefined ? {} : { legacyCanonicalRoot: prior.legacyCanonicalRoot }) };
        const previousLeaseGeneration = prior.lease.generation; const nextLeaseGeneration = scope.lease.generation;
        if (previousLeaseGeneration !== undefined && nextLeaseGeneration !== undefined
            && previousLeaseGeneration !== nextLeaseGeneration) {
          if (!/^(?:0|[1-9][0-9]*)$/u.test(previousLeaseGeneration)
              || !/^(?:0|[1-9][0-9]*)$/u.test(nextLeaseGeneration)
              || BigInt(nextLeaseGeneration) !== BigInt(previousLeaseGeneration) + 1n
              || !prior.checkpoint || !scope.checkpoint) {
            throw new SyncStateError('lease_authority_invalid');
          }
          const cursorStore = tx.objectStore(STORES.cursors);
          const currentCursor = await requestValue(cursorStore.get(scope.scopeKey)) as UnknownRecord | undefined;
          const ackIntents = await cursorPage<AckIntentRecord>(tx.objectStore(STORES.ackIntents),
            scopeRowsRange(scope.scopeKey), Number.MAX_SAFE_INTEGER);
          const recovery = await cursorPage<RecoveryHeader>(tx.objectStore(STORES.recovery),
            scopeRowsRange(scope.scopeKey), 1);
          const engineStore = tx.objectStore(STORES.engine);
          const engine = await requestValue(engineStore.get(scope.scopeKey)) as DurableSyncEngineState | undefined;
          const priorEvidence = currentCursor?.evidence && typeof currentCursor.evidence === 'object'
            ? currentCursor.evidence as UnknownRecord : {};
          // FIX-M-012: the recovery capability is bound to the staged Snapshot cursor evidence and
          // is acknowledged through the stable page syncCursor; legacy records carried the
          // capability in the cursor itself. Either binding satisfies the completed-recovery
          // activation, and a non-recovery cursor must never activate a generation handoff.
          const evidenceBound = typeof priorEvidence.capability === 'string'
            && priorEvidence.capability.startsWith('src1.');
          const legacyCursorBound = typeof currentCursor?.cursor === 'string'
            && currentCursor.cursor.startsWith('src1.');
          const completedRecoveryActivation = typeof currentCursor?.cursor === 'string'
            && currentCursor.cursor === prior.checkpoint.cursor
            && (evidenceBound || legacyCursorBound)
            && recovery.length === 0 && engine?.recoveryFrozen === true && engine.authorityRefreshRequired === true
            && ackIntents.some((intent) => intent.kind === 'bootstrap' && intent.state === 'complete'
              && intent.cursor === currentCursor.cursor);
          // Recovery Snapshot already stages the next generation's cursor. Its Ack
          // activates that same cursor; only ordinary expired-lease resume needs a
          // newly issued cursor. Neither path may bypass durable recovery evidence.
          if (prior.checkpoint.cursor === scope.checkpoint.cursor && !completedRecoveryActivation
              || currentCursor?.cursor !== prior.checkpoint.cursor || recovery.length > 0
              || ackIntents.some((intent) => intent.state !== 'complete')
              || (engine?.recoveryFrozen || engine?.authorityRefreshRequired) && !completedRecoveryActivation) {
            throw new SyncStateError('lease_authority_invalid');
          }
          cursorStore.put({ ...currentCursor, cursor: scope.checkpoint.cursor,
            checkpoint: scope.checkpoint.serverRevision, evidence: { ...priorEvidence, sessionAuthority: true } });
          if (engine) {
            const { lastError: _lastError, ...stable } = engine;
            engineStore.put({ ...stable, lastPublishedCursor: scope.checkpoint.cursor,
              lastAckedCursor: scope.checkpoint.cursor });
          }
        } else {
          // A renewed Session advertises server authority, not a local Pull/
          // Snapshot commit. Preserve the durable checkpoint until a validated
          // generation handoff or an explicit cursor transaction advances it.
          scope = { ...scope, checkpoint: prior.checkpoint };
        }
      }
      if (!existing) {
        // Fresh scopes cannot contain legacy receipts. New settlements write their
        // rejection projections atomically; only pre-existing scopes need adoption.
        tx.objectStore(STORES.metadata).put({ key: `consumed-rejections-v1:${scope.scopeKey}`, complete: true });
      }
      scopes.put(scope);
      if (!await requestValue(tx.objectStore(STORES.sequences).get(scope.scopeKey))) {
        tx.objectStore(STORES.sequences).add({ scopeKey: scope.scopeKey, next: 1 });
      }
    });
    durableCache.set(scope.scopeKey, clone(scope)); return clone(scope);
  }

  async function getScope(input: SyncScope): Promise<ScopeRecord | null> {
    const key = scopeKey(validateScope(input)); const value = await readOne(STORES.scopes, key);
    return value ? clone(validateScopeRecord(value, maxRecordBytes)) : null;
  }

  async function retireScope(input: SyncScope, retirement: { readonly retiredAt: number; readonly reason: string }) {
    assertWritable(); const key = scopeKey(validateScope(input)); safeInteger(retirement.retiredAt, 'retiredAt');
    boundedString(retirement.reason, 'reason'); const db = await writableDatabase();
    await runTransaction(db, [...SCOPE_ROW_STORES, STORES.archives, STORES.diagnostics],
      'readwrite', async (tx) => {
      const current = await requireActiveScope(tx, key); const archive = await collectExport(tx, key);
      tx.objectStore(STORES.archives).add({ ...archive, scopeKey: key, environment: current.environment,
        serverId: current.serverId, accountId: current.accountId, browserProfileId: current.browserProfileId,
        replicaId: current.replicaId, generation: current.generation, lifecycle: 'retired', ...retirement });
      for (const name of SCOPE_ROW_STORES) {
        await deleteScopeRows(tx.objectStore(name), key);
      }
      await iterateCursor(tx.objectStore(STORES.diagnostics).index(INDEXES.diagnosticByScope),
        IDBKeyRange.bound([key, ''], [key, '\uffff']), (_row, cursor) => { cursor.delete(); });
    }); durableCache.delete(key);
  }

  async function cleanupAccount(account: Pick<SyncScope, 'environment' | 'serverId' | 'accountId' | 'browserProfileId'>) {
    assertWritable(); const fields = validateAccountScope(account); const db = await writableDatabase();
    const tx = db.transaction(Object.values(STORES), 'readwrite'); const completion = transactionDone(tx);
    const scopes = tx.objectStore(STORES.scopes);
    const keys: string[] = [];
    await iterateCursor(scopes, null, (value) => { const row = value as ScopeRecord;
      if (row.environment === fields.environment && row.serverId === fields.serverId && row.accountId === fields.accountId
        && row.browserProfileId === fields.browserProfileId && row.lifecycle !== 'retired') keys.push(row.scopeKey); });
    const retiredAt = Date.now();
    for (const key of keys) {
      const current = await requestValue(scopes.get(key)) as ScopeRecord;
      const archive = await collectExport(tx, key);
      tx.objectStore(STORES.archives).add({ ...archive, scopeKey: key, environment: current.environment,
        serverId: current.serverId, accountId: current.accountId, browserProfileId: current.browserProfileId,
        replicaId: current.replicaId, generation: current.generation, lifecycle: 'retired', retiredAt,
        reason: 'logout_cleanup' });
      for (const name of SCOPE_ROW_STORES) {
        await deleteScopeRows(tx.objectStore(name), key);
      }
      await iterateCursor(tx.objectStore(STORES.diagnostics).index(INDEXES.diagnosticByScope),
        IDBKeyRange.bound([key, ''], [key, '\uffff']), (_row, cursor) => { cursor.delete(); });
    }
    await completion;
    for (const key of keys) durableCache.delete(key);
  }

  async function exportScope(input: SyncScope) {
    const key = scopeKey(validateScope(input)); const db = await open(); const tx = db.transaction(Object.values(STORES), 'readonly');
    const completion = transactionDone(tx); const result = await collectExport(tx, key); await completion; return clone(result);
  }

  async function exportArchive(input: SyncScope) {
    const key = scopeKey(validateScope(input)); const db = await open(); const tx = db.transaction(STORES.archives, 'readonly');
    const completion = transactionDone(tx);
    // The newest archive of the scope: a scope key retired once before must not hide the reset that just ran (B-13).
    const newest = await requestValue(tx.objectStore(STORES.archives).openCursor(scopeRowsRange(key), 'prev'));
    await completion; if (!newest) throw new SyncStateError('archive_not_found'); return clone(newest.value as UnknownRecord);
  }

  function peekDurableCache(input: SyncScope) { return clone(durableCache.get(scopeKey(validateScope(input))) ?? null); }

  async function importPreformalBinding(input: Record<string, unknown>): Promise<SyncScope> {
    const value = strictObject(clone(input), ['schemaVersion', 'source', ...SCOPE_FIELDS.filter((field) => field !== 'serverOrigin'),
      'serverOrigin', 'leaseId', 'leaseExpiresAt', 'leaseGeneration', 'checkpoint'], 'preformal', ['leaseGeneration']);
    if (value.schemaVersion !== 0 || value.source !== 'p3-27-chrome-storage-binding') throw new SyncStateError('preformal_invalid');
    const imported = validateScope(Object.fromEntries(SCOPE_FIELDS.map((field) => [field, value[field]])));
    const checkpoint = strictObject(value.checkpoint, ['serverRevision', 'serverCursor'], 'preformal checkpoint');
    await registerScope({ ...imported, lifecycle: 'active', lease: { leaseId: boundedString(value.leaseId, 'leaseId'),
      expiresAt: safeInteger(value.leaseExpiresAt, 'leaseExpiresAt', 1), ...(value.leaseGeneration === undefined ? {} : {
        generation: boundedString(value.leaseGeneration, 'leaseGeneration') }) }, checkpoint: {
        serverRevision: boundedString(checkpoint.serverRevision, 'serverRevision'),
        cursor: boundedString(checkpoint.serverCursor, 'serverCursor'),
      }, selectedRoots: [] });
    return imported;
  }

  async function seedLegacyForMigration(fixture: { readonly schemaVersion: number; readonly state: LegacyState }): Promise<void> {
    close(); const request = factory.open(DATABASE_NAME, fixture.schemaVersion);
    request.onupgradeneeded = () => {
      const db = request.result; const replica = db.createObjectStore('replica_state',
        { keyPath: ['serverId', 'collectionId', 'replicaId'] }); replica.put(clone(fixture.state));
      if (fixture.schemaVersion >= 2) {
        db.createObjectStore('event_dedupe', { keyPath: ['serverId', 'collectionId', 'replicaId', 'eventId'] });
        db.createObjectStore('leases', { keyPath: ['serverId', 'collectionId', 'replicaId'] });
        db.createObjectStore('schema_metadata', { keyPath: 'key' });
      }
    };
    const db = await requestValue(request); db.close();
  }

  async function exportLegacyDiagnostic() {
    if (ctx.isUpgradeFailed()) return readFailedLegacyDiagnostic();

    try { await open(); }
    catch (error) {
      if (error instanceof SyncStateError && error.code === 'upgrade_failed') return readFailedLegacyDiagnostic();
      throw error;
    }
    const marker = await readOne(STORES.diagnostics, 'legacy-migration');
    if (!marker) return { unackedQueue: [], receipts: [], intents: [] };
    const legacyScope = (marker as { readonly scope: SyncScope }).scope; const exported = await exportScope(legacyScope);
    return { unackedQueue: exported.queue, receipts: exported.receipts, intents: exported.intents };
  }

  async function readFailedLegacyDiagnostic() {
    const request = factory.open(DATABASE_NAME); request.onupgradeneeded = () => request.transaction?.abort();
    const db = await requestValue(request);
    try {
      if (!db.objectStoreNames.contains('replica_state')) throw new SyncStateError('legacy_store_missing');
      const tx = db.transaction('replica_state', 'readonly'); const completion = transactionDone(tx);
      const states = await cursorPage<LegacyState>(tx.objectStore('replica_state'), null, 100); await completion;
      const records = states.map((state) => legacyDiagnosticRecord(state, maxRecordBytes));
      return { unackedQueue: records.map((record) => record.queue), receipts: records.map((record) => record.receipt),
        intents: records.map((record) => record.intent) };
    } finally { db.close(); }
  }

  async function injectCorruptionForTest(kind: string, input: SyncScope) {
    const key = scopeKey(validateScope(input)); const db = await open(); const tx = db.transaction(STORES.receipts, 'readwrite');
    const completion = transactionDone(tx);
    if (kind === 'orphan_receipt') tx.objectStore(STORES.receipts).put({ scopeKey: key, receiptId: 'orphan', sequence: 999,
      opId: 'orphan', operationDigest: 'sha256:orphan', kind: 'terminal', resultDigest: 'sha256:orphan' });
    await completion;
  }

  async function auditIntegrity() {
    const db = await open(); const structural = structuralProblems(db);
    if (structural.length) { ctx.setDiagnosticReadOnly(); throw new SyncStateError('corruption_detected'); }
    const tx = db.transaction([STORES.scopes, STORES.mappings, STORES.sequences, STORES.queue, STORES.receipts,
      STORES.cursors, STORES.intents, STORES.deleteMembers, STORES.recovery, STORES.recoveryNodes, STORES.leases, STORES.bookmarkEvents,
      STORES.pullPages, STORES.pullEvents, STORES.effectPages, STORES.engine, STORES.ackIntents,
      STORES.importPlans, STORES.importNodes, STORES.diagnostics, STORES.metadata], 'readwrite');
    const completion = transactionDone(tx);
    const metadata = await requestValue(tx.objectStore(STORES.metadata).get('schema')) as UnknownRecord | undefined;
    const problems: string[] = [];
    if (!metadata || metadata.version !== DATABASE_VERSION || metadata.authorityDigest !== AUTHORITY_DIGEST) problems.push('schema_metadata');
    const scopes = await cursorPage<ScopeRecord>(tx.objectStore(STORES.scopes), null, Number.MAX_SAFE_INTEGER);
    const mappings = await cursorPage<ReturnType<typeof validateMapping>>(tx.objectStore(STORES.mappings), null, Number.MAX_SAFE_INTEGER);
    const sequences = await cursorPage<{ readonly scopeKey: string; readonly next: number }>(
      tx.objectStore(STORES.sequences), null, Number.MAX_SAFE_INTEGER);
    const receipts = await cursorPage<ReceiptRecord>(tx.objectStore(STORES.receipts), null, Number.MAX_SAFE_INTEGER);
    const queue = await cursorPage<QueueOperation>(tx.objectStore(STORES.queue), null, Number.MAX_SAFE_INTEGER);
    const cursors = await cursorPage<UnknownRecord>(tx.objectStore(STORES.cursors), null, Number.MAX_SAFE_INTEGER);
    const intents = await cursorPage<IntentRecord>(tx.objectStore(STORES.intents), null, Number.MAX_SAFE_INTEGER);
    const deleteMembers = await cursorPage<UnknownRecord>(tx.objectStore(STORES.deleteMembers), null, Number.MAX_SAFE_INTEGER);
    const recovery = await cursorPage<RecoveryHeader>(tx.objectStore(STORES.recovery), null, Number.MAX_SAFE_INTEGER);
    const recoveryNodes = await cursorPage<RecoveryNodeRecord>(tx.objectStore(STORES.recoveryNodes), null, Number.MAX_SAFE_INTEGER);
    const leases = await cursorPage<LeaseRecord>(tx.objectStore(STORES.leases), null, Number.MAX_SAFE_INTEGER);
    const bookmarkEvents = await cursorPage<BookmarkEventRecord>(tx.objectStore(STORES.bookmarkEvents), null,
      Number.MAX_SAFE_INTEGER);
    const pullPages = await cursorPage<UnknownRecord>(tx.objectStore(STORES.pullPages), null, Number.MAX_SAFE_INTEGER);
    const pullEvents = await cursorPage<UnknownRecord>(tx.objectStore(STORES.pullEvents), null, Number.MAX_SAFE_INTEGER);
    const effectPages = await cursorPage<UnknownRecord>(tx.objectStore(STORES.effectPages), null, Number.MAX_SAFE_INTEGER);
    const engines = await cursorPage<DurableSyncEngineState>(tx.objectStore(STORES.engine), null, Number.MAX_SAFE_INTEGER);
    const ackIntents = await cursorPage<AckIntentRecord>(tx.objectStore(STORES.ackIntents), null, Number.MAX_SAFE_INTEGER);
    const importPlans = await cursorPage<ImportPlanRecord>(tx.objectStore(STORES.importPlans), null, Number.MAX_SAFE_INTEGER);
    const importNodes = await cursorPage<ImportNodeRecord>(tx.objectStore(STORES.importNodes), null, Number.MAX_SAFE_INTEGER);
    const scopeKeys = new Set(scopes.map((record) => record.scopeKey));
    if ([...importPlans, ...importNodes].some((record) => !scopeKeys.has(record.scopeKey))) problems.push('orphan_import');
    const queueKeys = new Set(queue.map((record) => `${record.scopeKey}\u001f${record.sequence}`));
    const queueBindings = new Map(queue.map((record) => [`${record.scopeKey}\u001f${record.sequence}`,
      `${record.opId}\u001f${record.digest}`]));
    if (receipts.some((receipt) => !queueKeys.has(`${receipt.scopeKey}\u001f${receipt.sequence}`)
      || queueBindings.get(`${receipt.scopeKey}\u001f${receipt.sequence}`) !== `${receipt.opId}\u001f${receipt.operationDigest}`)) {
      problems.push('orphan_receipt');
    }
    const receiptKeys = new Set(receipts.map((receipt) => `${receipt.scopeKey}\u001f${receipt.sequence}`));
    if (queue.some((record) => (record.status === 'terminal' || record.status === 'deferred')
      && !receiptKeys.has(`${record.scopeKey}\u001f${record.sequence}`))) problems.push('missing_receipt');
    const maxSequence = new Map<string, number>();
    for (const record of queue) maxSequence.set(record.scopeKey, Math.max(maxSequence.get(record.scopeKey) ?? 0, record.sequence));
    if (sequences.some((record) => !scopeKeys.has(record.scopeKey) || !Number.isSafeInteger(record.next)
      || record.next <= (maxSequence.get(record.scopeKey) ?? 0))) problems.push('sequence_invalid');
    if (mappings.some((record) => !scopeKeys.has(record.scopeKey)) || leases.some((record) => !scopeKeys.has(record.scopeKey))) {
      problems.push('orphan_scope_fact');
    }
    const receiptsById = new Map(receipts.map((receipt) => [`${receipt.scopeKey}\u001f${receipt.receiptId}`, receipt]));
    const pullPageDigests = new Map(pullPages.map((page) => [`${page.scopeKey}\u001f${page.pageId}`, page.pageDigest]));
    const pullPageKeys = new Set(pullPageDigests.keys());
    const pullEventKeys = new Set(pullEvents.map((event) => `${event.scopeKey}\u001f${event.eventId}`));
    if (cursors.some((record) => !validCursorAuthority(record, scopeKeys, receiptsById, pullPageDigests))) problems.push('cursor_evidence_invalid');
    if (intents.some((intent) => !scopeKeys.has(intent.scopeKey))) problems.push('orphan_intent');
    const intentKeys = new Set(intents.map(intent => JSON.stringify([intent.scopeKey, intent.intentId])));
    if (deleteMembers.some(row => !intentKeys.has(JSON.stringify([row.scopeKey, row.intentId])))) problems.push('orphan_delete_member');
    if (engines.some((engine) => !scopeKeys.has(engine.scopeKey))
        || ackIntents.some((intent) => !scopeKeys.has(intent.scopeKey))) problems.push('orphan_engine_fact');
    const queueOpIds = new Set(queue.map((record) => `${record.scopeKey}\u001f${record.opId}`));
    if (bookmarkEvents.some((event) => !scopeKeys.has(event.scopeKey) || (event.status === 'processed'
      && !queueOpIds.has(`${event.scopeKey}\u001f${event.opId}`)))) problems.push('orphan_bookmark_event');
    const recoveryKeys = new Set(recovery.map((record) => `${record.scopeKey}\u001f${record.snapshotId}`));
    if (recoveryNodes.some((node) => !recoveryKeys.has(`${node.scopeKey}\u001f${node.snapshotId}`))) problems.push('orphan_page');
    if (pullEvents.some((event) => !pullPageKeys.has(`${event.scopeKey}\u001f${event.pageId}`))
      || effectPages.some((page) => !pullPageKeys.has(`${page.scopeKey}\u001f${page.pageId}`)
        || !pullEventKeys.has(`${page.scopeKey}\u001f${page.eventId}`))) problems.push('orphan_pull_fact');
    // T10: validate every critical record type independently, so the first bad
    // row no longer hides the rest. Each failure records its store, stable key,
    // scope digest and code; the bounded list never contains record content.
    const maxIntegrityBytes = Math.max(maxRecordBytes, 2 * 1024 * 1024);
    const failures = { count: 0, details: [] as unknown[] };
    const validateRows = <T>(store: string, rows: readonly T[], validate: (record: T) => void) => {
      for (const record of rows) validateIntegrityRecord(store, record, validate, failures);
    };
    const scopeOf = (record: unknown) => String((record as UnknownRecord | undefined)?.scopeKey ?? '');
    const sequenceOf = (record: unknown) => {
      const sequence = (record as UnknownRecord | undefined)?.sequence;
      return Number.isSafeInteger(sequence) ? sequence as number : 0;
    };
    validateRows(STORES.scopes, scopes, (record) => validateScopeRecord(record, maxRecordBytes));
    validateRows(STORES.queue, queue, (record) => validateQueueRecord(record, maxRecordBytes));
    validateRows(STORES.bookmarkEvents, bookmarkEvents, (record) => validateBookmarkEventRecord(record, maxRecordBytes));
    validateRows(STORES.mappings, mappings, (record) => validateMappingRecord(scopeOf(record), record, maxRecordBytes));
    validateRows(STORES.receipts, receipts, (record) => validateReceipt(scopeOf(record), sequenceOf(record), record, maxRecordBytes));
    validateRows(STORES.intents, intents, (record) => validateIntentIntegrity(record as unknown as UnknownRecord, maxIntegrityBytes));
    validateRows(STORES.deleteMembers, deleteMembers, record => validateRecord(record, maxRecordBytes));
    validateRows(STORES.pullPages, pullPages, (record) => validatePullPageIntegrity(record, maxIntegrityBytes));
    validateRows(STORES.pullEvents, pullEvents, (record) => validatePullEventIntegrity(record, maxIntegrityBytes));
    validateRows(STORES.effectPages, effectPages, (record) => validateEffectPageIntegrity(record, maxIntegrityBytes));
    validateRows(STORES.recovery, recovery, (record) => validateRecoveryHeaderIntegrity(record as unknown as UnknownRecord, maxIntegrityBytes));
    validateRows(STORES.recoveryNodes, recoveryNodes, (record) => validateRecoveryNodeIntegrity(record as unknown as UnknownRecord, maxIntegrityBytes));
    validateRows(STORES.engine, engines, validateEngineState);
    validateRows(STORES.ackIntents, ackIntents, validateAckIntent);
    validateRows(STORES.importPlans, importPlans, (record) => validateImportPlan(scopeOf(record), record, maxRecordBytes));
    validateRows(STORES.importNodes, importNodes, (record) => validateImportNode(scopeOf(record), record, maxRecordBytes));
    if (failures.count > 0) problems.push('bad_record');
    if (problems.length) {
      tx.objectStore(STORES.diagnostics).put({ id: `integrity:${Date.now()}`, scopeKey: null, kind: 'corruption', problems,
        ...(failures.details.length === 0 ? {} : { details: failures.details,
          truncated: failures.count > failures.details.length }) });
      await completion; ctx.setDiagnosticReadOnly(); throw new SyncStateError('corruption_detected');
    }
    await completion; return { outcome: 'valid' };
  }

  async function exportDiagnostics() {
    const db = await open(); const structural = structuralProblems(db);
    if (structural.length) return clone({ mode: 'diagnostic_read_only', records: [{ id: 'structural', scopeKey: null,
      kind: 'corruption', problems: structural }] });
    const tx = db.transaction(STORES.diagnostics, 'readonly'); const completion = transactionDone(tx);
    const records = await cursorPage<UnknownRecord>(tx.objectStore(STORES.diagnostics), null, 1_000); await completion;
    return clone({ mode: ctx.isDiagnosticReadOnly() ? 'diagnostic_read_only' : 'normal', records });
  }

  return { registerScope, getScope, retireScope, cleanupAccount, exportScope, exportArchive,
    peekDurableCache, importPreformalBinding, seedLegacyForMigration, exportLegacyDiagnostic,
    injectCorruptionForTest, auditIntegrity, exportDiagnostics };
}
