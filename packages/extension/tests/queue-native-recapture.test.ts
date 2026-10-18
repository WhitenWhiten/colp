import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { test } from 'vitest';
import { canonicalOperationDigest } from '@know-n/colp/sync';
import { createQueueRecapture } from '../src/queue-recapture.js';
import { createOutboundPushWorker } from '../src/outbound-push-worker.js';
import { honestChrome } from './kns-05-pull-harness.js';
import { installOutboundPushIndexedDb, setup, scope, json, problem } from './outbound-push-worker-harness.js';
installOutboundPushIndexedDb();
async function fixture() {
  const f = await setup({ createPlacement: 'bottom' });
  const recorded = (await f.store.getScope(scope))!;
  await f.store.registerScope({ ...recorded, selectedRoots: ['root-push'], rootStatus: 'ready' });
  await f.store.putMountBinding(scope, { mountId: 'mount', nativeRootId: 'native-parent', remoteMountNodeId: 'root-push',
    boundaryVersion: '1', materialized: true, status: 'active', rootRole: 'bookmarks-bar' });
  const api = honestChrome();
  api.seed({ id: 'native-parent', title: 'Root' });
  api.seed({ id: 'native-create', parentId: 'native-parent', title: 'Current title', url: 'https://example.test/current' });
  const capture = createQueueRecapture({ store: f.store, scope, api, permission: async () => true, now: () => 20_000 });
  await f.store.setAsideQueue(scope, [f.queued.sequence], 'recovery_identity_unproven');
  return { ...f, api, capture };
}
test('release creates a fresh native capture at the tail, with new identity, digest and dependency bindings', async () => {
  const f = await fixture();
  try {
    const rows = await f.store.releaseSetAsideQueue(scope, [f.queued.sequence], f.capture);
    assert.equal(rows.length, 1); const row = rows[0]!;
    assert.notEqual(row.opId, f.queued.opId); assert.notEqual(row.idempotencyKey, f.queued.idempotencyKey);
    assert.notEqual(row.digest, f.queued.digest); assert.equal(row.digest, canonicalOperationDigest(row.payload as never));
    assert.ok(row.sequence > f.queued.sequence);
    assert.equal((row.payload.payload as any).node.title, 'Current title');
    assert.equal((await f.store.getQueueByOpId(scope, f.queued.opId))?.status, 'rejected');
    assert.equal((await f.store.getMappingByNativeId(scope, 'native-create'))?.colpId, `pending-${row.opId}`);
    let sent: any; let expected = 1;
    const worker = createOutboundPushWorker({ ...f.options, fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)); sent = body.operations[0];
      if (sent.sequence !== expected) return problem(409, 'sequence_gap', { expectedSequence: expected });
      expected++;
      return json(200, { batchId: body.batchId, results: [{ opId: sent.opId, sequence: sent.sequence,
        status: 'applied', targetId: 'node-created', revision: 'r1', cursor: 'c1', warnings: [] }], serverCursor: 'c1' });
    } });
    assert.equal((await worker.drain()).outcome, 'gap');
    assert.equal((await worker.drain()).outcome, 'terminal');
    assert.equal(expected, 2);
    assert.equal(sent.payload.node.title, 'Current title');
    assert.equal((await f.store.getMappingByNativeId(scope, 'native-create'))?.colpId, 'node-created');
    assert.deepEqual(await f.store.releaseSetAsideQueue(scope, [f.queued.sequence], f.capture), []);
  } finally { f.store.close(); }
});
test('release reads the moved native parent instead of the original placement', async () => {
  const f = await fixture();
  try {
    f.api.seed({ id: 'native-new-parent', parentId: 'native-parent', title: 'New folder' });
    await f.store.putMapping(scope, { nativeId: 'native-new-parent', colpId: 'new-parent', rootNativeId: 'native-parent',
      parentNativeId: 'native-parent', parentColpId: 'root-push', nodeKind: 'folder',
      projection: { revision: 'r1', childrenRevision: 'children-1', digest: 'sha256:parent' } });
    await f.api.move('native-create', { parentId: 'native-new-parent', index: 0 });
    const [row] = await f.store.releaseSetAsideQueue(scope, [f.queued.sequence], f.capture);
    assert.equal((row!.payload.payload as any).parentId, 'new-parent');
  } finally { f.store.close(); }
});
for (const change of ['delete', 'outside', 'private'] as const) test(`held create ${change} never replays stale bytes`, async () => {
  const f = await fixture();
  try {
    if (change === 'delete') await f.api.remove('native-create');
    else {
      f.api.seed({ id: 'other-root', title: 'Outside' });
      await f.api.move('native-create', { parentId: 'other-root', index: 0 });
      if (change === 'private') {
        const recorded = (await f.store.getScope(scope))!;
        await f.store.putMapping(scope, { nativeId: 'other-root', colpId: 'private-root', rootNativeId: 'other-root',
          nodeKind: 'folder', projection: { revision: 'r1', digest: 'sha256:private' } });
        await f.store.registerScope({ ...recorded, selectedRoots: ['root-push', 'private-root'], privateRoots: ['private-root'] });
      }
    }
    assert.deepEqual(await f.store.releaseSetAsideQueue(scope, [f.queued.sequence], f.capture), []);
    assert.equal(await f.store.firstLaneQueue(scope), null);
    assert.equal((await f.store.getQueueByOpId(scope, f.queued.opId))?.recovery?.code, 'recaptured');
  } finally { f.store.close(); }
});
test('Retry requires fresh native proof and permission; merely clearing a hold is refused', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.store.releaseSetAsideQueue(scope, [f.queued.sequence]), /recapture_required/);
    const denied = createQueueRecapture({ store: f.store, scope, api: f.api, permission: async () => false });
    await assert.rejects(f.store.releaseSetAsideQueue(scope, [f.queued.sequence], denied), /permission_required/);
    const { scopeKey: _key, ...mapping } = (await f.store.getMappingByNativeId(scope, 'native-create'))!;
    await f.store.deleteMapping(scope, 'native-create');
    await f.store.putMapping(scope, { ...mapping, nativeId: 'other-native' });
    await assert.rejects(f.store.releaseSetAsideQueue(scope, [f.queued.sequence], f.capture), /recovery_identity_unproven/);
    assert.equal((await f.store.getQueueByOpId(scope, f.queued.opId))?.status, 'set_aside');
  } finally { f.store.close(); }
});

test('recapturing a create rebinds never-sent dependent targets and operation dependencies atomically', async () => {
  const f = await fixture();
  try {
    const dependent = await f.store.allocateSequenceAndEnqueue(scope, { opId: 'dependent', batchId: 'dependent',
      idempotencyKey: 'dependent', digest: 'sha256:old-dependent', endpointIdentity: 'syncPush', mediaType: 'application/json',
      baseRevision: f.queued.operationRevision, operationRevision: 'local-dependent', status: 'pending',
      retry: { attempt: 0, notBefore: 0 }, payload: { opId: 'dependent', replicaId: scope.replicaId, sequence: 2,
        collectionId: scope.collectionId, type: 'update_node_content', targetId: `pending-${f.queued.opId}`,
        baseRevision: f.queued.operationRevision, occurredAt: '2026-10-17T00:00:00Z', dependencies: [f.queued.opId],
        payload: { base: { title: 'Public' }, value: { title: 'Current title' } } } }, { allowUnstamped: true });
    assert.equal(dependent.status, 'set_aside');
    const [fresh] = await f.store.releaseSetAsideQueue(scope, [f.queued.sequence], f.capture);
    const rebound = (await f.store.getQueueByOpId(scope, 'dependent'))!;
    assert.equal(rebound.status, 'set_aside');
    assert.equal(rebound.payload.targetId, `pending-${fresh!.opId}`);
    assert.deepEqual(rebound.payload.dependencies, [fresh!.opId]);
    assert.equal(rebound.digest, canonicalOperationDigest(rebound.payload as never));
    assert.notEqual(rebound.idempotencyKey, dependent.idempotencyKey);
  } finally { f.store.close(); }
});
