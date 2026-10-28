import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { expect, test, vi } from 'vitest';
import { createSourceDatabase, sourceDigest } from '../src/site-adapters/source-db.js';
import { managedSlotKey } from '../src/site-adapters/managed-saves.js';
import type { LocalCopyTransfer } from '../src/site-adapters/local-identity.js';
import type { ManagedSaveCommand } from '../src/site-adapters/managed-client.js';
const f = vi.hoisted(() => ({ db: undefined as unknown as ReturnType<typeof createSourceDatabase>, calls: [] as ManagedSaveCommand[], loseReply: false,
  inRange: true, moveDuringProfile: false, parentRevision: 'parent-r1', scope: { serverOrigin: 'https://sync.test', accountId: 'owner', collectionId: 'library', replicaId: 'replica' } }));
vi.mock('../src/site-adapters/source-runtime.js', () => ({ siteLedger: { get db() { return f.db; } } }));
vi.mock('../src/sw/scope.js', () => ({ currentSyncScope: async () => f.scope }));
vi.mock('../src/sw/planned-capture.js', () => ({ assertSourceRoot: async () => ({ inRange: f.inRange }) }));
vi.mock('../src/sw/runtime.js', () => ({ syncState: { getLocalSyncExclusion: async () => null, getMappingByNativeId: async (_: unknown, id: string) => ({
  colpId: id === 'parent' ? 'canonical-parent' : 'canonical-native', projection: { revision: id === 'parent' ? f.parentRevision : 'node-r1' },
}) } }));
vi.mock('../src/site-adapters/local-transfer-queue.js', () => ({ createLocalTransferQueue: () => async () => {} }));
vi.mock('../src/site-adapters/managed-runtime.js', () => ({ managedClientForLibrary: async () => ({
  profile: async () => { if (f.moveDuringProfile) f.inRange = false; },
  call: async (_: string, command: ManagedSaveCommand) => {
    f.calls.push(structuredClone(command));
    if (f.loseReply) { f.loseReply = false; throw Error('sourceSyncPending'); }
    return { version: 1, commandId: command.commandId, digest: sourceDigest(command), key: managedSlotKey(command.collectionId, command.slot), disposition: 'reused',
      node: { nodeId: command.adopt!.nodeId, parentId: command.parentId, title: command.title, url: command.url, revision: command.adopt!.revision } };
  },
}) }));
import { registerLocalTransfer } from '../src/site-adapters/local-transfer-runtime.js';
const native = { nativeId: 'native', deviceId: 'device', dateAdded: 10, bindingId: 'command', kind: 'bookmark' as const, proof: { kind: 'writeReceipt' as const, id: 'command' } };
const transfer: LocalCopyTransfer = { version: 1, commandId: 'command', key: 'identity', native, parent: { ...native, kind: 'folder', nativeId: 'parent' }, title: 'Saved', url: 'https://example.org', owner: f.scope,
  slot: { kind: 'bookmark', copy: { purpose: 'semantic', content: { site: 'fixture', identityVersion: 1, itemId: 'one', accountId: null } } }, state: 'pending', createdAt: 10, updatedAt: 10 };
async function setup() {
  f.db = createSourceDatabase(new IDBFactory()); f.calls = []; f.inRange = true; f.moveDuringProfile = false; f.parentRevision = 'parent-r1';
  vi.stubGlobal('chrome', { bookmarks: { get: async () => [{ id: 'native', dateAdded: 10, parentId: 'parent', title: 'Saved', url: 'https://example.org' }] } });
}
test('lost adoption replies retry the exact uploaded node and immutable command without a create', async () => {
  await setup(); f.loseReply = true;
  try {
    await expect(registerLocalTransfer(transfer)).rejects.toThrow('sourceSyncPending');
    f.parentRevision = 'parent-r2';
    expect(await registerLocalTransfer(transfer)).toMatchObject({ nodeId: 'canonical-native' });
    expect(f.calls).toHaveLength(2); expect(f.calls[0]).toEqual(f.calls[1]);
    expect(f.calls[0]!.adopt).toEqual({ nodeId: 'canonical-native', revision: 'node-r1' });
  } finally { vi.unstubAllGlobals(); await f.db.close(); }
});
test('range revocation during capability negotiation prevents association dispatch', async () => {
  await setup(); f.moveDuringProfile = true;
  try { await expect(registerLocalTransfer(transfer)).rejects.toThrow('sourceSyncOwnerChanged'); expect(f.calls).toEqual([]); }
  finally { vi.unstubAllGlobals(); await f.db.close(); }
});
