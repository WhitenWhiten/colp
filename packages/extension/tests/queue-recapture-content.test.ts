import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { test } from 'vitest';
import { canonicalOperationDigest } from '@know-n/colp/sync';
import { createQueueRecapture } from '../src/queue-recapture.js';
import { honestChrome } from './kns-05-pull-harness.js';
import { installOutboundPushIndexedDb, setup, scope } from './outbound-push-worker-harness.js';
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

test('rebinding IDs must not rewrite unrelated bookmark content', async () => {
  const f = await fixture();
  try {
    const old = `pending-${f.queued.opId}`;
    await f.store.putMapping(scope, { nativeId: 'independent-native', colpId: 'independent-node', rootNativeId: 'native-parent',
      parentNativeId: 'native-parent', parentColpId: 'root-push', nodeKind: 'bookmark',
      projection: { revision: 'r1', digest: 'sha256:independent', content: { title: old } } });
    await f.store.allocateSequenceAndEnqueue(scope, { opId: 'independent', batchId: 'independent', idempotencyKey: 'independent',
      digest: 'sha256:independent', endpointIdentity: 'syncPush', mediaType: 'application/json',
      baseRevision: 'r1', operationRevision: 'local-independent', status: 'pending', retry: { attempt: 0, notBefore: 0 },
      payload: { opId: 'independent', replicaId: scope.replicaId, sequence: 2, collectionId: scope.collectionId,
        type: 'update_node_content', targetId: 'independent-node', baseRevision: 'r1', occurredAt: '2026-10-18T00:00:00Z',
        dependencies: [], payload: { base: { title: 'Before' }, value: { title: old } } } }, { allowUnstamped: true });
    const [fresh] = await f.store.releaseSetAsideQueue(scope, [f.queued.sequence], f.capture);
    const mapped = await f.store.getMappingByColpId(scope, 'independent-node');
    const queued = await f.store.getQueueByOpId(scope, 'independent');
    assert.equal((queued?.payload.payload as any).value.title, old, 'user content is not an identity reference');
    assert.equal(mapped?.projection.content?.title, old);
    assert.equal(mapped?.projection.digest, 'sha256:independent');
    assert.notEqual(fresh!.opId, f.queued.opId);
  } finally { f.store.close(); }
});

test('related identities change while matching native text, patches and mapping content remain byte-for-byte', async () => {
  const f = await fixture();
  try {
    const old = `pending-${f.queued.opId}`;
    await f.api.update('native-create', { title: old });
    const content = { title: old, description: f.queued.opId, tags: [old, f.queued.operationRevision],
      extensions: { 'https://example.test/': { parentId: old, opId: f.queued.opId, title: old } } };
    const { scopeKey: _key, ...original } = (await f.store.getMappingByNativeId(scope, 'native-create'))!;
    await f.store.putMapping(scope, { ...original, projection: { ...original.projection, content } });
    const dependent = await enqueue(f, 'dependent-content', old, content);
    const sent = await enqueue(f, 'sent-content', old, content);
    const tx = (await f.store.open()).transaction('outbound_queue', 'readwrite');
    const sentRow = { ...sent, status: 'unknown', attempt: { sessionId: 'session-push', batchId: sent.batchId,
      idempotencyKey: sent.idempotencyKey, endpointIdentity: 'syncPush', mediaType: 'application/json',
      body: JSON.stringify({ sessionId: 'session-push', batchId: sent.batchId, operations: [sent.payload] }), bodyDigest: 'sha256:sent' } };
    tx.objectStore('outbound_queue').put(sentRow);
    await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); });
    const [fresh] = await f.store.releaseSetAsideQueue(scope, [f.queued.sequence], f.capture); assert.ok(fresh);
    const rebound = (await f.store.getQueueByOpId(scope, dependent.opId))!;
    assert.equal(rebound.payload.targetId, `pending-${fresh.opId}`);
    assert.equal(rebound.baseRevision, `local-${fresh.opId}`);
    assert.deepEqual(rebound.payload.dependencies, [fresh.opId]);
    assert.deepEqual(rebound.payload.payload, dependent.payload.payload);
    assert.equal(rebound.digest, canonicalOperationDigest(rebound.payload as never));
    assert.equal((fresh.payload.payload as any).node.title, old);
    const mapping = (await f.store.getMappingByNativeId(scope, 'native-create'))!;
    assert.equal(mapping.colpId, `pending-${fresh.opId}`);
    assert.deepEqual(mapping.projection.content, content);
    assert.equal(mapping.projection.digest, original.projection.digest);
    assert.deepEqual(await f.store.getQueueByOpId(scope, sent.opId), sentRow);
  } finally { f.store.close(); }
});

test('a transaction constraint abort leaves the old row, mappings, sequences and native capture evidence intact', async () => {
  const f = await fixture();
  try {
    await enqueue(f, 'collision', 'independent', { title: 'Independent' });
    const before = await f.store.exportScope(scope);
    await assert.rejects(f.store.releaseSetAsideQueue(scope, [f.queued.sequence], async row => {
      const capture = await f.capture(row);
      return { ...capture, operations: capture.operations.map(operation => ({ ...operation, opId: 'collision' })) };
    }));
    const after = await f.store.exportScope(scope);
    assert.deepEqual(after.queue, before.queue);
    assert.deepEqual(after.mappings, before.mappings);
    assert.deepEqual(after.bookmarkEvents, before.bookmarkEvents);
    const [fresh] = await f.store.releaseSetAsideQueue(scope, [f.queued.sequence], f.capture);
    assert.equal(fresh?.sequence, Math.max(...before.queue.map(row => row.sequence)) + 1);
  } finally { f.store.close(); }
});

async function enqueue(f: Awaited<ReturnType<typeof fixture>>, opId: string, targetId: string, content: any) {
  return f.store.allocateSequenceAndEnqueue(scope, { opId, batchId: opId, idempotencyKey: opId,
    digest: 'sha256:dependent', endpointIdentity: 'syncPush', mediaType: 'application/json',
    baseRevision: f.queued.operationRevision, operationRevision: `local-${opId}`, status: 'pending', retry: { attempt: 0, notBefore: 0 },
    payload: { opId, replicaId: scope.replicaId, sequence: 0, collectionId: scope.collectionId,
      type: 'update_node_content', targetId, baseRevision: f.queued.operationRevision,
      occurredAt: '2026-10-18T00:00:00Z', dependencies: [f.queued.opId],
      payload: { base: structuredClone(content), value: structuredClone(content) } } }, { allowUnstamped: true });
}
