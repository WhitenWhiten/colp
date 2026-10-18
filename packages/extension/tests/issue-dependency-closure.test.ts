import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { test } from 'vitest';
import { canonicalAuthoritativeEffectDigest, canonicalOperationDigest } from '@know-n/colp/sync';
import { MemoryStorageArea } from '../src/credential-store.js';
import { projectReplicaHealth, replicaIssuesFromPull, sendReplicaHealthReport } from '../src/sw/replica-health-report.js';
import { handleSyncAttentionRequest } from '../src/sw/sync-attention.js';
import { installKns05IndexedDb, scope, setup } from './kns-05-pull-harness.js';
import { pullFixtures } from './pull-effect-fixtures.js';
import { freezeScopeRecovery } from '../src/pull-recovery-freeze.js';
import { createOutboundPushWorker } from '../src/outbound-push-worker.js';
import { installOutboundPushIndexedDb, setup as pushSetup, scope as pushScope, json } from './outbound-push-worker-harness.js';

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

test('review: descendants of an existing held folder must be held too', async () => {
  const f = await setup();
  try {
    await apply(f, [create(91, 'root-colp', 'Folder'), create(92, id(91), 'Folder'), create(93, id(92))], 'cursor-1');
    const child = (await f.store.getMappingByColpId(scope, id(93)))!;
    await apply(f, [update(94, id(91), 'root-colp', true, 'folder')], 'cursor-2');
    const before = f.api.getNode(child.nativeId)!.title;
    await apply(f, [update(95, id(93), id(92))], 'cursor-3');
    assert.equal(f.api.getNode(child.nativeId)!.title, before, 'held folder must hold descendant updates');
  } finally { f.store.close(); }
});


async function enqueue(f: Awaited<ReturnType<typeof setup>>, opId: string, targetId: string) {
  return f.store.allocateSequenceAndEnqueue(scope, { opId, batchId: opId, idempotencyKey: opId, digest: `sha256:${opId}`,
    endpointIdentity: 'syncPush', mediaType: 'application/json', baseRevision: 'r1', operationRevision: `local-${opId}`,
    status: 'pending', retry: { attempt: 0, notBefore: 0 }, payload: { type: 'update_node_content', targetId,
      payload: { base: { title: 'Remote' }, value: { title: 'Local title' } } } }, { allowUnstamped: true });
}

test('Pull issue holds existing descendants in both directions and moves out; independent siblings continue', async () => {
  const f = await setup();
  try {
    await apply(f, [create(91, 'root-colp', 'Folder'), create(92, id(91), 'Folder'), create(93, id(92))], 'cursor-1');
    const grandchild = (await f.store.getMappingByColpId(scope, id(93)))!;
    const before = f.api.getNode(grandchild.nativeId)!;
    await apply(f, [update(95, id(91), 'root-colp', true, 'folder')], 'cursor-2');
    assert.equal((await enqueue(f, 'descendant-update', id(93))).status, 'set_aside');
    assert.equal((await enqueue(f, 'independent-update', 'node-1')).status, 'pending');
    const move = pullFixtures.mutationEvent({ sequence: 96, kind: 'move', targetId: id(93), parentId: 'root-colp', collectionId: scope.collectionId });
    await apply(f, [move, update(97, 'node-child', 'root-colp')], 'cursor-3');
    assert.deepEqual(f.api.getNode(grandchild.nativeId), before);
    const independent = (await f.store.getMappingByColpId(scope, 'node-child'))!;
    assert.equal(f.api.getNode(independent.nativeId)?.title, 'Remote update');
    await apply(f, [pullFixtures.mutationEvent({ sequence: 98, kind: 'delete', targetId: id(93), parentId: id(92), collectionId: scope.collectionId })], 'cursor-4');
    assert.ok(f.api.getNode(grandchild.nativeId));
    assert.equal((await f.store.getCursor(scope))?.cursor, 'cursor-4');
  } finally { f.store.close(); }
});

test('an upload issue on an existing folder holds grandchildren and moves into it across directions', async () => {
  const f = await setup();
  try {
    await apply(f, [create(91, 'root-colp', 'Folder'), create(92, id(91), 'Folder'), create(93, id(92))], 'cursor-1');
    const holder = await enqueue(f, 'folder-held', id(91));
    await f.store.setAsideQueue(scope, [holder.sequence], 'recovery_identity_unproven');
    const child = await enqueue(f, 'existing-grandchild', id(93));
    assert.equal(child.status, 'set_aside');
    const independent = (await f.store.getMappingByColpId(scope, 'node-1'))!;
    const before = f.api.getNode(independent.nativeId);
    await apply(f, [pullFixtures.mutationEvent({ sequence: 95, kind: 'move', targetId: 'node-1', parentId: id(92),
      collectionId: scope.collectionId })], 'cursor-2');
    assert.deepEqual(f.api.getNode(independent.nativeId), before);
    assert.ok((await f.store.listPullIssues(scope)).some(issue => issue.nodeId === 'node-1'));
  } finally { f.store.close(); }
});
