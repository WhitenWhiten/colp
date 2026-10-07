/**
 * The delivery origin's fixed-class request log is diagnostics-only and must not
 * grow without bound.
 *
 * The route is session-free: every terminal outcome appends an entry, including
 * anonymous invalid-capability 404s, 405s, unsatisfiable-range 416s and limiter
 * 429/503 denials, and the production composition passes no `requestLog`, so the
 * array lives for the process lifetime. Before the bound existed, measured growth
 * under anonymous denial traffic was exactly linear (300 requests -> 300 entries,
 * 600 -> 600).
 */
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { createMemoryDeliveryRequestLimiter } from '../../../src/infrastructure/rate-limit/index.js';
import { DELIVERY_REQUEST_LOG_LIMIT } from '../../../src/transport/delivery-route.js';
import { plainBytes } from '../../support/phase4a-i11-test-helpers.js';
import {
  objectWith,
  startLimiterHarness,
  stopLimiterHarness,
} from '../../support/phase4a-l049-delivery-rate-limit.js';

describe('delivery request log retention is bounded', () => {
  test('anonymous denial traffic cannot grow the fixed-class log without bound', async () => {
    const object = objectWith('ad', plainBytes('retention payload\n'));
    const limiter = createMemoryDeliveryRequestLimiter({
      ip: { maxRequests: 10_000, windowMs: 60_000 },
      token: { maxRequests: 10_000, windowMs: 60_000 },
    });
    const harness = await startLimiterHarness({ limiter, objects: [object] });
    try {
      const attempts = DELIVERY_REQUEST_LOG_LIMIT + 64;
      for (let index = 0; index < attempts; index += 1) {
        const response = await fetch(`${harness.origin}/d/not-a-capability-${index}`);
        assert.equal(response.status, 404, `attempt ${index} must be a fixed zero-body 404`);
        await response.arrayBuffer();
      }

      assert.equal(
        harness.host.requestLog.length,
        DELIVERY_REQUEST_LOG_LIMIT,
        `request log must retain at most ${DELIVERY_REQUEST_LOG_LIMIT} entries`,
      );
      assert.ok(
        harness.host.requestLog.every((entry) => entry.status === 404),
        'retained entries keep their fixed-class shape',
      );
    } finally {
      await stopLimiterHarness(harness);
    }
  }, 120_000);
});
