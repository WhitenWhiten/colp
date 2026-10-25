import type { ReconcileRun } from './reconcile-run.js';
import type { SourceDatabase } from './source-db.js';
import { cursorPage, cursorPageDescending } from '../sync-state/idb.js';
export interface ReconcileRunSummary {
  key: string; id: string; createdAt: number; state: ReconcileRun['state']; scope: ReconcileRun['scope'];
  completed: number; attention: number; pending: number; undone: number;
}
const queue = 'reconcileQueue:', summaries = (connectionId: string) => `reconcileRunSummary:${JSON.stringify(connectionId)}:`;
export const reconcileRunKey = (id: string) => `reconcileRun:${id}`;
/** Small indexes keep historical previews out of normal wake/status scans. Receipts are retained. */
export function createReconcileRecords(db: SourceDatabase) {
  return {
    async save(run: ReconcileRun) {
      if (run.state === 'approved' && run.operations.every(op => ['completed', 'undone'].includes(op.state))) run.state = 'completed';
      const key = `${summaries(run.preview.context.connectionId)}${String(run.preview.createdAt).padStart(16, '0')}:${run.id}`;
      const summary: ReconcileRunSummary = { key, id: run.id, createdAt: run.preview.createdAt, state: run.state, scope: run.scope,
        completed: run.operations.filter(o => o.state === 'completed').length, attention: run.operations.filter(o => o.state === 'attention').length,
        pending: run.operations.filter(o => o.state === 'pending').length, undone: run.operations.filter(o => o.state === 'undone').length };
      const runnable = run.operations.some(op => op.state === 'pending' && (run.state === 'approved' || op.undoPending && op.undoAuthorized)
        || run.state === 'cancelled' && ['pending', 'attention'].includes(op.state) && op.command);
      await db.transaction(['meta'], 'readwrite', async tx => {
        const store = tx.objectStore('meta'); store.put({ ...run, updatedAt: Date.now() }, reconcileRunKey(run.id)); store.put(summary, key);
        if (runnable) store.put({ id: run.id }, queue + run.id); else store.delete(queue + run.id);
      });
    },
    async wakePage() {
      const after = await db.read<string>('meta', 'reconcileQueueCursor');
      let page = await db.transaction(['meta'], 'readonly', tx => cursorPage<{ id: string }>(tx.objectStore('meta'), IDBKeyRange.bound(after ? queue + after : queue, queue + '\uffff', !!after), 10));
      if (!page.length && after) page = await db.transaction(['meta'], 'readonly', tx => cursorPage<{ id: string }>(tx.objectStore('meta'), IDBKeyRange.bound(queue, queue + '\uffff'), 10));
      if (page.length) await db.transaction(['meta'], 'readwrite', async tx => { tx.objectStore('meta').put(page.at(-1)!.id, 'reconcileQueueCursor'); });
      const runs: ReconcileRun[] = [];
      for (const row of page) { const run = await db.read<ReconcileRun>('meta', reconcileRunKey(row.id)); if (run) runs.push(run); }
      return runs;
    },
    async history(connectionId: string, before?: string) {
      const prefix = summaries(connectionId); if (before && !before.startsWith(prefix)) throw new Error('invalid');
      const page = await db.transaction(['meta'], 'readonly', tx => cursorPageDescending<ReconcileRunSummary>(tx.objectStore('meta'), IDBKeyRange.bound(prefix, before ?? prefix + '\uffff', false, !!before), 26));
      return { runs: page.slice(0, 25), next: page.length > 25 ? page[24]!.key : null };
    },
  };
}
