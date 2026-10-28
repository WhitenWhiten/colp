import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { expect, test } from 'vitest';
import { createSourceDatabase, sourceKey } from '../src/site-adapters/source-db.js';
import { attachLocalAssociation } from '../src/site-adapters/local-association.js';
import { createLocalTransferQueue } from '../src/site-adapters/local-transfer-queue.js';
import { createContentBindings } from '../src/site-adapters/content-bindings.js';
import { localTransferKey, type LocalCopyTransfer } from '../src/site-adapters/local-identity.js';
import { managedLibraryKey } from '../src/site-adapters/copy-identity.js';
import { representationKey } from '../src/site-adapters/reservations.js';
import { contentBindingKey } from '../src/site-adapters/content-identity.js';
const owner = { serverOrigin: 'https://sync.test', accountId: 'owner-a', collectionId: 'library-a' };
const native = { deviceId: 'device', nativeId: 'native', dateAdded: 10, kind: 'bookmark' as const, bindingId: 'original', proof: { kind: 'writeReceipt' as const, id: 'original' } };
const root = { ...native, nativeId: 'root', kind: 'folder' as const };
const content = { siteKey: 'bilibili', identityVersion: 1, itemId: 'video:av:1' };
const transfer: LocalCopyTransfer = { version: 1, commandId: 'transport', connectionId: 'source', key: 'local-identity', owner, native, parent: root,
  title: 'Video', url: 'https://www.bilibili.com/video/av1', state: 'pending', createdAt: 1, updatedAt: 1,
  slot: { kind: 'bookmark', copy: { purpose: 'semantic', content: { site: 'bilibili', identityVersion: 1, itemId: content.itemId, accountId: null } } } };
test('a local semantic copy joining Sync moves its derived scope and confirmed reservation without another native create', async () => {
  const db = createSourceDatabase(new IDBFactory()), scopeId = managedLibraryKey(owner);
  const rep = { connectionId: 'source', itemId: content.itemId, purpose: 'semantic' as const, sourceCollectionId: null, mountId: null, scopeId: '["local","device"]' };
  const original = { commandId: 'original', native, owner: null };
  try {
    await db.transaction(['meta', 'outbox', 'transfers', 'representations', 'contentBindings', 'itemReservations'], 'readwrite', async tx => {
      tx.objectStore('meta').put(transfer, localTransferKey(transfer.commandId)); tx.objectStore('transfers').put({ ...transfer, dueAt: 0, attempts: 0 }, transfer.commandId);
      tx.objectStore('outbox').put(original, 'original');
      tx.objectStore('representations').put({ ...rep, native, state: 'active', manualRevision: 0, lastWritten: { title: transfer.title, parentId: root.nativeId, url: transfer.url } }, representationKey(rep));
      tx.objectStore('contentBindings').put({ id: 'binding', content, native, scopeId: rep.scopeId, scopeVersion: 2, connectionId: 'source', purpose: 'semantic', state: 'active',
        title: transfer.title, url: transfer.url, parentId: root.nativeId, commandId: 'original', captureIntentId: 'original', mode: 'create', policyRevision: null }, contentBindingKey(content, 'binding'));
      tx.objectStore('itemReservations').put({ representation: rep, commandId: 'original', state: 'confirmed', payloadDigest: 'immutable' }, representationKey(rep));
    });
    const shared = { library: owner, slot: transfer.slot, nodeId: 'canonical' };
    await createLocalTransferQueue(db, { register: async () => shared, attach: attachLocalAssociation, schedule: () => {} })();
    expect(await db.read('representations', representationKey(rep))).toBeUndefined();
    expect(await db.read('representations', representationKey({ ...rep, scopeId }))).toMatchObject({ native, shared, scopeId });
    expect(await db.read('itemReservations', representationKey({ ...rep, scopeId }))).toMatchObject({ commandId: 'original', payloadDigest: 'immutable', state: 'confirmed' });
    expect(await db.read('outbox', 'original')).toEqual(original);
    const next = await createContentBindings(db, async () => {}).prepare({ content, itemId: content.itemId, scopeId, commandId: 'next', captureIntentId: 'next', title: 'Again',
      url: transfer.url!, parentId: 'requested', automatic: false });
    expect(next).toMatchObject({ mode: 'reuse', native, parentId: root.nativeId });
  } finally { await db.close(); }
});
test.each([null, { ...owner, accountId: 'another-owner' }])('folder adoption updates an unbound mount but cannot retag an existing owner: %j', async destination => {
  const db = createSourceDatabase(new IDBFactory());
  const folder: LocalCopyTransfer = { ...transfer, native: { ...native, kind: 'folder' }, url: null, slot: { kind: 'folder', source: { site: 'bilibili', identityVersion: 1, sourceAccount: '42', sourceCollectionId: '101' } } };
  try {
    await db.transaction(['meta', 'transfers', 'folderReservations', 'mounts'], 'readwrite', async tx => {
      tx.objectStore('meta').put(folder, localTransferKey(folder.commandId)); tx.objectStore('transfers').put({ ...folder, dueAt: 0, attempts: 0 }, folder.commandId);
      tx.objectStore('folderReservations').put({ id: 'reservation', mountId: 'mount', collectionId: '101', native: folder.native, state: 'confirmed' }, sourceKey('mount', '101'));
      tx.objectStore('mounts').put({ id: 'mount', connectionId: 'source', rootRuleId: 'rule', root, state: 'active', revision: 7, destination }, sourceKey('source', 'rule'));
    });
    await createLocalTransferQueue(db, { register: async () => ({ library: owner, slot: folder.slot, nodeId: 'canonical-folder' }), attach: attachLocalAssociation, schedule: () => {} })();
    expect(await db.read('mounts', sourceKey('source', 'rule'))).toMatchObject({ destination: destination ?? owner, revision: 7, root });
    expect(await db.read('meta', localTransferKey(folder.commandId))).toMatchObject({ owner, native: folder.native, state: destination ? 'attention' : 'registered' });
  } finally { await db.close(); }
});
