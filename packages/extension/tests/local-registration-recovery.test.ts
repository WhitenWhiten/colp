import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { expect, test, vi } from 'vitest';
import { createSourceDatabase } from '../src/site-adapters/source-db.js';
import { localTransferKey, type LocalCopyTransfer } from '../src/site-adapters/local-identity.js';
import { createLocalTransferQueue, retryLocalTransfers } from '../src/site-adapters/local-transfer-queue.js';
import { saveManagedCopy, cancelManagedCopy, recoverManagedCopy, type ManagedSaveState } from '../../server/src/modules/source-archives/managed-copies.js';
import type { ManagedSaveCommand } from '../src/site-adapters/managed-client.js';
const f = vi.hoisted(() => ({ db: null as ReturnType<typeof createSourceDatabase> | null,
  mappedParent: 'parent-v1', serverParent: 'parent-v1', mappedNode: 'node-v1', serverNode: 'node-v1',
  calls: [] as ManagedSaveCommand[], loseReceipt: false, loseBefore: false, loseCancel: false, state: { bindings: {}, receipts: {} } as ManagedSaveState,
  scope: { serverOrigin: 'https://sync.test', accountId: 'owner', collectionId: 'library', replicaId: 'replica' } }));
vi.mock('../src/site-adapters/source-runtime.js', () => ({ siteLedger: { get db() { return f.db!; } } }));
vi.mock('../src/sw/scope.js', () => ({ currentSyncScope: async () => f.scope }));
vi.mock('../src/sw/planned-capture.js', () => ({ assertSourceRoot: async () => ({ inRange: true }) }));
vi.mock('../src/sw/runtime.js', () => ({ syncState: { getLocalSyncExclusion: async () => null,
  getMappingByNativeId: async (_: unknown, id: string) => ({ colpId: id, projection: { revision: id === 'parent' ? f.mappedParent : f.mappedNode } }) } }));
vi.mock('../src/site-adapters/managed-runtime.js', () => ({ projectManagedBinding: vi.fn(), managedClientForLibrary: async () => ({
  profile: async () => ({ managedCancel: 1 }),
  call: async (action: string, input: ManagedSaveCommand | { commandId: string; digest: string }) => {
    if (action === 'managed.recover' || action === 'managed.cancel') {
      if (!('digest' in input)) throw Error('invalid fixture request');
      if (action === 'managed.recover') return { receipt: recoverManagedCopy(f.state, input.commandId, input.digest) };
      const receipt = cancelManagedCopy(f.state, input.commandId, input.digest);
      if (f.loseCancel) { f.loseCancel = false; throw Error('sourceSyncPending'); }
      return { receipt };
    }
    if (!('slot' in input)) throw Error('invalid fixture request');
    const command = input;
    f.calls.push(structuredClone(command));
    if (f.loseBefore) { f.loseBefore = false; throw Error('sourceSyncPending'); }
    const receipt = await saveManagedCopy(f.state, command, {
      assertTarget: async c => { if (c.parentRevision !== f.serverParent) throw Error('source_root_changed'); },
      read: async () => ({ nodeId: 'native', parentId: 'parent', title: 'Saved', url: 'https://example.org', revision: f.serverNode }),
      create: async () => { throw Error('must_not_create'); },
    });
    if (f.loseReceipt) { f.loseReceipt = false; throw Error('sourceSyncPending'); }
    return receipt;
  },
}) }));
import { registerLocalTransfer } from '../src/site-adapters/local-registration-runtime.js';
const native = { nativeId: 'native', deviceId: 'device', dateAdded: 10, bindingId: 'command', kind: 'bookmark' as const, proof: { kind: 'writeReceipt' as const, id: 'command' } };
const transfer: LocalCopyTransfer = { version: 1, commandId: 'command', key: 'identity', connectionId: 'connection', native,
  parent: { ...native, kind: 'folder', nativeId: 'parent' }, title: 'Saved', url: 'https://example.org', owner: f.scope,
  slot: { kind: 'bookmark', copy: { purpose: 'semantic', content: { site: 'fixture', identityVersion: 1, itemId: 'one', accountId: null } } },
  state: 'pending', createdAt: 10, updatedAt: 10 };
test.each(['parent', 'node'])('stale %s admission is fenced before registration retries with current revisions', async kind => {
  f.db = createSourceDatabase(new IDBFactory()); f.calls = []; f.state = { bindings: {}, receipts: {} }; f.scope.replicaId = 'replica'; f.loseBefore = false; f.loseReceipt = false;
  f.mappedParent = f.serverParent = 'parent-v1'; f.mappedNode = f.serverNode = 'node-v1';
  if (kind === 'parent') f.serverParent = 'parent-v2'; else f.serverNode = 'node-v2';
  vi.stubGlobal('chrome', { bookmarks: { get: async () => [{ id: 'native', dateAdded: 10, parentId: 'parent', title: 'Saved', url: 'https://example.org' }] } });
  let now = 100;
  try {
    await f.db!.transaction(['meta', 'transfers'], 'readwrite', async tx => {
      tx.objectStore('meta').put(transfer, localTransferKey('command'));
      tx.objectStore('transfers').put({ ...transfer, dueAt: 0, attempts: 0 }, 'command');
    });
    const run = createLocalTransferQueue(f.db!, { register: registerLocalTransfer, schedule: vi.fn(), now: () => now });
    await run();
    f.mappedParent = f.serverParent; f.mappedNode = f.serverNode;
    await retryLocalTransfers(f.db!, 'connection'); now += 31000; await run();
    expect(f.calls).toHaveLength(2);
    expect(f.calls[1]!.commandId).not.toEqual(f.calls[0]!.commandId);
    expect(f.calls[1]!.parentRevision).toBe(f.serverParent);
    expect(f.calls[1]!.adopt?.revision).toBe(f.serverNode);
    expect(Object.keys(f.state.receipts)).toHaveLength(1);
    expect(Object.keys(f.state.cancelled ?? {})).toEqual([f.calls[0]!.commandId]);
    expect(await f.db!.read('meta', localTransferKey('command'))).toMatchObject({
      state: 'registered',
    });
  } finally { vi.unstubAllGlobals(); await f.db!.close(); }
});


test('a lost committed receipt is recovered without a replacement command', async () => {
  f.db = createSourceDatabase(new IDBFactory()); f.calls = []; f.state = { bindings: {}, receipts: {} };
  f.scope.replicaId = 'replica'; f.mappedParent = f.serverParent = 'parent-v1'; f.mappedNode = f.serverNode = 'node-v1'; f.loseReceipt = true;
  vi.stubGlobal('chrome', { bookmarks: { get: async () => [{ id: 'native', dateAdded: 10, parentId: 'parent', title: 'Saved', url: 'https://example.org' }] } });
  try {
    await expect(registerLocalTransfer(transfer)).rejects.toThrow('sourceSyncPending');
    await expect(registerLocalTransfer(transfer)).resolves.toMatchObject({ nodeId: 'native' });
    expect(f.calls).toHaveLength(1);
    expect(Object.keys(f.state.receipts)).toHaveLength(1);
    expect(Object.keys(f.state.cancelled ?? {})).toHaveLength(0);
  } finally { f.loseReceipt = false; vi.unstubAllGlobals(); await f.db!.close(); }
});

test('replica replacement fences an unresolved old command before using the new replica', async () => {
  f.db = createSourceDatabase(new IDBFactory()); f.calls = []; f.state = { bindings: {}, receipts: {} };
  f.scope.replicaId = 'replica'; f.mappedParent = f.serverParent = 'parent-v1'; f.mappedNode = f.serverNode = 'node-v1'; f.loseBefore = true;
  vi.stubGlobal('chrome', { bookmarks: { get: async () => [{ id: 'native', dateAdded: 10, parentId: 'parent', title: 'Saved', url: 'https://example.org' }] } });
  try {
    await expect(registerLocalTransfer(transfer)).rejects.toThrow('sourceSyncPending');
    f.scope.replicaId = 'rebuilt-replica';
    await expect(registerLocalTransfer(transfer)).resolves.toMatchObject({ nodeId: 'native' });
    expect(f.calls).toHaveLength(2);
    expect(f.calls[1]!.replicaId).toBe('rebuilt-replica');
    expect(Object.keys(f.state.cancelled ?? {})).toEqual([f.calls[0]!.commandId]);
  } finally { f.scope.replicaId = 'replica'; f.loseBefore = false; vi.unstubAllGlobals(); await f.db!.close(); }
});


test('a lost cancellation response is recovered before a replacement is issued', async () => {
  f.db = createSourceDatabase(new IDBFactory()); f.calls = []; f.state = { bindings: {}, receipts: {} };
  f.scope.replicaId = 'replica'; f.mappedParent = f.serverParent = 'parent-v1'; f.mappedNode = 'node-v1'; f.serverNode = 'node-v2'; f.loseCancel = true;
  vi.stubGlobal('chrome', { bookmarks: { get: async () => [{ id: 'native', dateAdded: 10, parentId: 'parent', title: 'Saved', url: 'https://example.org' }] } });
  try {
    await expect(registerLocalTransfer(transfer)).rejects.toThrow('source_copy_adoption_conflict');
    f.mappedNode = f.serverNode;
    await expect(registerLocalTransfer(transfer)).rejects.toThrow('sourceSyncPending');
    expect(Object.keys(f.state.cancelled ?? {})).toEqual([f.calls[0]!.commandId]);
    expect(f.calls).toHaveLength(1);
    await expect(registerLocalTransfer(transfer)).resolves.toMatchObject({ nodeId: 'native' });
    expect(f.calls).toHaveLength(2);
  } finally { f.loseCancel = false; vi.unstubAllGlobals(); await f.db!.close(); }
});
