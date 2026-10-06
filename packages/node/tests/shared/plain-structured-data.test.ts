import { describe, expect, it } from 'vitest';
import { assertPlainStructuredData, assertPlainStructuredSource } from '../../src/shared/plain-structured-data.js';

describe('Shared structured-data guards used by Core and Publisher', () => {
  it('accepts plain, null-prototype, dense and cyclic structured data', () => {
    const value: { rows: unknown[]; self?: unknown } = { rows: [Object.create(null), { title: 'value' }] };
    value.self = value;
    expect(() => assertPlainStructuredSource(value)).not.toThrow();
    expect(() => assertPlainStructuredData(structuredClone(value))).not.toThrow();
  });

  it('rejects an accessor without evaluating it', () => {
    let reads = 0;
    const value = Object.defineProperty({}, 'secret', {
      enumerable: true, get() { reads += 1; return 'secret'; },
    });
    expect(() => assertPlainStructuredSource(value)).toThrow(/accessors/u);
    expect(reads).toBe(0);
  });

  it.each([
    { value: new Proxy({}, {}) },
    { value: new Date() },
    { value: Object.create({ inherited: true }) },
    { value: [, 'hole'] },
    { value: Object.assign([], { extra: true }) },
    { value: Object.assign([], { [Symbol('extra')]: true }) },
  ])('rejects unsupported structured value %#', ({ value }) => {
    expect(() => assertPlainStructuredSource(value)).toThrow(TypeError);
  });

  it('rejects nested Proxies without invoking their traps', () => {
    const value = new Proxy({}, { getPrototypeOf() { throw new Error('must not execute trap'); } });
    expect(() => assertPlainStructuredSource({ nested: value })).toThrow(/Proxy/u);
    expect(() => assertPlainStructuredData({ nested: value })).toThrow(/Proxy/u);
  });

  it('retains the caller-specific error label', () => {
    expect(() => assertPlainStructuredSource(new Date(), 'Publisher request')).toThrow(/Publisher request/u);
  });
});
