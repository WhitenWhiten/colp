import { describe, expect, it, vi } from 'vitest';

import {
  IJsonLimitError,
  MAX_I_JSON_PARSE_LIMITS,
  cloneAndFreezeJsonData,
  createValidatorRegistry,
  parseIJson,
  resolveIJsonParseLimits,
  validateWireJsonDocument,
} from '../../src/schema/index.js';
import { validateServerWireDocument } from '../../src/server/index.js';

const accept = (_value: unknown) => ({ valid: true as const, issues: [] as const });

describe('bounded I-JSON receive APIs [evidence:core.ijson-bounds]', () => {
  it('clones and freezes strict JSON scalars, arrays, and null-prototype objects', () => {
    const nullPrototype = Object.assign(Object.create(null) as Record<string, unknown>, {
      nested: [null, true, 'value', 1.5],
    });
    const cloned = cloneAndFreezeJsonData(nullPrototype);

    expect(cloned).toEqual({ nested: [null, true, 'value', 1.5] });
    expect(cloned).not.toBe(nullPrototype);
    expect(cloned.nested).not.toBe(nullPrototype.nested);
    expect(Object.isFrozen(cloned)).toBe(true);
    expect(Object.isFrozen(cloned.nested)).toBe(true);
    expect(cloneAndFreezeJsonData(-0)).toBe(-0);
  });

  it.each([
    ['undefined', undefined, /not JSON data/u],
    ['bigint', 1n, /not JSON data/u],
    ['symbol', Symbol('value'), /not JSON data/u],
    ['function', () => undefined, /not JSON data/u],
    ['NaN', Number.NaN, /number must be finite/u],
    ['Infinity', Number.POSITIVE_INFINITY, /number must be finite/u],
    ['unsafe integer', Number.MAX_SAFE_INTEGER + 1, /safe range/u],
    ['custom prototype', new Date(0), /plain or null prototype/u],
  ])('rejects strict JSON clone input %s', (_case, value, message) => {
    expect(() => cloneAndFreezeJsonData(value)).toThrow(message);
  });

  it('rejects cyclic objects with a stable nested path', () => {
    const value: Record<string, unknown> = { child: {} };
    (value.child as Record<string, unknown>).parent = value;
    expect(() => cloneAndFreezeJsonData(value)).toThrow(/\/child\/parent.*cyclic references/u);
  });

  it('rejects sparse, accessor, symbol, and extended arrays without reading values', () => {
    const sparse = new Array(1);
    expect(() => cloneAndFreezeJsonData(sparse)).toThrow(/array item/u);

    const getter = vi.fn(() => 'value');
    const accessor: unknown[] = [];
    Object.defineProperty(accessor, '0', { enumerable: true, get: getter });
    accessor.length = 1;
    expect(() => cloneAndFreezeJsonData(accessor)).toThrow(/array item/u);
    expect(getter).not.toHaveBeenCalled();

    const extended: unknown[] = [];
    Object.defineProperty(extended, 'extra', { enumerable: true, value: true });
    expect(() => cloneAndFreezeJsonData(extended)).toThrow(/non-index property/u);

    const oversizedIndex: unknown[] = [];
    Object.defineProperty(oversizedIndex, '4294967295', { enumerable: true, value: true });
    expect(() => cloneAndFreezeJsonData(oversizedIndex)).toThrow(/non-index property/u);

    const symbolic: unknown[] = [];
    Object.defineProperty(symbolic, Symbol('extra'), { enumerable: true, value: true });
    expect(() => cloneAndFreezeJsonData(symbolic)).toThrow(/non-index property/u);
  });

  it('rejects unsafe object property descriptors and names without invoking accessors', () => {
    const getter = vi.fn(() => 'secret');
    const accessor = {};
    Object.defineProperty(accessor, 'value', { enumerable: true, get: getter });
    expect(() => cloneAndFreezeJsonData(accessor)).toThrow(/enumerable data property/u);
    expect(getter).not.toHaveBeenCalled();

    const hidden = {};
    Object.defineProperty(hidden, 'value', { enumerable: false, value: true });
    expect(() => cloneAndFreezeJsonData(hidden)).toThrow(/enumerable data property/u);

    const symbolic = { [Symbol('secret')]: true };
    expect(() => cloneAndFreezeJsonData(symbolic)).toThrow(/symbol property/u);

    const prohibited = {};
    Object.defineProperty(prohibited, '__proto__', { enumerable: true, value: {} });
    expect(() => cloneAndFreezeJsonData(prohibited)).toThrow(/prohibited member name/u);
  });

  it('rejects nested Proxies without invoking reflection traps', () => {
    const getPrototypeOf = vi.fn((): never => { throw new Error('proxy-secret'); });
    const value = { nested: new Proxy({}, { getPrototypeOf }) };
    expect(() => cloneAndFreezeJsonData(value)).toThrow(/not JSON data/u);
    expect(getPrototypeOf).not.toHaveBeenCalled();
  });

  it('still delegates malformed trailing object keys to the JSON parser', () => {
    expect(() => parseIJson('{"key"')).toThrow(SyntaxError);
  });
  it.each([
    '{"key":1,"key":1}',
    '{"key":1,"key":2}',
    '{"outer":{"key":1,"key":1}}',
    '{"key":1,"\\u006bey":2}',
  ])('rejects every duplicate object member without disclosing its name: %s', (source) => {
    expect(() => parseIJson(source)).toThrowError(
      expect.objectContaining({
        name: 'SyntaxError',
        message: 'I-JSON object contains a duplicate member name.',
      }),
    );
  });

  it('tracks duplicate names independently for nested object scopes', () => {
    expect(parseIJson('{"key":1,"nested":{"key":2}}')).toEqual({ key: 1, nested: { key: 2 } });
  });

  it('accepts depth at the limit and rejects limit + 1 before parsing', () => {
    expect(parseIJson('{"a":{"b":[]}}', { maxDepth: 3 })).toEqual({ a: { b: [] } });
    expect(() => parseIJson('{"a":{"b":[]}}', { maxDepth: 2 })).toThrowError(
      expect.objectContaining({ name: 'IJsonLimitError', code: 'max_depth', limit: 2 }),
    );
  });

  it('counts object members and array items across nested containers', () => {
    const source = '{"a":[1,{"b":2}],"c":[]}';
    expect(parseIJson(source, { maxMembers: 5 })).toEqual({ a: [1, { b: 2 }], c: [] });
    expect(() => parseIJson(source, { maxMembers: 4 })).toThrowError(
      expect.objectContaining({ name: 'IJsonLimitError', code: 'max_members', limit: 4 }),
    );
  });

  it('accepts member limits at limit - 1 and limit, then rejects limit + 1', () => {
    expect(parseIJson('{"a":1}', { maxMembers: 2 })).toEqual({ a: 1 });
    expect(parseIJson('{"a":1,"b":2}', { maxMembers: 2 })).toEqual({ a: 1, b: 2 });
    expect(() => parseIJson('{"a":1,"b":2,"c":3}', { maxMembers: 2 })).toThrowError(
      expect.objectContaining({ name: 'IJsonLimitError', code: 'max_members', limit: 2 }),
    );
  });

  it('ignores structural punctuation and escaped quotes inside strings', () => {
    const value = { value: 'brackets {[,:]} and quote " and slash \\', items: [']', ':'] };
    const source = JSON.stringify(value);
    expect(parseIJson(source, { maxDepth: 2, maxMembers: 4 })).toEqual({
      value: value.value,
      items: [']', ':'],
    });
  });

  it.each([
    [{ maxDepth: 0 }, 'maxDepth'],
    [{ maxMembers: 1.5 }, 'maxMembers'],
    [{ maxDepth: MAX_I_JSON_PARSE_LIMITS.maxDepth + 1 }, 'maxDepth'],
    [{ maxMembers: MAX_I_JSON_PARSE_LIMITS.maxMembers + 1 }, 'maxMembers'],
  ] as const)('rejects invalid or above-ceiling limits %j', (limits, name) => {
    expect(() => resolveIJsonParseLimits(limits)).toThrow(name);
  });

  it('returns the same parse-stage limit error from schema and server boundaries', () => {
    const validators = createValidatorRegistry();
    const source = '{"protocolVersion":"0.1","code":"x","status":400,"title":"x"}';
    const schemaResult = validateWireJsonDocument(
      validators,
      'problem',
      source,
      accept,
      { maxMembers: 3 },
    );
    const serverResult = validateServerWireDocument(
      validators,
      'problem',
      source,
      accept,
      { maxMembers: 3 },
    );
    expect(schemaResult).toMatchObject({ valid: false, stage: 'parse', error: { code: 'max_members' } });
    expect(serverResult).toMatchObject({ valid: false, stage: 'parse', error: { code: 'max_members' } });
    if (!schemaResult.valid && schemaResult.stage === 'parse') {
      expect(schemaResult.error).toBeInstanceOf(IJsonLimitError);
    }
  });
});
