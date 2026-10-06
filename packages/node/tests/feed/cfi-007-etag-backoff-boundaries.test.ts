import { describe, expect, it } from 'vitest';

import {
  computeFeedBackoffSeconds,
  createFeedPollController,
  type FeedPollController,
  type FeedPollLimits,
  type FeedPollResponseHint,
} from '../../src/feed/client-poll.js';

const evidence = 'feed.client-poll';
const MAX_ETAG_LENGTH = 1024;
const MAX_SAFE_DELAY_SECONDS = Math.floor(Number.MAX_SAFE_INTEGER / 1000);

function stableController(random: () => number = () => 0): FeedPollController {
  const controller = createFeedPollController(
    {
      minPollIntervalSeconds: 60,
      baseBackoffSeconds: 10,
      serverMaxBackoffSeconds: 300,
      jitterSeconds: 0,
    },
    { initialEtag: 'W/"stable"', random },
  );
  controller.observe({ status: 200, etag: '"observed"' }, 10_000);
  return controller;
}

function expectRejectedObserveWithoutChange(
  response: unknown,
  controller = stableController(),
  nowMs = 20_000,
  error: RegExp | ErrorConstructor = TypeError,
): void {
  const beforeState = controller.state();
  const beforeDecision = controller.decide(nowMs);

  expect(() => controller.observe(response as FeedPollResponseHint, nowMs)).toThrow(error);
  expect(controller.state()).toEqual(beforeState);
  expect(controller.state().etag).toBe(beforeState.etag);
  expect(controller.decide(nowMs)).toEqual(beforeDecision);
}

function hiddenProperty(
  source: Record<string, unknown>,
  name: string,
  value: unknown,
): Record<string, unknown> {
  Object.defineProperty(source, name, {
    configurable: true,
    enumerable: false,
    value,
  });
  return source;
}

function trappedProxy<T extends object>(target: T, onTrap: () => never): T {
  return new Proxy(target, {
    get: onTrap,
    getOwnPropertyDescriptor: onTrap,
    getPrototypeOf: onTrap,
    has: onTrap,
    ownKeys: onTrap,
  });
}

describe(`CFI-007 Feed ETag boundaries [evidence:${evidence}]`, () => {
  it.each([
    ['empty strong tag', '""'],
    ['empty weak tag', 'W/""'],
    ['strong tag', '"strong"'],
    ['weak tag', 'W/"weak"'],
    ['legal visible etagc', '"!#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~"'],
    ['comma inside opaque tag', '"one,two"'],
    ['obs-text bytes', '"\u0080\u00ff"'],
  ])('accepts a legal single %s verbatim', (_label, etag) => {
    const initial = createFeedPollController(
      { minPollIntervalSeconds: 1 },
      { initialEtag: etag, random: () => 0 },
    );

    expect(initial.state().etag).toBe(etag);
    expect(initial.decide(0)).toEqual({
      action: 'poll',
      headers: { 'If-None-Match': etag },
      waitMs: 0,
    });

    const observed = createFeedPollController(
      { minPollIntervalSeconds: 1 },
      { random: () => 0 },
    );
    observed.observe({ status: 200, etag }, 0);
    expect(observed.state().etag).toBe(etag);
    expect(observed.decide(1_000)).toEqual({
      action: 'poll',
      headers: { 'If-None-Match': etag },
      waitMs: 0,
    });
  });

  it('accepts the ETag length limit and rejects the next code unit', () => {
    const maximumStrong = `"${'a'.repeat(MAX_ETAG_LENGTH - 2)}"`;
    const maximumWeak = `W/"${'b'.repeat(MAX_ETAG_LENGTH - 4)}"`;
    const tooLong = `"${'c'.repeat(MAX_ETAG_LENGTH - 1)}"`;

    for (const etag of [maximumStrong, maximumWeak]) {
      const controller = createFeedPollController(
        { minPollIntervalSeconds: 1 },
        { initialEtag: etag, random: () => 0 },
      );
      expect(controller.decide(0)).toMatchObject({
        action: 'poll',
        headers: { 'If-None-Match': etag },
      });
    }

    expect(() => createFeedPollController(
      { minPollIntervalSeconds: 1 },
      { initialEtag: tooLong, random: () => 0 },
    )).toThrow(TypeError);
    expectRejectedObserveWithoutChange({ status: 200, etag: tooLong });
  });

  it.each([
    ['empty string', ''],
    ['bare token', 'opaque'],
    ['wildcard', '*'],
    ['lower-case weak marker', 'w/"tag"'],
    ['long weak marker', 'Weak/"tag"'],
    ['space in weak marker', 'W /"tag"'],
    ['missing weak slash', 'W"tag"'],
    ['multiple tags', '"one", "two"'],
    ['wildcard after tag', '"one", *'],
    ['unterminated tag', '"tag'],
    ['trailing data', '"tag"x'],
    ['embedded quote', '"a"b"'],
    ['unicode above obs-text', '"\u0100"'],
  ])('rejects %s at initial and observe boundaries', (_label, etag) => {
    expect(() => createFeedPollController(
      { minPollIntervalSeconds: 1 },
      { initialEtag: etag, random: () => 0 },
    )).toThrow(TypeError);
    expectRejectedObserveWithoutChange({ status: 200, etag });
  });

  it.each([
    ...Array.from({ length: 0x21 }, (_unused, code) => code),
    0x7f,
  ])('rejects control or whitespace U+%s inside an ETag', (code) => {
    const etag = `"before${String.fromCharCode(code)}after"`;

    expect(() => createFeedPollController(
      { minPollIntervalSeconds: 1 },
      { initialEtag: etag, random: () => 0 },
    )).toThrow(TypeError);
    expectRejectedObserveWithoutChange({ status: 200, etag });
  });

  it.each([
    ['CRLF injection', '"safe"\r\nX-Injected: true'],
    ['bare carriage return', '"carriage\rreturn"'],
    ['bare line feed', '"line\nfeed"'],
  ])('rejects %s without emitting or saving it', (_label, etag) => {
    expect(() => createFeedPollController(
      { minPollIntervalSeconds: 1 },
      { initialEtag: etag, random: () => 0 },
    )).toThrow(TypeError);
    expectRejectedObserveWithoutChange({ status: 200, etag });
  });

  it('can explicitly clear a saved ETag without emitting a header', () => {
    const controller = stableController();

    controller.observe({ status: 200, etag: null }, 70_000);

    expect(controller.state().etag).toBeNull();
    expect(controller.decide(130_000)).toEqual({
      action: 'poll',
      headers: {},
      waitMs: 0,
    });
  });
});

describe(`CFI-007 standalone Feed backoff boundaries [evidence:${evidence}]`, () => {
  it('accepts valid boundary values and applies bounded jitter', () => {
    expect(computeFeedBackoffSeconds({
      attempt: 0,
      baseSeconds: 1,
      serverMaxSeconds: 10,
      jitterSeconds: 0,
      random: () => 0,
    })).toBe(1);
    expect(computeFeedBackoffSeconds({
      attempt: 3,
      baseSeconds: 2,
      serverMaxSeconds: 10,
      jitterSeconds: 0.5,
      random: () => 1,
    })).toBe(10.5);
  });

  it.each([
    ['negative', -1],
    ['fractional', 0.5],
    ['NaN', Number.NaN],
    ['positive infinity', Number.POSITIVE_INFINITY],
    ['unsafe integer', Number.MAX_SAFE_INTEGER + 1],
  ])('rejects a %s attempt', (_label, attempt) => {
    expect(() => computeFeedBackoffSeconds({ attempt })).toThrow(TypeError);
  });

  it.each([
    ['baseSeconds', 0],
    ['baseSeconds', -1],
    ['baseSeconds', 1.5],
    ['baseSeconds', Number.NaN],
    ['baseSeconds', Number.POSITIVE_INFINITY],
    ['baseSeconds', Number.MAX_SAFE_INTEGER + 1],
    ['baseSeconds', MAX_SAFE_DELAY_SECONDS + 1],
    ['serverMaxSeconds', 0],
    ['serverMaxSeconds', -1],
    ['serverMaxSeconds', 1.5],
    ['serverMaxSeconds', Number.NaN],
    ['serverMaxSeconds', Number.POSITIVE_INFINITY],
    ['serverMaxSeconds', Number.MAX_SAFE_INTEGER + 1],
    ['serverMaxSeconds', MAX_SAFE_DELAY_SECONDS + 1],
    ['jitterSeconds', -1],
    ['jitterSeconds', Number.NaN],
    ['jitterSeconds', Number.POSITIVE_INFINITY],
    ['jitterSeconds', Number.MAX_VALUE],
  ] as const)('rejects invalid %s value %s', (field, value) => {
    expect(() => computeFeedBackoffSeconds({
      attempt: 0,
      [field]: value,
      random: () => 0,
    })).toThrow(TypeError);
  });

  it('caps exponential multiplication and rejects addition or millisecond-range overflow', () => {
    expect(() => computeFeedBackoffSeconds({
      attempt: 0,
      baseSeconds: MAX_SAFE_DELAY_SECONDS + 1,
      serverMaxSeconds: MAX_SAFE_DELAY_SECONDS + 1,
      jitterSeconds: 0,
      random: () => 0,
    })).toThrow(TypeError);

    expect(() => computeFeedBackoffSeconds({
      attempt: 0,
      baseSeconds: 1,
      serverMaxSeconds: MAX_SAFE_DELAY_SECONDS,
      jitterSeconds: 1,
      random: () => 1,
    })).toThrow(TypeError);

    expect(() => computeFeedBackoffSeconds({
      attempt: Number.MAX_SAFE_INTEGER,
      baseSeconds: MAX_SAFE_DELAY_SECONDS,
      serverMaxSeconds: MAX_SAFE_DELAY_SECONDS,
      jitterSeconds: 0,
      random: () => 0,
    })).not.toThrow();
  });

  it.each([
    ['negative', -0.01],
    ['greater than one', 1.01],
    ['NaN', Number.NaN],
    ['positive infinity', Number.POSITIVE_INFINITY],
    ['non-number', '0.5'],
  ])('rejects a custom random result that is %s', (_label, value) => {
    expect(() => computeFeedBackoffSeconds({
      attempt: 0,
      random: () => value as number,
    })).toThrow(TypeError);
  });

  it.each([
    ['baseBackoffSeconds', 0],
    ['baseBackoffSeconds', 1.5],
    ['serverMaxBackoffSeconds', 0],
    ['serverMaxBackoffSeconds', Number.POSITIVE_INFINITY],
    ['jitterSeconds', -1],
    ['jitterSeconds', Number.NaN],
  ] as const)('applies the standalone numeric constraint to controller %s', (field, value) => {
    expect(() => createFeedPollController({
      minPollIntervalSeconds: 1,
      [field]: value,
    })).toThrow(TypeError);
  });

  it('requires non-negative safe controller times without changing state', () => {
    const controller = stableController();
    const state = controller.state();
    const decision = controller.decide(20_000);

    expect(() => controller.decide(-1)).toThrow(TypeError);
    expect(() => controller.observe({ status: 200, etag: '"must-not-commit"' }, -1))
      .toThrow(TypeError);
    expect(controller.state()).toEqual(state);
    expect(controller.decide(20_000)).toEqual(decision);
  });

  it('propagates a custom random exception', () => {
    expect(() => computeFeedBackoffSeconds({
      attempt: 0,
      random: () => {
        throw new Error('random failed');
      },
    })).toThrow(/random failed/);
  });

  it.each([
    ['negative', (): number => -0.01, TypeError],
    ['greater than one', (): number => 1.01, TypeError],
    ['NaN', (): number => Number.NaN, TypeError],
    ['infinite', (): number => Number.POSITIVE_INFINITY, TypeError],
    ['exception', (): number => { throw new Error('controller random failed'); }, /controller random failed/],
  ] as const)('keeps controller state, ETag, and decision unchanged for %s random', (
    _label,
    random,
    error,
  ) => {
    expectRejectedObserveWithoutChange(
      { status: 503, etag: '"must-not-commit"' },
      stableController(random),
      20_000,
      error,
    );
  });

  it('rejects random-driven observe re-entry without allowing a failed outer observe to commit', () => {
    let controller: FeedPollController | undefined;
    let reentryError: unknown;
    const random = (): number => {
      try {
        controller?.observe({ status: 200, etag: '"reentered"' }, 20_000);
      } catch (error) {
        reentryError = error;
      }
      return -1;
    };
    controller = stableController(random);
    const beforeState = controller.state();
    const beforeDecision = controller.decide(20_000);

    expect(() => controller?.observe(
      { status: 503, etag: '"must-not-commit"' },
      20_000,
    )).toThrow(TypeError);
    expect(reentryError).toBeInstanceOf(TypeError);
    expect(controller.state()).toEqual(beforeState);
    expect(controller.decide(20_000)).toEqual(beforeDecision);
  });
});

describe(`CFI-007 exact own-data inputs [evidence:${evidence}]`, () => {
  it('rejects limit and option accessors without invoking them', () => {
    let limitGetterCalls = 0;
    const limits = {} as Record<string, unknown>;
    Object.defineProperty(limits, 'minPollIntervalSeconds', {
      enumerable: true,
      get: () => {
        limitGetterCalls += 1;
        return 1;
      },
    });
    expect(() => createFeedPollController(limits as unknown as FeedPollLimits)).toThrow(TypeError);
    expect(limitGetterCalls).toBe(0);

    let optionGetterCalls = 0;
    const options = {} as Record<string, unknown>;
    Object.defineProperty(options, 'initialEtag', {
      enumerable: true,
      get: () => {
        optionGetterCalls += 1;
        return '"attacker"';
      },
    });
    expect(() => createFeedPollController(
      { minPollIntervalSeconds: 1 },
      options as { initialEtag?: string },
    )).toThrow(TypeError);
    expect(optionGetterCalls).toBe(0);
  });

  it('rejects response and backoff accessors without invoking them', () => {
    let responseGetterCalls = 0;
    const response = { status: 200 } as Record<string, unknown>;
    Object.defineProperty(response, 'etag', {
      enumerable: true,
      get: () => {
        responseGetterCalls += 1;
        return '"attacker"';
      },
    });
    expectRejectedObserveWithoutChange(response);
    expect(responseGetterCalls).toBe(0);

    let backoffGetterCalls = 0;
    const backoff = {} as Record<string, unknown>;
    Object.defineProperty(backoff, 'attempt', {
      enumerable: true,
      get: () => {
        backoffGetterCalls += 1;
        return 0;
      },
    });
    expect(() => computeFeedBackoffSeconds(
      backoff as unknown as Parameters<typeof computeFeedBackoffSeconds>[0],
    )).toThrow(TypeError);
    expect(backoffGetterCalls).toBe(0);
  });

  it('rejects Proxy inputs without invoking any trap', () => {
    let trapCalls = 0;
    const trapped = (): never => {
      trapCalls += 1;
      throw new Error('Proxy trap must not run');
    };

    expect(() => createFeedPollController(
      trappedProxy({ minPollIntervalSeconds: 1 }, trapped),
    )).toThrow(TypeError);
    expect(() => createFeedPollController(
      { minPollIntervalSeconds: 1 },
      trappedProxy({ initialEtag: '"safe"' }, trapped),
    )).toThrow(TypeError);
    expectRejectedObserveWithoutChange(trappedProxy({ status: 200 }, trapped));
    expect(() => computeFeedBackoffSeconds(
      trappedProxy({ attempt: 0 }, trapped),
    )).toThrow(TypeError);

    const randomProxy = trappedProxy(() => 0, trapped);
    expect(() => createFeedPollController(
      { minPollIntervalSeconds: 1 },
      { random: randomProxy },
    )).toThrow(TypeError);
    expect(() => computeFeedBackoffSeconds({
      attempt: 0,
      random: randomProxy,
    })).toThrow(TypeError);
    expect(trapCalls).toBe(0);
  });

  it('rejects symbol keys at every input boundary', () => {
    const symbol = Symbol('unexpected');
    const limits: Record<string | symbol, unknown> = { minPollIntervalSeconds: 1 };
    limits[symbol] = true;
    expect(() => createFeedPollController(
      limits as unknown as FeedPollLimits,
    )).toThrow(TypeError);

    const options: Record<string | symbol, unknown> = { random: () => 0 };
    options[symbol] = true;
    expect(() => createFeedPollController(
      { minPollIntervalSeconds: 1 },
      options as { random?: () => number },
    )).toThrow(TypeError);

    const response: Record<string | symbol, unknown> = { status: 200 };
    response[symbol] = true;
    expectRejectedObserveWithoutChange(response);

    const backoff: Record<string | symbol, unknown> = { attempt: 0 };
    backoff[symbol] = true;
    expect(() => computeFeedBackoffSeconds(
      backoff as unknown as Parameters<typeof computeFeedBackoffSeconds>[0],
    )).toThrow(TypeError);
  });

  it('rejects unknown enumerable fields at every input boundary', () => {
    expect(() => createFeedPollController({
      minPollIntervalSeconds: 1,
      unexpected: true,
    } as FeedPollLimits)).toThrow(TypeError);
    expect(() => createFeedPollController(
      { minPollIntervalSeconds: 1 },
      { random: () => 0, unexpected: true } as { random?: () => number },
    )).toThrow(TypeError);
    expectRejectedObserveWithoutChange({ status: 200, unexpected: true });
    expect(() => computeFeedBackoffSeconds({
      attempt: 0,
      unexpected: true,
    } as Parameters<typeof computeFeedBackoffSeconds>[0])).toThrow(TypeError);
  });

  it('rejects non-enumerable fields at every input boundary', () => {
    expect(() => createFeedPollController(hiddenProperty(
      { minPollIntervalSeconds: 1 },
      'jitterSeconds',
      0,
    ) as unknown as FeedPollLimits)).toThrow(TypeError);
    expect(() => createFeedPollController(
      { minPollIntervalSeconds: 1 },
      hiddenProperty({ random: () => 0 }, 'initialEtag', '"hidden"'),
    )).toThrow(TypeError);
    expectRejectedObserveWithoutChange(hiddenProperty({ status: 200 }, 'etag', '"hidden"'));
    expect(() => computeFeedBackoffSeconds(hiddenProperty(
      { attempt: 0 },
      'baseSeconds',
      1,
    ) as unknown as Parameters<typeof computeFeedBackoffSeconds>[0])).toThrow(TypeError);
  });
});
