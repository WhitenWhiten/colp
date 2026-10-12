import { afterEach, expect, test, vi } from 'vitest';
import { LinkPreviewWorkerLoop } from '../../../src/infrastructure/collections/link-preview-worker.js';
import type { LinkPreviewRepository } from '../../../src/infrastructure/collections/link-preview-postgres.js';
import { createFakeEgress, createMemoryObjectStore, htmlResponse } from '../../support/link-preview-fixtures.js';

afterEach(() => vi.useRealTimers());

test('renews queued claims and rechecks ownership before fetching', async () => {
  vi.useFakeTimers();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const renewLease = vi.fn(async () => true);
  const completeNone = vi.fn(async () => true);
  const repository: LinkPreviewRepository = {
    enqueue: async () => 0, claimSweep: async () => null, listSweepUrls: async () => ({ urls: [], corrupted: false }),
    completeSweep: async () => {}, releaseSweep: async () => {}, pruneStale: async () => 0, listCollectable: async () => [],
    forgetObject: async () => {}, recordObject: async () => {}, completeFailure: async () => true,
    completeReady: async () => ({ written: true, generic: false }), renewLease, completeNone,
    claimDue: async () => [{ urlKey: 'key', normalizedUrl: 'https://example.com/page', site: 'example.com',
      objectId: null, digest: null, failures: 0, leaseOwner: 'owner' }],
  };
  const egress = createFakeEgress(new Map([['https://example.com/page', () => htmlResponse('')]]));
  const loop = new LinkPreviewWorkerLoop({ repository, store: createMemoryObjectStore(),
    logger: { info() {}, warn() {}, error() {} }, retentionSeconds: 31_536_000,
    resolve: egress.resolve, connect: egress.connect,
    hostGate: { run: async (_host, work) => { await gate; await work(); } },
  });
  const work = loop.runOnce();
  await vi.advanceTimersByTimeAsync(160_000);
  expect(renewLease).toHaveBeenCalledTimes(4);
  expect(egress.requested).toEqual([]);
  release();
  await work;
  expect(renewLease).toHaveBeenCalledTimes(5);
  expect(completeNone).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(renewLease).toHaveBeenCalledTimes(5);

  renewLease.mockResolvedValue(false);
  egress.requested.length = 0;
  await loop.runOnce();
  expect(egress.requested).toEqual([]);
  expect(completeNone).toHaveBeenCalledTimes(1);
});
