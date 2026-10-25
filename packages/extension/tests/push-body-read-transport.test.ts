import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { test, vi } from 'vitest';
import { createOutboundPushWorker } from '../src/outbound-push-worker.js';
import { installOutboundPushIndexedDb, json, scope, setup } from './outbound-push-worker-harness.js';

installOutboundPushIndexedDb();

/**
 * A-F12 / W2C-03 (push half): a 200 push response whose body stops arriving is the network
 * failing, not "the server's answer is unreadable". The bounded body reader hands the caller the
 * transport error itself (a TypeError, or an AbortError on timeout) for a stream failure and keeps
 * the caller's code only for parse, size and declared-length failures; the worker must record the
 * first as a wait and the second as an unreadable answer.
 */
let bodyFailure: unknown;
vi.mock('../src/json-response.js', () => ({
  readBoundedJson: async () => { throw bodyFailure; },
}));

test.each([
  ['a stream error', new TypeError('network error'), 'push_network_failed'],
  ['a body timeout', new DOMException('Response body timed out', 'AbortError'), 'push_network_failed'],
  ['a body that is too large or not JSON', new Error('push_response_invalid'), 'push_response_invalid'],
])('%s is recorded as %s', async (_name, failure, expected) => {
  bodyFailure = failure;
  const f = await setup();
  const worker = createOutboundPushWorker({ ...f.options, fetch: async () => json(200, {}) });
  assert.equal((await worker.drain()).outcome, 'unknown');
  const row = (await f.store.listQueue(scope))[0]!;
  assert.equal(row.recovery?.code, expected); assert.ok(row.attempt, 'the sent attempt stays bound');
  f.store.close();
});
