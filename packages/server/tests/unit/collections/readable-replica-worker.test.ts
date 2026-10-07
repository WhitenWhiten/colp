import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  ReadableReplicaWorkerLoop,
  createReadableReplicaHostGate,
} from '../../../src/infrastructure/collections/index.js';
import type {
  ReadableReplicaCompleteInput,
  ReadableReplicaWorkerRepository,
} from '../../../src/infrastructure/collections/index.js';

const silentLogger = { info() {}, warn() {}, error() {} };
const PUBLIC_PIN = '1.1.1.1';
const URL = 'https://example.test/readable-article';

function abortError(): Error {
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
}

test('stop() leaves an in-flight extract pending instead of writing timeout', async () => {
  let connectStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    connectStarted = resolve;
  });
  const completed: ReadableReplicaCompleteInput[] = [];
  const repository: ReadableReplicaWorkerRepository = {
    async claimDue() {
      return [{ nodeId: 'node-1', url: URL, leaseOwner: 'rr-stop' }];
    },
    async completeExtract(input) {
      completed.push(input);
      return true;
    },
  };
  const worker = new ReadableReplicaWorkerLoop({
    repository,
    logger: silentLogger,
    workerId: 'rr-stop',
    probeTimeoutMs: 8_000,
    connectTimeoutMs: 3_000,
    concurrency: 1,
    perHostGapMs: 0,
    pollIntervalMs: 1_000,
    leaseDurationMs: 60_000,
    resolve: async () => [PUBLIC_PIN],
    connect: async (_target, init) => {
      connectStarted();
      const signal = init.signal;
      await new Promise<never>((_, reject) => {
        if (signal?.aborted) {
          reject(abortError());
          return;
        }
        signal?.addEventListener('abort', () => reject(abortError()), { once: true });
      });
    },
  });
  worker.start();
  await started;
  await worker.stop();
  assert.equal(completed.length, 0);
});

test('an extractor exception terminates the row as failed/empty instead of leaving it pending', async () => {
  const completed: ReadableReplicaCompleteInput[] = [];
  const warnings: string[] = [];
  const repository: ReadableReplicaWorkerRepository = {
    async claimDue() {
      return [{ nodeId: 'node-crash', url: URL, leaseOwner: 'rr-crash' }];
    },
    async completeExtract(input) {
      completed.push(input);
      return true;
    },
  };
  const worker = new ReadableReplicaWorkerLoop({
    repository,
    logger: { info() {}, warn(_bindings, message) { warnings.push(message); }, error() {} },
    workerId: 'rr-crash',
    perHostGapMs: 0,
    resolve: async () => [PUBLIC_PIN],
    connect: async () => new Response('<html><body><p>crash me</p></body></html>', {
      status: 200, headers: { 'content-type': 'text/html' },
    }),
    extractor: () => { throw new RangeError('Maximum call stack size exceeded'); },
    now: () => new Date('2026-09-08T00:00:00.000Z'),
  });
  assert.equal(await worker.runOnce(), true);
  assert.equal(completed.length, 1);
  assert.equal(completed[0]?.status, 'failed');
  assert.equal(completed[0]?.failureCode, 'empty');
  assert.equal(completed[0]?.sections.length, 0);
  assert.equal(completed[0]?.extractedAt, null);
  assert.equal(completed[0]?.sourceUrl, URL);
  assert.equal(warnings.some((message) => message.includes('extractor threw')), true);
});

test('a successful extract writes ready with the extractor sections and the normalized source url', async () => {
  const completed: ReadableReplicaCompleteInput[] = [];
  const repository: ReadableReplicaWorkerRepository = {
    async claimDue() {
      return [{ nodeId: 'node-ok', url: `${URL}#fragment`, leaseOwner: 'rr-ok' }];
    },
    async completeExtract(input) {
      completed.push(input);
      return true;
    },
  };
  const worker = new ReadableReplicaWorkerLoop({
    repository,
    logger: silentLogger,
    workerId: 'rr-ok',
    perHostGapMs: 0,
    resolve: async () => [PUBLIC_PIN],
    connect: async () => new Response('<html><body><p>fine</p></body></html>', {
      status: 200, headers: { 'content-type': 'text/html' },
    }),
    extractor: () => ({
      kind: 'article',
      title: 'T',
      byline: null,
      wordCount: 1,
      sections: [{ id: 's0', heading: '', paragraphs: [{ id: 's0-p0', text: 'fine' }] }],
    }),
  });
  assert.equal(await worker.runOnce(), true);
  assert.equal(completed[0]?.status, 'ready');
  assert.equal(completed[0]?.title, 'T');
  assert.equal(completed[0]?.sections[0]?.paragraphs[0]?.text, 'fine');
  assert.equal(completed[0]?.sourceUrl, URL);
  assert.ok(completed[0]?.extractedAt instanceof Date);
});

test('constructor throws when leaseDurationMs is shorter than probeTimeoutMs', () => {
  const repository: ReadableReplicaWorkerRepository = {
    async claimDue() { return []; },
    async completeExtract() { return true; },
  };
  assert.throws(
    () => new ReadableReplicaWorkerLoop({
      repository,
      logger: silentLogger,
      probeTimeoutMs: 8_000,
      leaseDurationMs: 7_999,
    }),
    (error: unknown) => error instanceof RangeError
      && error.message === 'invalid readable-replica worker timing configuration',
  );
});

test('readable-replica host gate releases queues after success and failure', async () => {
  const gate = createReadableReplicaHostGate(0);
  await assert.rejects(
    gate.run('articles.test', async () => { throw new Error('extract failed'); }),
    /extract failed/u,
  );
  await gate.run('articles.test', async () => undefined);
  assert.equal(gate.pendingHostCount(), 0);
  assert.equal(gate.trackedHostCount(), 0);
});
