import { describe, expect, it } from 'vitest';

import {
  immutableJsonData,
  immutableJsonSnapshot,
  isJsonSafeNumber,
} from '../../src/shared/immutable-json.js';

const evidence = '[evidence:sync.guards-behavior]';

describe(`SYNC immutableJsonData snapshot helper ${evidence}`, () => {
  it(`rejects cyclic object graphs with a clear cycle error ${evidence}`, () => {
    const root: Record<string, unknown> = { label: 'root' };
    root.self = root;

    expect(() => immutableJsonData(root, 'cycle-fixture')).toThrow(/must not contain cycles/u);
  });

  it(`rejects non-JSON-safe numbers with the JSON-safe number message ${evidence}`, () => {
    for (const bad of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
      -(Number.MAX_SAFE_INTEGER + 1),
    ]) {
      expect(isJsonSafeNumber(bad)).toBe(false);
      expect(() => immutableJsonData({ value: bad }, 'number-fixture')).toThrow(
        /JSON-safe number/u,
      );
    }
    expect(isJsonSafeNumber(Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(isJsonSafeNumber(1.5)).toBe(true);
    expect(immutableJsonData({ n: Number.MAX_SAFE_INTEGER, d: 1.5 }, 'safe-numbers')).toEqual({
      n: Number.MAX_SAFE_INTEGER,
      d: 1.5,
    });
  });

  it(`produces null-prototype frozen objects and arrays ${evidence}`, () => {
    const source = { nested: { ok: true }, list: [1, { leaf: 'x' }] };
    const clone = immutableJsonData(source, 'freeze-fixture');

    expect(clone).not.toBe(source);
    expect(clone).toEqual(source);
    expect(Object.isFrozen(clone)).toBe(true);
    expect(Object.getPrototypeOf(clone)).toBe(null);
    expect(Object.isFrozen(clone.nested)).toBe(true);
    expect(Object.getPrototypeOf(clone.nested)).toBe(null);
    expect(Object.isFrozen(clone.list)).toBe(true);
    expect(Object.isFrozen(clone.list[1])).toBe(true);
    expect(Object.getPrototypeOf(clone.list[1])).toBe(null);
    expect(Reflect.set(clone as object, 'nested', null)).toBe(false);
  });

  it(`cleans an explicit shared seen Set when nested data throws ${evidence}`, () => {
    const seen = new Set<object>();
    const root = { a: { bad: Number.POSITIVE_INFINITY } };

    expect(() => immutableJsonData(root, 'seen-cleanup', seen)).toThrow(/JSON-safe number/u);
    expect(seen.has(root)).toBe(false);
    expect(seen.size).toBe(0);
  });

  it(`cleans seen after a nested cycle throw so the caller-owned Set is empty ${evidence}`, () => {
    const seen = new Set<object>();
    const child: Record<string, unknown> = {};
    child.loop = child;
    const root = { child };

    expect(() => immutableJsonData(root, 'seen-cycle-cleanup', seen)).toThrow(/must not contain cycles/u);
    expect(seen.has(root)).toBe(false);
    expect(seen.has(child)).toBe(false);
    expect(seen.size).toBe(0);
  });

  it(`accepts diamond / shared sibling references after ancestry is released ${evidence}`, () => {
    // Shared non-cycle refs: first visit finishes and deletes from `seen`, so the
    // second path clones successfully instead of false-positive cycle detection.
    const shared = { id: 'shared-leaf' };
    const root = { left: { child: shared }, right: { child: shared } };

    const clone = immutableJsonData(root, 'shared-ref');
    expect(clone.left.child).toEqual({ id: 'shared-leaf' });
    expect(clone.right.child).toEqual({ id: 'shared-leaf' });
    // Detached clones — not the same object identity as each other or the source.
    expect(clone.left.child).not.toBe(shared);
    expect(clone.right.child).not.toBe(shared);
    expect(clone.left.child).not.toBe(clone.right.child);
  });

  it(`accepts null-prototype plain objects as input ${evidence}`, () => {
    const source = Object.assign(Object.create(null) as Record<string, unknown>, {
      flag: true,
      nested: Object.assign(Object.create(null) as Record<string, unknown>, { n: 2 }),
    });

    const clone = immutableJsonData(source, 'null-proto-input');
    expect(clone).toEqual({ flag: true, nested: { n: 2 } });
    expect(Object.getPrototypeOf(clone)).toBe(null);
  });
});

describe(`SYNC immutableJsonSnapshot limits / hostile shapes ${evidence}`, () => {
  it(`rejects invalid maxDepth / maxMembers limits ${evidence}`, () => {
    expect(() => immutableJsonSnapshot({ a: 1 }, 'limits', { maxDepth: -1 })).toThrow(
      /maxDepth must be a non-negative safe integer/i,
    );
    expect(() => immutableJsonSnapshot({ a: 1 }, 'limits', { maxMembers: 1.5 })).toThrow(
      /maxMembers must be a non-negative safe integer/i,
    );
  });

  it(`rejects depth and member-count overflows with frozen-safe small payloads succeeding ${evidence}`, () => {
    expect(() =>
      immutableJsonSnapshot({ nested: { deep: true } }, 'depth', { maxDepth: 0 }),
    ).toThrow(/maximum JSON depth/i);
    expect(() =>
      immutableJsonSnapshot({ a: 1, b: 2, c: 3 }, 'members', { maxMembers: 2 }),
    ).toThrow(/maximum JSON member count/i);

    const ok = immutableJsonSnapshot({ ok: true, n: 1 }, 'ok-snapshot', {
      maxDepth: 2,
      maxMembers: 8,
    });
    expect(ok).toEqual({ ok: true, n: 1 });
    expect(Object.isFrozen(ok)).toBe(true);
    expect(Object.getPrototypeOf(ok)).toBe(null);
  });

  it(`rejects Proxy, symbol keys, sparse arrays, and subclassed arrays ${evidence}`, () => {
    expect(() => immutableJsonSnapshot(new Proxy({ a: 1 }, {}), 'proxy')).toThrow(/Proxy/i);

    const withSymbol = { a: 1 } as Record<string | symbol, unknown>;
    withSymbol[Symbol('x')] = 2;
    expect(() => immutableJsonSnapshot(withSymbol, 'symbol-key')).toThrow(/symbol keys/i);

    const sparse: unknown[] = [];
    sparse[1] = 'gap';
    expect(() => immutableJsonSnapshot(sparse, 'sparse')).toThrow(/dense/i);

    class SubArray extends Array<number> {}
    expect(() => immutableJsonSnapshot(new SubArray(1, 2), 'subclass')).toThrow(
      /ordinary arrays/i,
    );
  });

  it(`rejects bigint/undefined leaves and hostile array descriptors ${evidence}`, () => {
    expect(() => immutableJsonSnapshot({ v: 1n }, 'bigint')).toThrow(/plain JSON data/i);
    expect(() => immutableJsonSnapshot({ v: undefined }, 'undef')).toThrow(/plain JSON data/i);

    const arrSym: unknown[] = [1];
    (arrSym as unknown as Record<symbol, unknown>)[Symbol('x')] = 2;
    expect(() => immutableJsonSnapshot(arrSym, 'arr-sym')).toThrow(/symbol keys/i);

    const acc: unknown[] = ['x'];
    Object.defineProperty(acc, '0', {
      enumerable: true,
      configurable: true,
      get: () => 'x',
    });
    expect(() => immutableJsonSnapshot(acc, 'acc-idx')).toThrow(/dense data properties/i);
  });

  it(`rejects accessor properties on plain objects ${evidence}`, () => {
    const hostile: Record<string, unknown> = {};
    Object.defineProperty(hostile, 'leak', {
      enumerable: true,
      configurable: true,
      get: () => 'nope',
    });
    expect(() => immutableJsonSnapshot(hostile, 'accessor')).toThrow(
      /enumerable data properties/i,
    );
  });
});
