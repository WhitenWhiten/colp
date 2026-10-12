import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { test } from 'vitest';
import type { JsonObject } from '../src/sync-state-store.js';
import { pullFixtures } from './pull-effect-fixtures.js';
import { setupT03, seedMappedNode, mapping, reopenT03, t03Scope as scope } from './srg-t03-delete-harness.js';

test('a proven self-create echo does not require a historical sibling that was deleted later', async () => {
  const f = await setupT03();
  await seedMappedNode(f, { nativeId: 'self', colpId: 'node-created-1', parentNativeId: 'native-root',
    parentColpId: 'root-colp', nodeKind: 'bookmark', title: 'Remote', url: 'https://example.test/' });
  await f.store.putMapping(scope, mapping('unmounted:dead', 'dead', { parentNativeId: 'native-root', parentColpId: 'root-colp' }));
  const event = pullFixtures.createEvent({ kind: 'Bookmark', sequence: 1, collectionId: scope.collectionId,
    parentId: 'root-colp', replicaId: scope.replicaId, beforeId: 'dead' });
  if (event.kind !== 'operation') throw new Error('fixture');
  const row = await f.store.allocateSequenceAndEnqueue(scope, { opId: event.operation.opId, batchId: 'self',
    idempotencyKey: 'self', digest: 'sha256:self', endpointIdentity: 'syncPush', mediaType: 'application/json',
    baseRevision: null, operationRevision: 'local-self', status: 'pending', retry: { attempt: 0, notBefore: 0 },
    payload: event.operation as unknown as JsonObject }, { allowUnstamped: true });
  await f.store.completeQueueWithReceipt(scope, row.sequence, { opId: row.opId, operationDigest: row.digest,
    kind: 'terminal', receiptId: 'self', resultDigest: 'sha256:self' });
  await f.applier.stage(f.page([event])); await f.applier.resume();
  assert.equal(f.api.calls.filter(call => call.kind === 'create').length, 0);
  assert.equal((await f.store.exportScope(scope)).cursor?.cursor, 'cursor-next');
});

test('a pending local move is not evidence that the remote move already changed Chrome', async () => {
  const f = await setupT03('after_intent');
  await seedMappedNode(f, { nativeId: 'local-parent', colpId: 'local-parent-colp', parentNativeId: 'native-root',
    parentColpId: 'root-colp', nodeKind: 'folder' });
  await seedMappedNode(f, { nativeId: 'child', colpId: 'node-1', parentNativeId: 'local-parent',
    parentColpId: 'local-parent-colp', nodeKind: 'bookmark', title: 'Remote', url: 'https://example.test/' });
  const child = (await f.store.getMappingByNativeId(scope, 'child'))!; const { scopeKey: _key, ...value } = child;
  await f.store.putMapping(scope, { ...value, projection: { ...value.projection, revision: 'local-move', resourceRevision: 'local-move' } });
  await f.store.allocateSequenceAndEnqueue(scope, { opId: 'local-move', batchId: 'move', idempotencyKey: 'move',
    digest: 'sha256:move', endpointIdentity: 'syncPush', mediaType: 'application/json', baseRevision: 'revision-old',
    operationRevision: 'local-move', status: 'pending', retry: { attempt: 0, notBefore: 0 },
    payload: { type: 'move_node', targetId: 'node-1', payload: { newParentId: 'local-parent-colp' } } }, { allowUnstamped: true });
  await f.applier.stage(f.page([f.mutationEvent('move')]));
  await assert.rejects(f.applier.resume(), /worker_crash/);
  const event = (await f.store.listPullEvents(scope))[0]!;
  await f.store.markPullBrowserCallStarted(scope, String(event.eventId));
  const resumed = await reopenT03(f); await resumed.applier.resume();
  assert.equal(f.api.getNode('child')?.parentId, 'native-root');
  assert.equal((await resumed.store.getMappingByNativeId(scope, 'child'))?.parentNativeId, 'native-root');
  assert.equal((await resumed.store.listQueue(scope, 'pending')).length, 1, 'local intention remains uploadable');
});
