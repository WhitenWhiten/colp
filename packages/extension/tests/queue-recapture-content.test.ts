import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { test } from 'vitest';
import { canonicalOperationDigest } from '@know-n/colp/sync';
import { createQueueRecapture } from '../src/queue-recapture.js';
import type { QueueOperation } from '../src/sync-state-store.js';
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

for (const anchor of ['pending', 'optimistic', 'tombstone', 'moved', 'confirmed']) test(`recapture validates its ${anchor} sorting anchor`, async () => {
  const f = await fixture();
  try {
    f.api.seed({ id: 'native-anchor', parentId: 'native-parent', index: 0, title: 'Anchor', url: 'https://example.test/anchor' });
    await f.api.move('native-create', { parentId: 'native-parent', index: 2 });
    assert.deepEqual((await f.api.getChildren('native-parent')).map(node => node.id), ['native-anchor', 'native-create']);
    const colpId = anchor === 'pending' ? 'pending-other-create' : 'other-node';
    await f.store.putMapping(scope, { nativeId: 'native-anchor', colpId, rootNativeId: 'native-parent',
      parentNativeId: 'native-parent', parentColpId: anchor === 'moved' ? 'other-parent' : 'root-push', nodeKind: 'bookmark',
      projection: { revision: anchor === 'pending' || anchor === 'optimistic' ? 'local-other-create' : 'r1',
        digest: 'sha256:anchor', content: { title: 'Anchor', url: 'https://example.test/anchor' } } });
    if (anchor === 'tombstone') await f.store.putRemoteObservation(scope, { colpId, kind: 'tombstone',
      remoteRevision: 'deleted-r2', cursor: 'cursor-deleted', sourceDigest: 'sha256:deleted', observedAt: 20,
      payload: { deleted: true } });
    const captured = await f.capture((await f.store.getQueueByOpId(scope, f.queued.opId))!);
    assert.equal((captured.operations[0]?.payload as any).afterId, anchor === 'confirmed' ? 'other-node' : undefined);
    assert.equal((captured.operations[0]?.payload as any).parentId, 'root-push');
  } finally { f.store.close(); }
});

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

test('recapture finds its op id on the operation index, not from ordinal 0', async () => {
  const logStarts: number[] = [];
  const opReads: Array<{ opId: string; after: number }> = [];
  const rows = [
    ...Array.from({ length: 220 }, (_, index) => ({
      ordinal: index + 1, opId: `noise-${index}`, kind: 'create', nativeId: `noise-${index}`,
      details: {}, status: 'processed' as const,
    })),
    { ordinal: 300, opId: 'op-target', kind: 'move', nativeId: 'native-old',
      details: { hold: { code: 'recovery_identity_unproven' } }, status: 'processed' as const },
    { ordinal: 301, opId: 'op-target', kind: 'create', nativeId: 'native-new', details: {}, status: 'processed' as const },
  ];
  const store = {
    getScope: async () => ({ lifecycle: 'active', rootStatus: 'ready' }),
    async listBookmarkEvents(_scope: unknown, after = 0, limit = 100) {
      logStarts.push(after);
      return rows.filter((row) => row.ordinal > after).slice(0, limit);
    },
    async listBookmarkEventsByOperation(_scope: unknown, opId: string, after = 0, limit = 100) {
      opReads.push({ opId, after });
      return rows.filter((row) => row.opId === opId && row.ordinal > after).slice(0, limit);
    },
  };
  const capture = createQueueRecapture({
    store: store as never, scope, api: { get: async () => [], getChildren: async () => [] },
    permission: async () => true,
  });
  const row = { opId: 'op-target', status: 'set_aside', recovery: { code: 'held' },
    payload: { type: 'create_node' } } as unknown as QueueOperation;
  await assert.rejects(capture(row), /recovery_identity_unproven/);
  assert.deepEqual(logStarts, []);
  assert.deepEqual(opReads, [{ opId: 'op-target', after: 0 }]);
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
