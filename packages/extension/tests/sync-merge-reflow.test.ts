import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { describe, test } from 'vitest';
import { createOutboundPushWorker, type PushSessionController } from '../src/outbound-push-worker.js';
import type { JsonObject } from '../src/sync-state-store.js';
import {
  endpoints, installOutboundPushIndexedDb, json, scope,
} from './outbound-push-worker-harness.js';
import { createSyncStateStore } from '../src/sync-state-store.js';
import { indexedDB } from './outbound-push-worker-harness.js';

installOutboundPushIndexedDb();

const updateOperation: JsonObject = { opId: 'op-update-1', replicaId: scope.replicaId, sequence: 1,
  collectionId: scope.collectionId, type: 'update_node_content', targetId: 'node-bookmark',
  baseRevision: 'node-r1', occurredAt: '2026-07-27T00:00:00.000Z', dependencies: [],
  payload: { base: { title: 'Before', url: 'https://example.test/before' },
    value: { title: 'Local edit', url: 'https://example.test/before' } } };

async function setupUpdate(transform?: JsonObject) {
  const store = createSyncStateStore({ indexedDB });
  await store.registerScope({ ...scope, lifecycle: 'active',
    lease: { leaseId: 'lease-server', expiresAt: Date.parse('2099-01-01T00:00:00Z') }, checkpoint: null,
    selectedRoots: [] });
  await store.putMapping(scope, { nativeId: 'native-bookmark', colpId: 'node-bookmark',
    rootNativeId: 'root-native', nodeKind: 'bookmark',
    projection: { revision: 'node-r1', digest: 'sha256:bookmark',
      content: { title: 'Before', url: 'https://example.test/before' } } });
  const queued = await store.allocateSequenceAndEnqueue(scope, { opId: 'op-update-1', batchId: 'batch-update-1',
    idempotencyKey: 'idempotency-update-1', digest: 'sha256:operation-update-1', endpointIdentity: 'syncPush',
    mediaType: 'application/json', baseRevision: 'node-r1', operationRevision: 'local-event-update-1',
    status: 'pending', retry: { attempt: 0, notBefore: 0 }, payload: updateOperation }, { allowUnstamped: true });
  const clock = { now: 10_000 };
  const sessions: PushSessionController = { async get() { return {
    credential: { accessToken: 'access-token-push' }, session: { sessionId: 'session-push',
      expiresAt: '2099-01-01T00:00:00Z', scope: 'collection', snapshotRequired: false,
      credentialAuthorityDigest: 'a'.repeat(64),
      collection: { collectionId: scope.collectionId,
        serverCursor: 'cursor-0', serverRevision: 'revision-0' },
      replicaLease: { leaseId: 'lease-server', generation: '1', state: 'active',
        expiresAt: '2099-01-01T00:00:00Z' } } }; } };
  const result = { opId: 'op-update-1', sequence: 1, status: 'rebased' as const,
    targetId: 'node-bookmark', revision: 'node-r2', cursor: 'cursor-2', warnings: [],
    ...(transform === undefined ? {} : { transform }) };
  const worker = createOutboundPushWorker({ scope, store, endpoints: async () => endpoints,
    sessions, now: () => clock.now, random: () => 0, ownerId: () => 'owner-push',
    schedule: () => undefined,
    fetch: async () => json(200, { batchId: 'batch-update-1', results: [result],
      serverCursor: 'cursor-2' }) });
  return { store, queued, worker };
}

describe('F011 merge/rebased results reflow authoritative content into the mapping', () => {
  test('a rebased update receipt stores the merged transform, not the local attempt', async () => {
    const fixture = await setupUpdate({ title: 'Local edit', url: 'https://example.test/server' });
    assert.equal((await fixture.worker.drain()).outcome, 'terminal');
    const mapping = await fixture.store.getMappingByColpId(scope, 'node-bookmark');
    assert.equal(mapping?.projection.revision, 'node-r2');
    assert.deepEqual(mapping?.projection.content,
      { title: 'Local edit', url: 'https://example.test/server' });
  });

  test('a rebased receipt without transform keeps the local overlay fallback', async () => {
    const fixture = await setupUpdate();
    assert.equal((await fixture.worker.drain()).outcome, 'terminal');
    const mapping = await fixture.store.getMappingByColpId(scope, 'node-bookmark');
    assert.deepEqual(mapping?.projection.content,
      { title: 'Local edit', url: 'https://example.test/before' });
  });
});
