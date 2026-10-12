import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { describe, test } from 'vitest';
import { createOutboundPushWorker } from '../src/outbound-push-worker.js';
import { bootstrapOpId } from '../src/bootstrap/matcher.js';
import { operationPayload } from '../src/bootstrap/coordinator-operations.js';
import { validateOperation } from '../src/bookmark-event-codec.js';
import { createSyncStateStore, type JsonObject } from '../src/sync-state-store.js';
import { fixture, success } from './outbound-push-batch-harness.js';
import { installOutboundPushIndexedDb, scope, json, problem } from './outbound-push-worker-harness.js';

installOutboundPushIndexedDb();

describe('first-sync transport batches', () => {
  test('batches schema-valid operations from the real bootstrap producer', async () => {
    const f = await fixture(100, 50, 0, row => ({ ...row, ...operationPayload({
      type: 'create_node', reason: 'local-only', opId: String(row.opId), parentId: 'root-push',
      node: (row.payload as JsonObject).node as NonNullable<Parameters<typeof operationPayload>[0]['node']>,
    }, String(row.occurredAt)) }));
    const sizes: number[] = [];
    try {
      const result = await createOutboundPushWorker({ ...f.options, fetch: async (_url, init) => {
        const body = String(init?.body); const request = JSON.parse(body);
        request.operations.forEach(validateOperation);
        sizes.push(request.operations.length); return success(body);
      } }).drain();
      assert.equal(result.outcome, 'terminal');
      assert.deepEqual(sizes, [50, 50]);
    } finally { f.store.close(); }
  });

  test.each([1, 7, 50])('100 creates obey negotiated limit %i and persist all mappings', async limit => {
    const f = await fixture(100, limit); const sizes: number[] = [];
    const worker = createOutboundPushWorker({ ...f.options, fetch: async (_url, init) => {
      const body = String(init?.body); sizes.push(JSON.parse(body).operations.length); return success(body);
    } });
    assert.equal((await worker.drain()).outcome, 'terminal');
    assert.equal(sizes.length, Math.ceil(100 / limit));
    assert.ok(sizes.every(size => size <= limit));
    assert.equal((await f.store.listQueue(scope, 'terminal')).length, 100);
    assert.equal((await f.store.listMappings(scope)).length, 100);
    assert.equal((await f.store.getMappingByNativeId(scope, 'native-100'))?.colpId, 'node-100');
    f.store.close();
  });

  test('splits large creates at the byte budget', async () => {
    const f = await fixture(30, 50, 4_000); const sizes: number[] = [];
    const worker = createOutboundPushWorker({ ...f.options, fetch: async (_url, init) => {
      const body = String(init?.body); sizes.push(JSON.parse(body).operations.length);
      assert.ok(new TextEncoder().encode(body).length <= 64 * 1024); return success(body);
    } });
    assert.equal((await worker.drain()).outcome, 'terminal');
    assert.ok(sizes.length > 1); assert.equal(sizes.reduce((a, b) => a + b, 0), 30); f.store.close();
  });

  test.each(['lost_response', 'partial_commit', 'malformed_response'])('%s recovers with singleton attempts after restart', async mode => {
    const f = await fixture(8); const applied = new Set<string>(); let calls = 0;
    const fetcher: typeof fetch = async (_url, init) => {
      calls += 1; const body = String(init?.body); const request = JSON.parse(body);
      if (calls === 1) {
        if (mode !== 'malformed_response') {
          for (const op of request.operations.slice(0, mode === 'partial_commit' ? 3 : 8)) applied.add(op.opId);
          throw new TypeError('response lost after commit');
        }
        const response = await success(body).json(); response.results.reverse(); return json(200, response);
      }
      assert.equal(request.operations.length, 1);
      const op = request.operations[0];
      assert.equal(new Headers(init?.headers).get('Idempotency-Key'), op.opId);
      applied.add(op.opId); return success(body);
    };
    assert.equal((await createOutboundPushWorker({ ...f.options, fetch: fetcher }).drain()).outcome, 'unknown');
    assert.equal((await f.store.listQueue(scope, 'unknown')).length, 8);
    const attempts = (await f.store.listQueue(scope, 'unknown')).map(row => row.attempt!.body);
    assert.ok(attempts.every(body => JSON.parse(body).operations.length === 1));
    f.store.close();
    const restored = createSyncStateStore({ indexedDB: f.factory }); f.clock.now += 60_000;
    assert.equal((await createOutboundPushWorker({ ...f.options, store: restored, fetch: fetcher }).drain()).outcome, 'terminal');
    assert.equal(calls, 9); assert.equal(applied.size, 8);
    assert.deepEqual((await restored.listQueue(scope, 'terminal')).map(row => row.attempt!.body), attempts);
    restored.close();
  });

  test('batch rate limit preserves Retry-After and does not mark individual operations rejected', async () => {
    const f = await fixture(4); let calls = 0;
    const worker = createOutboundPushWorker({ ...f.options, fetch: async () => {
      calls += 1; return problem(429, 'rate_limited', undefined, '60');
    } });
    assert.equal((await worker.drain()).outcome, 'unknown');
    assert.equal((await f.store.listQueue(scope, 'rejected')).length, 0);
    await worker.drain(); assert.equal(calls, 1);
    assert.ok((await f.store.listQueue(scope, 'unknown')).every(row => row.retry.notBefore >= f.clock.now + 60_000));
    f.store.close();
  });

  test.each(['dependency', 'placement'])('keeps %s boundaries in sequence order', async boundary => {
    const f = await fixture(4, 50, 0, (payload, index) => index !== 2 ? payload : boundary === 'dependency'
      ? { ...payload, dependencies: [bootstrapOpId('first-sync', 'create', 'native-1')] }
      : { ...payload, payload: { ...(payload.payload as JsonObject), afterId: 'existing-anchor' } });
    const requests: number[][] = [];
    const worker = createOutboundPushWorker({ ...f.options, fetch: async (_url, init) => {
      const body = String(init?.body); requests.push(JSON.parse(body).operations.map((op: JsonObject) => op.sequence));
      return success(body);
    } });
    assert.equal((await worker.drain()).outcome, 'terminal');
    assert.deepEqual(requests, [[1], [2], [3, 4]]); f.store.close();
  });

  test('a batch dispatch refusal sends nothing and leaves recoverable singleton attempts', async () => {
    const f = await fixture(4); let requests = 0;
    const worker = createOutboundPushWorker({ ...f.options,
      dispatchBatch: async rows => { assert.equal(rows.length, 4); throw new Error('subscription_upload_denied'); },
      fetch: async () => { requests += 1; throw new Error('must not send'); } });
    assert.equal((await worker.drain()).outcome, 'unknown'); assert.equal(requests, 0);
    assert.equal((await f.store.listQueue(scope, 'unknown')).length, 4); f.store.close();
  });

  test('a failed local receipt transaction recovers every member without publishing a partial mapping', async () => {
    const f = await fixture(4); const fetcher: typeof fetch = async (_url, init) => success(String(init?.body));
    const failed = createOutboundPushWorker({ ...f.options, fetch: fetcher, settlementFault: 'after_receipt' });
    assert.equal((await failed.drain()).outcome, 'unknown');
    assert.equal((await f.store.listMappings(scope)).length, 0);
    assert.equal(await f.store.getQueueReceipt(scope, 1), null);
    f.clock.now += 60_000;
    assert.equal((await createOutboundPushWorker({ ...f.options, fetch: fetcher }).drain()).outcome, 'terminal');
    assert.equal((await f.store.listMappings(scope)).length, 4); f.store.close();
  });
});
