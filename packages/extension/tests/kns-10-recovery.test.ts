import { executeRemoteDelete } from './remote-delete-preview-harness.js';
/**
 * Owner: KNS-08 (QA). Fixture: see e2e/kns-08-ids.ts.
 * Run: see e2e/kns-08-ids.ts.
 * Evidence: test-results/known-extension-first-run-sync/<commit>/
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, test } from 'vitest';
import { localFactsFromRoots } from '../src/bootstrap/local-facts.js';
import { createBookmarkEventQueue, type BookmarkEventApi, type BookmarkEventNode } from '../src/bookmark-event-queue.js';
import type { NormalizedBookmarkRoot } from '../src/chrome-bookmark-tree.js';
import { createPullApplier, type PullBookmarkApi } from '../src/pull-applier.js';
import { recoverVerifiedOrFreeze } from '../src/recovery-guard.js';
import {
  confirmAddRange, countMountAffected, detachScopeMount, mintRemoteDeleteConfirmation,
  previewAddRange, rejoinScopeMount,
} from '../src/scope-commands.js';
import { classifyRejoinMappings, pullApplyAllowed, reconcileAfterReauth, revokeBookmarkSync } from '../src/scope-reconcile.js';
import { createSyncStateStore, type MappingInput, type SyncScope } from '../src/sync-state-store.js';
import { pullFixtures } from './pull-effect-fixtures.js';

const scope: SyncScope = Object.freeze({
  environment: 'production', serverId: 'server-kns10', serverOrigin: 'https://known.example',
  accountId: 'account-kns10', browserProfileId: 'profile-kns10', collectionId: 'collection-kns10',
  replicaId: 'replica-kns10', generation: 1,
});
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

let indexedDB: IDBFactory;
beforeEach(() => { indexedDB = new IDBFactory(); });

describe('KNS-10 scope detach, deletion journal and recovery', () => {
  test('uncheck detaches without enqueueing a remote delete', async () => {
    const store = await activeStore();
    await seedMount(store);
    await detachScopeMount(store, scope, 'mount-bar');
    const types = (await store.listQueue(scope)).map((row) => row.payload.type);
    assert.equal((await store.getMountBinding(scope, 'mount-bar'))?.status, 'detached');
    assert.equal(types.includes('delete_node'), false);
    assert.equal(types.includes('delete_subtree'), false);
    assert.equal((await store.getMappingByNativeId(scope, 'bm-1'))?.colpId, 'colp-bm-1');
    assert.equal(pullApplyAllowed({
      hasBookmarkPermission: true, hasActiveMounts: await store.hasActiveMounts(scope), rootStatus: 'ready',
    }), false);
  });

  test('remoteDelete requires an affected-count token and is a separate command', async () => {
    const store = await activeStore();
    await seedMount(store);
    const live = await countMountAffected(store, scope, 'mount-bar');
    assert.equal(live, 1);
    const rejected = await executeRemoteDelete(store, scope, {
      mountId: 'mount-bar', confirmationToken: 'wrong', affectedCount: live,
    });
    assert.equal(rejected.ok, false);
    assert.equal((await store.listQueue(scope)).length, 0);
    assert.equal((await store.getMountBinding(scope, 'mount-bar'))?.status, 'active');
    const token = mintRemoteDeleteConfirmation({
      mountId: 'mount-bar', affectedCount: live, boundaryVersion: '1',
    });
    const accepted = await executeRemoteDelete(store, scope, {
      mountId: 'mount-bar', confirmationToken: token, affectedCount: live,
    });
    assert.equal(accepted.ok, true);
    const queued = await store.listQueue(scope);
    assert.equal(queued.length, 1);
    assert.equal(queued[0]!.payload.type, 'delete_subtree');
    assert.equal(queued[0]!.payload.targetId, 'remote-bar');
    assert.equal((await store.getMountBinding(scope, 'mount-bar'))?.status, 'detached');
    assert.equal((await store.getMountBinding(scope, 'mount-bar'))?.pendingRemoteDelete?.confirmation, token);
    assert.equal('confirmationToken' in ((await store.getMountBinding(scope, 'mount-bar'))?.pendingRemoteDelete ?? {}), false);
    assert.equal((await store.getMappingByNativeId(scope, 'bm-1'))?.nativeId, 'bm-1');
  });

  test('add-range preview is inert until confirm and then reuses proven ids', async () => {
    const store = await activeStore();
    await seedMount(store);
    const roots = tree();
    const preview = await previewAddRange(store, scope, { roots, selectedNativeIds: ['bar'] });
    assert.equal(preview.ok, true);
    assert.equal(preview.bookmarkCount, 2);
    assert.equal((await store.listQueue(scope)).length, 0);
    const confirmed = await confirmAddRange(store, scope, {
      previewId: preview.previewId, confirmationId: 'conf-range', treeDigest: preview.treeDigest,
      localFacts: localFactsFromRoots(roots, ['bar']),
      remoteFacts: [
        { nodeId: 'folder-root', parentId: null, kind: 'folder', title: '', folderRole: 'root', revision: 'r0' },
        { nodeId: 'remote-bar', parentId: 'folder-root', kind: 'folder', title: 'Bar', folderRole: 'bookmarks-bar',
          revision: 'r1' },
      ],
      rootNodeId: 'folder-root', now: () => 50,
    });
    assert.equal(confirmed.ok, true);
    const created = (await store.listQueue(scope)).filter((row) => row.payload.type === 'create_node');
    const wire = JSON.stringify(created);
    assert.equal(wire.includes('https://example.com/one'), false);
    assert.equal(wire.includes('https://example.com/two'), true);
    assert.equal((await store.getMappingByNativeId(scope, 'bm-1'))?.colpId, 'colp-bm-1');
    assert.equal((await store.getMountBinding(scope, 'mount-bar'))?.status, 'active');
  });

  test('missing onRemoved payload without identity journals and reports it without a guessed delete', async () => {
    const { queue, store } = await eventFixture();
    const outcome = await queue.removed('ghost', { parentId: 'root-selected', index: 0 });
    assert.equal(outcome.outcome, 'filtered');
    const journal = await store.listDeletionJournal(scope, 'ghost');
    assert.equal(journal.length, 1);
    assert.equal(journal[0]!.parentNativeId, 'root-selected');
    assert.doesNotMatch(JSON.stringify(journal), /"title"|"url"/);
    assert.equal((await store.listQueue(scope)).length, 0);
    // One item for the Sync center, not a stop.
    assert.deepEqual((await store.listLocalIssues(scope)).map((issue) => issue.code), ['deletion_identity_unproven']);
    assert.notEqual((await store.getEngineState(scope))?.recoveryFrozen, true);
  });

  test('parent deleted first reconstructs the subtree from mappings and does not guess titles', async () => {
    const { queue, store } = await eventFixture();
    await mapping(store, 'folder-parent', 'folder-colp', 'root-selected', 'folder-r1', { title: 'Parent' },
      'root-selected', 'folder');
    await mapping(store, 'child-a', 'child-colp', 'root-selected', 'child-r1', { title: 'Child', url: 'https://c.example' },
      'folder-parent', 'bookmark');
    const outcome = await queue.removed('folder-parent', { parentId: 'root-selected', index: 0, node: {
      id: 'folder-parent', title: 'Parent', type: 'folder', children: [],
    } });
    assert.equal(outcome.outcome, 'staged');
    await queue.flush();
    const journal = await store.listDeletionJournal(scope);
    assert.ok(journal.some((row) => row.nativeId === 'folder-parent' && row.kind === 'folder'));
    assert.ok(journal.some((row) => row.nativeId === 'child-a' && row.parentNativeId === 'folder-parent'));
    assert.doesNotMatch(JSON.stringify(journal), /"title"|"url"/);
    const queued = await store.listQueue(scope);
    assert.equal(queued.some((row) => row.payload.type === 'delete_subtree' || row.payload.type === 'delete_node'), true);
    store.close();
    const reopened = createSyncStateStore({ indexedDB });
    assert.equal((await reopened.listDeletionJournal(scope)).length, journal.length);
  });

  test('revoke then grant after first-run captures a genuine unmapped local once', async () => {
    const store = await activeStore();
    await store.setFirstRun(scope, 'completed');
    await seedMount(store);
    const api = memoryApi();
    api.put({ id: 'bar', title: 'Bar', type: 'folder', children: [] });
    api.put({ id: 'bm-1', parentId: 'bar', index: 0, title: 'One', url: 'https://example.com/one', type: 'bookmark' });
    api.put({ id: 'bm-2', parentId: 'bar', index: 1, title: 'Two', url: 'https://example.com/two', type: 'bookmark' });
    const queue = createBookmarkEventQueue({
      scope, store, api, now: () => '2026-09-06T00:00:00Z',
      uuid: (() => { let n = 0; return () => `reauth-${++n}`; })(), autoFlush: false,
    });
    const mapsBefore = (await store.listMappings(scope)).length;
    const queueBefore = await store.listQueue(scope);
    const revoked = await revokeBookmarkSync(store, scope);
    assert.equal(revoked.mappingCount, mapsBefore);
    assert.equal(revoked.queueLength, queueBefore.length);
    assert.equal((await store.getScope(scope))?.rootStatus, 'permission_required');
    assert.equal((await store.listQueue(scope)).length, queueBefore.length);
    assert.equal((await store.getMappingByNativeId(scope, 'bm-1'))?.colpId, 'colp-bm-1');
    await reconcileAfterReauth(store, scope, {
      treeDigest: 'sha256:tree-reauth-stable', nativePresent: new Set(['bar', 'bm-1', 'bm-2']),
      discovered: [{ nativeId: 'bar', ancestorNativeIds: [] }],
    });
    assert.equal((await store.getScope(scope))?.rootStatus, 'ready');
    assert.equal((await store.getScope(scope))?.firstRun, 'completed');
    await queue.recover();
    const queued = await store.listQueue(scope);
    assert.equal((await store.getMappingByNativeId(scope, 'bm-1'))?.colpId, 'colp-bm-1');
    assert.equal(queued.filter((row) => row.payload.type === 'create_node').length, 1);
    assert.equal((await store.getEngineState(scope))?.recoveryFrozen ?? false, false);
    await queue.recover();
    assert.equal((await store.listQueue(scope)).filter((row) => row.payload.type === 'create_node').length, 1);
  });

  test('revoke keeps local bookmarks, queue and mapping; re-auth does not guess overwrite', async () => {
    const store = await activeStore();
    await seedMount(store);
    await store.allocateSequenceAndEnqueue(scope, {
      opId: 'op-keep', batchId: 'op-keep', idempotencyKey: 'op-keep', digest: 'sha256:keep',
      endpointIdentity: 'syncPush', mediaType: 'application/json', baseRevision: 'r1',
      operationRevision: 'local-op-keep', status: 'pending', retry: { attempt: 0, notBefore: 0 },
      payload: { type: 'update_node_content', opId: 'op-keep', targetId: 'colp-bm-1', baseRevision: 'r1',
        occurredAt: '2026-09-06T00:00:00.000Z', payload: { base: { title: 'One' }, value: { title: 'One' } } },
    }, { allowUnstamped: true });
    const mapsBefore = (await store.listMappings(scope)).length;
    const opIdsBefore = (await store.listQueue(scope)).map((row) => row.opId);
    const before = await revokeBookmarkSync(store, scope);
    assert.equal(before.queueLength, 1);
    assert.equal(before.mappingCount, mapsBefore);
    assert.equal((await store.getScope(scope))?.rootStatus, 'permission_required');
    assert.deepEqual((await store.listQueue(scope)).map((row) => row.opId), opIdsBefore);
    assert.equal((await store.listQueue(scope)).length, 1);
    assert.equal((await store.listMappings(scope)).length, mapsBefore);
    assert.equal((await store.getMappingByNativeId(scope, 'bm-1'))?.projection.content?.title, 'One');
    await reconcileAfterReauth(store, scope, {
      treeDigest: 'sha256:tree-reauth', nativePresent: new Set(['bar', 'bm-1']),
      discovered: [{ nativeId: 'bar', ancestorNativeIds: [] }],
    });
    assert.equal((await store.getMappingByNativeId(scope, 'bm-1'))?.colpId, 'colp-bm-1');
    assert.equal((await store.getMappingByNativeId(scope, 'bm-1'))?.projection.content?.title, 'One');
    assert.equal((await store.getMountBinding(scope, 'mount-bar'))?.lastReconcile?.treeDigest, 'sha256:tree-reauth');
  });

  test('stale cursor, missing page and unknown identity freeze with zero Chrome side effects', async () => {
    const store = await activeStore();
    await store.putMapping(scope, {
      nativeId: '1', colpId: 'root', rootNativeId: '1', nodeKind: 'folder',
      projection: { revision: 'r1', digest: 'd-root', content: { title: 'Root' } },
    });
    const recorded = await store.getScope(scope);
    await store.registerScope({ ...recorded!, selectedRoots: ['root'] });
    const chrome = countingChrome([{ id: '1', title: 'Root' }]);
    await assert.rejects(() => recoverVerifiedOrFreeze({
      scope, store, staged: [], api: chrome.api, staleCursor: true,
    }), /sync_cursor_expired/);
    assert.equal(chrome.destructive, 0);
    assert.equal((await store.getEngineState(scope))?.recoveryFrozen, true);

    const missing = createSyncStateStore({ indexedDB: new IDBFactory() });
    await activeOn(missing);
    await missing.putMapping(scope, {
      nativeId: '1', colpId: 'root', rootNativeId: '1', nodeKind: 'folder',
      projection: { revision: 'r1', digest: 'd-root', content: { title: 'Root' } },
    });
    const missingScope = await missing.getScope(scope);
    await missing.registerScope({ ...missingScope!, selectedRoots: ['root'] });
    await missing.stageRecoveryPage(scope, {
      snapshotId: 'snap-missing', revision: 'r2', syncCursor: 'c-missing', identityDigest: 'id-1',
      rootNodeId: 'root', page: 0, pageDigest: 'sha256:p0', previousPageDigest: null, nextCursor: 'next',
      complete: false, nodes: [{ colpId: 'root', parentId: null, position: 'a', kind: 'Folder',
        payloadDigest: 'sha256:root' }],
    });
    const missingChrome = countingChrome([{ id: '1', title: 'Root' }]);
    await assert.rejects(() => recoverVerifiedOrFreeze({
      scope, store: missing, staged: [], api: missingChrome.api, missingPage: true,
    }), /snapshot_page_missing/);
    assert.equal(missingChrome.destructive, 0);

    const unknown = createSyncStateStore({ indexedDB: new IDBFactory() });
    await activeOn(unknown);
    await unknown.putMapping(scope, {
      nativeId: '1', colpId: 'root', rootNativeId: '1', nodeKind: 'folder',
      projection: { revision: 'r1', digest: 'd-root', content: { title: 'Root' } },
    });
    await unknown.putMapping(scope, {
      nativeId: '99', colpId: 'ghost', rootNativeId: '1', nodeKind: 'bookmark', parentNativeId: '1',
      projection: { revision: 'r1', digest: 'd-ghost', content: { title: 'Ghost', url: 'https://ghost.example' } },
    });
    const unknownScope = await unknown.getScope(scope);
    await unknown.registerScope({ ...unknownScope!, selectedRoots: ['root'] });
    const unknownChrome = countingChrome([{ id: '1', title: 'Root' }]);
    await assert.rejects(() => recoverVerifiedOrFreeze({
      scope, store: unknown, staged: [], api: unknownChrome.api, freezeUnprovenIdentity: true,
    }), /bookmark_lookup_empty/);
    assert.equal(unknownChrome.destructive, 0);
    assert.notEqual((await unknown.getEngineState(scope))?.lastError, 'recovery_identity_unproven');
  });

  test('detached mount Pull delete does not mutate Chrome or drop mapping', async () => {
    const fixture = await pullFixture();
    await fixture.store.putMountBinding(scope, {
      mountId: 'mount-bar', nativeRootId: 'native-root', remoteMountNodeId: 'root-colp',
      boundaryVersion: '1', materialized: false, status: 'detached', customSourceKey: 'folder:ordinary',
    });
    await fixture.applier.stage(fixture.page([fixture.mutationEvent('delete')]));
    await fixture.applier.resume();
    assert.equal(fixture.api.calls.some((call) => call.kind === 'delete'), false);
    assert.equal((await fixture.store.getMappingByColpId(scope, 'node-1'))?.nativeId, 'native-node');
  });

  test('rejoin without native comparison classifies candidates and remains detached', async () => {
    const store = await activeStore();
    await seedMount(store);
    await store.detachMount(scope, 'mount-bar');
    await store.putMapping(scope, {
      nativeId: 'recovery:dup', colpId: 'pending-dup', rootNativeId: 'bar', mountId: 'mount-bar',
      nodeKind: 'bookmark', projection: { revision: 'r1', digest: 'sha256:dup' },
    });
    const { classification } = await rejoinScopeMount(store, scope, 'mount-bar', new Set(['bar', 'bm-1']), ['orphan']);
    assert.equal((await store.getMountBinding(scope, 'mount-bar'))?.status, 'detached');
    assert.ok(classification.verified.some((row) => row.nativeId === 'bm-1'));
    assert.ok(classification.conflicts.some((row) => row.nativeId === 'recovery:dup'));
    assert.deepEqual(classification.candidates, ['orphan']);
    assert.equal((await store.listQueue(scope)).length, 0);
    const classified = classifyRejoinMappings({
      mount: (await store.getMountBinding(scope, 'mount-bar'))!, mappings: await store.listMappings(scope),
      nativePresent: new Set(['bar', 'bm-1']), extraNativeIds: ['orphan'],
    });
    assert.equal(classified.verified.some((row) => row.colpId === 'colp-bm-1'), true);
  });

  test('recovery carries a dirty pre-recovery Pull world out without replaying it', async () => {
    const fixture = await pullFixture();
    // Pre-recovery leftovers: a page whose intent was prepared but never applied, and its
    // blocked sibling. Both were written through the production repository entries.
    const leftover = pullFixtures.mutationEvent({ kind: 'update', sequence: 90, collectionId: scope.collectionId,
      targetId: 'node-1', parentId: 'root-colp' });
    await fixture.store.stagePullPage(scope, { pageId: 'page-leftover', previousCursor: 'cursor-old',
      nextCursor: 'cursor-leftover', collectionRevision: 'revision-old', pageDigest: 'sha256:leftover',
      events: [{ eventId: 'event-leftover', cursor: 'cursor-leftover', operationId: 'op-90',
        effectId: 'fx-90', effectDigest: 'sha256:fx-90', operationDigest: 'sha256:op-90',
        kind: 'node_content_updated', payload: leftover as never }] });
    await fixture.store.preparePullIntent(scope, 'event-leftover', { intentId: 'intent:event-leftover',
      correlationId: 'correlation-leftover', operationId: 'op-90', eventId: 'event-leftover', effectId: 'fx-90',
      expected: { kind: 'change', nativeId: 'native-node' }, expiresAt: Date.now() + 300_000,
      state: 'intent_prepared', generation: scope.generation });
    await fixture.store.stageRecoveryPage(scope, { snapshotId: 'snapshot-kns10', sessionId: 'session-kns10',
      revision: 'revision-recovery', syncCursor: 'cursor-recovery', identityDigest: 'identity-kns10',
      rootNodeId: 'root-colp', page: 0, pageDigest: 'sha256:recovery', previousPageDigest: null,
      nextCursor: null, complete: true, nodes: [{ colpId: 'root-colp', parentId: null, position: 'a',
        kind: 'Folder', payloadDigest: 'sha256:root',
        mapping: { nativeId: 'native-root', colpId: 'root-colp', rootNativeId: 'native-root', nodeKind: 'folder',
          projection: { revision: 'revision-recovery', childrenRevision: 'children-recovery',
            digest: 'sha256:root', content: { title: 'root-colp' } } } },
      { colpId: 'node-1', parentId: 'root-colp', position: 'b', kind: 'Bookmark', payloadDigest: 'sha256:node',
        mapping: { nativeId: 'native-node', colpId: 'node-1', rootNativeId: 'native-root', nodeKind: 'bookmark',
          parentColpId: 'root-colp', projection: { revision: 'revision-recovery', digest: 'sha256:node',
            content: { title: 'node-1', url: 'https://example.test/' } } } }] });

    await fixture.store.commitRecovery(scope, 'snapshot-kns10');

    const cutover = await fixture.store.exportScope(scope);
    assert.equal(cutover.pullPages.length, 0);
    assert.equal(cutover.pullEvents.length, 0);
    assert.equal(cutover.intents.length, 0);
    assert.equal(cutover.cursor?.cursor, 'cursor-recovery');
    // The production entry point no longer re-drives the leftover event into Chrome.
    await fixture.applier.resume();
    assert.equal((await fixture.store.getMappingByColpId(scope, 'node-1'))?.projection.content?.title, 'node-1');
    assert.equal(fixture.api.calls.filter((call) => call.kind === 'update').length, 0);

    // A normal Pull after the cutover still applies.
    const fresh = pullFixtures.mutationEvent({ kind: 'update', sequence: 91, collectionId: scope.collectionId,
      targetId: 'node-1', parentId: 'root-colp' });
    await fixture.applier.stage(fixture.page([fresh], 'cursor-next'));
    await fixture.applier.resume();
    assert.equal(fixture.api.calls.filter((call) => call.kind === 'update').length, 1);
    assert.equal((await fixture.store.getMappingByColpId(scope, 'node-1'))?.projection.content?.title, 'Remote update');
    assert.equal((await fixture.store.getScope(scope))?.lifecycle, 'active');
    assert.equal((await fixture.store.getEngineState(scope))?.recoveryFrozen ?? false, false);
  });

  test('wires scope command bodies and journals deletion_journal v10', async () => {
    const firstRun = await readFile(join(packageRoot, 'src/sw/first-run.ts'), 'utf8');
    const schema = await readFile(join(packageRoot, 'src/sync-state/schema.ts'), 'utf8');
    assert.match(firstRun, /detachScopeMount/);
    assert.match(firstRun, /rejoinScopeMount/);
    assert.match(firstRun, /executeRemoteDelete/);
    assert.doesNotMatch(firstRun, /bookmarks\.(create|update|move|remove)/);
    assert.match(schema, /deletionJournal: 'deletion_journal'/);
    assert.match(schema, /DATABASE_VERSION = 23/);
  });
});

async function activeStore() {
  const store = createSyncStateStore({ indexedDB });
  await activeOn(store);
  return store;
}

async function activeOn(store: ReturnType<typeof createSyncStateStore>) {
  await store.registerScope({
    ...scope, lifecycle: 'active', lease: { leaseId: 'lease-kns10', expiresAt: 10_000 },
    checkpoint: { serverRevision: 'r0', cursor: 'c0' }, selectedRoots: [], rootStatus: 'ready',
  });
}

async function seedMount(store: ReturnType<typeof createSyncStateStore>) {
  await store.putMountBinding(scope, {
    mountId: 'mount-bar', nativeRootId: 'bar', remoteMountNodeId: 'remote-bar', boundaryVersion: '1',
    materialized: false, status: 'active', customSourceKey: 'folder:ordinary',
  });
  await store.putMapping(scope, {
    nativeId: 'bar', colpId: 'remote-bar', rootNativeId: 'bar', mountId: 'mount-bar', nodeKind: 'folder',
    projection: { revision: 'r-bar', digest: 'sha256:bar', content: { title: 'Bar' } },
  });
  await store.putMapping(scope, {
    nativeId: 'bm-1', colpId: 'colp-bm-1', rootNativeId: 'bar', mountId: 'mount-bar', parentNativeId: 'bar',
    nodeKind: 'bookmark', projection: { revision: 'r-bm', digest: 'sha256:bm',
      content: { title: 'One', url: 'https://example.com/one' } },
  });
}

function tree(): readonly NormalizedBookmarkRoot[] {
  return [{
    nativeId: 'bar', title: 'Bar', kind: 'folder', managed: false, rootKind: 'bookmarks_bar', children: [
      { nativeId: 'bm-1', title: 'One', kind: 'bookmark', managed: false, url: 'https://example.com/one', children: [] },
      { nativeId: 'bm-2', title: 'Two', kind: 'bookmark', managed: false, url: 'https://example.com/two', children: [] },
    ],
  }];
}

async function eventFixture() {
  const store = createSyncStateStore({ indexedDB });
  await store.registerScope({
    ...scope, lifecycle: 'active', lease: { leaseId: 'lease', expiresAt: 10_000 },
    checkpoint: { serverRevision: 'r', cursor: 'c' }, selectedRoots: [], rootStatus: 'ready',
  });
  await store.configureBrowserRoots(scope, {
    discovered: [{ nativeId: 'root-selected', ancestorNativeIds: [] }],
    selectedNativeIds: ['root-selected'], privateNativeIds: [], status: 'ready',
  });
  const selectedRoot = await store.getMappingByNativeId(scope, 'root-selected');
  await store.putMapping(scope, {
    nativeId: 'root-selected', colpId: selectedRoot!.colpId, rootNativeId: 'root-selected', nodeKind: 'folder',
    projection: { revision: 'server-root-r1', childrenRevision: 'children-server-root-r1',
      digest: 'sha256:server-root-r1', content: { title: 'Selected root' } },
  });
  const api = memoryApi();
  const queue = createBookmarkEventQueue({
    scope, store, api, now: () => '2026-09-06T00:00:00Z', uuid: (() => { let n = 0; return () => `local-${++n}`; })(),
    autoFlush: false,
  });
  return { store, queue, api };
}

async function mapping(store: ReturnType<typeof createSyncStateStore>, nativeId: string, colpId: string,
  rootNativeId: string, revision: string, content: Record<string, string>, parentNativeId?: string,
  nodeKind?: MappingInput['nodeKind']) {
  await store.putMapping(scope, {
    nativeId, colpId, rootNativeId, ...(parentNativeId ? { parentNativeId } : {}),
    ...(nodeKind ? { nodeKind } : {}),
    projection: { revision, childrenRevision: `children-${revision}`, digest: `sha256:${revision}`, content },
  });
}

function memoryApi(): BookmarkEventApi & { put(node: Record<string, unknown>): void } {
  const nodes = new Map<string, BookmarkEventNode>();
  return {
    put(node) { nodes.set(String(node.id), structuredClone(node) as unknown as BookmarkEventNode); },
    async get(id) { const value = nodes.get(id); return value ? [structuredClone(value)] : []; },
    async getChildren(id) {
      return [...nodes.values()].filter((node) => node.parentId === id).map((node) => structuredClone(node));
    },
  };
}

function countingChrome(seed: readonly { id: string; parentId?: string; title: string; url?: string }[]) {
  const nodes = new Map(seed.map((node) => [node.id, { ...node }]));
  let destructive = 0;
  const api: PullBookmarkApi = {
    async create(input) {
      destructive += 1;
      const id = `created-${destructive}`;
      nodes.set(id, { id, parentId: input.parentId, title: input.title ?? '', url: input.url });
      return { id };
    },
    async update() { destructive += 1; },
    async move() { destructive += 1; },
    async remove() { destructive += 1; },
    async removeTree() { destructive += 1; },
    async get(id) {
      const node = nodes.get(id);
      return node ? [{ id: node.id, title: node.title, ...(node.parentId ? { parentId: node.parentId } : {}),
        ...(node.url ? { url: node.url } : {}) }] : [];
    },
    async getChildren(id) {
      return [...nodes.values()].filter((node) => node.parentId === id)
        .map((node) => ({ id: node.id, title: node.title, ...(node.parentId ? { parentId: node.parentId } : {}),
          ...(node.url ? { url: node.url } : {}) }));
    },
  };
  return { api, get destructive() { return destructive; } };
}

async function pullFixture() {
  const store = createSyncStateStore({ indexedDB });
  await store.registerScope({
    ...scope, lifecycle: 'active', lease: { leaseId: 'lease-kns10', expiresAt: Date.parse('2099-01-01T00:00:00Z') },
    checkpoint: { serverRevision: 'revision-old', cursor: 'cursor-old' }, selectedRoots: ['root-colp'],
    rootStatus: 'ready',
  });
  const mappingRow = (nativeId: string, colpId: string, parentNativeId?: string): MappingInput => ({
    nativeId, colpId, rootNativeId: 'native-root', nodeKind: colpId === 'root-colp' ? 'folder' : 'bookmark',
    ...(parentNativeId ? { parentNativeId } : {}),
    projection: { revision: 'revision-old', resourceRevision: 'revision-old',
      childrenRevision: colpId === 'root-colp' ? 'children-old' : null, digest: `sha256:${colpId}`,
      content: { title: colpId, url: 'https://example.test/' } },
  });
  await store.putMapping(scope, mappingRow('native-root', 'root-colp'));
  await store.putMapping(scope, mappingRow('native-node', 'node-1', 'native-root'));
  const api = fakePullApi();
  api.seed({ id: 'native-root', index: 0, title: 'root-colp' });
  api.seed({ id: 'native-node', parentId: 'native-root', index: 0, title: 'node-1', url: 'https://example.test/' });
  const options = {
    scope, store, api, session: { acceptedProtocolVersion: '0.2' as const, sessionId: 'session-kns10',
      collectionId: scope.collectionId, conversionPolicy: { separator: 'preserve_remote' as const } },
    effectPageTemplate: 'https://known.example/effects/{effectId}/pages/{pageNumber}',
    effectPageAuthority: 'https://known.example',
  };
  let ordinal = 0;
  return {
    store, api, applier: createPullApplier(options),
    mutationEvent: (kind: 'update' | 'move' | 'delete') => pullFixtures.mutationEvent({
      kind, sequence: ++ordinal, collectionId: scope.collectionId, targetId: 'node-1', parentId: 'root-colp',
    }),
    page: (events: readonly unknown[], nextCursor = 'cursor-next') => pullFixtures.page({
      events, nextCursor, collectionRevision: 'revision-next',
    }),
  };
}

function fakePullApi(): PullBookmarkApi & {
  calls: Array<{ kind: string }>; seed(node: Record<string, unknown>): void;
} {
  const nodes = new Map<string, Record<string, unknown>>();
  const api: ReturnType<typeof fakePullApi> = {
    calls: [],
    seed(node) { nodes.set(String(node.id), node); },
    async create(input) {
      const id = `created-${api.calls.length}`;
      nodes.set(id, { id, parentId: input.parentId, title: input.title, url: input.url });
      api.calls.push({ kind: 'create' }); return { id };
    },
    async update(id, changes) {
      nodes.set(id, { ...nodes.get(id), ...changes }); api.calls.push({ kind: 'update' });
    },
    async move(id, destination) {
      nodes.set(id, { ...nodes.get(id), ...destination }); api.calls.push({ kind: 'move' });
    },
    async remove(id) { nodes.delete(id); api.calls.push({ kind: 'delete' }); },
    async removeTree(id) {
      for (const node of [...nodes.values()]) if (node.parentId === id) nodes.delete(String(node.id));
      return api.remove(id);
    },
    async get(id) {
      const node = nodes.get(id);
      return node && typeof node.id === 'string'
        ? [{ id: node.id, title: String(node.title ?? ''),
          ...(typeof node.parentId === 'string' ? { parentId: node.parentId } : {}),
          ...(typeof node.url === 'string' ? { url: node.url } : {}) }] : [];
    },
    async getChildren(id) {
      return [...nodes.values()].filter((node) => node.parentId === id && typeof node.id === 'string')
        .map((node) => ({ id: String(node.id), title: String(node.title ?? ''),
          ...(typeof node.parentId === 'string' ? { parentId: node.parentId } : {}),
          ...(typeof node.url === 'string' ? { url: node.url } : {}) }));
    },
  };
  return api;
}
