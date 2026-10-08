/**
 * P-06 overdue invite cleanup schedule. GET-is-read-only lives on the
 * PostgreSQL integration suite (a memory query port cannot mutate rows).
 */
import assert from 'node:assert/strict';
import { afterEach, describe, test, vi } from 'vitest';
import { buildWorker } from '../../../src/bootstrap/worker.js';
import { loadConfig } from '../../support/test-config.js';
import { InMemoryMetrics } from '../../../src/infrastructure/telemetry/index.js';
import {
  scheduleCollaborationInviteCleanup,
} from '../../../src/modules/access-policy/index.js';

const config = loadConfig({
  DATABASE_URL: 'postgres://unused/known',
  OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs',
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Collaboration invite cleanup scheduling', () => {
  test('coalesces overlapping ticks and stop waits for the active expire', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const active = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const schedule = scheduleCollaborationInviteCleanup(
      async () => ({
        expireOverdue: async () => {
          calls += 1;
          await active;
          return 2;
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

  test('worker starts and stops the injected cleanup loop and records metrics', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const metrics = new InMemoryMetrics();
    const worker = buildWorker(config, undefined, metrics, {
      inviteCleanup: async () => ({
        expireOverdue: async () => {
          calls += 1;
          if (calls === 1) throw new Error('temporary');
          return 3;
        },
      }),
    });
    await vi.advanceTimersByTimeAsync(config.collaborationInviteCleanup.cleanupIntervalMs);
    assert.equal(calls, 0);
    await worker.start();
    await vi.advanceTimersByTimeAsync(config.collaborationInviteCleanup.cleanupIntervalMs * 2 + 1);
    assert.equal(calls, 2);
    assert.equal(metrics.get('collaboration.invite_cleanup_error'), 1);
    assert.equal(metrics.get('collaboration.invite_cleanup_runs'), 1);
    assert.equal(metrics.get('collaboration.invite_expired'), 3);
    await worker.stop();
    const stoppedCalls = calls;
    await vi.advanceTimersByTimeAsync(config.collaborationInviteCleanup.cleanupIntervalMs * 2);
    assert.equal(calls, stoppedCalls);
  });
});
