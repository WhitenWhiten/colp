import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { test } from 'vitest';
import { createBootstrapCoordinator } from '../src/bootstrap/coordinator.js';
import { bootstrapOpId } from '../src/bootstrap/matcher.js';
import { scope } from './bookmark-event-queue-harness.js';
import { setupBootstrapRace as setup } from './bootstrap-event-race-harness.js';

test.each(['event-first', 'bootstrap-first', 'concurrent'] as const)(
  'first-sync and a live create share one operation: %s', async order => {
    const { store, coordinator, resumed, queue, api, node } = await setup();
    try {
      if (order === 'bootstrap-first') await coordinator.resume(resumed);
      const capture = await queue.created(node.id, node);
      if (order === 'concurrent') await Promise.all([queue.flush(), coordinator.resume(resumed)]);
      else {
        await queue.flush();
        await coordinator.resume(resumed);
      }
      const rows = await store.listQueue(scope);
      assert.equal(rows.length, 1, 'one native bookmark must produce one server create');
      assert.equal(rows[0]!.opId, bootstrapOpId(resumed.confirmationId, 'create', node.id));
      assert.equal((await store.getBookmarkEvent(scope, capture.eventId!))?.opId, rows[0]!.opId);
      assert.equal((await coordinator.status()).phase, 'syncing', 'wait for the original create receipt');
      const create = rows[0]!;
      const lease = await store.acquireLease(scope, 'receipt-worker', 1, 30_000);
      await store.claimNextQueue(scope, 'receipt-worker', lease.fence, 1);
      await store.settleClaimedPush(scope, create.sequence, 'receipt-worker', lease.fence, {
        outcome: 'terminal', receipt: {
          opId: create.opId, operationDigest: create.digest, kind: 'terminal', receiptId: 'receipt-create',
          resultDigest: 'sha256:receipt', result: { results: [{ opId: create.opId, sequence: create.sequence,
            status: 'applied', targetId: 'remote-new', revision: 'server-r1' }] },
        }, authoritativeCreate: { nativeId: node.id, targetId: 'remote-new', revision: 'server-r1' },
      });
      assert.equal((await coordinator.resume(resumed))?.run.phase, 'completed');
      assert.equal((await store.listQueue(scope)).length, 1);
      assert.equal((await store.getMappingByNativeId(scope, node.id))?.colpId, 'remote-new');
      assert.equal((await store.getEngineState(scope))?.recoveryFrozen, undefined);
      assert.equal(api.node(node.id).id, node.id);
    } finally { store.close(); }
  });

for (const legacy of [false, true]) test.each(['change', 'move', 'remove'] as const)(
  `a first-sync successor waits for its original create receipt (legacy=${legacy}): %s`, async kind => {
    const { store, coordinator, resumed, queue, api, node } = await setup();
    try {
      await coordinator.resume(resumed);
      if (legacy) await store.deleteMapping(scope, node.id);
      let captured;
      if (kind === 'change') {
        api.put({ ...node, title: 'Edited before receipt' });
        captured = await queue.changed(node.id, { title: 'Edited before receipt' }, 'callback');
      } else if (kind === 'move') {
        api.put({ ...node, parentId: 'folder-parent' });
        captured = await queue.moved(node.id, { parentId: 'folder-parent', oldParentId: node.parentId, index: 0, oldIndex: 0 });
      } else {
        const get = api.get.bind(api), children = api.getChildren.bind(api);
        api.get = async id => { if (id === node.id) throw new Error("Can't find bookmark for id."); return get(id); };
        api.getChildren = async id => (await children(id)).filter(child => child.id !== node.id);
        captured = await queue.removed(node.id, { parentId: node.parentId, index: 0, node });
      }
      assert.equal(captured.outcome, 'staged');
      await queue.flush();
      assert.equal((await store.listQueue(scope)).length, 1, 'dependent work must wait for a canonical target');
      assert.equal((await store.listBookmarkEventsByStatus(scope, 'pending')).length, 1);
      assert.notEqual((await store.getEngineState(scope))?.recoveryFrozen, true);
      const create = (await store.listQueue(scope))[0]!;
      const lease = await store.acquireLease(scope, 'receipt-worker', 1, 30_000);
      await store.claimNextQueue(scope, 'receipt-worker', lease.fence, 1);
      await store.settleClaimedPush(scope, create.sequence, 'receipt-worker', lease.fence, {
        outcome: 'terminal', receipt: {
          opId: create.opId, operationDigest: create.digest, kind: 'terminal', receiptId: 'receipt-create',
          resultDigest: 'sha256:receipt', result: { results: [{ opId: create.opId, sequence: create.sequence,
            status: 'applied', targetId: 'remote-new', revision: 'server-r1' }] },
        }, authoritativeCreate: { nativeId: node.id, targetId: 'remote-new', revision: 'server-r1' },
      });
      await queue.flush();
      const rows = await store.listQueue(scope);
      assert.equal(rows.length, 2);
      assert.equal(rows[1]!.payload.type, kind === 'change' ? 'update_node_content' : kind === 'move' ? 'move_node' : 'delete_node');
      assert.equal(rows[1]!.payload.targetId, 'remote-new');
      assert.equal(rows[1]!.baseRevision, 'server-r1');
      assert.equal((await store.listBookmarkEventsByStatus(scope, 'pending')).length, 0);
    } finally { store.close(); }
  });

test('first-sync queue allocation and its provisional native identity roll back together', async () => {
  const { store, coordinator, resumed, node } = await setup();
  try {
    const crashing = createBootstrapCoordinator({ scope, store: { ...store,
      allocateSequenceAndEnqueue: (input, operation, options) => store.allocateSequenceAndEnqueue(input, operation,
        { ...options, fault: 'after_mapping' }),
    } });
    await assert.rejects(crashing.resume(resumed), /fault_injected/);
    assert.equal((await store.listQueue(scope)).length, 0);
    assert.equal(await store.getMappingByNativeId(scope, node.id), null);
    await coordinator.resume(resumed);
    const create = (await store.listQueue(scope))[0]!;
    assert.equal(create.sequence, 1);
    assert.equal((await store.getMappingByNativeId(scope, node.id))?.colpId, `pending-${create.opId}`);
  } finally { store.close(); }
});

test('deleting before the first-sync create is queued excludes the stale scan without stopping sync', async () => {
  const { store, coordinator, resumed, queue, node } = await setup();
  try {
    assert.equal((await queue.removed(node.id, { parentId: node.parentId, index: 0, node })).outcome, 'filtered');
    assert.equal((await store.listDeletionJournal(scope, node.id)).length, 1);
    const view = await coordinator.resume(resumed);
    assert.equal(view?.run.phase, 'completed');
    assert.equal((await store.listQueue(scope)).length, 0);
    assert.notEqual((await store.getEngineState(scope))?.recoveryFrozen, true);
  } finally { store.close(); }
});

test.each(['change', 'move'] as const)('captures an unmapped %s between planning and atomic queue allocation', async kind => {
  const { store, resumed, queue, api, node } = await setup();
  try {
    let captured = false;
    const racing = createBootstrapCoordinator({ scope, store: { ...store,
      allocateSequenceAndEnqueue: async (...args) => {
        if (!captured) {
          captured = true;
          if (kind === 'change') {
            api.put({ ...node, title: 'Before allocation' });
            assert.equal((await queue.changed(node.id, { title: 'Before allocation' }, 'callback')).outcome, 'staged');
          } else {
            api.put({ ...node, parentId: 'folder-parent' });
            assert.equal((await queue.moved(node.id, { parentId: 'folder-parent', oldParentId: node.parentId, index: 0, oldIndex: 0 })).outcome, 'staged');
          }
        }
        return store.allocateSequenceAndEnqueue(...args);
      },
    } });
    await racing.resume(resumed);
    assert.equal((await store.listBookmarkEventsByStatus(scope, 'pending'))[0]?.details.nativeMutation, true);
    const create = (await store.listQueue(scope))[0]!;
    const lease = await store.acquireLease(scope, 'receipt-worker', 1, 30_000);
    await store.claimNextQueue(scope, 'receipt-worker', lease.fence, 1);
    await store.settleClaimedPush(scope, create.sequence, 'receipt-worker', lease.fence, {
      outcome: 'terminal', receipt: {
        opId: create.opId, operationDigest: create.digest, kind: 'terminal', receiptId: 'receipt-create',
        resultDigest: 'sha256:receipt', result: { results: [{ opId: create.opId, sequence: create.sequence,
          status: 'applied', targetId: 'remote-new', revision: 'server-r1' }] },
      }, authoritativeCreate: { nativeId: node.id, targetId: 'remote-new', revision: 'server-r1' },
    });
    await queue.flush();
    const successor = (await store.listQueue(scope))[1]!;
    assert.equal(successor.payload.type, kind === 'change' ? 'update_node_content' : 'move_node');
    assert.equal(successor.payload.targetId, 'remote-new');
    assert.equal(successor.baseRevision, 'server-r1');
    assert.equal((await store.listBookmarkEventsByStatus(scope, 'pending')).length, 0);
  } finally { store.close(); }
});

test('an unmapped edit followed by deletion does not pin the first-sync inbox', async () => {
  const { store, coordinator, resumed, queue, api, node } = await setup();
  try {
    api.put({ ...node, title: 'Edited then deleted' });
    await queue.changed(node.id, { title: 'Edited then deleted' }, 'callback');
    const get = api.get.bind(api);
    api.get = async id => { if (id === node.id) throw new Error("Can't find bookmark for id."); return get(id); };
    await queue.removed(node.id, { parentId: node.parentId, index: 0, node });
    await queue.flush();
    assert.equal((await store.listBookmarkEventsByStatus(scope, 'pending')).length, 0);
    assert.equal((await coordinator.resume(resumed))?.run.phase, 'completed');
    assert.equal((await store.listQueue(scope)).length, 0);
  } finally { store.close(); }
});

test('a removal journal committed after planning prevents allocation without consuming a sequence', async () => {
  const { store, resumed, node } = await setup();
  try {
    const racing = createBootstrapCoordinator({ scope, store: { ...store,
      allocateSequenceAndEnqueue: async (...args) => {
        await store.putDeletionJournal(scope, { nativeId: node.id, parentNativeId: node.parentId, kind: 'bookmark', ordinal: 1 });
        return store.allocateSequenceAndEnqueue(...args);
      },
    } });
    await racing.resume(resumed);
    assert.equal((await store.listQueue(scope)).length, 0);
    assert.equal(await store.getMappingByNativeId(scope, node.id), null);
  } finally { store.close(); }
});
