import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  CACHE_ERROR_CATEGORY,
  CACHE_SCHEMA_VERSION,
  decodeCacheEnvelope,
  encodeCacheEnvelope,
  type CacheEnvelopeTimes,
} from '../../../src/infrastructure/cache/index.js';

const MAX_ENTRY_BYTES = 512 * 1024; // config.cache.limits.maxEntryBytes default
const times: CacheEnvelopeTimes = { writtenAtMs: 100, softExpiresAtMs: 200, hardExpiresAtMs: 300 };

function decode(raw: string) {
  return decodeCacheEnvelope(raw, { maxEntryBytes: MAX_ENTRY_BYTES });
}

function encode(value: unknown, overrides: Partial<CacheEnvelopeTimes> = {}) {
  return encodeCacheEnvelope(value, { ...times, ...overrides }, { maxEntryBytes: MAX_ENTRY_BYTES });
}

function envelopeRaw(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    schemaVersion: CACHE_SCHEMA_VERSION,
    writtenAtMs: 1,
    softExpiresAtMs: 2,
    hardExpiresAtMs: 3,
    value: { id: 'collection-1' },
    ...overrides,
  });
}

function assertDecodeError(raw: string, reason: string): void {
  const result = decode(raw);
  assert.equal(result.kind, 'decode_error');
  if (result.kind === 'decode_error') {
    assert.equal(result.category, CACHE_ERROR_CATEGORY.DECODE_ERROR);
    assert.equal(result.category, 'cache_decode_error');
    assert.equal(result.reason, reason);
  }
}

function assertEncodeRejected(value: unknown, reason: string): void {
  const result = encode(value);
  assert.equal(result.kind, 'rejected');
  if (result.kind === 'rejected') assert.equal(result.reason, reason);
}

describe('cache envelope codec', () => {
  test('encodeCacheEnvelope then decodeCacheEnvelope round-trips a public projection', () => {
    const value = { id: 'collection-1', title: 'Engineering Notes', tags: ['a', 'b'] };
    const encoded = encode(value);
    assert.equal(encoded.kind, 'ok');
    if (encoded.kind !== 'ok') return;
    assert.ok(encoded.utf8Bytes > 0);
    assert.equal(encoded.utf8Bytes, Buffer.byteLength(encoded.encoded, 'utf8'));

    const decoded = decode(encoded.encoded);
    assert.equal(decoded.kind, 'ok');
    if (decoded.kind !== 'ok') return;
    assert.deepEqual(decoded.envelope.value, value);
    assert.equal(decoded.envelope.schemaVersion, CACHE_SCHEMA_VERSION);
    assert.equal(decoded.envelope.writtenAtMs, times.writtenAtMs);
    assert.equal(decoded.envelope.softExpiresAtMs, times.softExpiresAtMs);
    assert.equal(decoded.envelope.hardExpiresAtMs, times.hardExpiresAtMs);
    assert.equal(decoded.utf8Bytes, encoded.utf8Bytes);
  });

  test('wrong schema version is rejected with a stable decode classification', () => {
    assertDecodeError(envelopeRaw({ schemaVersion: 2 }), 'bad_schema_version');
    assertDecodeError(envelopeRaw({ schemaVersion: 0 }), 'bad_schema_version');
    assertDecodeError(envelopeRaw({ schemaVersion: '1' }), 'bad_schema_version');
  });

  test('decode failures return the stable cache_decode_error category instead of throwing', () => {
    const brokenEnvelopes = [
      '',
      '{oops',
      '[1, 2]',
      '"hello"',
      'null',
      'x'.repeat(MAX_ENTRY_BYTES + 1),
      envelopeRaw({ schemaVersion: 99 }),
      envelopeRaw({ writtenAtMs: -1 }),
      envelopeRaw({ value: { email: 'user@example.test' } }),
    ];
    for (const raw of brokenEnvelopes) {
      assert.doesNotThrow(() => decode(raw));
    }
  });

  test('decode rejects malformed envelopes', () => {
    assertDecodeError('{oops', 'invalid_json');
    assertDecodeError('', 'invalid_json');
    assertDecodeError('not json at all', 'invalid_json');
    assertDecodeError('[1, 2]', 'not_plain_object');
    assertDecodeError('"hello"', 'not_plain_object');
    assertDecodeError('null', 'not_plain_object');
  });

  test('decode rejects invalid time fields', () => {
    assertDecodeError(envelopeRaw({ writtenAtMs: -1 }), 'bad_time_fields');
    assertDecodeError(envelopeRaw({ softExpiresAtMs: -1 }), 'bad_time_fields');
    assertDecodeError(envelopeRaw({ hardExpiresAtMs: -1 }), 'bad_time_fields');
    assertDecodeError(envelopeRaw({ writtenAtMs: 1.5 }), 'bad_time_fields');
    assertDecodeError(envelopeRaw({ softExpiresAtMs: '2' }), 'bad_time_fields');
    assertDecodeError(envelopeRaw({ hardExpiresAtMs: Number.MAX_SAFE_INTEGER + 1 }), 'bad_time_fields');
    // Monotonicity: writtenAtMs <= softExpiresAtMs <= hardExpiresAtMs.
    assertDecodeError(envelopeRaw({ softExpiresAtMs: 0 }), 'bad_time_fields');
    assertDecodeError(envelopeRaw({ hardExpiresAtMs: 1 }), 'bad_time_fields');
  });

  test('decode rejects envelopes whose value is not a plain object', () => {
    assertDecodeError(envelopeRaw({ value: null }), 'bad_value');
    assertDecodeError(envelopeRaw({ value: [1, 2] }), 'bad_value');
    assertDecodeError(envelopeRaw({ value: 'text' }), 'bad_value');
    assertDecodeError(envelopeRaw({ value: undefined }), 'bad_value');
  });

  test('oversized values are rejected on encode and oversized envelopes on decode', () => {
    assertEncodeRejected({ data: 'x'.repeat(MAX_ENTRY_BYTES) }, 'oversized');
    assertEncodeRejected({ data: 'x'.repeat(MAX_ENTRY_BYTES + 1) }, 'oversized');
    assertDecodeError(
      JSON.stringify({
        schemaVersion: CACHE_SCHEMA_VERSION,
        writtenAtMs: 1,
        softExpiresAtMs: 2,
        hardExpiresAtMs: 3,
        value: { data: 'x'.repeat(MAX_ENTRY_BYTES + 1) },
      }),
      'oversized',
    );
  });

  test('encode checks envelope bytes after adding version/time fields, not only the value', () => {
    const value = { data: 'x'.repeat(150) };
    assert.ok(Buffer.byteLength(JSON.stringify(value), 'utf8') < 200);
    const result = encodeCacheEnvelope(value, times, { maxEntryBytes: 200 });
    assert.equal(result.kind, 'rejected');
    if (result.kind === 'rejected') assert.equal(result.reason, 'oversized');
  });

  test('encode rejects invalid times and non-object values without throwing', () => {
    // Invalid time fields.
    assert.equal(encode({ id: 'c' }, { writtenAtMs: -1 }).kind, 'rejected');
    assert.equal(encode({ id: 'c' }, { softExpiresAtMs: 500, hardExpiresAtMs: 400 }).kind, 'rejected');
    assert.equal(encode({ id: 'c' }, { writtenAtMs: 1.5 }).kind, 'rejected');
    // Non-object values.
    assertEncodeRejected(null, 'invalid_value');
    assertEncodeRejected([1, 2], 'invalid_value');
    assertEncodeRejected('text', 'invalid_value');
    assertEncodeRejected(42, 'invalid_value');
    assertEncodeRejected(undefined, 'invalid_value');
  });

  test('public value codec rejects private/auth fields at encode and decode', () => {
    const forbiddenFields = [
      'principalId', 'ownerSubjectId', 'ownerId', 'creatorSubjectId', 'creatorId', 'creatorPrincipalId',
      'email', 'emails', 'emailAddress',
      'membership', 'membershipRole', 'memberIds', 'memberSubjectIds',
      'visibilityRevision', 'policyRevision', 'policy', 'policyFacts', 'permissions', 'acl',
      'password', 'passwordHash', 'sessionToken', 'authorization', 'cookie', 'apiKey',
    ];
    for (const field of forbiddenFields) {
      assertEncodeRejected({ id: 'c-1', [field]: 'secret' }, 'forbidden_field');
      assertDecodeError(
        JSON.stringify({
          schemaVersion: CACHE_SCHEMA_VERSION,
          writtenAtMs: 1,
          softExpiresAtMs: 2,
          hardExpiresAtMs: 3,
          value: { id: 'c-1', [field]: 'secret' },
        }),
        'forbidden_field',
      );
    }
    // Nested leaks are rejected too, not just top-level keys.
    assertEncodeRejected({ id: 'c-1', nested: { email: 'user@example.test' } }, 'forbidden_field');
    assertDecodeError(
      JSON.stringify({
        schemaVersion: CACHE_SCHEMA_VERSION,
        writtenAtMs: 1,
        softExpiresAtMs: 2,
        hardExpiresAtMs: 3,
        value: { nested: { ownerSubjectId: 's-1' } },
      }),
      'forbidden_field',
    );
  });

  test('public-facing fields that are not private facts remain cacheable', () => {
    const value = {
      id: 'collection-1',
      title: 'Engineering Notes',
      visibility: 'public',
      owner: { profileId: 'profile-1', handle: 'known', displayName: 'Known' },
    };
    const encoded = encode(value);
    assert.equal(encoded.kind, 'ok');
    if (encoded.kind === 'ok') {
      const decoded = decode(encoded.encoded);
      assert.equal(decoded.kind, 'ok');
      if (decoded.kind === 'ok') assert.deepEqual(decoded.envelope.value, value);
    }
  });

  test('schema version constant matches the documented v1 contract', () => {
    assert.equal(CACHE_SCHEMA_VERSION, 1);
    assert.equal(CACHE_ERROR_CATEGORY.DECODE_ERROR, 'cache_decode_error');
    assert.equal(CACHE_ERROR_CATEGORY.UNAVAILABLE, 'cache_unavailable');
  });
});
