import { describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for the shared security input-snapshot helpers.
 *
 * Production surface (`src/security/input-snapshot.ts`):
 *   - isPlainRecord(value)
 *   - hasSafeRecordPrototype(value)
 *   - assertPlainRecord(value, name?)
 *   - readOwnDataProperty(value, key)
 *   - requireOwnDataProperty(value, key, name)
 *   - exactOwnStringKeys(value, allowed, name?)
 *   - snapshotDenseArray(value, name?)
 *
 * Corner cases only: plain-record acceptance, Proxy/prototype rejection,
 * own-data vs accessor reads (getters never run), dense vs sparse arrays,
 * Proxy length spoof, exact-key allowlist.
 */

import * as inputSnapshot from '../../src/security/input-snapshot.js';

const evidence = '[evidence:security.input-snapshot]';

const {
  isPlainRecord,
  assertPlainRecord,
  readOwnDataProperty,
  requireOwnDataProperty,
  exactOwnStringKeys,
  snapshotDenseArray,
} = inputSnapshot;

describe(`${evidence} isPlainRecord`, () => {
  it(`${evidence} accepts ordinary plain objects and null-prototype records`, () => {
    expect(isPlainRecord({ a: 1 })).toBe(true);
    expect(isPlainRecord(Object.create(null))).toBe(true);
    expect(isPlainRecord({})).toBe(true);
  });

  it(`${evidence} rejects Proxy objects without invoking traps`, () => {
    const getTrap = vi.fn(() => undefined);
    const ownKeysTrap = vi.fn(() => [] as ArrayLike<string | symbol>);
    const getOwnPropertyDescriptorTrap = vi.fn(() => undefined);
    const proxied = new Proxy(
      { a: 1 },
      {
        get: getTrap,
        ownKeys: ownKeysTrap,
        getOwnPropertyDescriptor: getOwnPropertyDescriptorTrap,
      },
    );

    expect(isPlainRecord(proxied)).toBe(false);
    expect(getTrap).not.toHaveBeenCalled();
    expect(ownKeysTrap).not.toHaveBeenCalled();
    expect(getOwnPropertyDescriptorTrap).not.toHaveBeenCalled();
  });

  it(`${evidence} rejects arrays, null, and primitives as plain records`, () => {
    expect(isPlainRecord([])).toBe(false);
    expect(isPlainRecord([1, 2])).toBe(false);
    expect(isPlainRecord(null)).toBe(false);
    expect(isPlainRecord(undefined)).toBe(false);
    expect(isPlainRecord(1)).toBe(false);
    expect(isPlainRecord('record')).toBe(false);
    expect(isPlainRecord(true)).toBe(false);
    expect(isPlainRecord(Symbol('x'))).toBe(false);
  });

  it(`${evidence} rejects objects with a custom prototype`, () => {
    const custom = Object.create({ inherited: true });
    custom.own = 1;
    expect(isPlainRecord(custom)).toBe(false);

    class Hostile {}
    expect(isPlainRecord(new Hostile())).toBe(false);
  });
});

describe(`${evidence} assertPlainRecord`, () => {
  it(`${evidence} accepts plain records without throwing`, () => {
    expect(() => assertPlainRecord({ a: 1 })).not.toThrow();
    expect(() => assertPlainRecord(Object.create(null))).not.toThrow();
  });

  it(`${evidence} throws TypeError for non-plain values without running Proxy traps`, () => {
    const getTrap = vi.fn(() => 1);
    const proxied = new Proxy({ a: 1 }, { get: getTrap });

    expect(() => assertPlainRecord(proxied)).toThrow(TypeError);
    expect(getTrap).not.toHaveBeenCalled();

    expect(() => assertPlainRecord([])).toThrow(TypeError);
    expect(() => assertPlainRecord(null)).toThrow(TypeError);
    expect(() => assertPlainRecord(Object.create({ x: 1 }))).toThrow(TypeError);
  });
});

describe(`${evidence} readOwnDataProperty`, () => {
  it(`${evidence} finds own data properties and reports missing keys`, () => {
    const record = { a: 1, b: 'two' };
    expect(readOwnDataProperty(record, 'a')).toEqual({ found: true, value: 1 });
    expect(readOwnDataProperty(record, 'b')).toEqual({ found: true, value: 'two' });
    expect(readOwnDataProperty(record, 'missing')).toEqual({ found: false });
    expect(readOwnDataProperty(record, 'missing').value).toBeUndefined();
  });

  it(`${evidence} reads null-prototype own data properties`, () => {
    const record = Object.create(null) as Record<string, unknown>;
    record.token = 'value';
    expect(readOwnDataProperty(record, 'token')).toEqual({ found: true, value: 'value' });
  });

  it(`${evidence} rejects accessor properties without invoking the getter`, () => {
    const getter = vi.fn(() => 'secret');
    const record = Object.defineProperty({}, 'token', {
      enumerable: true,
      configurable: true,
      get: getter,
    });

    expect(() => readOwnDataProperty(record, 'token')).toThrow(TypeError);
    expect(getter).not.toHaveBeenCalled();
  });

  it(`${evidence} fails closed for Proxy / non-record hosts without trap execution`, () => {
    const getTrap = vi.fn(() => 'hostile');
    const getOwnPropertyDescriptorTrap = vi.fn(() => ({
      configurable: true,
      enumerable: true,
      value: 'hostile',
    }));
    const proxied = new Proxy(
      { token: 'x' },
      {
        get: getTrap,
        getOwnPropertyDescriptor: getOwnPropertyDescriptorTrap,
      },
    );

    // Non-plain hosts must not yield a trusted found value; traps must not run.
    const result = readOwnDataProperty(proxied, 'token');
    expect(result.found).toBe(false);
    expect(getTrap).not.toHaveBeenCalled();
    expect(getOwnPropertyDescriptorTrap).not.toHaveBeenCalled();

    expect(readOwnDataProperty(null, 'token')).toEqual({ found: false });
    expect(readOwnDataProperty([], '0')).toEqual({ found: false });
    expect(readOwnDataProperty(1, 'token')).toEqual({ found: false });
  });

  it(`${evidence} does not treat inherited data as own`, () => {
    const proto = { inherited: 42 };
    const record = Object.create(proto) as Record<string, unknown>;
    // custom prototype is not a plain record — fail closed
    expect(readOwnDataProperty(record, 'inherited').found).toBe(false);
  });
});

describe(`${evidence} snapshotDenseArray`, () => {
  it(`${evidence} snapshots a dense ordinary array of own data entries`, () => {
    const input = [1, 'two', { nested: true }, null];
    const snapshot = snapshotDenseArray(input);

    expect(snapshot).toEqual([1, 'two', { nested: true }, null]);
    expect(Array.isArray(snapshot)).toBe(true);
    // Snapshot must be independent of later mutation of the source.
    input[0] = 99;
    expect(snapshot[0]).toBe(1);
  });

  it(`${evidence} accepts an empty dense array`, () => {
    expect(snapshotDenseArray([])).toEqual([]);
  });

  it(`${evidence} rejects sparse arrays`, () => {
    const sparse = new Array<unknown>(2);
    sparse[1] = 'only-one';

    expect(() => snapshotDenseArray(sparse)).toThrow(TypeError);
  });

  it(`${evidence} rejects Proxy arrays without trusting or invoking traps`, () => {
    const getTrap = vi.fn((target: unknown[], property: string | symbol) => {
      if (property === 'length') return 0;
      return Reflect.get(target, property);
    });
    const getOwnPropertyDescriptorTrap = vi.fn(
      (target: unknown[], property: string | symbol) =>
        Reflect.getOwnPropertyDescriptor(target, property),
    );
    const ownKeysTrap = vi.fn((target: unknown[]) => Reflect.ownKeys(target));
    const proxied = new Proxy([1, 2], {
      get: getTrap,
      getOwnPropertyDescriptor: getOwnPropertyDescriptorTrap,
      ownKeys: ownKeysTrap,
    });

    expect(() => snapshotDenseArray(proxied)).toThrow(TypeError);
    expect(getTrap).not.toHaveBeenCalled();
    expect(getOwnPropertyDescriptorTrap).not.toHaveBeenCalled();
    expect(ownKeysTrap).not.toHaveBeenCalled();
  });

  it(`${evidence} rejects accessor indexes without invoking the getter`, () => {
    const getter = vi.fn(() => 'secret-entry');
    const withAccessor = Object.defineProperty(['placeholder'], '0', {
      configurable: true,
      enumerable: true,
      get: getter,
    });

    expect(() => snapshotDenseArray(withAccessor)).toThrow(TypeError);
    expect(getter).not.toHaveBeenCalled();
  });

  it(`${evidence} rejects length spoof via Proxy without trusting trap values`, () => {
    // Real dense length 2; trap claims length 1 so a deny/hostile entry would be hidden
    // if the helper trusted `proxy.length` instead of rejecting Proxies / own descriptors.
    const lengthGetTrap = vi.fn(() => 1);
    const getTrap = vi.fn((target: unknown[], property: string | symbol, receiver: unknown) => {
      if (property === 'length') return lengthGetTrap();
      return Reflect.get(target, property, receiver);
    });
    const getOwnPropertyDescriptorTrap = vi.fn(
      (target: unknown[], property: string | symbol) => {
        if (property === 'length') {
          return {
            configurable: false,
            enumerable: false,
            writable: true,
            value: 1,
          } as PropertyDescriptor;
        }
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    );

    const spoofed = new Proxy(['visible', 'hidden-deny'], {
      get: getTrap,
      getOwnPropertyDescriptor: getOwnPropertyDescriptorTrap,
    });

    expect(() => snapshotDenseArray(spoofed)).toThrow(TypeError);
    expect(lengthGetTrap).not.toHaveBeenCalled();
    expect(getTrap).not.toHaveBeenCalled();
    expect(getOwnPropertyDescriptorTrap).not.toHaveBeenCalled();
  });

  it(`${evidence} rejects non-array values`, () => {
    expect(() => snapshotDenseArray({ 0: 'a', length: 1 })).toThrow(TypeError);
    expect(() => snapshotDenseArray(null)).toThrow(TypeError);
    expect(() => snapshotDenseArray('ab')).toThrow(TypeError);
  });

  it(`${evidence} rejects arrays with a custom prototype`, () => {
    const customProto = Object.create(Array.prototype) as unknown[];
    const hostile = Object.setPrototypeOf([1], customProto) as unknown[];
    expect(() => snapshotDenseArray(hostile)).toThrow(TypeError);
  });
});

describe(`${evidence} requireOwnDataProperty`, () => {
  it(`${evidence} returns own data values and throws when missing or non-plain`, () => {
    expect(requireOwnDataProperty({ token: 'x' }, 'token', 'token')).toBe('x');
    expect(() => requireOwnDataProperty({ token: 'x' }, 'missing', 'token')).toThrow(TypeError);
    expect(() => requireOwnDataProperty(null, 'token', 'token')).toThrow(TypeError);
    expect(() => requireOwnDataProperty([], '0', 'token')).toThrow(TypeError);
  });

  it(`${evidence} rejects accessors without invoking the getter`, () => {
    const getter = vi.fn(() => 'secret');
    const record = Object.defineProperty({}, 'token', {
      enumerable: true,
      configurable: true,
      get: getter,
    });
    expect(() => requireOwnDataProperty(record, 'token', 'token')).toThrow(TypeError);
    expect(getter).not.toHaveBeenCalled();
  });
});

describe(`${evidence} exactOwnStringKeys`, () => {
  it(`${evidence} rejects unknown own string keys and symbols`, () => {
    expect(() => exactOwnStringKeys({ a: 1, b: 2 }, ['a', 'b'])).not.toThrow();
    expect(() => exactOwnStringKeys({ a: 1 }, ['a'])).not.toThrow();
    // Allowlist may list keys that are absent — only unknown own keys fail.
    expect(() => exactOwnStringKeys({ a: 1 }, ['a', 'b'])).not.toThrow();
    expect(() => exactOwnStringKeys({ a: 1, unknown: true }, ['a'])).toThrow(TypeError);
    expect(() => exactOwnStringKeys({ extra: 1 }, [])).toThrow(TypeError);

    const withSymbol = Object.defineProperty({ a: 1 }, Symbol('s'), {
      enumerable: true,
      configurable: true,
      writable: true,
      value: 1,
    });
    expect(() => exactOwnStringKeys(withSymbol, ['a'])).toThrow(TypeError);
  });
});
