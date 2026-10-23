import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, test } from 'vitest';
import { createPullApplier } from '../src/pull-applier.js';
import { createBookmarkEventQueue } from '../src/bookmark-event-queue.js';
import { createSyncStateStore, type SyncScope } from '../src/sync-state-store.js';
import { honestChrome } from './kns-05-pull-harness.js';
import { pullFixtures } from './pull-effect-fixtures.js';

const scope: SyncScope = { environment: 'production', serverId: 'server-pull', serverOrigin: 'https://known.example',
  accountId: 'account-pull', browserProfileId: 'profile-pull', collectionId: 'collection-pull',
  replicaId: 'replica-receiver', generation: 1 };
let indexedDB: IDBFactory;
beforeEach(() => { indexedDB = new IDBFactory(); });

test('a subtree deletion protects a descendant inside a private native folder', async () => {
  const f = await setup();
  try {
    f.api.seed({ id: 'native-node', parentId: 'native-root', index: 0, title: 'node-1' });
    const { scopeKey: _parentKey, ...parent } = (await f.store.getMappingByNativeId(scope, 'native-node'))!;
    await f.store.putMapping(scope, { ...parent, nodeKind: 'folder',
      projection: { ...parent.projection, content: { title: 'node-1' } } });
    f.api.seed({ id: 'native-private', parentId: 'native-node', index: 0, title: 'Private' });
    f.api.seed({ id: 'native-child', parentId: 'native-private', index: 0, title: 'node-child', url: 'https://example.test/' });
    const { scopeKey: _mappingKey, ...child } = (await f.store.getMappingByNativeId(scope, 'native-child'))!;
    await f.store.putMapping(scope, { ...child, parentNativeId: 'native-private' });
    await f.store.configureBrowserRoots(scope, { discovered: [
      { nativeId: 'native-root', ancestorNativeIds: [] },
      { nativeId: 'native-node', ancestorNativeIds: ['native-root'] },
      { nativeId: 'native-private', ancestorNativeIds: ['native-root', 'native-node'] },
    ], selectedNativeIds: ['native-root'], privateNativeIds: ['native-private'], status: 'ready' });
    await f.applier.stage(f.page([f.subtreeEvent(false)]));
    await f.applier.resume();
    assert.equal(f.api.getNode('native-child')?.parentId, 'native-private');
    assert.equal(f.api.getNode('native-private')?.title, 'Private');
    assert.equal(f.api.calls.some(call => call.kind === 'delete' && call.nativeId === 'native-child'), false);
  } finally { f.store.close(); }
});

test('permission lost after preparing a delete reports the failure without deleting the bookmark', async () => {
  const f = await setup('after_intent');
  try {
    await f.applier.stage(f.page([f.mutationEvent('delete')]));
    await assert.rejects(() => f.applier.resume(), /worker_crash/);
    f.api.denyPermission('native-node');
    await assert.rejects(() => f.applier.resume(), /permission/i);
    assert.equal(f.api.getNode('native-node')?.url, 'https://example.test/');
    assert.equal(f.api.calls.some(call => call.kind === 'delete'), false);
  } finally { f.store.close(); }
});

async function setup(crash?: string, omitNodeMappings = false) {
  const store = createSyncStateStore({ indexedDB }); await store.registerScope({ ...scope, lifecycle: 'active',
    lease: { leaseId: 'lease-pull', expiresAt: Date.parse('2099-01-01T00:00:00Z') },
    checkpoint: { serverRevision: 'revision-old', cursor: 'cursor-old' }, selectedRoots: ['root-colp'],
    rootStatus: 'ready' });
  const mapping = (nativeId: string, colpId: string, parentNativeId?: string) => ({ nativeId, colpId,
    rootNativeId: 'native-root', nodeKind: colpId === 'root-colp' ? 'folder' as const : 'bookmark' as const,
    ...(parentNativeId ? { parentNativeId } : {}), projection: { revision: 'revision-old', resourceRevision: 'revision-old',
      childrenRevision: colpId === 'root-colp' ? 'children-old' : null, digest: `sha256:${colpId}`,
      content: { title: colpId, url: 'https://example.test/' } } });
  await store.putMapping(scope, mapping('native-root', 'root-colp'));
  if (!omitNodeMappings) { await store.putMapping(scope, mapping('native-node', 'node-1', 'native-root'));
    await store.putMapping(scope, mapping('native-child', 'node-child', 'native-node')); }
  // B3-1: the device double is the shared honest one. `node-1` is declared a bookmark, so it must
  // be a Chrome leaf - seeding `native-child` under it was only representable by a lenient
  // `remove`, and the SR-02 anchor test below needs a real `Can't find bookmark for id.` rejection.
  const api = honestChrome(); api.seed({ id: 'native-root', index: 0, title: 'root-colp' });
  if (!omitNodeMappings) { api.seed({ id: 'native-node', parentId: 'native-root', index: 0, title: 'node-1',
    url: 'https://example.test/' }); api.seed({ id: 'native-child', parentId: 'native-root', index: 1,
    title: 'node-child', url: 'https://example.test/' }); }
  let crashBoundary = crash;
  const options = { scope, store, api, session: { acceptedProtocolVersion: '0.2' as const, sessionId: 'session-pull',
    collectionId: scope.collectionId, conversionPolicy: { separator: 'preserve_remote' as const } },
    effectPageTemplate: 'https://known.example/effects/{effectId}/pages/{pageNumber}',
    effectPageAuthority: 'https://known.example', crash: (at: string) => {
      if (crashBoundary === at) { crashBoundary = undefined; throw new Error('worker_crash'); }
    } };
  const applier = createPullApplier(options);
  let ordinal = 0;
  const createEvent = (kind: 'Folder' | 'Bookmark' | 'Separator', sequence = ++ordinal, afterId?: string) =>
    pullFixtures.createEvent({ kind, sequence, collectionId: scope.collectionId, parentId: 'root-colp', afterId });
  const mutationEvent = (kind: 'update' | 'move' | 'delete') => pullFixtures.mutationEvent({ kind,
    sequence: ++ordinal, collectionId: scope.collectionId, targetId: 'node-1', parentId: 'root-colp' });
  const subtreeEvent = (paged: boolean) => pullFixtures.subtreeEvent({ sequence: ++ordinal,
    collectionId: scope.collectionId, targetId: 'node-1', members: ['node-1', 'node-child'], paged });
  const page = (events: readonly unknown[]) => pullFixtures.page({ events, nextCursor: 'cursor-next',
    collectionRevision: 'revision-next' });
  return { store, api, options, applier, mapping, createEvent, mutationEvent, subtreeEvent, page,
    corrupt: pullFixtures.corrupt, disableCrash: () => { crashBoundary = undefined; } };
}


test('AUDIT: an uncaptured local URL survives remote deletion', async () => {
  const f = await setup();
  const savedUrl = 'https://local-only.example/before-delete';
  f.api.seed({ id: 'native-node', parentId: 'native-root', index: 0, title: 'User edited', url: savedUrl });
  await f.applier.stage(f.page([f.mutationEvent('delete')]));
  await f.applier.resume();
  const queue = createBookmarkEventQueue({ scope, store: f.store,
    api: { get: async id => (await f.api.get(id)).map(node => ({ ...node, title: node.title ?? '' })),
      getChildren: async id => (await f.api.getChildren(id)).map(node => ({ ...node, title: node.title ?? '' })) } });
  await queue.recover();
  const exported = JSON.stringify(await f.store.exportScope(scope));
  let native: readonly { url?: string }[] = [];
  try { native = await f.api.get('native-node'); } catch { /* Removed by Pull. */ }
  assert.ok(native.some(node => node.url === savedUrl) || exported.includes(savedUrl),
    'the locally saved URL must survive in Chrome or durable recovery evidence');
});

test('delete does not call Chrome when persisting the local preimage fails', async () => {
  const f = await setup();
  const persist = f.store.saveDeleteMember;
  const store = { ...f.store, saveDeleteMember: async (...args: Parameters<typeof persist>) => {
    if (args[3].preimage) throw new Error('preimage storage unavailable');
    return persist(...args);
  } };
  const applier = createPullApplier({ ...f.options, store });
  await applier.stage(f.page([f.mutationEvent('delete')]));
  await applier.resume().catch(() => undefined);
  assert.equal((await f.api.get('native-node'))[0]?.url, 'https://example.test/');
});

test('a local edit during the durable delete barrier must survive', async () => {
  const f = await setup();
  const savedUrl = 'https://local-only.example/during-delete-barrier';
  const persist = f.store.saveDeleteMember;
  let edited = false;
  const store = { ...f.store, saveDeleteMember: async (...args: Parameters<typeof persist>) => {
    const saved = await persist(...args);
    if (!edited && args[3].preimage) {
      edited = true;
      f.api.seed({ id: 'native-node', parentId: 'native-root', index: 0, title: 'Edited during barrier', url: savedUrl });
    }
    return saved;
  } };
  const applier = createPullApplier({ ...f.options, store });
  await applier.stage(f.page([f.mutationEvent('delete')]));
  await applier.resume();
  let native: readonly { url?: string }[] = [];
  try { native = await f.api.get('native-node'); } catch { /* Removed by Pull. */ }
  assert.ok(native.some(node => node.url === savedUrl) || JSON.stringify(await f.store.exportScope(scope)).includes(savedUrl));
});
