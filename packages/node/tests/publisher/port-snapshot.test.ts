import { describe, expect, it, vi } from 'vitest';

import {
  assertPortObject,
  bindMethod,
  dataObject,
  dataValue,
  findDataProperty,
  optionalMethod,
  requirePromise,
} from '../../src/publisher/port-snapshot.js';

class InheritedPort {
  value = 3;
  method(add: number): number { return this.value + add; }
}

class ChildPort extends InheritedPort {}

describe('Publisher port snapshot primitives', () => {
  it('binds a legal data method to the port object without detaching this', () => {
    const owner = new InheritedPort();
    const method = bindMethod<(add: number) => number>(owner, 'method', 'Test port');
    expect(method(4)).toBe(7);
    owner.value = 10;
    expect(method(4)).toBe(14);
  });

  it('accepts a method inherited from a class prototype', () => {
    const method = bindMethod<(add: number) => number>(new ChildPort(), 'method', 'Test port');
    expect(method(2)).toBe(5);
    expect(optionalMethod<(add: number) => number>(new ChildPort(), 'method', 'Test port')!(2)).toBe(5);
  });

  it('rejects Proxies without consulting their traps', () => {
    const trap = vi.fn(() => { throw new Error('proxy trap must not run'); });
    const proxied = new Proxy({ method: () => 1 }, { get: trap, getPrototypeOf: trap });
    expect(() => bindMethod(proxied, 'method', 'Test port')).toThrow(TypeError);
    expect(trap).not.toHaveBeenCalled();

    const apply = vi.fn(() => 1);
    expect(() => bindMethod({ method: new Proxy(() => 1, { apply }) }, 'method', 'Test port')).toThrow(TypeError);
    expect(apply).not.toHaveBeenCalled();

    const prototype = new Proxy({ method: () => 1 }, {});
    expect(() => findDataProperty(Object.create(prototype), 'method', 'Test port')).toThrow(TypeError);
  });

  it('rejects accessors before their getters run, including inherited accessors', () => {
    const getter = vi.fn(() => () => 1);
    const own = Object.defineProperty({}, 'method', { enumerable: true, get: getter });
    expect(() => bindMethod(own, 'method', 'Test port')).toThrow(TypeError);
    expect(() => optionalMethod(own, 'method', 'Test port')).toThrow(TypeError);
    expect(() => dataValue(own, 'method', 'Test port')).toThrow(TypeError);
    expect(getter).not.toHaveBeenCalled();

    const inheritedGetter = vi.fn(() => ({ ok: true }));
    const prototype = Object.defineProperty({}, 'nested', { enumerable: true, get: inheritedGetter });
    expect(() => dataObject(Object.create(prototype), 'nested', 'Test port')).toThrow(TypeError);
    expect(inheritedGetter).not.toHaveBeenCalled();
  });

  it('distinguishes an absent optional method from a present hostile one', () => {
    expect(optionalMethod({}, 'missing', 'Test port')).toBeUndefined();
    expect(() => optionalMethod({ missing: 1 }, 'missing', 'Test port')).toThrow(TypeError);
  });

  it('propagates a synchronous throw from the captured method', () => {
    const method = bindMethod<() => never>({ method() { throw new Error('sync failure'); } }, 'method', 'Test port');
    expect(() => method()).toThrow('sync failure');
  });

  it('accepts only native Promises for the port result contract', () => {
    const native = Promise.resolve(1);
    expect(requirePromise(native, 'Test result')).toBe(native);
    expect(() => requirePromise({ then: () => undefined } as never, 'Test result')).toThrow(/native Promise/u);
    expect(() => requirePromise(1 as never, 'Test result')).toThrow(/native Promise/u);
  });

  it('rejects non-object ports and keeps data-object/member shape checks separate', () => {
    expect(() => assertPortObject(null, 'Test port')).toThrow(TypeError);
    expect(() => assertPortObject(1, 'Test port')).toThrow(TypeError);
    expect(() => assertPortObject(new Proxy({}, {}), 'Test port')).toThrow(TypeError);
    expect(() => assertPortObject({}, 'Test port')).not.toThrow();

    const nested = { ok: true };
    expect(dataValue({ nested }, 'nested', 'Test port')).toBe(nested);
    expect(dataObject({ nested }, 'nested', 'Test port')).toBe(nested);
    expect(() => dataObject({ nested: new Proxy({}, {}) }, 'nested', 'Test port')).toThrow(TypeError);
    expect(() => dataObject({ nested: 1 }, 'nested', 'Test port')).toThrow(TypeError);
  });
});
