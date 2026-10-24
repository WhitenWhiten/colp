import { withReceiptOutcome } from './open-issue-facts.js';
import { cursorPage, requestValue, requireActiveScope, runTransaction, transactionDone } from './idb.js';
import { INDEXES, STORES } from './schema.js';
import { scopeKey, validateScope } from './scope-key.js';
import { tryValidateQueueRecord } from './queue-lenient.js';
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
    // An unreadable settled row is stepped over (Rule C); it cannot be an open issue.
    const validated = row ? tryValidateQueueRecord(row, maxBytes) : undefined;
    if (validated?.status === 'terminal' && validated.recovery?.resultStatus === 'rejected') rows.push(validated);
  }
  return rows;
}
export function createQueueIssueRepository(ctx: SyncStoreRuntime) {
  /** One bounded, restartable adoption sweep per scope. New receipts write their own projection atomically. */
  async function adoptConsumedRejections(scope: SyncScope): Promise<void> {
    const key = scopeKey(validateScope(scope)); const markerKey = `consumed-rejections-v1:${key}`;
    for (;;) {
      let complete = false;
      await runTransaction(await ctx.writableDatabase(), [STORES.scopes, STORES.metadata, STORES.queue, STORES.receipts, STORES.diagnostics], 'readwrite', async tx => {
        await requireActiveScope(tx, key);
        const metadata = tx.objectStore(STORES.metadata);
        const marker = await requestValue<{ after?: number; complete?: boolean } | undefined>(metadata.get(markerKey));
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
        metadata.put({ key: markerKey, complete, after: rows.at(-1)?.sequence ?? marker?.after ?? 0 });
      });
      if (complete) return;
    }
  }
  async function listConsumedQueueIssues(scope: SyncScope): Promise<QueueOperation[]> {
    await adoptConsumedRejections(scope);
    const key = scopeKey(validateScope(scope)); const db = await ctx.open();
    const tx = db.transaction([STORES.queue, STORES.diagnostics], 'readonly'); const done = transactionDone(tx);
    const rows = await consumedRejectionRows(tx, key, ctx.maxRecordBytes); await done; return rows;
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
