import assert from 'node:assert/strict';
import { afterEach, describe, test, vi } from 'vitest';
import { buildWorker } from '../../../src/bootstrap/worker.js';
import { loadConfig } from '../../support/test-config.js';
import { InMemoryMetrics } from '../../../src/infrastructure/telemetry/index.js';
import { schedulePublicationInsightPurge } from '../../../src/modules/publication/index.js';

const config = loadConfig({ DATABASE_URL: 'postgres://unused/known',
  OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs' });

afterEach(() => {
  vi.useRealTimers();
});

describe('Publication insight purge scheduling', () => {
  test('coalesces overlapping ticks and stop waits for the active purge', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const active = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const schedule = schedulePublicationInsightPurge(
      async () => ({
        purgeExpired: async () => {
          calls += 1;
          await active;
          return { events: 2, daily: 1 };
        },
      }),
      { intervalMs: 10, batchSize: 4 },
    );

    await vi.advanceTimersByTimeAsync(35);
    assert.equal(calls, 1);
    let stopped = false;
    const stopping = schedule.stop().then(() => { stopped = true; });
    await Promise.resolve();
    assert.equal(stopped, false);
    release();
    await stopping;
    assert.equal(stopped, true);
  });

  test('reports failures without unhandled rejection and continues on the next tick', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const purged: Array<{ events: number; daily: number }> = [];
    const errors: unknown[] = [];
    const schedule = schedulePublicationInsightPurge(
      async () => ({
        purgeExpired: async () => {
          calls += 1;
          if (calls === 1) throw new Error('temporary');
          return { events: 3, daily: 2 };
        },
      }),
      {
        intervalMs: 10,
        batchSize: 4,
        onPurged: (counts) => purged.push(counts),
        onError: (error) => { errors.push(error); throw new Error('observer failed'); },
      },
    );
    await vi.advanceTimersByTimeAsync(25);
    await schedule.stop();
    assert.equal(calls, 2);
    assert.equal(errors.length, 1);
    assert.deepEqual(purged, [{ events: 3, daily: 2 }]);
  });

  test('worker starts and stops the injected maintenance loop and records success/failure metrics', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const metrics = new InMemoryMetrics();
    const worker = buildWorker(config, undefined, metrics, {
      insightMaintenance: async () => ({
        purgeExpired: async () => {
          calls += 1;
          if (calls === 1) throw new Error('temporary');
          return { events: 5, daily: 4 };
        },
      }),
    });
    await vi.advanceTimersByTimeAsync(config.publicationInsightRetention.cleanupIntervalMs);
    assert.equal(calls, 0);
    await worker.start();
    await vi.advanceTimersByTimeAsync(config.publicationInsightRetention.cleanupIntervalMs * 2 + 1);
    assert.equal(calls, 2);
    assert.equal(metrics.get('publication.insight_cleanup_error'), 1);
    assert.equal(metrics.get('publication.insight_cleanup_runs'), 1);
    assert.equal(metrics.get('publication.insight_purged_events'), 5);
    assert.equal(metrics.get('publication.insight_purged_daily'), 4);
    await worker.stop();
    const stoppedCalls = calls;
    await vi.advanceTimersByTimeAsync(config.publicationInsightRetention.cleanupIntervalMs * 2);
    assert.equal(calls, stoppedCalls);
  });
});
