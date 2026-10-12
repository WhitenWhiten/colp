import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach } from 'vitest';
import { createBookmarkEventQueue, type BookmarkEventApi } from '../src/bookmark-event-queue.js';
import { createOutboundPushWorker, type PushSessionController } from '../src/outbound-push-worker.js';
import { createSyncStateStore, type JsonObject, type SyncScope } from '../src/sync-state-store.js';
import { json } from './durable-sync-engine-harness.js';

export const scope: SyncScope = Object.freeze({
  environment: 'production', serverId: 'server-a', serverOrigin: 'https://known.example',
  accountId: 'account-a', browserProfileId: 'profile-a', collectionId: 'collection-a',
  replicaId: 'replica-a', generation: 1,
});
export const endpoints = {
  syncSessions: 'https://known.example/v1/session', syncSnapshot: 'https://known.example/v1/snapshot',
  syncPush: 'https://known.example/v1/push', syncPull: 'https://known.example/v1/pull',
  syncAck: 'https://known.example/v1/ack', syncConflict: 'https://known.example/v1/conflicts/{conflictId}',
  syncEffectPages: 'https://known.example/v1/effects/{effectId}/pages/{pageNumber}',
  effectPageAuthority: 'https://known.example', syncRetire: 'https://known.example/v1/retire',
} as const;

export let indexedDB: IDBFactory;
export function installKns04IndexedDb() {
  beforeEach(() => { indexedDB = new IDBFactory(); });
}

export async function bootstrapCreateReceiptFixture() {
  const store = createSyncStateStore({ indexedDB });
  await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease', expiresAt: 10_000 },
    checkpoint: { serverRevision: 'r', cursor: 'c' }, selectedRoots: [], rootStatus: 'ready', firstRun: 'completed' });
  await store.putMountBinding(scope, {
    mountId: 'mount-bar', nativeRootId: '1', remoteMountNodeId: 'server-mount-bar', boundaryVersion: '1',
    materialized: false, status: 'active', rootRole: 'bookmarks-bar',
  });
  await store.putMapping(scope, { nativeId: '1', colpId: 'server-mount-bar', rootNativeId: '1', nodeKind: 'folder',
    mountId: 'mount-bar', rootRole: 'bookmarks-bar',
    projection: { revision: 'server-mount-r1', childrenRevision: 'children-server-mount-r1',
      digest: 'sha256:server-mount-r1', content: { title: 'Bar', folderRole: 'bookmarks-bar' } } });
  const opId = 'b3.kns04confirm.create.5';
  const payload: JsonObject = { opId, replicaId: scope.replicaId, sequence: 1, collectionId: scope.collectionId,
    type: 'create_node', baseRevision: null, occurredAt: '2026-07-27T00:00:00.000Z', dependencies: [],
    payload: { parentId: 'server-mount-bar', node: { kind: 'bookmark', title: 'KNS08 restore item',
      url: 'https://example.test/restore' } } };
  await store.allocateSequenceAndEnqueue(scope, { opId, batchId: opId, idempotencyKey: opId, digest: 'sha256:create-5',
    endpointIdentity: 'syncPush', mediaType: 'application/json', baseRevision: null, operationRevision: `local-${opId}`,
    status: 'pending', retry: { attempt: 0, notBefore: 0 }, payload }, { allowUnstamped: true });
  await store.transitionEngine(scope, { phase: 'sleeping', updatedAt: 10_000, recoveryFrozen: false,
    notBefore: 0, authorityRefreshRequired: false });
  const clock = { now: 10_000 };
  const worker = createOutboundPushWorker({ ...pushOptions(store, clock), fetch: async (_url, init) => json(200, {
    batchId: JSON.parse(String(init?.body)).batchId, results: [{ opId, sequence: 1, status: 'applied',
      targetId: 'server-restore-item', revision: 'server-restore-r1', cursor: 'cursor-1', warnings: [] }],
    serverCursor: 'cursor-1' }) });
  assert.equal((await worker.drain()).outcome, 'terminal');
  const api = memoryApi();
  api.put(folder('0', '', 0, 'Root'));
  api.put(folder('1', '0', 0, 'Bar'));
  const queue = createBookmarkEventQueue({ scope, store, api, now: () => '2026-07-27T00:00:00Z',
    uuid: deterministicIds(), autoFlush: false });
  return { store, queue, api };
}

export function assertWireHasNoPendingIdentity(records: readonly { readonly payload: JsonObject }[]) {
  for (const record of records) {
    const nested = record.payload.payload;
    const inner = nested && typeof nested === 'object' && !Array.isArray(nested) ? nested as JsonObject : {};
    for (const value of [record.payload.targetId, record.payload.baseRevision, inner.parentId, inner.targetId,
      inner.afterId, inner.beforeId, inner.newParentId]) {
      if (typeof value === 'string') assert.doesNotMatch(value, /^(?:pending-|local-|inbox-parent)/);
    }
  }
}

export async function fixture(options: { mappedNode?: boolean; mappedSubtree?: boolean } = {},
  database: IDBFactory = indexedDB) {
  const store = createSyncStateStore({ indexedDB: database });
  await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease', expiresAt: 10_000 },
    checkpoint: { serverRevision: 'collection-revision-3', cursor: 'cursor-3' }, selectedRoots: [], rootStatus: 'ready' });
  await store.configureBrowserRoots(scope, { discovered: [
    { nativeId: 'root-selected', ancestorNativeIds: [] },
    { nativeId: 'folder-parent', ancestorNativeIds: ['root-selected'] },
    { nativeId: 'root-private', ancestorNativeIds: [] },
    { nativeId: 'root-unselected', ancestorNativeIds: [] },
  ], selectedNativeIds: ['root-selected'], privateNativeIds: ['root-private'], status: 'ready' });
  const selectedRoot = await store.getMappingByNativeId(scope, 'root-selected');
  await store.putMapping(scope, { nativeId: 'root-selected', colpId: selectedRoot!.colpId,
    rootNativeId: 'root-selected', nodeKind: 'folder',
    projection: { revision: 'server-root-r1', childrenRevision: 'children-server-root-r1',
      digest: 'sha256:server-root-r1', content: { title: 'Selected root' } } });
  await mapping(store, 'folder-parent', 'folder-colp', 'root-selected', 'folder-revision-2', { title: 'Parent' });
  if (options.mappedNode) await mapping(store, 'mapped', 'mapped-colp', 'root-selected', 'server-revision-7',
    { title: 'Server before', url: 'https://example.test/before' });
  if (options.mappedSubtree) {
    await mapping(store, 'mapped', 'mapped-colp', 'root-selected', 'server-revision-7', { title: 'Child' },
      'folder-parent');
    await mapping(store, 'mapped-separator', 'separator-colp', 'root-selected', 'server-revision-1', {},
      'folder-parent');
  }
  const api = memoryApi();
  api.put(folder('folder-parent', 'root-selected', 0, 'Parent'));
  const queue = createBookmarkEventQueue({ scope, store, api, now: () => '2026-07-27T00:00:00Z',
    uuid: deterministicIds(), autoFlush: false });
  return { queue, store, api };
}

export async function mapping(store: ReturnType<typeof createSyncStateStore>, nativeId: string, colpId: string,
  rootNativeId: string, revision: string, content: Record<string, string>, parentNativeId?: string) {
  await store.putMapping(scope, { nativeId, colpId, rootNativeId, ...(parentNativeId ? { parentNativeId } : {}),
    projection: { revision, childrenRevision: `children-${revision}`, digest: `sha256:${revision}`, content } });
}

export function folder(id: string, parentId: string, index: number, title: string,
  children: readonly import('../src/bookmark-event-queue.js').BookmarkEventNode[] = []) {
  return { id, parentId, index, title, type: 'folder' as const, children };
}
export function bookmark(id: string, parentId: string, index: number, title: string, url: string) {
  return { id, parentId, index, title, url, type: 'bookmark' as const };
}
export function memoryApi(): BookmarkEventApi & { put(node: any): void; node(id: string): any } {
  const nodes = new Map<string, any>();
  return { put(node) { nodes.set(node.id, structuredClone(node)); }, node(id) { return structuredClone(nodes.get(id)); },
    async get(id) { const value = nodes.get(id); return value ? [structuredClone(value)] : []; },
    async getChildren(id) { return [...nodes.values()].filter((node) => node.parentId === id)
      .map((node) => structuredClone(node)); } };
}
export function deterministicIds(start = 0) { let value = start; return () => `local-${++value}`; }

export function pushOptions(store: ReturnType<typeof createSyncStateStore>, clock: { now: number }) {
  const sessions: PushSessionController = { async get() { return {
    credential: { accessToken: 'access-token-push' }, session: { sessionId: 'session-push',
      expiresAt: '2099-01-01T00:00:00Z', scope: 'collection', snapshotRequired: false,
      credentialAuthorityDigest: 'a'.repeat(64),
      collection: { collectionId: scope.collectionId, serverCursor: 'cursor-0', serverRevision: 'revision-0' },
      replicaLease: { leaseId: 'lease-server', generation: '1', state: 'active',
        expiresAt: '2099-01-01T00:00:00Z' } } }; } };
  return { scope, store, endpoints: async () => endpoints, sessions, now: () => clock.now, random: () => 0,
    ownerId: () => 'owner-push', schedule: () => undefined };
}

export async function enqueueUpdate(store: ReturnType<typeof createSyncStateStore>, opId: string, targetId: string) {
  return store.allocateSequenceAndEnqueue(scope, { opId, batchId: `batch-${opId}`, idempotencyKey: opId,
    digest: `sha256:${opId}`, endpointIdentity: 'syncPush', mediaType: 'application/json',
    baseRevision: 'r1', operationRevision: `local-${opId}`, status: 'pending', retry: { attempt: 0, notBefore: 0 },
    payload: { opId, replicaId: scope.replicaId, sequence: opId === 'op-a' ? 1 : 2, collectionId: scope.collectionId,
      type: 'update_node_content', targetId, baseRevision: 'r1', occurredAt: '2026-07-27T00:00:00.000Z',
      dependencies: [], payload: { base: { title: 'Before' }, value: { title: 'After' } } } }, { allowUnstamped: true });
}
