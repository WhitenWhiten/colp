import { describe, expect, it } from 'vitest';

import {
  computeFeedBackoffSeconds,
  createFeedPollController,
} from '../../src/feed/client-poll.js';

const evidence = 'feed.client-poll';

describe(`FEED-0008 client poll/backoff [evidence:${evidence}]`, () => {
  it(`[success] enforces minPollIntervalSeconds after success [evidence:${evidence}]`, () => {
    const controller = createFeedPollController(
      { minPollIntervalSeconds: 60 },
      { random: () => 0 },
    );
    const t0 = 1_000_000;
    expect(controller.decide(t0)).toMatchObject({ action: 'poll', waitMs: 0 });
    controller.observe({ status: 200, etag: '"v1"', recommendedAfterSeconds: 60 }, t0);
    const decision = controller.decide(t0 + 30_000);
    expect(decision.action).toBe('wait');
    if (decision.action === 'wait') {
      expect(decision.reason).toBe('min_poll');
      expect(decision.waitMs).toBe(30_000);
    }
    expect(controller.decide(t0 + 60_000).action).toBe('poll');
  });

  it(`[success] sends If-None-Match when ETag known [evidence:${evidence}]`, () => {
    const controller = createFeedPollController(
      { minPollIntervalSeconds: 1 },
      { random: () => 0, initialEtag: '"abc"' },
    );
    const decision = controller.decide(0);
    expect(decision.action).toBe('poll');
    if (decision.action === 'poll') {
      expect(decision.headers['If-None-Match']).toBe('"abc"');
    }
  });

  it(`[success] uses Retry-After on 429 [evidence:${evidence}]`, () => {
    const controller = createFeedPollController(
      { minPollIntervalSeconds: 1 },
      { random: () => 0 },
    );
    const t0 = 0;
    controller.observe({ status: 429, retryAfterSeconds: 120 }, t0);
    const decision = controller.decide(t0 + 10_000);
    expect(decision.action).toBe('wait');
    if (decision.action === 'wait') {
      expect(decision.reason).toBe('retry_after');
      expect(decision.waitMs).toBe(110_000);
    }
  });

  it(`[success] exponential backoff with jitter on 5xx [evidence:${evidence}]`, () => {
    const controller = createFeedPollController(
      {
        minPollIntervalSeconds: 1,
        baseBackoffSeconds: 2,
        serverMaxBackoffSeconds: 100,
        jitterSeconds: 1,
      },
      { random: () => 0.5 },
    );
    const t0 = 0;
    controller.observe({ status: 503 }, t0);
    // attempt=1: min(100, 2 * 2^0) + 0.5 = 2.5s
    const decision = controller.decide(t0);
    expect(decision.action).toBe('wait');
    if (decision.action === 'wait') {
      expect(decision.reason).toBe('backoff');
      expect(decision.waitMs).toBe(2500);
    }
    controller.observe({ status: 500 }, t0 + 2500);
    // attempt=2: min(100, 2 * 2^1) + 0.5 = 4.5s
    const second = controller.decide(t0 + 2500);
    expect(second.action).toBe('wait');
    if (second.action === 'wait') expect(second.waitMs).toBe(4500);
  });

  it(`[success] successful response resets backoff attempt [evidence:${evidence}]`, () => {
    const controller = createFeedPollController(
      { minPollIntervalSeconds: 10, baseBackoffSeconds: 2, jitterSeconds: 0 },
      { random: () => 0 },
    );
    controller.observe({ status: 500 }, 0);
    expect(controller.state().attempt).toBe(1);
    controller.observe({ status: 200, etag: '"ok"' }, 10_000);
    expect(controller.state().attempt).toBe(0);
    expect(controller.state().etag).toBe('"ok"');
  });

  it(`[success] computeFeedBackoffSeconds matches formula [evidence:${evidence}]`, () => {
    const delay = computeFeedBackoffSeconds({
      attempt: 3,
      baseSeconds: 1,
      serverMaxSeconds: 100,
      jitterSeconds: 0,
      random: () => 0,
    });
    // min(100, 1 * 2^3) + 0 = 8
    expect(delay).toBe(8);
  });

  it(`[boundary] rejects invalid limits and backs off on 429 without Retry-After [evidence:${evidence}]`, () => {
    expect(() => createFeedPollController({ minPollIntervalSeconds: 0 })).toThrow();
    const controller = createFeedPollController(
      { minPollIntervalSeconds: 1 },
      { random: () => 0 },
    );
    controller.observe({ status: 429 }, 0);
    expect(controller.decide(0)).toEqual({ action: 'wait', waitMs: 1_000, reason: 'backoff' });
  });

  it(`[regression] 304 still enforces min poll and preserves ETag [evidence:${evidence}]`, () => {
    const controller = createFeedPollController(
      { minPollIntervalSeconds: 30 },
      { random: () => 0, initialEtag: '"v1"' },
    );
    controller.observe({ status: 304, etag: '"v1"' }, 0);
    expect(controller.state().etag).toBe('"v1"');
    expect(controller.decide(10_000).action).toBe('wait');
  });
});
