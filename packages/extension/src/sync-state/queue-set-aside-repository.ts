import { reasonCode } from '../push-error-code.js';
import { ISSUE_DEPENDENCY_STORES, transactionIssueDependencies } from './issue-dependencies.js';
import type { RecaptureQueueRow } from '../queue-recapture.js';
import { recapturedOperationDigest } from '../queue-recapture.js';
import { validateOperation } from '../bookmark-event-codec.js';
import { cursorPage, scopeRowsRange } from './idb.js';
import { stampColpQueueRecord } from './queue-target.js';
import { boundedString, clone, safeInteger } from './codec.js';
import { requestValue, requireActiveScope, runTransaction, transactionDone } from './idb.js';
import { asHeld, DEPENDENT_HOLDS, firstLaneQueueRow, heldBy, holdWaitingRows, laneHolders } from './queue-hold.js';
import { validateQueueRecord } from './queue-validate.js';
import type { SyncStoreRuntime } from './runtime.js';
import { INDEXES, STORES } from './schema.js';
import { scopeKey, validateScope } from './scope-key.js';
import { SyncStateError, type LeaseRecord, type QueueOperation, type SyncScope, type JsonObject, type MappingInput } from './types.js';

/** Rows that own no server sequence: refused history and held work. A gap realign parks them after live work. */
export function parkedOutOfLane(row: QueueOperation): boolean {
  return row.status === 'rejected' || row.status === 'set_aside';
}

/** Rows held out of the push lane for one item's problem, so the rest keeps syncing. */
export function createQueueSetAsideRepository(ctx: SyncStoreRuntime) {
  /**
   * Holds rows out of the push lane (`set_aside`) because of one item's
   * problem. Only a pending row without an attempt qualifies: a row that was
   * sent, claimed or awaits a receipt may already own its server sequence. A
   * held row keeps its slot until the next gap realign parks it after the
   * surviving work, exactly as for rejected rows, so it never stalls them.
   * Later changes of the same bookmark are held with it.
   */
  async function setAsideQueue(input: SyncScope, sequences: readonly number[], code: string): Promise<QueueOperation[]> {
    ctx.assertWritable(); const key = scopeKey(validateScope(input)); boundedString(code, 'recovery code');
    for (const sequence of sequences) safeInteger(sequence, 'sequence', 1);
    const db = await ctx.writableDatabase(); const held: QueueOperation[] = [];
    await runTransaction(db, [...ISSUE_DEPENDENCY_STORES, STORES.scopes, STORES.queue], 'readwrite', async (tx) => {
      await requireActiveScope(tx, key);
      const queue = tx.objectStore(STORES.queue);
      for (const sequence of [...new Set(sequences)].sort((left, right) => left - right)) {
        const value = await requestValue(queue.index(INDEXES.queueBySequence).get([key, sequence]));
        if (!value) throw new SyncStateError('queue_not_found');
        const row = validateQueueRecord(value, ctx.maxRecordBytes);
        if (row.status === 'set_aside') { held.push(row); continue; }
        if (row.status !== 'pending' || row.attempt !== undefined) throw new SyncStateError('set_aside_refused');
        const updated = asHeld(row, code, ctx.maxRecordBytes);
        queue.put(updated); held.push(updated);
      }
      if (held.length > 0) await holdWaitingRows(queue, key, ctx.maxRecordBytes, held[0]!.sequence);
    });
    return held.map((row) => clone(row));
  }

  /** Old bytes remain refused history; only a fresh native capture may enter the tail. */
  function releaseSetAsideQueue(input: SyncScope, sequences: readonly number[], recapture?: RecaptureQueueRow): Promise<QueueOperation[]> {
    for (const sequence of sequences) safeInteger(sequence, 'sequence', 1);
    return releaseRecaptured(input, async (queue, key) => {
      const rows: QueueOperation[] = [];
      for (const sequence of [...new Set(sequences)].sort((left, right) => left - right)) {
        const value = await requestValue(queue.index(INDEXES.queueBySequence).get([key, sequence]));
        const row = value ? validateQueueRecord(value, ctx.maxRecordBytes) : null;
        if (row?.status === 'set_aside') rows.push(row);
      }
      return rows;
    }, recapture);
  }

  /**
   * Releases the changes held only for something that is now settled: the
   * conflict's resolution arrived through Pull, or the held item was released.
   * A change still waiting for an open conflict, a held item, or an earlier
   * change that stays held keeps waiting.
   */
  function releaseSettledHolds(input: SyncScope, recapture?: RecaptureQueueRow): Promise<QueueOperation[]> {
    return releaseRecaptured(input, async (queue, key) => {
      const holders = await laneHolders(queue, key, ctx.maxRecordBytes);
      const dependent = (row: QueueOperation) => row.status === 'set_aside' && DEPENDENT_HOLDS.has(row.recovery?.code ?? '');
      const graph = await transactionIssueDependencies(queue, key);
      const kept = holders.filter((row) => !dependent(row)); const released: QueueOperation[] = [];
      for (const row of holders) {
        if (!dependent(row)) continue;
        if (heldBy(row, kept, graph)) kept.push(row); else released.push(row);
      }
      return released;
    }, recapture, true);
  }

  /**
   * Sets aside a claimed change the push worker cannot send as it is, because
   * its placement or identity cannot be proven. It has no attempt, so it owns
   * no server sequence; the changes waiting for it are held with it, and the
   * rest of the lane keeps going.
   */
  async function setAsideClaimedPush(input: SyncScope, sequence: number, ownerId: string, fence: number,
    code: string): Promise<void> {
    ctx.assertWritable(); const key = scopeKey(validateScope(input)); safeInteger(sequence, 'sequence', 1);
    boundedString(ownerId, 'ownerId'); safeInteger(fence, 'fence', 1); boundedString(code, 'recovery code');
    await runTransaction(await ctx.writableDatabase(), [...ISSUE_DEPENDENCY_STORES, STORES.scopes, STORES.leases, STORES.queue], 'readwrite', async (tx) => {
      await requireActiveScope(tx, key);
      const lease = await requestValue(tx.objectStore(STORES.leases).get(key)) as LeaseRecord | undefined;
      const queue = tx.objectStore(STORES.queue);
      const value = await requestValue(queue.index(INDEXES.queueBySequence).get([key, sequence]));
      const row = value ? validateQueueRecord(value, ctx.maxRecordBytes) : null;
      if (!lease || lease.ownerId !== ownerId || lease.fence !== fence || !row || row.status !== 'claimed'
          || row.retry.ownerId !== ownerId || row.retry.fence !== fence) throw new SyncStateError('stale_fence');
      if (row.attempt !== undefined) throw new SyncStateError('set_aside_refused');
      queue.put(asHeld(row, code, ctx.maxRecordBytes));
      await holdWaitingRows(queue, key, ctx.maxRecordBytes, sequence);
    });
  }

  async function releaseRecaptured(input: SyncScope,
    pick: (queue: IDBObjectStore, key: string) => Promise<QueueOperation[]>,
    recapture?: RecaptureQueueRow, independent = false): Promise<QueueOperation[]> {
    ctx.assertWritable(); const key = scopeKey(validateScope(input)); const db = await ctx.writableDatabase();
    const read = db.transaction([STORES.queue, ...ISSUE_DEPENDENCY_STORES], 'readonly'); const completion = transactionDone(read);
    const picked = await pick(read.objectStore(STORES.queue), key); await completion;
    if (picked.length === 0) return [];
    if (!recapture) throw new SyncStateError('recapture_required');
    const plans: { row: QueueOperation; capture: Awaited<ReturnType<RecaptureQueueRow>> }[] = [];
    const failed: { row: QueueOperation; code: string }[] = [];
    for (const row of picked) {
      try { plans.push({ row, capture: await recapture(row) }); }
      catch (error) {
        if (!independent) throw error;
        failed.push({ row, code: reasonCode(error, 'recapture_required') });
      }
    }
    const released: QueueOperation[] = [];
    await runTransaction(db, [...ISSUE_DEPENDENCY_STORES, STORES.scopes, STORES.queue, STORES.sequences, STORES.mappings,
      STORES.bookmarkEvents, STORES.metadata], 'readwrite', async tx => {
      await requireActiveScope(tx, key); const queue = tx.objectStore(STORES.queue);
      const sequences = tx.objectStore(STORES.sequences);
      const counter = await requestValue(sequences.get(key)) as { next: number };
      let next = counter.next;
      const replacements = new Map<string, string>();
      const metadata = tx.objectStore(STORES.metadata); const ordinalKey = `bookmark-event-ordinal:${key}`;
      const ordinalCounter = await requestValue(metadata.get(ordinalKey)) as { next: number } | undefined;
      const previousEvents = await cursorPage<{ ordinal: number }>(tx.objectStore(STORES.bookmarkEvents),
        scopeRowsRange(key), Number.MAX_SAFE_INTEGER);
      let ordinal = previousEvents.reduce((next, event) => Math.max(next, event.ordinal + 1), ordinalCounter?.next ?? 1);
      for (const { row, code } of failed) tx.objectStore(STORES.diagnostics).put({
        id: `queue-recapture:${key}:${row.opId}`, scopeKey: key, kind: 'queue_recapture_failed', code,
        details: { opId: row.opId },
      });
      for (const { row, capture } of plans) {
        const live = await requestValue(queue.index(INDEXES.queueByOpId).get([key, row.opId]));
        if (!live || JSON.stringify(validateQueueRecord(live, ctx.maxRecordBytes)) !== JSON.stringify(row)) throw new SyncStateError('stale_ref');
        queue.put(validateQueueRecord({ ...row, status: 'rejected', recovery: { code: 'recaptured' } }, ctx.maxRecordBytes));
        if (row.payload.type === 'create_node' && capture.operations.length === 0) {
          const mappings = tx.objectStore(STORES.mappings);
          const mapping = await requestValue<MappingInput | undefined>(mappings.index(INDEXES.mappingByColpId)
            .get([key, `pending-${row.opId}`]));
          if (mapping) {
            tx.objectStore(STORES.diagnostics).put({ id: `queue-recapture-discarded:${key}:${row.opId}`, scopeKey: key,
              kind: 'queue_recapture_discarded', code: 'create_not_current',
              details: { opId: row.opId, nativeId: mapping.nativeId, colpId: mapping.colpId, rootNativeId: mapping.rootNativeId } });
            mappings.delete([key, mapping.nativeId]);
          }
        }
        for (const operation of capture.operations) {
          const payload = replaceTokens(operation, replacements) as JsonObject;
          const opId = boundedString(payload.opId, 'opId');
          if (opId === row.opId) throw new SyncStateError('recapture_identity_reused');
          const fresh = stampColpQueueRecord(input, key, { opId, batchId: opId, idempotencyKey: opId,
            endpointIdentity: 'syncPush', mediaType: 'application/json', digest: 'pending',
            baseRevision: payload.baseRevision as string | null, operationRevision: `local-${opId}`,
            status: 'pending', retry: { attempt: 0, notBefore: 0 }, payload }, next++, ctx.maxRecordBytes,
          validateOperation, recapturedOperationDigest);
          queue.add(fresh); released.push(fresh);
          if (capture.nativeId) {
            const eventId = `recapture-${opId}`;
            tx.objectStore(STORES.bookmarkEvents).add({ scopeKey: key, eventId, dedupeKey: eventId,
              ordinal: ordinal++, occurredAt: payload.occurredAt, status: 'processed', opId,
              kind: payload.type === 'create_node' ? 'create' : payload.type === 'move_node' ? 'move' : 'change',
              nativeId: capture.nativeId, details: { operation: payload,
                context: { ...(capture.parentNativeId ? { parentNativeId: capture.parentNativeId } : {}) },
                recapturedFrom: row.opId } });
          }
          if (payload.type === 'create_node') {
            replacements.set(row.opId, opId); replacements.set(`pending-${row.opId}`, `pending-${opId}`);
            replacements.set(row.operationRevision, `local-${opId}`);
          }
        }
      }
      // Rebind unsent dependants and provisional mappings atomically with the new creates.
      if (replacements.size) {
        const rows = await cursorPage<QueueOperation>(queue, scopeRowsRange(key), Number.MAX_SAFE_INTEGER);
        for (const row of rows) {
          if (!['pending', 'set_aside'].includes(row.status) || row.attempt) continue;
          const payload = replaceTokens(row.payload, replacements) as JsonObject;
          if (JSON.stringify(payload) === JSON.stringify(row.payload)) continue;
          queue.put(validateQueueRecord({ ...row, payload,
            baseRevision: replaceTokens(row.baseRevision, replacements), digest: recapturedOperationDigest(payload),
            idempotencyKey: `${row.opId}.recaptured` }, ctx.maxRecordBytes));
        }
        const mappings = tx.objectStore(STORES.mappings);
        const rows2 = await cursorPage<MappingInput>(mappings, scopeRowsRange(key), Number.MAX_SAFE_INTEGER);
        for (const row of rows2) mappings.put(replaceTokens(row, replacements));
      }
      sequences.put({ scopeKey: key, next }); metadata.put({ key: ordinalKey, next: ordinal });
    });
    return released.map(row => clone(row));
  }

  /** The row the push lane sends next, past conflicts the server already consumed; null when none. */
  async function firstLaneQueue(input: SyncScope): Promise<QueueOperation | null> {
    const key = scopeKey(validateScope(input)); const db = await ctx.open();
    const tx = db.transaction([STORES.queue, STORES.receipts], 'readonly'); const completion = transactionDone(tx);
    const row = await firstLaneQueueRow(tx.objectStore(STORES.queue), tx.objectStore(STORES.receipts), key,
      ctx.maxRecordBytes);
    await completion; return row ? clone(row) : null;
  }

  return { setAsideQueue, releaseSetAsideQueue, releaseSettledHolds, setAsideClaimedPush, firstLaneQueue };
}

function replaceTokens(value: unknown, replacements: ReadonlyMap<string, string>): unknown {
  if (typeof value === 'string') return replacements.get(value) ?? value;
  if (Array.isArray(value)) return value.map(item => replaceTokens(item, replacements));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .map(([key, item]) => [key, replaceTokens(item, replacements)]));
  return value;
}
