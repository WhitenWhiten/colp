import { siteLedger, SITE_RECOVERY_ALARM } from './source-runtime.js';
import { managedClientForLibrary } from './managed-runtime.js';
import { managedLibraryKey } from './copy-identity.js';
import type { ManagedReference } from './managed-client.js';
import { currentCaptureScope } from '../sw/capture-native.js';
import { sourceDigest, get } from './source-db.js';
let pending: Promise<void> | undefined;
export function flushManagedChanges(): Promise<void> {
  return pending ??= (async () => {
    const scope = await currentCaptureScope(); if (!scope.accountId || !scope.collectionId) return;
    const library = { serverOrigin: scope.serverOrigin, accountId: scope.accountId, collectionId: scope.collectionId };
    const prefix = `managedManual:${managedLibraryKey(library)}:`, entries = await siteLedger.db.transaction(['meta'], 'readonly', tx =>
      new Promise<{ key: IDBValidKey; reference: ManagedReference; state: string }[]>((resolve, reject) => {
        const values: { key: IDBValidKey; reference: ManagedReference; state: string }[] = [], r = tx.objectStore('meta').openCursor(IDBKeyRange.bound(prefix, prefix + '\uffff'));
        r.onerror = () => reject(r.error); r.onsuccess = () => { const c = r.result; if (!c || values.length >= 20) return resolve(values); values.push({ key: c.key, ...c.value }); c.continue(); };
      }));
    if (!entries.length) return;
    chrome.alarms.create(SITE_RECOVERY_ALARM, { when: Date.now() + 30000 });
    const client = await managedClientForLibrary(library);
    for (const { key, reference, state } of entries) {
      await client.call('managed.manual', { collectionId: library.collectionId, slot: reference.slot, nodeId: reference.nodeId, state });
      await siteLedger.db.transaction(['meta'], 'readwrite', async tx => {
        const old = await get(tx, 'meta', key);
        if (sourceDigest(old) === sourceDigest({ reference, state })) tx.objectStore('meta').delete(key);
      });
    }
  })().finally(() => { pending = undefined; });
}
