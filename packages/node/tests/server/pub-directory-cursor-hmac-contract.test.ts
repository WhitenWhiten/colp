import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PUBLICATION_DIRECTORY_SORT,
  createPublicationDirectoryCursor,
  createPublicationDirectoryCursorHmacKey,
  createPublicationDirectoryFilterDigest,
  verifyPublicationDirectoryCursor,
  type PublicationDirectoryCursorContext,
  type PublicationDirectoryCursorScope,
} from '../../src/server/index.js';

const evidence = 'http.directory.cursor-hmac';
const keyBytes = Uint8Array.from({ length: 32 }, (_, index) => index + 1);

const baselineFilter = Object.freeze({
  tag: 'design',
  creator: 'https://alice.example/about',
  kind: 'knowledge_collection',
  updatedSince: '2026-07-16T00:00:00Z',
  q: 'interface systems',
} as const);

const baseline = Object.freeze({
  resourceId: 'directory/mount-a',
  principal: 'principal-secret-alice',
  filterDigest: createPublicationDirectoryFilterDigest(baselineFilter),
  sort: DEFAULT_PUBLICATION_DIRECTORY_SORT,
  limit: 50,
  protocolVersion: '0.1',
  nextPosition: 'exclusive-after-collection-25',
} satisfies PublicationDirectoryCursorScope);

function key() {
  return createPublicationDirectoryCursorHmacKey(keyBytes);
}

function context(scope: PublicationDirectoryCursorScope = baseline): PublicationDirectoryCursorContext {
  const { nextPosition: _nextPosition, ...requestContext } = scope;
  return requestContext;
}

function cursor(scope: PublicationDirectoryCursorScope = baseline): string {
  return createPublicationDirectoryCursor(scope, key());
}

const invalid = Object.freeze({ valid: false, code: 'invalid_cursor_scope' } as const);

describe(`Directory cursor HMAC server [evidence:${evidence}]`, () => {
  it(`round-trips the exclusive nextPosition only for the complete bound scope [evidence:${evidence}]`, () => {
    const signingKey = key();
    const token = createPublicationDirectoryCursor(baseline, signingKey);
    const result = verifyPublicationDirectoryCursor(token, context(), signingKey);

    expect(result).toEqual({
      valid: true,
      nextPosition: 'exclusive-after-collection-25',
    });
    expect(result).not.toHaveProperty('position');
    expect(result).not.toHaveProperty('principal');
    expect(result).not.toHaveProperty('filterDigest');
    expect(result).not.toHaveProperty('limit');
    expect(Object.keys(result).sort()).toEqual(['nextPosition', 'valid']);
  });

  it(`keeps principal, filterDigest, sort, and protocolVersion out of the opaque token [evidence:${evidence}]`, () => {
    const token = cursor();
    expect(token).toMatch(/^pdc1\.p[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/u);
    expect(token.length).toBeLessThanOrEqual(128);

    for (const secret of [
      baseline.principal,
      baseline.filterDigest,
      baseline.sort,
      baseline.protocolVersion,
      baseline.nextPosition,
      baselineFilter.tag,
      baselineFilter.q,
    ]) {
      expect(token).not.toContain(secret);
      expect(Buffer.from(token, 'base64url').toString('utf8')).not.toContain(secret);
    }
  });

  it.each([
    ['resource identity', { resourceId: 'directory/mount-b' }],
    ['principal', { principal: 'principal-secret-bob' }],
    ['limit', { limit: 51 }],
    ['query filterDigest', {
      filterDigest: createPublicationDirectoryFilterDigest({ ...baselineFilter, tag: 'engineering' }),
    }],
    ['empty query filterDigest', {
      filterDigest: createPublicationDirectoryFilterDigest({}),
    }],
    ['sort', { sort: 'id ASC' }],
    ['protocolVersion', { protocolVersion: '0.2' }],
  ])(`returns only invalid_cursor_scope when %s changes [evidence:${evidence}]`, (_name, change) => {
    const signingKey = key();
    const token = createPublicationDirectoryCursor(baseline, signingKey);
    const result = verifyPublicationDirectoryCursor(token, { ...context(), ...change }, signingKey);

    expect(result).toEqual(invalid);
    expect(Object.keys(result)).toEqual(['valid', 'code']);
  });

  it.each([
    ['position bit flip', (value: string) => value.replace(/^(pdc1\.p)(.)/u, (_all, prefix: string, first: string) => `${prefix}${first === 'A' ? 'B' : 'A'}`)],
    ['MAC bit flip', (value: string) => value.replace(/\.([A-Za-z0-9_-])([A-Za-z0-9_-]{42})$/u, (_all, first: string, rest: string) => `.${first === 'A' ? 'B' : 'A'}${rest}`)],
    ['truncation', (value: string) => value.slice(0, -1)],
    ['appended data', (value: string) => `${value}A`],
    ['non-canonical base64url padding', (value: string) => value.replace(/^(pdc1\.p[^.]+)/u, '$1=')],
    ['wrong version', (value: string) => `pdc2.${value.slice('pdc1.'.length)}`],
    ['snapshot prefix spoof', (value: string) => `psc1.${value.slice('pdc1.'.length)}`],
  ])(`collapses token %s to invalid_cursor_scope [evidence:${evidence}]`, (_name, mutate) => {
    const signingKey = key();
    const token = createPublicationDirectoryCursor(baseline, signingKey);
    expect(verifyPublicationDirectoryCursor(mutate(token), context(), signingKey)).toEqual(invalid);
  });

  it(`collapses verification with the wrong key without leaking a reason [evidence:${evidence}]`, () => {
    const token = cursor();
    const wrongKey = createPublicationDirectoryCursorHmacKey(new Uint8Array(32).fill(0xa5));
    const result = verifyPublicationDirectoryCursor(token, context(), wrongKey);

    expect(result).toEqual(invalid);
    expect(Object.keys(result)).toEqual(['valid', 'code']);
    expect(JSON.stringify(result)).not.toMatch(/principal|filter|sort|limit|position|signature|key|mac/iu);
  });

  it(`destroys a key idempotently and fails closed for create and verify [evidence:${evidence}]`, () => {
    const signingKey = key();
    const token = createPublicationDirectoryCursor(baseline, signingKey);
    expect(signingKey.destroyed).toBe(false);

    signingKey.destroy();
    signingKey.destroy();
    expect(signingKey.destroyed).toBe(true);

    expect(() => createPublicationDirectoryCursor(baseline, signingKey)).toThrow(/destroyed cursor key/u);
    expect(verifyPublicationDirectoryCursor(token, context(), signingKey)).toEqual(invalid);
  });

  it(`stable filter digests bind query fields and reject cross-query reuse [evidence:${evidence}]`, () => {
    const signingKey = key();
    const emptyDigest = createPublicationDirectoryFilterDigest();
    const emptyObjectDigest = createPublicationDirectoryFilterDigest({});
    const reorderedDigest = createPublicationDirectoryFilterDigest({
      q: baselineFilter.q,
      updatedSince: baselineFilter.updatedSince,
      kind: baselineFilter.kind,
      creator: baselineFilter.creator,
      tag: baselineFilter.tag,
    });
    const partialDigest = createPublicationDirectoryFilterDigest({ tag: baselineFilter.tag });

    expect(emptyDigest).toBe(emptyObjectDigest);
    expect(reorderedDigest).toBe(baseline.filterDigest);
    expect(partialDigest).not.toBe(baseline.filterDigest);

    const token = createPublicationDirectoryCursor(baseline, signingKey);
    expect(verifyPublicationDirectoryCursor(token, {
      ...context(),
      filterDigest: partialDigest,
    }, signingKey)).toEqual(invalid);
    expect(verifyPublicationDirectoryCursor(token, {
      ...context(),
      filterDigest: emptyDigest,
    }, signingKey)).toEqual(invalid);
  });

  it(`frames adjacent scope fields without concatenation collisions [evidence:${evidence}]`, () => {
    const signingKey = key();
    const left = createPublicationDirectoryCursor({
      ...baseline,
      principal: 'a',
      filterDigest: createPublicationDirectoryFilterDigest({ tag: 'bc' }),
    }, signingKey);
    const right = createPublicationDirectoryCursor({
      ...baseline,
      principal: 'ab',
      filterDigest: createPublicationDirectoryFilterDigest({ tag: 'c' }),
    }, signingKey);

    expect(left).not.toBe(right);
    expect(verifyPublicationDirectoryCursor(left, {
      ...context(),
      principal: 'ab',
      filterDigest: createPublicationDirectoryFilterDigest({ tag: 'c' }),
    }, signingKey)).toEqual(invalid);
  });

  it(`frames filter field presence so adjacent values cannot collide [evidence:${evidence}]`, () => {
    const left = createPublicationDirectoryFilterDigest({ tag: 'ab', creator: 'c' });
    const right = createPublicationDirectoryFilterDigest({ tag: 'a', creator: 'bc' });
    expect(left).not.toBe(right);
  });

  it.each([
    ['empty principal', { principal: '' }],
    ['controlled principal', { principal: 'principal\u007fsecret' }],
    ['unpaired principal surrogate', { principal: '\ud800' }],
    ['oversized principal', { principal: 'p'.repeat(4097) }],
    ['empty filterDigest', { filterDigest: '' }],
    ['controlled filterDigest', { filterDigest: 'digest\nsecret' }],
    ['empty sort', { sort: '' }],
    ['controlled sort', { sort: 'sort\u0000secret' }],
    ['empty protocolVersion', { protocolVersion: '' }],
    ['controlled protocolVersion', { protocolVersion: '0.1\u001f' }],
    ['empty nextPosition', { nextPosition: '' }],
    ['controlled nextPosition', { nextPosition: 'position\u001fsecret' }],
    ['unpaired nextPosition surrogate', { nextPosition: '\udfff' }],
  ])(`rejects the %s string boundary at issuance [evidence:${evidence}]`, (_name, change) => {
    expect(() => createPublicationDirectoryCursor({ ...baseline, ...change }, key()))
      .toThrow(/must (?:be|not exceed)/u);
  });

  it.each([
    ['limit zero', { limit: 0 }],
    ['limit negative', { limit: -1 }],
    ['limit fractional', { limit: 1.5 }],
    ['limit unsafe', { limit: Number.MAX_SAFE_INTEGER + 1 }],
  ])(`rejects the %s integer boundary at issuance [evidence:${evidence}]`, (_name, change) => {
    expect(() => createPublicationDirectoryCursor({ ...baseline, ...change }, key())).toThrow(/integer/u);
  });

  it(`accepts the exact 128-character cursor boundary and rejects the next position byte [evidence:${evidence}]`, () => {
    const signingKey = key();
    const maximum = { ...baseline, nextPosition: 'x'.repeat(58) };
    const token = createPublicationDirectoryCursor(maximum, signingKey);

    expect(token).toHaveLength(128);
    expect(verifyPublicationDirectoryCursor(token, context(maximum), signingKey)).toEqual({
      valid: true,
      nextPosition: maximum.nextPosition,
    });
    expect(() => createPublicationDirectoryCursor({ ...baseline, nextPosition: 'x'.repeat(59) }, signingKey))
      .toThrow(/128 characters/u);
  });

  it.each([
    ['empty token', ''],
    ['oversized token', `pdc1.p${'A'.repeat(129)}`],
    ['control character token', 'pdc1.pA\u0000.B'],
    ['unpaired surrogate token', 'pdc1.p\ud800.B'],
    ['non-string token', 42],
  ])(`returns invalid_cursor_scope for the %s verification boundary [evidence:${evidence}]`, (_name, token) => {
    expect(verifyPublicationDirectoryCursor(token as string, context(), key())).toEqual(invalid);
  });

  it.each([
    ['short key', 31],
    ['oversized key', 1025],
    ['empty key', 0],
  ])(`rejects a %s without creating a key capability [evidence:${evidence}]`, (_name, size) => {
    expect(() => createPublicationDirectoryCursorHmacKey(new Uint8Array(size))).toThrow(/32-1024 bytes/u);
  });

  it(`copies key material and exposes no readable key bytes [evidence:${evidence}]`, () => {
    const source = new Uint8Array(32).fill(0x31);
    const signingKey = createPublicationDirectoryCursorHmacKey(source);
    const token = createPublicationDirectoryCursor(baseline, signingKey);
    source.fill(0);

    expect(verifyPublicationDirectoryCursor(token, context(), signingKey)).toEqual({
      valid: true,
      nextPosition: baseline.nextPosition,
    });
    expect(Object.keys(signingKey)).toEqual([]);
    expect(JSON.stringify(signingKey)).toBe('{}');
    expect(signingKey).not.toHaveProperty('key');
    expect(signingKey).not.toHaveProperty('material');
  });

  it(`fails verification closed for malformed context without disclosing validation details [evidence:${evidence}]`, () => {
    const token = cursor();
    const result = verifyPublicationDirectoryCursor(token, {
      ...context(),
      principal: '\ud800',
    }, key());

    expect(result).toEqual(invalid);
    expect(result).not.toHaveProperty('detail');
    expect(result).not.toHaveProperty('cause');
    expect(result).not.toHaveProperty('message');
  });

  it(`uses the protocol default Directory sort constant in round-trips [evidence:${evidence}]`, () => {
    expect(DEFAULT_PUBLICATION_DIRECTORY_SORT).toBe('updatedAt DESC, id ASC');
    const signingKey = key();
    const token = createPublicationDirectoryCursor({
      ...baseline,
      sort: DEFAULT_PUBLICATION_DIRECTORY_SORT,
    }, signingKey);
    expect(verifyPublicationDirectoryCursor(token, {
      ...context(),
      sort: DEFAULT_PUBLICATION_DIRECTORY_SORT,
    }, signingKey)).toEqual({
      valid: true,
      nextPosition: baseline.nextPosition,
    });
  });
});
