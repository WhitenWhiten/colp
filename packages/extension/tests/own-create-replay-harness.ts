import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { validateOperation } from '../src/bookmark-event-codec.js';
import { createBookmarkEventQueue } from '../src/bookmark-event-queue.js';
import { repairOwnCreateFromNative } from '../src/bookmark-own-create-repair.js';
import { createSyncStateStore, type MappingInput, type SyncScope, type JsonObject } from '../src/sync-state-store.js';
import { honestChrome } from './kns-05-pull-harness.js';
import { pullFixtures } from './pull-effect-fixtures.js';

export const scope: SyncScope = { environment: 'production', serverId: 'server-pull', serverOrigin: 'https://known.example',
  accountId: 'account-pull', browserProfileId: 'profile-pull', collectionId: 'collection-pull',
  replicaId: 'replica-receiver', generation: 1 };

export async function setup(firstRun: 'running' | 'completed', queued = true) {
  const store = createSyncStateStore({ indexedDB: new IDBFactory() });
  await store.registerScope({ ...scope, lifecycle: 'active', firstRun,
    lease: { leaseId: 'lease', expiresAt: Date.parse('2099-01-01T00:00:00Z') },
    checkpoint: { serverRevision: 'revision-old', cursor: 'cursor-old' }, selectedRoots: ['root-colp'], rootStatus: 'ready' });
  const parent: MappingInput = { nativeId: 'native-root', colpId: 'root-colp', rootNativeId: 'native-root', nodeKind: 'folder',
    projection: { revision: 'revision-old', childrenRevision: 'children-old', digest: 'sha256:root', content: { title: 'Root' } } };
  await store.putMapping(scope, parent);
  await store.putMountBinding(scope, { mountId: 'mount', nativeRootId: 'native-root', remoteMountNodeId: 'root-colp',
    boundaryVersion: '1', materialized: true, status: 'active', customSourceKey: 'root' });
  const api = honestChrome(); api.seed({ id: 'native-root', index: 0, title: 'Root' });
  const event = pullFixtures.createEvent({ kind: 'Bookmark', sequence: 1, collectionId: scope.collectionId,
    parentId: 'root-colp', replicaId: scope.replicaId, opId: 'normal-create' });
  assert.ok(event.kind === 'operation' && event.operation.type === 'create_node' && event.effect.kind === 'node_created');
  const remote = event.effect.node; assert.ok(remote.kind === 'bookmark' && typeof remote.url === 'string');
  const node = { id: 'native-original', parentId: 'native-root', index: 0,
    title: remote.title, url: remote.url };
  api.seed(node);
  const original: MappingInput = { nativeId: node.id, colpId: 'pending-normal-create', rootNativeId: 'native-root',
    parentNativeId: 'native-root', nodeKind: 'bookmark', projection: { revision: 'local-normal-create',
      digest: 'sha256:original', content: { title: node.title, url: node.url } } };
  if (queued) {
    await store.stageBookmarkEvent(scope, { eventId: 'create-callback', nativeId: node.id, kind: 'create',
      occurredAt: event.operation.occurredAt, dedupeKey: 'create-callback', details: {} });
    await store.commitBookmarkEvent(scope, 'create-callback', { operation: event.operation as unknown as JsonObject,
      baseRevision: null, operationRevision: 'local-normal-create', mapping: original,
      allocateOperationId: () => 'normal-create', validateOperation,
      digestOperation: () => event.effect.operationDigest });
  }
  await store.putMapping(scope, original);
  const queue = createBookmarkEventQueue({ scope, store, autoFlush: false, api: {
    get: async id => (await api.get(id)).map(node => ({ ...node, title: node.title ?? '' })),
    getChildren: async id => (await api.getChildren(id)).map(node => ({ ...node, title: node.title ?? '' })),
  } });
  let repairs = 0;
  const options = { scope, store, api, session: { acceptedProtocolVersion: '0.2' as const, sessionId: 'session-pull',
    collectionId: scope.collectionId, conversionPolicy: { separator: 'preserve_remote' as const } },
    effectPageTemplate: 'https://known.example/effects/{effectId}/pages/{pageNumber}', effectPageAuthority: 'https://known.example',
    repairOwnCreate: async (mapping: MappingInput, parent: MappingInput) => {
      repairs++; await repairOwnCreateFromNative(queue, id => api.get(id), mapping, parent);
    } };
  const page = pullFixtures.page({ events: [event], nextCursor: 'cursor-next', collectionRevision: 'revision-next' });
  return { store, api, queue, options, page, remote, node, original, parent, repairs: () => repairs };
}
