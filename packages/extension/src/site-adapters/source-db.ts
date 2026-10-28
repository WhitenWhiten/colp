import { legacySite } from './registry.js';
import { requestValue, runTransaction, cursorPage } from '../sync-state/idb.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { canonicalJson } from '../canonical-json.js';
export const SOURCE_STORES = ['meta', 'authorities', 'documentLeases', 'connections', 'observations', 'receipts', 'items', 'collections', 'memberships',
  'readRequests', 'importRuns', 'importPages', 'representations', 'itemReservations', 'folderReservations', 'folderConsumers',
  'savePlans', 'effects', 'outbox', 'contentBindings', 'mounts', 'importPreviews', 'importApprovals', 'semanticJobs', 'semanticIndexes', 'work', 'transfers'] as const;
export type SourceStore = typeof SOURCE_STORES[number];
export const SOURCE_DATABASE_VERSION = 9;
export function sourceDigest(value: unknown): string {
  return `sha256:${bytesToHex(sha256(new TextEncoder().encode(canonicalJson(value, () => { throw new Error('invalidData'); }))))}`;
}
export const sourceKey = (...parts: unknown[]) => JSON.stringify(parts);
export const sourcePrefixRange = (...parts: unknown[]) => { const prefix = JSON.stringify(parts).slice(0, -1) + ','; return IDBKeyRange.bound(prefix, prefix + '\uffff'); };
export const rows = async <T>(tx: IDBTransaction, store: SourceStore, ...parts: unknown[]) => {
  const values = await cursorPage<T>(tx.objectStore(store), sourcePrefixRange(...parts), 100001);
  if (values.length > 100000) throw new Error('capacity'); // Never treat a truncated dependency set as complete.
  return values;
};
export const get = async <T>(tx: IDBTransaction, store: SourceStore, key: IDBValidKey): Promise<T | undefined> =>
  requestValue(tx.objectStore(store).get(key)) as Promise<T | undefined>;
export const put = (tx: IDBTransaction, store: SourceStore, key: IDBValidKey, value: unknown) => tx.objectStore(store).put(value, key);
/** Private extension-origin database. Unknown future schemas never trigger reset/downgrade. */
export function createSourceDatabase(factory?: IDBFactory, name = 'known-site-adapters') {
  let connection: Promise<IDBDatabase> | undefined;
  const open = () => {
    if (!factory && !globalThis.indexedDB) return Promise.reject(new Error('sourceStoreUnavailable'));
    return connection ??= new Promise<IDBDatabase>((resolve, reject) => {
    const available = factory ?? globalThis.indexedDB;
    if (!available) { reject(new Error('sourceStoreUnavailable')); return; }
    let abandoned = false;
    const r = available.open(name, SOURCE_DATABASE_VERSION);
    r.onupgradeneeded = () => {
      for (const store of SOURCE_STORES) if (!r.result.objectStoreNames.contains(store)) r.result.createObjectStore(store);
      const indexes: Partial<Record<SourceStore, Record<string, string>>> = {
        importPages: { receiptId: 'receipt.id' }, representations: { nativeId: 'native.nativeId' },
        contentBindings: { nativeId: 'native.nativeId', captureIntentId: 'captureIntentId' },
        mounts: { id: 'id', nativeId: 'root.nativeId' }, folderReservations: { id: 'id', nativeId: 'native.nativeId' },
      };
      for (const [name, definitions] of Object.entries(indexes)) {
        const store = r.transaction!.objectStore(name);
        for (const [index, path] of Object.entries(definitions)) if (!store.indexNames.contains(index)) store.createIndex(index, path);
      }
      const transfers = r.transaction!.objectStore('transfers');
      if (!transfers.indexNames.contains('dueAt')) transfers.createIndex('dueAt', 'dueAt');
      for (const [name, path] of Object.entries({ state: 'state', connectionState: ['connectionId', 'state'], ownerState: ['ownerKey', 'state'] }))
        if (!transfers.indexNames.contains(name)) transfers.createIndex(name, path);
      const work = r.transaction!.objectStore('work');
      if (!work.indexNames.contains('dueAt')) work.createIndex('dueAt', 'dueAt');
      if (!work.indexNames.contains('connectionId')) work.createIndex('connectionId', 'connectionId');
      const semanticJobs = r.transaction!.objectStore('semanticJobs');
      if (!semanticJobs.indexNames.contains('stateUpdatedAt')) semanticJobs.createIndex('stateUpdatedAt', ['state', 'updatedAt']);
      if (!semanticJobs.indexNames.contains('connections')) semanticJobs.createIndex('connections', 'connections', { multiEntry: true });
      const connections = r.transaction!.objectStore('connections');
      if (!connections.indexNames.contains('id')) connections.createIndex('id', 'id', { unique: true });
      const bindings = r.transaction!.objectStore('contentBindings');
      const bindingCursor = bindings.openCursor();
      bindingCursor.onsuccess = () => { const c = bindingCursor.result; if (!c) return;
        const b = c.value, key = sourceKey(b.content.siteKey, b.content.identityVersion, b.content.itemId, b.id);
        if (c.key !== key) { bindings.put(b, key); c.delete(); } c.continue(); };
      const observations = r.transaction!.objectStore('observations');
      if (!observations.indexNames.contains('connectionState')) observations.createIndex('connectionState', ['context.connectionId', 'state']);
      if (!observations.indexNames.contains('installationReady')) {
        observations.createIndex('installationReady', ['installationId', 'state', 'readyAt', 'ordinal']);
        const ready = observations.openCursor();
        ready.onsuccess = () => { const c = ready.result; if (!c) return;
          c.update({ ...c.value, installationId: c.value.installationId ?? legacySite.adapterId, readyAt: c.value.readyAt ?? 0 }); c.continue(); };
      }
      if (!observations.indexNames.contains('state')) observations.createIndex('state', 'state');
      if (!observations.indexNames.contains('stateOrdinal')) observations.createIndex('stateOrdinal', ['state', 'ordinal']);
      if (!observations.indexNames.contains('installationStateOrdinal')) {
        observations.createIndex('installationStateOrdinal', ['installationId', 'state', 'ordinal']);
        const cursor = observations.openCursor();
        cursor.onsuccess = () => { const c = cursor.result; if (!c) return;
          c.update({ ...c.value, installationId: c.value.installationId ?? legacySite.adapterId }); c.continue(); };
      }

    };
    r.onerror = () => { if (abandoned) return; connection = undefined; reject(new Error(r.error?.name === 'VersionError' ? 'schemaIncompatible' : 'sourceStoreUnavailable')); };
    r.onblocked = () => { abandoned = true; connection = undefined; reject(new Error('schemaIncompatible')); };
    r.onsuccess = () => { if (abandoned) { r.result.close(); return; }
      if (SOURCE_STORES.some(store => !r.result.objectStoreNames.contains(store))) { r.result.close(); connection = undefined; reject(new Error('schemaIncompatible')); return; }
      r.result.onversionchange = () => { r.result.close(); connection = undefined; }; resolve(r.result); };
    });
  };
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
