import { describe, expect, it, vi } from 'vitest';

import { parseIJson as parseCoreIJson } from '../../src/schema/index.js';
import { parseIJson, validateServerWireDocument } from '../../src/server/index.js';

describe('SEC-0003 server I-JSON boundary [evidence:server.ijson]', () => {
  it('accepts ordinary interoperable JSON values [evidence:server.ijson]', () => {
    expect(parseIJson('{"name":"collection","enabled":true,"ratio":0.5,"items":[1,null]}')).toEqual({
      name: 'collection',
      enabled: true,
      ratio: 0.5,
      items: [1, null],
    });

    for (const source of ['null', 'true', '"scalar"', '[1,{"nested":false}]']) {
      expect(parseIJson(source)).toEqual(parseCoreIJson(source));
    }

    expect(parseIJson('{"outer":[1]}', { maxDepth: 2, maxMembers: 2 })).toEqual({
      outer: [1],
    });
    expect(() => parseIJson('{"outer":[1]}', { maxDepth: 1 })).toThrow(/nesting depth/u);
    expect(() => parseIJson('{"outer":[1]}', { maxMembers: 1 })).toThrow(/array-item count/u);
  });

  it('accepts both safe-integer boundaries [evidence:server.ijson]', () => {
    expect(parseIJson('{"maximum":9007199254740991,"minimum":-9007199254740991}')).toEqual({
      maximum: Number.MAX_SAFE_INTEGER,
      minimum: Number.MIN_SAFE_INTEGER,
    });
  });

  it('rejects duplicate top-level members [evidence:server.ijson]', () => {
    expect(() => parseIJson('{"id":1,"id":2}')).toThrow(/duplicate member/u);
  });

  it('rejects duplicate nested members [evidence:server.ijson]', () => {
    expect(() => parseIJson('{"outer":{"id":1,"id":2}}')).toThrow(/duplicate member/u);
  });

  it('rejects escaped-equivalent duplicate members [evidence:server.ijson]', () => {
    expect(() => parseIJson('{"name":1,"na\\u006de":2}')).toThrow(/duplicate member/u);
    expect(() => parseIJson('{"\\ud83d\\ude00":1,"\\uD83D\\uDE00":2}')).toThrow(/duplicate member/u);
  });

  it('keeps duplicate-member tracking scoped to each object [evidence:server.ijson]', () => {
    expect(parseIJson('{"left":{"id":1},"right":{"id":2}}')).toEqual({
      left: { id: 1 },
      right: { id: 2 },
    });
  });

  it('does not disclose a malicious duplicate member name [evidence:server.ijson]', () => {
    const maliciousName = 'secret-token-should-not-be-reflected';
    expect(() => parseIJson(`{"${maliciousName}":1,"${maliciousName}":2}`)).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining(maliciousName) }),
    );
  });

  it('rejects an unsafe positive integer [evidence:server.ijson]', () => {
    expect(() => parseIJson('{"value":9007199254740992}')).toThrow(/outside the safe range/u);
  });

  it('rejects an unsafe negative integer [evidence:server.ijson]', () => {
    expect(() => parseIJson('{"value":-9007199254740992}')).toThrow(/outside the safe range/u);
  });

  it('rejects an unsafe integer written in exponent form [evidence:server.ijson]', () => {
    expect(() => parseIJson('{"value":9.007199254740992e15}')).toThrow(/outside the safe range/u);
    expect(() => parseIJson('{"value":-9.007199254740992e15}')).toThrow(/outside the safe range/u);
  });

  it('accepts safe integers written in exponent form and finite fractions [evidence:server.ijson]', () => {
    expect(parseIJson('{"integer":9.007199254740991e15,"fraction":0.125}')).toEqual({
      integer: Number.MAX_SAFE_INTEGER,
      fraction: 0.125,
    });
  });

  it('rejects non-finite numeric results [evidence:server.ijson]', () => {
    expect(() => parseIJson('{"value":1e400}')).toThrow(/not finite/u);
  });

  it('rejects every prototype-polluting name at the top level [evidence:server.ijson]', () => {
    for (const key of ['__proto__', 'constructor', 'prototype'] as const) {
      expect(() => parseIJson(`{"${key}":{"sec0003Polluted":true}}`), key).toThrow(SyntaxError);
      expect(() => parseIJson(`{"${key}":true}`), `${key} scalar`).toThrow(SyntaxError);
    }
    expect((Object.prototype as Record<string, unknown>).sec0003Polluted).toBeUndefined();
  });

  it('rejects every prototype-polluting name when nested [evidence:server.ijson]', () => {
    for (const key of ['__proto__', 'constructor', 'prototype'] as const) {
      expect(() => parseIJson(`{"outer":{"${key}":true}}`), key).toThrow(SyntaxError);
    }
    expect((Object.prototype as Record<string, unknown>).sec0003Polluted).toBeUndefined();
  });

  it('rejects escaped prototype-polluting names without polluting Object.prototype [evidence:server.ijson]', () => {
    for (const source of [
      '{"\\u005f_proto__":{"sec0003Polluted":true}}',
      '{"outer":{"__pro\\u0074o__":true}}',
      '{"outer":{"constr\\u0075ctor":true}}',
      '{"outer":{"proto\\u0074ype":true}}',
    ]) {
      expect(() => parseIJson(source), source).toThrow(SyntaxError);
    }
    expect((Object.prototype as Record<string, unknown>).sec0003Polluted).toBeUndefined();
    expect(Object.hasOwn(Object.prototype, 'sec0003Polluted')).toBe(false);
  });

  it('does not reject benign names that merely resemble prohibited keys [evidence:server.ijson]', () => {
    expect(parseIJson('{"__proto":1,"constructorId":2,"prototypeVersion":3}')).toEqual({
      __proto: 1,
      constructorId: 2,
      prototypeVersion: 3,
    });
  });

  it('returns parse stage before validator or semantics for unsafe input [evidence:server.ijson]', () => {
    const validate = vi.fn(() => ({ valid: true as const, errors: [] as const }));
    const validators = {
      definitionNames: ['problem'],
      get: vi.fn(),
      validate,
    } as unknown as Parameters<typeof validateServerWireDocument>[0];
    const semantics = vi.fn(() => ({ valid: true as const, issues: [] as const }));

    const result = validateServerWireDocument(
      validators,
      'problem',
      '{"status":400,"status":401}',
      semantics,
    );

    expect(result).toMatchObject({ valid: false, stage: 'parse', error: expect.any(SyntaxError) });
    expect(validate).not.toHaveBeenCalled();
    expect(validators.get).not.toHaveBeenCalled();
    expect(semantics).not.toHaveBeenCalled();
  });

  it('returns parse stage for a prohibited __proto__ member before validation [evidence:server.ijson]', () => {
    const validate = vi.fn(() => ({ valid: true as const, errors: [] as const }));
    const validators = {
      definitionNames: ['problem'],
      get: vi.fn(),
      validate,
    } as unknown as Parameters<typeof validateServerWireDocument>[0];
    const semantics = vi.fn(() => ({ valid: true as const, issues: [] as const }));

    const result = validateServerWireDocument(
      validators,
      'problem',
      '{"__proto__":true}',
      semantics,
    );

    expect(result).toMatchObject({ valid: false, stage: 'parse', error: expect.any(SyntaxError) });
    expect(validate).not.toHaveBeenCalled();
    expect(validators.get).not.toHaveBeenCalled();
    expect(semantics).not.toHaveBeenCalled();
    expect((Object.prototype as Record<string, unknown>).sec0003Polluted).toBeUndefined();
  });
});
