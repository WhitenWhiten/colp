import { describe, expect, it } from 'vitest';

import {
  createPublicationCachePolicy,
  type PublicationCachePolicyHeaders,
  type PublicationCachePolicyInput,
} from '../../src/server/index.js';

const evidence = 'http.cache.authorization';
const authPolicy = Object.freeze({ kind: 'authorization-varying' } as const);

function create(
  change: Record<string, unknown> = {},
): PublicationCachePolicyHeaders {
  return createPublicationCachePolicy({ ...authPolicy, ...change } as PublicationCachePolicyInput);
}

function varyTokens(value: string | undefined): string[] {
  if (value === undefined) return [];
  return value.split(',').map((token) => token.trim());
}

function expectExactVary(value: string | undefined, expected: readonly string[]): void {
  const actual = varyTokens(value);
  expect(actual).toEqual(expected);
  expect(actual.every((token) => token.length > 0)).toBe(true);
  expect(new Set(actual.map((token) => token.toLowerCase())).size).toBe(actual.length);
}

function cacheDirectives(value: string | undefined): string[] {
  if (value === undefined) return [];
  return value.split(',').map((directive) => directive.trim().toLowerCase());
}

describe(`PUB-0007 Authorization cache policy [evidence:${evidence}]`, () => {
  it(`forces the normal authorization-varying response to private no-store [evidence:${evidence}]`, () => {
    const headers = create();
    expect(cacheDirectives(headers['Cache-Control'])).toEqual(['private', 'no-store']);
    expectExactVary(headers.Vary, ['Authorization']);
    expect(Object.keys(headers).sort()).toEqual(['Cache-Control', 'Vary']);
  });

  it.each([
    ['public', 'public'],
    ['max-age', 'max-age=3600'],
    ['shared max-age', 's-maxage=86400'],
    ['public and max-age', 'public, max-age=60'],
    ['immutable', 'public, immutable, max-age=31536000'],
    ['must-revalidate', 'public, must-revalidate'],
    ['repeated header fields', ['public, max-age=60', 's-maxage=120']],
  ] as const)(`eliminates existing unsafe %s directives on an authorized variant [evidence:${evidence}]`, (_name, existingCacheControl) => {
    const headers = create({ existingCacheControl });
    expect(cacheDirectives(headers['Cache-Control'])).toEqual(['private', 'no-store']);
    expect(headers['Cache-Control']).toBe('private, no-store');
    expect(JSON.stringify(headers)).not.toMatch(/public|max-age|s-maxage|immutable|must-revalidate/iu);
  });

  it.each([
    ['an absent field', undefined, ['Authorization']],
    ['a preserved Origin', 'Origin', ['Origin', 'Authorization']],
    ['a preserved Accept', 'Accept', ['Accept', 'Authorization']],
    ['a preserved custom token', 'X-Projection-Key', ['X-Projection-Key', 'Authorization']],
    ['an existing lowercase authorization', 'authorization', ['authorization']],
    ['case-insensitive duplicates', 'Origin, authorization, AUTHORIZATION', ['Origin', 'authorization']],
    ['optional whitespace', '\tOrigin \t,\t Accept\t', ['Origin', 'Accept', 'Authorization']],
    ['repeated fields', ['Origin', 'Accept', 'X-Tenant'], ['Origin', 'Accept', 'X-Tenant', 'Authorization']],
    ['duplicates across repeated fields', ['Origin, Accept', 'origin, X-Tenant', 'ACCEPT'], ['Origin', 'Accept', 'X-Tenant', 'Authorization']],
  ] as const)(`normalizes Vary with %s without losing or duplicating tokens [evidence:${evidence}]`, (_name, existingVary, expected) => {
    const headers = create(existingVary === undefined ? {} : { existingVary });
    expectExactVary(headers.Vary, expected);
    expect(varyTokens(headers.Vary).filter((token) => token.toLowerCase() === 'authorization')).toHaveLength(1);
  });

  it.each([
    ['Origin with a public cache candidate', 'Origin', 'public, max-age=60'],
    ['Accept with a shared cache candidate', 'Accept', 's-maxage=120'],
    ['custom variant with repeated fields', ['X-Tenant', 'Origin'], ['public', 'max-age=30']],
  ] as const)(`preserves %s across cache-control variants while still making authorization private [evidence:${evidence}]`, (_name, existingVary, existingCacheControl) => {
    const headers = create({ existingVary, existingCacheControl });
    const expected = Array.isArray(existingVary) ? [...existingVary, 'Authorization'] : [existingVary, 'Authorization'];
    expectExactVary(headers.Vary, expected);
    expect(headers['Cache-Control']).toBe('private, no-store');
  });

  it.each([
    ['a single field', '*'],
    ['a whitespace-padded repeated field', [' \t*\t ']],
  ] as const)(`preserves RFC Vary star semantics from %s [evidence:${evidence}]`, (_name, existingVary) => {
    const headers = create({ existingVary });
    expect(headers.Vary).toBe('*');
    expect(varyTokens(headers.Vary)).toEqual(['*']);
    expect(headers.Vary).not.toContain('Authorization');
  });

  it.each([
    ['no cache declaration', undefined, undefined, undefined],
    ['public freshness', 'public, max-age=60', 'Origin', 'public, max-age=60'],
    ['shared freshness', 's-maxage=120', 'Accept', 's-maxage=120'],
    ['private declaration chosen by caller', 'private, max-age=0', 'X-Tenant', 'private, max-age=0'],
    ['repeated cache fields', ['public', 'max-age=30'], ['Origin', 'Accept'], 'public, max-age=30'],
  ] as const)(`leaves anonymous-public %s available only on the anonymous branch [evidence:${evidence}]`, (_name, existingCacheControl, existingVary, expectedCacheControl) => {
    const anonymousInput = {
      kind: 'anonymous-public',
      ...(existingCacheControl === undefined ? {} : { existingCacheControl }),
      ...(existingVary === undefined ? {} : { existingVary }),
    } satisfies PublicationCachePolicyInput;
    const anonymous = createPublicationCachePolicy(anonymousInput);
    expect(anonymous['Cache-Control']).toBe(expectedCacheControl);
    if (existingVary === undefined) expect(anonymous.Vary).toBeUndefined();
    else expectExactVary(anonymous.Vary, typeof existingVary === 'string' ? [existingVary] : existingVary);

    const authorized = create({
      ...(existingCacheControl === undefined ? {} : { existingCacheControl }),
      ...(existingVary === undefined ? {} : { existingVary }),
    });
    expect(authorized['Cache-Control']).toBe('private, no-store');
    if (authorized.Vary !== '*') {
      expect(varyTokens(authorized.Vary).map((token) => token.toLowerCase())).toContain('authorization');
    }
  });

  it.each([
    ['a success with a body', 200, '{"private":true}'],
    ['no content', 204, null],
    ['not modified', 304, null],
    ['an authorization failure', 403, '{"code":"insufficient_scope"}'],
    ['a concealed empty response', 404, ''],
  ] as const)(`does not let %s bypass authorization cache policy [evidence:${evidence}]`, (_name, status, body) => {
    const response = new Response(body, { status, headers: create() });
    expect(response.status).toBe(status);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('Vary')).toBe('Authorization');
  });

  it(`does not mutate caller-owned header arrays [evidence:${evidence}]`, () => {
    const existingVary = ['Origin, Accept', 'authorization'];
    const existingCacheControl = ['public', 'max-age=60'];
    const varySnapshot = structuredClone(existingVary);
    const cacheSnapshot = structuredClone(existingCacheControl);
    create({ existingVary, existingCacheControl });
    expect(existingVary).toEqual(varySnapshot);
    expect(existingCacheControl).toEqual(cacheSnapshot);
  });

  it(`returns a frozen output that cannot be rewritten to shared caching [evidence:${evidence}]`, () => {
    const headers = create({ existingVary: 'Origin' });
    expect(Object.isFrozen(headers)).toBe(true);
    expect(() => Object.assign(headers, { 'Cache-Control': 'public', Vary: 'Origin' })).toThrow(TypeError);
    expect(headers).toEqual({ 'Cache-Control': 'private, no-store', Vary: 'Origin, Authorization' });
  });

  it(`isolates outputs from later calls and caller mutation [evidence:${evidence}]`, () => {
    const existingVary = ['Origin'];
    const first = create({ existingVary });
    existingVary[0] = 'Accept';
    const second = create({ existingVary });
    expect(first).toEqual({ 'Cache-Control': 'private, no-store', Vary: 'Origin, Authorization' });
    expect(second).toEqual({ 'Cache-Control': 'private, no-store', Vary: 'Accept, Authorization' });
    expect(first).not.toBe(second);
  });

  it.each([
    ['empty field', ''],
    ['OWS-only field', ' \t '],
    ['leading empty member', ',Origin'],
    ['trailing empty member', 'Origin,'],
    ['embedded empty member', 'Origin,,Accept'],
    ['colon separator', 'Origin:X'],
    ['quoted token', '"Origin"'],
    ['CRLF injection', 'Origin\r\nX-Injected: yes'],
    ['NUL control injection', 'Origin\u0000X'],
    ['star mixed with a token', '*, Origin'],
    ['extreme token length', `X-${'a'.repeat(16 * 1024)}`],
  ])(`rejects invalid Vary input with %s [evidence:${evidence}]`, (_name, existingVary) => {
    expect(() => create({ existingVary })).toThrow(/Vary|header|token|length|star/iu);
  });

  it.each([
    ['empty field', ''],
    ['empty repeated member', ['public', '']],
    ['CRLF injection', 'public\r\nX-Injected: yes'],
    ['control injection', 'public\u007f'],
    ['unterminated quoted value', 'extension="unterminated'],
    ['duplicate directive', 'max-age=60, MAX-AGE=120'],
    ['conflicting visibility', 'public, private'],
  ])(`rejects invalid Cache-Control input with %s [evidence:${evidence}]`, (_name, existingCacheControl) => {
    expect(() => create({ existingCacheControl })).toThrow(/Cache-Control|header|directive|conflict/iu);
  });

  it.each([
    ['numeric Vary', { existingVary: 42 }],
    ['non-string Vary member', { existingVary: ['Origin', 42] }],
    ['empty Vary field array', { existingVary: [] }],
    ['object Cache-Control', { existingCacheControl: { value: 'public' } }],
    ['empty Cache-Control field array', { existingCacheControl: [] }],
  ])(`rejects the illegal %s type [evidence:${evidence}]`, (_name, change) => {
    expect(() => create(change)).toThrow(/Vary|Cache-Control|header|string|array/iu);
  });

  it.each([
    ['direct credential field', { authorization: 'Bearer secret-direct-734' }],
    ['request header bag', { requestHeaders: { Authorization: 'Bearer secret-bag-912' } }],
  ])(`rejects %s rather than writing an Authorization value into output [evidence:${evidence}]`, (_name, credentialCarrier) => {
    const secret = JSON.stringify(credentialCarrier).match(/Bearer [^"}]+/u)?.[0];
    expect(secret).toBeDefined();
    let thrown: unknown;
    try {
      create(credentialCarrier);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(TypeError);
    expect(String(thrown)).not.toContain(secret!);
  });
});
