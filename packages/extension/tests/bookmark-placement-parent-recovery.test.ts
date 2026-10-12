import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { test } from 'vitest';
import { createOutboundPushWorker } from '../src/outbound-push-worker.js';
import { freezeScopeRecovery } from '../src/pull-recovery-freeze.js';
import { describeSyncAttention } from '../src/sync-attention-ui.js';
import { setup as setupEngine, scope as engineScope } from './durable-sync-engine-harness.js';
import { installOutboundPushIndexedDb, json, problem, scope, setup } from './outbound-push-worker-harness.js';

installOutboundPushIndexedDb();

for (const mode of ['top', 'bottom'] as const) {
  test(`${mode} save with deleted parent parks unchanged even when a writable recovery destination exists`, async () => {
    const fixture = await setup({ createPlacement: mode });
    await markDeletedParent(fixture);
    let sends = 0;
    const worker = createOutboundPushWorker({ ...fixture.options, fetch: async () => {
      sends += 1; throw new Error('unexpected_upload');
    } });
    assert.equal((await worker.drain()).outcome, 'recovery');
    assert.equal((await worker.drain()).outcome, 'recovery');
    assert.equal(sends, 0);
    const row = (await fixture.store.listQueue(scope))[0]!;
    assert.equal(row.status, 'unknown');
    assert.equal(row.attempt, undefined);
    assert.deepEqual(row.payload, fixture.queued.payload);
    assert.equal(row.opId, fixture.queued.opId);
    assert.equal(row.sequence, fixture.queued.sequence);
    assert.equal(row.idempotencyKey, fixture.queued.idempotencyKey);
    assert.equal((await fixture.store.getScope(scope))?.metadata?.recoveryCode, 'create_placement_parent_deleted');
    assert.equal((await fixture.store.getEngineState(scope))?.recoveryFrozen, true);
  });
}

test('an unreadable refreshed native folder freezes instead of using stale reorder metadata', async () => {
  const fixture = await setup({ createPlacement: 'top' });
  let sends = 0;
  const worker = createOutboundPushWorker({ ...fixture.options,
    readChildrenOrder: async () => { throw new Error('native_parent_unavailable'); },
    fetch: async () => { sends += 1; return problem(409, 'position_context_stale', { retryable: true }); } });
  assert.equal((await worker.drain()).outcome, 'unknown');
  fixture.clock.now = (await fixture.store.listQueue(scope))[0]!.retry.notBefore;
  assert.equal((await worker.drain()).outcome, 'recovery');
  assert.equal(sends, 1);
  assert.equal((await fixture.store.getEngineState(scope))?.lastError, 'create_placement_unproven');
});

test('definitive missing-parent refusal refreshes once and parks the save before any changed request', async () => {
  const fixture = await setup({ createPlacement: 'top' });
  let sends = 0; let refreshes = 0;
  const worker = createOutboundPushWorker({ ...fixture.options, refreshPlacement: async () => {
    refreshes += 1; await markDeletedParent(fixture); return 'continue';
  }, fetch: async () => { sends += 1; return problem(404, 'resource_not_found', { retryable: false }); } });
  assert.equal((await worker.drain()).outcome, 'unknown');
  const refused = (await fixture.store.listQueue(scope))[0]!;
  assert.equal(refused.attempt, undefined);
  fixture.clock.now = refused.retry.notBefore;
  assert.equal((await worker.drain()).outcome, 'recovery');
  assert.equal(refreshes, 1); assert.equal(sends, 1);
  assert.equal((await fixture.store.getEngineState(scope))?.lastError, 'create_placement_parent_deleted');
});

test('an unexplained repeated 404 cannot loop the placement refresh indefinitely', async () => {
  const fixture = await setup({ createPlacement: 'top' });
  let sends = 0;
  const worker = createOutboundPushWorker({ ...fixture.options,
    readChildrenOrder: async () => ['native-create', 'native-anchor-old'],
    fetch: async () => { sends += 1; return problem(404, 'resource_not_found', { retryable: false }); } });
  assert.equal((await worker.drain()).outcome, 'unknown');
  fixture.clock.now = (await fixture.store.listQueue(scope))[0]!.retry.notBefore;
  assert.equal((await worker.drain()).outcome, 'rejected');
  assert.equal(sends, 2);
  assert.equal((await fixture.store.listQueue(scope))[0]!.recovery?.code, 'resource_not_found');
});

test('a save with an unknown committed outcome replays identical bytes before considering parent deletion', async () => {
  const fixture = await setup({ createPlacement: 'top' });
  const bodies: string[] = [];
  const worker = createOutboundPushWorker({ ...fixture.options, fetch: async (_url, init) => {
    bodies.push(String(init?.body));
    if (bodies.length === 1) throw new TypeError('fetch failed');
    return json(200, { batchId: JSON.parse(String(init?.body)).batchId, results: [{
      opId: fixture.queued.opId, sequence: 1, status: 'applied', targetId: 'saved-node',
      revision: 'saved-r1', cursor: 'cursor-1', warnings: [],
    }], serverCursor: 'cursor-1' });
  } });
  assert.equal((await worker.drain()).outcome, 'unknown');
  await markDeletedParent(fixture);
  fixture.clock.now = (await fixture.store.listQueue(scope))[0]!.retry.notBefore;
  assert.equal((await worker.drain()).outcome, 'terminal');
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0], bodies[1]);
});

for (const code of ['create_placement_parent_deleted', 'create_placement_unproven'] as const) {
  test(`${code} stays frozen across engine wakes and exposes a location-review explanation`, async () => {
    const fixture = await setupEngine();
    await freezeScopeRecovery(fixture.store, engineScope, code);
    await fixture.engine.wake('manual');
    await fixture.engine.wake('alarm');
    assert.deepEqual(fixture.order, []);
    const engine = await fixture.store.getEngineState(engineScope);
    assert.equal(engine?.recoveryFrozen, true);
    assert.equal(engine?.lastError, code);
    const view = describeSyncAttention({ recoveryFrozen: true, lastError: code, recoveryCode: code });
    assert.equal(view.terminal.show, true);
    assert.match(view.terminal.copy, /save location needs review/);
  });
}

async function markDeletedParent(fixture: Awaited<ReturnType<typeof setup>>) {
  await fixture.store.putMountBinding(scope, { mountId: 'writable-other-root', nativeRootId: 'root-native',
    remoteMountNodeId: 'other-root', boundaryVersion: '1', materialized: false, status: 'active',
    rootRole: 'bookmarks-bar' });
  await fixture.store.putRemoteObservation(scope, { colpId: 'root-push', remoteRevision: 'deleted-r1',
    cursor: 'cursor-deleted', kind: 'tombstone', payload: { deleted: true },
    sourceDigest: 'sha256:deleted-parent', observedAt: 20 });
}
