import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { describe, test } from 'vitest';
import { createOutboundPushWorker } from '../src/outbound-push-worker.js';
import { isTransportError, unrecognizedStatusReason } from '../src/push-error-code.js';
import { classifySyncFailure } from '../src/sync-failure-class.js';
import { installOutboundPushIndexedDb, json, scope, setup } from './outbound-push-worker-harness.js';

installOutboundPushIndexedDb();

/**
 * A-F12 (push half): the codes a push row can carry are registered, and an outage is not told
 * apart from "the server cannot read this change" only by luck. A 5xx without a Problem body, a
 * request that failed before it left and a response body that stopped arriving are waits (transient);
 * a refusal of one change by the network or by an upload policy is an item.
 */
describe('A-F12 push row reasons are registered', () => {
  test.each([
    ['push_dispatch_failed', 'transient'], ['push_server_unavailable', 'transient'], ['push_attempt_missing', 'transient'],
    ['push_network_failed', 'transient'], ['push_request_refused', 'item'], ['push_attempt_bind_failed', 'item'],
    ['push_media_type_invalid', 'item'], ['subscription_upload_excluded', 'item'], ['bootstrap_upload_excluded', 'item'],
    ['bootstrap_boundary_unavailable', 'item'],
  ] as const)('%s is %s', (code, expected) => {
    // An item needs a subject to stay an item; the rows below carry their opId.
    assert.equal(classifySyncFailure(code, { opId: 'op-1' })?.class, expected);
  });

  test('statuses with no usable Problem body map to a wait or to an unrecognized answer', () => {
    for (const status of [500, 502, 503, 504, 408, 425]) assert.equal(unrecognizedStatusReason(status), 'push_server_unavailable', String(status));
    assert.equal(unrecognizedStatusReason(429), 'rate_limited');
    for (const status of [400, 404, 405, 413, 415, 422]) assert.equal(unrecognizedStatusReason(status), 'push_response_unrecognized', String(status));
  });

  test('transport errors are told apart from programming errors', () => {
    assert.equal(isTransportError(new TypeError('Failed to fetch')), true);
    assert.equal(isTransportError(new DOMException('timed out', 'AbortError')), true);
    assert.equal(isTransportError(new DOMException('x', 'NetworkError')), true);
    assert.equal(isTransportError(new ReferenceError('x is not defined')), false);
    assert.equal(isTransportError(new Error('push_response_invalid')), false);
  });
});

describe('A-F12 what a sent row records', () => {
  test.each([
    [503, 'text/html', 'push_server_unavailable'], [502, 'text/plain', 'push_server_unavailable'],
    [429, 'text/plain', 'rate_limited'], [404, 'text/html', 'push_response_unrecognized'],
  ] as const)('a %s answer with no Problem body is recorded as %s', async (status, type, code) => {
    const f = await setup();
    const worker = createOutboundPushWorker({ ...f.options,
      fetch: async () => new Response('gateway page', { status, headers: { 'Content-Type': type } }) });
    assert.equal((await worker.drain()).outcome, 'unknown');
    const row = (await f.store.listQueue(scope))[0]!;
    assert.equal(row.status, 'unknown'); assert.equal(row.recovery?.code, code);
    assert.ok(row.attempt, 'the sent attempt stays bound');
    f.store.close();
  });

  test('a 200 body that is not JSON is an unreadable answer, kept on the sent attempt', async () => {
    const f = await setup();
    const worker = createOutboundPushWorker({ ...f.options,
      fetch: async () => new Response('<html>maintenance</html>', { status: 200, headers: { 'Content-Type': 'application/json' } }) });
    assert.equal((await worker.drain()).outcome, 'unknown');
    const row = (await f.store.listQueue(scope))[0]!;
    assert.equal(row.recovery?.code, 'push_response_invalid'); assert.ok(row.attempt);
    assert.equal(classifySyncFailure(row.recovery?.code)?.class, 'replica');
    f.store.close();
  });

  test('a request that cannot be dispatched before it leaves keeps the attempt and is a wait', async () => {
    const f = await setup();
    const worker = createOutboundPushWorker({ ...f.options,
      endpoints: async () => { throw new ReferenceError('manifest helper missing'); },
      fetch: async () => json(200, {}) });
    for (let drain = 0; drain < 7; drain += 1) {
      assert.equal((await worker.drain()).outcome, 'unknown');
      const row = (await f.store.listQueue(scope))[0]!;
      assert.equal(row.status, 'unknown'); assert.equal(row.recovery?.code, 'push_dispatch_failed');
      f.clock.now = row.retry.notBefore + 1;
    }
    assert.equal((await f.store.listQueue(scope))[0]?.status, 'unknown', 'a wait is never held as an item');
    f.store.close();
  });
});
