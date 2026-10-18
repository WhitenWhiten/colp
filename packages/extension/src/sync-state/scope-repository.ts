import {
  SyncStateError, type AckIntentRecord, type BookmarkEventRecord, type DurableSyncEngineState,
  type ImportNodeRecord, type ImportPlanRecord, type IntentRecord, type LegacyState, type LeaseRecord,
  type QueueOperation, type ReceiptRecord, type RecoveryHeader, type RecoveryNodeRecord, type ScopeRecord,
  type SyncScope, type UnknownRecord, type MountBindingRecord, type ScopePreviewRecord, type BootstrapRunRecord,
  type DeletionJournalRecord, type RemoteObservationRecord, type ScopeCommandPlanRecord,
} from './types.js';
import { boundedString, clone, safeInteger, strictObject, validateRecord } from './codec.js';
import { constraintError } from './errors.js';
import {
  cursorPage, deleteScopeRows, iterateCursor, requestValue, requireActiveScope, runTransaction,
  scopeRowsRange, transactionDone,
} from './idb.js';
import { AUTHORITY_DIGEST, DATABASE_NAME, DATABASE_VERSION, INDEXES, SCOPE_ROW_STORES, STORES, structuralProblems } from './schema.js';
import {
  SCOPE_FIELDS, scopeKey, validLifecycleTransition, validateAccountScope, validateScope, validateScopeRecord,
} from './scope-key.js';
import { validateMapping } from './mapping-repository.js';
import { validateBookmarkEventRecord } from './bookmark-event-repository.js';
import { validateAckIntent, validateEngineState } from './pull-validate.js';
import { validateQueueRecord } from './queue-validate.js';
import type { SyncStoreRuntime } from './runtime.js';

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
    batchPlans, batchItems, remoteObservations, scopeCommandPlans] = await Promise.all([
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
    rows<ScopeCommandPlanRecord>(STORES.scopeCommandPlans)]);
  const compactionWatermark = await requestValue(tx.objectStore(STORES.compactionWatermarks).get(key));
  const diagnostics = await requestValue<UnknownRecord[]>(tx.objectStore(STORES.diagnostics)
    .index(INDEXES.diagnosticByScope).getAll(IDBKeyRange.bound([key, ''], [key, '\uffff'])));
  const remoteDeletePolicy = await requestValue(tx.objectStore(STORES.remoteDeletePolicies).get(key));
  return { diagnostics, scope: scope ?? null, sequence: sequence ?? null, mappings, queue, receipts, cursor: cursor ?? null, intents,
    recovery: recoveryHeaders[0] ?? null, recoveryNodes, bookmarkEvents, pullPages, pullEvents, effectPages,
    engine: engine ?? null, ackIntents, importPlans, importNodes,
    compactionWatermark: compactionWatermark ?? null, compactSummaries, mountBindings, scopePreviews, bootstrapRuns,
    deletionJournal, advancedPlans, advancedSteps, remoteDeletePolicy: remoteDeletePolicy ?? null,
    remoteDeleteDecisions, localSyncExclusions, batchPlans, batchItems, remoteObservations, scopeCommandPlans };
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
    const values = await cursorPage<UnknownRecord>(tx.objectStore(STORES.archives), scopeRowsRange(key), 1);
    await completion; if (!values[0]) throw new SyncStateError('archive_not_found'); return clone(values[0]);
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
    let db: IDBDatabase;
    try { db = await open(); }
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
      STORES.cursors, STORES.intents, STORES.recovery, STORES.recoveryNodes, STORES.leases, STORES.bookmarkEvents,
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
    try { scopes.forEach((record) => validateScopeRecord(record, maxRecordBytes));
      queue.forEach((record) => validateQueueRecord(record, maxRecordBytes));
      bookmarkEvents.forEach((record) => validateBookmarkEventRecord(record, maxRecordBytes));
      engines.forEach(validateEngineState); ackIntents.forEach(validateAckIntent);
      [...mappings, ...receipts, ...intents, ...pullPages, ...pullEvents, ...effectPages]
        .forEach((record) => validateRecord(record, Math.max(maxRecordBytes, 2 * 1024 * 1024))); }
    catch { problems.push('bad_record'); }
    if (problems.length) {
      tx.objectStore(STORES.diagnostics).put({ id: `integrity:${Date.now()}`, scopeKey: null, kind: 'corruption', problems });
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
