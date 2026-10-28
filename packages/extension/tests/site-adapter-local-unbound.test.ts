import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { expect, test, vi } from 'vitest';
import { createSourceDatabase } from '../src/site-adapters/source-db.js';
import { localTransferKey, type LocalCopyTransfer } from '../src/site-adapters/local-identity.js';
import { bindUnownedLocalTransfers } from '../src/site-adapters/local-unbound-transfers.js';
import { settleLocalTransferOwnership } from '../src/site-adapters/local-transfer-ownership.js';
test('a proven later Sync binding queues an adoption without retagging the local-only receipt', async () => {
  const db = createSourceDatabase(new IDBFactory());
  const local = { version: 1, commandId: 'local', key: 'copy', owner: null, state: 'pending', native: { nativeId: 'native', dateAdded: 10 }, createdAt: 10, updatedAt: 10 } as LocalCopyTransfer;
  const owner = { serverOrigin: 'https://sync.test', accountId: 'new-owner', collectionId: 'library' };
  try {
    await db.transaction(['meta', 'unboundTransfers'], 'readwrite', async tx => {
      tx.objectStore('meta').put(local, localTransferKey('local')); tx.objectStore('unboundTransfers').put({ ...local, dueAt: 0 }, 'local');
    });
    await bindUnownedLocalTransfers(db, { ownerFor: async () => owner, schedule: vi.fn() });
    expect(await db.read('meta', localTransferKey('local'))).toEqual(local);
    const rebound = await db.read<{ commandId: string }>('meta', 'localOwnerBinding:local');
    expect(rebound).toBeDefined();
    expect(await db.read('transfers', rebound!.commandId)).toMatchObject({ owner, native: local.native, state: 'pending' });
    expect(await db.read('unboundTransfers', 'local')).toBeUndefined();
    const lookup = vi.fn(async () => owner);
    await bindUnownedLocalTransfers(db, { ownerFor: lookup, schedule: vi.fn() }); expect(lookup).not.toHaveBeenCalled();
  } finally { await db.close(); }
});
test('a user deletion during later owner lookup cannot create new association work', async () => {
  const db = createSourceDatabase(new IDBFactory());
  const local = { version: 1, commandId: 'local', key: 'copy', owner: null, state: 'pending', native: { nativeId: 'native', dateAdded: 10 }, createdAt: 10, updatedAt: 10 } as LocalCopyTransfer;
  try {
    await db.transaction(['meta', 'unboundTransfers'], 'readwrite', async tx => {
      tx.objectStore('meta').put(local, localTransferKey('local')); tx.objectStore('unboundTransfers').put({ ...local, dueAt: 0 }, 'local');
    });
    await bindUnownedLocalTransfers(db, { schedule: vi.fn(), ownerFor: async () => {
      await settleLocalTransferOwnership(db, ['native'], true, async () => null);
      return { serverOrigin: 'https://sync.test', accountId: 'owner', collectionId: 'library' };
    } });
    expect(await db.read('meta', localTransferKey('local'))).toMatchObject({ state: 'suppressed', owner: null });
    expect(await db.read('meta', 'localOwnerBinding:local')).toBeUndefined();
    expect(await db.transaction(['transfers'], 'readonly', tx => new Promise(resolve => {
      const request = tx.objectStore('transfers').count(); request.onsuccess = () => resolve(request.result);
    }))).toBe(0);
  } finally { await db.close(); }
});
