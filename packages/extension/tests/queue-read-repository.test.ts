import 'fake-indexeddb/auto';
import { expect, test, vi } from 'vitest';
import { createOutboundPushWorker } from '../src/outbound-push-worker.js';
import { createSyncStateStore } from '../src/sync-state-store.js';
import { requestValue, runTransaction } from '../src/sync-state/idb.js';
import { createQueueReadRepository, MAX_QUEUE_READ_IDS } from '../src/sync-state/queue-read-repository.js';
import { createSyncStoreRuntime } from '../src/sync-state/runtime.js';
import { INDEXES, STORES } from '../src/sync-state/schema.js';
import { validateQueueRecord } from '../src/sync-state/queue-validate.js';
import { digestJson } from '../src/bookmark-event-codec.js';
import { indexedDB, installOutboundPushIndexedDb, json, problem, scope, setup, setupMove } from './outbound-push-worker-harness.js';

installOutboundPushIndexedDb();

type Fixture = Awaited<ReturnType<typeof setup>>;
function response(f: Fixture, status: 'applied' | 'rejected' | 'deferred') {
  return json(200, { batchId: f.queued.batchId, serverCursor: 'cursor-1',
    results: [{ opId: f.queued.opId, sequence: f.queued.sequence, status, warnings: [],
      ...(status === 'applied' ? { targetId: 'cloud-created', revision: 'r1', cursor: 'cursor-1' }
        : status === 'rejected' ? { code: 'policy_denied' } : { code: 'pending_parent', retryAfterSeconds: 17 }) }] });
}

test.each(['pending', 'applied', 'rejected', 'deferred', 'unknown', 'request-rejected'] as const)(
  'fresh queue worksets preserve real worker %s evidence without changing durable bytes', async outcome => {
    const f = await setup(); const observer = createSyncStateStore({ indexedDB });
    try {
      if (outcome !== 'pending') {
        const worker = createOutboundPushWorker({ ...f.options, fetch: async () => {
          if (outcome === 'unknown') throw new TypeError('response lost');
          if (outcome === 'request-rejected') return problem(422, 'invalid_document', { retryable: false });
          return response(f, outcome);
        } });
        await worker.drain();
      }
      const before = await f.store.exportScope(scope);
      const entries = await observer.readQueueEntriesByOpIds(scope, ['missing', f.queued.opId, f.queued.opId]);
      expect(entries).toHaveLength(1);
      const entry = entries[0]!;
      expect(entry.queue).toEqual(await f.store.getQueueByOpId(scope, f.queued.opId));
      const expectedStatus = outcome === 'applied' || outcome === 'rejected' ? 'terminal'
        : outcome === 'request-rejected' ? 'rejected' : outcome;
      expect(entry.queue.status).toBe(expectedStatus);
      expect((await observer.listQueue(scope, expectedStatus)).map(row => row.opId)).toEqual([f.queued.opId]);
      if (expectedStatus === 'terminal') {
        expect(entry.receipt).toEqual(await f.store.getQueueReceipt(scope, f.queued.sequence));
        expect(entry.receipt?.operationDigest).toBe(entry.queue.digest);
        expect(entry.receipt?.opId).toBe(entry.queue.opId);
      } else {
        expect(entry.receipt).toBeNull();
        if (outcome === 'unknown') expect(entry.queue.attempt?.body).toBeTruthy();
        if (outcome === 'deferred') expect((await f.store.getQueueReceipt(scope, f.queued.sequence))?.kind).toBe('deferred');
      }
      if (outcome === 'rejected') expect(entry.queue.recovery?.resultStatus).toBe('rejected');
      Object.assign(entry.queue.payload, { readCopyOnly: true });
      if (entry.receipt?.result) Object.assign(entry.receipt.result, { readCopyOnly: true });
      const after = await f.store.exportScope(scope);
      expect(after.queue).toEqual(before.queue);
      expect(after.receipts).toEqual(before.receipts);
      expect(after.sequence).toEqual(before.sequence);
      expect(await observer.readQueueEntriesByOpIds({ ...scope, accountId: 'other-account' }, [f.queued.opId])).toEqual([]);
    } finally { observer.close(); f.store.close(); }
  });

test('a settlement on a second connection appears on the next workset, never halfway through one', async () => {
  const f = await setup(); const observer = createSyncStateStore({ indexedDB });
  await observer.open();
  let reached!: () => void; const started = new Promise<void>(resolve => { reached = resolve; });
  let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; });
  const drain = createOutboundPushWorker({ ...f.options, fetch: async () => {
    reached(); await wait; return response(f, 'applied');
  } }).drain();
  await started;
  const get = IDBIndex.prototype.get; let releasedDuringRead = false;
  const spy = vi.spyOn(IDBIndex.prototype, 'get').mockImplementation(function (this: IDBIndex, key) {
    const result = get.call(this, key);
    if (!releasedDuringRead && this.name === INDEXES.queueByOpId) {
      releasedDuringRead = true; result.addEventListener('success', release, { once: true });
    }
    return result;
  });
  try {
    const before = await observer.readQueueEntriesByOpIds(scope, [f.queued.opId]);
    expect(releasedDuringRead).toBe(true);
    expect(before[0]?.queue.status).toBe('claimed');
    expect(before[0]?.receipt).toBeNull();
    expect((await drain).outcome).toBe('terminal');
    const after = await observer.readQueueEntriesByOpIds(scope, [f.queued.opId]);
    expect(after[0]?.queue.status).toBe('terminal');
    expect(after[0]?.receipt?.operationDigest).toBe(after[0]?.queue.digest);
  } finally { release(); spy.mockRestore(); await drain; observer.close(); f.store.close(); }
});

test('single and paged queue reads open only the stores that their evidence projection uses', async () => {
  const f = await setup(); const transaction = IDBDatabase.prototype.transaction;
  const accesses: { stores: string[]; mode: IDBTransactionMode }[] = [];
  const spy = vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (this: IDBDatabase,
    ...args: Parameters<typeof transaction>) {
    accesses.push({ stores: (typeof args[0] === 'string' ? [args[0]] : Array.from(args[0])).sort(),
      mode: args[1] ?? 'readonly' });
    return transaction.apply(this, args);
  });
  try {
    expect((await f.store.getQueueByOpId(scope, f.queued.opId))?.opId).toBe(f.queued.opId);
    expect((await f.store.listQueue(scope)).map(row => row.opId)).toEqual([f.queued.opId]);
    expect(accesses).toEqual(Array.from({ length: 2 }, () => ({ stores: [STORES.queue, STORES.receipts].sort(), mode: 'readonly' })));
  } finally { spy.mockRestore(); f.store.close(); }
});

test('requested identity order, missing rows, page boundaries and cloned target history are preserved', async () => {
  const f = await setupMove();
  try {
    const { scopeKey: _scopeKey, sequence: _sequence, ...input } = f.queued;
    const next = await f.store.allocateSequenceAndEnqueue(scope, { ...input,
      opId: 'second', batchId: 'second', idempotencyKey: 'second',
      operationRevision: 'local-second', payload: { ...f.queued.payload, opId: 'second', sequence: 2, targetId: 'other-node' },
    }, { allowUnstamped: true });
    const rows = await f.store.readQueueEntriesByOpIds(scope, [next.opId, 'missing', f.queued.opId, next.opId]);
    expect(rows.map(row => row.queue.opId)).toEqual([next.opId, f.queued.opId]);
    expect((await f.store.listQueue(scope, 'pending', 0, 1)).map(row => row.sequence)).toEqual([f.queued.sequence]);
    expect((await f.store.listQueue(scope, undefined, f.queued.sequence, 1)).map(row => row.sequence)).toEqual([next.sequence]);
    expect(await f.store.listQueue(scope, undefined, Number.MAX_SAFE_INTEGER)).toEqual([]);
    expect(await f.store.listQueue(scope, 'terminal')).toEqual([]);
    const history = await f.store.listQueueByTarget(scope, 'node-bookmark');
    expect(history.map(row => row.opId)).toEqual([f.queued.opId]);
    Object.assign(history[0]!.payload, { readCopyOnly: true });
    expect((await f.store.getQueueByOpId(scope, f.queued.opId))?.payload.readCopyOnly).toBeUndefined();
    expect(await f.store.getQueueByOpId(scope, 'missing')).toBeNull();
    expect(await f.store.getQueueReceipt(scope, 99)).toBeNull();
  } finally { f.store.close(); }
});

test('empty and invalid worksets do not start queue transactions, and one bounded batch uses only queue/receipts', async () => {
  const f = await setup(); const transaction = IDBDatabase.prototype.transaction; const names: string[][] = [];
  const spy = vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (this: IDBDatabase,
    ...args: Parameters<typeof transaction>) {
    names.push(typeof args[0] === 'string' ? [args[0]] : Array.from(args[0])); return transaction.apply(this, args);
  });
  try {
    expect(await f.store.readQueueEntriesByOpIds(scope, [])).toEqual([]);
    await expect(f.store.readQueueEntriesByOpIds(scope, Array(MAX_QUEUE_READ_IDS + 1).fill('id'))).rejects.toThrow('limit_exceeded');
    await expect(f.store.readQueueEntriesByOpIds(scope, [''])).rejects.toThrow();
    await expect(f.store.listQueue(scope, undefined, 0, 1_001)).rejects.toThrow('limit_exceeded');
    await expect(f.store.listQueue(scope, undefined, 0, 0)).rejects.toThrow();
    expect(names).toEqual([]);
    const entries = await f.store.readQueueEntriesByOpIds(scope, [f.queued.opId, ...Array.from({ length: 199 }, (_, i) => `missing-${i}`)]);
    expect(entries).toHaveLength(1);
    expect(names.map(value => value.sort())).toEqual([[STORES.queue, STORES.receipts].sort()]);
  } finally { spy.mockRestore(); f.store.close(); }
});

test('a tiny identity workset does not scan a thousand unrelated pending operations', async () => {
  const f = await setup();
  try {
    const database = await f.store.open();
    // Validated pending history extends one real allocated operation. These are
    // unattempted operations, with no invented terminal result or receipt.
    await runTransaction(database, [STORES.queue, STORES.sequences], 'readwrite', async tx => {
      for (let index = 0; index < 1_001; index++) {
        const opId = `history-${index}`; const sequence = index + 2;
        const payload = { ...f.queued.payload, opId, sequence };
        tx.objectStore(STORES.queue).add(validateQueueRecord({ ...f.queued, opId, sequence,
          batchId: opId, idempotencyKey: opId, digest: digestJson(payload), payload }, 256 * 1_024));
      }
      tx.objectStore(STORES.sequences).put({ scopeKey: f.queued.scopeKey, next: 1_003 });
    });
    let pointReads = 0; const get = IDBIndex.prototype.get;
    const getSpy = vi.spyOn(IDBIndex.prototype, 'get').mockImplementation(function (this: IDBIndex, key) {
      if (this.objectStore.name === STORES.queue) pointReads++;
      return get.call(this, key);
    });
    const allSpy = vi.spyOn(IDBIndex.prototype, 'getAll');
    const cursorSpy = vi.spyOn(IDBIndex.prototype, 'openCursor');
    try {
      const entries = await f.store.readQueueEntriesByOpIds(scope, ['history-1000', f.queued.opId, 'missing']);
      expect(entries.map(entry => [entry.queue.opId, entry.queue.status, entry.receipt])).toEqual([
        ['history-1000', 'pending', null], [f.queued.opId, 'pending', null],
      ]);
      expect(pointReads).toBe(3); expect(allSpy).not.toHaveBeenCalled(); expect(cursorSpy).not.toHaveBeenCalled();
    } finally { getSpy.mockRestore(); allSpy.mockRestore(); cursorSpy.mockRestore(); }
  } finally { f.store.close(); }
});

test('missing or malformed terminal evidence is never manufactured into a successful receipt', async () => {
  const f = await setup();
  try {
    await createOutboundPushWorker({ ...f.options, fetch: async () => response(f, 'applied') }).drain();
    const receipt = (await f.store.getQueueReceipt(scope, f.queued.sequence))!;
    const database = await f.store.open();
    await runTransaction(database, [STORES.receipts], 'readwrite', async tx => {
      await requestValue(tx.objectStore(STORES.receipts).delete([receipt.scopeKey, receipt.receiptId]));
    });
    const missing = await f.store.readQueueEntriesByOpIds(scope, [f.queued.opId]);
    expect(missing[0]?.queue.status).toBe('terminal'); expect(missing[0]?.receipt).toBeNull();
    // Explicit corruption injection verifies the existing receipt codec still
    // gates the new path. No test manufactures a successful server acknowledgement.
    await runTransaction(database, [STORES.receipts], 'readwrite', async tx => {
      await requestValue(tx.objectStore(STORES.receipts).put({ ...receipt, kind: 'invented' }));
    });
    await expect(f.store.readQueueEntriesByOpIds(scope, [f.queued.opId])).rejects.toThrow('receipt_kind_invalid');
    await expect(f.store.getQueueReceipt(scope, f.queued.sequence)).rejects.toThrow('receipt_kind_invalid');
  } finally { f.store.close(); }
});

test('read-only diagnosis, a retired scope and reopening preserve the existing pure-read contract', async () => {
  const f = await setup(); const runtime = createSyncStoreRuntime({ indexedDB });
  try {
    const registered = (await f.store.getScope(scope))!;
    await f.store.registerScope({ ...registered, lifecycle: 'retired' });
    runtime.setDiagnosticReadOnly(); const reader = createQueueReadRepository(runtime);
    expect((await reader.readQueueEntriesByOpIds(scope, [f.queued.opId]))[0]?.queue.opId).toBe(f.queued.opId);
    f.store.close();
    expect((await f.store.readQueueEntriesByOpIds(scope, [f.queued.opId]))[0]?.queue.opId).toBe(f.queued.opId);
    expect((await f.store.getScope(scope))?.lifecycle).toBe('retired');
  } finally { runtime.close(); f.store.close(); }
});
