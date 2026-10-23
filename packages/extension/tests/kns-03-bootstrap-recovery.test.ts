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
import { describe, test } from 'vitest';
import { digestJson, validateOperation } from '../src/bookmark-event-codec.js';
import type { LocalNodeFact } from '../src/bootstrap/matcher.js';
import {
  assertOpaquePlanned, assertOpaqueQueued, assertStampedColp, barMount, baseConfirm, bindRemoteMount,
  bookmark, completeBootstrapAck, freezeRecovery, frozenConfirm, installKns03IndexedDb, nestedLocalFacts,
  productConfirm, putLiveRemoteMappings, recoveryNode, recoveryRoot, root, scope, setup,
  unfreezeRecovery,
} from './kns-03-bootstrap-harness.js';
import type { JsonObject } from '../src/sync-state-store.js';

installKns03IndexedDb();

describe('KNS-03 bootstrap nested trees, recovery and freeze', () => {
  test('nested folder is parent-first; unmapped child does not complete or hang on Collection root', async () => {
    const { store, coordinator } = await setup();
    const folder: LocalNodeFact = {
      nativeId: 'folder-1', mountNativeRootId: 'bar', parentNativeId: 'bar', kind: 'folder', title: 'Nested',
    };
    const child: LocalNodeFact = {
      nativeId: 'bm-nested', mountNativeRootId: 'bar', parentNativeId: 'folder-1', kind: 'bookmark',
      title: 'Nested bm', url: 'https://example.com/nested',
    };
    const view = await coordinator.confirm(baseConfirm({
      localFacts: [folder, child], remoteFacts: [root], mounts: [barMount()], rootNodeId: 'folder-root',
    }));
    await bindRemoteMount(store, 'mount-bar');
    const resumed = await coordinator.advance(view.run.runId, baseConfirm({
      localFacts: [folder, child], remoteFacts: [root], mounts: [barMount('mount-bar')], rootNodeId: 'folder-root',
    }));
    const localCreates = resumed.report?.planned.filter((op) => op.reason === 'local-only') ?? [];
    assert.ok(localCreates.some((op) => op.nativeId === 'folder-1' && op.parentId === 'mount-bar'));
    assert.ok(localCreates.some((op) => op.nativeId === 'bm-nested' && op.parentId !== 'folder-root'));
    assert.equal(localCreates.filter((op) => op.node?.kind === 'bookmark' && op.parentId === 'folder-root').length, 0);
    const queued = await store.listQueue(scope);
    assertOpaquePlanned(resumed.report?.planned);
    assertOpaqueQueued(queued);
    assertStampedColp(queued);
    assert.ok(queued.some((row) => row.opId.includes('.create.folder-1')));
    assert.equal(queued.filter((row) => row.opId.includes('.create.bm-nested')).length, 0);
    assert.notEqual(resumed.run.phase, 'completed');
    assert.notEqual(resumed.run.phase, 'needs_attention');
  });

  test('nested bookmark enqueues under the folder once the parent mapping exists', async () => {
    const { store, coordinator } = await setup();
    const facts = nestedLocalFacts();
    const input = baseConfirm({
      localFacts: facts, remoteFacts: [root], mounts: [barMount()], rootNodeId: 'folder-root',
    });
    const view = await coordinator.confirm(input);
    await bindRemoteMount(store, 'mount-bar');
    await coordinator.advance(view.run.runId, { ...input, mounts: [barMount('mount-bar')] });
    const before = await store.listQueue(scope);
    assert.ok(before.some((row) => row.opId.includes('.create.folder-1')));
    assert.equal(before.filter((row) => row.opId.includes('.create.bm-nested')).length, 0);
    await store.putMapping(scope, {
      nativeId: 'folder-1', colpId: 'folder-colp', rootNativeId: 'bar', nodeKind: 'folder',
      parentNativeId: 'bar', parentColpId: 'mount-bar',
      projection: { revision: 'rev-folder-1', digest: 'sha256:folder-1', content: { title: 'Nested' } },
    });
    const resumed = await coordinator.resume({ ...input, mounts: [barMount('mount-bar')] });
    assert.ok(resumed);
    const queued = await store.listQueue(scope);
    assertOpaquePlanned(resumed.report?.planned);
    assertOpaqueQueued(queued);
    assertStampedColp(queued);
    const folder = queued.find((row) => row.opId.includes('.create.folder-1'))!;
    const child = queued.find((row) => row.opId.includes('.create.bm-nested'))!;
    assert.ok(folder);
    assert.ok(child);
    assert.ok(folder.sequence < child.sequence);
    const childPayload = child.payload as { payload: { parentId: string; node: { kind?: string; url?: string } } };
    assert.equal(childPayload.payload.parentId, 'folder-colp');
    assert.equal(childPayload.payload.node.url, 'https://example.com/nested');
    assert.equal(queued.filter((row) => {
      const payload = row.payload as { type: string; payload: { parentId?: string; node?: { kind?: string } } };
      return payload.type === 'create_node' && payload.payload.parentId === 'folder-root'
        && payload.payload.node?.kind === 'bookmark';
    }).length, 0);
    assert.equal(resumed.report?.planned.filter((op) => op.node?.kind === 'bookmark'
      && op.parentId === 'folder-root').length, 0);
    assert.equal((await store.getScope(scope))?.firstRun, 'running');
    assert.equal(resumed.run.phase, 'syncing');
    const provisional = (await store.listMappings(scope)).filter(row => row.colpId.startsWith('pending-'));
    assert.deepEqual(provisional.map(row => row.nativeId), ['bm-nested']);
    assert.equal(provisional[0]!.projection.revision, `local-${child.opId}`);
  });

  test('terminal parent create receipt rematch enqueues nested child without pending mapping', async () => {
    const { store, coordinator } = await setup();
    const facts = nestedLocalFacts();
    const input = baseConfirm({
      localFacts: facts, remoteFacts: [root], mounts: [barMount()], rootNodeId: 'folder-root',
    });
    const view = await coordinator.confirm(input);
    await bindRemoteMount(store, 'mount-bar');
    await coordinator.advance(view.run.runId, { ...input, mounts: [barMount('mount-bar')] });
    const folderOp = (await store.listQueue(scope)).find((row) => row.opId.includes('.create.folder-1'))!;
    assert.ok(folderOp);
    await store.completeQueueWithReceipt(scope, folderOp.sequence, {
      opId: folderOp.opId, operationDigest: folderOp.digest, kind: 'terminal',
      receiptId: 'receipt-folder-1', resultDigest: 'sha256:folder-result',
      result: { results: [{ opId: folderOp.opId, sequence: folderOp.sequence, status: 'applied',
        targetId: 'folder-from-receipt', revision: 'rev-folder-1' }] },
    });
    assert.equal(await store.getMappingByNativeId(scope, 'folder-1'), null);
    const resumed = await coordinator.resume({ ...input, mounts: [barMount('mount-bar')] });
    assert.ok(resumed);
    const queued = await store.listQueue(scope);
    const child = queued.find((row) => row.opId.includes('.create.bm-nested'))!;
    assert.ok(child);
    const childPayload = child.payload as { payload: { parentId: string; node: { url?: string } } };
    assert.equal(childPayload.payload.parentId, 'folder-from-receipt');
    assert.equal(childPayload.payload.node.url, 'https://example.com/nested');
    assert.ok(folderOp.sequence < child.sequence);
    assert.equal(queued.filter((row) => {
      const payload = row.payload as { type: string; payload: { parentId?: string; node?: { kind?: string } } };
      return payload.type === 'create_node' && payload.payload.parentId === 'folder-root'
        && payload.payload.node?.kind === 'bookmark';
    }).length, 0);
    assert.equal((await store.getMappingByNativeId(scope, 'folder-1')), null);
    assert.equal((await store.listMappings(scope)).filter((row) => row.colpId.startsWith('pending-')
      || row.nativeId.startsWith('pending-')).length, 0);
    assert.equal((await store.getScope(scope))?.firstRun, 'running');
    assert.equal(resumed.run.phase, 'syncing');
  });

  test('product-shaped confirm does not enqueue and retryReason survives persist as snapshot_pending', async () => {
    const { store, coordinator } = await setup();
    const view = await coordinator.confirm(productConfirm());
    const mounts = await store.listMountBindings(scope);
    assert.equal(mounts.length, 1);
    assert.equal(mounts[0]?.remoteMountNodeId, null);
    assert.equal((await store.listQueue(scope)).length, 0);
    assert.equal(view.run.phase, 'syncing');
    assert.equal(view.run.retryReason, 'snapshot_pending');
    assert.equal((await store.getScope(scope))?.firstRun, 'running');
    const status = await coordinator.status();
    assert.equal(status.retryReason, 'snapshot_pending');
    assert.equal(status.firstRun, 'running');
  });

  test('recovery nodes then resume rematches remote tree and skips matched local creates', async () => {
    const { store, coordinator } = await setup();
    await coordinator.confirm(productConfirm());
    await store.stageRecoveryPage(scope, {
      snapshotId: 'snap-join', revision: 'r1', syncCursor: 'spc2.join', identityDigest: 'identity-join',
      rootNodeId: 'folder-root', page: 0, pageDigest: 'sha256:join', previousPageDigest: null, nextCursor: null,
      complete: true,
      nodes: [
        recoveryRoot('folder-root'),
        recoveryNode('mount-bar', 'folder-root', 'Folder', { title: 'Bar', folderRole: 'bookmarks-bar' },
          'bookmarks-bar'),
        recoveryNode('bookmark-shared', 'mount-bar', 'Bookmark',
          { title: 'bm-1', url: 'https://example.com/one' }),
        recoveryNode('bookmark-remote', 'mount-bar', 'Bookmark',
          { title: 'Remote only', url: 'https://example.com/remote-only' }),
      ],
    });
    const resumed = await coordinator.resume(productConfirm());
    assert.ok(resumed);
    assert.equal(resumed.report?.emptyRemote, false);
    assert.ok(resumed.report?.matched.some((row) => row.nativeId === 'bm-1'));
    assert.equal(resumed.report?.planned.filter((op) => op.reason === 'mount-resolve').length, 0);
    assert.equal(resumed.report?.planned.filter((op) => op.nativeId === 'bm-1').length, 0);
    assert.ok(resumed.report?.planned.some((op) => op.nativeId === 'bm-local' && op.reason === 'local-only'));
    assertOpaquePlanned(resumed.report?.planned);
    const queued = await store.listQueue(scope);
    assert.equal(queued.filter((row) => row.opId.includes('.create.bm-1')).length, 0);
    assert.equal(queued.filter((row) => row.opId.includes('.create.bm-local')).length, 1);
    assert.equal(queued.filter((row) => {
      const payload = row.payload as { type: string; payload: { node?: { folderRole?: string } } };
      return payload.type === 'create_node' && payload.payload.node?.folderRole === 'bookmarks-bar';
    }).length, 0);
    assertOpaqueQueued(queued);
    assertStampedColp(queued);
    assert.equal(resumed.run.retryReason, undefined);
  });

  test('cutover without recovery nodes rematches live mappings and skips matched creates', async () => {
    const { store, coordinator } = await setup();
    await coordinator.confirm(productConfirm());
    await completeBootstrapAck(store);
    assert.equal((await store.exportScope(scope)).recoveryNodes.length, 0);
    await putLiveRemoteMappings(store);
    const resumed = await coordinator.resume(productConfirm());
    assert.ok(resumed);
    assert.equal(resumed.report?.emptyRemote, false);
    assert.ok(resumed.report?.matched.some((row) => row.nativeId === 'bm-1'));
    assert.equal(resumed.report?.planned.filter((op) => op.reason === 'mount-resolve').length, 0);
    assert.equal(resumed.report?.planned.filter((op) => op.nativeId === 'bm-1').length, 0);
    assert.ok(resumed.report?.planned.some((op) => op.nativeId === 'bm-local' && op.reason === 'local-only'));
    assertOpaquePlanned(resumed.report?.planned);
    const queued = await store.listQueue(scope);
    assert.equal(queued.filter((row) => row.opId.includes('.create.bm-1')).length, 0);
    assert.equal(queued.filter((row) => row.opId.includes('.create.bm-local')).length, 1);
    assert.equal(queued.filter((row) => {
      const payload = row.payload as { type: string; payload: { node?: { folderRole?: string } } };
      return payload.type === 'create_node' && payload.payload.node?.folderRole === 'bookmarks-bar';
    }).length, 0);
    assertOpaqueQueued(queued);
    assertStampedColp(queued);
    assert.equal(resumed.run.retryReason, undefined);
  });

  test('frozen engine confirm does not enqueue and retryReason survives persist as queue_recovery_frozen', async () => {
    const { store, coordinator } = await setup();
    await freezeRecovery(store);
    const view = await coordinator.confirm(frozenConfirm());
    const mounts = await store.listMountBindings(scope);
    assert.equal(mounts.length, 2);
    assert.ok(mounts.every((row) => row.remoteMountNodeId === null));
    assert.equal((await store.listQueue(scope)).length, 0);
    assert.equal(view.run.phase, 'syncing');
    assert.equal(view.run.retryReason, 'queue_recovery_frozen');
    assert.equal((await store.getScope(scope))?.firstRun, 'running');
    const status = await coordinator.status();
    assert.equal(status.retryReason, 'queue_recovery_frozen');
    assert.equal(status.firstRun, 'running');
  });

  test('unfreeze plus resume rematches recovery nodes and enqueues mount-resolve under rootNodeId', async () => {
    const { store, coordinator } = await setup();
    await freezeRecovery(store);
    await coordinator.confirm(frozenConfirm());
    await store.stageRecoveryPage(scope, {
      snapshotId: 'snap-empty', revision: 'r1', syncCursor: 'spc2.empty', identityDigest: 'identity-empty',
      rootNodeId: 'folder-root', page: 0, pageDigest: 'sha256:empty', previousPageDigest: null, nextCursor: null,
      complete: true,
      nodes: [recoveryRoot('folder-root')],
    });
    await unfreezeRecovery(store);
    const resumed = await coordinator.resume(frozenConfirm());
    assert.ok(resumed);
    assertOpaquePlanned(resumed.report?.planned);
    const queued = await store.listQueue(scope);
    assert.equal(queued.length, 2);
    assertOpaqueQueued(queued);
    assertStampedColp(queued);
    for (const row of queued) {
      const payload = row.payload as { type: string; payload: { parentId: string; node: { folderRole?: string } } };
      assert.equal(payload.type, 'create_node');
      assert.equal(payload.payload.parentId, 'folder-root');
      assert.ok(payload.payload.node.folderRole === 'bookmarks-bar'
        || payload.payload.node.folderRole === 'other-bookmarks');
    }
    assert.equal(resumed.run.retryReason, undefined);
    assert.equal((await store.getScope(scope))?.firstRun, 'running');
    const again = await coordinator.confirm(frozenConfirm());
    assert.equal(again.run.runId, resumed.run.runId);
    assert.equal((await store.listQueue(scope)).length, 2);
    assert.deepEqual((await store.listQueue(scope)).map((row) => row.opId).sort(),
      queued.map((row) => row.opId).sort());
  });

  test('engine wake and first-run status resume a running bootstrap after freeze lifts', async () => {
    const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
    const engine = await readFile(join(rootDir, 'src/sw/engine.ts'), 'utf8');
    const firstRun = await readFile(join(rootDir, 'src/sw/first-run.ts'), 'utf8');
    assert.match(engine, /resumeRunningBootstrap/);
    assert.match(engine, /if \(result && !result\.recoveryFrozen && result\.phase !== 'error'\)[\s\S]{0,1400}resumeRunningBootstrap/);
    assert.match(engine, /await worker\.drain\(\);[\s\S]{0,180}resumeRunningBootstrap/);
    assert.doesNotMatch(engine, /onTerminal:[\s\S]{0,520}resumeRunningBootstrap/);
    assert.match(firstRun, /export async function resumeRunningBootstrap/);
    assert.match(firstRun, /retryReason === 'queue_recovery_frozen'/);
    assert.match(firstRun, /retryReason === 'snapshot_pending'/);
    assert.match(firstRun, /recoveryFrozen === true/);
    assert.match(firstRun, /queuedOpIds\.some\(\(opId\) => !priorOpIds\.has\(opId\)\)/);
    assert.doesNotMatch(firstRun, /queuedOpIds\.length > 0/);
    assert.doesNotMatch(firstRun, /bookmarks\.(create|update|move|remove)/);
    assert.doesNotMatch(firstRun, /scheduleSyncEngineWake|from '\.\/engine\.js'/);
  });

  test('pending inbox create rematch queues the node and leftover inbox stays syncing', async () => {
    const { store, coordinator } = await setup();
    await store.stageBookmarkEvent(scope, {
      eventId: 'evt-inbox-create', dedupeKey: 'd-inbox-create', occurredAt: '2026-07-27T05:00:00Z',
      kind: 'create', nativeId: 'bm-inbox',
      details: { title: 'Inbox', url: 'https://example.com/inbox', parentNativeId: 'bar',
        mountNativeRootId: 'bar', kind: 'bookmark' },
    });
    const view = await coordinator.confirm(baseConfirm({
      localFacts: [],
      remoteFacts: [root, { nodeId: 'mount-bar', parentId: 'folder-root', kind: 'folder', title: 'Bar',
        folderRole: 'bookmarks-bar', revision: 'rev-bar-1' }],
      mounts: [barMount('mount-bar')],
    }));
    const queued = await store.listQueue(scope);
    assert.equal(queued.filter((row) => row.opId.includes('.create.bm-inbox')).length, 1);
    assert.equal((await store.listBookmarkEventsByStatus(scope, 'pending')).length, 1);
    assert.equal(view.run.phase, 'syncing');
    assert.equal((await store.getScope(scope))?.firstRun, 'running');
  });

  test('enqueue stamps replicaId/sequence/collectionId and digests the schema-valid wire body', async () => {
    const { store, coordinator } = await setup();
    await coordinator.confirm(baseConfirm({
      localFacts: [bookmark('bm-1', 'https://example.com/one')],
      remoteFacts: [root], mounts: [barMount()], rootNodeId: 'folder-root',
    }));
    const queued = await store.listQueue(scope);
    assert.equal(queued.length, 1);
    assertStampedColp(queued);
    const row = queued[0]!;
    assert.equal(row.payload.type, 'create_node');
    assert.notEqual(row.digest, 'sha256:pending');
    const unstamped = Object.fromEntries(Object.entries(row.payload)
      .filter(([key]) => key !== 'replicaId' && key !== 'sequence' && key !== 'collectionId')) as JsonObject;
    assert.notEqual(row.digest, digestJson(unstamped));
    assert.equal(validateOperation(row.payload), true);
  });
});
