import { describe, expect, it } from 'vitest';
import { cloneAndFreezeJsonData, IJsonLimitError, parseIJson } from '../../src/schema/json.js';
import { decodePublicationUtf8Json, publicationUtf8JsonBytes } from '../../src/server/publication-http-utf8.js';

function expectLimit(work: () => unknown, code: string) {
  try { work(); throw new Error('expected resource rejection'); }
  catch (error) {
    expect(error).toBeInstanceOf(IJsonLimitError);
    expect((error as IJsonLimitError).code).toBe(code);
  }
}

describe('JSON resource admission', () => {
  it('bounds whitespace and scalar strings before parsing, including UTF-8 bytes', () => {
    expectLimit(() => parseIJson(' '.repeat(17), { maxBytes: 16 }), 'max_bytes');
    expectLimit(() => parseIJson('"' + 'a'.repeat(16) + '"', { maxBytes: 16 }), 'max_bytes');
    expect(parseIJson('"雪"', { maxBytes: 5 })).toBe('雪');
    expectLimit(() => parseIJson('"雪"', { maxBytes: 4 }), 'max_bytes');
  });

  it('checks wire bytes before UTF-8 decoding, not after allocating a string', () => {
    expectLimit(() => decodePublicationUtf8Json(new Uint8Array([255, 255]), { maxBytes: 1 }), 'max_bytes');
    expect(() => decodePublicationUtf8Json(new Uint8Array([255]), { maxBytes: 1 })).toThrow(TypeError);
    expect(decodePublicationUtf8Json(new TextEncoder().encode('{"ok":true}'))).toEqual({ ok: true });
  });

  it('uses internal byte lengths before decoding even when callers shadow binary properties', () => {
    for (const body of [new Uint8Array([255, 255]), Buffer.from([255, 255]), new Uint8Array([255, 255]).buffer]) {
      let reads = 0;
      Object.defineProperty(body, 'byteLength', { get() { reads += 1; return 0; } });
      // Invalid UTF-8 would raise TypeError if the decoder ran before admission.
      expectLimit(() => decodePublicationUtf8Json(body, { maxBytes: 1 }), 'max_bytes');
      expect(reads).toBe(0);
    }
  });

  it('decodes only a bounded view and rejects array-like executable inputs', () => {
    const bytes = new TextEncoder().encode(' null ');
    expect(decodePublicationUtf8Json(bytes.subarray(1, 5), { maxBytes: 4 })).toBeNull();
    let reads = 0;
    const arrayLike = { get length() { reads += 1; return 0; } };
    expect(() => decodePublicationUtf8Json(arrayLike as unknown as ArrayBuffer)).toThrow(TypeError);
    expect(reads).toBe(0);
  });

  it('rejects excessive clone depth and width with controlled errors', () => {
    let deep: unknown = null;
    for (let depth = 0; depth < 600; depth += 1) deep = { child: deep };
    expectLimit(() => cloneAndFreezeJsonData(deep), 'max_depth');
    expectLimit(() => cloneAndFreezeJsonData(new Array(100_000), { maxMembers: 16 }), 'max_members');
    expectLimit(() => cloneAndFreezeJsonData({ a: 1, b: 2 }, { maxMembers: 1 }), 'max_members');
  });

  it('charges shared subgraphs every time they would be copied', () => {
    const shared = { children: [1, 2, 3] };
    expectLimit(() => cloneAndFreezeJsonData([shared, shared], { maxMembers: 8 }), 'max_members');
    const copied = cloneAndFreezeJsonData([shared, shared]);
    expect(copied).toEqual([shared, shared]);
    expect(copied[0]).not.toBe(copied[1]);
  });

  it.each(['plain', '雪', '\u0000\n\t"\\', '\ud800', '😀'])('charges exact serialized string bytes: %j', value => {
    const bytes = Buffer.byteLength(JSON.stringify({ value }));
    expect(cloneAndFreezeJsonData({ value }, { maxBytes: bytes })).toEqual({ value });
    expectLimit(() => cloneAndFreezeJsonData({ value }, { maxBytes: bytes - 1 }), 'max_bytes');
  });

  it('preserves cycle, getter, prototype, numeric and deep-freeze defenses', () => {
    const cyclic: { self?: unknown } = {}; cyclic.self = cyclic;
    expect(() => cloneAndFreezeJsonData(cyclic)).toThrow(/cyclic/);
    let invoked = false;
    expect(() => cloneAndFreezeJsonData({ get value() { invoked = true; return 1; } })).toThrow(TypeError);
    expect(invoked).toBe(false);
    expect(() => cloneAndFreezeJsonData(new Date())).toThrow(TypeError);
    expect(() => cloneAndFreezeJsonData({ value: Infinity })).toThrow(TypeError);
    const copied = cloneAndFreezeJsonData({ values: [1, true, null] });
    expect(Object.isFrozen(copied)).toBe(true);
    expect(Object.isFrozen(copied.values)).toBe(true);
    expect(new TextDecoder().decode(publicationUtf8JsonBytes(copied))).toBe('{"values":[1,true,null]}');
  });

  it('preserves parser defenses and rejects invalid budgets', () => {
    expect(() => parseIJson('{"x":1,"x":2}')).toThrow(/duplicate/);
    expect(() => parseIJson('{"__proto__":1}')).toThrow(/not allowed/);
    expectLimit(() => parseIJson('[[0]]', { maxDepth: 1 }), 'max_depth');
    for (const maxBytes of [0, -1, Infinity, NaN, 0.5]) {
      expect(() => parseIJson('null', { maxBytes })).toThrow(RangeError);
      expect(() => cloneAndFreezeJsonData(null, { maxBytes })).toThrow(RangeError);
    }
  });
});
