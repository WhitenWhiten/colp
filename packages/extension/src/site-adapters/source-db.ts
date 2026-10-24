import { requestValue, runTransaction, cursorPage } from '../sync-state/idb.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { canonicalJson } from '../canonical-json.js';
export const SOURCE_STORES = ['meta', 'authorities', 'documentLeases', 'connections', 'observations', 'receipts', 'items', 'collections', 'memberships',
  'readRequests', 'importRuns', 'importPages', 'representations', 'itemReservations', 'folderReservations', 'folderConsumers',
  'savePlans', 'effects', 'outbox', 'contentBindings', 'mounts', 'importPreviews', 'importApprovals'] as const;
export type SourceStore = typeof SOURCE_STORES[number];
export function sourceDigest(value: unknown): string {
  return `sha256:${bytesToHex(sha256(new TextEncoder().encode(canonicalJson(value, () => { throw new Error('invalidData'); }))))}`;
}
export const sourceKey = (...parts: unknown[]) => JSON.stringify(parts);
export const sourcePrefixRange = (...parts: unknown[]) => { const prefix = JSON.stringify(parts).slice(0, -1) + ','; return IDBKeyRange.bound(prefix, prefix + '\uffff'); };
export const rows = <T>(tx: IDBTransaction, store: SourceStore, ...parts: unknown[]) => cursorPage<T>(tx.objectStore(store), sourcePrefixRange(...parts), 100001);
export const get = async <T>(tx: IDBTransaction, store: SourceStore, key: IDBValidKey): Promise<T | undefined> =>
  requestValue(tx.objectStore(store).get(key)) as Promise<T | undefined>;
export const put = (tx: IDBTransaction, store: SourceStore, key: IDBValidKey, value: unknown) => tx.objectStore(store).put(value, key);
/** Private extension-origin database. Unknown future schemas never trigger reset/downgrade. */
export function createSourceDatabase(factory: IDBFactory = indexedDB, name = 'known-site-adapters') {
  let connection: Promise<IDBDatabase> | undefined;
  const open = () => connection ??= new Promise<IDBDatabase>((resolve, reject) => {
    const r = factory.open(name, 2);
    r.onupgradeneeded = () => {
      for (const store of SOURCE_STORES) if (!r.result.objectStoreNames.contains(store)) r.result.createObjectStore(store);
      const observations = r.transaction!.objectStore('observations');
      if (!observations.indexNames.contains('state')) observations.createIndex('state', 'state');
      if (!observations.indexNames.contains('stateOrdinal')) observations.createIndex('stateOrdinal', ['state', 'ordinal']);
    };
    r.onerror = () => { connection = undefined; reject(new Error(r.error?.name === 'VersionError' ? 'schemaIncompatible' : 'sourceStoreUnavailable')); };
    r.onblocked = () => reject(new Error('schemaIncompatible'));
    r.onsuccess = () => { r.result.onversionchange = () => { r.result.close(); connection = undefined; }; resolve(r.result); };
  });
  return {
    open,
    async transaction<T>(stores: readonly SourceStore[], mode: IDBTransactionMode, work: (tx: IDBTransaction) => Promise<T>): Promise<T> {
      let result: T;
      await runTransaction(await open(), [...stores], mode, async tx => { result = await work(tx); });
      return result!;
    },
    async read<T>(store: SourceStore, key: IDBValidKey) { return this.transaction([store], 'readonly', tx => get<T>(tx, store, key)); },
    async close() { if (connection) (await connection).close(); connection = undefined; },
  };
}
export type SourceDatabase = ReturnType<typeof createSourceDatabase>;
