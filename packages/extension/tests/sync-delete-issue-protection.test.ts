import { verifySyncResilienceCase } from '../../conformance/src/sync-resilience.mjs';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { test } from 'vitest';
import { canonicalAuthoritativeEffectDigest, canonicalOperationDigest } from '@know-n/colp/sync';

import { installKns05IndexedDb, scope, setup } from './kns-05-pull-harness.js';
import { pullFixtures } from './pull-effect-fixtures.js';

import { installOutboundPushIndexedDb } from './outbound-push-worker-harness.js';

installKns05IndexedDb();
installOutboundPushIndexedDb();
const id = (n: number) => `node-created-${n}`;
const create = (n: number, parentId = 'root-colp', kind: 'Bookmark' | 'Folder' = 'Bookmark') =>
  pullFixtures.createEvent({ sequence: n, parentId, kind, collectionId: scope.collectionId });
function update(n: number, targetId: string, parentId: string, long = false, targetKind: 'bookmark' | 'folder' = 'bookmark') {
  const event: any = pullFixtures.mutationEvent({ sequence: n, kind: 'update', targetId, parentId, targetKind,
    collectionId: scope.collectionId });
  if (long) {
    event.effect.node.title = 'x'.repeat(300_000);
    event.operation.payload.value.title = event.effect.node.title;
    event.effect.operationDigest = canonicalOperationDigest(event.operation);
    event.effect.effectDigest = canonicalAuthoritativeEffectDigest(event.effect);
  }
  return event;
}
async function apply(f: Awaited<ReturnType<typeof setup>>, events: any[], cursor: string) {
  await f.applier.stage(f.page(events, cursor)); await f.applier.resume();
}

test('review: a subtree delete must retain a descendant with an open Pull issue', async () => {
  const f = await setup();
  try {
    await apply(f, [create(91, 'root-colp', 'Folder'), create(92, id(91)), create(93, id(91))], 'cursor-1');
    const held = (await f.store.getMappingByColpId(scope, id(92)))!;
    const ancestor = (await f.store.getMappingByColpId(scope, id(91)))!;
    const sibling = (await f.store.getMappingByColpId(scope, id(93)))!;
    await apply(f, [update(94, id(92), id(91), true)], 'cursor-2');
    assert.equal((await f.store.listPullIssues(scope)).length, 1);
    await apply(f, [pullFixtures.subtreeEvent({ sequence: 95, targetId: id(91),
      collectionId: scope.collectionId, members: [id(91), id(92), id(93)], paged: false })], 'cursor-3');
    assert.ok(f.api.getNode(held.nativeId), 'open Pull issue must protect the native bookmark');
    assert.ok(await f.store.getLocalSyncExclusion(scope, held.nativeId));
    assert.equal(await f.store.getMappingByNativeId(scope, held.nativeId), null);
    assert.ok(await f.store.getMappingByColpId(scope, id(92)), 'retained node has virtual tombstone mapping');
    assert.equal((await f.store.listPullIssues(scope)).length, 1);
    assert.equal((await f.store.getCursor(scope))?.cursor, 'cursor-3');
    assert.equal(f.api.all().filter(node => node.title === 'Remote').length, 2, 'only folder and issue child remain');
    assert.deepEqual(verifySyncResilienceCase('SYNC-0035', {
      protected: [id(92)], ancestors: [id(91)], independent: [id(93)],
      survivors: [ancestor, held, sibling].filter(mapping => f.api.getNode(mapping.nativeId)).map(mapping => mapping.colpId),
      excluded: await f.store.getLocalSyncExclusion(scope, held.nativeId) ? [id(92)] : [],
      retainedIssues: (await f.store.listPullIssues(scope)).map(issue => issue.nodeId),
      cursor: (await f.store.getCursor(scope))?.cursor, previousCursor: 'cursor-2',
    }), []);
  } finally { f.store.close(); }
});

test('single mapped Pull issue and missing subtree members retain evidence while siblings delete', async () => {
  const f = await setup();
  try {
    await apply(f, [create(91, 'root-colp', 'Folder'), create(92, id(91)), create(93, id(91))], 'cursor-1');
    const held = (await f.store.getMappingByColpId(scope, id(92)))!;
    const sibling = (await f.store.getMappingByColpId(scope, id(93)))!;
    await apply(f, [update(94, id(92), id(91), true)], 'cursor-2');
    await apply(f, [pullFixtures.mutationEvent({ sequence: 95, kind: 'delete', targetId: id(92),
      parentId: id(91), collectionId: scope.collectionId })], 'cursor-3');
    assert.ok(f.api.getNode(held.nativeId));
    await apply(f, [pullFixtures.subtreeEvent({ sequence: 96, targetId: id(91), collectionId: scope.collectionId,
      members: [id(91), id(92), id(93), 'unmapped-member'], paged: false })], 'cursor-4');
    assert.equal(f.api.getNode(sibling.nativeId), undefined);
    assert.ok(f.api.getNode(held.nativeId));
    assert.equal((await f.store.listPullIssues(scope)).length, 1);
    assert.equal((await f.store.getCursor(scope))?.cursor, 'cursor-4');
  } finally { f.store.close(); }
});

test('a missing subtree-root mapping does not prevent allowed mapped siblings from being deleted', async () => {
  const f = await setup();
  try {
    await apply(f, [create(91, 'root-colp', 'Folder'), create(92, id(91)), create(93, id(91))], 'cursor-1');
    const root = (await f.store.getMappingByColpId(scope, id(91)))!;
    const held = (await f.store.getMappingByColpId(scope, id(92)))!;
    const sibling = (await f.store.getMappingByColpId(scope, id(93)))!;
    await apply(f, [update(94, id(92), id(91), true)], 'cursor-2');
    await f.store.deleteMapping(scope, root.nativeId);
    await apply(f, [pullFixtures.subtreeEvent({ sequence: 95, targetId: id(91), collectionId: scope.collectionId,
      members: [id(91), id(92), id(93)], paged: false })], 'cursor-3');
    assert.ok(f.api.getNode(held.nativeId)); assert.ok(f.api.getNode(root.nativeId));
    assert.equal(f.api.getNode(sibling.nativeId), undefined);
    assert.equal((await f.store.getCursor(scope))?.cursor, 'cursor-3');
    assert.equal((await f.store.listPullIssues(scope)).length, 1);
    assert.ok(await f.store.getLocalSyncExclusion(scope, held.nativeId));
    assert.equal((await f.store.getLocalSyncExclusion(scope, root.nativeId))?.rootNativeId, 'native-root');
  } finally { f.store.close(); }
});
