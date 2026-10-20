import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { test } from 'vitest';
import { assertQueuedUploadAllowed } from '../src/queued-upload-boundary.js';
import { createOutboundPushWorker } from '../src/outbound-push-worker.js';
import { digestJson } from '../src/bookmark-event-codec.js';
import { needsReplicaRebuild } from '../src/sync-failure-class.js';
import { syncAttentionTerminalCode, terminalFreezeReasonCopy } from '../src/sync-attention-ui.js';
import type { QueueOperation } from '../src/sync-state-store.js';
import { bookmark, fixture, scope } from './bookmark-event-queue-harness.js';
import { endpoints } from './outbound-push-worker-harness.js';

async function setup(type: 'create' | 'change' | 'move' = 'create') {
  const f = await fixture(new IDBFactory(), { autoFlush: true, mappedNode: type !== 'create' });
  const native = bookmark(type === 'create' ? 'secret' : 'mapped', 'folder-parent', 0,
    'Private title', 'https://example.test/private');
  f.api.put(native);
  if (type === 'create') await f.queue.created(native.id, native);
  else if (type === 'change') await f.queue.changed(native.id, { title: native.title, url: native.url });
  else {
    f.api.put({ ...native, parentId: 'root-selected' });
    await f.queue.moved(native.id, { parentId: 'root-selected', index: 0, oldParentId: 'folder-parent', oldIndex: 0 });
  }
  const guard = (queue: QueueOperation) => assertQueuedUploadAllowed({ store: f.store, scope, queue,
    parentOf: async id => (await f.api.get(id))[0]?.parentId });
  let now = 1_000;
  const sent: string[] = [];
  const options = { scope, store: f.store, endpoints: async () => endpoints, now: () => now,
    ownerId: () => 'privacy-worker', schedule: () => undefined, assertUploadAllowed: guard,
    sessions: { async get() { return { credential: { accessToken: 'test-token' }, session: {
      sessionId: 'test-session', expiresAt: '2099-01-01T00:00:00Z', scope: 'collection' as const,
      snapshotRequired: false, credentialAuthorityDigest: 'a'.repeat(64),
      collection: { collectionId: scope.collectionId, serverCursor: 'cursor-old', serverRevision: 'revision-old' },
      replicaLease: { leaseId: 'lease', generation: '1', state: 'active' as const, expiresAt: '2099-01-01T00:00:00Z' },
    } }; } },
    fetch: async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      sent.push(String(init?.body)); throw new Error('Failed to fetch');
    },
  };
  return { ...f, native, guard, sent, options, advance: () => { now += 600_000; },
    movePrivate: () => f.api.put({ ...native, parentId: 'root-private' }) };
}

for (const type of ['create', 'change', 'move'] as const) {
  for (const when of ['before_admission', 'after_attempt_persist', 'inside_dispatch'] as const) {
    test(`never-sent ${type} observes a new private ancestor ${when}`, async () => {
      const f = await setup(type);
      try {
        const original = (await f.store.listQueue(scope))[0]!;
        assert.equal(original.attempt, undefined);
        if (when === 'before_admission') f.movePrivate();
        await createOutboundPushWorker({ ...f.options,
          ...(when === 'after_attempt_persist' ? { beforeDispatch: async () => { f.movePrivate(); } } : {}),
          ...(when === 'inside_dispatch' ? { dispatch: async (_row: QueueOperation, send: () => Promise<Response>) => {
            f.movePrivate(); return send();
          } } : {}),
        }).drain();
        assert.equal(f.sent.length, 0);
        const queued = await f.store.getQueueByOpId(scope, original.opId);
        assert.equal(queued?.status, 'rejected');
        assert.equal(queued?.sequence, original.sequence);
        assert.equal(queued?.digest, original.digest);
        assert.equal((await f.store.getEngineState(scope))?.recoveryFrozen ?? false, false);
      } finally { f.store.close(); }
    });
  }
}

test('a response-lost attempt stops at a withdrawn boundary and preserves exact evidence for reset', async () => {
  const f = await setup();
  try {
    await createOutboundPushWorker(f.options).drain();
    const original = (await f.store.listQueue(scope))[0]!;
    assert.equal(f.sent.length, 1);
    assert.equal(original.status, 'unknown');
    assert.ok(original.attempt);
    f.movePrivate(); f.advance(); f.store.close();
    const outcome = await createOutboundPushWorker({ ...f.options, allowRecoveryFrozenPush: () => true }).drain();
    assert.equal(outcome.outcome, 'recovery');
    const retained = await f.store.getQueueByOpId(scope, original.opId);
    assert.equal(retained?.status, 'blocked');
    assert.deepEqual(retained?.attempt, original.attempt);
    assert.equal(retained?.sequence, original.sequence);
    assert.equal(retained?.digest, original.digest);
    assert.equal(retained?.idempotencyKey, original.idempotencyKey);
    assert.equal((await f.store.getEngineState(scope))?.recoveryFrozen, true);
    await createOutboundPushWorker({ ...f.options, allowRecoveryFrozenPush: () => true }).drain();
    assert.equal(f.sent.length, 1, 'advanced recovery cannot bypass withdrawn upload consent');
    assert.equal(needsReplicaRebuild('upload_boundary_changed'), true);
    assert.equal(syncAttentionTerminalCode('upload_boundary_changed', undefined), 'upload_boundary_changed');
    assert.match(terminalFreezeReasonCopy('upload_boundary_changed'), /unconfirmed/);
  } finally { f.store.close(); }
});

test('a stopped mount rejects ordinary queued content while keeping it on the device', async () => {
  const f = await setup();
  try {
    await f.store.putMountBinding(scope, { mountId: 'chosen', nativeRootId: 'root-selected',
      remoteMountNodeId: 'selected-colp', status: 'detached', boundaryVersion: '2', materialized: false,
      rootRole: 'bookmarks-bar' });
    await createOutboundPushWorker(f.options).drain();
    assert.equal(f.sent.length, 0);
    assert.equal((await f.store.listQueue(scope))[0]?.status, 'rejected');
    assert.equal(f.api.node(f.native.id).title, f.native.title);
  } finally { f.store.close(); }
});

test('advanced create provenance checks the native source as well as its selected destination', async () => {
  const f = await setup();
  try {
    const planId = 'advanced-plan', stepId = 'advanced-step';
    await f.store.commitAdvancedPlan(scope, { planId, metadata: {}, now: 1_000,
      steps: [{ stepId, side: 'remote', action: 'create', source: { nativeId: f.native.id } }] });
    const original = (await f.store.listQueue(scope))[0]!;
    const opId = `ab.${digestJson({ planId, stepId }).slice(7)}`;
    f.movePrivate();
    await assert.rejects(f.guard({ ...original, opId }), /queued_upload_excluded/);
  } finally { f.store.close(); }
});

test('a never-published create is captured anew when its native returns to an authorized range', async () => {
  const f = await setup();
  try {
    const prior = (await f.store.listQueue(scope))[0]!;
    f.movePrivate();
    await createOutboundPushWorker(f.options).drain();
    assert.equal(await f.store.getMappingByNativeId(scope, f.native.id), null);
    f.api.put(f.native);
    await f.queue.recover();
    const retry = (await f.store.listQueue(scope, 'pending')).find(row => row.payload.type === 'create_node');
    assert.ok(retry);
    assert.notEqual(retry.opId, prior.opId);
    assert.ok(retry.sequence > prior.sequence);
    assert.equal(f.sent.length, 0);
  } finally { f.store.close(); }
});
