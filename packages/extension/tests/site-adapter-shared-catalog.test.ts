import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { expect, test, vi } from 'vitest';
import { createSourceDatabase } from '../src/site-adapters/source-db.js';
import { createSharedCatalog } from '../src/site-adapters/shared-catalog.js';
import type { ManagedBinding } from '../src/site-adapters/managed-client.js';
const library = { serverOrigin: 'https://sync.test', accountId: 'owner', collectionId: 'library' };
const binding: ManagedBinding = { collectionId: 'library', slot: { kind: 'folder', source: { site: 'bilibili', identityVersion: 1, sourceAccount: '42', sourceCollectionId: '1' } },
  node: { nodeId: 'folder', parentId: 'root', title: 'Saved', url: null, revision: 'r1' }, state: 'active', controlRevision: 2 };
test('cached shared roles survive outages and partial refreshes without crossing library boundaries', async () => {
  const db = createSourceDatabase(new IDBFactory()); let now = 1000;
  const list = vi.fn(async () => ({ bindings: [binding], nextCursor: null as string | null })), schedule = vi.fn();
  const cache = createSharedCatalog(db, { list, schedule, now: () => now });
  try {
    await cache.refresh(library); expect(await cache.read(library, binding.slot)).toEqual(binding);
    expect(await cache.read({ ...library, accountId: 'other' }, binding.slot)).toBeUndefined();
    await cache.refresh(library); expect(list).toHaveBeenCalledTimes(1);
    now += 30000; list.mockRejectedValueOnce(Error('offline'));
    await expect(cache.refresh(library)).rejects.toThrow('offline');
    expect(await cache.read(library, binding.slot)).toEqual(binding);
    list.mockResolvedValueOnce({ bindings: [], nextCursor: 'page2' }); await cache.refresh(library);
    expect(await cache.read(library, binding.slot)).toEqual(binding);
    now += 50; await cache.refresh(library); expect(list).toHaveBeenLastCalledWith(library, 'page2');
    now += 30000; list.mockResolvedValueOnce({ bindings: [{ ...binding, controlRevision: 1, state: 'suppressed' }], nextCursor: null });
    await cache.refresh(library); expect(await cache.read(library, binding.slot)).toEqual(binding);
  } finally { await db.close(); }
});

test('cross-role lookup is indexed by complete content and destination identity', async () => {
  const db = createSourceDatabase(new IDBFactory()), content = { site: 'fixture', identityVersion: 1, itemId: 'one', accountId: null };
  const source: ManagedBinding = { ...binding, slot: { kind: 'bookmark', copy: { purpose: 'sourceArchive', sourceAccount: 'reader', sourceCollectionId: 'saved', content } } };
  const semantic: ManagedBinding = { ...source, slot: { kind: 'bookmark', copy: { purpose: 'semantic', content } } };
  const cache = createSharedCatalog(db, { list: async () => ({ bindings: [source, semantic], nextCursor: null }), schedule: () => {} });
  try {
    await cache.refresh(library); expect(await cache.content(library, content)).toHaveLength(2);
    expect(await cache.content({ ...library, accountId: 'other' }, content)).toEqual([]);
    expect(await cache.content(library, { ...content, accountId: 'private' })).toEqual([]);
    expect(await cache.content(library, { ...content, site: 'other' })).toEqual([]);
  } finally { await db.close(); }
});
