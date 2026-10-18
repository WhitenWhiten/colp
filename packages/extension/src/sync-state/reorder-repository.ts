import { SyncFailureError } from '../sync-failure-class.js';
import type { SyncStoreRuntime } from './runtime.js';
import type { JsonObject, SyncScope } from './types.js';
import { boundedString, clone, validateRecord } from './codec.js';
import { deleteByIndexRange, requestValue, requireActiveScope, runTransaction, transactionDone } from './idb.js';
import { INDEXES, STORES } from './schema.js';
import { scopeKey, validateScope } from './scope-key.js';

export interface PendingReorder {
  readonly parentNativeId: string;
  readonly version: string;
  readonly childIds: readonly string[];
  readonly moves: readonly { readonly nativeId: string; readonly eventId: string; readonly details: JsonObject }[];
  readonly retained: number;
  readonly unmapped: readonly string[];
  readonly excluded: readonly string[];
  readonly reserved: readonly string[];
}

/** One durable target per parent. Immutable moves survive partial staging. */
export function createReorderRepository(ctx: SyncStoreRuntime) {
  const prefix = (key: string) => `reorder:${key}:`;
  const movePrefix = (key: string, parent: string) => `reorder-move:${key}:${JSON.stringify(parent)}:`;
  const range = (key: string, start: string) => IDBKeyRange.bound([key, start], [key, `${start}\uffff`]);
  async function putPendingReorder(scope: SyncScope, input: PendingReorder): Promise<void> {
    ctx.assertWritable(); const key = scopeKey(validateScope(scope));
    boundedString(input.parentNativeId, 'parentNativeId'); boundedString(input.version, 'reorderVersion');
    const { moves, ...target } = clone(input);
    const record = { ...target, moveCount: moves.length, id: `${prefix(key)}${input.parentNativeId}`,
      scopeKey: key, kind: 'reorder_pending' };
    validateRecord(record, ctx.maxRecordBytes);
    // Large sibling lists must not turn a valid set of small operations into
    // one oversized record. Publish the target and all immutable moves atomically.
    const moveRows = moves.map((move, ordinal) => ({ ...move, ordinal, scopeKey: key, kind: 'reorder_move',
      id: `${movePrefix(key, input.parentNativeId)}${ordinal}` }));
    for (const row of moveRows) validateRecord(row, ctx.maxRecordBytes);
    await runTransaction(await ctx.writableDatabase(), [STORES.scopes, STORES.diagnostics], 'readwrite', async tx => {
      await requireActiveScope(tx, key); const rows = tx.objectStore(STORES.diagnostics);
      await deleteByIndexRange(rows.index(INDEXES.diagnosticByScope), range(key, movePrefix(key, input.parentNativeId)));
      rows.put(record); for (const row of moveRows) rows.put(row);
    });
  }
  async function listPendingReorders(scope: SyncScope): Promise<readonly PendingReorder[]> {
    const key = scopeKey(validateScope(scope)); const db = await ctx.open();
    const tx = db.transaction(STORES.diagnostics, 'readonly'); const done = transactionDone(tx);
    const index = tx.objectStore(STORES.diagnostics).index(INDEXES.diagnosticByScope);
    const rows = await requestValue<(Omit<PendingReorder, 'moves'> & { moveCount: number })[]>(index.getAll(range(key, prefix(key))));
    const pending = await Promise.all(rows.map(async row => {
      const moves = await requestValue<(PendingReorder['moves'][number] & { ordinal: number })[]>(
        index.getAll(range(key, movePrefix(key, row.parentNativeId))));
      if (moves.length !== row.moveCount) throw new SyncFailureError('reorder_incomplete');
      return { ...row, moves: moves.sort((a, b) => a.ordinal - b.ordinal) };
    }));
    await done; return clone(pending);
  }
  async function deletePendingReorder(scope: SyncScope, parentNativeId: string, version?: string): Promise<void> {
    ctx.assertWritable(); const key = scopeKey(validateScope(scope));
    await runTransaction(await ctx.writableDatabase(), [STORES.scopes, STORES.diagnostics], 'readwrite', async tx => {
      await requireActiveScope(tx, key); const rows = tx.objectStore(STORES.diagnostics);
      const id = `${prefix(key)}${parentNativeId}`;
      const prior = await requestValue<PendingReorder | undefined>(rows.get(id));
      if (prior && (version === undefined || prior.version === version)) {
        rows.delete(id);
        await deleteByIndexRange(rows.index(INDEXES.diagnosticByScope), range(key, movePrefix(key, parentNativeId)));
      }
    });
  }
  return { putPendingReorder, listPendingReorders, deletePendingReorder };
}
