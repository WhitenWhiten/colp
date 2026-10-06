import { describe, expect, it, vi } from 'vitest';

/**
 * Contract tests for configurable dense-array inspection
 * (`refactor(security): extract configurable dense-array inspection`).
 *
 * Production surface:
 *   - `inspectExactDenseArray(value, options?)` in `src/security/dense-array.ts`
 *     (re-exported from `src/security/input-snapshot.ts`)
 *   - `snapshotDenseArray(value, name?)` — throw + freeze wrapper
 *
 * Options: minLength (default 0), maxLength, allowExtraOwnKeys (default false),
 * requireStandardPrototype (default true).
 *
 * Failure codes: not-array | proxy | custom-prototype | invalid-length |
 * not-dense | extra-keys | non-data-entry
 */

import {
  inspectExactDenseArray,
  snapshotDenseArray,
  type ExactDenseArrayInspectionFailure,
  type ExactDenseArrayInspectionResult,
} from '../../src/security/input-snapshot.js';

const evidence = '[evidence:security.input-snapshot]';

function expectRejected(
  result: ExactDenseArrayInspectionResult,
  failure: ExactDenseArrayInspectionFailure,
): asserts result is { ok: false; failure: ExactDenseArrayInspectionFailure } {
  expect(result).toEqual({ ok: false, failure });
}

function expectAccepted(
  result: ExactDenseArrayInspectionResult,
  values: readonly unknown[],
): asserts result is { ok: true; values: readonly unknown[] } {
  expect(result).toEqual({ ok: true, values });
}

describe(`${evidence} inspectExactDenseArray — acceptance`, () => {
  it(`${evidence} accepts dense plain arrays including empty when minLength defaults to 0`, () => {
    expectAccepted(inspectExactDenseArray([]), []);
    expectAccepted(inspectExactDenseArray([1, 'two', null]), [1, 'two', null]);
    expectAccepted(inspectExactDenseArray(['only']), ['only']);
  });

  it(`${evidence} accepts null-prototype dense arrays under default prototype rules`, () => {
    const nullProto = Object.setPrototypeOf(['a', 'b'], null) as unknown[];
    expectAccepted(inspectExactDenseArray(nullProto), ['a', 'b']);
  });

  it(`${evidence} returns index values without sharing the source array identity`, () => {
    const input = [1, 2, 3];
    const result = inspectExactDenseArray(input);
    expectAccepted(result, [1, 2, 3]);
    if (result.ok) {
      expect(result.values).not.toBe(input);
      input[0] = 99;
      expect(result.values[0]).toBe(1);
    }
  });
});

describe(`${evidence} inspectExactDenseArray — structural rejection`, () => {
  it(`${evidence} rejects Proxy arrays without invoking traps`, () => {
    const getTrap = vi.fn((target: unknown[], property: string | symbol) =>
      Reflect.get(target, property),
    );
    const ownKeysTrap = vi.fn((target: unknown[]) => Reflect.ownKeys(target));
    const getOwnPropertyDescriptorTrap = vi.fn(
      (target: unknown[], property: string | symbol) =>
        Reflect.getOwnPropertyDescriptor(target, property),
    );
    const proxied = new Proxy([1, 2], {
      get: getTrap,
      ownKeys: ownKeysTrap,
      getOwnPropertyDescriptor: getOwnPropertyDescriptorTrap,
    });

    expectRejected(inspectExactDenseArray(proxied), 'proxy');
    expect(getTrap).not.toHaveBeenCalled();
    expect(ownKeysTrap).not.toHaveBeenCalled();
    expect(getOwnPropertyDescriptorTrap).not.toHaveBeenCalled();
  });

  it(`${evidence} rejects sparse holes as not-dense`, () => {
    const sparse = new Array<unknown>(2);
    sparse[1] = 'only-one';
    expectRejected(inspectExactDenseArray(sparse), 'not-dense');

    // length claims 1 but index 0 is missing
    const holeAtZero = ['present'];
    delete (holeAtZero as unknown as Record<string, unknown>)['0'];
    holeAtZero.length = 1;
    expectRejected(inspectExactDenseArray(holeAtZero), 'not-dense');
  });

  it(`${evidence} rejects non-data accessor indexes without invoking getters`, () => {
    const getter = vi.fn(() => 'secret-entry');
    const withAccessor = Object.defineProperty(['placeholder'], '0', {
      configurable: true,
      enumerable: true,
      get: getter,
    });

    expectRejected(inspectExactDenseArray(withAccessor), 'non-data-entry');
    expect(getter).not.toHaveBeenCalled();
  });

  it(`${evidence} rejects invalid length at the index-space upper bound`, () => {
    // 2^32 − 1 is a legal Array length but outside the inspector's exclusive upper bound.
    const oversized = [] as unknown[];
    oversized.length = 4_294_967_295;
    expectRejected(inspectExactDenseArray(oversized), 'invalid-length');
  });

  it(`${evidence} rejects non-array values as not-array`, () => {
    expectRejected(inspectExactDenseArray({ 0: 'a', length: 1 }), 'not-array');
    expectRejected(inspectExactDenseArray(null), 'not-array');
    expectRejected(inspectExactDenseArray(undefined), 'not-array');
    expectRejected(inspectExactDenseArray('ab'), 'not-array');
    expectRejected(inspectExactDenseArray(42), 'not-array');
  });
});

describe(`${evidence} inspectExactDenseArray — minLength / maxLength`, () => {
  it(`${evidence} enforces minLength via failure 'invalid-length'`, () => {
    expectRejected(inspectExactDenseArray([], { minLength: 1 }), 'invalid-length');
    expectRejected(inspectExactDenseArray(['only'], { minLength: 2 }), 'invalid-length');
    expectAccepted(inspectExactDenseArray(['a', 'b'], { minLength: 2 }), ['a', 'b']);
    expectAccepted(inspectExactDenseArray(['a', 'b', 'c'], { minLength: 2 }), ['a', 'b', 'c']);
  });

  it(`${evidence} enforces maxLength via failure 'invalid-length'`, () => {
    expectRejected(inspectExactDenseArray([1, 2, 3], { maxLength: 2 }), 'invalid-length');
    expectAccepted(inspectExactDenseArray([1, 2], { maxLength: 2 }), [1, 2]);
    expectAccepted(inspectExactDenseArray([], { maxLength: 0 }), []);
    expectRejected(inspectExactDenseArray([1], { maxLength: 0 }), 'invalid-length');
  });

  it(`${evidence} enforces minLength and maxLength together`, () => {
    expectRejected(inspectExactDenseArray([], { minLength: 1, maxLength: 3 }), 'invalid-length');
    expectRejected(
      inspectExactDenseArray([1, 2, 3, 4], { minLength: 1, maxLength: 3 }),
      'invalid-length',
    );
    expectAccepted(inspectExactDenseArray([1, 2], { minLength: 1, maxLength: 3 }), [1, 2]);
  });
});

describe(`${evidence} inspectExactDenseArray — allowExtraOwnKeys`, () => {
  function arrayWithExtraOwnKey(): unknown[] {
    const values = [10, 20] as unknown[];
    Object.defineProperty(values, 'meta', {
      value: 'extra',
      writable: true,
      enumerable: true,
      configurable: true,
    });
    return values;
  }

  function arrayWithSymbolOwnKey(): unknown[] {
    const values = ['x'] as unknown[];
    Object.defineProperty(values, Symbol('tag'), {
      value: true,
      writable: true,
      enumerable: true,
      configurable: true,
    });
    return values;
  }

  it(`${evidence} rejects extra own keys when allowExtraOwnKeys is false (default)`, () => {
    expectRejected(inspectExactDenseArray(arrayWithExtraOwnKey()), 'extra-keys');
    expectRejected(
      inspectExactDenseArray(arrayWithExtraOwnKey(), { allowExtraOwnKeys: false }),
      'extra-keys',
    );
    expectRejected(inspectExactDenseArray(arrayWithSymbolOwnKey()), 'extra-keys');
  });

  it(`${evidence} allows extra own keys when allowExtraOwnKeys is true while still reading indexes`, () => {
    const withExtra = arrayWithExtraOwnKey();
    expectAccepted(inspectExactDenseArray(withExtra, { allowExtraOwnKeys: true }), [10, 20]);

    const withSymbol = arrayWithSymbolOwnKey();
    expectAccepted(inspectExactDenseArray(withSymbol, { allowExtraOwnKeys: true }), ['x']);
  });

  it(`${evidence} still rejects sparse density even when allowExtraOwnKeys is true`, () => {
    const sparse = new Array<unknown>(2);
    sparse[0] = 'present';
    Object.defineProperty(sparse, 'meta', {
      value: 'extra',
      writable: true,
      enumerable: true,
      configurable: true,
    });
    expectRejected(inspectExactDenseArray(sparse, { allowExtraOwnKeys: true }), 'not-dense');
  });
});

describe(`${evidence} inspectExactDenseArray — requireStandardPrototype`, () => {
  it(`${evidence} rejects custom prototype arrays when requireStandardPrototype is true`, () => {
    const customProto = Object.create(Array.prototype) as unknown[];
    const hostile = Object.setPrototypeOf([1, 2], customProto) as unknown[];

    expectRejected(
      inspectExactDenseArray(hostile, { requireStandardPrototype: true }),
      'custom-prototype',
    );
    // default is true
    expectRejected(inspectExactDenseArray(hostile), 'custom-prototype');
  });

  it(`${evidence} rejects subclass instances when requireStandardPrototype is true`, () => {
    class SubArray extends Array<number> {}
    const subclassed = new SubArray(1, 2, 3);
    expectRejected(
      inspectExactDenseArray(subclassed, { requireStandardPrototype: true }),
      'custom-prototype',
    );
  });

  it(`${evidence} accepts Array.prototype arrays when requireStandardPrototype is true`, () => {
    expectAccepted(inspectExactDenseArray([7], { requireStandardPrototype: true }), [7]);
  });

  it(`${evidence} allows custom prototypes when requireStandardPrototype is false`, () => {
    const customProto = Object.create(Array.prototype) as unknown[];
    const hostile = Object.setPrototypeOf(['ok'], customProto) as unknown[];
    expectAccepted(
      inspectExactDenseArray(hostile, { requireStandardPrototype: false }),
      ['ok'],
    );
  });
});

describe(`${evidence} snapshotDenseArray — freeze and labeled TypeErrors`, () => {
  it(`${evidence} freezes the returned snapshot and isolates from source mutation`, () => {
    const input = [1, 'two', { nested: true }];
    const snapshot = snapshotDenseArray(input, 'ops');

    expect(snapshot).toEqual([1, 'two', { nested: true }]);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(() => {
      (snapshot as unknown as unknown[]).push(99);
    }).toThrow();

    input[0] = 99;
    expect(snapshot[0]).toBe(1);
  });

  it(`${evidence} freezes empty snapshots`, () => {
    const snapshot = snapshotDenseArray([]);
    expect(snapshot).toEqual([]);
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it(`${evidence} throws labeled TypeError for Proxy arrays without trap invocation`, () => {
    const getTrap = vi.fn(() => undefined);
    const proxied = new Proxy([1], { get: getTrap });

    expect(() => snapshotDenseArray(proxied, 'requestOrigin')).toThrow(
      /requestOrigin must be a plain dense array/,
    );
    expect(getTrap).not.toHaveBeenCalled();
  });

  it(`${evidence} throws labeled TypeError for sparse arrays`, () => {
    const sparse = new Array<unknown>(2);
    sparse[1] = 'only';
    expect(() => snapshotDenseArray(sparse, 'allowedOrigins')).toThrow(
      /allowedOrigins must be dense/,
    );
  });

  it(`${evidence} throws labeled TypeError for custom prototypes`, () => {
    const customProto = Object.create(Array.prototype) as unknown[];
    const hostile = Object.setPrototypeOf(['x'], customProto) as unknown[];
    expect(() => snapshotDenseArray(hostile, 'retainedKeyIds')).toThrow(
      /retainedKeyIds must not inherit from a custom prototype/,
    );
  });

  it(`${evidence} throws labeled TypeError for invalid length`, () => {
    const bad = [] as unknown[];
    bad.length = 4_294_967_295;
    expect(() => snapshotDenseArray(bad, 'array')).toThrow(/array has an invalid length/);
  });

  it(`${evidence} throws labeled TypeError for extra own keys`, () => {
    const withExtra = [1, 2] as unknown[];
    Object.defineProperty(withExtra, 'meta', {
      value: true,
      writable: true,
      enumerable: true,
      configurable: true,
    });
    expect(() => snapshotDenseArray(withExtra, 'scopes')).toThrow(
      /scopes must not contain extra properties/,
    );
  });

  it(`${evidence} throws labeled TypeError for accessor indexes without invoking getters`, () => {
    const getter = vi.fn(() => 'secret');
    const withAccessor = Object.defineProperty(['placeholder'], '0', {
      configurable: true,
      enumerable: true,
      get: getter,
    });
    expect(() => snapshotDenseArray(withAccessor, 'entries')).toThrow(
      /entries entries must be own data properties/,
    );
    expect(getter).not.toHaveBeenCalled();
  });

  it(`${evidence} throws labeled TypeError for non-array hosts`, () => {
    expect(() => snapshotDenseArray({ 0: 'a', length: 1 }, 'identity')).toThrow(
      /identity must be a plain dense array/,
    );
    expect(() => snapshotDenseArray(null, 'identity')).toThrow(
      /identity must be a plain dense array/,
    );
  });
});
