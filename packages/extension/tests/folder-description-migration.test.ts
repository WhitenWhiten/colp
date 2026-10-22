import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, expect, test, vi } from 'vitest';
import { createFolderDescriptionStore } from '../src/folder-description-store.js';
import { importFolderDescriptionSnapshot, reconcileFolderDescriptions } from '../src/folder-description-sync.js';
import { loadCompleteRemoteSnapshot, type CompleteRemoteSnapshot } from '../src/bootstrap/remote-snapshot.js';
import { fixture, scope } from './bookmark-event-queue-harness.js';
import { snapshot as snapshotFixture } from './durable-sync-engine-harness.js';
import type { StoredSession } from '../src/types.js';

const mocked = vi.hoisted(() => ({ sync: undefined as unknown, importSnapshot: undefined as unknown, hasKey: false }));
vi.mock('../src/sw/runtime.js', () => ({ get syncState() { return mocked.sync; },
  store: { fence: { assertWritable: async () => undefined } } }));
vi.mock('../src/classification-local-session.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/classification-local-session.js')>(),
  localClassificationCredential: async () => mocked.hasKey ? {} : null,
}));
vi.mock('../src/classification-local-projection.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/classification-local-projection.js')>(), localProjectionIsQuiet: async () => true,
}));
vi.mock('../src/sw/bookmark-metadata.js', () => ({ importBrowserMetadata: async (_scope: unknown, _context: unknown,
  snapshot: CompleteRemoteSnapshot) => (mocked.importSnapshot as (snapshot: CompleteRemoteSnapshot) => Promise<unknown>)(snapshot) }));
afterEach(() => vi.unstubAllGlobals());

test.each([false, true])('large supported legacy collections migrate descriptions (local key: %s)', async hasKey => {
  const factory = new IDBFactory(), f = await fixture(factory), descriptions = createFolderDescriptionStore({ indexedDB: factory });
  const native = { id: 'folder-parent', title: 'Parent', dateAdded: 100 }, tree = [native];
  const input = { scope, sync: f.store, descriptions, tree, queue: f.queue, assertCurrent: async () => undefined,
    allowed: (mapping: { nativeId: string }) => mapping.nativeId === native.id };
  try {
    const original = (await f.store.getMappingByNativeId(scope, native.id))!;
    const { scopeKey: _scopeKey, ...mapping } = original;
    await f.store.putMapping(scope, { ...mapping, nodeKind: 'folder' });
    await descriptions.save(native, 'Offline description');
    expect((await reconcileFolderDescriptions(input)).needsSnapshot).toBe(true);
    const base = snapshotFixture(1, false, null);
    const collection = { ...base.collection, id: scope.collectionId };
    const root = { ...base.nodes[0]!, collectionId: scope.collectionId };
    const nodes = [root, ...Array.from({ length: 300 }, (_, i) => ({ id: i === 0 ? 'folder-colp' : `folder-${i}`,
      collectionId: scope.collectionId, kind: 'folder', parentId: root.id, position: `p${i}`, title: `Folder ${i}`,
      // 300 × 6 KB ≈ 1.8 MB: large, but inside the frozen 2 MiB Snapshot
      // aggregate support bound shared with the server.
      description: 'd'.repeat(6_000), revision: `snapshot-r${i}`, createdAt: base.generatedAt, updatedAt: base.generatedAt, extensions: {} }))];
    const pages = Array.from({ length: Math.ceil(nodes.length / 100) }, (_, i) => ({ ...base, collection,
      nodes: nodes.slice(i * 100, (i + 1) * 100),
      parentRevisions: nodes.slice(i * 100, (i + 1) * 100).map(node => ({ parentId: node.id, childrenRevision: `children-${node.id}` })),
      page: { sequence: i + 1, hasMore: (i + 1) * 100 < nodes.length, nextCursor: (i + 1) * 100 < nodes.length ? `page-${i + 2}` : null },
    }));
    const session = { sessionId: 'session-a' } as StoredSession;
    const read = async (classificationProjection = true) => {
      let page = 0;
      return loadCompleteRemoteSnapshot({ endpoint: `${scope.serverOrigin}/v1/snapshot`, origin: 'chrome-extension://extension',
        credential: { accessToken: 'fixture' }, session, scope, classificationProjection,
        fetcher: async () => Response.json(pages[page++]) });
    };
    // The AI-context guard (4 MiB) sits above the frozen 2 MiB Snapshot
    // aggregate, so a supported snapshot reads successfully on both paths.
    const projectionSnapshot = await read(true);
    expect(projectionSnapshot.classificationProjection?.nodes).toHaveLength(301);
    mocked.sync = { ...f.store, getEngineState: async () => ({ lastAckedCursor: 'cursor-3' }) };
    mocked.hasKey = hasKey; mocked.importSnapshot = (snapshot: CompleteRemoteSnapshot) => importFolderDescriptionSnapshot({ ...input, snapshot });
    const writeProjection = vi.fn(); vi.stubGlobal('chrome', { storage: { session: { set: writeProjection } } });
    const { refreshLocalClassificationProjection } = await import('../src/sw/classification-local-projection.js');
    await refreshLocalClassificationProjection(scope, { generation: 1, signal: new AbortController().signal }, read, true);
    const saved = await descriptions.get(native);
    expect(saved).toMatchObject({ description: 'Offline description', state: 'dirty',
      remote: { colpId: 'folder-colp', revision: 'snapshot-r0' } });
    expect(saved?.remote?.description?.length).toBe(6_000);
    // Migrating a different nonempty cloud description must preserve the local draft until confirmation.
    expect(saved?.reviewVersion).toBe(saved?.version);
    expect(await reconcileFolderDescriptions(input)).toMatchObject({ staged: 0, needsSnapshot: false });
    expect(await f.store.listQueue(scope)).toHaveLength(0);
    await descriptions.save(native, 'Offline description', saved?.version, saved?.remote?.revision);
    expect((await descriptions.get(native))?.reviewVersion).toBeUndefined();
    expect(await reconcileFolderDescriptions(input)).toMatchObject({ staged: 1, needsSnapshot: false });
    await f.queue.flush();
    expect((await f.store.listQueue(scope))[0]!.payload).toMatchObject({ baseRevision: 'snapshot-r0',
      payload: { value: { description: 'Offline description' } } });
    expect(writeProjection).not.toHaveBeenCalled();
  } finally { descriptions.close(); f.store.close(); }
});
