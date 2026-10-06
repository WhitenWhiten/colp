import { createHash, randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { createUrlHash, isUrlHash } from '../../src/semantic/index.js';
import { createValidatorRegistry } from '../../src/schema/index.js';

const evidence = '[evidence:core.url-hash-canonical-base64]';
const validators = createValidatorRegistry();

function wireValue(bytes: Uint8Array): string {
  return `sha-256=:${Buffer.from(bytes).toString('base64')}:`;
}

function payload(value: string): string {
  return value.slice('sha-256=:'.length, -1);
}

function expectParity(value: string, valid: boolean): void {
  expect(
    validators.validate('urlHash', value).valid,
    `Schema result for ${JSON.stringify(value)}`,
  ).toBe(valid);
  expect(isUrlHash(value), `runtime result for ${JSON.stringify(value)}`).toBe(valid);
}

const knownEmptySha256 =
  'sha-256=:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=:';
const generatedSha256 = wireValue(createHash('sha256').update('canonical-base64').digest());
const randomDigest = wireValue(randomBytes(32));
const standardAlphabetDigest = wireValue(Buffer.alloc(32, 0xfb));
const zeroDigest = wireValue(Buffer.alloc(32));

const validCases = [
  ['known SHA-256 digest', knownEmptySha256],
  ['generated SHA-256 digest', generatedSha256],
  ['random 32-octet digest', randomDigest],
  ['standard alphabet digest containing + and /', standardAlphabetDigest],
] as const;

const invalidCases = [
  ['base64url hyphen', standardAlphabetDigest.replace('+', '-')],
  ['base64url underscore', standardAlphabetDigest.replace('/', '_')],
  ['missing padding', zeroDigest.replace(/=:$/u, ':')],
  ['extra padding', zeroDigest.replace(/=:$/u, '==:')],
  ['padding before the final sextet', `sha-256=:${'A'.repeat(42)}=A:`],
  ['padding in the middle', `sha-256=:${'A'.repeat(20)}=${'A'.repeat(23)}:`],
  ['leading payload whitespace', zeroDigest.replace('sha-256=:', 'sha-256=: ')],
  ['embedded payload whitespace', zeroDigest.replace('AAAA', 'AA AA')],
  ['embedded payload newline', zeroDigest.replace('AAAA', 'AA\nAA')],
  ['trailing wire whitespace', `${zeroDigest} `],
  ['trailing wire CRLF', `${zeroDigest}\r\n`],
  ['invalid punctuation', zeroDigest.replace('AAAA', 'AA*A')],
  ['31-octet payload', wireValue(Buffer.alloc(31))],
  ['33-octet payload', wireValue(Buffer.alloc(33))],
  ['non-zero pad bits ending in B', zeroDigest.replace('A=:', 'B=:')],
  ['non-zero pad bits ending in C', zeroDigest.replace('A=:', 'C=:')],
  ['non-zero pad bits ending in D', zeroDigest.replace('A=:', 'D=:')],
] as const;

describe(`CORE-0039 canonical padded Base64 ${evidence}`, () => {
  it('keeps createUrlHash, isUrlHash, and Schema validation in public-contract parity', () => {
    const url = 'https://example.test/canonical-base64?query=kept#fragment';
    const value = createUrlHash(url);

    expect(value).toBe(wireValue(createHash('sha256').update(url, 'utf8').digest()));
    expectParity(value, true);
    expect(
      validators.validate('nodeCreate', {
        kind: 'bookmark',
        title: 'Canonical Base64',
        url,
        urlHash: value,
      }),
    ).toEqual({ valid: true, errors: [] });
  });

  it.each(validCases)('accepts a canonical %s', (_case, value) => {
    const encoded = payload(value);
    const decoded = Buffer.from(encoded, 'base64');

    expect(encoded).toHaveLength(44);
    expect(encoded.match(/=/gu)).toHaveLength(1);
    expect(encoded.endsWith('=')).toBe(true);
    expect(decoded).toHaveLength(32);
    expect(decoded.toString('base64')).toBe(encoded);
    expectParity(value, true);
  });

  it('uses the standard Base64 alphabet when + and / are required', () => {
    const encoded = payload(standardAlphabetDigest);

    expect(encoded).toContain('+');
    expect(encoded).toContain('/');
    expect(encoded).not.toMatch(/[-_]/u);
    expectParity(standardAlphabetDigest, true);
  });

  it.each(invalidCases)('rejects %s in both Schema and runtime validation', (_case, value) => {
    expectParity(value, false);
  });

  it.each(['B', 'C', 'D'] as const)(
    'rejects non-zero pad bits ending in %s even though a generic decoder accepts them',
    (finalSextet) => {
      const nonCanonical = payload(zeroDigest).replace(/A=$/u, `${finalSextet}=`);
      const decoded = Buffer.from(nonCanonical, 'base64');

      expect(decoded).toHaveLength(32);
      expect(decoded.equals(Buffer.alloc(32))).toBe(true);
      expect(decoded.toString('base64')).not.toBe(nonCanonical);
      expectParity(`sha-256=:${nonCanonical}:`, false);
    },
  );
});
