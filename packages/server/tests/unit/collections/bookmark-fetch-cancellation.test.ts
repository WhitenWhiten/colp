import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import { fetchReadableReplicaHtml } from '../../../src/infrastructure/collections/readable-replica-fetch.js';
import { probeBookmarkUrl } from '../../../src/infrastructure/collections/link-health-probe.js';
import { ReadableReplicaWorkerLoop } from '../../../src/infrastructure/collections/readable-replica-worker.js';
import { LinkHealthWorkerLoop } from '../../../src/infrastructure/collections/link-health-worker.js';
import type { HardenedEgressConnector } from '../../../src/infrastructure/egress/index.js';

afterEach(() => vi.useRealTimers());
const options = {
  url: 'https://article.example/page', timeoutMs: 100, connectTimeoutMs: 20,
  maxBodyBytes: 1024, resolve: async () => ['1.1.1.1'],
};

function stalledBody() {
  let signal: AbortSignal | undefined;
  let body: ReadableStreamDefaultController<Uint8Array> | undefined;
  let opened!: () => void;
  const ready = new Promise<void>((resolve) => { opened = resolve; });
  const connect: HardenedEgressConnector = async (_target, init) => {
    if (init.method === 'HEAD') return new Response(null, { status: 405 });
    signal = init.signal ?? undefined;
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      body = controller;
      signal!.addEventListener('abort', () => controller.error(
        new DOMException('Aborted', 'AbortError'),
      ), { once: true });
    } });
    opened();
    return new Response(stream, { headers: { 'content-type': 'text/html' } });
  };
  return { connect, ready, signal: () => signal, cleanup: () => body?.error(new Error('cleanup')) };
}

for (const kind of ['readable', 'link-health'] as const) {
  test(`${kind} cancels a stalled body after headers at the total deadline`, async () => {
    vi.useFakeTimers();
    const connection = stalledBody();
    let finished = false;
    const operation = kind === 'readable'
      ? fetchReadableReplicaHtml({ ...options, connect: connection.connect })
      : probeBookmarkUrl({ ...options, connect: connection.connect });
    const result = operation.then((value) => { finished = true; return value; });
    try {
      await connection.ready;
      await vi.advanceTimersByTimeAsync(25);
      assert.equal(connection.signal()?.aborted, false, 'connection timer ends at headers');
      await vi.advanceTimersByTimeAsync(75);
      assert.equal(finished, true, 'the body must not outlive the total deadline');
      assert.equal(connection.signal()?.aborted, true);
      const value = await result;
      if ('kind' in value) assert.equal(value.kind === 'failure' && value.failureCode, 'timeout');
      else assert.equal(value.fact.errorClass, 'timeout');
    } finally {
      connection.cleanup();
      await result;
    }
  });
}

test('a slow body can finish after the connection deadline while the total budget remains', async () => {
  vi.useFakeTimers();
  let finish!: () => void;
  const operation = fetchReadableReplicaHtml({ ...options, connect: async (_target, init) =>
    new Response(new ReadableStream<Uint8Array>({ start(controller) {
      init.signal!.addEventListener('abort', () => controller.error(init.signal!.reason));
      finish = () => { controller.enqueue(new TextEncoder().encode('<p>done</p>')); controller.close(); };
    } }), { headers: { 'content-type': 'text/html' } }),
  });
  await vi.advanceTimersByTimeAsync(30);
  finish();
  assert.equal((await operation).kind, 'html');
});

for (const kind of ['readable', 'link-health'] as const) {
  test(`${kind} worker stop cancels a received body without recording a terminal failure`, async () => {
    vi.useFakeTimers();
    const connection = stalledBody();
    let completions = 0;
    let claimed = false;
    const common = {
      logger: { info() {}, warn() {}, error() {} }, workerId: 'cancellation-test',
      perHostGapMs: 0, pollIntervalMs: 100, resolve: options.resolve, connect: connection.connect,
    };
    const claimDue = async () => {
      if (claimed) return [];
      claimed = true;
      return [{ nodeId: 'node', url: options.url, leaseOwner: common.workerId }];
    };
    const worker = kind === 'readable'
      ? new ReadableReplicaWorkerLoop({ ...common, repository: {
        claimDue, async completeExtract() { completions++; return true; },
      } })
      : new LinkHealthWorkerLoop({ ...common, repository: {
        claimDue, async completeProbe() { completions++; return true; },
      } });
    worker.start();
    await connection.ready;
    await vi.advanceTimersByTimeAsync(0);
    let stopped = false;
    const stopping = worker.stop().then(() => { stopped = true; });
    try {
      await vi.advanceTimersByTimeAsync(0);
      assert.equal(connection.signal()?.aborted, true);
      await vi.advanceTimersByTimeAsync(100);
      assert.equal(stopped, true);
      assert.equal(completions, 0);
    } finally {
      connection.cleanup();
      await vi.advanceTimersByTimeAsync(100);
      await stopping;
    }
  });
}
