import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { test } from 'vitest';
import { readOpenSyncIssues } from '../src/sync-issues.js';
import { installKns05IndexedDb, scope } from './kns-05-pull-harness.js';
import { rejectedOrderFixture, rejectQueueRow, acceptQueueRow, applyMoveEcho } from './rejoin-rejected-harness.js';
import { deletionFixture } from './rejoin-decision-harness.js';
import { rejoinResolutionId } from '../src/sync-state/rejoin-queue-resolution.js';
import { validateOperation } from '../src/bookmark-event-codec.js';
import { assertQueuedUploadAllowed } from '../src/queued-upload-boundary.js';
import { COLP_QUEUE_STAMP } from '../src/colp-queue-stamp.js';

installKns05IndexedDb();

test('a rejected multi-move order stays visible through a fresh accepted decision and closes only after native completion', async () => {
  const f = await rejectedOrderFixture();
  try {
    await f.compare(); assert.equal((await f.list()).length, 1);
    const first = await f.resolve('keep_local_order');
    const rows = await f.getStore().listQueue(scope);
    assert.ok(rows.length >= 2, JSON.stringify(rows));
    for (const row of rows) await rejectQueueRow(f.getStore(), row);
    const originals = await f.getStore().listQueue(scope);
    const receipts = await Promise.all(rows.map(row => f.getStore().getQueueReceipt(scope, row.sequence)));
    await f.refresh();
    const [retry] = await f.list(); assert.ok(retry); assert.notEqual(retry.commandId, first.commandId);
    assert.equal((await readOpenSyncIssues(f.getStore(), scope)).queue.length, rows.length);
    await assert.rejects(f.resolve('keep_remote_order', { crash: at => {
      if (at === 'after_rejoin_confirmation') throw new Error('worker_crash');
    } }), /worker_crash/);
    assert.equal((await readOpenSyncIssues(f.getStore(), scope)).queue.length, rows.length);
    f.reopen(); await f.refresh();
    assert.deepEqual((await f.api.getChildren('native-root')).map(row => row.id), ['native-c', 'native-d', 'native-a', 'native-b']);
    assert.equal((await f.list()).length, 0);
    assert.equal((await f.getStore().getMountBinding(scope, 'mount-bar'))?.status, 'active');
    assert.equal((await readOpenSyncIssues(f.getStore(), scope)).queue.length, 0);
    assert.deepEqual(await f.getStore().listQueue(scope), originals);
    assert.deepEqual(await Promise.all(rows.map(row => f.getStore().getQueueReceipt(scope, row.sequence))), receipts);
    await f.queue().recover(); assert.deepEqual(await f.getStore().listQueue(scope), originals);
  } finally { f.getStore().close(); }
});

test('retrying the browser order is authorized only past its own refusals and waits for every real Pull echo', async () => {
  const f = await rejectedOrderFixture();
  try {
    await f.compare(); await f.resolve('keep_local_order');
    const first = await f.getStore().listQueue(scope);
    for (const row of first) await rejectQueueRow(f.getStore(), row);
    const originals = await f.getStore().listQueue(scope);
    await f.refresh(); const retry = await f.resolve('keep_local_order');
    const replacement = (await f.getStore().listQueue(scope)).filter(row => !first.some(old => old.opId === row.opId));
    assert.ok(replacement.length >= 2);
    assert.ok(replacement.every(row => row.status === 'pending'));
    assert.equal((await readOpenSyncIssues(f.getStore(), scope)).queue.length, first.length);
    await assert.rejects(f.getStore().completeRejoinDecision(scope, retry.commandId), /rejoin_dependency_pending/);
    for (const row of replacement) await acceptQueueRow(f.getStore(), row);
    await f.refresh(); assert.equal((await readOpenSyncIssues(f.getStore(), scope)).queue.length, first.length);
    for (const row of replacement.slice(0, -1)) await applyMoveEcho(f, row);
    await f.refresh(); assert.equal((await readOpenSyncIssues(f.getStore(), scope)).queue.length, first.length);
    assert.equal((await f.getStore().getScopeCommandPlan(scope, retry.commandId))?.phase, 'applying');
    f.reopen(); await applyMoveEcho(f, replacement.at(-1)!);
    f.setRemote(['d', 'c', 'b', 'a']); await f.refresh();
    assert.equal((await f.getStore().getScopeCommandPlan(scope, retry.commandId))?.phase, 'active');
    assert.equal((await readOpenSyncIssues(f.getStore(), scope)).queue.length, 0);
    for (const row of originals) assert.deepEqual(await f.getStore().getQueueByOpId(scope, row.opId), row);
    assert.ok((await f.getStore().listQueue(scope)).filter(row => replacement.some(newRow => row.opId === newRow.opId))
      .every(row => row.echoApplied));
  } finally { f.getStore().close(); }
});

test('a refused delete can be retried, then restored after another refusal without an invented ACK', async () => {
  const f = await deletionFixture();
  try {
    await f.compare(); await f.resolve('delete_remote');
    const [first] = await f.getStore().listQueue(scope); assert.ok(first);
    assert.equal(validateOperation(first.payload), true);
    await assertQueuedUploadAllowed({ store: f.getStore(), scope, queue: first,
      parentOf: async id => (await f.api.get(id))[0]?.parentId });
    await rejectQueueRow(f.getStore(), first); await f.refresh();
    await f.resolve('delete_remote');
    const retry = (await f.getStore().listQueue(scope)).find(row => row.opId !== first.opId); assert.ok(retry);
    assert.equal(retry.status, 'pending'); await rejectQueueRow(f.getStore(), retry);
    const originals = await f.getStore().listQueue(scope); const receipts = (await f.getStore().exportScope(scope)).receipts;
    await f.refresh(); await assert.rejects(f.resolve('keep_remote', { crash: at => {
      if (at === 'after_rejoin_restore_preparation') throw new Error('worker_crash');
    } }), /worker_crash/);
    assert.equal((await readOpenSyncIssues(f.getStore(), scope)).queue.length, 2);
    f.reopen(); await f.refresh();
    assert.equal((await readOpenSyncIssues(f.getStore(), scope)).queue.length, 0);
    assert.equal((await f.getStore().getMountBinding(scope, 'mount-bar'))?.status, 'active');
    assert.deepEqual(await f.getStore().listQueue(scope), originals);
    assert.deepEqual((await f.getStore().exportScope(scope)).receipts, receipts);
    const restored = (await f.getStore().getMappingByColpId(scope, 'restore-folder'))!;
    assert.equal((await f.api.getChildren(restored.nativeId)).length, 2);
  } finally { f.getStore().close(); }
});

test('recovery never rolls back a later local revision or closes a newer issue on the same bookmark', async () => {
  const f = await rejectedOrderFixture();
  try {
    await f.compare(); await f.resolve('keep_local_order');
    const first = await f.getStore().listQueue(scope);
    for (const row of first) await rejectQueueRow(f.getStore(), row);
    await f.refresh();
    await assert.rejects(f.resolve('keep_remote_order', { crash: at => {
      if (at === 'after_rejoin_intent') throw new Error('worker_crash');
    } }), /worker_crash/);
    const target = (await f.getStore().getMappingByColpId(scope, String(first[0]!.payload.targetId)))!;
    await f.api.update(target.nativeId, { title: 'New work after the refusal' });
    await f.queue().changed(target.nativeId, { title: 'New work after the refusal' }); await f.queue().flush();
    const newer = (await f.getStore().listQueue(scope)).find(row => !first.some(old => old.opId === row.opId));
    assert.ok(newer); assert.equal(newer.status, 'set_aside');
    const protectedMapping = await f.getStore().getMappingByNativeId(scope, target.nativeId);
    assert.equal(protectedMapping?.projection.revision, newer.operationRevision);
    f.reopen(); await f.refresh();
    assert.deepEqual(await f.getStore().getMappingByNativeId(scope, target.nativeId), protectedMapping);
    assert.equal((await f.api.get(target.nativeId))[0]?.title, 'New work after the refusal');
    assert.deepEqual((await readOpenSyncIssues(f.getStore(), scope)).queue.map(row => row.opId), [newer.opId]);
  } finally { f.getStore().close(); }
});

test('successful recovery closes its own refusals and preserves an unrelated rejection and its receipt', async () => {
  const f = await deletionFixture();
  try {
    await f.compare(); await f.resolve('delete_remote');
    const [first] = await f.getStore().listQueue(scope); assert.ok(first); await rejectQueueRow(f.getStore(), first);
    const { scopeKey: _key, sequence: _sequence, ...template } = first;
    const opId = crypto.randomUUID();
    const unrelated = await f.getStore().allocateSequenceAndEnqueue(scope, { ...template,
      opId, idempotencyKey: opId, batchId: opId, digest: 'sha256:unrelated', payload: { ...first.payload,
        opId, targetId: 'unrelated-node', payload: { reason: 'browser_event' } } }, COLP_QUEUE_STAMP);
    await rejectQueueRow(f.getStore(), unrelated);
    const original = await f.getStore().getQueueByOpId(scope, unrelated.opId);
    const receipt = await f.getStore().getQueueReceipt(scope, unrelated.sequence);
    await f.refresh(); await f.resolve('keep_remote'); f.reopen(); await f.refresh();
    assert.deepEqual((await readOpenSyncIssues(f.getStore(), scope)).queue, [original]);
    assert.deepEqual(await f.getStore().getQueueReceipt(scope, unrelated.sequence), receipt);
    assert.notEqual(original?.echoApplied, true);
  } finally { f.getStore().close(); }
});

test('a changed cloud order refreshes a rejected preview and an already matching order remains resolvable', async () => {
  const f = await rejectedOrderFixture();
  try {
    await f.compare(); await f.resolve('keep_local_order');
    for (const row of await f.getStore().listQueue(scope)) await rejectQueueRow(f.getStore(), row);
    await f.refresh(); const [prior] = await f.list(); assert.ok(prior);
    f.setRemote(['d', 'c', 'b', 'a']);
    await assert.rejects(f.resolve('keep_remote_order'), /preview_stale/);
    const [updated] = await f.list(); assert.ok(updated); assert.notEqual(updated.token, prior.token);
    assert.equal(updated.commandId, prior.commandId);
    await f.resolve('keep_remote_order');
    assert.equal((await readOpenSyncIssues(f.getStore(), scope)).queue.length, 0);
    assert.equal((await f.getStore().getMountBinding(scope, 'mount-bar'))?.status, 'active');
  } finally { f.getStore().close(); }
});

test('a mismatched projection digest fails the recovery CAS without touching mappings or clearing refusals', async () => {
  const f = await rejectedOrderFixture();
  try {
    await f.compare(); await f.resolve('keep_local_order');
    const first = await f.getStore().listQueue(scope);
    for (const row of first) await rejectQueueRow(f.getStore(), row);
    await f.refresh();
    const mapping = (await f.getStore().getMappingByColpId(scope, String(first[0]!.payload.targetId)))!;
    const { scopeKey: _key, ...original } = mapping;
    await f.getStore().putMapping(scope, { ...original, projection: { ...mapping.projection, digest: 'sha256:changed' } });
    const before = await f.getStore().listMappings(scope); const calls = f.api.calls.length;
    await f.resolve('keep_remote_order');
    assert.deepEqual(await f.getStore().listMappings(scope), before); assert.equal(f.api.calls.length, calls);
    assert.equal((await readOpenSyncIssues(f.getStore(), scope)).queue.length, first.length);
  } finally { f.getStore().close(); }
});

test('warning resolution binds scope, opId, sequence and digest and never hides another rejection', async () => {
  const f = await rejectedOrderFixture();
  try {
    await f.compare(); await f.resolve('keep_local_order');
    const rows = await f.getStore().listQueue(scope);
    for (const row of rows) await rejectQueueRow(f.getStore(), row);
    const originals = await f.getStore().listQueue(scope); const [first] = originals; assert.ok(first);
    const db = await f.getStore().open();
    for (const change of [{ scopeKey: 'another-scope' }, { opId: 'another-op' }, { sequence: first.sequence + 1 }, { digest: 'wrong' }]) {
      const tx = db.transaction('diagnostics', 'readwrite');
      tx.objectStore('diagnostics').put({ id: rejoinResolutionId(first.scopeKey, first.opId),
        kind: 'rejoin_queue_resolution', scopeKey: first.scopeKey, opId: first.opId,
        sequence: first.sequence, digest: first.digest, ...change });
      await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); });
      assert.deepEqual(await f.getStore().filterResolvedQueueIssues(scope, originals), originals);
    }
    await f.refresh(); await f.resolve('keep_remote_order');
    assert.equal((await readOpenSyncIssues(f.getStore(), scope)).queue.length, 0);
    assert.deepEqual(await f.getStore().listQueue(scope), originals);
  } finally { f.getStore().close(); }
});

test('a resolution diagnostic cannot settle an upload that still has no terminal outcome', async () => {
  const f = await rejectedOrderFixture();
  try {
    await f.compare(); await f.resolve('keep_local_order');
    const originals = await f.getStore().listQueue(scope), first = originals[0]!;
    assert.equal(first.status, 'pending'); assert.equal(await f.getStore().getQueueReceipt(scope, first.sequence), null);
    const tx = (await f.getStore().open()).transaction('diagnostics', 'readwrite');
    tx.objectStore('diagnostics').put({ id: rejoinResolutionId(first.scopeKey, first.opId),
      kind: 'rejoin_queue_resolution', scopeKey: first.scopeKey, opId: first.opId,
      sequence: first.sequence, digest: first.digest });
    await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); });
    assert.deepEqual(await f.getStore().filterResolvedQueueIssues(scope, originals), originals);
    assert.deepEqual(await f.getStore().listQueue(scope), originals);
    assert.equal(await f.getStore().getQueueReceipt(scope, first.sequence), null);
  } finally { f.getStore().close(); }
});

test('bounded queue pages retain ordering, scope, detached values and validated refusal receipts', async () => {
  const f = await rejectedOrderFixture();
  try {
    await f.compare(); await f.resolve('keep_local_order');
    const store = f.getStore(), originals = await store.listQueue(scope), first = originals[0]!;
    assert.ok(originals.length > 1);
    await rejectQueueRow(store, first);
    const [refusal] = await store.listQueue(scope, 'terminal', 0, 1);
    assert.equal(refusal?.opId, first.opId); assert.equal(refusal?.recovery?.resultStatus, 'rejected');
    assert.equal(refusal?.digest, first.digest); assert.deepEqual(refusal?.payload, first.payload);
    assert.deepEqual((await store.listQueue(scope, undefined, first.sequence, 1)).map(row => row.sequence), [originals[1]!.sequence]);
    assert.deepEqual(await store.listQueue({ ...scope, accountId: 'different-account' }), []);
    assert.deepEqual(await store.listQueue(scope, undefined, Number.MAX_SAFE_INTEGER), []);
    await assert.rejects(store.listQueue(scope, undefined, 0, 1_001), /limit_exceeded/);
    await assert.rejects(store.listQueue(scope, undefined, 0, 0), /unsafe_integer/);
    Object.assign(refusal!.payload, { targetId: 'caller-mutated' });
    assert.deepEqual((await store.listQueue(scope, 'terminal'))[0]!.payload, first.payload);
    // A bulk request cannot bypass the codec, including on a terminal row.
    const tx = (await store.open()).transaction('outbound_queue', 'readwrite');
    tx.objectStore('outbound_queue').put({ ...refusal, digest: '' });
    await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); });
    await assert.rejects(store.listQueue(scope, 'terminal'), /bounded_string_invalid/);
    assert.equal((await store.listQueue(scope, undefined, first.sequence, 1))[0]?.opId, originals[1]!.opId);
  } finally { f.getStore().close(); }
});
