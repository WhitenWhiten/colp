import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { test } from 'vitest';
import { installKns05IndexedDb, setup, scope } from './kns-05-pull-harness.js';
import { pullFixtures } from './pull-effect-fixtures.js';

installKns05IndexedDb();

async function fixture(input: { removal?: 'pending' | 'processed' | 'unrelated'; receipt?: boolean;
  crash?: string; foreign?: boolean; wrongRevision?: boolean; create?: boolean } = {}) {
  const f = await setup(input.crash, input.create);
  if (input.create) f.api.seed({ id: 'native-node', parentId: 'native-root', title: 'Remote', url: 'https://example.test/' });
  const identity = { sequence: 1, collectionId: scope.collectionId, parentId: 'root-colp',
    replicaId: input.foreign ? 'another-replica' : scope.replicaId };
  const event = input.create ? pullFixtures.createEvent({ ...identity, kind: 'Bookmark' })
    : pullFixtures.mutationEvent({ ...identity, kind: 'update', targetId: 'node-1' });
  assert.equal(event.kind, 'operation');
  if (event.kind !== 'operation' || (event.effect.kind !== 'node_content_updated'
      && event.effect.kind !== 'node_created')) throw new Error('fixture_invalid');
  const revision = event.effect.node.revision; const targetId = event.effect.node.id;
  await f.store.putMapping(scope, { nativeId: 'native-node', colpId: targetId, rootNativeId: 'native-root',
    parentNativeId: 'native-root', nodeKind: 'bookmark', projection: { revision: input.wrongRevision ? 'unconfirmed' : revision,
      digest: 'sha256:updated', content: { title: 'Remote update', url: 'https://example.test/' } } });
  const queued = await f.store.allocateSequenceAndEnqueue(scope, { opId: event.operation.opId,
    batchId: 'update', idempotencyKey: 'update', digest: 'sha256:update', endpointIdentity: 'syncPush',
    mediaType: 'application/json', baseRevision: 'revision-old', operationRevision: 'local-update',
    status: 'pending', retry: { attempt: 0, notBefore: 0 },
    payload: input.create ? { type: 'create_node' } : { type: 'update_node_content', targetId } }, { allowUnstamped: true });
  await f.store.completeQueueWithReceipt(scope, queued.sequence, { opId: queued.opId,
    operationDigest: queued.digest, kind: 'terminal', receiptId: 'update-receipt', resultDigest: 'sha256:receipt',
    ...(input.receipt === false ? {} : { result: { results: [{ opId: queued.opId, sequence: queued.sequence,
      status: 'applied', revision, targetId }] } }) });
  await f.api.remove('native-node');
  if (input.removal) {
    const nativeId = input.removal === 'unrelated' ? 'native-child' : 'native-node';
    const removedTargetId = input.removal === 'unrelated' ? 'node-child' : targetId;
    const removal = await f.store.stageBookmarkEvent(scope, { eventId: 'remove', dedupeKey: 'remove',
      nativeId, kind: 'remove', occurredAt: '2026-10-18T00:00:00Z',
      details: { deleteNativeIds: [nativeId], draft: { type: 'delete_node', targetId: removedTargetId } } });
    if (input.removal === 'processed') await f.store.commitBookmarkEvent(scope, removal.event.eventId, {
      operation: { type: 'delete_node', targetId: removedTargetId }, baseRevision: revision, operationRevision: 'local-delete',
      deleteNativeIds: input.wrongRevision ? [] : [nativeId],
      allocateOperationId: () => 'delete', validateOperation: () => true, digestOperation: () => 'sha256:delete',
    });
  }
  await f.applier.stage(f.page([event]));
  return f;
}

test.each(['pending', 'processed', 'restart'] as const)(
  'a confirmed update echo leaves a later local deletion syncing: %s', async state => {
    const f = await fixture({ removal: state === 'pending' ? 'pending' : 'processed',
      ...(state === 'restart' ? { crash: 'after_intent' } : {}) });
    try {
      if (state === 'restart') await assert.rejects(() => f.applier.resume(), /worker_crash/);
      await f.applier.resume();
      assert.deepEqual(await f.store.listPullIssues(scope), []);
      assert.equal(f.api.getNode('native-node'), undefined);
      assert.equal(f.api.calls.some(call => call.kind === 'update' || call.kind === 'create'), false);
      assert.equal((await f.store.exportScope(scope)).pullPages[0]?.state, 'page_complete');
      if (state !== 'pending') assert.equal((await f.store.getQueueByOpId(scope, 'delete'))?.status, 'pending');
    } finally { f.store.close(); }
  });

test('an older create echo cannot recreate a native after its later removal deleted the mapping', async () => {
  const f = await fixture({ create: true, removal: 'processed' });
  try {
    await f.applier.resume();
    assert.deepEqual(await f.store.listPullIssues(scope), []);
    assert.equal(f.api.calls.some(call => call.kind === 'create'), false);
    assert.equal((await f.store.getQueueByOpId(scope, 'delete'))?.status, 'pending');
    assert.equal((await f.store.exportScope(scope)).pullPages[0]?.state, 'page_complete');
    assert.equal((await f.store.getMappingByColpId(scope, 'root-colp'))?.projection.childrenRevision, 'children-1');
  } finally { f.store.close(); }
});

test.each([{ removal: 'processed' as const, foreign: true }, { removal: 'processed' as const, receipt: false },
  { removal: 'processed' as const, wrongRevision: true }])(
  'an update of a node this browser removed is superseded by that removal: %j', async input => {
  // The removal itself is the authority (pull-local-delete-supersede.ts): another device's edit, or
  // this browser's own echo without its receipt, no longer needs repair for a node the user deleted.
  const f = await fixture(input);
  try {
    await f.applier.resume();
    assert.deepEqual(await f.store.listPullIssues(scope), []);
    assert.equal((await f.store.exportScope(scope)).pullPages[0]?.state, 'page_complete');
  } finally { f.store.close(); }
});

test.each([{}, { removal: 'unrelated' as const }])('a missing target still requires repair without matching local removal authority: %j', async input => {
  const f = await fixture(input);
  try {
    await f.applier.resume();
    assert.deepEqual((await f.store.listPullIssues(scope)).map(issue => issue.code), ['pull_apply_target_missing']);
  } finally { f.store.close(); }
});
