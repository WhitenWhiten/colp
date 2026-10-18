import 'fake-indexeddb/auto';
import { expect, test } from 'vitest';
import { createOutboundPushWorker } from '../src/outbound-push-worker.js';
import { readOpenSyncIssues } from '../src/sync-issues.js';
import { snapshotSyncIssues } from '../src/sync-issue-snapshot.js';
import { installOutboundPushIndexedDb, setup, scope, json, problem } from './outbound-push-worker-harness.js';
installOutboundPushIndexedDb();

test('an inconsistent sequence_blocked response is visible, survives restart and retries exact bytes', async () => {
  const f = await setup(); const bodies: string[] = []; let attempts = 0;
  try {
    const options = { ...f.options, fetch: async (_url: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(String(init?.body)); attempts++;
      const body = JSON.parse(String(init?.body));
      return attempts === 1 ? problem(409, 'sequence_blocked', { expectedSequence: 1 }) : json(200, { batchId: body.batchId,
        results: [{ opId: f.queued.opId, sequence: 1, status: 'noop', warnings: [] }], serverCursor: 'sync-unchanged' });
    } };
    await createOutboundPushWorker(options).drain();
    expect(snapshotSyncIssues(await readOpenSyncIssues(f.store, scope))).toMatchObject([{ code: 'sequence_blocked', actions: ['retry'] }]);
    f.store.close(); f.clock.now += 60000;
    await createOutboundPushWorker(options).drain();
    expect(bodies).toHaveLength(2); expect(bodies[1]).toBe(bodies[0]);
    expect((await f.store.getQueueByOpId(scope, f.queued.opId))?.status).toBe('terminal');
    expect((await readOpenSyncIssues(f.store, scope)).total).toBe(0);
  } finally { f.store.close(); }
});
test('a missing deferred predecessor never causes renumbering; repeated refusals stop bounded retries with a real manual exit', async () => {
  const f = await setup(); let requests = 0;
  try {
    const worker = createOutboundPushWorker({ ...f.options, fetch: async () => { requests++;
      return problem(409, 'sequence_blocked', { expectedSequence: 1 }); } });
    for (let i = 0; i < 12; i++) { await worker.drain(); f.clock.now += 600000; }
    expect(requests).toBe(8);
    const row = (await f.store.listQueue(scope))[0]!;
    expect(row.sequence).toBe(1); expect(row.opId).toBe(f.queued.opId);
    expect((await readOpenSyncIssues(f.store, scope)).total).toBe(1);
    await f.store.retrySequenceBlocked(scope, row.opId); await worker.drain(); expect(requests).toBe(9);
    expect((await f.store.listQueue(scope))[0]?.attempt?.body).toBe(row.attempt?.body);
  } finally { f.store.close(); }
});

test('a legal deferred predecessor settles first, then the persisted blocked successor resumes', async () => {
  const f = await setup(); let expected = 1; let defer = true; const seen: number[] = [];
  try {
    const { scopeKey: _key, sequence: _sequence, ...input } = f.queued;
    const next = await f.store.allocateSequenceAndEnqueue(scope, { ...input, opId: 'next', batchId: 'next', idempotencyKey: 'next',
      digest: 'sha256:next', payload: { ...input.payload, opId: 'next', sequence: 2 } }, { allowUnstamped: true });
    const fetcher: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body)); const op = body.operations[0]; seen.push(op.sequence);
      if (op.sequence > expected) return problem(409, 'sequence_blocked', { expectedSequence: expected });
      expect(op.sequence).toBe(expected);
      if (defer) { defer = false; return json(200, { batchId: body.batchId, results: [{ opId: op.opId,
        sequence: op.sequence, status: 'deferred', code: 'pending_parent', retryAfterSeconds: 1, warnings: [] }], serverCursor: 'sync-unchanged' }); }
      expected++; return json(200, { batchId: body.batchId, results: [{ opId: op.opId, sequence: op.sequence,
        status: 'noop', warnings: [] }], serverCursor: 'sync-unchanged' });
    };
    await createOutboundPushWorker({ ...f.options, fetch: fetcher }).drain();
    // Recover an older worker's pipelined blocked row; the predecessor's actual deferred receipt is retained.
    const db = await f.store.open(); const tx = db.transaction('outbound_queue', 'readwrite');
    const body = JSON.stringify({ sessionId: 'session-push', batchId: next.batchId, atomic: false, operations: [next.payload] });
    tx.objectStore('outbound_queue').put({ ...next, status: 'blocked', recovery: { code: 'sequence_blocked', expectedSequence: 1 },
      retry: { attempt: 1, notBefore: 0 }, attempt: { sessionId: 'session-push', batchId: next.batchId,
        idempotencyKey: next.idempotencyKey, endpointIdentity: 'syncPush', mediaType: 'application/json', body, bodyDigest: 'sha256:next', startedAt: 10000 } });
    await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); });
    f.store.close(); f.clock.now += 60000;
    await createOutboundPushWorker({ ...f.options, fetch: fetcher }).drain();
    expect(seen).toEqual([1, 1, 2]); expect(expected).toBe(3);
    expect((await readOpenSyncIssues(f.store, scope)).total).toBe(0);
  } finally { f.store.close(); }
});
