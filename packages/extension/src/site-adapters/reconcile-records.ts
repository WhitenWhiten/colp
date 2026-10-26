import { readReconcileData, writeReconcileData } from './reconcile-storage.js';
import type { ReconcileOperation, ReconcileRun } from './reconcile-run.js';
import { get, sourceKey, sourcePrefixRange, type SourceDatabase } from './source-db.js';
import { cursorPage, cursorPageDescending } from '../sync-state/idb.js';
export interface ReconcileRunSummary {
  key: string; id: string; createdAt: number; state: ReconcileRun['state']; scope: ReconcileRun['scope'];
  completed: number; attention: number; pending: number; undone: number;
}
const queue = 'reconcileQueue:', summaries = (connectionId: string) => `reconcileRunSummary:${JSON.stringify(connectionId)}:`;
export const reconcileRunKey = (id: string) => `reconcileRun:${id}`;
const operationKey = (id: string, index: number) => sourceKey('reconcileOperation', id, index);
const pendingKey = (id: string, index: number) => sourceKey('reconcilePendingOperation', id, String(index).padStart(10, '0'));
const previewKey = (id: string) => `reconcileRunPreview:${id}`;
type Progress = NonNullable<ReconcileRun['progress']>;
type StoredRun = Omit<ReconcileRun, 'operations' | 'operationsPartial' | 'totalOperations'> & { storage: 'paged-v1'; operationCount: number };
const runnable = (run: ReconcileRun, op: ReconcileOperation) => op.state === 'pending' && (run.state === 'approved' || op.undoPending && op.undoAuthorized)
  || run.state === 'cancelled' && ['pending', 'attention'].includes(op.state) && !!op.command;
/** Immutable preview pages, individual operation records and small runnable indexes. */
export function createReconcileRecords(db: SourceDatabase) {
  const checkpoints = new WeakMap<ReconcileRun, { counts: Progress; states: Map<string, ReconcileOperation['state']> }>();
  async function load(id: string, fullPreview = false, bounded = false): Promise<ReconcileRun | undefined> {
    const stored = await db.read<StoredRun | ReconcileRun>('meta', reconcileRunKey(id)); if (!stored) return undefined;
    if (!('storage' in stored)) return stored;
    const { storage: _storage, operationCount, ...header } = stored;
    const operations = await db.transaction(['meta'], 'readonly', async tx => {
      let indexes: number[];
      if (bounded) {
        const prefix = sourcePrefixRange('reconcilePendingOperation', id);
        let page = await cursorPage<{ index: number }>(tx.objectStore('meta'), IDBKeyRange.bound(pendingKey(id, header.operationCursor ?? 0), prefix.upper), 10);
        if (!page.length && header.operationCursor) page = await cursorPage(tx.objectStore('meta'), prefix, 10);
        indexes = page.map(p => p.index);
      } else indexes = Array.from({ length: operationCount }, (_, i) => i);
      const result: ReconcileOperation[] = [];
      for (const index of indexes) {
        const op = await get<ReconcileOperation>(tx, 'meta', operationKey(id, index));
        if (!op) throw new Error('reconcileRunIncomplete'); result.push({ ...op, sequence: index });
      }
      return result;
    });
    if (fullPreview) {
      const preview = await readReconcileData<ReconcileRun['preview']>(db, previewKey(id));
      if (!preview) throw new Error('reconcileRunIncomplete'); header.preview = preview;
    }
    const run: ReconcileRun = { ...header, operations, totalOperations: operationCount, ...(bounded ? { operationsPartial: true } : {}) };
    if (run.progress) checkpoints.set(run, { counts: { ...run.progress }, states: new Map(operations.map(o => [o.id, o.state])) });
    return run;
  }
  return {
    load,
    async view(id: string, differenceIds: readonly string[] = []): Promise<ReconcileRun | undefined> {
      const stored = await db.read<StoredRun | ReconcileRun>('meta', reconcileRunKey(id)); if (!stored) return undefined;
      if (!('storage' in stored)) return stored;
      const { storage: _storage, operationCount: _count, ...run } = stored;
      const operations = await db.transaction(['meta'], 'readonly', async tx => {
        const result: ReconcileOperation[] = [];
        for (const differenceId of differenceIds) {
          const index = await get<number>(tx, 'meta', sourceKey('reconcileOperationByDifference', id, differenceId));
          if (index === undefined) continue;
          const operation = await get<ReconcileOperation>(tx, 'meta', operationKey(id, index));
          if (!operation) throw new Error('reconcileRunIncomplete'); result.push(operation);
        }
        return result;
      });
      return { ...run, operations };
    },
    async save(run: ReconcileRun, changed: readonly ReconcileOperation[] = []) {
      const previous = await db.read<StoredRun | ReconcileRun>('meta', reconcileRunKey(run.id));
      const first = !previous || !('storage' in previous);
      if (first) await writeReconcileData(db, previewKey(run.id), run.preview);
      let checkpoint = checkpoints.get(run);
      if (!checkpoint) {
        const counts: Progress = { completed: 0, attention: 0, pending: 0, undone: 0 };
        for (const op of run.operations) counts[op.state]++;
        checkpoint = { counts, states: new Map(run.operations.map(o => [o.id, o.state])) }; checkpoints.set(run, checkpoint);
      } else for (const op of changed) {
        const before = checkpoint.states.get(op.id); if (!before) throw new Error('reconcileOperationMissing');
        checkpoint.counts[before]--; checkpoint.counts[op.state]++; checkpoint.states.set(op.id, op.state);
      }
      run.progress = { ...checkpoint.counts };
      if (run.state === 'approved' && !run.progress.pending && !run.progress.attention) run.state = 'completed';
      const key = `${summaries(run.preview.context.connectionId)}${String(run.preview.createdAt).padStart(16, '0')}:${run.id}`;
      const summary: ReconcileRunSummary = { key, id: run.id, createdAt: run.preview.createdAt, state: run.state, scope: run.scope, ...run.progress };
      await db.transaction(['meta'], 'readwrite', async tx => {
        const store = tx.objectStore('meta'), { operations, operationsPartial: _partial, totalOperations, ...header } = run;
        store.put({ ...header, storage: 'paged-v1', operationCount: totalOperations ?? operations.length, updatedAt: Date.now(),
          preview: { ...run.preview, differences: [], snapshots: run.preview.snapshots.map(s => ({ ...s, items: [] })) } } satisfies StoredRun, reconcileRunKey(run.id));
        const initial = first ? operations.map((op, index) => ({ op, index })) : changed.map(op => ({ op, index: op.sequence ?? operations.indexOf(op) }));
        for (const { op, index } of initial) {
          if (index < 0) throw new Error('reconcileOperationMissing'); op.sequence = index;
          store.put(op, operationKey(run.id, index));
          if (runnable(run, op)) store.put({ index }, pendingKey(run.id, index)); else store.delete(pendingKey(run.id, index));
          if (first) store.put(index, sourceKey('reconcileOperationByDifference', run.id, op.difference.id));
        }
        store.put(summary, key);
        const pending = await cursorPage(store, sourcePrefixRange('reconcilePendingOperation', run.id), 1);
        if (pending.length) store.put({ id: run.id }, queue + run.id); else store.delete(queue + run.id);
      });
    },
    async wakePage() {
      const after = await db.read<string>('meta', 'reconcileQueueCursor');
      let page = await db.transaction(['meta'], 'readonly', tx => cursorPage<{ id: string }>(tx.objectStore('meta'), IDBKeyRange.bound(after ? queue + after : queue, queue + '\uffff', !!after), 10));
      if (!page.length && after) page = await db.transaction(['meta'], 'readonly', tx => cursorPage(tx.objectStore('meta'), IDBKeyRange.bound(queue, queue + '\uffff'), 10));
      if (page.length) await db.transaction(['meta'], 'readwrite', async tx => { tx.objectStore('meta').put(page.at(-1)!.id, 'reconcileQueueCursor'); });
      const runs: ReconcileRun[] = [];
      for (const row of page) { const run = await load(row.id, false, true); if (run) runs.push(run); }
      return runs;
    },
    async history(connectionId: string, before?: string) {
      const prefix = summaries(connectionId); if (before && !before.startsWith(prefix)) throw new Error('invalid');
      const page = await db.transaction(['meta'], 'readonly', tx => cursorPageDescending<ReconcileRunSummary>(tx.objectStore('meta'), IDBKeyRange.bound(prefix, before ?? prefix + '\uffff', false, !!before), 26));
      return { runs: page.slice(0, 25), next: page.length > 25 ? page[24]!.key : null };
    },
  };
}
