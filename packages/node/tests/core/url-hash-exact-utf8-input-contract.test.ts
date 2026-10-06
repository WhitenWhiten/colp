import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { createUrlHash } from '../../src/semantic/index.js';
import { createValidatorRegistry } from '../../src/schema/index.js';

const evidence = '[evidence:core.url-hash-exact-utf8-input]';
const validators = createValidatorRegistry();

function independentUrlHash(url: string): string {
  const utf8 = Buffer.from(url, 'utf8');
  return `sha-256=:${createHash('sha256').update(utf8).digest('base64')}:`;
}

const preservedUrls = [
  'https://example.test/bookmarks/42',
  'HTTPS://EXAMPLE.TEST:443/%7euser?b=2&a=1#Keep',
  'http://example.test:80/path',
  'https://example.test/%2F/%2f/%41/A',
  'https://example.test/search?tag=one&tag=&tag=two&&flag&trailing=',
  'https://example.test/path#Case-Sensitive%2fFragment',
  'https://example.test/caf%C3%A9?label=%E7%9F%A5%E8%AF%86',
  'https://example.test/cafe%CC%81?label=%e7%9f%a5%e8%af%86',
] as const;

const distinctSpellings = [
  ['scheme case', 'HTTPS://example.test/path', 'https://example.test/path'],
  ['host case', 'https://EXAMPLE.TEST/path', 'https://example.test/path'],
  ['explicit default port', 'https://example.test:443/path', 'https://example.test/path'],
  ['percent-encoding hex case', 'https://example.test/%2F', 'https://example.test/%2f'],
  ['encoded versus unreserved', 'https://example.test/%41', 'https://example.test/A'],
  ['query order', 'https://example.test/?a=1&b=2', 'https://example.test/?b=2&a=1'],
  ['duplicate query order', 'https://example.test/?a=1&a=2', 'https://example.test/?a=2&a=1'],
  ['empty query spelling', 'https://example.test/?a=&b=1', 'https://example.test/?a&b=1'],
  ['empty query parameter', 'https://example.test/?a=1&&b=2', 'https://example.test/?a=1&b=2'],
  ['fragment presence', 'https://example.test/path#kept', 'https://example.test/path'],
  ['fragment case', 'https://example.test/path#Keep', 'https://example.test/path#keep'],
  [
    'percent-encoded Unicode normalization spelling',
    'https://example.test/caf%C3%A9',
    'https://example.test/cafe%CC%81',
  ],
] as const;

describe(`CORE-0040 exact UTF-8 URL hash input ${evidence}`, () => {
  it('matches a fixed SHA-256 known-answer vector', () => {
    expect(createUrlHash('https://example.test/exact-known-vector')).toBe(
      'sha-256=:lmBfo/kro7/eNyeaECugqPflW1jOLcePvCzEaFkZRrk=:',
    );
  });

  it.each(preservedUrls)('matches independent SHA-256 over the exact UTF-8 bytes for %j', (url) => {
    expect(createUrlHash(url)).toBe(independentUrlHash(url));
  });

  it.each(distinctSpellings)('does not normalize %s', (_case, left, right) => {
    expect(left).not.toBe(right);
    expect(createUrlHash(left)).toBe(independentUrlHash(left));
    expect(createUrlHash(right)).toBe(independentUrlHash(right));
    expect(createUrlHash(left)).not.toBe(createUrlHash(right));
  });

  it('uses the runtime Unicode string UTF-8 bytes without making a Bookmark Schema claim', () => {
    const composed = 'https://example.test/caf\u00e9';
    const decomposed = 'https://example.test/cafe\u0301';
    const composedBytes = Buffer.from(composed, 'utf8');
    const decomposedBytes = Buffer.from(decomposed, 'utf8');

    expect(composedBytes.subarray(-5).toString('hex')).toBe('636166c3a9');
    expect(decomposedBytes.subarray(-6).toString('hex')).toBe('63616665cc81');
    expect(createUrlHash(composed)).toBe(
      `sha-256=:${createHash('sha256').update(composedBytes).digest('base64')}:`,
    );
    expect(createUrlHash(decomposed)).toBe(
      `sha-256=:${createHash('sha256').update(decomposedBytes).digest('base64')}:`,
    );
    expect(createUrlHash(composed)).not.toBe(createUrlHash(decomposed));
  });

  it('hashes an exact 4096-character URL accepted by the Bookmark Schema', () => {
    const prefix = 'https://example.test/bookmark?opaque=';
    const suffix = '#Kept';
    const url = `${prefix}${'x'.repeat(4096 - prefix.length - suffix.length)}${suffix}`;

    expect(url).toHaveLength(4096);
    expect(
      validators.validate('nodeCreate', { kind: 'bookmark', title: 'Boundary', url }),
    ).toEqual({ valid: true, errors: [] });
    expect(createUrlHash(url)).toBe(independentUrlHash(url));
  });

  it.each(preservedUrls.slice(0, 3))('is deterministic for the unchanged input %j', (url) => {
    const first = createUrlHash(url);

    expect(createUrlHash(url)).toBe(first);
    expect(createUrlHash(url)).toBe(first);
  });

  it('emits canonical padded Base64 that decodes to exactly 32 octets', () => {
    const value = createUrlHash('https://example.test/exact-digest-envelope');
    const match = /^sha-256=:([A-Za-z0-9+/]{43}=):$/u.exec(value);

    expect(match).not.toBeNull();
    const encoded = match?.[1] ?? '';
    expect(Buffer.from(encoded, 'base64')).toHaveLength(32);
    expect(Buffer.from(encoded, 'base64').toString('base64')).toBe(encoded);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['number', 42],
    ['boolean', true],
    ['bigint', 42n],
    ['plain object', { toString: () => 'https://example.test/coerced' }],
    ['array', ['https://example.test/coerced']],
    ['URL object', new URL('https://example.test/coerced')],
    ['Uint8Array', new Uint8Array([0x68, 0x74, 0x74, 0x70])],
    ['boxed String', new String('https://example.test/coerced')],
  ] as const)('rejects the non-string %s input instead of coercing it', (_case, value) => {
    expect(() => createUrlHash(value as unknown as string)).toThrow(TypeError);
  });
});
