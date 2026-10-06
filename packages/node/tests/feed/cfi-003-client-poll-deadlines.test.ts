import { describe, expect, it } from 'vitest';

import {
  createFeedPollController,
  type FeedPollController,
  type FeedPollResponseHint,
  type FeedPollState,
} from '../../src/feed/client-poll.js';

const evidence = 'feed.cfi-003.poll-deadlines';

function expectSchedule(
  controller: FeedPollController,
  state: FeedPollState,
  nowMs: number,
  reason: 'min_poll' | 'retry_after' | 'backoff',
): void {
  expect(controller.state()).toEqual(state);
  expect(controller.decide(nowMs)).toEqual({
    action: 'wait',
    waitMs: state.nextAllowedAtMs - nowMs,
    reason,
  });

  const headers = state.etag === null || state.etag.length === 0
    ? {}
    : { 'If-None-Match': state.etag };
  expect(controller.decide(state.nextAllowedAtMs)).toEqual({
    action: 'poll',
    headers,
    waitMs: 0,
  });
}

function stableController(random: () => number = () => 0): FeedPollController {
  const controller = createFeedPollController(
    { minPollIntervalSeconds: 60, baseBackoffSeconds: 10, jitterSeconds: 0 },
    { random, initialEtag: '"initial"' },
  );
  controller.observe({ status: 200, etag: '"stable"' }, 10_000);
  return controller;
}

function expectRejectedWithoutStateChange(
  controller: FeedPollController,
  response: unknown,
  nowMs = 20_000,
  error: RegExp | ErrorConstructor = TypeError,
): void {
  const beforeState = controller.state();
  const beforeDecision = controller.decide(nowMs);

  expect(() => controller.observe(response as FeedPollResponseHint, nowMs)).toThrow(error);
  expect(controller.state()).toEqual(beforeState);
  expect(controller.decide(nowMs)).toEqual(beforeDecision);
}

describe(`CFI-003 unified Feed polling deadlines [evidence:${evidence}]`, () => {
  it.each([
    { label: 'less than', retryAfterSeconds: 30, expectedDelaySeconds: 60 },
    { label: 'equal to', retryAfterSeconds: 60, expectedDelaySeconds: 60 },
    { label: 'greater than', retryAfterSeconds: 90, expectedDelaySeconds: 90 },
  ])(
    'uses the later deadline when Retry-After is $label minPoll',
    ({ retryAfterSeconds, expectedDelaySeconds }) => {
      const controller = createFeedPollController(
        { minPollIntervalSeconds: 60 },
        { random: () => 0 },
      );
      const nowMs = 100_000;

      controller.observe({ status: 429, etag: '"retry"', retryAfterSeconds }, nowMs);

      expectSchedule(controller, {
        etag: '"retry"',
        attempt: 1,
        nextAllowedAtMs: nowMs + expectedDelaySeconds * 1000,
        lastStatus: 429,
      }, nowMs, 'retry_after');
    },
  );

  it.each([
    { label: 'less than', baseBackoffSeconds: 10, expectedDelaySeconds: 60 },
    { label: 'greater than', baseBackoffSeconds: 120, expectedDelaySeconds: 120 },
  ])(
    'uses the later deadline when 5xx backoff is $label minPoll',
    ({ baseBackoffSeconds, expectedDelaySeconds }) => {
      const controller = createFeedPollController(
        {
          minPollIntervalSeconds: 60,
          baseBackoffSeconds,
          serverMaxBackoffSeconds: 300,
          jitterSeconds: 0,
        },
        { random: () => 0 },
      );
      const nowMs = 100_000;

      controller.observe({ status: 503, etag: '"unavailable"' }, nowMs);

      expectSchedule(controller, {
        etag: '"unavailable"',
        attempt: 1,
        nextAllowedAtMs: nowMs + expectedDelaySeconds * 1000,
        lastStatus: 503,
      }, nowMs, 'backoff');
    },
  );

  it.each([
    {
      label: 'minPoll later than notBefore',
      response: { status: 200, notBeforeOffsetSeconds: 30 },
      expectedDelaySeconds: 60,
      attempt: 0,
      reason: 'min_poll' as const,
    },
    {
      label: 'notBefore later than minPoll',
      response: { status: 200, notBeforeOffsetSeconds: 90 },
      expectedDelaySeconds: 90,
      attempt: 0,
      reason: 'min_poll' as const,
    },
    {
      label: 'notBefore later than Retry-After',
      response: { status: 429, retryAfterSeconds: 90, notBeforeOffsetSeconds: 120 },
      expectedDelaySeconds: 120,
      attempt: 1,
      reason: 'retry_after' as const,
    },
    {
      label: 'Retry-After later than notBefore',
      response: { status: 429, retryAfterSeconds: 180, notBeforeOffsetSeconds: 120 },
      expectedDelaySeconds: 180,
      attempt: 1,
      reason: 'retry_after' as const,
    },
    {
      label: 'notBefore later than backoff',
      response: { status: 503, notBeforeOffsetSeconds: 120 },
      expectedDelaySeconds: 120,
      attempt: 1,
      reason: 'backoff' as const,
    },
    {
      label: 'backoff later than notBefore',
      response: { status: 503, notBeforeOffsetSeconds: 120 },
      expectedDelaySeconds: 180,
      attempt: 1,
      reason: 'backoff' as const,
      baseBackoffSeconds: 180,
    },
    {
      label: 'Retry-After later than 5xx backoff and notBefore',
      response: {
        status: 503,
        retryAfterSeconds: 240,
        notBeforeOffsetSeconds: 120,
      },
      expectedDelaySeconds: 240,
      attempt: 1,
      reason: 'backoff' as const,
      baseBackoffSeconds: 180,
    },
    {
      label: 'notBefore later than recommended deadline',
      response: { status: 200, recommendedAfterSeconds: 90, notBeforeOffsetSeconds: 120 },
      expectedDelaySeconds: 120,
      attempt: 0,
      reason: 'min_poll' as const,
    },
    {
      label: 'recommended deadline later than notBefore',
      response: { status: 200, recommendedAfterSeconds: 180, notBeforeOffsetSeconds: 120 },
      expectedDelaySeconds: 180,
      attempt: 0,
      reason: 'min_poll' as const,
    },
  ])(
    'combines $label',
    ({ response, expectedDelaySeconds, attempt, reason, baseBackoffSeconds = 90 }) => {
      const nowMs = Date.parse('2026-07-24T00:00:00.000Z');
      const controller = createFeedPollController(
        {
          minPollIntervalSeconds: 60,
          baseBackoffSeconds,
          serverMaxBackoffSeconds: 300,
          jitterSeconds: 0,
        },
        { random: () => 0 },
      );
      const { notBeforeOffsetSeconds, ...hint } = response;

      controller.observe({
        ...hint,
        notBefore: new Date(nowMs + notBeforeOffsetSeconds * 1000).toISOString(),
      }, nowMs);

      expectSchedule(controller, {
        etag: null,
        attempt,
        nextAllowedAtMs: nowMs + expectedDelaySeconds * 1000,
        lastStatus: response.status,
      }, nowMs, reason);
    },
  );

  it.each([
    ['undefined response', undefined],
    ['null response', null],
    ['array response', []],
    ['missing status', {}],
    ['string status', { status: '200' }],
    ['fractional status', { status: 200.5 }],
    ['status below HTTP range', { status: 99 }],
    ['status above HTTP range', { status: 600 }],
    ['numeric ETag', { status: 200, etag: 1 }],
    ['object ETag', { status: 200, etag: {} }],
    ['string Retry-After', { status: 429, retryAfterSeconds: '1' }],
    ['negative Retry-After', { status: 429, retryAfterSeconds: -1 }],
    ['NaN Retry-After', { status: 429, retryAfterSeconds: Number.NaN }],
    ['infinite Retry-After', { status: 429, retryAfterSeconds: Number.POSITIVE_INFINITY }],
    ['string recommended delay', { status: 200, recommendedAfterSeconds: '60' }],
    ['negative recommended delay', { status: 200, recommendedAfterSeconds: -1 }],
    ['NaN recommended delay', { status: 200, recommendedAfterSeconds: Number.NaN }],
    ['infinite recommended delay', { status: 200, recommendedAfterSeconds: Number.POSITIVE_INFINITY }],
    ['numeric notBefore', { status: 200, notBefore: 0 }],
    ['empty notBefore', { status: 200, notBefore: '' }],
    ['unparseable notBefore', { status: 200, notBefore: 'not-a-date' }],
    ['date-only notBefore', { status: 200, notBefore: '2026-07-24' }],
    ['impossible notBefore date', { status: 200, notBefore: '2026-02-30T00:00:00Z' }],
    ['unknown enumerable field', { status: 200, unexpected: true }],
    ['random field in response hint', { status: 200, random: 0.5 }],
  ])('rejects %s atomically', (_label, response) => {
    expectRejectedWithoutStateChange(stableController(), response);
  });

  it('rejects accessors without invoking them and keeps state and decisions unchanged', () => {
    let getterCalls = 0;
    const response = { status: 500 } as Record<string, unknown>;
    Object.defineProperty(response, 'etag', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return '"attacker"';
      },
    });
    const controller = stableController();

    expectRejectedWithoutStateChange(controller, response);
    expect(getterCalls).toBe(0);
  });

  it('rejects a Proxy response without invoking any trap', () => {
    let trapCalls = 0;
    const trapped = (): never => {
      trapCalls += 1;
      throw new Error('response Proxy trap must not run');
    };
    const response = new Proxy(
      { status: 200 },
      {
        get: trapped,
        getOwnPropertyDescriptor: trapped,
        getPrototypeOf: trapped,
        has: trapped,
        ownKeys: trapped,
      },
    );
    const controller = stableController();

    expectRejectedWithoutStateChange(controller, response);
    expect(trapCalls).toBe(0);
  });

  it('rejects symbol and hidden extra fields atomically', () => {
    const symbolResponse: Record<string | symbol, unknown> = { status: 200 };
    symbolResponse[Symbol('hidden')] = true;
    expectRejectedWithoutStateChange(stableController(), symbolResponse);

    const hiddenResponse = { status: 200 } as Record<string, unknown>;
    Object.defineProperty(hiddenResponse, 'unexpected', {
      configurable: true,
      enumerable: false,
      value: true,
    });
    expectRejectedWithoutStateChange(stableController(), hiddenResponse);
  });

  it.each([
    ['NaN', Number.NaN],
    ['positive infinity', Number.POSITIVE_INFINITY],
    ['negative value', -0.01],
    ['value greater than one', 1.01],
    ['non-number', '0.5'],
  ])('rejects invalid random result %s without partially committing state', (_label, value) => {
    const controller = stableController(() => value as number);
    expectRejectedWithoutStateChange(
      controller,
      { status: 503, etag: '"must-not-commit"', notBefore: '2026-07-24T01:00:00.000Z' },
    );
  });

  it('keeps state unchanged when random throws', () => {
    const controller = stableController(() => {
      throw new Error('random failed');
    });
    expectRejectedWithoutStateChange(
      controller,
      { status: 503, etag: '"must-not-commit"' },
      20_000,
      /random failed/,
    );
  });

  it('snapshots the complete response before invoking random', () => {
    const nowMs = Date.parse('2026-07-24T00:00:00.000Z');
    const response: Record<string, unknown> = {
      status: 503,
      etag: '"snapshotted"',
      notBefore: new Date(nowMs + 120_000).toISOString(),
    };
    const controller = createFeedPollController(
      {
        minPollIntervalSeconds: 60,
        baseBackoffSeconds: 10,
        serverMaxBackoffSeconds: 300,
        jitterSeconds: 1,
      },
      {
        random: () => {
          response.status = 200;
          response.etag = '"mutated"';
          response.notBefore = new Date(nowMs + 1_000).toISOString();
          return 0;
        },
      },
    );

    controller.observe(response as unknown as FeedPollResponseHint, nowMs);

    expectSchedule(controller, {
      etag: '"snapshotted"',
      attempt: 1,
      nextAllowedAtMs: nowMs + 120_000,
      lastStatus: 503,
    }, nowMs, 'backoff');
  });

  it('rejects extremely large finite response delays without changing state', () => {
    expectRejectedWithoutStateChange(stableController(), {
      status: 429,
      etag: '"must-not-commit"',
      retryAfterSeconds: Number.MAX_VALUE,
    });
    expectRejectedWithoutStateChange(stableController(), {
      status: 200,
      etag: '"must-not-commit"',
      recommendedAfterSeconds: Number.MAX_VALUE,
    });
  });

  it('rejects finite seconds whose millisecond conversion is not a safe integer', () => {
    const unsafeSeconds = Math.floor(Number.MAX_SAFE_INTEGER / 1000) + 1;

    expectRejectedWithoutStateChange(stableController(), {
      status: 429,
      etag: '"must-not-commit"',
      retryAfterSeconds: unsafeSeconds,
    });

    expect(() => createFeedPollController({
      minPollIntervalSeconds: unsafeSeconds,
    })).toThrow(TypeError);

    expect(() => createFeedPollController(
      {
        minPollIntervalSeconds: 1,
        baseBackoffSeconds: unsafeSeconds,
        serverMaxBackoffSeconds: unsafeSeconds,
        jitterSeconds: 0,
      },
      { random: () => 0 },
    )).toThrow(TypeError);
  });

  it('rejects now plus delay overflow without partially committing state', () => {
    const controller = createFeedPollController(
      { minPollIntervalSeconds: 1 },
      { initialEtag: '"initial"', random: () => 0 },
    );
    const nowMs = Number.MAX_SAFE_INTEGER - 500;

    expectRejectedWithoutStateChange(
      controller,
      { status: 200, etag: '"must-not-commit"' },
      nowMs,
    );
  });

  it('rejects an extremely large finite nowMs without changing state', () => {
    const controller = stableController();
    const beforeState = controller.state();
    const beforeDecision = controller.decide(20_000);

    expect(() => controller.observe({ status: 200 }, Number.MAX_VALUE)).toThrow(TypeError);
    expect(controller.state()).toEqual(beforeState);
    expect(controller.decide(20_000)).toEqual(beforeDecision);
  });

  it('does not shorten an established deadline when the clock moves backward', () => {
    const controller = createFeedPollController(
      { minPollIntervalSeconds: 60 },
      { initialEtag: '"initial"', random: () => 0 },
    );

    controller.observe({ status: 429, retryAfterSeconds: 200 }, 100_000);
    expect(controller.state()).toEqual({
      etag: '"initial"',
      attempt: 1,
      nextAllowedAtMs: 300_000,
      lastStatus: 429,
    });

    controller.observe({ status: 200, etag: '"fresh"' }, 50_000);

    expectSchedule(controller, {
      etag: '"fresh"',
      attempt: 0,
      nextAllowedAtMs: 300_000,
      lastStatus: 200,
    }, 250_000, 'retry_after');
  });

  describe('bounded and failure-tolerant schedules', () => {
    const now = 1_760_000_000_000;

    it('backs off on a 429 without Retry-After instead of polling again at once', () => {
      const controller = createFeedPollController(
        { minPollIntervalSeconds: 1, baseBackoffSeconds: 8, jitterSeconds: 0 },
        { random: () => 0 },
      );
      controller.observe({ status: 429 }, now);
      expect(controller.state().attempt).toBe(1);
      expect(controller.decide(now)).toEqual({ action: 'wait', waitMs: 8_000, reason: 'backoff' });
      controller.observe({ status: 429 }, now + 8_000);
      expect(controller.decide(now + 8_000)).toEqual({ action: 'wait', waitMs: 16_000, reason: 'backoff' });
    });

    it('backs off after a network error and keeps the ETag', () => {
      const controller = createFeedPollController(
        { minPollIntervalSeconds: 1, baseBackoffSeconds: 4, jitterSeconds: 0 },
        { random: () => 0, initialEtag: '"v1"' },
      );
      expect(controller.observeNetworkError(now)).toEqual({
        etag: '"v1"', attempt: 1, nextAllowedAtMs: now + 4_000, lastStatus: null,
      });
      expect(controller.decide(now)).toEqual({ action: 'wait', waitMs: 4_000, reason: 'backoff' });
      controller.observe({ status: 200 }, now + 4_000);
      expect(controller.state().attempt).toBe(0);
    });

    it.each([
      ['Retry-After', { status: 429, retryAfterSeconds: 1_000_000_000 }, 'retry_after'],
      ['recommendedAfterSeconds', { status: 200, recommendedAfterSeconds: 1_000_000_000 }, 'min_poll'],
      ['notBefore', { status: 200, notBefore: '2999-01-01T00:00:00Z' }, 'min_poll'],
    ] as const)('caps an extreme %s at maxDeferralSeconds', (_label, response, reason) => {
      const controller = createFeedPollController({ minPollIntervalSeconds: 60, maxDeferralSeconds: 600 });
      controller.observe(response, now);
      expect(controller.decide(now)).toEqual({ action: 'wait', waitMs: 600_000, reason });
    });

    it('defaults the ceiling to one day and recovers once it has passed', () => {
      const controller = createFeedPollController({ minPollIntervalSeconds: 60 });
      controller.observe({ status: 429, retryAfterSeconds: 1_000_000_000 }, now);
      expect(controller.decide(now)).toEqual({ action: 'wait', waitMs: 86_400_000, reason: 'retry_after' });
      expect(controller.decide(now + 86_400_000).action).toBe('poll');
    });

    it('re-bounds a kept deadline when the clock steps back', () => {
      const controller = createFeedPollController({ minPollIntervalSeconds: 60, maxDeferralSeconds: 600 });
      controller.observe({ status: 429, retryAfterSeconds: 600 }, now);
      const steppedBack = now - 10 * 86_400_000;
      controller.observe({ status: 200 }, steppedBack);
      expect(controller.decide(steppedBack)).toEqual({ action: 'wait', waitMs: 600_000, reason: 'retry_after' });
    });

    it('rejects a ceiling below the manifest minimum', () => {
      expect(() => createFeedPollController({ minPollIntervalSeconds: 60, maxDeferralSeconds: 59 })).toThrow(TypeError);
    });
  });
});
