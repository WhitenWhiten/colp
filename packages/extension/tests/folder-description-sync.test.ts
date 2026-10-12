import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { createFolderDescriptionStore } from '../src/folder-description-store.js';
import { reconcileFolderDescriptions, importFolderDescriptionSnapshot } from '../src/folder-description-sync.js';
import { fixture, scope } from './bookmark-event-queue-harness.js';
import type { CompleteRemoteSnapshot } from '../src/bootstrap/remote-snapshot.js';

let f: Awaited<ReturnType<typeof fixture>>, descriptions: ReturnType<typeof createFolderDescriptionStore>;
const native = { id: 'folder-parent', title: 'Parent', dateAdded: 100 };
const tree = [{ id: '0', title: '', children: [{ id: 'root-selected', title: 'Bar', children: [native] }] }];
beforeEach(async () => {
  const factory = new IDBFactory(); f = await fixture(factory); descriptions = createFolderDescriptionStore({ indexedDB: factory });
  const raw = (await f.store.getMappingByNativeId(scope, native.id))!;
  const { scopeKey: _scopeKey, ...mapping } = raw;
  await f.store.putMapping(scope, { ...mapping, nodeKind: 'folder', projection: { ...mapping.projection,
    content: { title: 'Parent', description: 'Cloud scope' } } });
});
afterEach(() => { f.store.close(); descriptions.close(); });
const inputs = () => ({ scope, sync: f.store, descriptions, tree, queue: f.queue,
  allowed: (mapping: { nativeId: string }) => mapping.nativeId === native.id, assertCurrent: async () => undefined });

test('an offline description uses the real existing queue as a description-only CAS update', async () => {
  await reconcileFolderDescriptions(inputs()); await descriptions.save(native, 'Offline scope');
  expect(await reconcileFolderDescriptions(inputs())).toMatchObject({ staged: 1, needsSnapshot: false });
  await f.queue.flush();
  const rows = await f.store.listQueue(scope);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.payload).toMatchObject({ type: 'update_node_content', targetId: 'folder-colp', baseRevision: 'folder-revision-2',
    payload: { base: { description: 'Cloud scope' }, value: { description: 'Offline scope' } } });
  expect(f.api.node(native.id).title).toBe('Parent');
  expect((await descriptions.get(native))?.state).toBe('dirty');
  expect((await reconcileFolderDescriptions(inputs())).staged).toBe(0);
  expect(await f.store.listQueue(scope)).toHaveLength(1);
});

test('an authoritative echo completes a local description and a later cloud clear reaches local storage', async () => {
  await reconcileFolderDescriptions(inputs()); await descriptions.save(native, 'Offline scope');
  await reconcileFolderDescriptions(inputs()); await f.queue.flush();
  const raw = (await f.store.getMappingByNativeId(scope, native.id))!;
  const { scopeKey: _scopeKey, ...mapping } = raw;
  await f.store.putMapping(scope, { ...mapping, projection: { ...mapping.projection, revision: 'r3', resourceRevision: 'r3', content: { title: 'Parent', description: 'Offline scope' } } });
  await reconcileFolderDescriptions(inputs()); expect((await descriptions.get(native))?.state).toBe('synced');
  await f.store.putMapping(scope, { ...mapping, projection: { ...mapping.projection, revision: 'r4', resourceRevision: 'r4', content: { title: 'Parent', description: null } } });
  await reconcileFolderDescriptions(inputs()); expect((await descriptions.get(native))?.description).toBeNull();
});

test('first sync migrates an old title-only projection once and preserves the description written before sign-in', async () => {
  const raw = (await f.store.getMappingByNativeId(scope, native.id))!;
  const { scopeKey: _scopeKey, ...mapping } = raw;
  await f.store.putMapping(scope, { ...mapping, projection: { ...mapping.projection, content: { title: 'Parent' } } });
  await descriptions.save(native, 'Written before sign-in');
  expect(await reconcileFolderDescriptions(inputs())).toMatchObject({ staged: 0, needsSnapshot: true });
  const snapshot: CompleteRemoteSnapshot = { snapshotId: 'snapshot', revision: 'c1', syncCursor: 'cursor', pageCount: 1, identityDigest: 'digest',
    remoteFacts: [{ nodeId: 'folder-colp', parentId: null, kind: 'folder', title: 'Parent', revision: 'folder-revision-2', description: null }] };
  await importFolderDescriptionSnapshot({ ...inputs(), snapshot });
  expect(await reconcileFolderDescriptions(inputs())).toMatchObject({ staged: 1, needsSnapshot: false });
  await f.queue.flush();
  expect((await f.store.listQueue(scope))[0]!.payload).toMatchObject({ payload: { base: { description: null }, value: { description: 'Written before sign-in' } } });
});

test('private or detached folders retain their local descriptions and author no cloud operation', async () => {
  await descriptions.save(native, 'Keep private');
  expect(await reconcileFolderDescriptions({ ...inputs(), allowed: () => false })).toMatchObject({ staged: 0, needsSnapshot: false });
  expect((await descriptions.get(native))?.description).toBe('Keep private');
  expect(await f.store.listQueue(scope)).toEqual([]);
});

test.each([false, true])('a resolved description conflict is not recreated and preserves a newer draft (%s)', async newerDraft => {
  await reconcileFolderDescriptions(inputs()); await descriptions.save(native, 'Conflicted local value');
  await reconcileFolderDescriptions(inputs()); await f.queue.flush();
  const [queued] = await f.store.listQueue(scope);
  const lease = await f.store.acquireLease(scope, 'description-review', 100, 1_000);
  await f.store.claimQueue(scope, 'description-review', lease.fence, 100, queued!.sequence);
  await f.store.settleClaimedPush(scope, queued!.sequence, 'description-review', lease.fence, {
    outcome: 'blocked', retry: { attempt: 0, notBefore: 100 }, recovery: { code: 'conflict_pending' },
    receipt: { opId: queued!.opId, operationDigest: queued!.digest, kind: 'terminal', receiptId: 'description-conflict',
      resultDigest: 'sha256:description-conflict', result: { results: [{ opId: queued!.opId, sequence: queued!.sequence,
        status: 'conflicted', conflictId: 'conflict-description' }] } },
  });
  if (newerDraft) await descriptions.save(native, 'Newer offline draft');
  const raw = (await f.store.getMappingByNativeId(scope, native.id))!;
  const { scopeKey: _scopeKey, ...mapping } = raw;
  await f.store.putMapping(scope, { ...mapping, projection: { ...mapping.projection, revision: 'resolved-r3', resourceRevision: 'resolved-r3',
    content: { title: 'Parent', description: 'Cloud value chosen by user' } } });
  await f.store.stagePullPage(scope, { pageId: 'description-resolution', previousCursor: 'cursor-3', nextCursor: 'cursor-4',
    collectionRevision: 'resolved-c4', pageDigest: 'sha256:description-resolution', effectPages: [], events: [{
      eventId: 'description-resolution', cursor: 'cursor-4', operationId: 'resolution-op', effectId: 'resolution-effect',
      effectDigest: 'sha256:resolution-effect', operationDigest: 'sha256:resolution-op', kind: 'node_content_updated',
      initialState: 'authority_committed', payload: { kind: 'operation', operation: { opId: 'resolution-op',
        dependencies: [queued!.opId], source: { adapterProfile: 'known-conflict-resolution' } } },
    }] });
  await f.store.completePullPage(scope, 'description-resolution');
  expect((await f.store.getQueueByOpId(scope, queued!.opId))?.status).toBe('terminal');
  expect(await reconcileFolderDescriptions(inputs())).toMatchObject({ staged: newerDraft ? 1 : 0 });
  expect(await descriptions.get(native)).toMatchObject({ description: newerDraft ? 'Newer offline draft' : 'Cloud value chosen by user',
    state: newerDraft ? 'dirty' : 'synced', remote: { revision: 'resolved-r3', description: 'Cloud value chosen by user' } });
  await f.queue.flush();
  const rows = await f.store.listQueue(scope);
  expect(rows).toHaveLength(newerDraft ? 2 : 1);
  if (newerDraft) expect(rows[1]!.payload).toMatchObject({ baseRevision: 'resolved-r3', payload: {
    base: { description: 'Cloud value chosen by user' }, value: { description: 'Newer offline draft' },
  } });
});
