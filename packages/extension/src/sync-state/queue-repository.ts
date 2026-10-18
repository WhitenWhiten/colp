import { conflictResolutionBindings } from './conflict-resolution-bindings.js';
import { parkedOutOfLane } from './queue-set-aside-repository.js';
import { enqueueParentIds, enqueueTargetId, findBlockingUnsettledAttempt,
  firstLiveQueueRow } from './queue-live-work.js';
import {
  SyncStateError, type DurableSyncEngineState, type FaultOptions, type JsonObject, type LeaseRecord, type LeaseResult,
  type PushSettlement, type QueueOperation, type ReceiptInput, type SyncScope, type UnknownRecord, type MappingInput,
} from './types.js';
import { boundedString, clone, safeInteger, validateJson } from './codec.js';
import { constraintError, inject } from './errors.js';
import {
  cursorPage, iterateCursor, requestValue, requireActiveScope, runTransaction, scopeRowsRange, transactionDone,
} from './idb.js';
import { INDEXES, STORES } from './schema.js';
import { scopeKey, validateScope } from './scope-key.js';
import {
  sameQueueOperation, sameReceipt, validatePushAttempt, validatePushSettlement, validateQueueInput,
  validateQueueRecord, validateReceipt,
} from './queue-validate.js';
import { validateCursor, validateEngineState } from './pull-validate.js';
import { readAllQueueRowsByTarget, stampColpQueueRecord } from './queue-target.js';
import { rebindCreateInTransaction, rebindProjectionInTransaction, assertAuthoritativeCreateReceipt,
  assertAuthoritativeProjectionReceipt, validateMapping } from './mapping-repository.js';
import { settleImportNode, unavailableImportOpIds } from './import-settle.js';
import type { SyncStoreRuntime } from './runtime.js';



export async function settleResolvedConflictQueue(tx: IDBTransaction, key: string, event: UnknownRecord, maxBytes: number) {
  const bindings = conflictResolutionBindings(event);
  const queueStore = tx.objectStore(STORES.queue);
  for (const binding of bindings) {
    const raw = await requestValue(queueStore.index(INDEXES.queueByOpId).get([key, binding.opId]));
    if (!raw) continue;
    const queued = validateQueueRecord(raw, maxBytes);
    if (queued.status === 'terminal' && queued.echoApplied === true) continue;
    if (queued.status !== 'terminal' && (queued.status !== 'blocked' || queued.recovery?.code !== 'conflict_pending')) {
      throw new SyncStateError('conflict_resolution_binding_invalid');
    }
    const receiptRaw = await requestValue(tx.objectStore(STORES.receipts).index('by_scope_sequence')
      .get([key, queued.sequence]));
    const receipt = receiptRaw ? validateReceipt(key, queued.sequence, receiptRaw, maxBytes) : null;
    const results = Array.isArray(receipt?.result?.results) ? receipt.result.results : [];
    const matched = results.some((candidate) => candidate && typeof candidate === 'object' && !Array.isArray(candidate)
      && (candidate as UnknownRecord).opId === binding.opId
      && (binding.conflictId === undefined || (candidate as UnknownRecord).conflictId === binding.conflictId)
      && ['conflicted', 'conflict'].includes(String((candidate as UnknownRecord).status)));
    if (!matched) throw new SyncStateError('conflict_resolution_binding_invalid');
    queueStore.put(validateQueueRecord({ ...queued, status: 'terminal', echoApplied: true, recovery: undefined }, maxBytes));
  }
}

/** Every bounded queue read shares one ceiling and one error code. */
function boundedLimit(limit?: number): void {
  if (limit === undefined) return;
  safeInteger(limit, 'limit', 1);
  if (limit > 1_000) throw new SyncStateError('limit_exceeded');
}

export function createQueueRepository(ctx: SyncStoreRuntime) {
  const maxRecordBytes = ctx.maxRecordBytes;
  const durableCache = ctx.durableCache;
  const open = () => ctx.open();
  const writableDatabase = () => ctx.writableDatabase();
  const assertWritable = () => ctx.assertWritable();
  const readOne = (storeName: string, key: IDBValidKey) => ctx.readOne(storeName, key);
  const factory = ctx.factory;
  const close = () => ctx.close();
  async function allocateSequenceAndEnqueue(input: SyncScope, operationInput: Omit<QueueOperation, 'sequence' | 'scopeKey'>,
    faults: FaultOptions & {
      readonly validateOperation?: (operation: JsonObject) => boolean;
      readonly digestOperation?: (operation: JsonObject) => string;
      readonly allowUnstamped?: boolean;
      readonly provisionalCreateMapping?: MappingInput;
    } = {}): Promise<QueueOperation> {
    assertWritable(); const key = scopeKey(validateScope(input));
    const stampValidate = typeof faults.validateOperation === 'function' ? faults.validateOperation : undefined;
    const stampDigest = typeof faults.digestOperation === 'function' ? faults.digestOperation : undefined;
    if (!stampValidate !== !stampDigest || (!stampValidate && faults.allowUnstamped !== true)) {
      throw new SyncStateError('operation_validator_missing');
    }
    const operation = validateQueueInput(key, operationInput, maxRecordBytes);
    const provisional = faults.provisionalCreateMapping
      ? validateMapping(key, faults.provisionalCreateMapping, maxRecordBytes) : undefined;
    if (provisional && (operation.payload.type !== 'create_node' || provisional.colpId !== `pending-${operation.opId}`
        || provisional.projection.revision !== `local-${operation.opId}`)) throw new SyncStateError('provisional_mapping_binding_invalid');
    const db = await writableDatabase(); let committed!: QueueOperation;
    try { await runTransaction(db, [STORES.scopes, STORES.sequences, STORES.queue, STORES.engine, STORES.mappings, STORES.deletionJournal], 'readwrite', async (tx) => {
      await requireActiveScope(tx, key); const queue = tx.objectStore(STORES.queue);
      const engine = await requestValue(tx.objectStore(STORES.engine).get(key)) as DurableSyncEngineState | undefined;
      if (engine?.recoveryFrozen) throw new SyncStateError('queue_recovery_frozen');
      const prior = await requestValue(queue.index(INDEXES.queueByOpId).get([key, operation.opId])) as QueueOperation | undefined;
      if (prior) {
        if (!stampValidate && !sameQueueOperation(prior, operation)) throw new SyncStateError('op_id_reuse');
        committed = prior; return;
      }
      if (provisional && (await cursorPage(tx.objectStore(STORES.deletionJournal),
        IDBKeyRange.bound([key, provisional.nativeId, 1], [key, provisional.nativeId, Number.MAX_SAFE_INTEGER]), 1)).length) {
        throw new SyncStateError('bootstrap_native_removed');
      }
      // F010: an unsettled attempt only holds an operation that really depends
      // on it (same canonical target or a parent it writes into). The durable
      // queue still drains in sequence order, so dependent work cannot overtake
      // its predecessor on the wire.
      const targetId = enqueueTargetId(operation.payload);
      if (await findBlockingUnsettledAttempt(queue, key, { ...(targetId === undefined ? {} : { targetId }),
        parentIds: enqueueParentIds(operation.payload) })) {
        throw new SyncStateError('exact_retry_pending');
      }
      const sequences = tx.objectStore(STORES.sequences);
      const counter = await requestValue(sequences.get(key)) as { scopeKey: string; next: number } | undefined;
      if (!counter) throw new SyncStateError('sequence_missing');
      const sequence = safeInteger(counter.next, 'sequence', 1);
      if (sequence === Number.MAX_SAFE_INTEGER) throw new SyncStateError('sequence_exhausted');
      committed = stampValidate && stampDigest
        ? stampColpQueueRecord(input, key, operation, sequence, maxRecordBytes, stampValidate, stampDigest)
        : { ...operation, scopeKey: key, sequence };
      sequences.put({ scopeKey: key, next: sequence + 1 }); inject(faults.fault, 'after_sequence', tx);
      queue.add(committed); inject(faults.fault, 'after_queue', tx);
      if (provisional) {
        const mappings = tx.objectStore(STORES.mappings);
        if (await requestValue(mappings.get([key, provisional.nativeId]))) throw new SyncStateError('mapping_identity_collision');
        mappings.add(provisional); inject(faults.fault, 'after_mapping', tx);
      }
      if (faults.fault === 'quota') { tx.abort(); throw new SyncStateError('quota_exceeded'); }
    }); } catch (error) { throw constraintError(error); }
    if (faults.fault === 'unknown_commit') throw new SyncStateError('commit_outcome_unknown');
    durableCache.set(key, { sequence: committed.sequence, opId: committed.opId }); return clone(committed);
  }

  async function advanceSequenceFloor(input: SyncScope, nextSequence: number): Promise<void> {
    assertWritable(); const key = scopeKey(validateScope(input)); safeInteger(nextSequence, 'nextSequence', 1);
    const db = await writableDatabase();
    await runTransaction(db, [STORES.scopes, STORES.sequences], 'readwrite', async (tx) => {
      await requireActiveScope(tx, key);
      const sequences = tx.objectStore(STORES.sequences);
      const counter = await requestValue(sequences.get(key)) as { scopeKey: string; next: number } | undefined;
      if (!counter) throw new SyncStateError('sequence_missing');
      if (counter.next < nextSequence) sequences.put({ scopeKey: key, next: nextSequence });
    });
  }

  async function listQueue(input: SyncScope, status?: QueueOperation['status'], afterSequence = 0, limit = 100): Promise<QueueOperation[]> {
    const key = scopeKey(validateScope(input)); safeInteger(afterSequence, 'afterSequence'); boundedLimit(limit);
    const db = await open(); const tx = db.transaction(STORES.queue, 'readonly'); const store = tx.objectStore(STORES.queue);
    const completion = transactionDone(tx);
    const source = status ? store.index(INDEXES.queueByStatusSequence) : store.index(INDEXES.queueBySequence);
    if (afterSequence === Number.MAX_SAFE_INTEGER) return [];
    const range = status ? IDBKeyRange.bound([key, status, afterSequence + 1], [key, status, Number.MAX_SAFE_INTEGER])
      : IDBKeyRange.bound([key, afterSequence + 1], [key, Number.MAX_SAFE_INTEGER]);
    const values = await cursorPage<QueueOperation>(source, range, limit); await completion;
    return values.map((value) => clone(validateQueueRecord(value, maxRecordBytes)));
  }

  /** One target's rows, paged to completion; see {@link readAllQueueRowsByTarget}. */
  async function listQueueByTarget(input: SyncScope, targetId: string): Promise<QueueOperation[]> {
    return clone(await readAllQueueRowsByTarget(await open(), input, targetId, maxRecordBytes));
  }

  async function getQueueByOpId(input: SyncScope, opId: string): Promise<QueueOperation | null> {
    const key = scopeKey(validateScope(input)); boundedString(opId, 'opId');
    const db = await open(); const tx = db.transaction(STORES.queue, 'readonly'); const completion = transactionDone(tx);
    const value = await requestValue(tx.objectStore(STORES.queue).index(INDEXES.queueByOpId).get([key, opId]));
    await completion; return value ? clone(validateQueueRecord(value, maxRecordBytes)) : null;
  }

  async function getQueueReceipt(input: SyncScope, sequence: number) {
    const key = scopeKey(validateScope(input)); safeInteger(sequence, 'sequence', 1);
    const db = await open(); const tx = db.transaction(STORES.receipts, 'readonly'); const completion = transactionDone(tx);
    const value = await requestValue(tx.objectStore(STORES.receipts).index('by_scope_sequence').get([key, sequence]));
    await completion; return value ? clone(validateReceipt(key, sequence, value, maxRecordBytes)) : null;
  }

  async function completeQueueWithReceipt(input: SyncScope, sequence: number, receiptInput: ReceiptInput,
    faults: FaultOptions = {}): Promise<void> {
    assertWritable(); const key = scopeKey(validateScope(input)); safeInteger(sequence, 'sequence', 1);
    const receipt = validateReceipt(key, sequence, receiptInput, maxRecordBytes); const db = await writableDatabase();
    try { await runTransaction(db, [STORES.scopes, STORES.queue, STORES.receipts, STORES.importPlans, STORES.importNodes],
      'readwrite', async (tx) => {
      await requireActiveScope(tx, key); const queue = tx.objectStore(STORES.queue);
      const queued = await requestValue(queue.index(INDEXES.queueBySequence).get([key, sequence])) as QueueOperation | undefined;
      if (!queued) throw new SyncStateError('queue_not_found');
      if (queued.opId !== receipt.opId || queued.digest !== receipt.operationDigest) throw new SyncStateError('digest_mismatch');
      const receipts = tx.objectStore(STORES.receipts);
      const prior = await requestValue(receipts.get([key, receipt.receiptId])) as typeof receipt | undefined;
      if (prior && !sameReceipt(prior, receipt)) throw new SyncStateError('receipt_id_reuse');
      if (!prior) receipts.add(receipt);
      inject(faults.fault, 'after_receipt', tx);
      queue.put({ ...queued, status: receipt.kind });
      await settleImportNode(tx, key, queued.opId, receipt.kind, receipt.result);
    }); } catch (error) { throw constraintError(error); }
    if (faults.fault === 'unknown_commit') throw new SyncStateError('commit_outcome_unknown');
    durableCache.set(key, { receiptId: receipt.receiptId, sequence });
  }

  async function completeClaimedQueueWithReceipt(input: SyncScope, sequence: number, ownerId: string, fence: number,
    receiptInput: ReceiptInput): Promise<void> {
    assertWritable(); const key = scopeKey(validateScope(input)); safeInteger(sequence, 'sequence', 1);
    boundedString(ownerId, 'ownerId'); safeInteger(fence, 'fence', 1);
    const receipt = validateReceipt(key, sequence, receiptInput, maxRecordBytes); const db = await writableDatabase();
    try { await runTransaction(db, [STORES.scopes, STORES.leases, STORES.queue, STORES.receipts,
      STORES.importPlans, STORES.importNodes], 'readwrite', async (tx) => {
      await requireActiveScope(tx, key); const lease = await requestValue(tx.objectStore(STORES.leases).get(key)) as LeaseRecord | undefined;
      const queue = tx.objectStore(STORES.queue); const queued = await requestValue(
        queue.index(INDEXES.queueBySequence).get([key, sequence])) as QueueOperation | undefined;
      if (!lease || lease.ownerId !== ownerId || lease.fence !== fence || !queued || queued.status !== 'claimed'
        || queued.retry.ownerId !== ownerId || queued.retry.fence !== fence) throw new SyncStateError('stale_fence');
      if (queued.opId !== receipt.opId || queued.digest !== receipt.operationDigest) throw new SyncStateError('digest_mismatch');
      const receipts = tx.objectStore(STORES.receipts);
      const prior = await requestValue(receipts.get([key, receipt.receiptId])) as typeof receipt | undefined;
      if (prior && !sameReceipt(prior, receipt)) throw new SyncStateError('receipt_id_reuse');
      if (!prior) receipts.add(receipt);
      queue.put({ ...queued, status: receipt.kind });
      await settleImportNode(tx, key, queued.opId, receipt.kind, receipt.result);
    }); } catch (error) { throw constraintError(error); }
    durableCache.set(key, { receiptId: receipt.receiptId, sequence, fence });
  }

  async function publishCursor(input: SyncScope, cursorInput: { readonly cursor: string; readonly checkpoint: string;
    readonly evidence: { readonly receiptId: string; readonly operationDigest: string } }, faults: FaultOptions = {}): Promise<void> {
    assertWritable(); const key = scopeKey(validateScope(input)); const cursor = validateCursor(key, cursorInput, maxRecordBytes);
    const db = await writableDatabase(); await runTransaction(db, [STORES.scopes, STORES.receipts, STORES.cursors], 'readwrite', async (tx) => {
      await requireActiveScope(tx, key);
      const receipt = await requestValue(tx.objectStore(STORES.receipts).get([key, cursor.evidence.receiptId]));
      if (!receipt || (receipt as { operationDigest: string }).operationDigest !== cursor.evidence.operationDigest) {
        throw new SyncStateError('cursor_evidence_unbound');
      }
      tx.objectStore(STORES.cursors).put(cursor); inject(faults.fault, 'after_cursor', tx);
    }); durableCache.set(key, { cursor: cursor.cursor });
  }

  async function acquireLease(input: SyncScope, ownerId: string, now: number, duration: number) {
    assertWritable(); const key = scopeKey(validateScope(input)); boundedString(ownerId, 'ownerId');
    safeInteger(now, 'now'); safeInteger(duration, 'duration', 1); const db = await writableDatabase(); let result: LeaseResult | undefined;
    await runTransaction(db, [STORES.scopes, STORES.leases], 'readwrite', async (tx) => {
      await requireActiveScope(tx, key); const leases = tx.objectStore(STORES.leases);
      const prior = await requestValue(leases.get(key)) as LeaseRecord | undefined;
      if (prior && prior.expiresAt > now && prior.ownerId !== ownerId) {
        result = { outcome: 'contended', ownerId: prior.ownerId, fence: prior.fence,
          expiresAt: prior.expiresAt }; return;
      }
      const fence = prior ? safeInteger(prior.fence, 'fence', 1) + 1 : 1;
      const expiresAt = safeInteger(now + duration, 'expiresAt', 1);
      leases.put({ scopeKey: key, ownerId, fence, expiresAt }); result = { outcome: 'acquired', ownerId, fence, expiresAt };
    }); if (!result) throw new SyncStateError('lease_result_missing'); return clone(result);
  }

  async function renewLease(input: SyncScope, ownerId: string, fence: number, now: number, duration: number) {
    assertWritable(); const key = scopeKey(validateScope(input)); boundedString(ownerId, 'ownerId');
    safeInteger(fence, 'fence', 1); safeInteger(now, 'now'); safeInteger(duration, 'duration', 1);
    const db = await writableDatabase(); let renewed = false; let expiresAt = 0;
    await runTransaction(db, [STORES.scopes, STORES.leases], 'readwrite', async (tx) => {
      await requireActiveScope(tx, key);
      const leases = tx.objectStore(STORES.leases);
      const lease = await requestValue(leases.get(key)) as LeaseRecord | undefined;
      if (!lease || lease.ownerId !== ownerId || lease.fence !== fence || lease.expiresAt <= now) {
        throw new SyncStateError('stale_fence');
      }
      expiresAt = safeInteger(now + duration, 'expiresAt', 1);
      leases.put({ ...lease, expiresAt }); renewed = true;
    });
    return { renewed, expiresAt };
  }

  async function claimQueue(input: SyncScope, ownerId: string, fence: number, now: number, limit: number) {
    assertWritable(); const key = scopeKey(validateScope(input)); boundedString(ownerId, 'ownerId'); safeInteger(fence, 'fence', 1);
    safeInteger(now, 'now'); boundedLimit(limit);
    const db = await writableDatabase(); const claimed: QueueOperation[] = [];
    await runTransaction(db, [STORES.scopes, STORES.leases, STORES.queue, STORES.importPlans, STORES.importNodes], 'readwrite', async (tx) => {
      await requireActiveScope(tx, key); const lease = await requestValue(tx.objectStore(STORES.leases).get(key)) as LeaseRecord | undefined;
      if (!lease || lease.ownerId !== ownerId || lease.fence !== fence || lease.expiresAt <= now) throw new SyncStateError('stale_fence');
      const unavailableImports = await unavailableImportOpIds(tx, key);
      const index = tx.objectStore(STORES.queue).index(INDEXES.queueByStatusSequence);
      await iterateCursor(index, IDBKeyRange.bound([key, 'pending', 1], [key, 'pending', Number.MAX_SAFE_INTEGER]),
        (value, cursor) => { if (claimed.length >= limit) return false; const queue = value as QueueOperation;
          if (unavailableImports.has(queue.opId)) return false;
          const updated = { ...queue, status: 'claimed' as const, retry: { ...queue.retry, ownerId, fence,
            claimExpiresAt: lease.expiresAt } }; cursor.update(updated); claimed.push(updated); return undefined; });
    }); return clone(claimed);
  }

  async function claimNextQueue(input: SyncScope, ownerId: string, fence: number, now: number): Promise<QueueOperation | null> {
    assertWritable(); const key = scopeKey(validateScope(input)); boundedString(ownerId, 'ownerId');
    safeInteger(fence, 'fence', 1); safeInteger(now, 'now'); const db = await writableDatabase();
    let claimed: QueueOperation | null = null;
    await runTransaction(db, [STORES.scopes, STORES.leases, STORES.queue, STORES.importPlans, STORES.importNodes], 'readwrite', async (tx) => {
      await requireActiveScope(tx, key); const lease = await requestValue(tx.objectStore(STORES.leases).get(key)) as LeaseRecord | undefined;
      if (!lease || lease.ownerId !== ownerId || lease.fence !== fence || lease.expiresAt <= now) {
        throw new SyncStateError('stale_fence');
      }
      const queue = tx.objectStore(STORES.queue);
      // The queue is never pruned, so a bounded sequence scan stops seeing
      // outstanding work once a scope accumulates more than one contract page
      // of terminal rows. firstLiveQueueRow reads the earliest row per
      // non-terminal status instead, and rejected rows are settled history:
      // a permanently refused operation must not mask the pending work behind
      // it, or one bad row wedges outbound push forever.
      const first = await firstLiveQueueRow(queue, key, maxRecordBytes);
      if (!first || first.retry.notBefore > now || first.status === 'gap' || first.status === 'blocked') return;
      if ((await unavailableImportOpIds(tx, key)).has(first.opId)) return;
      if (first.status === 'claimed' && first.retry.ownerId === ownerId && first.retry.fence === fence
          && (first.retry.claimExpiresAt ?? Number.MAX_SAFE_INTEGER) > now) return;
      const updated = validateQueueRecord({ ...first, status: 'claimed', recovery: undefined,
        retry: { attempt: first.retry.attempt, notBefore: first.retry.notBefore, ownerId, fence,
          claimExpiresAt: lease.expiresAt } }, maxRecordBytes);
      queue.put(updated); claimed = updated;
    });
    return claimed ? clone(claimed) : null;
  }

  /**
   * Heal the queue after a `sequence_gap`. A 'gap' head carries the server's
   * expectedSequence evidence, and the server lane is authoritative:
   *
   * - `expected < head.sequence`: a hole sits below the head. When every row in
   *   that hole is rejected history, the surviving work is renumbered down onto
   *   the expected slot (rejected rows park after it).
   * - `expected === head.sequence`: the barrier already points at the lane's
   *   next slot, so it is cleared and the retained attempt is replayed as-is.
   * - `expected > head.sequence`: the lane moved past the local head (another
   *   writer claimed the shared lane, or the replica was restored from an older
   *   backup). Surviving rows below the lane are lifted onto it so they can be
   *   accepted instead of re-triggering the gap forever.
   *
   * Renumbering rewrites operation bytes and idempotency identity, so it only
   * happens when the lane evidence proves the old slot can never be accepted.
   * Terminal rows at or above the lane contradict that evidence (their receipts
   * would have advanced it) and claimed/blocked rows still hold in-flight work
   * or receipts — every contradiction leaves the barrier untouched. Repeated
   * calls are no-ops: healed rows no longer carry 'gap', and the floor only
   * ever rises.
   */
  async function realignQueueAfterGap(input: SyncScope, ownerId: string, fence: number, now: number,
    digestOperation: (operation: JsonObject) => string): Promise<{ readonly realigned: boolean;
      readonly mode?: 'renumber_down' | 'renumber_up' | 'resume_at_expected' }> {
    assertWritable(); const key = scopeKey(validateScope(input)); boundedString(ownerId, 'ownerId');
    safeInteger(fence, 'fence', 1); safeInteger(now, 'now');
    if (typeof digestOperation !== 'function') throw new SyncStateError('operation_validator_missing');
    const db = await writableDatabase();
    let mode: 'renumber_down' | 'renumber_up' | 'resume_at_expected' | undefined;
    await runTransaction(db, [STORES.scopes, STORES.leases, STORES.queue, STORES.sequences], 'readwrite', async (tx) => {
      await requireActiveScope(tx, key);
      const lease = await requestValue(tx.objectStore(STORES.leases).get(key)) as LeaseRecord | undefined;
      if (!lease || lease.ownerId !== ownerId || lease.fence !== fence || lease.expiresAt <= now) {
        throw new SyncStateError('stale_fence');
      }
      const queue = tx.objectStore(STORES.queue);
      const head = await firstLiveQueueRow(queue, key, maxRecordBytes);
      const expected = head?.status === 'gap' ? head.recovery?.expectedSequence : undefined;
      if (!head || expected === undefined) return;
      const sequences = tx.objectStore(STORES.sequences);
      const counter = await requestValue(sequences.get(key)) as { scopeKey: string; next: number } | undefined;
      if (!counter) throw new SyncStateError('sequence_missing');
      const laneRange = IDBKeyRange.bound([key, expected], [key, Number.MAX_SAFE_INTEGER]);
      const above = await cursorPage<QueueOperation>(queue.index(INDEXES.queueBySequence), laneRange,
        Number.MAX_SAFE_INTEGER);
      // Terminal rows at or above the expected slot would contradict the lane
      // (their receipts would have advanced it); claimed or blocked rows mean
      // other work is still settling or a receipt is bound to that sequence.
      if (above.some((row) => row.status === 'terminal' || row.status === 'claimed'
        || row.status === 'blocked')) return;
      if (expected === head.sequence) {
        // The barrier already sits on the lane's next slot: clear it, keep the
        // retained attempt byte-identical, and never allocate over a live row.
        queue.put(validateQueueRecord({ ...head, status: 'pending', recovery: undefined,
          retry: { attempt: head.retry.attempt, notBefore: 0 } }, maxRecordBytes));
        const floor = Math.max(counter.next, ...above.map((row) => row.sequence + 1));
        if (counter.next < floor) sequences.put({ scopeKey: key, next: floor });
        mode = 'resume_at_expected'; return;
      }
      const hole = expected < head.sequence
        ? above.filter((row) => row.sequence < head.sequence) : [];
      if (expected < head.sequence && (hole.length === 0 || hole.some((row) => !parkedOutOfLane(row)))) return;
      let affected = above;
      if (expected > head.sequence) {
        // Rows between the local head and the lane were never accepted there.
        // Terminal ones are already applied and keep their receipts; in-flight
        // ones would strand a receipt, so they refuse the move.
        const below = await cursorPage<QueueOperation>(queue.index(INDEXES.queueBySequence),
          IDBKeyRange.bound([key, head.sequence], [key, expected - 1]), Number.MAX_SAFE_INTEGER);
        if (below.some((row) => row.status === 'claimed' || row.status === 'blocked')) return;
        affected = [...below.filter((row) => row.status !== 'terminal'), ...above];
        mode = 'renumber_up';
      } else mode = 'renumber_down';
      const active = affected.filter((row) => !parkedOutOfLane(row));
      const parked = affected.filter(parkedOutOfLane);
      for (const row of affected) queue.delete([key, row.sequence]);
      let next = expected;
      const renumber = (row: QueueOperation, reset: boolean) => {
        const sequence = next; next += 1;
        const payload = { ...row.payload, sequence };
        const record = validateQueueRecord({ ...row, sequence, payload,
          digest: boundedString(digestOperation(payload), 'operation digest'),
          // The operation bytes changed, so the old idempotency identity must
          // not be replayed against them.
          idempotencyKey: `${row.opId}.realign.${sequence}`,
          ...(reset ? { status: 'pending', recovery: undefined } : {}),
          attempt: undefined,
          retry: { attempt: row.retry.attempt, notBefore: 0 } }, maxRecordBytes);
        queue.add({ ...record, scopeKey: key });
      };
      for (const row of active) renumber(row, true);
      for (const row of parked) renumber(row, false);
      sequences.put({ scopeKey: key, next });
    });
    return mode === undefined ? { realigned: false } : { realigned: true, mode };
  }

  async function bindPushAttempt(input: SyncScope, sequence: number, ownerId: string, fence: number,
    attemptInput: NonNullable<QueueOperation['attempt']>, replaceAfterAuthenticationDenial = false): Promise<QueueOperation> {
    assertWritable(); const key = scopeKey(validateScope(input)); safeInteger(sequence, 'sequence', 1);
    boundedString(ownerId, 'ownerId'); safeInteger(fence, 'fence', 1); const attempt = validatePushAttempt(attemptInput);
    const db = await writableDatabase(); let bound!: QueueOperation;
    await runTransaction(db, [STORES.scopes, STORES.leases, STORES.queue], 'readwrite', async (tx) => {
      await requireActiveScope(tx, key); const lease = await requestValue(tx.objectStore(STORES.leases).get(key)) as LeaseRecord | undefined;
      const queue = tx.objectStore(STORES.queue); const value = await requestValue(
        queue.index(INDEXES.queueBySequence).get([key, sequence]));
      const queued = value ? validateQueueRecord(value, maxRecordBytes) : null;
      if (!lease || lease.ownerId !== ownerId || lease.fence !== fence || !queued || queued.status !== 'claimed'
          || queued.retry.ownerId !== ownerId || queued.retry.fence !== fence) throw new SyncStateError('stale_fence');
      if (queued.attempt && !replaceAfterAuthenticationDenial && JSON.stringify(queued.attempt) !== JSON.stringify(attempt)) {
        throw new SyncStateError('attempt_binding_immutable');
      }
      bound = validateQueueRecord(queued.attempt && !replaceAfterAuthenticationDenial ? queued : { ...queued, attempt }, maxRecordBytes);
      queue.put(bound);
    });
    return clone(bound);
  }

  async function rebaseClaimedPush(input: SyncScope, sequence: number, ownerId: string, fence: number,
    patch: { readonly payload: JsonObject; readonly digest: string; readonly idempotencyKey: string;
      readonly baseRevision: string | null }): Promise<QueueOperation> {
    assertWritable(); const key = scopeKey(validateScope(input)); safeInteger(sequence, 'sequence', 1);
    boundedString(ownerId, 'ownerId'); safeInteger(fence, 'fence', 1);
    const digest = boundedString(patch.digest, 'operation digest');
    const idempotencyKey = boundedString(patch.idempotencyKey, 'idempotencyKey');
    const payload = validateJson(patch.payload, 'payload') as JsonObject;
    const baseRevision = patch.baseRevision === null ? null : boundedString(patch.baseRevision, 'baseRevision');
    const db = await writableDatabase(); let bound!: QueueOperation;
    await runTransaction(db, [STORES.scopes, STORES.leases, STORES.queue], 'readwrite', async (tx) => {
      await requireActiveScope(tx, key); const lease = await requestValue(tx.objectStore(STORES.leases).get(key)) as LeaseRecord | undefined;
      const queue = tx.objectStore(STORES.queue); const value = await requestValue(
        queue.index(INDEXES.queueBySequence).get([key, sequence]));
      const queued = value ? validateQueueRecord(value, maxRecordBytes) : null;
      if (!lease || lease.ownerId !== ownerId || lease.fence !== fence || !queued || queued.status !== 'claimed'
          || queued.retry.ownerId !== ownerId || queued.retry.fence !== fence) throw new SyncStateError('stale_fence');
      const { attempt: _attempt, ...rest } = queued;
      bound = validateQueueRecord({ ...rest, payload, digest, idempotencyKey, baseRevision }, maxRecordBytes);
      queue.put(bound);
    });
    return clone(bound);
  }

  async function settleClaimedPush(input: SyncScope, sequence: number, ownerId: string, fence: number,
    settlementInput: PushSettlement, faults: FaultOptions = {}): Promise<void> {
    assertWritable(); const key = scopeKey(validateScope(input)); safeInteger(sequence, 'sequence', 1);
    boundedString(ownerId, 'ownerId'); safeInteger(fence, 'fence', 1);
    const settlement = validatePushSettlement(settlementInput, maxRecordBytes); const db = await writableDatabase();
    try { await runTransaction(db, [STORES.scopes, STORES.leases, STORES.queue, STORES.receipts,
      STORES.mappings, STORES.mounts, STORES.bookmarkEvents, STORES.importPlans, STORES.importNodes, STORES.engine, STORES.bootstrapRuns],
    'readwrite', async (tx) => {
        await requireActiveScope(tx, key); const lease = await requestValue(tx.objectStore(STORES.leases).get(key)) as LeaseRecord | undefined;
        const queue = tx.objectStore(STORES.queue); const queuedValue = await requestValue(
          queue.index(INDEXES.queueBySequence).get([key, sequence]));
        const queued = queuedValue ? validateQueueRecord(queuedValue, maxRecordBytes) : null;
        if (!lease || lease.ownerId !== ownerId || lease.fence !== fence || !queued || queued.status !== 'claimed'
          || queued.retry.ownerId !== ownerId || queued.retry.fence !== fence) throw new SyncStateError('stale_fence');
        if (settlement.outcome === 'terminal' || settlement.outcome === 'deferred'
            || (settlement.outcome === 'blocked' && settlement.receipt)) {
          const receipt = validateReceipt(key, sequence, settlement.receipt, maxRecordBytes);
          if (queued.opId !== receipt.opId || queued.digest !== receipt.operationDigest) throw new SyncStateError('digest_mismatch');
          const receipts = tx.objectStore(STORES.receipts);
          const priorValue = await requestValue(receipts.get([key, receipt.receiptId]));
          const prior = priorValue ? validateReceipt(key, sequence, priorValue, maxRecordBytes) : null;
          if (prior && !sameReceipt(prior, receipt) && prior.kind !== 'deferred') throw new SyncStateError('receipt_id_reuse');
          if ('authoritativeCreate' in settlement && settlement.authoritativeCreate) {
            assertAuthoritativeCreateReceipt(queued, receipt, settlement.authoritativeCreate);
          }
          if ('authoritativeProjection' in settlement && settlement.authoritativeProjection) {
            assertAuthoritativeProjectionReceipt(queued, receipt, settlement.authoritativeProjection);
          }
          receipts.put(receipt);
          inject(faults.fault, 'after_receipt', tx);
          if ('authoritativeCreate' in settlement && settlement.authoritativeCreate) {
            if (settlement.outcome !== 'terminal' || queued.payload.type !== 'create_node') {
              throw new SyncStateError('provisional_mapping_binding_invalid');
            }
            await rebindCreateInTransaction(tx, key, queued, settlement.authoritativeCreate, maxRecordBytes);
          }
          if ('authoritativeProjection' in settlement && settlement.authoritativeProjection) {
            if (settlement.outcome !== 'terminal') throw new SyncStateError('authoritative_projection_invalid');
            await rebindProjectionInTransaction(tx, key, queued, settlement.authoritativeProjection, maxRecordBytes);
          }
          queue.put(validateQueueRecord({ ...queued, status: settlement.outcome,
            ...(settlement.outcome === 'blocked' ? { recovery: settlement.recovery } : { recovery: undefined }),
            retry: { attempt: settlement.retry?.attempt ?? queued.retry.attempt,
              notBefore: settlement.retry?.notBefore ?? queued.retry.notBefore } }, maxRecordBytes));
          await settleImportNode(tx, key, queued.opId, settlement.outcome, receipt.result);
          await persistPushPullHint(tx, key, receipt.result, maxRecordBytes);
          return;
        }
        if (settlement.outcome === 'rejected') {
          queue.put(validateQueueRecord({ ...queued, status: 'rejected', recovery: settlement.recovery,
            retry: { attempt: queued.retry.attempt, notBefore: queued.retry.notBefore } }, maxRecordBytes)); return;
        }
        const base = settlement.outcome === 'unknown' && settlement.clearAttempt === true
          ? (({ attempt: _attempt, ...rest }) => rest)(queued) : queued;
        queue.put(validateQueueRecord({ ...base, status: settlement.outcome,
          recovery: 'recovery' in settlement ? settlement.recovery : undefined,
          retry: settlement.retry }, maxRecordBytes));
      }); } catch (error) { throw constraintError(error); }
    durableCache.set(key, { sequence, fence, outcome: settlement.outcome });
  }

  async function repairSequenceReuseRow(input: SyncScope, sequence: number, action:
    | { readonly outcome: 'unknown' }
    | { readonly outcome: 'terminal'; readonly receipt: ReceiptInput;
      readonly authoritativeCreate?: { readonly nativeId: string; readonly targetId: string; readonly revision: string } },
  ): Promise<void> {
    assertWritable(); const key = scopeKey(validateScope(input)); safeInteger(sequence, 'sequence', 1);
    const db = await writableDatabase();
    await runTransaction(db, [STORES.scopes, STORES.queue, STORES.receipts, STORES.mappings,
      STORES.bookmarkEvents, STORES.importPlans, STORES.importNodes, STORES.engine, STORES.bootstrapRuns], 'readwrite', async (tx) => {
      await requireActiveScope(tx, key);
      const queue = tx.objectStore(STORES.queue);
      const queuedValue = await requestValue(queue.index(INDEXES.queueBySequence).get([key, sequence]));
      const queued = queuedValue ? validateQueueRecord(queuedValue, maxRecordBytes) : null;
      if (!queued) throw new SyncStateError('queue_not_found');
      const code = queued.recovery?.code ?? '';
      if ((queued.status !== 'rejected' && queued.status !== 'unknown')
          || (code !== 'sequence_reuse' && code !== 'op_id_reused')) {
        return;
      }
      if (action.outcome === 'unknown') {
        // Parking a row must never reset its replay backoff: the repair scan
        // covers these rows on every drain, and `notBefore: 0` would turn a
        // parked reuse refusal into a zero-delay replay storm.
        queue.put(validateQueueRecord({ ...queued, status: 'unknown', recovery: queued.recovery,
          retry: queued.retry }, maxRecordBytes));
        return;
      }
      const receipt = validateReceipt(key, sequence, action.receipt, maxRecordBytes);
      if (queued.opId !== receipt.opId || queued.digest !== receipt.operationDigest) {
        throw new SyncStateError('digest_mismatch');
      }
      const receipts = tx.objectStore(STORES.receipts);
      const priorValue = await requestValue(receipts.get([key, receipt.receiptId]));
      const prior = priorValue ? validateReceipt(key, sequence, priorValue, maxRecordBytes) : null;
      if (prior && !sameReceipt(prior, receipt) && prior.kind !== 'deferred') throw new SyncStateError('receipt_id_reuse');
      if (action.authoritativeCreate) {
        assertAuthoritativeCreateReceipt(queued, receipt, action.authoritativeCreate);
      }
      receipts.put(receipt);
      if (action.authoritativeCreate) {
        await rebindCreateInTransaction(tx, key, queued, action.authoritativeCreate, maxRecordBytes);
      }
      queue.put(validateQueueRecord({ ...queued, status: 'terminal', recovery: undefined,
        retry: { attempt: queued.retry.attempt, notBefore: queued.retry.notBefore } }, maxRecordBytes));
      await settleImportNode(tx, key, queued.opId, 'terminal', receipt.result);
    });
  }

  return { allocateSequenceAndEnqueue, advanceSequenceFloor, listQueue, listQueueByTarget, getQueueByOpId, getQueueReceipt,
    completeQueueWithReceipt, completeClaimedQueueWithReceipt, publishCursor,
    acquireLease, renewLease, claimQueue, claimNextQueue, realignQueueAfterGap, bindPushAttempt, rebaseClaimedPush,
    settleClaimedPush, repairSequenceReuseRow };
}

/**
 * Push receipt `serverCursor` values that are markers, not stream cursors:
 * `'repair'` is minted locally by sequence-reuse repair, `'sync-unchanged'` is
 * the server's "no stream advance" receipt. They never enter a cursor field.
 */
const PUSH_RECEIPT_CURSOR_SENTINELS = new Set(['repair', 'sync-unchanged']);

async function persistPushPullHint(tx: IDBTransaction, key: string, result: JsonObject | undefined,
  _maxBytes: number): Promise<void> {
  const cursor = result?.serverCursor;
  if (typeof cursor !== 'string') return;
  const engines = tx.objectStore(STORES.engine);
  const prior = await requestValue(engines.get(key)) as DurableSyncEngineState | undefined;
  if (!prior) return;
  // F023: a Push receipt never feeds lastPublishedCursor — that field is the
  // Pull/Ack convergence pair with lastAckedCursor. Real push cursors land in
  // lastPushServerCursor; sentinels are recorded as an outcome hint only.
  const patch = PUSH_RECEIPT_CURSOR_SENTINELS.has(cursor)
    ? { lastPushOutcomeHint: cursor }
    : { lastPushServerCursor: cursor };
  engines.put(validateEngineState({ ...prior, ...patch, revision: prior.revision + 1,
    updatedAt: prior.updatedAt }));
}
