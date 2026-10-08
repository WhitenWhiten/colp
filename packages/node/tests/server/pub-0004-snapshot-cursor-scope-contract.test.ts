import { describe, expect, it } from 'vitest';

import {
  createPublicationSnapshotCursor,
  createPublicationSnapshotCursorHmacKey,
  verifyPublicationSnapshotCursor,
  type PublicationSnapshotCursorContext,
  type PublicationSnapshotCursorScope,
} from '../../src/server/index.js';

const evidence = 'http.snapshot.cursor-scope';
const keyBytes = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const baseline = Object.freeze({
  collectionId: 'collection-1',
  resourceId: 'snapshot-1',
  revision: 'revision-secret-1042',
  principal: 'principal-secret-alice',
  root: 'root-secret-node',
  depth: 3,
  include: ['annotations', 'attachments'] as const,
  pageSize: 25,
  nextPosition: 'exclusive-position-25',
} satisfies PublicationSnapshotCursorScope);

function key() {
  return createPublicationSnapshotCursorHmacKey(keyBytes);
}

function context(scope: PublicationSnapshotCursorScope = baseline): PublicationSnapshotCursorContext {
  const { nextPosition: _nextPosition, ...requestContext } = scope;
  return requestContext;
}

function cursor(scope: PublicationSnapshotCursorScope = baseline): string {
  return createPublicationSnapshotCursor(scope, key());
}

const invalid = Object.freeze({ valid: false, code: 'invalid_cursor_scope' } as const);

describe(`PUB-0004 Snapshot cursor scope server [evidence:${evidence}]`, () => {
  it(`round-trips the exclusive nextPosition only for the complete bound scope [evidence:${evidence}]`, () => {
    const signingKey = key();
    const token = createPublicationSnapshotCursor(baseline, signingKey);
    expect(verifyPublicationSnapshotCursor(token, context(), signingKey)).toEqual({
      valid: true,
      nextPosition: 'exclusive-position-25',
    });
    expect(verifyPublicationSnapshotCursor(token, context(), signingKey)).not.toHaveProperty('position');
  });

  it(`keeps revision, principal, and root out of the opaque token [evidence:${evidence}]`, () => {
    const token = cursor();
    expect(token).toMatch(/^psc1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);
    expect(token).not.toContain(baseline.revision);
    expect(token).not.toContain(baseline.principal);
    expect(token).not.toContain(baseline.root);
    expect(Buffer.from(token, 'base64url').toString('utf8')).not.toContain(baseline.revision);
    expect(Buffer.from(token, 'base64url').toString('utf8')).not.toContain(baseline.principal);
    expect(Buffer.from(token, 'base64url').toString('utf8')).not.toContain(baseline.root);
  });

  it('binds collection and resource identities into the cursor MAC', () => {
    const signingKey = key();
    const scoped = { ...baseline, collectionId: 'collection-3', resourceId: 'snapshot-3' };
    const token = createPublicationSnapshotCursor(scoped, signingKey);
    const scopedContext = context(scoped);
    expect(verifyPublicationSnapshotCursor(token, scopedContext, signingKey)).toEqual({
      valid: true,
      nextPosition: baseline.nextPosition,
    });
    expect(verifyPublicationSnapshotCursor(token, { ...scopedContext, collectionId: 'collection-2' }, signingKey)).toEqual(invalid);
    expect(verifyPublicationSnapshotCursor(token, { ...scopedContext, resourceId: 'snapshot-2' }, signingKey)).toEqual(invalid);
  });

  it.each([
    ['revision', { revision: 'revision-secret-1043' }],
    ['principal', { principal: 'principal-secret-bob' }],
    ['root', { root: 'other-root' }],
    ['depth', { depth: 4 }],
    ['include', { include: ['relations'] as const }],
    ['pageSize', { pageSize: 26 }],
  ])(`returns only invalid_cursor_scope when %s changes [evidence:${evidence}]`, (_name, change) => {
    const signingKey = key();
    const token = createPublicationSnapshotCursor(baseline, signingKey);
    expect(verifyPublicationSnapshotCursor(token, { ...context(), ...change }, signingKey)).toEqual(invalid);
  });

  it.each([
    ['reordered include values', ['attachments', 'annotations'] as const],
    ['duplicate include values', ['annotations', 'attachments', 'annotations'] as const],
  ])(`canonicalizes %s as the same include set [evidence:${evidence}]`, (_name, include) => {
    const signingKey = key();
    const token = createPublicationSnapshotCursor(baseline, signingKey);
    expect(verifyPublicationSnapshotCursor(token, { ...context(), include }, signingKey)).toEqual({
      valid: true,
      nextPosition: baseline.nextPosition,
    });
  });

  it.each([
    ['omitted to empty', undefined, [] as const],
    ['empty to omitted', [] as const, undefined],
  ])(`canonicalizes the %s include boundary [evidence:${evidence}]`, (_name, issuedInclude, verifiedInclude) => {
    const signingKey = key();
    const { include: _baselineInclude, ...withoutInclude } = baseline;
    const issued: PublicationSnapshotCursorScope = issuedInclude === undefined
      ? withoutInclude
      : { ...withoutInclude, include: issuedInclude };
    const verified = verifiedInclude === undefined
      ? context(issued)
      : { ...context(issued), include: verifiedInclude };
    const token = createPublicationSnapshotCursor(issued, signingKey);
    expect(verifyPublicationSnapshotCursor(token, verified, signingKey)).toEqual({
      valid: true,
      nextPosition: baseline.nextPosition,
    });
  });

  it.each([
    ['position bit flip', (value: string) => value.replace(/^(psc1\.)(.)/u, (_all, prefix, first: string) => `${prefix}${first === 'A' ? 'B' : 'A'}`)],
    ['MAC bit flip', (value: string) => value.replace(/\.([A-Za-z0-9_-])([A-Za-z0-9_-]{42})$/u, (_all, first: string, rest: string) => `.${first === 'A' ? 'B' : 'A'}${rest}`)],
    ['truncation', (value: string) => value.slice(0, -1)],
    ['appended data', (value: string) => `${value}A`],
    ['non-canonical base64url padding', (value: string) => value.replace(/^(psc1\.[^.]+)/u, '$1=')],
    ['wrong version', (value: string) => `psc2.${value.slice('psc1.'.length)}`],
  ])(`collapses token %s to invalid_cursor_scope [evidence:${evidence}]`, (_name, mutate) => {
    const signingKey = key();
    const token = createPublicationSnapshotCursor(baseline, signingKey);
    expect(verifyPublicationSnapshotCursor(mutate(token), context(), signingKey)).toEqual(invalid);
  });

  it(`collapses verification with the wrong key without leaking a reason [evidence:${evidence}]`, () => {
    const token = cursor();
    const wrongKey = createPublicationSnapshotCursorHmacKey(new Uint8Array(32).fill(0xa5));
    const result = verifyPublicationSnapshotCursor(token, context(), wrongKey);
    expect(result).toEqual(invalid);
    expect(Object.keys(result)).toEqual(['valid', 'code']);
    expect(JSON.stringify(result)).not.toMatch(/revision|principal|root|position|signature|key|mac/iu);
  });

  it.each([
    ['empty revision', { revision: '' }],
    ['controlled revision', { revision: 'rev\nsecret' }],
    ['unpaired revision surrogate', { revision: '\ud800' }],
    ['oversized revision', { revision: 'r'.repeat(4097) }],
    ['empty principal', { principal: '' }],
    ['controlled principal', { principal: 'principal\u007fsecret' }],
    ['unpaired principal surrogate', { principal: '\udfff' }],
    ['oversized principal', { principal: 'p'.repeat(4097) }],
    ['empty root', { root: '' }],
    ['controlled root', { root: 'root\u0000secret' }],
    ['unpaired root surrogate', { root: '\ud800' }],
    ['oversized root', { root: 'r'.repeat(4097) }],
    ['empty nextPosition', { nextPosition: '' }],
    ['controlled nextPosition', { nextPosition: 'position\u001fsecret' }],
    ['unpaired nextPosition surrogate', { nextPosition: '\udfff' }],
  ])(`rejects the %s string boundary at issuance [evidence:${evidence}]`, (_name, change) => {
    expect(() => createPublicationSnapshotCursor({ ...baseline, ...change }, key()))
      .toThrow(/must (?:be|not exceed)/u);
  });

  it(`frames adjacent scope fields without concatenation collisions [evidence:${evidence}]`, () => {
    const signingKey = key();
    const left = createPublicationSnapshotCursor({
      ...baseline,
      revision: 'a',
      principal: 'bc',
    }, signingKey);
    const right = createPublicationSnapshotCursor({
      ...baseline,
      revision: 'ab',
      principal: 'c',
    }, signingKey);

    expect(left).not.toBe(right);
    expect(verifyPublicationSnapshotCursor(left, {
      ...context(),
      revision: 'ab',
      principal: 'c',
    }, signingKey)).toEqual(invalid);
  });

  it.each([
    ['pageSize zero', { pageSize: 0 }],
    ['pageSize negative', { pageSize: -1 }],
    ['pageSize fractional', { pageSize: 1.5 }],
    ['pageSize unsafe', { pageSize: Number.MAX_SAFE_INTEGER + 1 }],
    ['depth negative', { depth: -1 }],
    ['depth fractional', { depth: 1.5 }],
    ['depth unsafe', { depth: Number.MAX_SAFE_INTEGER + 1 }],
  ])(`rejects the %s integer boundary at issuance [evidence:${evidence}]`, (_name, change) => {
    expect(() => createPublicationSnapshotCursor({ ...baseline, ...change }, key())).toThrow(/integer/u);
  });

  it.each([
    ['unsupported include', ['nodes']],
    ['non-string include', [1]],
    ['non-array include', 'annotations'],
  ])(`rejects %s at issuance [evidence:${evidence}]`, (_name, include) => {
    expect(() => createPublicationSnapshotCursor({
      ...baseline,
      include: include as never,
    }, key())).toThrow(/include/u);
  });

  it(`accepts the exact 128-character cursor boundary and rejects the next position byte [evidence:${evidence}]`, () => {
    const signingKey = key();
    const maximum = { ...baseline, nextPosition: 'x'.repeat(58) };
    const token = createPublicationSnapshotCursor(maximum, signingKey);
    expect(token).toHaveLength(128);
    expect(verifyPublicationSnapshotCursor(token, context(maximum), signingKey)).toEqual({
      valid: true,
      nextPosition: maximum.nextPosition,
    });
    expect(() => createPublicationSnapshotCursor({ ...baseline, nextPosition: 'x'.repeat(59) }, signingKey))
      .toThrow(/128 characters/u);
  });

  // F-27: explicit wire-budget pair — just within 128 succeeds; one position byte over fails with 128 semantics.
  it(`succeeds when the issued cursor is exactly at the 128-character wire budget (F-27) [evidence:${evidence}]`, () => {
    const signingKey = key();
    const withinBudget = { ...baseline, nextPosition: 'x'.repeat(58) };
    const token = createPublicationSnapshotCursor(withinBudget, signingKey);

    expect(token).toHaveLength(128);
    expect(token.length).toBeLessThanOrEqual(128);
    expect(verifyPublicationSnapshotCursor(token, context(withinBudget), signingKey)).toEqual({
      valid: true,
      nextPosition: withinBudget.nextPosition,
    });
  });

  it(`rejects issuance one position byte over the 128-character wire budget with a RangeError (F-27) [evidence:${evidence}]`, () => {
    const signingKey = key();

    expect(() => createPublicationSnapshotCursor({ ...baseline, nextPosition: 'x'.repeat(59) }, signingKey))
      .toThrow(RangeError);
    expect(() => createPublicationSnapshotCursor({ ...baseline, nextPosition: 'x'.repeat(59) }, signingKey))
      .toThrow(/Publication Snapshot cursor must not exceed 128 characters/u);
  });

  it.each([
    ['empty token', ''],
    ['oversized token', `psc1.${'A'.repeat(129)}`],
    ['control character token', 'psc1.A\u0000.B'],
    ['unpaired surrogate token', 'psc1.\ud800.B'],
    ['non-string token', 42],
  ])(`returns invalid_cursor_scope for the %s verification boundary [evidence:${evidence}]`, (_name, token) => {
    expect(verifyPublicationSnapshotCursor(token as string, context(), key())).toEqual(invalid);
  });

  it.each([
    ['short key', 31],
    ['oversized key', 1025],
    ['empty key', 0],
  ])(`rejects a %s without creating a key capability [evidence:${evidence}]`, (_name, size) => {
    expect(() => createPublicationSnapshotCursorHmacKey(new Uint8Array(size))).toThrow(/32-1024 bytes/u);
  });

  it(`copies key material and exposes no readable key bytes [evidence:${evidence}]`, () => {
    const source = new Uint8Array(32).fill(0x31);
    const signingKey = createPublicationSnapshotCursorHmacKey(source);
    const token = createPublicationSnapshotCursor(baseline, signingKey);
    source.fill(0);

    expect(verifyPublicationSnapshotCursor(token, context(), signingKey)).toEqual({
      valid: true,
      nextPosition: baseline.nextPosition,
    });
    expect(Object.keys(signingKey)).toEqual([]);
    expect(JSON.stringify(signingKey)).toBe('{}');
  });

  it(`destroys a key idempotently and fails closed for create and verify [evidence:${evidence}]`, () => {
    const signingKey = key();
    const token = createPublicationSnapshotCursor(baseline, signingKey);
    expect(signingKey.destroyed).toBe(false);
    signingKey.destroy();
    signingKey.destroy();
    expect(signingKey.destroyed).toBe(true);
    expect(() => createPublicationSnapshotCursor(baseline, signingKey)).toThrow(/destroyed cursor key/u);
    expect(verifyPublicationSnapshotCursor(token, context(), signingKey)).toEqual(invalid);
  });

  it(`fails verification closed for malformed context without disclosing validation details [evidence:${evidence}]`, () => {
    const token = cursor();
    const result = verifyPublicationSnapshotCursor(token, {
      ...context(),
      principal: '\ud800',
    }, key());
    expect(result).toEqual(invalid);
    expect(result).not.toHaveProperty('detail');
    expect(result).not.toHaveProperty('cause');
  });
});
