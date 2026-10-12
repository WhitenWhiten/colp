import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach } from 'vitest';
import { createBootstrapCoordinator } from '../src/bootstrap/coordinator.js';
import type { LocalNodeFact, MountFact, RemoteNodeFact } from '../src/bootstrap/matcher.js';
import { digestJson, validateOperation } from '../src/bookmark-event-codec.js';
import { createSyncStateStore, type JsonObject, type MountBindingRecord, type QueueOperation,
  type SyncScope } from '../src/sync-state-store.js';

export const scope: SyncScope = Object.freeze({
  environment: 'production', serverId: 'server-a', serverOrigin: 'https://known.example',
  accountId: 'account-a', browserProfileId: 'profile-a', collectionId: 'collection-a',
  replicaId: 'replica-a', generation: 1,
});
export const root: RemoteNodeFact = {
  nodeId: 'folder-root', parentId: null, kind: 'folder', title: '', folderRole: 'root', revision: 'rev-root-1',
};
export const barMount = (remoteMountNodeId: string | null = null): MountFact => (
  { nativeRootId: 'bar', rootRole: 'bookmarks-bar', remoteMountNodeId });
export const otherMount = (remoteMountNodeId: string | null = null): MountFact => (
  { nativeRootId: 'other', rootRole: 'other-bookmarks', remoteMountNodeId });
export const customMount = (nativeRootId: string, customSourceKey: string,
  remoteMountNodeId: string | null = null): MountFact => (
  { nativeRootId, customSourceKey, remoteMountNodeId });
export const bookmark = (nativeId: string, url: string, title = nativeId): LocalNodeFact => (
  { nativeId, mountNativeRootId: 'bar', parentNativeId: 'bar', kind: 'bookmark', title, url });
export const nestedLocalFacts = (): LocalNodeFact[] => [
  { nativeId: 'folder-1', mountNativeRootId: 'bar', parentNativeId: 'bar', kind: 'folder', title: 'Nested' },
  { nativeId: 'bm-nested', mountNativeRootId: 'bar', parentNativeId: 'folder-1', kind: 'bookmark',
    title: 'Nested bm', url: 'https://example.com/nested' },
];

export let indexedDB: IDBFactory;
export function installKns03IndexedDb() {
  beforeEach(() => { indexedDB = new IDBFactory(); });
}

export async function setup() {
  const store = createSyncStateStore({ indexedDB });
  await active(store);
  return { store, coordinator: createBootstrapCoordinator({ store, scope, now: () => 10, randomUUID: () => 'run-1' }) };
}

export async function active(store: ReturnType<typeof createSyncStateStore>, extra: { legacyCanonicalRoot?: string } = {}) {
  await store.registerScope({
    ...scope, lifecycle: 'active', lease: { leaseId: 'lease-1', expiresAt: 10_000 },
    checkpoint: { serverRevision: 'revision-0', cursor: 'cursor-0' }, selectedRoots: [],
    ...(extra.legacyCanonicalRoot ? { legacyCanonicalRoot: extra.legacyCanonicalRoot } : {}),
  });
}

export function baseConfirm(overrides: Partial<Parameters<ReturnType<typeof createBootstrapCoordinator>['confirm']>[0]>) {
  return {
    confirmationId: 'conf-1', treeDigest: 'sha256:tree', confirmationVersion: '1',
    localFacts: [bookmark('bm-1', 'https://example.com/one')], remoteFacts: [root],
    mounts: [barMount()], rootNodeId: 'folder-root' as string | null, ...overrides,
  };
}

export function productConfirm() {
  return baseConfirm({
    confirmationId: 'conf-product', remoteFacts: undefined, libraryId: 'P327OwnedDefaultAAAAAA',
    mounts: [barMount()], rootNodeId: 'folder-root',
    localFacts: [bookmark('bm-1', 'https://example.com/one'), bookmark('bm-local', 'https://example.com/local')],
  });
}

export function frozenConfirm() {
  return baseConfirm({
    confirmationId: 'conf-frozen', remoteFacts: undefined, libraryId: 'P327OwnedDefaultAAAAAA',
    mounts: [barMount(), otherMount()], rootNodeId: 'folder-root',
  });
}

export async function freezeRecovery(store: ReturnType<typeof createSyncStateStore>) {
  await store.transitionEngine(scope, {
    phase: 'recovery', updatedAt: 10, recoveryFrozen: true, authorityRefreshRequired: true, notBefore: 0,
  });
}

export async function unfreezeRecovery(store: ReturnType<typeof createSyncStateStore>) {
  await store.transitionEngine(scope, {
    phase: 'sleeping', updatedAt: 20, recoveryFrozen: false, authorityRefreshRequired: false, notBefore: 0,
  });
}

export function recoveryRoot(colpId: string) {
  return recoveryNode(colpId, null, 'Folder', { title: '', folderRole: 'root' });
}

export function recoveryNode(colpId: string, parentId: string | null, kind: 'Folder' | 'Bookmark',
  content: { title: string; url?: string; folderRole?: string }, rootRole?: 'bookmarks-bar') {
  return {
    colpId, parentId, position: colpId, kind, payloadDigest: `sha256:${colpId}`,
    mapping: {
      nativeId: `recovery:${colpId}`, colpId, rootNativeId: 'recovery:root',
      nodeKind: kind === 'Bookmark' ? 'bookmark' as const : 'folder' as const,
      ...(parentId ? { parentColpId: parentId } : {}),
      ...(rootRole ? { rootRole } : {}),
      projection: { revision: 'rev-root-1', digest: `sha256:${colpId}`, content },
    },
  };
}

export async function completeBootstrapAck(store: ReturnType<typeof createSyncStateStore>) {
  const snapshotId = 'snap-cutover';
  const sessionId = 'session-cutover';
  const cursor = 'spc2.cutover';
  await store.stageRecoveryPage(scope, {
    snapshotId, revision: 'r-cut', syncCursor: cursor, identityDigest: 'identity-cutover',
    rootNodeId: 'folder-root', page: 0, pageDigest: 'sha256:cutover', previousPageDigest: null, nextCursor: null,
    complete: true, sessionId,
    nodes: [recoveryRoot('folder-root')],
  });
  const body = JSON.stringify({ sessionId, cursor, warnings: [] });
  await store.commitRecovery(scope, snapshotId, {
    intentId: 'ack-cutover', sessionId, idempotencyKey: 'ack-cutover',
    endpointIdentity: 'syncAck' as const, mediaType: 'application/json' as const, body,
    bodyDigest: createHash('sha256').update(body).digest('hex'),
  });
  await store.completeAckIntent(scope, 'ack-cutover', {
    replicaId: scope.replicaId, ackedCursor: cursor, ackedAt: '2026-09-07T00:00:00.000Z',
  });
}

export async function putLiveRemoteMappings(store: ReturnType<typeof createSyncStateStore>) {
  await store.putMapping(scope, {
    nativeId: 'recovery:folder-root', colpId: 'folder-root', rootNativeId: 'recovery:root',
    nodeKind: 'folder',
    projection: { revision: 'rev-root-1', digest: 'sha256:folder-root', content: { folderRole: 'root', title: '' } },
  });
  await store.putMapping(scope, {
    nativeId: 'recovery:mount-bar', colpId: 'mount-bar', rootNativeId: 'recovery:root',
    nodeKind: 'folder', parentColpId: 'folder-root', rootRole: 'bookmarks-bar',
    projection: { revision: 'rev-bar-1', digest: 'sha256:mount-bar',
      content: { folderRole: 'bookmarks-bar', title: 'Bar' } },
  });
  await store.putMapping(scope, {
    nativeId: 'recovery:bookmark-shared', colpId: 'bookmark-shared', rootNativeId: 'recovery:root',
    nodeKind: 'bookmark', parentColpId: 'mount-bar',
    projection: { revision: 'rev-bm-1', digest: 'sha256:bookmark-shared',
      content: { title: 'bm-1', url: 'https://example.com/one' } },
  });
}

const OPAQUE_ID = /^[A-Za-z0-9._~-]{1,128}$/u;

export function assertOpaqueOpId(opId: string) {
  assert.match(opId, OPAQUE_ID);
  assert.doesNotMatch(opId, /:/);
}

export function assertOpaquePlanned(planned: readonly { readonly opId: string }[] | undefined) {
  assert.ok(planned);
  for (const op of planned) assertOpaqueOpId(op.opId);
}

export function assertOpaqueQueued(rows: readonly { readonly opId: string; readonly batchId: string;
  readonly idempotencyKey: string; readonly payload: { readonly opId?: unknown } }[]) {
  for (const row of rows) {
    assertOpaqueOpId(row.opId);
    assertOpaqueOpId(row.batchId);
    assertOpaqueOpId(row.idempotencyKey);
    assert.equal(row.payload.opId, row.opId);
  }
}

export function assertStampedColp(rows: readonly QueueOperation[]) {
  for (const row of rows) {
    const payload = row.payload;
    assert.equal(payload.replicaId, scope.replicaId);
    assert.equal(payload.sequence, row.sequence);
    assert.equal(payload.collectionId, scope.collectionId);
    assert.equal(payload.opId, row.opId);
    assert.ok(typeof payload.type === 'string');
    assert.ok('baseRevision' in payload);
    assert.ok(typeof payload.occurredAt === 'string');
    assert.ok(Array.isArray(payload.dependencies));
    assert.ok(payload.payload && typeof payload.payload === 'object' && !Array.isArray(payload.payload));
    assert.equal(row.digest, digestJson(payload));
    if (payload.type === 'create_node') assert.equal(validateOperation(payload), true);
  }
}

export async function bindRemoteMount(store: ReturnType<typeof createSyncStateStore>, remoteMountNodeId: string,
  nativeRootId?: string) {
  const mounts = await store.listMountBindings(scope);
  const current = nativeRootId ? mounts.find((row) => row.nativeRootId === nativeRootId) : mounts[0];
  assert.ok(current);
  const next: Omit<MountBindingRecord, 'scopeKey'> = {
    mountId: current.mountId, nativeRootId: current.nativeRootId, remoteMountNodeId,
    boundaryVersion: current.boundaryVersion, materialized: current.materialized, status: 'active',
    ...(current.rootRole ? { rootRole: current.rootRole } : {}),
    ...(current.customSourceKey ? { customSourceKey: current.customSourceKey } : {}),
  };
  await store.putMountBinding(scope, next);
}

export async function completeQueuedCreate(store: ReturnType<typeof createSyncStateStore>,
  row: QueueOperation, targetId: string) {
  await store.completeQueueWithReceipt(scope, row.sequence, {
    opId: row.opId, operationDigest: row.digest, kind: 'terminal',
    receiptId: `receipt-${targetId}`, resultDigest: `sha256:${targetId}`,
    result: { results: [{ opId: row.opId, sequence: row.sequence, status: 'applied',
      targetId, revision: `rev-${targetId}` }] },
  });
}
