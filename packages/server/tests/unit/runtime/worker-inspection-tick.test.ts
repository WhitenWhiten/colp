import assert from 'node:assert/strict';
import { afterEach, describe, test, vi } from 'vitest';
import { runWorkerInspectionTick } from '../../../src/bootstrap/worker-inspection-tick.js';
import { buildWorker } from '../../../src/bootstrap/worker.js';
import { loadConfig } from '../../support/test-config.js';
import { InMemoryMetrics } from '../../../src/infrastructure/telemetry/index.js';

const config = loadConfig({
  DATABASE_URL: 'postgres://unused/known',
  OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs',
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Worker inspection ticks', () => {
  test('reports inspect failures without rejecting and continues on the next tick', async () => {
    const gate = { running: false };
    let calls = 0;
    const errors: unknown[] = [];
    const inspect = async () => {
      calls += 1;
      if (calls === 1) throw new Error('temporary');
    };
    await runWorkerInspectionTick({
      enabled: true,
      gate,
      inspect,
      onError: (error) => { errors.push(error); throw new Error('observer failed'); },
    });
    assert.equal(calls, 1);
    assert.equal(errors.length, 1);
    assert.equal(gate.running, false);
    await runWorkerInspectionTick({
      enabled: true,
      gate,
      inspect,
      onError: (error) => { errors.push(error); },
    });
    assert.equal(calls, 2);
    assert.equal(errors.length, 1);
  });

  test('coalesces overlapping ticks and skips when disabled', async () => {
    const gate = { running: false };
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const first = runWorkerInspectionTick({
      enabled: true,
      gate,
      inspect: async () => { calls += 1; await held; },
      onError: () => { throw new Error('must not run'); },
    });
    await Promise.resolve();
    assert.equal(gate.running, true);
    await runWorkerInspectionTick({
      enabled: true,
      gate,
      inspect: async () => { calls += 1; },
      onError: () => { throw new Error('must not run'); },
    });
    await runWorkerInspectionTick({
      enabled: false,
      gate: { running: false },
      inspect: async () => { calls += 1; },
      onError: () => { throw new Error('must not run'); },
    });
    assert.equal(calls, 1);
    release();
    await first;
    assert.equal(gate.running, false);
  });

  test('worker start records inspection errors and keeps later ticks eligible', async () => {
    vi.useFakeTimers();
    let syncCalls = 0;
    let feedCalls = 0;
    let notificationCalls = 0;
    const metrics = new InMemoryMetrics();
    const silent = { info() {}, warn() {}, error() {} };
    const worker = buildWorker(config, undefined, metrics, {
      logger: silent,
      feedOperations: {
        inspectStatus: async () => {
          feedCalls += 1;
          throw new Error('feed inspect failed');
        },
      },
      notificationOperations: {
        inspectStatus: async () => {
          notificationCalls += 1;
          throw new Error('notification inspect failed');
        },
      },
      syncOperations: {
        inspect: async () => {
          syncCalls += 1;
          throw new Error('sync inspect failed');
        },
      },
    });
    await worker.start();
    assert.equal(feedCalls, 1);
    assert.equal(notificationCalls, 1);
    assert.equal(syncCalls, 1);
    assert.equal(metrics.get('feed.operations_inspect_error'), 1);
    assert.equal(metrics.get('notifications.operations_inspect_error'), 1);
    assert.equal(metrics.get('sync.operations_inspect_error'), 1);
    await vi.advanceTimersByTimeAsync(30_001);
    assert.equal(feedCalls, 2);
    assert.equal(notificationCalls, 2);
    assert.equal(syncCalls, 2);
    await worker.stop();
    const stoppedFeed = feedCalls;
    await vi.advanceTimersByTimeAsync(30_000);
    assert.equal(feedCalls, stoppedFeed);
  });
});
