import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { expect, test, vi } from 'vitest';
import { createSourceDatabase } from '../src/site-adapters/source-db.js';
import { localTransferKey, type LocalCopyTransfer } from '../src/site-adapters/local-identity.js';
import { createLocalTransferQueue } from '../src/site-adapters/local-transfer-queue.js';
import type { ManagedReference } from '../src/site-adapters/managed-client.js';
const native = { nativeId: 'native', deviceId: 'device', dateAdded: 10, bindingId: 'command', kind: 'bookmark' as const, proof: { kind: 'writeReceipt' as const, id: 'command' } };
const owner = { serverOrigin: 'https://sync.test', accountId: 'original', collectionId: 'library' };
const transfer: LocalCopyTransfer = { version: 1, commandId: 'command', key: 'identity', native, parent: { ...native, kind: 'folder', nativeId: 'parent' }, title: 'Saved', url: 'https://example.org', owner,
  slot: { kind: 'bookmark', copy: { purpose: 'semantic', content: { site: 'fixture', identityVersion: 1, itemId: 'one', accountId: null } } }, state: 'pending', createdAt: 10, updatedAt: 10 };
test('transport failure preserves local success and the original owner across queue reconstruction', async () => {
  const db = createSourceDatabase(new IDBFactory()); let now = 100;
  try {
    await db.transaction(['meta', 'transfers'], 'readwrite', async tx => {
      tx.objectStore('meta').put(transfer, localTransferKey(transfer.commandId));
      tx.objectStore('transfers').put({ ...transfer, dueAt: 0, attempts: 0 }, transfer.commandId);
    });
    const register = vi.fn().mockRejectedValueOnce(Error('sourceSyncOwnerChanged')).mockResolvedValue({ library: owner, slot: transfer.slot, nodeId: 'canonical' } satisfies ManagedReference);
    const schedule = vi.fn();
    await createLocalTransferQueue(db, { register, schedule, now: () => now })();
    expect(await db.read('meta', localTransferKey('command'))).toMatchObject({ native, owner, state: 'pending', reason: 'sourceSyncOwnerChanged' });
    now = 30101; await createLocalTransferQueue(db, { register, schedule, now: () => now })();
    expect(await db.read('transfers', 'command')).toBeUndefined();
    expect(await db.read('meta', localTransferKey('command'))).toMatchObject({ state: 'registered', native, owner });
    expect(register.mock.calls[1]![0].owner.accountId).toBe('original');
  } finally { await db.close(); }
});
test('conflicting adoption is reviewable and never replaces or deletes the local receipt', async () => {
  const db = createSourceDatabase(new IDBFactory());
  try {
    await db.transaction(['meta', 'transfers'], 'readwrite', async tx => {
      tx.objectStore('meta').put(transfer, localTransferKey('command'));
      tx.objectStore('transfers').put({ ...transfer, dueAt: 0, attempts: 0 }, 'command');
    });
    const register = vi.fn(async () => { throw Error('source_copy_adoption_conflict'); });
    const run = createLocalTransferQueue(db, { register, schedule: vi.fn() }); await run(); await run();
    expect(register).toHaveBeenCalledOnce(); expect(await db.read('transfers', 'command')).toBeUndefined();
    expect(await db.read('meta', localTransferKey('command'))).toMatchObject({ state: 'attention', native, owner, reason: 'source_copy_adoption_conflict' });
  } finally { await db.close(); }
});
