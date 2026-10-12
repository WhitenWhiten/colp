import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, test } from 'vitest';
import { createBookmarkEventQueue } from '../src/bookmark-event-queue.js';
import { createPullApplier, type PullBookmarkApi } from '../src/pull-applier.js';
import { keepLocalFromDecision } from '../src/remote-delete-apply.js';
import { remoteDeleteDecisionId } from '../src/remote-delete-policy.js';
import { enqueueRemoteDeleteRestore } from '../src/remote-delete-restore.js';
import { createSyncStateStore, SyncStateError, type SyncScope } from '../src/sync-state-store.js';
import { pullFixtures } from './pull-effect-fixtures.js';

const scope: SyncScope = { environment: 'production', serverId: 'server-pull', serverOrigin: 'https://known.example',
  accountId: 'account-pull', browserProfileId: 'profile-pull', collectionId: 'collection-pull',
  replicaId: 'replica-receiver', generation: 1 };
let indexedDB: IDBFactory;
beforeEach(() => { indexedDB = new IDBFactory(); });

describe('P1-02 device remote-delete policy', () => {
  test('empty-folder single-node delete Chrome-deletes and Acks', async () => {
    const fixture = await setup();
    await fixture.applier.stage(fixture.page([fixture.mutationEvent('delete')]));
    await fixture.applier.resume();
    assert.ok(fixture.api.calls.some((call) => call.kind === 'delete' && call.nativeId === 'native-node'));
    assert.equal(await fixture.store.getMappingByNativeId(scope, 'native-node'), null);
    assert.equal((await fixture.store.exportScope(scope)).cursor?.cursor, 'cursor-next');
  });

  test('single-node delete of a folder with a live child does not Chrome-delete the folder', async () => {
    const fixture = await setup({ liveChild: true });
    await fixture.applier.stage(fixture.page([fixture.mutationEvent('delete')]));
    await fixture.applier.resume();
    assert.equal(fixture.api.calls.filter((call) => call.kind === 'delete' && call.nativeId === 'native-node').length, 0);
    assert.equal((await fixture.api.get('native-node')).length, 1);
    assert.equal((await fixture.api.get('native-child')).length, 1);
  });

  test('single-node delete of a folder with a local-only extra does not Chrome-delete the folder', async () => {
    const fixture = await setup({ localExtra: true });
    await fixture.applier.stage(fixture.page([fixture.mutationEvent('delete')]));
    await fixture.applier.resume();
    assert.equal(fixture.api.calls.filter((call) => call.kind === 'delete' && call.nativeId === 'native-node').length, 0);
    assert.equal((await fixture.api.get('native-node')).length, 1);
    assert.equal((await fixture.api.get('native-extra')).length, 1);
  });

  test('subtree_deleted Chrome-deletes verified members when no local extra remains', async () => {
    const fixture = await setup({ liveChild: true });
    await fixture.applier.stage(fixture.page([fixture.subtreeEvent(false)]));
    await fixture.applier.resume();
    assert.ok(fixture.api.calls.some((call) => call.kind === 'delete' && call.nativeId === 'native-node'));
    assert.equal((await fixture.api.get('native-node')).length, 0);
    assert.equal((await fixture.api.get('native-child')).length, 0);
    assert.equal((await fixture.store.exportScope(scope)).cursor?.cursor, 'cursor-next');
  });

  test('policy confirm parks only the remote delete and still applies unrelated same-page events', async () => {
    const fixture = await setup();
    await fixture.store.setRemoteDeletePolicy(scope, { policy: 'confirm', expectedCasVersion: 0, now: 10 });
    const create = fixture.createEvent('Bookmark');
    const deleted = fixture.mutationEvent('delete');
    await fixture.applier.stage(fixture.page([create, deleted]));
    await fixture.applier.resume();
    assert.equal(fixture.api.calls.filter((call) => call.kind === 'delete').length, 0);
    assert.ok(fixture.api.calls.some((call) => call.kind === 'create'));
    assert.ok(await fixture.store.getMappingByNativeId(scope, 'native-node'));
    const exported = await fixture.store.exportScope(scope);
    assert.equal(exported.cursor?.cursor ?? exported.scope?.checkpoint?.cursor, 'cursor-old');
    const pending = await fixture.store.listRemoteDeleteDecisions(scope, ['pending']);
    assert.equal(pending.length, 1);
    assert.equal(pending[0]?.targetId, 'node-1');
    const events = await fixture.store.listPullEvents(scope);
    assert.ok(events.some((event) => event.state === 'awaiting_confirmation'));
    assert.ok(events.some((event) => event.state === 'authority_committed'));
  });

  test('apply decision Chrome-deletes once and is idempotent so the page can Ack', async () => {
    const fixture = await setup();
    await fixture.store.setRemoteDeletePolicy(scope, { policy: 'confirm', expectedCasVersion: 0, now: 10 });
    const deleted = fixture.mutationEvent('delete');
    await fixture.applier.stage(fixture.page([deleted]));
    await fixture.applier.resume();
    const pending = (await fixture.store.listRemoteDeleteDecisions(scope, ['pending']))[0]!;
    const first = await fixture.store.decideRemoteDelete(scope, {
      decisionId: pending.decisionId, action: 'apply', expectedCasVersion: pending.casVersion,
      deleteRevision: pending.deleteRevision, generation: 1, now: 20, permissionGranted: true,
    });
    await fixture.applier.resume();
    assert.equal(fixture.api.calls.filter((call) => call.kind === 'delete').length, 1);
    const second = await fixture.store.decideRemoteDelete(scope, {
      decisionId: pending.decisionId, action: 'apply', expectedCasVersion: first.casVersion,
      deleteRevision: pending.deleteRevision, generation: 1, now: 30, permissionGranted: true,
    });
    await fixture.applier.resume();
    assert.equal(second.state, 'applied');
    assert.equal(fixture.api.calls.filter((call) => call.kind === 'delete').length, 1);
    assert.equal((await fixture.store.exportScope(scope)).cursor?.cursor, 'cursor-next');
  });

  test('keep-local keeps Chrome, unbinds mapping, excludes the subtree from later create/update', async () => {
    const fixture = await setup({ liveChild: true });
    await fixture.store.setRemoteDeletePolicy(scope, { policy: 'confirm', expectedCasVersion: 0, now: 10 });
    await fixture.applier.stage(fixture.page([fixture.subtreeEvent(false)]));
    await fixture.applier.resume();
    const pending = (await fixture.store.listRemoteDeleteDecisions(scope, ['pending']))[0]!;
    const raw = await fixture.store.getPullEvent(scope, pending.eventId);
    await fixture.store.decideRemoteDelete(scope, {
      decisionId: pending.decisionId, action: 'keep_local', expectedCasVersion: pending.casVersion,
      deleteRevision: pending.deleteRevision, generation: 1, now: 20, permissionGranted: true,
    });
    await keepLocalFromDecision(fixture.store, scope, raw!.payload as never, pending, () => 20);
    await fixture.applier.resume();
    assert.equal(fixture.api.calls.filter((call) => call.kind === 'delete').length, 0);
    assert.equal((await fixture.api.get('native-node')).length, 1);
    assert.equal(await fixture.store.getMappingByNativeId(scope, 'native-node'), null);
    assert.equal(await fixture.store.getMappingByNativeId(scope, 'native-child'), null);
    assert.ok(await fixture.store.getLocalSyncExclusion(scope, 'native-node'));
    assert.ok(await fixture.store.getLocalSyncExclusion(scope, 'native-child'));
    const queue = createBookmarkEventQueue({
      scope, store: fixture.store, autoFlush: true,
      api: {
        get: async (id) => (await fixture.api.get(id)).map((node) => ({ id: node.id, title: node.title ?? '',
          parentId: node.parentId, index: node.index, url: node.url })),
        getChildren: async (id) => (await fixture.api.getChildren(id)).map((node) => ({ id: node.id,
          title: node.title ?? '', parentId: node.parentId, index: node.index, url: node.url })),
      },
    });
    assert.equal((await queue.changed('native-node', { title: 'kept local' })).outcome, 'filtered');
    assert.equal((await queue.moved('native-node', { parentId: 'native-root', index: 1,
      oldParentId: 'native-root', oldIndex: 0 })).outcome, 'filtered');
    assert.equal((await queue.created('native-child', { id: 'native-child', parentId: 'native-node',
      title: 'child', url: 'https://example.test/' })).outcome, 'filtered');
    assert.equal((await queue.created('native-new', { id: 'native-new', parentId: 'native-node',
      title: 'new under excluded', url: 'https://example.test/new' })).outcome, 'filtered');
    assert.equal((await queue.removed('native-node', { parentId: 'native-root', index: 0 })).outcome, 'filtered');
    assert.equal((await fixture.store.getEngineState(scope))?.recoveryFrozen ?? false, false);
    await queue.recover();
    assert.equal((await fixture.store.listQueue(scope)).filter((row) => row.payload.type === 'create_node'
      || row.payload.targetId === 'node-1').length, 0);
    assert.equal((await fixture.store.exportScope(scope)).cursor?.cursor, 'cursor-next');
  });

  test('restore enqueues restore_node, keeps the original Node id, and does not Chrome-delete', async () => {
    const fixture = await setup();
    await fixture.store.setRemoteDeletePolicy(scope, { policy: 'confirm', expectedCasVersion: 0, now: 10 });
    await fixture.applier.stage(fixture.page([fixture.mutationEvent('delete')]));
    await fixture.applier.resume();
    const pending = (await fixture.store.listRemoteDeleteDecisions(scope, ['pending']))[0]!;
    const decided = await fixture.store.decideRemoteDelete(scope, {
      decisionId: pending.decisionId, action: 'restore', expectedCasVersion: pending.casVersion,
      deleteRevision: pending.deleteRevision, generation: 1, now: 20, permissionGranted: true,
    });
    const queued = await enqueueRemoteDeleteRestore(fixture.store, scope, decided, 20);
    assert.equal(queued.payload.type, 'restore_node');
    assert.equal(queued.payload.targetId, 'node-1');
    await fixture.store.completeQueueWithReceipt(scope, queued.sequence, {
      opId: queued.opId, operationDigest: queued.digest, kind: 'terminal', receiptId: 'receipt-restore',
      resultDigest: 'sha256:restore', result: { results: [{ opId: queued.opId, sequence: queued.sequence,
        status: 'applied', targetId: 'node-1', revision: 'revision-restored' }] },
    });
    await fixture.applier.resume();
    const restored = await fixture.store.getRemoteDeleteDecision(scope, pending.decisionId);
    assert.equal(restored?.state, 'restored');
    assert.equal(fixture.api.calls.filter((call) => call.kind === 'delete').length, 0);
    assert.equal((await fixture.store.getMappingByNativeId(scope, 'native-node'))?.colpId, 'node-1');
    assert.equal((await fixture.store.exportScope(scope)).cursor?.cursor, 'cursor-next');
  });

  test('parked decision survives a store reopen and does not enlarge the native set', async () => {
    const fixture = await setup();
    await fixture.store.setRemoteDeletePolicy(scope, { policy: 'confirm', expectedCasVersion: 0, now: 10 });
    await fixture.applier.stage(fixture.page([fixture.mutationEvent('delete')]));
    await fixture.applier.resume();
    const before = (await fixture.store.listRemoteDeleteDecisions(scope, ['pending']))[0]!;
    fixture.store.close();
    const reopened = createSyncStateStore({ indexedDB });
    const after = (await reopened.listRemoteDeleteDecisions(scope, ['pending']))[0]!;
    assert.equal(after.decisionId, before.decisionId);
    assert.deepEqual(after.nativeIds, before.nativeIds);
    await createPullApplier({ ...fixture.options, store: reopened }).resume();
    assert.equal((await reopened.listRemoteDeleteDecisions(scope, ['pending']))[0]?.nativeIds.length,
      before.nativeIds.length);
    assert.equal((await reopened.exportScope(scope)).cursor?.cursor ?? 'cursor-old', 'cursor-old');
  });

  test('revoked permission and generation fence do not Chrome-delete', async () => {
    const fixture = await setup();
    await fixture.store.setRemoteDeletePolicy(scope, { policy: 'confirm', expectedCasVersion: 0, now: 10 });
    await fixture.applier.stage(fixture.page([fixture.mutationEvent('delete')]));
    await fixture.applier.resume();
    const pending = (await fixture.store.listRemoteDeleteDecisions(scope, ['pending']))[0]!;
    await assert.rejects(() => fixture.store.decideRemoteDelete(scope, {
      decisionId: pending.decisionId, action: 'apply', expectedCasVersion: pending.casVersion,
      deleteRevision: pending.deleteRevision, generation: 1, now: 20, permissionGranted: false,
    }), (error: unknown) => error instanceof SyncStateError && error.code === 'permission_required');
    await assert.rejects(() => fixture.store.decideRemoteDelete(scope, {
      decisionId: pending.decisionId, action: 'apply', expectedCasVersion: pending.casVersion,
      deleteRevision: pending.deleteRevision, generation: 2, now: 20, permissionGranted: true,
    }), (error: unknown) => error instanceof SyncStateError && error.code === 'remote_delete_generation_fenced');
    assert.equal(fixture.api.calls.filter((call) => call.kind === 'delete').length, 0);
  });

  test('stale delete revision is rejected until the user re-reads the pending item', async () => {
    const fixture = await setup();
    await fixture.store.setRemoteDeletePolicy(scope, { policy: 'confirm', expectedCasVersion: 0, now: 10 });
    await fixture.applier.stage(fixture.page([fixture.mutationEvent('delete')]));
    await fixture.applier.resume();
    const pending = (await fixture.store.listRemoteDeleteDecisions(scope, ['pending']))[0]!;
    await assert.rejects(() => fixture.store.decideRemoteDelete(scope, {
      decisionId: pending.decisionId, action: 'apply', expectedCasVersion: pending.casVersion,
      deleteRevision: 'delete-stale', generation: 1, now: 20, permissionGranted: true,
    }), (error: unknown) => error instanceof SyncStateError && error.code === 'remote_delete_revision_stale');
    await assert.rejects(() => fixture.store.decideRemoteDelete(scope, {
      decisionId: pending.decisionId, action: 'apply', expectedCasVersion: pending.casVersion + 9,
      deleteRevision: pending.deleteRevision, generation: 1, now: 20, permissionGranted: true,
    }), (error: unknown) => error instanceof SyncStateError && error.code === 'remote_delete_decision_stale');
    assert.equal(fixture.api.calls.filter((call) => call.kind === 'delete').length, 0);
  });

  test('self-echo empty-folder delete is not parked under confirm', async () => {
    const fixture = await setup();
    await fixture.store.setRemoteDeletePolicy(scope, { policy: 'confirm', expectedCasVersion: 0, now: 10 });
    const event = pullFixtures.mutationEvent({ kind: 'delete', sequence: 7, collectionId: scope.collectionId,
      targetId: 'node-1', parentId: 'root-colp', replicaId: scope.replicaId, targetKind: 'folder' });
    await fixture.applier.stage(fixture.page([event]));
    await fixture.applier.resume();
    assert.equal((await fixture.store.listRemoteDeleteDecisions(scope)).length, 0);
    assert.ok(fixture.api.calls.some((call) => call.kind === 'delete' && call.nativeId === 'native-node'));
    assert.equal((await fixture.store.exportScope(scope)).cursor?.cursor, 'cursor-next');
  });

  test('keep_local policy resolves without parking and without a Chrome delete', async () => {
    const fixture = await setup();
    await fixture.store.setRemoteDeletePolicy(scope, { policy: 'keep_local', expectedCasVersion: 0, now: 10 });
    await fixture.applier.stage(fixture.page([fixture.mutationEvent('delete')]));
    await fixture.applier.resume();
    assert.equal(fixture.api.calls.filter((call) => call.kind === 'delete').length, 0);
    assert.equal(await fixture.store.getMappingByNativeId(scope, 'native-node'), null);
    assert.ok(await fixture.store.getLocalSyncExclusion(scope, 'native-node'));
    assert.equal((await fixture.store.exportScope(scope)).cursor?.cursor, 'cursor-next');
    assert.equal(remoteDeleteDecisionId('cursor-1:op-1').startsWith('rdd:'), true);
  });
});

async function setup(tree: { liveChild?: boolean; localExtra?: boolean } = {}) {
  const store = createSyncStateStore({ indexedDB }); await store.registerScope({ ...scope, lifecycle: 'active',
    lease: { leaseId: 'lease-pull', expiresAt: Date.parse('2099-01-01T00:00:00Z') },
    checkpoint: { serverRevision: 'revision-old', cursor: 'cursor-old' }, selectedRoots: ['root-colp'],
    rootStatus: 'ready' });
  const mapping = (nativeId: string, colpId: string, parentNativeId?: string) => ({ nativeId, colpId,
    rootNativeId: 'native-root', nodeKind: nativeId === 'native-child' ? 'bookmark' as const : 'folder' as const,
    ...(parentNativeId ? { parentNativeId } : {}), projection: { revision: 'revision-old', resourceRevision: 'revision-old',
      childrenRevision: nativeId === 'native-root' ? 'children-old' : null, digest: `sha256:${colpId}`,
      content: { title: colpId, url: 'https://example.test/' } } });
  await store.putMapping(scope, mapping('native-root', 'root-colp'));
  await store.putMapping(scope, { ...mapping('native-node', 'node-1', 'native-root'), nodeKind: 'folder' });
  if (tree.liveChild) await store.putMapping(scope, mapping('native-child', 'node-child', 'native-node'));
  const api = fakeApi(); api.seed({ id: 'native-root', index: 0, title: 'root-colp' });
  api.seed({ id: 'native-node', parentId: 'native-root', index: 0, title: 'node-1' });
  if (tree.liveChild) {
    api.seed({ id: 'native-child', parentId: 'native-node', index: 0, title: 'node-child', url: 'https://example.test/' });
  }
  if (tree.localExtra) {
    api.seed({ id: 'native-extra', parentId: 'native-node', index: 0, title: 'local-only', url: 'https://example.test/extra' });
  }
  const options = { scope, store, api, session: { acceptedProtocolVersion: '0.2' as const, sessionId: 'session-pull',
    collectionId: scope.collectionId, conversionPolicy: { separator: 'preserve_remote' as const } },
    effectPageTemplate: 'https://known.example/effects/{effectId}/pages/{pageNumber}',
    effectPageAuthority: 'https://known.example' };
  const applier = createPullApplier(options);
  let ordinal = 0;
  const createEvent = (kind: 'Folder' | 'Bookmark' | 'Separator', sequence = ++ordinal, afterId?: string) =>
    pullFixtures.createEvent({ kind, sequence, collectionId: scope.collectionId, parentId: 'root-colp', afterId });
  const mutationEvent = (kind: 'update' | 'move' | 'delete') => pullFixtures.mutationEvent({ kind,
    sequence: ++ordinal, collectionId: scope.collectionId, targetId: 'node-1', parentId: 'root-colp',
    targetKind: 'folder' });
  const subtreeEvent = (paged: boolean) => pullFixtures.subtreeEvent({ sequence: ++ordinal,
    collectionId: scope.collectionId, targetId: 'node-1', members: ['node-1', 'node-child'], paged });
  const page = (events: readonly unknown[]) => pullFixtures.page({ events, nextCursor: 'cursor-next',
    collectionRevision: 'revision-next' });
  return { store, api, options, applier, createEvent, mutationEvent, subtreeEvent, page };
}

function fakeApi(): PullBookmarkApi & {
  calls: Array<{ kind: string; nativeId?: string }>; seed(node: Record<string, unknown>): void;
} {
  const nodes = new Map<string, any>();
  const api: any = { calls: [] as Array<{ kind: string; nativeId?: string }>,
    seed(node: Record<string, unknown>) { nodes.set(String(node.id), node); },
    async create(input: Record<string, unknown>) { const id = `created-${api.calls.length}`;
      nodes.set(id, { id, parentId: input.parentId, index: input.index, title: input.title, url: input.url });
      api.calls.push({ kind: 'create', nativeId: id }); return { id }; },
    async update(id: string, changes: Record<string, unknown>) { nodes.set(id, { ...nodes.get(id), ...changes });
      api.calls.push({ kind: 'update', nativeId: id }); },
    async move(id: string, destination: Record<string, unknown>) {
      nodes.set(id, { ...nodes.get(id), ...destination }); api.calls.push({ kind: 'move', nativeId: id }); },
    async remove(id: string) { nodes.delete(id); api.calls.push({ kind: 'delete', nativeId: id }); },
    async removeTree(id: string) { for (const node of [...nodes.values()]) if (node.parentId === id) nodes.delete(node.id);
      return api.remove(id); }, async get(id: string) { const node = nodes.get(id); return node ? [node] : []; },
    async getChildren(id: string) { return [...nodes.values()].filter((node) => node.parentId === id); } };
  return api;
}
