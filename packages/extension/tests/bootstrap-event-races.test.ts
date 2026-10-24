import { subtreeDeleteSource } from '@know-n/colp/sync/canonical';
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createBookmarkEventQueue } from '../src/bookmark-event-queue.js';
import type { JsonObject } from '../src/sync-state-store.js';
import { bookmark, mapping, scope } from './bookmark-event-queue-harness.js';
import { allocateWithMutation, setupBootstrapRace, settleNext, updateValue } from './bootstrap-event-race-harness.js';

for (const field of ['title', 'url'] as const) test(`an unmapped ${field} edit followed by a revert survives receipts and restart`, async () => {
  const f = await setupBootstrapRace();
  try {
    const intermediate = field === 'title' ? 'Intermediate' : 'https://example.test/intermediate';
    await allocateWithMutation(f, async () => {
      f.api.put({ ...f.node, [field]: intermediate });
      assert.equal((await f.queue.changed(f.node.id, { [field]: intermediate }, 'callback')).outcome, 'staged');
    });
    // Recreate the queue as a worker restart would; pending native edits must be its working state.
    const queue = createBookmarkEventQueue({ scope, store: f.store, api: f.api, autoFlush: false });
    f.api.put(f.node);
    assert.equal((await queue.changed(f.node.id, { [field]: f.node[field] }, 'callback')).outcome, 'staged');
    await queue.flush();
    assert.equal((await f.store.listQueue(scope)).length, 1, 'the create must settle first');
    await settleNext(f, 'created-r1');
    await queue.flush();
    const edit = await settleNext(f, 'edited-r2');
    assert.deepEqual(updateValue(edit.payload), { [field]: intermediate });
    await queue.flush();
    const revert = await settleNext(f, 'reverted-r3');
    assert.deepEqual((revert.payload.payload as JsonObject).base, { [field]: intermediate });
    assert.deepEqual(updateValue(revert.payload), { [field]: f.node[field] });
    assert.equal(revert.baseRevision, 'edited-r2');
    await queue.flush();
    assert.equal((await f.store.getMappingByNativeId(scope, f.node.id))?.projection.content?.[field], f.node[field]);
    assert.equal((await f.store.listBookmarkEventsByStatus(scope, 'pending')).length, 0);
  } finally { f.store.close(); }
});

test('an edit already included in the scan retains the receipt needed by its successor', async () => {
  const f = await setupBootstrapRace();
  try {
    f.api.put({ ...f.node, title: 'Included by scan' });
    await f.queue.changed(f.node.id, { title: 'Included by scan' }, 'callback');
    await f.coordinator.resume(f.resumed);
    const create = (await f.store.listQueue(scope))[0]!;
    assert.equal(((create.payload.payload as JsonObject).node as JsonObject).title, 'Included by scan');
    f.api.put({ ...f.node, title: 'Final title' });
    await f.queue.changed(f.node.id, { title: 'Final title' }, 'callback');
    await settleNext(f, 'created-r1');
    await f.queue.flush();
    await settleNext(f, 'equivalent-r2', 'rebased');
    await f.queue.flush();
    const final = await settleNext(f, 'final-r3');
    assert.deepEqual(updateValue(final.payload), { title: 'Final title' });
    assert.equal(final.baseRevision, 'equivalent-r2');
    assert.equal((await f.store.listBookmarkEventsByStatus(scope, 'pending')).length, 0);
  } finally { f.store.close(); }
});

for (const anchor of ['mapped', 'pending', 'missing'] as const) for (const position of ['before', 'after'] as const)
  test(`an unmapped move resolves its ${position} ${anchor} sibling through queueing`, async () => {
  const f = await setupBootstrapRace();
  try {
    const index = position === 'before' ? 0 : 1;
    const sibling = bookmark('sibling', 'folder-parent', 1 - index, 'Sibling', 'https://example.test/sibling');
    f.api.put(sibling);
    const children = f.api.getChildren.bind(f.api);
    f.api.getChildren = async id => [...await children(id)].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    if (anchor === 'mapped') await mapping(f.store, sibling.id, 'sibling-colp', 'root-selected', 'sibling-r1',
      { title: sibling.title, url: sibling.url }, 'folder-parent');
    if (anchor === 'pending') await f.queue.created(sibling.id, sibling);
    await allocateWithMutation(f, async () => {
      f.api.put({ ...f.node, parentId: 'folder-parent', index });
      await f.queue.moved(f.node.id, { parentId: 'folder-parent', oldParentId: f.node.parentId, index, oldIndex: 0 });
    });
    await settleNext(f, 'created-r1');
    await f.queue.flush();
    if (anchor === 'pending') {
      const queued = await f.store.listQueue(scope);
      assert.deepEqual(queued.map(row => row.payload.type), ['create_node', 'create_node'], 'wait for the live sibling create');
      await settleNext({ ...f, node: sibling }, 'sibling-r1', 'applied', 'sibling-colp');
      await f.queue.flush();
    }
    const move = await settleNext(f, 'moved-r2');
    assert.equal(move.payload.type, 'move_node');
    const payload = move.payload.payload as JsonObject;
    if (anchor === 'missing') {
      // Without a mapping or live create, the neighbour cannot release a wait.
      assert.equal(payload.beforeId, undefined);
      assert.equal(payload.afterId, undefined);
    } else assert.equal(payload[`${position}Id`], 'sibling-colp');
    assert.equal((await f.store.getMappingByNativeId(scope, f.node.id))?.parentNativeId, 'folder-parent');
  } finally { f.store.close(); }
});

for (const phase of ['completed', 'needs_attention', 'later-run'] as const) test(`late create callbacks retain their original operation after ${phase}`, async () => {
  const f = await setupBootstrapRace();
  try {
    await f.coordinator.resume(f.resumed);
    const create = await settleNext(f, 'created-r1');
    await f.coordinator.resume(f.resumed);
    const run = (await f.store.listBootstrapRuns(scope))[0]!;
    if (phase === 'needs_attention') await f.store.putBootstrapRun(scope, { ...run, phase });
    if (phase === 'later-run') await f.store.putBootstrapRun(scope, { ...run, runId: 'later-run',
      confirmationId: 'later-confirmation', phase: 'matching', updatedAt: run.updatedAt + 1 });
    const originalMapping = await f.store.getMappingByNativeId(scope, f.node.id);
    const queue = createBookmarkEventQueue({ scope, store: f.store, api: f.api, autoFlush: false });
    const callback = await queue.created(f.node.id, f.node);
    await queue.flush();
    assert.equal((await f.store.listQueue(scope)).length, 1);
    assert.equal((await f.store.getBookmarkEvent(scope, callback.eventId!))?.opId, create.opId);
    assert.deepEqual(await f.store.getMappingByNativeId(scope, f.node.id), originalMapping);
    assert.equal((await f.store.listBookmarkEventsByStatus(scope, 'pending')).length, 0);
  } finally { f.store.close(); }
});

test('one flush settles sibling create callbacks whose bootstrap uploads are already confirmed', async () => {
  const f = await setupBootstrapRace();
  try {
    const nodes = [f.node, ...Array.from({ length: 5 }, (_, index) => bookmark(`sibling-${index}`, 'root-selected',
      index + 1, `Sibling ${index}`, `https://example.test/sibling/${index}`))];
    for (const node of nodes) f.api.put(node);
    const input = { ...f.resumed, localFacts: nodes.map(node => ({ nativeId: node.id, parentNativeId: node.parentId,
      mountNativeRootId: 'root-selected', kind: 'bookmark' as const, title: node.title, url: node.url })) };
    await f.coordinator.resume(input);
    const lease = await f.store.acquireLease(scope, 'sibling-worker', 1, 30_000);
    const creates = await f.store.listQueue(scope);
    for (const node of nodes) {
      const row = await f.store.claimNextQueue(scope, 'sibling-worker', lease.fence, 1);
      assert.ok(row);
      const targetId = `remote-${node.id}`, revision = `rev-${node.id}`;
      await f.store.settleClaimedPush(scope, row.sequence, 'sibling-worker', lease.fence, {
        outcome: 'terminal', receipt: { opId: row.opId, operationDigest: row.digest, kind: 'terminal',
          receiptId: `receipt-${row.opId}`, resultDigest: 'sha256:receipt', result: { results: [{
            opId: row.opId, sequence: row.sequence, status: 'applied', targetId, revision,
          }] } }, authoritativeCreate: { nativeId: node.id, targetId, revision },
      });
    }
    await f.coordinator.resume(input);
    const before = await f.store.listMappings(scope);
    const callbacks = [];
    for (const node of nodes) callbacks.push(await f.queue.created(node.id, node));
    // An extension reload must also settle a backlog persisted by the old worker.
    const restarted = createBookmarkEventQueue({ scope, store: f.store, api: f.api, autoFlush: false });
    await restarted.flush();
    assert.equal((await f.store.listBookmarkEventsByStatus(scope, 'pending')).length, 0);
    assert.deepEqual(await f.store.listMappings(scope), before);
    assert.equal((await f.store.listQueue(scope)).length, creates.length);
    for (let index = 0; index < nodes.length; index++) {
      assert.equal((await f.store.getBookmarkEvent(scope, callbacks[index]!.eventId!))?.opId, creates[index]!.opId);
    }
  } finally { f.store.close(); }
});

test.each(['absent', 'replaced', 'tombstoned'] as const)('historical bootstrap creates do not claim a native with %s ownership', async state => {
  const f = await setupBootstrapRace();
  try {
    await f.coordinator.resume(f.resumed); await settleNext(f, 'created-r1'); await f.coordinator.resume(f.resumed);
    if (state === 'absent') await f.store.deleteMapping(scope, f.node.id);
    else if (state === 'replaced') {
      const { scopeKey: _scopeKey, ...original } = (await f.store.getMappingByNativeId(scope, f.node.id))!;
      await f.store.deleteMapping(scope, f.node.id);
      await f.store.putMapping(scope, { ...original, colpId: 'another-colp' });
    } else await f.store.putRemoteObservation(scope, { colpId: 'remote-new', remoteRevision: 'deleted-r2',
      cursor: 'deleted-cursor', kind: 'tombstone', payload: {}, sourceDigest: 'sha256:deleted', observedAt: 1 });
    await f.queue.created(f.node.id, f.node); await f.queue.flush();
    assert.equal((await f.store.listQueue(scope)).length, 2);
  } finally { f.store.close(); }
});

for (const kind of ['change', 'move', 'remove'] as const) test(`later range bootstrap captures an unmapped ${kind} with onboarding completed`, async () => {
  const f = await setupBootstrapRace();
  try {
    await f.store.setFirstRun(scope, 'completed');
    await allocateWithMutation(f, async () => {
      if (kind === 'change') {
        f.api.put({ ...f.node, title: 'Range edit' });
        assert.equal((await f.queue.changed(f.node.id, { title: 'Range edit' }, 'callback')).outcome, 'staged');
      } else if (kind === 'move') {
        f.api.put({ ...f.node, parentId: 'folder-parent' });
        assert.equal((await f.queue.moved(f.node.id, { parentId: 'folder-parent', oldParentId: f.node.parentId,
          index: 0, oldIndex: 0 })).outcome, 'staged');
      } else {
        assert.equal((await f.queue.removed(f.node.id, { parentId: f.node.parentId, index: 0, node: f.node })).outcome, 'filtered');
      }
    });
    assert.equal((await f.store.getScope(scope))?.firstRun, 'completed');
    if (kind === 'remove') assert.equal((await f.store.listQueue(scope)).length, 0);
    else {
      await settleNext(f, 'created-r1'); await f.queue.flush();
      const edit = await settleNext(f, 'edited-r2');
      assert.equal(edit.payload.type, kind === 'change' ? 'update_node_content' : 'move_node');
    }
    assert.notEqual((await f.store.getEngineState(scope))?.recoveryFrozen, true);
  } finally { f.store.close(); }
});

test('deleting a mapped bootstrap native drains its unmapped edit and revert predecessors', async () => {
  const f = await setupBootstrapRace();
  try {
    await allocateWithMutation(f, async () => {
      f.api.put({ ...f.node, title: 'Intermediate' });
      await f.queue.changed(f.node.id, { title: 'Intermediate' }, 'callback');
    });
    f.api.put(f.node);
    await f.queue.changed(f.node.id, { title: f.node.title }, 'callback');
    const get = f.api.get.bind(f.api);
    f.api.get = async id => { if (id === f.node.id) throw new Error("Can't find bookmark for id."); return get(id); };
    await f.queue.removed(f.node.id, { parentId: f.node.parentId, index: 0, node: f.node });
    await settleNext(f, 'created-r1'); await f.queue.flush();
    assert.deepEqual(updateValue((await settleNext(f, 'edited-r2')).payload), { title: 'Intermediate' });
    await f.queue.flush(); await settleNext(f, 'reverted-r3');
    await f.queue.flush();
    const removal = await settleNext(f, 'deleted-r4');
    assert.equal(removal.payload.type, 'delete_node');
    assert.equal(removal.baseRevision, 'reverted-r3');
    assert.equal(await f.store.getMappingByNativeId(scope, f.node.id), null);
    assert.equal((await f.store.listBookmarkEventsByStatus(scope, 'pending')).length, 0);
  } finally { f.store.close(); }
});

test('subtree deletion waits for the captured unmapped child edit receipt', async () => {
  const f = await setupBootstrapRace();
  try {
    const node = { ...f.node, parentId: 'folder-parent' };
    f.api.put(node);
    await allocateWithMutation({ ...f, resumed: { ...f.resumed,
      localFacts: f.resumed.localFacts.map(fact => ({ ...fact, parentNativeId: 'folder-parent' })) } }, async () => {
      f.api.put({ ...node, title: 'Edited child' });
      await f.queue.changed(node.id, { title: 'Edited child' }, 'callback');
    });
    await f.queue.removed('folder-parent', { parentId: 'root-selected', index: 0,
      node: { id: 'folder-parent', title: 'Parent', type: 'folder', children: [node] } });
    await settleNext(f, 'created-r1'); await f.queue.flush();
    assert.equal((await f.store.listQueue(scope)).length, 2, 'delete waits for the child update');
    await settleNext(f, 'child-r2'); await f.queue.flush();
    const removal = (await f.store.listQueue(scope))[2]!;
    assert.equal(removal.payload.type, 'delete_subtree');
    assert.deepEqual(removal.payload.source, subtreeDeleteSource('folder-colp', [
      { id: 'folder-colp', revision: 'folder-revision-2' }, { id: 'remote-new', revision: 'child-r2' },
    ]));
    assert.equal((await f.store.listBookmarkEventsByStatus(scope, 'pending')).length, 0);
  } finally { f.store.close(); }
});
