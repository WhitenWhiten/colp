import { scheduleSourceAlarm } from './wake-scheduler.js';
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
import { sourceDigest, get, put } from './source-db.js';
let pending: Promise<void> | undefined;
const terminal = new Set(['source_association_changed', 'source_copy_adoption_conflict']);
const issueKey = (key: IDBValidKey) => `managedChangeIssue:${sourceDigest(key)}`;
async function scan<T>(prefix: string) {
  const after = await siteLedger.db.read<string>('meta', `managedChangeCursor:${prefix}`);
  const end = prefix + '\uffff';
  return siteLedger.db.transaction(['meta'], 'readonly', tx => new Promise<{ key: string; value: T }[]>((resolve, reject) => {
    const values: { key: string; value: T }[] = [];
    const r = tx.objectStore('meta').openCursor(after && after >= prefix && after < end ? IDBKeyRange.bound(after, end, true) : IDBKeyRange.bound(prefix, end));
    r.onerror = () => reject(r.error); r.onsuccess = () => { const c = r.result; if (!c || values.length >= 20) return resolve(values); values.push({ key: c.key as string, value: c.value }); c.continue(); };
  }));
}
async function checkpoint(prefix: string, entries: { key: string }[]) {
  await siteLedger.db.transaction(['meta'], 'readwrite', async tx => {
    const key = `managedChangeCursor:${prefix}`;
    if (entries.length === 20) put(tx, 'meta', key, entries[19]!.key); else tx.objectStore('meta').delete(key);
  });
  if (entries.length === 20) scheduleSourceAlarm(Date.now() + 50, SITE_RECOVERY_ALARM);
}
async function forget(key: IDBValidKey, value: unknown) {
  await siteLedger.db.transaction(['meta'], 'readwrite', async tx => {
    const old = await get(tx, 'meta', key);
    if (old !== undefined && sourceDigest(old) === sourceDigest(value)) { tx.objectStore('meta').delete(key); tx.objectStore('meta').delete(issueKey(key)); }
  });
}
async function failed(key: IDBValidKey, value: unknown, error: unknown) {
  const reason = error instanceof Error ? error.message : 'managedChangeUnavailable';
  await siteLedger.db.transaction(['meta'], 'readwrite', async tx => {
    const old = await get(tx, 'meta', key);
    if (old === undefined || sourceDigest(old) !== sourceDigest(value)) return;
    const permanent = terminal.has(reason);
    put(tx, 'meta', permanent ? `${issueKey(key)}:${sourceDigest(value)}` : issueKey(key), { state: permanent ? 'attention' : 'pending', reason, key, value });
    if (permanent) tx.objectStore('meta').delete(issueKey(key));
    if (permanent) tx.objectStore('meta').delete(key);
  });
}
export function flushManagedChanges(): Promise<void> {
  return pending ??= (async () => {
    const scope = await currentCaptureScope(); if (!scope.accountId || !scope.collectionId) return;
    const library = { serverOrigin: scope.serverOrigin, accountId: scope.accountId, collectionId: scope.collectionId };
    const owner = managedLibraryKey(library), manualPrefix = `managedManual:${owner}:`, relocatePrefix = `managedRelocate:${owner}:`, adoptionPrefix = `semanticAdoptPending:${owner}:`;
    const entries = await scan<{ reference: ManagedReference; state: string }>(manualPrefix);
    const relocations = await scan<{ reference: ManagedReference; native: NativeBinding<'bookmark'>; nativeParent: string;
      expected: { nodeId: string; from: string; to: string; title: string; url: string } }>(relocatePrefix);
    const adoptions = await scan<{ bindingKey: string; scope: CaptureScope }>(adoptionPrefix);
    if (!entries.length && !relocations.length && !adoptions.length) {
      const cursors = await Promise.all([manualPrefix, relocatePrefix, adoptionPrefix].map(prefix => siteLedger.db.read('meta', `managedChangeCursor:${prefix}`)));
      await checkpoint(manualPrefix, entries); await checkpoint(relocatePrefix, relocations); await checkpoint(adoptionPrefix, adoptions);
      if (cursors.some(Boolean)) scheduleSourceAlarm(Date.now() + 30000, SITE_RECOVERY_ALARM);
      return;
    }
    scheduleSourceAlarm(Date.now() + 30000, SITE_RECOVERY_ALARM);
    const client = await managedClientForLibrary(library);
    for (const { key, value } of entries) {
      try {
        const { reference, state } = value;
        await client.call('managed.manual', { collectionId: library.collectionId, slot: reference.slot, nodeId: reference.nodeId, state, revision: reference.controlRevision ?? 0 });
        await forget(key, value);
      } catch (error) { await failed(key, value, error); }
    }
    await checkpoint(manualPrefix, entries);
    for (const { key, value } of relocations) {
      try {
        const node = (await chrome.bookmarks.get(value.native.nativeId).catch(() => []))[0];
        if (!node || node.dateAdded !== value.native.dateAdded || node.title !== value.expected.title || node.url !== value.expected.url || node.parentId !== value.nativeParent)
          throw new Error('nativeIdentityChanged');
        const sync = await currentSyncScope(), mapping = await syncState.getMappingByNativeId(sync, node.id);
        if (!mapping || mapping.quarantine || mapping.parentColpId !== value.expected.to) throw new Error('sourceSyncPending');
        await client.call('managed.relocate', { collectionId: library.collectionId, slot: value.reference.slot,
          expected: { ...value.expected, revision: mapping.projection.resourceRevision ?? mapping.projection.revision } });
        await forget(key, value);
      } catch (error) { await failed(key, value, error); }
    }
    await checkpoint(relocatePrefix, relocations);
    for (const { key, value } of adoptions) {
      try {
        await assertCaptureOwner(value.scope);
        const binding = await siteLedger.db.read<ContentBindingRow>('contentBindings', value.bindingKey);
        if (!binding || binding.supersededBy || binding.state !== 'active') throw new Error('content_binding_needs_review');
        await (await import('./semantic-associations.js')).adoptSemanticAssociation(binding, scope);
        await forget(key, value);
      } catch (error) { await failed(key, value, error); }
    }
    await checkpoint(adoptionPrefix, adoptions);
  })().finally(() => { pending = undefined; });
}
