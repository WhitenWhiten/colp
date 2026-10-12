import { requestValue, transactionDone } from './sync-state/idb.js';

export interface LocalDeleteNode {
  readonly snapshotId: string; readonly order: number; readonly parentOrder: number | null;
  readonly title: string; readonly url?: string; readonly index: number;
  readonly description?: string | null;
  /** Tags, note and pin of a deleted bookmark, re-keyed to the restored native id on Undo. */
  readonly annotation?: { readonly tags: string[]; readonly note: string | null; readonly pinned?: true };
  readonly state: 'waiting' | 'submitted' | 'restored'; readonly nativeId?: string;
}
export interface LocalDeleteSnapshot {
  readonly snapshotId: string; readonly sourceNativeId: string; readonly parentId: string;
  readonly digest: string; readonly total: number; readonly next: number; readonly expiresAt: number;
}

/** Browser-owned backups; no account, mapping, credential or outbound operation. */
export function createLocalDeleteStore(factory: IDBFactory = indexedDB) {
  let connection: Promise<IDBDatabase> | undefined;
  function open() {
    connection ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open('known-bookmark-local-delete', 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('snapshots', { keyPath: 'snapshotId' });
        request.result.createObjectStore('nodes', { keyPath: ['snapshotId', 'order'] });
      };
      request.onsuccess = () => {
        request.result.onversionchange = () => { request.result.close(); connection = undefined; };
        resolve(request.result);
      };
      request.onerror = () => { connection = undefined; reject(request.error); };
    });
    return connection;
  }
  async function transaction<T>(mode: IDBTransactionMode, work: (tx: IDBTransaction) => Promise<T>): Promise<T> {
    const tx = (await open()).transaction(['snapshots', 'nodes'], mode), done = transactionDone(tx);
    try { const value = await work(tx); await done; return value; }
    catch (error) { try { tx.abort(); } catch { /* Already settled. */ } await done.catch(() => undefined); throw error; }
  }
  return {
    get(snapshotId: string): Promise<LocalDeleteSnapshot | undefined> {
      return transaction('readonly', tx => requestValue(tx.objectStore('snapshots').get(snapshotId)));
    },
    node(snapshotId: string, order: number): Promise<LocalDeleteNode | undefined> {
      return transaction('readonly', tx => requestValue(tx.objectStore('nodes').get([snapshotId, order])));
    },
    nodes(snapshotId: string): Promise<readonly LocalDeleteNode[]> {
      return transaction('readonly', tx => requestValue(tx.objectStore('nodes').getAll(
        IDBKeyRange.bound([snapshotId, 0], [snapshotId, Number.MAX_SAFE_INTEGER]))));
    },
    async put(snapshot: LocalDeleteSnapshot, nodes: readonly LocalDeleteNode[]) {
      await transaction('readwrite', async tx => {
        const previous = await requestValue(tx.objectStore('snapshots').get(snapshot.snapshotId)) as LocalDeleteSnapshot | undefined;
        if (previous) {
          if (previous.sourceNativeId !== snapshot.sourceNativeId || previous.digest !== snapshot.digest) throw new Error('local_delete_snapshot_changed');
          return;
        }
        tx.objectStore('snapshots').add(snapshot);
        for (const node of nodes) tx.objectStore('nodes').add(node);
      });
    },
    async submit(snapshot: LocalDeleteSnapshot, node: LocalDeleteNode) {
      await transaction('readwrite', async tx => {
        const live = await requestValue(tx.objectStore('snapshots').get(snapshot.snapshotId)) as LocalDeleteSnapshot;
        const pending = await requestValue(tx.objectStore('nodes').get([snapshot.snapshotId, node.order])) as LocalDeleteNode;
        if (live.next !== node.order || pending.state !== 'waiting') throw new Error('local_restore_changed');
        tx.objectStore('nodes').put({ ...pending, state: 'submitted' });
      });
    },
    async confirm(snapshot: LocalDeleteSnapshot, node: LocalDeleteNode, nativeId: string) {
      await transaction('readwrite', async tx => {
        const live = await requestValue(tx.objectStore('snapshots').get(snapshot.snapshotId)) as LocalDeleteSnapshot;
        const pending = await requestValue(tx.objectStore('nodes').get([snapshot.snapshotId, node.order])) as LocalDeleteNode;
        if (live.next !== node.order || pending.state !== 'submitted') throw new Error('local_restore_changed');
        tx.objectStore('nodes').put({ ...pending, state: 'restored', nativeId });
        tx.objectStore('snapshots').put({ ...live, next: live.next + 1 });
      });
    },
    async prune(now: number) {
      await transaction('readwrite', async tx => {
        const snapshots = tx.objectStore('snapshots');
        const rows = await requestValue(snapshots.getAll()) as LocalDeleteSnapshot[];
        for (const snapshot of rows) {
          // An interrupted restore keeps its backup, even after the admission window.
          if (snapshot.expiresAt >= now || snapshot.next > 0 && snapshot.next < snapshot.total) continue;
          const pending = await requestValue(tx.objectStore('nodes').get([snapshot.snapshotId, snapshot.next])) as LocalDeleteNode | undefined;
          if (pending?.state === 'submitted') continue;
          snapshots.delete(snapshot.snapshotId);
          tx.objectStore('nodes').delete(IDBKeyRange.bound([snapshot.snapshotId], [snapshot.snapshotId, []]));
        }
      });
    },
    async close() { (await connection)?.close(); connection = undefined; },
  };
}
export type LocalDeleteStore = ReturnType<typeof createLocalDeleteStore>;
