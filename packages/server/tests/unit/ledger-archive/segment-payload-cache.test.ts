import assert from 'node:assert/strict';
import { describe, test } from 'vitest';

import { LedgerArchiveColdReadError } from '../../../src/infrastructure/ledger-archive/cold-reader.js';
import {
  createSegmentPayloadCache,
  estimateRetainedBytes,
  segmentPayloadCacheKey,
} from '../../../src/infrastructure/ledger-archive/segment-payload-cache.js';

const KEY = Object.freeze({
  segmentId: '11111111-1111-4111-8111-111111111111',
  contentDigest: `sha256:${'a'.repeat(64)}`,
  archiveSchemaVersion: 1,
});

describe('SYNC-Q-006 SegmentPayloadCache', () => {
  test('one materialize serves 1000 O(1) lookups and rejects duplicate keys', async () => {
    let scans = 0;
    const rows = new Map<bigint, unknown>();
    for (let index = 0; index < 1_000; index += 1) rows.set(BigInt(index), { n: index });
    const cache = createSegmentPayloadCache({
      maxCachedBytes: 8n * 1024n * 1024n, maxBytesPerSegment: 2n * 1024n * 1024n,
    });
    const reader = {
      async readRows(_id: string, onRow: (row: { key: bigint; value: unknown }) => void) {
        scans += 1;
        for (const [key, value] of rows) onRow({ key, value });
      },
    };
    const first = await cache.get(KEY, 42n, reader);
    const many = await cache.readMany(KEY, [0n, 999n, 42n], reader);
    for (let index = 0; index < 1_000; index += 1) {
      assert.deepEqual(await cache.get(KEY, BigInt(index), reader), { n: index });
    }
    assert.deepEqual(first, { n: 42 });
    assert.deepEqual(many.get(999n), { n: 999 });
    assert.equal(scans, 1);
    assert.equal(cache.stats().scans, 1);
    assert.equal(cache.stats().lookups, 1_004);
    const duplicate = createSegmentPayloadCache();
    await assert.rejects(duplicate.get(KEY, 1n, {
      async readRows(_id, onRow) {
        onRow({ key: 1n, value: { a: 1 } });
        onRow({ key: 1n, value: { a: 2 } });
      },
    }), (error: unknown) => error instanceof LedgerArchiveColdReadError
      && error.stableCode === 'archive_materialization_duplicate_key');
    assert.equal(duplicate.stats().scans, 1);
    await assert.rejects(duplicate.get(KEY, 1n, {
      async readRows() { throw new Error('should retry after failed materialize'); },
    }), /should retry/);
  });

  test('bounds concurrent loads and does not cache aborted or oversized segments', async () => {
    const cache = createSegmentPayloadCache({
      maxCachedBytes: 64n * 1024n, maxBytesPerSegment: 32n * 1024n, maxConcurrentLoads: 2,
    });
    let peak = 0;
    let active = 0;
    const reader = {
      async readRows(segmentId: string, onRow: (row: { key: bigint; value: unknown }) => void) {
        active += 1;
        peak = Math.max(peak, active);
        await Promise.resolve();
        onRow({ key: 1n, value: { segmentId } });
        active -= 1;
      },
    };
    const keys = Array.from({ length: 16 }, (_, index) => ({
      ...KEY, segmentId: `22222222-2222-4222-8222-${String(index).padStart(12, '0')}`,
    }));
    await Promise.all(keys.map((key) => cache.get(key, 1n, reader)));
    assert.equal(peak, 2);
    const oversize = createSegmentPayloadCache({
      maxCachedBytes: 64n, maxBytesPerSegment: 32n, maxConcurrentLoads: 1,
    });
    await assert.rejects(oversize.get(KEY, 1n, {
      async readRows(_id, onRow) { onRow({ key: 1n, value: { pad: 'x'.repeat(128) } }); },
    }), (error: unknown) => error instanceof LedgerArchiveColdReadError
      && error.stableCode === 'archive_materialization_byte_ceiling');
    assert.equal(oversize.stats().retainedBytes, 0n);
    const otherKey = { ...KEY, contentDigest: `sha256:${'b'.repeat(64)}` };
    assert.notEqual(segmentPayloadCacheKey(KEY), segmentPayloadCacheKey(otherKey));
    assert.ok(estimateRetainedBytes(10n, 1) > 10n);
  });

  test('emits machine-readable cache stats for the named archive-memory job', async () => {
    const rows = new Map<bigint, unknown>();
    for (let index = 0; index < 1_000; index += 1) rows.set(BigInt(index), { n: index });
    const cache = createSegmentPayloadCache({
      maxCachedBytes: 8n * 1024n * 1024n, maxBytesPerSegment: 2n * 1024n * 1024n,
    });
    const reader = {
      async readRows(_id: string, onRow: (row: { key: bigint; value: unknown }) => void) {
        for (const [key, value] of rows) onRow({ key, value });
      },
    };
    await cache.get(KEY, 0n, reader);
    for (let index = 0; index < 1_000; index += 1) await cache.get(KEY, BigInt(index), reader);
    const stats = cache.stats();
    const receipt = {
      loads: stats.loads,
      lookups: stats.lookups,
      scans: stats.scans,
      evictions: stats.evictions,
      busy: stats.busy,
      retainedBytes: stats.retainedBytes.toString(),
      inFlight: stats.inFlight,
      queued: stats.queued,
      heapUsed: process.memoryUsage().heapUsed,
    };
    assert.deepEqual(Object.keys(JSON.parse(JSON.stringify(receipt))), Object.keys(receipt));
    assert.equal(receipt.scans, 1);
    assert.equal(receipt.lookups, 1_001);
    assert.equal(receipt.inFlight, 0);
    assert.equal(receipt.queued, 0);
    assert.ok(receipt.heapUsed < 512 * 1024 * 1024);
  });
});
