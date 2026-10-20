import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBDatabase, IDBObjectStore } from 'fake-indexeddb';
import { afterEach, test, vi } from 'vitest';
import { canonicalOperationDigest } from '@know-n/colp/sync';
import { createOutboundPushWorker } from '../src/outbound-push-worker.js';
import { readOpenSyncIssues } from '../src/sync-issues.js';
import { createSyncStateStore } from '../src/sync-state-store.js';
import { runTransaction } from '../src/sync-state/idb.js';
import { STORES } from '../src/sync-state/schema.js';
import { validateQueueRecord } from '../src/sync-state/queue-validate.js';
import { installOutboundPushIndexedDb, indexedDB, setup, scope, json } from './outbound-push-worker-harness.js';

installOutboundPushIndexedDb();
afterEach(() => vi.restoreAllMocks());

async function rejected() {
  const f = await setup();
  await createOutboundPushWorker({ ...f.options, fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    return json(200, { batchId: body.batchId, results: [{ opId: f.queued.opId, sequence: 1,
      status: 'rejected', code: 'resource_id_unavailable', warnings: [] }], serverCursor: 'cursor-1' });
  } }).drain();
  assert.equal((await f.store.getQueueReceipt(scope, 1))?.kind, 'terminal');
  return f;
}

test('completed adoption reads no writes and preserves the actual rejected attempt and receipt', async () => {
  const f = await rejected();
  try {
    const row = await f.store.getQueueByOpId(scope, f.queued.opId);
    const receipt = await f.store.getQueueReceipt(scope, 1);
    const transactions = vi.spyOn(IDBDatabase.prototype, 'transaction');
    for (let i = 0; i < 3; i++) assert.deepEqual(await f.store.listConsumedQueueIssues(scope), [row]);
    assert.equal(transactions.mock.calls.filter(([, mode]) => mode === 'readwrite').length, 0);
    assert.equal(transactions.mock.calls.length, 3, 'marker and rejection facts share one fresh transaction');
    transactions.mockRestore();
    assert.deepEqual(await f.store.getQueueByOpId(scope, f.queued.opId), row);
    assert.deepEqual(await f.store.getQueueReceipt(scope, 1), receipt);
  } finally { f.store.close(); }
});

test('another connection can resume newly incomplete adoption without stale completion or duplicate writes', async () => {
  const f = await rejected();
  const second = createSyncStateStore({ indexedDB });
  try {
    const row = (await f.store.getQueueByOpId(scope, f.queued.opId))!;
    const receipt = await f.store.getQueueReceipt(scope, 1);
    assert.deepEqual(await f.store.listConsumedQueueIssues(scope), [row]);
    assert.deepEqual(await second.listConsumedQueueIssues(scope), [row]);
    await runTransaction(await f.store.open(), [STORES.metadata, STORES.diagnostics, STORES.queue], 'readwrite', async tx => {
      // Model an unfinished legacy projection using a real saved receipt.
      // No successful transport outcome or terminal receipt is manufactured.
      const { recovery: _recovery, ...legacy } = row;
      tx.objectStore(STORES.queue).put(legacy);
      tx.objectStore(STORES.diagnostics).delete(`push-rejection:${row.scopeKey}:${row.opId}`);
      tx.objectStore(STORES.metadata).put({ key: `consumed-rejections-v1:${row.scopeKey}`, after: 0, complete: false });
    });
    const puts = vi.spyOn(IDBObjectStore.prototype, 'put');
    const [first, concurrent] = await Promise.all([
      f.store.listConsumedQueueIssues(scope), second.listConsumedQueueIssues(scope),
    ]);
    assert.deepEqual(first, [row]); assert.deepEqual(concurrent, [row]);
    assert.equal(puts.mock.calls.filter(([value]) => value.kind === 'push_rejection').length, 1,
      'the write transaction rechecks completion after a competing reader adopted the same receipt');
    puts.mockRestore();
    f.store.close(); second.close();
    assert.deepEqual(await second.listConsumedQueueIssues(scope), [row]);
    assert.deepEqual(await second.getQueueReceipt(scope, 1), receipt);
  } finally { f.store.close(); second.close(); }
});

test('the readonly fast path retains missing and diagnostic-read-only scope failures', async () => {
  const f = await setup();
  try {
    assert.deepEqual(await f.store.listConsumedQueueIssues(scope), []);
    await assert.rejects(f.store.listConsumedQueueIssues({ ...scope, generation: 2 }), /scope_not_found/u);
    await f.store.injectCorruptionForTest('orphan_receipt', scope);
    await assert.rejects(f.store.auditIntegrity(), /corruption_detected/u);
    await assert.rejects(f.store.listConsumedQueueIssues(scope), /diagnostic_read_only/u);
  } finally { f.store.close(); }
});

test.each(['retired', 'removed'] as const)('a completed marker does not keep %s scope authority readable', async state => {
  const f = await setup();
  try {
    const { scopeKey: _key, ...record } = (await f.store.getScope(scope))!;
    if (state === 'retired') await f.store.registerScope({ ...record, lifecycle: 'retired' });
    else await f.store.retireScope(scope, { retiredAt: 10_000, reason: 'user_reset' });
    f.store.close();
    const expected = state === 'retired' ? /scope_retired/u : /scope_not_found/u;
    await assert.rejects(f.store.listConsumedQueueIssues(scope), expected);
    await assert.rejects(readOpenSyncIssues(f.store, scope), expected);
  } finally { f.store.close(); }
});

test('parallel status scans complete all raw pages before filtering excluded or settled history', async () => {
  const f = await setup();
  try {
    const excluded = new Set<string>();
    const expected: string[] = [];
    await runTransaction(await f.store.open(), [STORES.queue, STORES.sequences], 'readwrite', async tx => {
      let sequence = 1;
      for (const status of ['blocked', 'rejected', 'set_aside'] as const) for (let i = 0; i <= 1_000; i++) {
        const opId = `${status}-${i}`;
        if (i < 1_000) excluded.add(opId); else expected.push(opId);
        const payload = { ...f.queued.payload, sequence: ++sequence, opId };
        const row = validateQueueRecord({ ...f.queued, status, sequence, opId,
          digest: canonicalOperationDigest(payload),
          recovery: { code: status === 'blocked' ? 'conflict_pending' : 'resource_id_unavailable' },
          payload }, 256 * 1024);
        tx.objectStore(STORES.queue).put(row);
      }
      tx.objectStore(STORES.sequences).put({ scopeKey: f.queued.scopeKey, next: sequence + 1 });
    });
    const pages = vi.fn(f.store.listQueue);
    const result = await readOpenSyncIssues({ ...f.store, listQueue: pages }, scope, { excludeQueueOpIds: excluded });
    assert.deepEqual(result.queue.map(row => row.opId), expected);
    for (const status of ['blocked', 'rejected', 'set_aside']) {
      assert.equal(pages.mock.calls.filter(([, state]) => state === status).length, 2);
    }
    assert.equal(result.operationalTotal, 3);
    assert.equal(await f.store.getQueueReceipt(scope, 1), null);
  } finally { f.store.close(); }
});
