import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, test } from 'vitest';
import { assertPreviewSourceUnchanged, bindImportFolderChoices, createBookmarkImportCoordinator,
} from '../src/bookmark-import-plan.js';
import { previewChromeBookmarkImport, previewNetscapeBookmarkImport } from '../src/import-preview.js';
import { createSyncStateStore, type SyncScope } from '../src/sync-state-store.js';

const scope: SyncScope = { environment: 'production', serverId: 'known', serverOrigin: 'https://known.example',
  accountId: 'account', browserProfileId: 'profile', collectionId: 'collection', replicaId: 'replica', generation: 1 };
const html = (body: string) => new TextEncoder().encode(`<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><p>${body}</DL><p>`);
const nested = () => previewNetscapeBookmarkImport(html('<DT><H3>Reading</H3><DL><p>'
  + '<DT><A HREF="https://example.test/one">One</A><DT><A HREF="https://example.test/two">Two</A>'
  + '</DL><p><DT><H3>Skip me</H3><DL><p><DT><A HREF="https://example.test/skip">Skip</A></DL><p>'));

let indexedDB: IDBFactory;
beforeEach(() => { indexedDB = new IDBFactory(); });

async function setup() {
  const store = createSyncStateStore({ indexedDB });
  await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease', expiresAt: 99_999 },
    checkpoint: { serverRevision: 'r1', cursor: 'c1' }, selectedRoots: ['root'] });
  await store.putMapping(scope, { nativeId: 'native-root', colpId: 'server-root', rootNativeId: 'native-root',
    nodeKind: 'folder', projection: { revision: 'children-r1', digest: 'sha256:root' } });
  return { store, coordinator: createBookmarkImportCoordinator({ store, scope, now: () => 100 }) };
}

describe('P3-35 durable bookmark import plans', () => {
  for (const legacy of [false, true]) test(`a consumed rejection stays visible instead of completing an import (legacy=${legacy})`, async () => {
    const { store, coordinator } = await setup();
    try {
      const conversion = previewNetscapeBookmarkImport(html('<DT><A HREF="https://example.test/one">One</A>'));
      const plan = await coordinator.commit({ conversion, choices: conversion.tree.map(node => ({
        sourceNodeId: node.sourceNodeId, action: 'import', target: {
          nativeId: 'native-root', colpId: 'server-root', revision: 'children-r1' },
      })) });
      const queued = (await store.listQueue(scope))[0]!;
      await store.completeQueueWithReceipt(scope, queued.sequence, { opId: queued.opId,
        operationDigest: queued.digest, kind: 'terminal', receiptId: 'rejected-import', resultDigest: 'sha256:rejected',
        result: { results: [{ opId: queued.opId, sequence: queued.sequence, status: 'rejected', code: 'resource_not_found' }] } });
      if (legacy) {
        const node = (await store.listImportNodes(scope, plan.planId))[0]!;
        const db = await store.open(); const tx = db.transaction('import_nodes', 'readwrite');
        tx.objectStore('import_nodes').put({ ...node, status: 'terminal', recovery: undefined });
        await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); });
        await store.setImportPlanState(scope, plan.planId, 'complete', 101); store.close();
      } else {
        const immediate = await coordinator.status(plan.planId);
        assert.equal(immediate.state, 'attention'); assert.equal(immediate.progress.terminal, 0);
        assert.equal(immediate.nodes[0]?.recovery, 'push_rejected');
      }
      const view = await coordinator.advance(plan.planId);
      assert.equal(view.state, 'attention'); assert.equal(view.progress.terminal, 0);
      assert.equal(view.progress.recoverable, 1); assert.equal(view.nodes[0]?.recovery, 'push_rejected');
      const retried = await coordinator.retry(plan.planId);
      assert.equal(retried.state, 'attention'); assert.equal(retried.nodes[0]?.recovery, 'push_rejected');
      assert.equal((await store.getQueueByOpId(scope, queued.opId))?.status, 'terminal');
      assert.equal((await store.listQueue(scope)).length, 1, 'a consumed sequence must not be replayed');
    } finally { store.close(); }
  });

  test('missing import plans and nodes cannot be changed into recoverable work', async () => {
    const { store } = await setup();
    try {
      await assert.rejects(store.setImportPlanState(scope, 'missing-plan', 'active', 100), /import_plan_not_found/);
      await assert.rejects(store.setImportNodeRecovery(scope, 'missing-plan', 'missing-op', null), /import_node_not_found/);
      assert.deepEqual(await store.listImportPlans(scope), []);
      assert.deepEqual(await store.listQueue(scope), []);
    } finally { store.close(); }
  });

  test('requires an explicit mapping or Skip for every source folder and handles all-skip without queue work', async () => {
    const { store, coordinator } = await setup(); const conversion = nested();
    await assert.rejects(() => coordinator.commit({ conversion, choices: [] }), /folder_choice_required/);
    const choices = conversion.tree.map((node) => ({ sourceNodeId: node.sourceNodeId, action: 'skip' as const }));
    const plan = await coordinator.commit({ conversion, choices });
    assert.deepEqual(plan.progress, { total: 5, skipped: 5, queued: 0, terminal: 0, recoverable: 0 });
    assert.equal(plan.state, 'complete');
    assert.equal((await store.listQueue(scope)).length, 0);
  });

  test('remaps folders, assigns stable per-node opIds and sequences, and makes preview/commit replay idempotent', async () => {
    const { store, coordinator } = await setup(); const conversion = nested();
    const choices = conversion.tree.map((node, index) => index === 0
      ? { sourceNodeId: node.sourceNodeId, action: 'import' as const, target: {
        nativeId: 'native-root', colpId: 'server-root', revision: 'children-r1' } }
      : { sourceNodeId: node.sourceNodeId, action: 'skip' as const });
    const first = await coordinator.commit({ conversion, choices });
    const replay = await coordinator.commit({ conversion: structuredClone(conversion), choices });
    assert.equal(replay.planId, first.planId);
    assert.deepEqual(replay.nodes.map((node) => node.opId), first.nodes.map((node) => node.opId));
    const queue = await store.listQueue(scope);
    assert.equal(queue.length, 1); assert.equal(queue[0]?.sequence, 1);
    assert.equal((queue[0]?.payload.payload as unknown as Record<string, unknown>).parentId, 'server-root');
    assert.equal(new Set(first.nodes.filter((node) => node.choice === 'import').map((node) => node.opId)).size, 3);
  });

  test('reopens after interruption and queues children only after durable parent authority, without requeueing terminal nodes', async () => {
    const { store, coordinator } = await setup(); const conversion = nested(); const source = conversion.tree[0]!;
    const committed = await coordinator.commit({ conversion, choices: [
      { sourceNodeId: source.sourceNodeId, action: 'import', target: {
        nativeId: 'native-root', colpId: 'server-root', revision: 'children-r1' } },
      { sourceNodeId: conversion.tree[1]!.sourceNodeId, action: 'skip' },
    ] });
    const rootQueue = (await store.listQueue(scope))[0]!;
    await store.completeQueueWithReceipt(scope, rootQueue.sequence, { opId: rootQueue.opId,
      operationDigest: rootQueue.digest, kind: 'terminal', receiptId: 'receipt-folder', resultDigest: 'sha256:folder',
      result: { targetId: 'folder-authority', revision: 'folder-r1' } });
    store.close();
    const reopened = createSyncStateStore({ indexedDB });
    const resumed = createBookmarkImportCoordinator({ store: reopened, scope, now: () => 200 });
    await resumed.resume(committed.planId);
    const queue = await reopened.listQueue(scope);
    assert.deepEqual(queue.map((item) => item.sequence), [1, 2, 3]);
    assert.equal(queue.filter((item) => item.opId === rootQueue.opId).length, 1);
    assert(queue.slice(1).every((item) => (item.payload.payload as unknown as Record<string, unknown>).parentId === 'folder-authority'));
  });

  test('atomically settles an imported create receipt and authoritative mapping', async () => {
    const { store, coordinator } = await setup(); const conversion = nested(); const source = conversion.tree[0]!;
    await coordinator.commit({ conversion, choices: [
      { sourceNodeId: source.sourceNodeId, action: 'import', target: {
        nativeId: 'native-root', colpId: 'server-root', revision: 'children-r1' } },
      { sourceNodeId: conversion.tree[1]!.sourceNodeId, action: 'skip' },
    ] });
    const queued = (await store.listQueue(scope))[0]!;
    const lease = await store.acquireLease(scope, 'owner', 101, 1_000); assert.equal(lease.outcome, 'acquired');
    await store.claimNextQueue(scope, 'owner', lease.fence, 102);
    await store.bindPushAttempt(scope, queued.sequence, 'owner', lease.fence, { sessionId: 'session', batchId: 'batch',
      idempotencyKey: 'key', endpointIdentity: 'syncPush', mediaType: 'application/json',
      body: JSON.stringify({ sessionId: 'session', batchId: 'batch', atomic: false, operations: [queued.payload] }),
      bodyDigest: 'digest' });
    const result = { batchId: 'batch', results: [{ opId: queued.opId, sequence: queued.sequence, status: 'applied',
      targetId: 'server-created', revision: 'server-r1', cursor: 'cursor-1', warnings: [] }], serverCursor: 'cursor-1' };
    await store.settleClaimedPush(scope, queued.sequence, 'owner', lease.fence, { outcome: 'terminal', receipt: {
      opId: queued.opId, operationDigest: queued.digest, kind: 'terminal', receiptId: `push-${queued.opId}`,
      resultDigest: 'sha256:result', result } });
    assert.equal((await store.listQueue(scope))[0]?.status, 'terminal');
    assert.deepEqual((await store.listImportNodes(scope, (await coordinator.status()).planId))
      .find((node) => node.opId === queued.opId)?.authoritativeTarget,
      { colpId: 'server-created', revision: 'server-r1' });
  });

  test('settles against an already materialized pull target and resumes children after a recovery race', async () => {
    const { store, coordinator } = await setup(); const conversion = nested(); const source = conversion.tree[0]!;
    const plan = await coordinator.commit({ conversion, choices: [
      { sourceNodeId: source.sourceNodeId, action: 'import', target: {
        nativeId: 'native-root', colpId: 'server-root', revision: 'children-r1' } },
      { sourceNodeId: conversion.tree[1]!.sourceNodeId, action: 'skip' },
    ] });
    const queued = (await store.listQueue(scope))[0]!;
    await store.putMapping(scope, { nativeId: 'native-from-pull', colpId: 'server-created', rootNativeId: 'native-root',
      nodeKind: 'folder', parentNativeId: 'native-root', projection: { revision: 'server-r1', digest: 'sha256:created' } });
    const lease = await store.acquireLease(scope, 'owner', 101, 1_000); assert.equal(lease.outcome, 'acquired');
    await store.claimNextQueue(scope, 'owner', lease.fence, 102);
    const result = { batchId: 'batch', results: [{ opId: queued.opId, sequence: queued.sequence, status: 'applied',
      targetId: 'server-created', revision: 'server-r1', cursor: 'cursor-1', warnings: [] }], serverCursor: 'cursor-1' };
    await store.settleClaimedPush(scope, queued.sequence, 'owner', lease.fence, { outcome: 'terminal', receipt: {
      opId: queued.opId, operationDigest: queued.digest, kind: 'terminal', receiptId: `push-${queued.opId}`,
      resultDigest: 'sha256:result', result } });
    assert.equal((await store.getMappingByNativeId(scope, 'native-from-pull'))?.colpId, 'server-created');
    await coordinator.resume(plan.planId);
    const queue = await store.listQueue(scope); assert.deepEqual(queue.map((item) => item.sequence), [1, 2, 3]);
    assert(queue.slice(1).every((item) => (item.payload.payload as unknown as Record<string, unknown>).parentId === 'server-created'));
  });

  test('derives partial progress and recoverable Conflict, Session and permission states from durable facts', async () => {
    const { store, coordinator } = await setup(); const conversion = nested();
    const plan = await coordinator.commit({ conversion, choices: conversion.tree.map((node) => ({
      sourceNodeId: node.sourceNodeId, action: 'import' as const,
      target: { nativeId: 'native-root', colpId: 'server-root', revision: 'children-r1' },
    })) });
    const queued = await store.listQueue(scope); const first = queued[0]!; const conflict = queued[1]!;
    await store.completeQueueWithReceipt(scope, first.sequence, { opId: first.opId, operationDigest: first.digest,
      kind: 'terminal', receiptId: 'receipt', resultDigest: 'sha256:terminal' });
    await coordinator.recordRecovery(plan.planId, first.opId, 'conflict');
    assert.equal((await coordinator.status(plan.planId)).progress.terminal, 1);
    for (const code of ['session_expired', 'permission_required'] as const) {
      await coordinator.recordRecovery(plan.planId, plan.nodes.at(-1)!.opId, code);
      const recovered = await coordinator.status(plan.planId);
      assert.equal(recovered.state, 'attention'); assert(recovered.progress.recoverable >= 1);
    }
    await store.completeQueueWithReceipt(scope, conflict.sequence, { opId: conflict.opId, operationDigest: conflict.digest,
      kind: 'terminal', receiptId: 'conflict-receipt', resultDigest: 'sha256:conflict', result: { status: 'conflict' } });
    await coordinator.retry(plan.planId);
    const retried = await coordinator.status(plan.planId);
    assert.equal(retried.state, 'attention'); assert.equal(retried.progress.recoverable, 1);
    assert.equal((await store.listQueue(scope)).filter((item) => item.status === 'terminal').length, 2);
  });

  test('projects a Push Conflict atomically and retry keeps its immutable operation blocked for resolution', async () => {
    const { store, coordinator } = await setup(); const conversion = nested(); const source = conversion.tree[0]!;
    const plan = await coordinator.commit({ conversion, choices: [
      { sourceNodeId: source.sourceNodeId, action: 'import', target: {
        nativeId: 'native-root', colpId: 'server-root', revision: 'children-r1' } },
      { sourceNodeId: conversion.tree[1]!.sourceNodeId, action: 'skip' },
    ] });
    const queued = (await store.listQueue(scope))[0]!; const lease = await store.acquireLease(scope, 'owner', 101, 1_000);
    assert.equal(lease.outcome, 'acquired'); await store.claimNextQueue(scope, 'owner', lease.fence, 102);
    const result = { batchId: 'batch', results: [{ opId: queued.opId, sequence: queued.sequence, status: 'conflicted',
      conflictId: 'conflict-1', cursor: 'cursor-1', warnings: [] }], serverCursor: 'cursor-1' };
    await store.settleClaimedPush(scope, queued.sequence, 'owner', lease.fence, { outcome: 'blocked', receipt: {
      opId: queued.opId, operationDigest: queued.digest, kind: 'terminal', receiptId: `push-${queued.opId}`,
      resultDigest: 'sha256:conflict', result }, retry: { attempt: 0, notBefore: 0 },
    recovery: { code: 'conflict_pending' } });
    const conflicted = await coordinator.status(plan.planId); assert.equal(conflicted.state, 'attention');
    assert.equal(conflicted.progress.recoverable, 1); assert.equal((await store.listQueue(scope))[0]?.status, 'blocked');
    const retried = await coordinator.retry(plan.planId); assert.equal(retried.state, 'attention');
    assert.equal(retried.progress.recoverable, 1); assert.equal((await store.listQueue(scope))[0]?.status, 'blocked');
  });

  test('keeps real bookmark events interleavable and never stores source file bytes', async () => {
    const { store, coordinator } = await setup(); const conversion = nested();
    const plan = await coordinator.commit({ conversion, choices: conversion.tree.map((node) => ({
      sourceNodeId: node.sourceNodeId, action: 'import' as const,
      target: { nativeId: 'native-root', colpId: 'server-root', revision: 'children-r1' },
    })) });
    await store.allocateSequenceAndEnqueue(scope, { opId: 'live-op', batchId: 'live-op', idempotencyKey: 'live-op',
      digest: 'sha256:live', endpointIdentity: 'syncPush', mediaType: 'application/json', baseRevision: null,
      operationRevision: 'local-live', status: 'pending', retry: { attempt: 0, notBefore: 0 }, payload: { type: 'create_node' } }, { allowUnstamped: true });
    await coordinator.pause(plan.planId); const lease = await store.acquireLease(scope, 'owner', 101, 1_000);
    assert.equal(lease.outcome, 'acquired'); assert.equal(await store.claimNextQueue(scope, 'owner', lease.fence, 102), null);
    await coordinator.resume(plan.planId);
    assert.equal((await store.claimNextQueue(scope, 'owner', lease.fence, 103))?.opId, plan.nodes[0]?.opId);
    const exported = JSON.stringify(await store.exportScope(scope));
    assert.match(exported, /live-op/); assert.doesNotMatch(exported, /NETSCAPE-Bookmark-file/);
  });

  test('rejects empty and oversized files before a plan can exist', async () => {
    const { store, coordinator } = await setup();
    assert.throws(() => previewNetscapeBookmarkImport(new Uint8Array()), /import_empty/);
    await assert.rejects(() => coordinator.commit({
      conversion: previewNetscapeBookmarkImport(html('<DT><A HREF="https://example.test/none">Gone</A>')),
      choices: [],
    }), /folder_choice_required/);
    assert.throws(() => previewNetscapeBookmarkImport(new Uint8Array(17), { maxInputBytes: 16 }), /input_too_large/);
    assert.equal((await store.exportScope(scope)).importPlans.length, 0);
  });

  test('unselected roots enqueue nothing and out-of-bound targets never create a plan', async () => {
    const { store, coordinator } = await setup(); const conversion = nested();
    const skipped = conversion.tree[1]!;
    const imported = conversion.tree[0]!;
    const plan = await coordinator.commit({ conversion, choices: [
      { sourceNodeId: imported.sourceNodeId, action: 'import', target: {
        nativeId: 'native-root', colpId: 'server-root', revision: 'children-r1' } },
      { sourceNodeId: skipped.sourceNodeId, action: 'skip' },
    ] });
    const queue = await store.listQueue(scope);
    const skippedNodes = plan.nodes.filter((node) => node.choice === 'skip');
    assert.equal(skippedNodes.length, 2);
    assert.equal(skippedNodes.every((node) => node.status === 'skipped'), true);
    assert.equal(queue.some((item) => skippedNodes.some((node) => node.opId === item.opId)), false);
    assert.doesNotMatch(JSON.stringify(queue), /example\.test\/skip/);
    assert.throws(() => bindImportFolderChoices([
      { sourceNodeId: imported.sourceNodeId, action: 'import', target: {
        nativeId: 'outside-native', colpId: 'outside-colp', revision: 'r-x' } },
    ], new Map([['native-root\u0000server-root', {
      nativeId: 'native-root', colpId: 'server-root', revision: 'children-r1' }]])), /folder_choice_invalid/);
  });

  test('binds conversion and choice digests, rejects a changed native source, and keeps a failed plan', async () => {
    const { store, coordinator } = await setup(); const conversion = nested();
    const first = await coordinator.commit({ conversion, choices: conversion.tree.map((node) => ({
      sourceNodeId: node.sourceNodeId, action: 'import' as const,
      target: { nativeId: 'native-root', colpId: 'server-root', revision: 'children-r1' },
    })) });
    const stored = (await store.listImportPlans(scope))[0]!;
    assert.equal(stored.conversionDigest, conversion.digest);
    assert.match(stored.choiceDigest, /^sha256:[0-9a-f]{64}$/u);
    assert.equal(stored.planId, first.planId);
    const chrome = previewChromeBookmarkImport([{ id: '0', title: '', children: [
      { id: '1', parentId: '0', index: 0, title: 'Bar', children: [
        { id: '2', parentId: '1', index: 0, title: 'A', url: 'https://a.example/' }] }] }]);
    const changed = previewChromeBookmarkImport([{ id: '0', title: '', children: [
      { id: '1', parentId: '0', index: 0, title: 'Bar', children: [
        { id: '2', parentId: '1', index: 0, title: 'B', url: 'https://b.example/' }] }] }]);
    assert.throws(() => assertPreviewSourceUnchanged(chrome, changed), /preview_expired/);
    assertPreviewSourceUnchanged(chrome, previewChromeBookmarkImport([{ id: '0', title: '', children: [
      { id: '1', parentId: '0', index: 0, title: 'Bar', children: [
        { id: '2', parentId: '1', index: 0, title: 'A', url: 'https://a.example/' }] }] }]));
    await coordinator.recordRecovery(first.planId, first.nodes[0]!.opId, 'permission_required');
    const afterFailure = await coordinator.status(first.planId);
    assert.equal(afterFailure.state, 'attention');
    assert.equal((await store.listImportPlans(scope)).some((plan) => plan.planId === first.planId), true);
    assert.equal((await store.listImportNodes(scope, first.planId)).length, first.nodes.length);
  });

  test('pause stops advance without throwing and resume keeps the same plan and opIds', async () => {
    const { store, coordinator } = await setup(); const conversion = nested();
    const plan = await coordinator.commit({ conversion, choices: conversion.tree.map((node) => ({
      sourceNodeId: node.sourceNodeId, action: 'import' as const,
      target: { nativeId: 'native-root', colpId: 'server-root', revision: 'children-r1' },
    })) });
    const paused = await coordinator.pause(plan.planId);
    assert.equal(paused.state, 'paused');
    assert.deepEqual(paused.nodes.map((node) => node.opId), plan.nodes.map((node) => node.opId));
    const stillPaused = await coordinator.advance(plan.planId);
    assert.equal(stillPaused.state, 'paused');
    const lease = await store.acquireLease(scope, 'owner', 101, 1_000); assert.equal(lease.outcome, 'acquired');
    assert.equal(await store.claimNextQueue(scope, 'owner', lease.fence, 102), null);
    const resumed = await coordinator.resume(plan.planId);
    assert.equal(resumed.planId, plan.planId);
    assert.deepEqual(resumed.nodes.map((node) => node.opId), plan.nodes.map((node) => node.opId));
    assert.equal((await store.claimNextQueue(scope, 'owner', lease.fence, 103))?.opId, plan.nodes[0]?.opId);
  });

  test('terminal receipt without identity goes to attention and retry does not mint a new create', async () => {
    const { store, coordinator } = await setup(); const conversion = nested(); const source = conversion.tree[0]!;
    const plan = await coordinator.commit({ conversion, choices: [
      { sourceNodeId: source.sourceNodeId, action: 'import', target: {
        nativeId: 'native-root', colpId: 'server-root', revision: 'children-r1' } },
      { sourceNodeId: conversion.tree[1]!.sourceNodeId, action: 'skip' },
    ] });
    const queued = (await store.listQueue(scope))[0]!;
    await store.completeQueueWithReceipt(scope, queued.sequence, { opId: queued.opId,
      operationDigest: queued.digest, kind: 'terminal', receiptId: 'receipt-unknown', resultDigest: 'sha256:unknown' });
    const attention = await coordinator.advance(plan.planId);
    assert.equal(attention.state, 'attention');
    assert.equal(attention.nodes.find((node) => node.opId === queued.opId)?.recovery, 'conflict');
    const opIds = attention.nodes.map((node) => node.opId);
    const retried = await coordinator.retry(plan.planId);
    assert.equal(retried.state, 'attention');
    assert.deepEqual(retried.nodes.map((node) => node.opId), opIds);
    assert.equal((await store.listQueue(scope)).filter((item) => item.opId === queued.opId).length, 1);
    assert.equal((await store.listQueue(scope)).length, 1);
  });
});
