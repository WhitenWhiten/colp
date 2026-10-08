import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createSegmentPayloadCache } from '../../../src/infrastructure/ledger-archive/segment-payload-cache.js';

const key = (segmentId: string) => ({ segmentId, contentDigest: 'sha256:fixture', archiveSchemaVersion: 1 });
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
function heldReader() {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const calls: string[] = [];
  const reader = { async readRows(id: string, onRow: (row: { key: bigint; value: unknown }) => void) {
    calls.push(id);
    await gate;
    onRow({ key: 1n, value: id });
  } };
  return { reader, calls, release: () => release() };
}

test('bounded queue rejects excess admission and abort removes a queued segment before any I/O', async () => {
  const cache = createSegmentPayloadCache({ maxConcurrentLoads: 1, maxQueuedLoads: 1 });
  const held = heldReader();
  const first = cache.get(key('first'), 1n, held.reader);
  await turn();
  const queued = cache.get(key('queued'), 1n, held.reader);
  await assert.rejects(cache.get(key('excess'), 1n, held.reader), { stableCode: 'archive_reader_busy' });
  const rejected = assert.rejects(queued);
  cache.abort(key('queued'));
  await rejected;
  assert.equal(cache.stats().queued, 0);
  held.release();
  assert.equal(await first, 'first');
  assert.deepEqual(held.calls, ['first']);
  assert.equal(cache.stats().inFlight, 0);
});

test('deadline includes queue wait and an abort-ignoring reader retains its capacity until it settles', async () => {
  const cache = createSegmentPayloadCache({ maxConcurrentLoads: 1, maxQueuedLoads: 1, loadTimeoutMs: 100 });
  const held = heldReader();
  const first = assert.rejects(cache.get(key('first'), 1n, held.reader));
  await turn();
  const queued = assert.rejects(cache.get(key('queued'), 1n, held.reader));
  await Promise.all([first, queued]);
  assert.equal(cache.stats().queued, 0);
  assert.equal(cache.stats().inFlight, 1);
  assert.deepEqual(held.calls, ['first']);
  held.release();
  await turn();
  assert.equal(cache.stats().inFlight, 0);
  assert.equal(cache.stats().retainedBytes, 0n);
});

test('one cancelled request does not cancel another participant in the same segment', async () => {
  const cache = createSegmentPayloadCache({ maxConcurrentLoads: 1 });
  const held = heldReader();
  const controller = new AbortController();
  const abandoned = cache.get(key('shared'), 1n, held.reader, controller.signal);
  const retained = cache.get(key('shared'), 1n, held.reader);
  const rejected = assert.rejects(abandoned);
  controller.abort();
  await rejected;
  held.release();
  assert.equal(await retained, 'shared');
  assert.deepEqual(held.calls, ['shared']);
  assert.equal(cache.stats().inFlight, 0);
});
