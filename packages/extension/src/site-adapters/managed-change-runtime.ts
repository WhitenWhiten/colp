import { siteLedger, SITE_RECOVERY_ALARM } from './source-runtime.js';
import { managedClientForLibrary } from './managed-runtime.js';
import { managedLibraryKey } from './copy-identity.js';
import type { ManagedReference } from './managed-client.js';
import { currentCaptureScope, assertCaptureOwner } from '../sw/capture-native.js';
import { currentSyncScope } from '../sw/scope.js';
import { syncState } from '../sw/runtime.js';
import type { NativeBinding } from './contracts.js';
import type { ContentBindingRow } from './content-bindings.js';
import type { CaptureScope } from '../capture/contracts.js';
import { sourceDigest, get } from './source-db.js';
let pending: Promise<void> | undefined;
async function scan<T>(prefix: string) {
  return siteLedger.db.transaction(['meta'], 'readonly', tx => new Promise<{ key: IDBValidKey; value: T }[]>((resolve, reject) => {
    const values: { key: IDBValidKey; value: T }[] = [], r = tx.objectStore('meta').openCursor(IDBKeyRange.bound(prefix, prefix + '\uffff'));
    r.onerror = () => reject(r.error); r.onsuccess = () => { const c = r.result; if (!c || values.length >= 20) return resolve(values); values.push({ key: c.key, value: c.value }); c.continue(); };
  }));
}
async function forget(key: IDBValidKey, value: unknown) {
  await siteLedger.db.transaction(['meta'], 'readwrite', async tx => {
    const old = await get(tx, 'meta', key);
    if (old !== undefined && sourceDigest(old) === sourceDigest(value)) tx.objectStore('meta').delete(key);
  });
}
export function flushManagedChanges(): Promise<void> {
  return pending ??= (async () => {
    const scope = await currentCaptureScope(); if (!scope.accountId || !scope.collectionId) return;
    const library = { serverOrigin: scope.serverOrigin, accountId: scope.accountId, collectionId: scope.collectionId };
    const owner = managedLibraryKey(library), entries = await scan<{ reference: ManagedReference; state: string }>(`managedManual:${owner}:`);
    const relocations = await scan<{ reference: ManagedReference; native: NativeBinding<'bookmark'>; nativeParent: string;
      expected: { nodeId: string; from: string; to: string; title: string; url: string } }>(`managedRelocate:${owner}:`);
    const adoptions = await scan<{ bindingKey: string; scope: CaptureScope }>(`semanticAdoptPending:${owner}:`);
    if (!entries.length && !relocations.length && !adoptions.length) return;
    chrome.alarms.create(SITE_RECOVERY_ALARM, { when: Date.now() + 30000 });
    const client = await managedClientForLibrary(library);
    for (const { key, value } of entries) {
      const { reference, state } = value;
      await client.call('managed.manual', { collectionId: library.collectionId, slot: reference.slot, nodeId: reference.nodeId, state });
      await forget(key, value);
    }
    const sync = await currentSyncScope();
    for (const { key, value } of relocations) {
      const node = (await chrome.bookmarks.get(value.native.nativeId).catch(() => []))[0];
      if (!node || node.dateAdded !== value.native.dateAdded || node.title !== value.expected.title || node.url !== value.expected.url || node.parentId !== value.nativeParent) {
        await forget(key, value); continue;
      }
      const mapping = await syncState.getMappingByNativeId(sync, node.id);
      if (!mapping || mapping.quarantine || mapping.parentColpId !== value.expected.to) continue;
      await client.call('managed.relocate', { collectionId: library.collectionId, slot: value.reference.slot,
        expected: { ...value.expected, revision: mapping.projection.resourceRevision ?? mapping.projection.revision } });
      await forget(key, value);
    }
    for (const { key, value } of adoptions) {
      await assertCaptureOwner(value.scope);
      const binding = await siteLedger.db.read<ContentBindingRow>('contentBindings', value.bindingKey);
      if (!binding || binding.supersededBy || binding.state !== 'active') { await forget(key, value); continue; }
      await (await import('./semantic-associations.js')).adoptSemanticAssociation(binding, scope);
      await forget(key, value);
    }
  })().finally(() => { pending = undefined; });
}
