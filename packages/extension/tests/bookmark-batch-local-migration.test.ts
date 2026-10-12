import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { expect, test, vi } from 'vitest';
import { createSyncStateStore, type SyncScope } from '../src/sync-state-store.js';
import { createLocalBatchStore, LOCAL_BATCH_PARTITION } from '../src/bookmark-batch-local-store.js';
import { migrateLegacyLocalBatches } from '../src/bookmark-batch-local-migration.js';
import { confirmBatch, previewOrThrow, undoBatch } from '../src/bookmark-batch-executor.js';
import { createMemoryBookmarks } from './bookmark-batch-memory.js';
const legacy: SyncScope = { environment: 'production', serverId: 'local-bookmark-manager', serverOrigin: 'https://local.invalid',
  accountId: 'local', browserProfileId: 'local', collectionId: 'local', replicaId: 'local', generation: 1 };
async function legacyDelete(factory: IDBFactory) {
  const store = createSyncStateStore({ indexedDB: factory });
  await store.registerScope({ ...legacy, lifecycle: 'active', lease: { leaseId: 'local-only', expiresAt: 0 },
    checkpoint: { serverRevision: 'local-only', cursor: 'local-only' }, selectedRoots: [], privateRoots: [], rootStatus: 'ready' });
  const api = createMemoryBookmarks(), preview = await previewOrThrow({ store, scope: legacy, api, kind: 'delete', nativeIds: ['bm-1'] });
  const commandId = crypto.randomUUID();
  const status = await confirmBatch({ store, scope: legacy, api, kind: 'delete', nativeIds: ['bm-1'], commandId, previewDigest: preview.digest, secondConfirm: true });
  return { store, api, commandId, status };
}
test('migration keeps the existing deletion identity, receipt and undo deadline, and removes the retired journal rows only after copying', async () => {
  const factory = new IDBFactory(), source = await legacyDelete(factory), native = createLocalBatchStore(factory);
  try {
    await migrateLegacyLocalBatches(native, factory);
    const migrated = await native.local.readBatchPlan(source.commandId);
    expect(migrated?.plan).toMatchObject({ planId: source.commandId, state: 'completed', undoExpiresAt: source.status.undoExpiresAt, scopeKey: LOCAL_BATCH_PARTITION });
    expect(migrated?.items[0]?.operationId).toBe(source.status.items[0]?.operationId);
    expect(await source.store.readBatchPlan(legacy, source.commandId)).toBeNull();
    expect((await undoBatch({ local: native.local, api: source.api, planId: source.commandId, commandId: source.commandId })).undone).toBe(1);
    expect(source.api.node('bar')!.children![0]?.url).toBe('https://a.test/one');
    await migrateLegacyLocalBatches(native, factory);
    expect((await native.local.listBatchPlans()).length).toBe(1);
  } finally { source.store.close(); await native.close(); }
});
test('an interruption after durable copy leaves the source intact and retries without duplicating plans or native mutations', async () => {
  const factory = new IDBFactory(), source = await legacyDelete(factory), native = createLocalBatchStore(factory);
  try {
    const copy = native.importLegacy.bind(native);
    vi.spyOn(native, 'importLegacy').mockImplementationOnce(async (plans, items) => { await copy(plans, items); throw new Error('interrupted_after_copy'); });
    await expect(migrateLegacyLocalBatches(native, factory)).rejects.toThrow('interrupted_after_copy');
    expect(await source.store.readBatchPlan(legacy, source.commandId)).not.toBeNull();
    await migrateLegacyLocalBatches(native, factory);
    expect(await source.store.readBatchPlan(legacy, source.commandId)).toBeNull();
    expect((await native.local.listBatchPlans()).length).toBe(1);
    expect(source.api.mutations).toEqual(['remove:bm-1']);
  } finally { source.store.close(); await native.close(); }
});
