import assert from 'node:assert/strict';
import { test } from 'vitest';
import { LinkHealthWorkerLoop } from '../../../src/infrastructure/collections/link-health-worker.js';
import { ReadableReplicaWorkerLoop } from '../../../src/infrastructure/collections/readable-replica-worker.js';

for (const kind of ['link-health', 'readable-replica'] as const) {
  test(`${kind} resolves concurrent A-to-B and B-to-A redirects without nested host locks`, async () => {
    const completed: string[] = [];
    let arrived = 0;
    let release!: () => void;
    const bothStarted = new Promise<void>((resolve) => { release = resolve; });
    const options = {
      logger: { info() {}, warn() {}, error() {} }, perHostGapMs: 0,
      probeTimeoutMs: 1000, connectTimeoutMs: 500,
      resolve: async () => ['1.1.1.1'],
      connect: async (target: { url: URL }) => {
        if (target.url.pathname === '/start') {
          if (++arrived === 2) release();
          await bothStarted;
          const other = target.url.hostname === 'a.example' ? 'b.example' : 'a.example';
          return new Response(null, { status: 302, headers: { location: `https://${other}/final` } });
        }
        return new Response('<html><body><p>Article</p></body></html>', {
          headers: { 'content-type': 'text/html' },
        });
      },
    };
    const claimDue = async () => ['a', 'b'].map((host) => ({ nodeId: host,
      url: `https://${host}.example/start`, leaseOwner: 'test' }));
    const worker = kind === 'link-health'
      ? new LinkHealthWorkerLoop({ ...options, repository: { claimDue,
        completeProbe: async (input) => { completed.push(input.fact.status); return true; } } })
      : new ReadableReplicaWorkerLoop({ ...options, repository: { claimDue,
        completeExtract: async (input) => { completed.push(input.failureCode ?? 'ready'); return true; } } });
    await worker.runOnce();
    assert.equal(completed.length, 2);
    if (kind === 'link-health') assert.deepEqual(completed, ['redirect', 'redirect']);
    else assert.equal(completed.includes('timeout'), false);
  });
}
