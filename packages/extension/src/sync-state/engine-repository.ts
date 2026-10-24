import {
  SyncStateError, type AckIntentRecord, type CommitImportPlanInput, type DurableSyncEngineState,
  type EnqueueImportNodeInput, type ImportNodeRecord, type ImportPlanRecord, type ImportRecoveryCode,
  type JsonObject, type QueueOperation, type SyncScope, type UnknownRecord,
} from './types.js';
import { boundedString, canonicalJson, clone, safeInteger, validateJson } from './codec.js';
import { cursorPage, cursorPageDescending, requestValue, requireActiveScope, runTransaction, scopeRowsRange, transactionDone } from './idb.js';
import { INDEXES, STORES } from './schema.js';
import { scopeKey, validateScope } from './scope-key.js';
import { validateQueueRecord } from './queue-validate.js';
import { sameAckIntent } from './engine-validate.js';
import { inheritFrozenEngineFacts } from './engine-transition.js';
import { validateAckIntent, validateEngineState, validateImportNode, validateImportPlan } from './pull-validate.js';
import type { CompactionWatermark } from '../sync-compaction.js';
import type { SyncStoreRuntime } from './runtime.js';

export function createEngineRepository(ctx: SyncStoreRuntime) {
  const maxRecordBytes = ctx.maxRecordBytes;

  const open = () => ctx.open();
  const writableDatabase = () => ctx.writableDatabase();
  const assertWritable = () => ctx.assertWritable();
  const readOne = (storeName: string, key: IDBValidKey) => ctx.readOne(storeName, key);

  async function commitImportPlan(input: SyncScope, planInput: CommitImportPlanInput): Promise<ImportPlanRecord> {
    assertWritable(); const key = scopeKey(validateScope(input)); const plan = validateImportPlan(key, planInput.plan, maxRecordBytes);
    const nodes = planInput.nodes.map((node) => validateImportNode(key, node, maxRecordBytes));
    if (nodes.length === 0) throw new SyncStateError('import_empty');
    if (nodes.some((node) => node.planId !== plan.planId)) throw new SyncStateError('import_plan_invalid');
    const identities = new Set(nodes.map((node) => node.sourceNodeId)); const opIds = new Set(nodes.map((node) => node.opId));
    if (identities.size !== nodes.length || opIds.size !== nodes.length) throw new SyncStateError('import_node_duplicate');
    const db = await writableDatabase(); let committed = plan;
    await runTransaction(db, [STORES.scopes, STORES.importPlans, STORES.importNodes], 'readwrite', async (tx) => {
      await requireActiveScope(tx, key); const plans = tx.objectStore(STORES.importPlans);
      const prior = await requestValue(plans.get([key, plan.planId])) as ImportPlanRecord | undefined;
      if (prior) {
        if (prior.conversionDigest !== plan.conversionDigest || prior.choiceDigest !== plan.choiceDigest) {
          throw new SyncStateError('import_plan_reuse');
        }
        committed = validateImportPlan(key, prior, maxRecordBytes); return;
      }
      plans.add(plan); const nodeStore = tx.objectStore(STORES.importNodes);
      for (const node of nodes) nodeStore.add(node);
    });
    return clone(committed);
  }

  async function listImportPlans(input: SyncScope): Promise<ImportPlanRecord[]> {
    const key = scopeKey(validateScope(input)); const db = await open(); const tx = db.transaction(STORES.importPlans, 'readonly');
    // W2A-08: the 100 most recently updated plans, not the first 100 by id (plans are never deleted, so a live
    // import would drop out of an id-ordered window). Handed back in id order, as before.
    const completion = transactionDone(tx); const values = await cursorPageDescending<ImportPlanRecord>(
      tx.objectStore(STORES.importPlans).index(INDEXES.importPlanByUpdated), scopeRowsRange(key), 100); await completion;
    return values.map((value) => clone(validateImportPlan(key, value, maxRecordBytes)))
      .sort((left, right) => left.planId < right.planId ? -1 : left.planId > right.planId ? 1 : 0);
  }

  async function listImportNodes(input: SyncScope, planId: string): Promise<ImportNodeRecord[]> {
    const key = scopeKey(validateScope(input)); boundedString(planId, 'planId'); const db = await open();
    const tx = db.transaction(STORES.importNodes, 'readonly'); const completion = transactionDone(tx);
    const values = await cursorPage<ImportNodeRecord>(tx.objectStore(STORES.importNodes).index(INDEXES.importNodeByPlanOrder),
      IDBKeyRange.bound([key, planId, 0], [key, planId, Number.MAX_SAFE_INTEGER]), 20_000); await completion;
    return values.map((value) => clone(validateImportNode(key, value, maxRecordBytes)));
  }

  async function setImportPlanState(input: SyncScope, planId: string, state: ImportPlanRecord['state'], updatedAt: number) {
    const key = scopeKey(validateScope(input)); boundedString(planId, 'planId'); safeInteger(updatedAt, 'updatedAt');
    if (!['active', 'paused', 'complete', 'attention'].includes(state)) throw new SyncStateError('import_state_invalid');
    const db = await writableDatabase(); await runTransaction(db, [STORES.scopes, STORES.importPlans], 'readwrite', async (tx) => {
      await requireActiveScope(tx, key); const plans = tx.objectStore(STORES.importPlans);
      const prior = await requestValue(plans.get([key, planId])) as ImportPlanRecord | undefined;
      if (!prior) throw new SyncStateError('import_plan_not_found'); plans.put({ ...prior, state, updatedAt });
    });
  }

  async function setImportNodeRecovery(input: SyncScope, planId: string, opId: string,
    recovery: ImportRecoveryCode | null): Promise<void> {
    const key = scopeKey(validateScope(input)); boundedString(planId, 'planId'); boundedString(opId, 'opId');
    const db = await writableDatabase(); await runTransaction(db, [STORES.scopes, STORES.importNodes], 'readwrite', async (tx) => {
      await requireActiveScope(tx, key); const nodes = tx.objectStore(STORES.importNodes);
      const rows = await cursorPage<ImportNodeRecord>(nodes.index(INDEXES.importNodeByPlanOrder),
        IDBKeyRange.bound([key, planId, 0], [key, planId, Number.MAX_SAFE_INTEGER]), 20_000);
      const node = rows.find((item) => item.opId === opId); if (!node) throw new SyncStateError('import_node_not_found');
      nodes.put({ ...node, status: recovery ? 'recoverable' : node.sequence ? 'queued' : 'staged',
        ...(recovery ? { recovery } : { recovery: undefined }) });
    });
  }

  async function retryImportNode(input: SyncScope, planId: string, opId: string): Promise<void> {
    const key = scopeKey(validateScope(input)); boundedString(planId, 'planId'); boundedString(opId, 'opId');
    const db = await writableDatabase(); await runTransaction(db,
      [STORES.scopes, STORES.importNodes, STORES.queue], 'readwrite', async (tx) => {
        await requireActiveScope(tx, key); const nodes = tx.objectStore(STORES.importNodes);
        const rows = await cursorPage<ImportNodeRecord>(nodes.index(INDEXES.importNodeByPlanOrder),
          IDBKeyRange.bound([key, planId, 0], [key, planId, Number.MAX_SAFE_INTEGER]), 20_000);
        const node = rows.find((item) => item.opId === opId); if (!node || node.status !== 'recoverable') {
          throw new SyncStateError('import_node_not_recoverable');
        }
        const queue = tx.objectStore(STORES.queue); const value = await requestValue(queue.index(INDEXES.queueByOpId).get([key, opId]));
        const queued = value ? validateQueueRecord(value, maxRecordBytes) : null;
        if (queued?.status === 'rejected') queue.put(validateQueueRecord({ ...queued, status: 'pending', recovery: undefined,
          attempt: undefined, retry: { attempt: queued.retry.attempt + 1, notBefore: 0 } }, maxRecordBytes));
        nodes.put({ ...node, status: node.sequence ? 'queued' : 'staged', recovery: undefined });
      });
  }

  async function enqueueImportNode(input: SyncScope, enqueue: EnqueueImportNodeInput): Promise<QueueOperation> {
    assertWritable(); const key = scopeKey(validateScope(input)); const planId = boundedString(enqueue.planId, 'planId');
    const sourceNodeId = boundedString(enqueue.sourceNodeId, 'sourceNodeId'); const occurredAt = boundedString(enqueue.occurredAt, 'occurredAt');
    const db = await writableDatabase(); let committed!: QueueOperation;
    await runTransaction(db, [STORES.scopes, STORES.sequences, STORES.queue, STORES.bookmarkEvents,
      STORES.importPlans, STORES.importNodes, STORES.engine, STORES.metadata], 'readwrite', async (tx) => {
      await requireActiveScope(tx, key); const plans = tx.objectStore(STORES.importPlans);
      const plan = await requestValue(plans.get([key, planId])) as ImportPlanRecord | undefined;
      if (!plan || plan.state !== 'active') throw new SyncStateError(plan?.state === 'paused' ? 'import_paused' : 'import_plan_inactive');
      const nodes = tx.objectStore(STORES.importNodes); const value = await requestValue(nodes.get([key, planId, sourceNodeId]));
      const node = value ? validateImportNode(key, value, maxRecordBytes) : null;
      if (!node || node.choice !== 'import') throw new SyncStateError('import_node_not_found');
      const queue = tx.objectStore(STORES.queue); const prior = await requestValue(queue.index(INDEXES.queueByOpId).get([key, node.opId]));
      if (prior) { committed = validateQueueRecord(prior, maxRecordBytes); return; }
      if (node.status !== 'staged' && node.status !== 'recoverable') throw new SyncStateError('import_node_state_invalid');
      const engine = await requestValue(tx.objectStore(STORES.engine).get(key)) as DurableSyncEngineState | undefined;
      if (engine?.recoveryFrozen) throw new SyncStateError('queue_recovery_frozen');
      const sequences = tx.objectStore(STORES.sequences); const counter = await requestValue(sequences.get(key)) as
        { scopeKey: string; next: number } | undefined; if (!counter) throw new SyncStateError('sequence_missing');
      const sequence = safeInteger(counter.next, 'sequence', 1); if (sequence === Number.MAX_SAFE_INTEGER) {
        throw new SyncStateError('sequence_exhausted');
      }
      const operation = { ...validateJson(clone(enqueue.operation), 'operation') as JsonObject, opId: node.opId,
        replicaId: input.replicaId, sequence, collectionId: input.collectionId, occurredAt };
      if (!enqueue.validateOperation(operation)) throw new SyncStateError('operation_schema_invalid');
      const digest = boundedString(enqueue.digestOperation(operation), 'operationDigest');
      committed = validateQueueRecord({ scopeKey: key, sequence, opId: node.opId, batchId: node.opId,
        idempotencyKey: node.opId, digest, endpointIdentity: 'syncPush', mediaType: 'application/json', baseRevision: null,
        operationRevision: `local-${node.opId}`, status: 'pending', retry: { attempt: 0, notBefore: 0 }, payload: operation }, maxRecordBytes);
      sequences.put({ scopeKey: key, next: sequence + 1 }); queue.add(committed);
      const metadata = tx.objectStore(STORES.metadata); const ordinalKey = `bookmark-event-ordinal:${key}`;
      const ordinalRecord = await requestValue(metadata.get(ordinalKey)) as { key: string; next: number } | undefined;
      const ordinal = ordinalRecord?.next ?? 1; metadata.put({ key: ordinalKey, next: ordinal + 1 });
      tx.objectStore(STORES.bookmarkEvents).add({ scopeKey: key, eventId: `import:${planId}:${sourceNodeId}`, ordinal,
        dedupeKey: `import:${planId}:${sourceNodeId}`, occurredAt, kind: 'create', nativeId: enqueue.nativeId,
        details: { importPlanId: planId }, status: 'processed', opId: node.opId });
      nodes.put({ ...node, status: 'queued', sequence, recovery: undefined }); plans.put({ ...plan, updatedAt: Date.parse(occurredAt) || plan.updatedAt });
    });
    return clone(committed);
  }

  async function listAckIntents(input: SyncScope) {
    const key = scopeKey(validateScope(input)); const db = await open();
    const tx = db.transaction(STORES.ackIntents, 'readonly'); const completion = transactionDone(tx);
    const values = await cursorPage<AckIntentRecord>(tx.objectStore(STORES.ackIntents), scopeRowsRange(key),
      Number.MAX_SAFE_INTEGER); await completion; return clone(values);
  }

  async function getEngineState(input: SyncScope): Promise<DurableSyncEngineState | null> {
    const key = scopeKey(validateScope(input)); const value = await readOne(STORES.engine, key);
    return value ? clone(validateEngineState(value)) : null;
  }

  async function transitionEngine(input: SyncScope, transition: Omit<DurableSyncEngineState, 'scopeKey' | 'revision'>
    & { readonly expectedRevision?: number }): Promise<DurableSyncEngineState> {
    assertWritable(); const key = scopeKey(validateScope(input)); const next = validateEngineState({ ...transition,
      scopeKey: key, revision: 1 }); const db = await writableDatabase(); let committed!: DurableSyncEngineState;
    await runTransaction(db, [STORES.scopes, STORES.engine], 'readwrite', async (tx) => {
      await requireActiveScope(tx, key); const engine = tx.objectStore(STORES.engine);
      const prior = await requestValue(engine.get(key)) as DurableSyncEngineState | undefined;
      if (transition.expectedRevision !== undefined && (prior?.revision ?? 0) !== transition.expectedRevision) {
        throw new SyncStateError('engine_revision_stale');
      }
      committed = validateEngineState({ ...next, revision: (prior?.revision ?? 0) + 1 }); engine.put(committed);
    }); return clone(committed);
  }

  async function claimRestartConnectivity(input: SyncScope, expectedRevision: number, now: number,
    timeoutMilliseconds: number): Promise<{ readonly outcome: 'claimed' | 'stale' | 'ineligible';
      readonly state: DurableSyncEngineState }> {
    assertWritable(); const key = scopeKey(validateScope(input)); safeInteger(expectedRevision, 'expectedRevision', 1);
    safeInteger(now, 'now'); safeInteger(timeoutMilliseconds, 'timeoutMilliseconds', 1_000);
    const db = await writableDatabase(); let outcome!: 'claimed' | 'stale' | 'ineligible';
    let committed!: DurableSyncEngineState;
    await runTransaction(db, [STORES.scopes, STORES.engine], 'readwrite', async (tx) => {
      await requireActiveScope(tx, key); const engines = tx.objectStore(STORES.engine);
      const value = await requestValue(engines.get(key)) as DurableSyncEngineState | undefined;
      if (!value) throw new SyncStateError('engine_state_missing'); const prior = validateEngineState(value);
      if (prior.revision !== expectedRevision) { outcome = 'stale'; committed = prior; return; }
      const eligibleNetworkBackoff = prior.phase === 'offline' && prior.lastError === 'network_unavailable'
        && !prior.recoveryFrozen && !prior.authorityRefreshRequired;
      const expiredClaim = eligibleNetworkBackoff && prior.connectivityConfirmationRevision !== undefined
        && prior.notBefore <= now;
      const freshNetworkBackoff = eligibleNetworkBackoff && prior.connectivityConfirmationRevision === undefined
        && prior.notBefore > now;
      if (!(expiredClaim || freshNetworkBackoff)) {
        outcome = 'ineligible'; committed = prior; return;
      }
      const revision = prior.revision + 1;
      committed = validateEngineState({ ...prior, phase: 'offline', revision, updatedAt: now,
        notBefore: now + timeoutMilliseconds, lastError: 'network_unavailable',
        connectivityConfirmationRevision: revision });
      engines.put(committed); outcome = 'claimed';
    });
    return { outcome, state: clone(committed) };
  }

  async function confirmRestartConnectivity(input: SyncScope, confirmationRevision: number,
    now: number): Promise<boolean> {
    assertWritable(); const key = scopeKey(validateScope(input)); safeInteger(confirmationRevision,
      'confirmationRevision', 1); safeInteger(now, 'now'); const db = await writableDatabase(); let confirmed = false;
    await runTransaction(db, [STORES.scopes, STORES.engine], 'readwrite', async (tx) => {
      await requireActiveScope(tx, key); const engines = tx.objectStore(STORES.engine);
      const value = await requestValue(engines.get(key)) as DurableSyncEngineState | undefined;
      if (!value) throw new SyncStateError('engine_state_missing'); const prior = validateEngineState(value);
      if (prior.connectivityConfirmationRevision !== confirmationRevision) return;
      const { connectivityConfirmationRevision: _confirmation, ...rest } = prior;
      engines.put(validateEngineState({ ...rest, revision: prior.revision + 1, updatedAt: now,
        notBefore: 0 })); confirmed = true;
    });
    return confirmed;
  }

  async function beginAckIntent(input: SyncScope, intentInput: Omit<AckIntentRecord, 'scopeKey' | 'state'>): Promise<AckIntentRecord> {
    assertWritable(); const key = scopeKey(validateScope(input)); const intent = validateAckIntent({ ...intentInput,
      scopeKey: key, state: 'pending' }); const db = await writableDatabase(); let committed = intent;
    await runTransaction(db, [STORES.scopes, STORES.cursors, STORES.ackIntents], 'readwrite', async (tx) => {
      await requireActiveScope(tx, key); const cursor = await requestValue(tx.objectStore(STORES.cursors).get(key)) as
        { readonly cursor?: string; readonly evidence?: UnknownRecord } | undefined;
      const durableKind = cursor?.evidence && (intent.kind === 'pull' ? typeof cursor.evidence.pullPageId === 'string'
        : typeof cursor.evidence.snapshotId === 'string');
      if (cursor?.cursor !== intent.cursor || !durableKind) throw new SyncStateError('ack_cursor_not_published');
      const intents = tx.objectStore(STORES.ackIntents); const prior = await requestValue(intents.get([key, intent.intentId])) as
        AckIntentRecord | undefined;
      if (prior) { if (!sameAckIntent(prior, intent)) throw new SyncStateError('ack_intent_reuse'); committed = prior; return; }
      const outstanding = await cursorPage<AckIntentRecord>(intents, scopeRowsRange(key), Number.MAX_SAFE_INTEGER);
      if (outstanding.some((item) => item.state === 'pending')) throw new SyncStateError('ack_pending'); intents.add(intent);
    }); return clone(committed);
  }

  async function getPendingAckIntent(input: SyncScope): Promise<AckIntentRecord | null> {
    const key = scopeKey(validateScope(input)); const db = await open(); const tx = db.transaction(STORES.ackIntents, 'readonly');
    const completion = transactionDone(tx); const rows = await cursorPage<AckIntentRecord>(tx.objectStore(STORES.ackIntents),
      scopeRowsRange(key), Number.MAX_SAFE_INTEGER); await completion;
    return clone(rows.find((item) => item.state === 'pending') ?? null);
  }

  async function completeAckIntent(input: SyncScope, intentId: string, resultInput: JsonObject): Promise<void> {
    assertWritable(); const key = scopeKey(validateScope(input)); const result = validateJson(resultInput, 'ack result') as JsonObject;
    const db = await writableDatabase(); await runTransaction(db, [STORES.scopes, STORES.ackIntents, STORES.compactionWatermarks], 'readwrite', async (tx) => {
      await requireActiveScope(tx, key); const intents = tx.objectStore(STORES.ackIntents);
      const intent = await requestValue(intents.get([key, boundedString(intentId, 'intentId')])) as AckIntentRecord | undefined;
      if (!intent) throw new SyncStateError('ack_intent_missing');
      if (result.ackedCursor !== intent.cursor) throw new SyncStateError('ack_result_mismatch');
      if (intent.state === 'complete') { if (canonicalJson(intent.result) !== canonicalJson(result)) {
        throw new SyncStateError('ack_result_mismatch'); } return; }
      intents.put(validateAckIntent({ ...intent, state: 'complete', result }));
      const watermarks = tx.objectStore(STORES.compactionWatermarks);
      const prior = await requestValue(watermarks.get(key)) as CompactionWatermark | undefined;
      watermarks.put({ scopeKey: key, queueThroughSequence: 0, eventThroughOrdinal: 0,
        compactedAt: 0, remainingEligible: false, ...prior,
        latestCompleteAck: { ...prior?.latestCompleteAck, [intent.kind]: intent.intentId } });
    });
  }

  async function discardPullAckIntent(input: SyncScope, intentId: string): Promise<void> {
    assertWritable(); const key = scopeKey(validateScope(input)); const id = boundedString(intentId, 'intentId');
    const db = await writableDatabase();
    await runTransaction(db, [STORES.scopes, STORES.ackIntents], 'readwrite', async (tx) => {
      await requireActiveScope(tx, key); const intents = tx.objectStore(STORES.ackIntents);
      const intent = await requestValue(intents.get([key, id])) as AckIntentRecord | undefined;
      // Only a pending pull intent may be abandoned: its cursor stays durably published, and the
      // next Pull under the current Session re-issues an ackable cursor for the same tuple.
      // Bootstrap intents own the recovery cutover and must go through the explicit reject path.
      if (!intent || intent.kind !== 'pull' || intent.state !== 'pending') {
        throw new SyncStateError('pull_ack_discard_invalid');
      }
      intents.delete([key, id]);
    });
  }

  async function rejectBootstrapAckAndRequireAuthorityRefresh(input: SyncScope, intentId: string,
    transition: { readonly sessionId: string; readonly updatedAt: number; readonly notBefore: number;
      readonly errorCode: string; readonly expectedRevision?: number }): Promise<void> {
    assertWritable(); const key = scopeKey(validateScope(input)); const id = boundedString(intentId, 'intentId');
    const sessionId = boundedString(transition.sessionId, 'sessionId'); const updatedAt = safeInteger(transition.updatedAt, 'updatedAt');
    const notBefore = safeInteger(transition.notBefore, 'notBefore'); const errorCode = boundedString(transition.errorCode, 'errorCode');
    const expectedRevision = transition.expectedRevision === undefined ? undefined
      : safeInteger(transition.expectedRevision, 'expectedRevision', 1);
    const db = await writableDatabase(); await runTransaction(db,
      [STORES.scopes, STORES.ackIntents, STORES.engine], 'readwrite', async (tx) => {
      await requireActiveScope(tx, key); const intents = tx.objectStore(STORES.ackIntents);
      const intent = await requestValue(intents.get([key, id])) as AckIntentRecord | undefined;
      if (!intent || intent.kind !== 'bootstrap' || intent.state !== 'pending') {
        throw new SyncStateError('bootstrap_ack_discard_invalid');
      }
      intents.delete([key, id]);
      const engines = tx.objectStore(STORES.engine);
      // SR-06: the intent delete and the freeze commit together, so the engine write is
      // its own read-modify-write and needs its own CAS. `transitionEngine` is not
      // reachable from inside this bare transaction, so the expectation is checked here:
      // the caller's read is only trusted while the durable revision still matches.
      const prior = await requestValue(engines.get(key)) as DurableSyncEngineState | undefined;
      if (expectedRevision !== undefined && (prior?.revision ?? 0) !== expectedRevision) {
        throw new SyncStateError('engine_revision_stale');
      }
      // Re-state every optional cursor/connectivity fact (SR-06): this path previously
      // kept only `lastAckedCursor`, so a rejected bootstrap Ack silently erased the
      // published cursor and the push-receipt cursors the replica had actually reached.
      engines.put(validateEngineState({ scopeKey: key, phase: 'recovery', revision: (prior?.revision ?? 0) + 1,
        updatedAt, sessionId, recoveryFrozen: true, authorityRefreshRequired: true, notBefore,
        ...inheritFrozenEngineFacts(prior), lastError: errorCode }));
    });
  }

  return { commitImportPlan, listImportPlans, listImportNodes, setImportPlanState, setImportNodeRecovery,
    retryImportNode, enqueueImportNode, listAckIntents, getEngineState, transitionEngine,
    claimRestartConnectivity, confirmRestartConnectivity, beginAckIntent, getPendingAckIntent,
    completeAckIntent, discardPullAckIntent, rejectBootstrapAckAndRequireAuthorityRefresh };
}
