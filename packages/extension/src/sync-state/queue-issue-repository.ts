import { unresolvedRejoinQueueRows } from './rejoin-queue-resolution.js';
import { withReceiptOutcome } from './open-issue-facts.js';
import { cursorPage, requestValue, requireActiveScope, runTransaction } from './idb.js';
import { INDEXES, STORES } from './schema.js';
import { scopeKey, validateScope } from './scope-key.js';
import { validateQueueRecord } from './queue-validate.js';
import type { SyncStoreRuntime } from './runtime.js';
import { SyncStateError, type QueueOperation, type SyncScope, type UnknownRecord } from './types.js';

const prefix = (key: string) => `push-rejection:${key}:`;
const range = (key: string) => IDBKeyRange.bound([key, prefix(key)], [key, `${prefix(key)}\uffff`]);
/** Written in the receipt transaction. Consumed failures are display/subject holds, never lane owners. */
export function putConsumedRejection(tx: IDBTransaction, row: QueueOperation): void {
  if (row.status !== 'terminal' || row.recovery?.resultStatus !== 'rejected') return;
  tx.objectStore(STORES.diagnostics).put({ id: `${prefix(row.scopeKey)}${row.opId}`, scopeKey: row.scopeKey,
    kind: 'push_rejection', opId: row.opId, code: row.recovery.code });
}
export async function consumedRejectionRows(tx: IDBTransaction, key: string, maxBytes: number): Promise<QueueOperation[]> {
  const facts = await cursorPage<UnknownRecord>(tx.objectStore(STORES.diagnostics).index(INDEXES.diagnosticByScope), range(key), Number.MAX_SAFE_INTEGER);
  const rows: QueueOperation[] = [];
  for (const fact of facts) {
    const row = await requestValue(tx.objectStore(STORES.queue).index(INDEXES.queueByOpId).get([key, fact.opId as string]));
    if (row) {
      const validated = validateQueueRecord(row, maxBytes);
      if (validated.status === 'terminal' && validated.recovery?.resultStatus === 'rejected') rows.push(validated);
    }
  }
  return unresolvedRejoinQueueRows(tx, key, rows);
}
export function createQueueIssueRepository(ctx: SyncStoreRuntime) {
  const markerKey = (key: string) => `consumed-rejections-v1:${key}`;
  async function adoptionComplete(tx: IDBTransaction, key: string): Promise<boolean> {
    await requireActiveScope(tx, key);
    const marker = await requestValue<{ complete?: boolean } | undefined>(tx.objectStore(STORES.metadata).get(markerKey(key)));
    return !!marker?.complete;
  }
  /** One bounded, restartable adoption sweep per scope. New receipts write their own projection atomically. */
  async function adoptConsumedRejections(scope: SyncScope): Promise<void> {
    const key = scopeKey(validateScope(scope));
    let complete = false;
    await runTransaction(await ctx.writableDatabase(), [STORES.scopes, STORES.metadata], 'readonly', async tx => {
      complete = await adoptionComplete(tx, key);
    });
    if (!complete) await resumeAdoption(key);
  }
  async function resumeAdoption(key: string): Promise<void> {
    for (;;) {
      let complete = false;
      await runTransaction(await ctx.writableDatabase(), [STORES.scopes, STORES.metadata, STORES.queue, STORES.receipts, STORES.diagnostics], 'readwrite', async tx => {
        await requireActiveScope(tx, key);
        const metadata = tx.objectStore(STORES.metadata);
        const marker = await requestValue<{ after?: number; complete?: boolean } | undefined>(metadata.get(markerKey(key)));
        if (marker?.complete) { complete = true; return; }
        const queue = tx.objectStore(STORES.queue);
        const rows = await cursorPage<QueueOperation>(queue.index(INDEXES.queueByStatusSequence),
          IDBKeyRange.bound([key, 'terminal', (marker?.after ?? 0) + 1], [key, 'terminal', Number.MAX_SAFE_INTEGER]), 1000);
        for (const row of rows) {
          const receipt = await requestValue(tx.objectStore(STORES.receipts).index(INDEXES.queueBySequence).get([key, row.sequence]));
          const projected = withReceiptOutcome(row, receipt as never);
          if (projected.recovery?.resultStatus !== 'rejected') continue;
          queue.put(projected); putConsumedRejection(tx, projected);
        }
        complete = rows.length < 1000;
        metadata.put({ key: markerKey(key), complete, after: rows.at(-1)?.sequence ?? marker?.after ?? 0 });
      });
      if (complete) return;
    }
  }
  async function listConsumedQueueIssues(scope: SyncScope): Promise<QueueOperation[]> {
    const key = scopeKey(validateScope(scope));
    for (;;) {
      let rows: QueueOperation[] | undefined;
      // Completion and projected refusals are fresh facts from the same read.
      // A completed migration must not acquire a write lock for every Pull item.
      await runTransaction(await ctx.writableDatabase(), [STORES.scopes, STORES.metadata, STORES.queue, STORES.diagnostics], 'readonly', async tx => {
        if (await adoptionComplete(tx, key)) rows = await consumedRejectionRows(tx, key, ctx.maxRecordBytes);
      });
      if (rows) return rows;
      // Recheck the marker under the existing write transaction. Concurrent
      // readers may finish adoption first; interrupted pages still resume.
      await resumeAdoption(key);
    }
  }
  /** Manual exact retry: retain the attempt, sequence, digest and idempotency identity. */
  async function retrySequenceBlocked(input: SyncScope, opId: string): Promise<void> {
    const key = scopeKey(validateScope(input));
    await runTransaction(await ctx.writableDatabase(), [STORES.scopes, STORES.queue], 'readwrite', async tx => {
      await requireActiveScope(tx, key); const queue = tx.objectStore(STORES.queue);
      const row = await requestValue<QueueOperation | undefined>(queue.index(INDEXES.queueByOpId).get([key, opId]));
      if (!row || row.status !== 'blocked' || row.recovery?.code !== 'sequence_blocked' || !row.attempt) throw new SyncStateError('action_unavailable');
      queue.put(validateQueueRecord({ ...row, retry: { attempt: 0, notBefore: 0 } }, ctx.maxRecordBytes));
    });
  }

  return { adoptConsumedRejections, listConsumedQueueIssues, retrySequenceBlocked };
}
