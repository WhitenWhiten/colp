import { canonicalOperationDigest, canonicalAuthoritativeEffectDigest } from '@know-n/colp/sync';
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


test('RECHECK: a local URL saved while the native barrier commits must survive', async () => {
  const fixture = await setup();
  fixture.api.seed({ id: 'native-node', parentId: 'native-root', index: 0,
    title: 'First local edit', url: 'https://example.test/' });
  const latest = 'https://local-second.example/not-captured';
  const stage = fixture.store.stageBookmarkEvent.bind(fixture.store);
  const wrappedStore = { ...fixture.store, stageBookmarkEvent: async (...args: Parameters<typeof stage>) => {
    const result = await stage(...args);
    // Browser edits do not share IndexedDB's transaction lock. Deliberately
    // omit its callback to exercise the native barrier's fail-closed path.
    fixture.api.seed({ id: 'native-node', parentId: 'native-root', index: 0,
      title: 'Second local edit', url: latest });
    return result;
  } };
  const applier = createPullApplier({ ...fixture.options, store: wrappedStore });
  const incoming: any = fixture.mutationEvent('update');
  incoming.operation.payload.value.url = 'https://remote-new.example/';
  incoming.effect.node.url = 'https://remote-new.example/';
  incoming.effect.operationDigest = canonicalOperationDigest(incoming.operation);
  incoming.effect.effectDigest = canonicalAuthoritativeEffectDigest(incoming.effect);
  await applier.stage(fixture.page([incoming]));
  await applier.resume();
  assert.equal(fixture.api.calls.filter(call => call.kind === 'update').length, 0);
  const queue = createBookmarkEventQueue({ scope, store: fixture.store,
    api: { get: async (id) => (await fixture.api.get(id)).map(node => ({ ...node, title: node.title ?? '' })),
      getChildren: async (id) => (await fixture.api.getChildren(id)).map(node => ({ ...node, title: node.title ?? '' })) } });
  await queue.recover();
  assert.ok((await fixture.api.get('native-node')).some(node => node.url === latest)
    || JSON.stringify(await fixture.store.exportScope(scope)).includes(latest),
    'the second saved URL must remain in Chrome or durable storage');
});


test('RECHECK: original own-update echo preserves a later inbox draft', async () => {
  const fixture = await setup();
  fixture.api.seed({ id: 'native-node', parentId: 'native-root', index: 0,
    title: 'Later local edit', url: 'https://example.test/' });
  const queue = createBookmarkEventQueue({ scope, store: fixture.store,
    api: { get: async id => (await fixture.api.get(id)).map(node => ({ ...node, title: node.title ?? '' })),
      getChildren: async id => (await fixture.api.getChildren(id)).map(node => ({ ...node, title: node.title ?? '' })) },
    autoFlush: false });
  assert.equal((await queue.changed('native-node', { title: 'Later local edit' })).outcome, 'staged');
  const event = pullFixtures.mutationEvent({ kind: 'update', sequence: 1,
    collectionId: scope.collectionId, replicaId: scope.replicaId, targetId: 'node-1', parentId: 'root-colp' });
  await fixture.applier.stage(fixture.page([event]));
  await fixture.applier.resume();
  assert.equal((await fixture.api.get('native-node'))[0]?.title, 'Later local edit');
});
