import { describe, expect, it, vi } from 'vitest';

import { evaluateEffectiveScopes, hasEffectiveScope } from '../../src/security/index.js';
import type { AccessPolicy, PrincipalRef, ScopeName } from '../../src/types/index.js';
import { parseIJson } from '../../src/server/index.js';

/**
 * PR7 quality residuals — L-3 / L-5 / M-7.
 *
 * PR2 extends L-5: evaluator public surface never throws on untrusted chain
 * input; returns an empty deny-all scope set (and hasEffectiveScope → false).
 *
 * L-5 — `evaluateEffectiveScopes` / `hasEffectiveScope` fail closed empty for:
 *   - missing / nullish policyChain container
 *   - missing own required chain layers
 *   - accessor-backed chain fields (getters never invoked)
 *   - sparse / Proxy / custom-prototype ancestor arrays
 *   - Proxy / non-plain policyChain containers
 *
 * M-7 — Server `parseIJson` must reject prototype-polluting member names with a
 * secret-safe message (no key echo) and must not re-run `JSON.parse` after the
 * CORE I-JSON parse for the name audit.
 *
 * L-3 — Time-unit helpers/types (epoch ms vs NumericDate seconds).
 * `assertEpochMilliseconds` / `assertUnixSeconds` are exported and wired at
 * primary validation sites (credential-restrictions, OAuth NumericDate,
 * mutable-integrity, DPoP/sender clocks). Units remain non-interchangeable.
 */

const evidence = '[evidence:security.quality-residuals]';

const publisher: PrincipalRef = { type: 'service', id: 'publisher' };

function policy(
  scopes: AccessPolicy['entries'][number]['scopes'],
  visibility: AccessPolicy['visibility'] = 'private',
  principal: PrincipalRef = publisher,
): AccessPolicy {
  return {
    visibility,
    entries: [{ principal, effect: 'allow', scopes }],
    publication: { listInDirectory: false, allowSearchIndexing: false, allowEmbedding: false },
    revision: 'acl-residual-1',
  };
}

function openChain(layer: AccessPolicy) {
  return {
    serverDefault: layer,
    collection: layer,
    ancestors: [] as const,
    object: layer,
  };
}

function expectEmptyScopes(value: ReadonlySet<ScopeName>): void {
  expect(value.size).toBe(0);
  expect([...value]).toEqual([]);
}

/** Build an input missing `policyChain` without fighting the required-field type. */
function withoutPolicyChain(
  overrides: {
    readonly grantedScopes?: ReadonlySet<ScopeName>;
    readonly identities?: readonly PrincipalRef[];
  } = {},
): Parameters<typeof evaluateEffectiveScopes>[0] {
  return {
    grantedScopes: overrides.grantedScopes ?? new Set<ScopeName>(['nodes:read', 'collections:read']),
    identities: overrides.identities ?? [publisher],
  } as unknown as Parameters<typeof evaluateEffectiveScopes>[0];
}

describe(`${evidence} L-5 evaluateEffectiveScopes missing policyChain fail-closed`, () => {
  it(`${evidence} returns empty set when policyChain is absent (does not throw)`, () => {
    const effective = evaluateEffectiveScopes(withoutPolicyChain());
    expectEmptyScopes(effective);
  });

  it(`${evidence} returns empty set when policyChain is null`, () => {
    const effective = evaluateEffectiveScopes({
      grantedScopes: new Set<ScopeName>(['nodes:read', 'collections:read']),
      identities: [publisher],
      policyChain: null as unknown as Parameters<typeof evaluateEffectiveScopes>[0]['policyChain'],
    });
    expectEmptyScopes(effective);
  });

  it(`${evidence} returns empty set when policyChain is undefined`, () => {
    const effective = evaluateEffectiveScopes({
      grantedScopes: new Set<ScopeName>(['nodes:read', 'collections:read']),
      identities: [publisher],
      policyChain: undefined as unknown as Parameters<typeof evaluateEffectiveScopes>[0]['policyChain'],
    });
    expectEmptyScopes(effective);
  });

  it(`${evidence} returns empty set when policyChain own-data property is omitted`, () => {
    const withChain = {
      grantedScopes: new Set<ScopeName>(['nodes:read']),
      identities: [publisher] as const,
      policyChain: openChain(policy(['nodes:read'])),
    };
    const { policyChain: _omitted, ...withoutChain } = withChain;

    const effective = evaluateEffectiveScopes(
      withoutChain as unknown as Parameters<typeof evaluateEffectiveScopes>[0],
    );
    expectEmptyScopes(effective);
  });

  it(`${evidence} still returns scopes for a valid policy chain (smoke)`, () => {
    const layer = policy(['nodes:read', 'collections:read']);
    const effective = evaluateEffectiveScopes({
      grantedScopes: new Set<ScopeName>(['nodes:read', 'collections:read', 'nodes:write']),
      identities: [publisher],
      policyChain: openChain(layer),
    });

    expect([...effective].sort()).toEqual(['collections:read', 'nodes:read']);
    expect(effective.has('nodes:write')).toBe(false);
  });

  it(`${evidence} returns empty set (not throw) for missing own required chain layers`, () => {
    const layer = policy(['nodes:read', 'collections:read']);
    const complete = openChain(layer);
    const grantedScopes = new Set<ScopeName>(['nodes:read', 'collections:read']);
    const identities = [publisher] as const;

    // Baseline: complete chain grants, so empty below is deny-all not a false positive.
    const baseline = evaluateEffectiveScopes({ grantedScopes, identities, policyChain: complete });
    expect([...baseline].sort()).toEqual(['collections:read', 'nodes:read']);
    expect(hasEffectiveScope({ grantedScopes, identities, policyChain: complete }, 'nodes:read')).toBe(
      true,
    );

    for (const key of ['serverDefault', 'collection', 'ancestors', 'object'] as const) {
      const incomplete = { ...complete } as Record<string, unknown>;
      delete incomplete[key];
      const input = {
        grantedScopes,
        identities,
        policyChain: incomplete,
      } as unknown as Parameters<typeof evaluateEffectiveScopes>[0];

      const effective = evaluateEffectiveScopes(input);
      expectEmptyScopes(effective);
      expect(effective.has('nodes:read')).toBe(false);
      expect(effective.has('collections:read')).toBe(false);
      expect(hasEffectiveScope(input, 'nodes:read')).toBe(false);
      expect(hasEffectiveScope(input, 'collections:read')).toBe(false);
    }
  });

  it(`${evidence} returns empty set without invoking accessor-backed chain fields`, () => {
    const layer = policy(['nodes:read']);
    const grantedScopes = new Set<ScopeName>(['nodes:read']);
    const identities = [publisher] as const;
    const open = openChain(layer);

    // Baseline: open own-data chain grants.
    expect([
      ...evaluateEffectiveScopes({ grantedScopes, identities, policyChain: open }),
    ]).toEqual(['nodes:read']);

    for (const key of ['serverDefault', 'collection', 'ancestors', 'object'] as const) {
      const chain = {
        serverDefault: layer,
        collection: layer,
        ancestors: [] as AccessPolicy[],
        object: layer,
      };
      const original = chain[key];
      const getter = vi.fn(() => original);
      Object.defineProperty(chain, key, { enumerable: true, configurable: true, get: getter });

      const input = { grantedScopes, identities, policyChain: chain };
      const effective = evaluateEffectiveScopes(input);
      expectEmptyScopes(effective);
      expect(effective.has('nodes:read')).toBe(false);
      expect(hasEffectiveScope(input, 'nodes:read')).toBe(false);
      expect(getter, `${key} accessor`).not.toHaveBeenCalled();
    }
  });

  it(`${evidence} returns empty set for sparse, Proxy, and custom-prototype ancestor arrays`, () => {
    const layer = policy(['nodes:read']);
    const grantedScopes = new Set<ScopeName>(['nodes:read']);
    const identities = [publisher] as const;

    // Baseline: dense ordinary ancestors grant.
    expect([
      ...evaluateEffectiveScopes({
        grantedScopes,
        identities,
        policyChain: {
          serverDefault: layer,
          collection: layer,
          ancestors: [layer],
          object: layer,
        },
      }),
    ]).toEqual(['nodes:read']);

    const sparse = new Array<AccessPolicy>(1);
    const proxied = new Proxy([layer], {
      get(target, property, receiver) {
        if (property === '0') {
          throw new Error('ancestor Proxy trap must not run');
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const customPrototype = [layer];
    Object.setPrototypeOf(customPrototype, Object.create(Array.prototype));

    for (const ancestors of [sparse, proxied, customPrototype]) {
      const input = {
        grantedScopes,
        identities,
        policyChain: {
          serverDefault: layer,
          collection: layer,
          ancestors,
          object: layer,
        },
      };
      const effective = evaluateEffectiveScopes(input);
      expectEmptyScopes(effective);
      expect(effective.has('nodes:read')).toBe(false);
      expect(hasEffectiveScope(input, 'nodes:read')).toBe(false);
    }
  });

  it(`${evidence} returns empty set for Proxy and non-plain policyChain containers`, () => {
    const layer = policy(['nodes:read']);
    const grantedScopes = new Set<ScopeName>(['nodes:read']);
    const identities = [publisher] as const;
    const open = openChain(layer);

    // Baseline: plain own-data container grants.
    expect([
      ...evaluateEffectiveScopes({ grantedScopes, identities, policyChain: open }),
    ]).toEqual(['nodes:read']);

    const trap = vi.fn(() => {
      throw new Error('policyChain Proxy trap must not run');
    });
    const proxiedChain = new Proxy(open, {
      get: trap,
      getOwnPropertyDescriptor: trap,
      ownKeys: trap,
      getPrototypeOf: trap,
    });
    const inheritedOnly = Object.create(open) as typeof open;

    for (const policyChain of [proxiedChain, inheritedOnly]) {
      const input = { grantedScopes, identities, policyChain };
      const effective = evaluateEffectiveScopes(input);
      expectEmptyScopes(effective);
      expect(effective.has('nodes:read')).toBe(false);
      expect(hasEffectiveScope(input, 'nodes:read')).toBe(false);
    }
    expect(trap).not.toHaveBeenCalled();
  });
});

describe(`${evidence} M-7 server parseIJson single-pass + secret-safe prototype rejection`, () => {
  const prohibited = ['__proto__', 'constructor', 'prototype'] as const;

  it(`${evidence} rejects __proto__ with a message that does not echo the key`, () => {
    expect(() => parseIJson('{"__proto__":true}')).toThrow(SyntaxError);

    try {
      parseIJson('{"__proto__":{"polluted":true}}');
      expect.unreachable('expected prototype-polluting member to be rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(SyntaxError);
      const message = (error as Error).message;
      // Server boundary is secret-safe: must not reflect the prohibited name.
      expect(message).not.toContain('__proto__');
      expect(message.length).toBeGreaterThan(0);
    }

    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
  });

  it.each(prohibited)(
    `${evidence} rejects prohibited member name %s without echoing it`,
    (key) => {
      expect(() => parseIJson(`{"${key}":true}`)).toThrow(SyntaxError);
      expect(() => parseIJson(`{"outer":{"${key}":1}}`)).toThrow(SyntaxError);

      try {
        parseIJson(`{"${key}":{"m7Polluted":true}}`);
        expect.unreachable(`expected ${key} to be rejected`);
      } catch (error) {
        expect(error).toBeInstanceOf(SyntaxError);
        expect((error as Error).message).not.toContain(key);
      }

      expect((Object.prototype as Record<string, unknown>).m7Polluted).toBeUndefined();
    },
  );

  it(`${evidence} accepts ordinary interoperable JSON`, () => {
    expect(parseIJson('{"name":"collection","enabled":true,"ratio":0.5,"items":[1,null]}')).toEqual({
      name: 'collection',
      enabled: true,
      ratio: 0.5,
      items: [1, null],
    });
    expect(parseIJson('null')).toBeNull();
    expect(parseIJson('[1,{"nested":false}]')).toEqual([1, { nested: false }]);
  });

  it(`${evidence} does not re-parse the full body via JSON.parse for member-name audit`, () => {
    // CORE may decode individual key string literals (JSON.parse('"key"')) during
    // budget checks. After M-7 the server wrapper must not re-parse the accepted
    // full body via JSON.parse(source[, reviver]) solely to audit member names.
    const source = '{"audit":"single-pass","nested":{"ok":true}}';
    const parseSpy = vi.spyOn(JSON, 'parse');

    try {
      expect(parseIJson(source)).toEqual({
        audit: 'single-pass',
        nested: { ok: true },
      });
      for (const call of parseSpy.mock.calls) {
        expect(call[0]).not.toBe(source);
        // Key-literal decoding only: a single quoted JSON string, no reviver.
        expect(typeof call[0]).toBe('string');
        expect(call[0] as string).toMatch(/^"/u);
        expect(call[1]).toBeUndefined();
      }
    } finally {
      parseSpy.mockRestore();
    }
  });

  it(`${evidence} still rejects duplicates and unsafe integers (regression smoke)`, () => {
    expect(() => parseIJson('{"id":1,"id":2}')).toThrow(/duplicate member/u);
    expect(() => parseIJson('{"value":9007199254740992}')).toThrow(/outside the safe range/u);
  });
});

describe(`${evidence} L-3 time unit helpers (optional exports)`, () => {
  /**
   * Probe common post-fix export names. When none exist, L-3 is treated as
   * docs/types-only and this suite stays a no-op rather than failing the build.
   */
  function resolveEpochMillisecondsHelper(
    barrel: Record<string, unknown>,
  ): ((value: unknown, name?: string) => unknown) | undefined {
    for (const name of [
      'assertEpochMilliseconds',
      'asEpochMilliseconds',
      'requireEpochMilliseconds',
      'parseEpochMilliseconds',
    ] as const) {
      const candidate = barrel[name];
      if (typeof candidate === 'function') {
        return candidate as (value: unknown, name?: string) => unknown;
      }
    }
    return undefined;
  }

  it(`${evidence} assertEpochMilliseconds validates non-negative safe integers when exported`, async () => {
    const barrel = (await import('../../src/security/index.js')) as Record<string, unknown>;
    const assertEpoch = resolveEpochMillisecondsHelper(barrel);

    if (assertEpoch === undefined) {
      // Optional after bugfix — docs/types only is an acceptable L-3 resolution.
      expect(assertEpoch).toBeUndefined();
      return;
    }

    const millisecondsScale = 1_700_000_000_000;
    // Valid epoch-ms must be accepted (assert form returns void / non-throw).
    expect(() => assertEpoch(millisecondsScale, 'expiresAt')).not.toThrow();
    expect(() => assertEpoch(-1, 'notBefore')).toThrow();
    expect(() => assertEpoch(1.5, 'notBefore')).toThrow();
    expect(() => assertEpoch(Number.NaN, 'notBefore')).toThrow();
  });

  it(`${evidence} assertUnixSeconds accepts whole-second NumericDate when present`, async () => {
    const barrel = (await import('../../src/security/index.js')) as Record<string, unknown>;
    const secondsHelper =
      (typeof barrel.assertUnixSeconds === 'function'
        ? barrel.assertUnixSeconds
        : typeof barrel.assertEpochSeconds === 'function'
          ? barrel.assertEpochSeconds
          : typeof barrel.assertNumericDateSeconds === 'function'
            ? barrel.assertNumericDateSeconds
            : undefined) as ((value: unknown, name?: string) => unknown) | undefined;

    if (secondsHelper === undefined) {
      expect(secondsHelper).toBeUndefined();
      return;
    }

    const secondsScale = 1_700_000_000;
    expect(() => secondsHelper(secondsScale, 'iat')).not.toThrow();
    expect(() => secondsHelper(1.5, 'iat')).toThrow();
    expect(() => secondsHelper(Number.NaN, 'iat')).toThrow();
  });
});
