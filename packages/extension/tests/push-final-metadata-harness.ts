import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { expect } from 'vitest';
import { createBookmarkAnnotationStore } from '../src/bookmark-annotation-store.js';
import { reconcileBookmarkTags } from '../src/bookmark-tag-sync.js';
import { createAuthorityFence } from '../src/authority-fence.js';
import { MemoryStorageArea } from '../src/credential-store.js';
import { createMetadataSyncPolicyStore } from '../src/metadata-sync-policy.js';
import { assertQueuedUploadAllowed } from '../src/queued-upload-boundary.js';
import { createSyncEffectAuthority } from '../src/sync-effect-authority.js';
import { createChromePullBookmarkApi } from '../src/pull-bookmark-api.js';
import { createOutboundPushWorker } from '../src/outbound-push-worker.js';
import { fixture, scope } from './bookmark-event-queue-harness.js';
import { endpoints } from './outbound-push-worker-harness.js';
import { rejoinSession, REJOIN_TOKEN } from './rejoin-http-fixture.js';

export async function metadataBoundaryFixture() {
  const factory = new IDBFactory(), f = await fixture(factory, { mappedNode: true });
  const annotations = createBookmarkAnnotationStore({ indexedDB: factory });
  const bookmark = { id: 'mapped', title: 'Page', parentId: 'root-selected', url: 'https://example.test/' };
  f.api.put(bookmark);
  const { scopeKey: _key, ...mapping } = (await f.store.getMappingByNativeId(scope, bookmark.id))!;
  await f.store.putMapping(scope, { ...mapping, nodeKind: 'bookmark', projection: { ...mapping.projection,
    content: { title: bookmark.title, url: bookmark.url, tags: ['base'] } } });
  const root = (await f.store.getMappingByNativeId(scope, 'root-selected'))!;
  await f.store.putMountBinding(scope, { mountId: 'metadata-selected', nativeRootId: root.nativeId,
    remoteMountNodeId: root.colpId, customSourceKey: 'selected', boundaryVersion: '1', status: 'active', materialized: true });
  const input = { scope, sync: f.store, annotations, tree: [bookmark], queue: f.queue,
    allowed: () => true, assertCurrent: async () => undefined };
  await reconcileBookmarkTags(input); await annotations.save(bookmark, { tags: ['base', 'local'], note: 'Private draft' });
  expect((await reconcileBookmarkTags(input)).staged).toBe(1); await f.queue.flush();
  const original = (await f.store.listQueue(scope))[0]!;
  expect(original.payload).toMatchObject({ payload: { value: { tags: ['base', 'local'] } } });
  const metadataStorage = new MemoryStorageArea(), policy = createMetadataSyncPolicyStore(metadataStorage);
  await policy.write(scope, true);
  const fence = createAuthorityFence(new MemoryStorageArea()), context = await fence.capture();
  const session = await rejoinSession(scope), sent: string[] = [];
  const hooks: { duringAdmission?: () => Promise<void>; afterFinalProof?: () => Promise<void> } = {};
  let admitted = false;
  const read = metadataStorage.get.bind(metadataStorage);
  metadataStorage.get = async keys => {
    const value = await read(keys); admitted = true; await hooks.duringAdmission?.(); return value;
  };
  const effects = createSyncEffectAuthority({ scope, context, api: createChromePullBookmarkApi(), metadataPolicy: policy,
    assertWritable: generation => fence.assertWritable(generation), currentScope: async () => scope,
    fetch: async (_url, init) => {
      sent.push(String(init?.body)); const request = JSON.parse(sent.at(-1)!);
      return Response.json({ batchId: request.batchId, serverCursor: 'after-metadata', results: [{ opId: original.opId,
        sequence: original.sequence, status: 'applied', targetId: 'mapped-colp', revision: 'tags-r2', cursor: 'tags-c2', warnings: [] }] });
    } });
  const options: Parameters<typeof createOutboundPushWorker>[0] = { store: f.store, scope, endpoints: async () => endpoints,
    sessions: { get: async () => ({ credential: { accessToken: REJOIN_TOKEN, subject: scope.accountId }, session }) },
    fetch: effects.fetch, ownerId: () => 'metadata-final-boundary', schedule: () => undefined,
    assertUploadAllowed: async queue => {
      await assertQueuedUploadAllowed({ store: f.store, scope, queue, parentOf: async id => (await f.api.get(id))[0]?.parentId });
      if (admitted) await hooks.afterFinalProof?.();
    } };
  return { ...f, annotations, bookmark, original, hooks, policy, fence, sent, options,
    close() { annotations.close(); f.store.close(); } };
}
