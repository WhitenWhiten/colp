import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, expect, test, vi } from 'vitest';
import { createSourceDatabase, sourceDigest } from '../src/site-adapters/source-db.js';
import type { PlannedNativeCommand } from '../src/site-adapters/planned-types.js';
const f = vi.hoisted(() => ({ db: undefined as unknown as ReturnType<typeof createSourceDatabase>, create: vi.fn() }));
vi.mock('../src/site-adapters/source-runtime.js', () => ({ siteLedger: { get db() { return f.db; } } }));
vi.mock('../src/sw/planned-capture.js', () => ({ assertSourceRoot: async () => {}, executePlannedNative: f.create, recoverPlannedNative: async () => null }));
vi.mock('../src/site-adapters/local-save-runtime.js', () => ({ rememberLocalSourceSave: async (_: unknown, result: unknown) => result }));
import { executeLocalSave, recoverLocalSave } from '../src/site-adapters/local-reuse-runtime.js';
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
test('cached canonical projection produces a durable local reuse receipt and never another create', async () => {
  f.db = createSourceDatabase(new IDBFactory());
  const native = { bindingId: 'original', nativeId: 'native', dateAdded: 10, kind: 'folder' as const, deviceId: 'device', proof: { kind: 'writeReceipt' as const, id: 'original' } };
  const slot = { kind: 'folder' as const, source: { site: 'bilibili', identityVersion: 1, sourceAccount: '42', sourceCollectionId: '1' } };
  const owner = { serverOrigin: 'https://sync.test', accountId: 'owner', collectionId: 'library' };
  const reuse = { native, written: { title: 'Saved', parentId: 'root' }, shared: { library: owner, slot, nodeId: 'canonical' } };
  const command: PlannedNativeCommand = { commandId: 'reuse', ownerId: 'folder', connectionId: 'source', logicalDigest: 'plan',
    kind: 'folder', title: 'Saved', parent: { ...native, nativeId: 'root' }, deviceId: 'device', local: { root: { ...native, nativeId: 'root' }, owner, slot, reuse } };
  let title = 'Changed'; vi.stubGlobal('chrome', { bookmarks: { get: async () => [{ id: 'native', dateAdded: 10, title, parentId: 'root' }] } });
  const authorize = vi.fn(async () => {}), digest = sourceDigest(command);
  try {
    await expect(executeLocalSave(command, digest, authorize)).rejects.toThrow('sourceCopyDetached');
    expect(await recoverLocalSave(command, digest)).toBeNull();
    title = 'Saved'; expect(await executeLocalSave(command, digest, authorize)).toMatchObject({ status: 'confirmed', native });
    expect(await recoverLocalSave(command, digest)).toMatchObject({ status: 'confirmed', native });
    expect(await f.db.read('meta', 'localShared:reuse')).toEqual(reuse.shared);
    expect(f.create).not.toHaveBeenCalled();
    await expect(recoverLocalSave(command, 'different')).rejects.toThrow('capture_command_reused');
  } finally { await f.db.close(); }
});
