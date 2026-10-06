import { describe, expect, it } from 'vitest';

import { hasDenseArrayOwnKeys } from '../../src/shared/dense-array-keys.js';

describe('linear dense-array own-key validation', () => {
  it.each([0, 1, 10_000, 100_000])('accepts a dense array with %i entries', (length) => {
    const array = Array.from({ length }, (_, index) => index);
    expect(hasDenseArrayOwnKeys(Reflect.ownKeys(array), length)).toBe(true);
  });

  it.each([
    { keys: ['length'], length: 1 },
    { keys: ['0', '2', 'length'], length: 3 },
    { keys: ['0', '1', 'length', 'extra'], length: 2 },
    { keys: ['0', 'length', Symbol('extra')], length: 1 },
    { keys: ['1', '0', 'length'], length: 2 },
    { keys: ['0', 'extra'], length: 1 },
  ])('rejects holes, unexpected members and invalid key order: $keys', ({ keys, length }) => {
    expect(hasDenseArrayOwnKeys(keys, length)).toBe(false);
  });

  it('does not read array elements while checking their keys', () => {
    const array = [0];
    Object.defineProperty(array, '0', { get() { throw new Error('must not invoke getters'); } });
    expect(hasDenseArrayOwnKeys(Reflect.ownKeys(array), array.length)).toBe(true);
    // Descriptor/accessor rejection remains the owning snapshot's responsibility.
  });

  it('reads each own key once even at the supported 100,000-node ceiling', () => {
    const length = 100_000;
    const keys = [...Array.from({ length }, (_, index) => String(index)), 'length'];
    let indexReads = 0;
    const measured = new Proxy(keys, {
      get(target, key, receiver) {
        if (typeof key === 'string' && /^(?:0|[1-9][0-9]*)$/u.test(key)) indexReads += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    expect(hasDenseArrayOwnKeys(measured, length)).toBe(true);
    // Structural complexity assertion: no machine-dependent timing threshold.
    expect(indexReads).toBe(length + 1);
  });
});
