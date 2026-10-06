import { describe, expect, it } from 'vitest';

import { deepFreeze } from '../../src/server/deep-freeze.js';

describe('server deepFreeze contract', () => {
  it('returns primitives and null unchanged', () => {
    expect(deepFreeze(null)).toBe(null);
    expect(deepFreeze(undefined as unknown as null)).toBe(undefined);
    expect(deepFreeze(42)).toBe(42);
    expect(deepFreeze('ok')).toBe('ok');
    expect(deepFreeze(true)).toBe(true);
    expect(deepFreeze(false)).toBe(false);
    const sym = Symbol('s');
    expect(deepFreeze(sym as unknown as object)).toBe(sym);
  });

  it('freezes a plain object and nested enumerable data properties', () => {
    const nested = { leaf: 1 };
    const root = { a: 1, nested, list: [2, { inner: 3 }] };

    const frozen = deepFreeze(root);

    expect(frozen).toBe(root);
    expect(Object.isFrozen(root)).toBe(true);
    expect(Object.isFrozen(nested)).toBe(true);
    expect(Object.isFrozen(root.list)).toBe(true);
    expect(Object.isFrozen(root.list[1] as object)).toBe(true);
    expect(() => {
      (root as { a: number }).a = 99;
    }).toThrow();
    expect(() => {
      nested.leaf = 99;
    }).toThrow();
  });

  it('freezes nested object values on non-enumerable own data properties (Reflect.ownKeys walk)', () => {
    const hidden = { secret: true };
    const root: Record<string, unknown> = { visible: { ok: 1 } };
    Object.defineProperty(root, 'hidden', {
      value: hidden,
      enumerable: false,
      writable: true,
      configurable: true,
    });

    deepFreeze(root);

    expect(Object.isFrozen(root)).toBe(true);
    expect(Object.isFrozen(root.visible as object)).toBe(true);
    expect(Object.isFrozen(hidden)).toBe(true);
    expect(() => {
      hidden.secret = false;
    }).toThrow();
  });

  it('freezes nested objects stored under symbol own data properties', () => {
    const key = Symbol('payload');
    const nested = { n: 1 };
    const root: Record<PropertyKey, unknown> = { tag: 'x' };
    root[key] = nested;

    deepFreeze(root);

    expect(Object.isFrozen(root)).toBe(true);
    expect(Object.isFrozen(nested)).toBe(true);
    expect(root[key]).toBe(nested);
    expect(() => {
      nested.n = 2;
    }).toThrow();
  });

  it('does not invoke accessors and does not throw from getters; parent still freezes', () => {
    let getterCalls = 0;
    const root: Record<string, unknown> = { plain: { ok: true } };
    Object.defineProperty(root, 'boom', {
      enumerable: true,
      configurable: true,
      get() {
        getterCalls += 1;
        throw new Error('getter must not be invoked by deepFreeze');
      },
    });

    expect(() => deepFreeze(root)).not.toThrow();
    expect(getterCalls).toBe(0);
    expect(Object.isFrozen(root)).toBe(true);
    expect(Object.isFrozen(root.plain as object)).toBe(true);

    const descriptor = Object.getOwnPropertyDescriptor(root, 'boom');
    expect(descriptor).toBeDefined();
    expect(typeof descriptor?.get).toBe('function');
    expect('value' in (descriptor ?? {})).toBe(false);

    // Getter remains live after freeze (frozen objects keep existing accessors).
    expect(() => root.boom).toThrow('getter must not be invoked by deepFreeze');
    expect(getterCalls).toBe(1);
  });

  it('freezes arrays and deep-freezes object elements in dense arrays', () => {
    const a = { i: 0 };
    const b = { i: 1 };
    const arr = [a, b, 3];

    const frozen = deepFreeze(arr);

    expect(frozen).toBe(arr);
    expect(Object.isFrozen(arr)).toBe(true);
    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(b)).toBe(true);
    expect(() => {
      arr.push(4);
    }).toThrow();
    expect(() => {
      a.i = 9;
    }).toThrow();
  });

  it('freezes cyclic graphs without infinite recursion', () => {
    const a: { name: string; ref?: object } = { name: 'a' };
    const b: { name: string; ref?: object } = { name: 'b' };
    a.ref = b;
    b.ref = a;

    expect(() => deepFreeze(a)).not.toThrow();
    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(b)).toBe(true);
    expect(a.ref).toBe(b);
    expect(b.ref).toBe(a);
  });

  it('freezes an object that directly references itself', () => {
    const self: { self?: object; n: number } = { n: 1 };
    self.self = self;

    expect(() => deepFreeze(self)).not.toThrow();
    expect(Object.isFrozen(self)).toBe(true);
    expect(self.self).toBe(self);
  });

  it('returns an already-frozen object unchanged and still frozen', () => {
    const nested = Object.freeze({ x: 1 });
    const root = Object.freeze({ nested });

    const result = deepFreeze(root);

    expect(result).toBe(root);
    expect(Object.isFrozen(root)).toBe(true);
    expect(Object.isFrozen(nested)).toBe(true);
  });

  it('freezes diamond / shared sibling references without false failure', () => {
    const shared = { leaf: 'shared' };
    const root = {
      left: { child: shared },
      right: { child: shared },
    };

    expect(() => deepFreeze(root)).not.toThrow();
    expect(Object.isFrozen(root)).toBe(true);
    expect(Object.isFrozen(root.left)).toBe(true);
    expect(Object.isFrozen(root.right)).toBe(true);
    expect(Object.isFrozen(shared)).toBe(true);
    expect(root.left.child).toBe(root.right.child);
  });
});
