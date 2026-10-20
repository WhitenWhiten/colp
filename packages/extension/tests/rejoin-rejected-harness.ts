import { createSyncStateStore, type QueueOperation } from '../src/sync-state-store.js';
import { detachScopeMount, rejoinScopeMount } from '../src/scope-commands.js';
import { listRejoinDecisions, refreshRejoinDecisions, resolveRejoinDecision } from '../src/scope-rejoin-decisions.js';
import type { RejoinChrome } from '../src/scope-rejoin-mutation.js';
import type { CompleteRemoteSnapshot } from '../src/bootstrap/remote-snapshot.js';
import { createBookmarkEventQueue } from '../src/bookmark-event-queue.js';
import { createPullApplier } from '../src/pull-applier.js';
import { canonicalAuthoritativeEffectDigest, canonicalOperationDigest } from '@know-n/colp/sync';
import type { Operation } from '@know-n/colp/types';
import { pullFixtures } from './pull-effect-fixtures.js';
import { indexedDB, nativeOrUndefined, scope, setup } from './kns-05-pull-harness.js';

/** Real bookmark capture/flush and IDB; only the remote authority and native browser API are ports. */
export async function rejectedOrderFixture() {
  const f = await setup(undefined, true); let store = f.store;
  await store.setFirstRun(scope, 'completed');
  await store.putMountBinding(scope, { mountId: 'mount-bar', nativeRootId: 'native-root',
    remoteMountNodeId: 'root-colp', boundaryVersion: '1', materialized: true, status: 'active', rootRole: 'bookmarks-bar' });
  const ids = ['a', 'b', 'c', 'd'];
  const root = (await store.getMappingByNativeId(scope, 'native-root'))!;
  const { scopeKey: _rootKey, ...rootValue } = root;
  await store.putMapping(scope, { ...rootValue, projection: { ...root.projection, childrenOrder: ids.map(id => `native-${id}`) } });
  for (const [index, id] of ids.entries()) {
    f.api.seed({ id: `native-${id}`, parentId: 'native-root', index, title: id, url: `https://example.test/${id}` });
    await store.putMapping(scope, { nativeId: `native-${id}`, colpId: `colp-${id}`, nodeKind: 'bookmark', mountId: 'mount-bar',
      rootNativeId: 'native-root', parentNativeId: 'native-root', parentColpId: 'root-colp',
      projection: { revision: `revision-${id}`, resourceRevision: `revision-${id}`, digest: `digest-${id}`,
        content: { title: id, url: `https://example.test/${id}` } } });
  }
  let remote = ['c', 'd', 'a', 'b'];
  const snapshot = (): CompleteRemoteSnapshot => ({ snapshotId: 'current', revision: 'current', syncCursor: 'current',
    pageCount: 1, identityDigest: 'current', remoteFacts: [
      { nodeId: 'root-colp', parentId: null, kind: 'folder', title: 'root-colp', revision: 'revision-old', childrenRevision: 'cloud-children' },
      ...remote.map((id, index) => ({ nodeId: `colp-${id}`, parentId: 'root-colp', kind: 'bookmark' as const,
        title: id, url: `https://example.test/${id}`, revision: `revision-${id}`, position: String(index) })),
    ] });
  const native: RejoinChrome = { getNative: id => nativeOrUndefined(f.api, id), getChildren: id => f.api.getChildren(id),
    moveNative: (id, placement) => f.api.move(id, placement), readRemoteSnapshot: async () => snapshot() };
  await detachScopeMount(store, scope, 'mount-bar');
  for (const [index, id] of [...ids].reverse().entries()) await f.api.move(`native-${id}`, { parentId: 'native-root', index });
  const input = () => ({ ...native, scope, store });
  return { ...f, input, getStore: () => store, native, snapshot,
    setRemote: (value: string[]) => { remote = value; },
    reopen: () => { store.close(); store = createSyncStateStore({ indexedDB }); return store; },
    compare: () => rejoinScopeMount(store, scope, 'mount-bar', new Set(), [], native),
    refresh: () => refreshRejoinDecisions(input()), list: () => listRejoinDecisions(input()),
    resolve: async (choice: 'keep_local_order' | 'keep_remote_order', chrome: Partial<RejoinChrome> = {}) => {
      const [decision] = await listRejoinDecisions(input()); if (!decision) throw new Error('test_decision_missing');
      await resolveRejoinDecision({ ...input(), ...chrome }, { kind: 'known.sync.rejoinDecisions.resolve',
        commandId: decision.commandId, token: decision.token, choice, userGesture: true });
      return decision;
    },
    queue: () => createBookmarkEventQueue({ scope, store, autoFlush: false, api: {
      get: async id => (await f.api.get(id)).map(row => ({ ...row, title: row.title ?? '' })),
      getChildren: async id => (await f.api.getChildren(id)).map(row => ({ ...row, title: row.title ?? '' })),
    } }),
  };
}

export async function rejectQueueRow(store: ReturnType<typeof createSyncStateStore>, row: QueueOperation) {
  const now = Date.now(); const owner = 'test-server';
  const lease = await store.acquireLease(scope, owner, now, 30_000);
  const claimed = await store.claimNextQueue(scope, owner, lease.fence, now);
  if (!claimed || claimed.opId !== row.opId) throw new Error('test_claim_missing');
  await store.settleClaimedPush(scope, row.sequence, owner, lease.fence, { outcome: 'terminal', receipt: {
    opId: row.opId, operationDigest: row.digest, kind: 'terminal', receiptId: `receipt-${row.sequence}`,
    resultDigest: `sha256:rejected-${row.sequence}`, result: { results: [
      { opId: row.opId, sequence: row.sequence, status: 'rejected', code: 'resource_id_unavailable', warnings: [] },
    ] },
  } });
}

/** Honest terminal receipt, followed separately by the real Pull applier's own echo. */
export async function acceptQueueRow(store: ReturnType<typeof createSyncStateStore>, row: QueueOperation) {
  const now = Date.now(); const owner = 'test-server';
  const lease = await store.acquireLease(scope, owner, now, 30_000);
  const claimed = await store.claimNextQueue(scope, owner, lease.fence, now);
  if (!claimed || claimed.opId !== row.opId) throw new Error(`test_claim_missing:${claimed?.status ?? 'none'}`);
  await store.settleClaimedPush(scope, row.sequence, owner, lease.fence, { outcome: 'terminal', receipt: {
    opId: row.opId, operationDigest: row.digest, kind: 'terminal', receiptId: `receipt-${row.sequence}`,
    resultDigest: `sha256:applied-${row.sequence}`, result: { results: [
      { opId: row.opId, sequence: row.sequence, status: 'applied', targetId: String(row.payload.targetId), revision: `applied-${row.sequence}`, warnings: [] },
    ] },
  }, authoritativeProjection: { targetId: String(row.payload.targetId), revision: `applied-${row.sequence}` } });
}

export async function applyMoveEcho(f: Awaited<ReturnType<typeof rejectedOrderFixture>>, row: QueueOperation) {
  const store = f.getStore();
  const base = pullFixtures.mutationEvent({ kind: 'move', sequence: row.sequence, targetId: String(row.payload.targetId),
    parentId: 'root-colp', collectionId: scope.collectionId, replicaId: scope.replicaId });
  if (base.kind !== 'operation' || base.effect.kind !== 'node_moved' || base.effect.node.kind !== 'bookmark') {
    throw new Error('test_move_fixture_invalid');
  }
  const mapping = (await store.getMappingByColpId(scope, String(row.payload.targetId)))!;
  const operation = row.payload as unknown as Operation;
  const placement = operation.payload as { afterId?: string; beforeId?: string };
  const effect = { ...base.effect, opId: row.opId, effectId: row.opId,
    operationDigest: canonicalOperationDigest(operation), node: { ...base.effect.node,
      title: String(mapping.projection.content?.title), url: String(mapping.projection.content?.url), revision: `applied-${row.sequence}` },
    placement: { ...base.effect.placement, afterId: placement.afterId ?? null, beforeId: placement.beforeId ?? null } };
  effect.effectDigest = canonicalAuthoritativeEffectDigest(effect);
  const applier = createPullApplier({ ...f.options, store });
  await applier.stage(pullFixtures.page({ events: [{ ...base, operation, effect }],
    nextCursor: `echo-${row.sequence}`, collectionRevision: `applied-${row.sequence}` }));
  await applier.resume();
}
