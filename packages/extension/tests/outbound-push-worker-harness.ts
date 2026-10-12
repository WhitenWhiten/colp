import { IDBFactory } from 'fake-indexeddb';
import { beforeEach } from 'vitest';
import { type PushSessionController } from '../src/outbound-push-worker.js';
import { createSyncStateStore, type JsonObject, type SyncScope } from '../src/sync-state-store.js';

export const scope: SyncScope = { environment: 'production', serverId: 'https://known.example',
  serverOrigin: 'https://known.example', accountId: 'account-push', browserProfileId: 'profile-push',
  collectionId: 'collection-push', replicaId: 'replica-push', generation: 1 };
export const operation: JsonObject = { opId: 'op-push-1', replicaId: scope.replicaId, sequence: 1,
  collectionId: scope.collectionId, type: 'create_node', baseRevision: null,
  occurredAt: '2026-07-27T00:00:00.000Z', dependencies: [], payload: { parentId: 'root-push',
    node: { kind: 'bookmark', title: 'Public', url: 'https://example.test/public' } } };
export const endpoints = { syncSessions: 'https://known.example/v1/session', syncSnapshot: 'https://known.example/v1/snapshot',
  syncPush: 'https://known.example/v1/push', syncPull: 'https://known.example/v1/pull',
  syncAck: 'https://known.example/v1/ack', syncConflict: 'https://known.example/v1/conflicts/{conflictId}',
  syncEffectPages: 'https://known.example/v1/effects/{effectId}/pages/{pageNumber}',
  effectPageAuthority: 'https://known.example',
  syncRetire: 'https://known.example/v1/retire' } as const;

export let indexedDB: IDBFactory;
export function resetIndexedDb(factory = new IDBFactory()) {
  indexedDB = factory;
  return indexedDB;
}
export function installOutboundPushIndexedDb() {
  beforeEach(() => { resetIndexedDb(); });
}

export async function setup(input: { readonly createPlacement?: 'top' | 'bottom' } = {}) {
  const store = createSyncStateStore({ indexedDB }); await store.registerScope({ ...scope, lifecycle: 'active',
    lease: { leaseId: 'lease-server', expiresAt: Date.parse('2099-01-01T00:00:00Z') }, checkpoint: null,
    selectedRoots: [] });
  if (input.createPlacement) {
    await store.putMapping(scope, { nativeId: 'native-parent', colpId: 'root-push', rootNativeId: 'root-native',
      nodeKind: 'folder', projection: { revision: 'parent-r1', childrenRevision: 'children-r1',
        childrenOrder: ['native-anchor-old'], digest: 'sha256:parent' } });
    await store.putMapping(scope, { nativeId: 'native-anchor-old', colpId: 'anchor-old', rootNativeId: 'root-native',
      parentNativeId: 'native-parent', parentColpId: 'root-push', nodeKind: 'bookmark',
      projection: { revision: 'anchor-r1', digest: 'sha256:anchor', content: { title: 'Old' } } });
  }
  await store.putMapping(scope, { nativeId: 'native-create', colpId: 'pending-op-push-1', rootNativeId: 'root-native',
    ...(input.createPlacement ? { parentNativeId: 'native-parent', parentColpId: 'root-push' } : {}),
    nodeKind: 'bookmark', projection: { revision: 'local-event-push-1', digest: 'sha256:projection',
      content: { title: 'Public', url: 'https://example.test/public' } } });
  const database = await store.open(); const scopeKey = (await store.getScope(scope))!.scopeKey;
  const transaction = database.transaction('bookmark_events', 'readwrite');
  transaction.objectStore('bookmark_events').add({ scopeKey, eventId: 'event-push-1', ordinal: 1,
    dedupeKey: 'dedupe-push-1', occurredAt: '2026-07-27T00:00:00Z', kind: 'create', nativeId: 'native-create',
    details: { operation: { type: 'create_node' }, ...(input.createPlacement ? { context: {
      parentNativeId: 'native-parent', index: input.createPlacement === 'top' ? 0 : 1,
      placement: { version: 1, mode: input.createPlacement, targetParentNativeId: 'native-parent',
        collectionId: scope.collectionId, batchId: '11111111-1111-4111-8111-111111111111',
        batchOrder: 0, batchSize: 1, expectedIndex: input.createPlacement === 'top' ? 0 : 1,
        intentId: '22222222-2222-4222-8222-222222222222' } } } : {}) },
    status: 'processed', opId: 'op-push-1' });
  await new Promise<void>((resolve, reject) => { transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error); transaction.onabort = () => reject(transaction.error); });
  const queued = await store.allocateSequenceAndEnqueue(scope, { opId: 'op-push-1', batchId: 'batch-push-1',
    idempotencyKey: 'idempotency-push-1', digest: 'sha256:operation-push-1', endpointIdentity: 'syncPush',
    mediaType: 'application/json', baseRevision: null,
    operationRevision: 'local-event-push-1', status: 'pending', retry: { attempt: 0, notBefore: 0 },
    payload: input.createPlacement ? { ...operation, payload: { ...(operation.payload as JsonObject),
      ...(input.createPlacement === 'top' ? { beforeId: 'anchor-old' } : { afterId: 'anchor-old' }) } } : operation },
  { allowUnstamped: true });
  const clock = { now: 10_000 }; const sessions: PushSessionController = { async get() { return {
    credential: { accessToken: 'access-token-push' }, session: { sessionId: 'session-push',
      expiresAt: '2099-01-01T00:00:00Z', scope: 'collection', snapshotRequired: false,
      credentialAuthorityDigest: 'a'.repeat(64),
      collection: { collectionId: scope.collectionId,
        serverCursor: 'cursor-0', serverRevision: 'revision-0' }, replicaLease: { leaseId: 'lease-server', generation: '1',
        state: 'active', expiresAt: '2099-01-01T00:00:00Z' } } }; } };
  return { store, queued, clock, options: { scope, store, endpoints: async () => endpoints, sessions,
    now: () => clock.now, random: () => 0, ownerId: () => 'owner-push', schedule: () => undefined } };
}
export async function setupMove() {
  const store = createSyncStateStore({ indexedDB }); await store.registerScope({ ...scope, lifecycle: 'active',
    lease: { leaseId: 'lease-server', expiresAt: Date.parse('2099-01-01T00:00:00Z') }, checkpoint: null,
    selectedRoots: [] });
  await store.putMapping(scope, { nativeId: 'native-bookmark', colpId: 'node-bookmark', rootNativeId: 'root-native',
    parentNativeId: 'native-source', parentColpId: 'folder-source', nodeKind: 'bookmark',
    projection: { revision: 'node-r1', digest: 'sha256:bookmark', content: { title: 'Moved' } } });
  await store.putMapping(scope, { nativeId: 'native-source', colpId: 'folder-source', rootNativeId: 'root-native',
    nodeKind: 'folder', projection: { revision: 'source-r1', childrenRevision: 'children-source-old',
      digest: 'sha256:source' } });
  await store.putMapping(scope, { nativeId: 'native-dest', colpId: 'folder-dest', rootNativeId: 'root-native',
    nodeKind: 'folder', projection: { revision: 'dest-r1', childrenRevision: 'children-dest-old',
      digest: 'sha256:dest' } });
  const move: JsonObject = { opId: 'op-push-1', replicaId: scope.replicaId, sequence: 1,
    collectionId: scope.collectionId, type: 'move_node', targetId: 'node-bookmark', baseRevision: 'node-r1',
    occurredAt: '2026-07-27T00:00:00.000Z', dependencies: [], payload: { newParentId: 'folder-dest',
      baseSourceParentRevision: 'children-source-old', baseTargetParentRevision: 'children-dest-old' } };
  const queued = await store.allocateSequenceAndEnqueue(scope, { opId: 'op-push-1', batchId: 'batch-push-1',
    idempotencyKey: 'idempotency-push-1', digest: 'sha256:operation-push-1', endpointIdentity: 'syncPush',
    mediaType: 'application/json', baseRevision: 'node-r1', operationRevision: 'local-event-push-1',
    status: 'pending', retry: { attempt: 0, notBefore: 0 }, payload: move }, { allowUnstamped: true });
  const clock = { now: 10_000 }; const sessions: PushSessionController = { async get() { return {
    credential: { accessToken: 'access-token-push' }, session: { sessionId: 'session-push',
      expiresAt: '2099-01-01T00:00:00Z', scope: 'collection', snapshotRequired: false,
      credentialAuthorityDigest: 'a'.repeat(64),
      collection: { collectionId: scope.collectionId,
        serverCursor: 'cursor-0', serverRevision: 'revision-0' }, replicaLease: { leaseId: 'lease-server', generation: '1',
        state: 'active', expiresAt: '2099-01-01T00:00:00Z' } } }; } };
  return { store, queued, clock, options: { scope, store, endpoints: async () => endpoints, sessions,
    now: () => clock.now, random: () => 0, ownerId: () => 'owner-push', schedule: () => undefined } };
}
export function json(status: number, value: unknown) { return new Response(JSON.stringify(value), { status,
  headers: { 'Content-Type': 'application/json' } }); }
export function problem(status: number, code: string, recovery?: Record<string, unknown>, retryAfter?: string) {
  return new Response(JSON.stringify({ type: `https://know-n.com/colp/problems/${code}`, title: code,
    status, code, ...(recovery ?? {}) }), { status, headers: { 'Content-Type': 'application/problem+json',
      ...(retryAfter ? { 'Retry-After': retryAfter } : {}) } });
}
