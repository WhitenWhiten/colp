/**
 * P4A-RL02 HMAC key codec contract (plan §2.3 key contract + §4.1.11 key
 * isolation + §8 RL02 anti-false-positive rule "raw principal in the key is
 * not enough").
 *
 * The key format is fixed:
 *
 *   known:<env>:ratelimit:v1:{att:<subjectHmac>}:<routeClass>:<window>
 *
 * where `subjectHmac` is the base64url-truncated HMAC-SHA-256 over
 * `principalId + NUL + tenant/collection scope` with the configured key
 * secret. NO raw principal, Collection, email, session, IP, filename, blob,
 * generation or URL may ever enter the key text — the codec has no path that
 * interpolates them, and the normalizer (`parseAttachmentRateLimitKey`)
 * rejects any key whose subject segment is not exactly the truncated
 * base64url HMAC shape. Building a key by pasting a raw principal into the
 * subject segment MUST fail.
 *
 * No Redis, no PostgreSQL, no browser.
 */
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'vitest';
import {
  RATE_LIMIT_KEY_MAX_LENGTH,
  RATE_LIMIT_KEY_SCHEMA_VERSION,
  RATE_LIMIT_SUBJECT_FIELD_MAX_LENGTH,
  RATE_LIMIT_SUBJECT_HMAC_TRUNCATED_CHARS,
  RateLimitKeyError,
  assertRateLimitSubject,
  buildAttachmentRateLimitKey,
  parseAttachmentRateLimitKey,
  rateLimitSubjectHmac,
  type RateLimitKeyBuildInput,
  type RateLimitSubjectInput,
} from '../../../src/modules/attachments/index.js';

const KEY_SECRET = Buffer.from('rl02-contract-hmac-key-secret-0123456789', 'utf8');

function buildInput(overrides: Partial<RateLimitKeyBuildInput> = {}): RateLimitKeyBuildInput {
  return {
    keyPrefix: 'known',
    environment: 'test',
    keySecret: KEY_SECRET,
    routeClass: 'issue',
    subject: { principalId: 'principal-1', scope: 'collection-1' },
    windowStartEpochMs: 1_750_000_000_000,
    ...overrides,
  };
}

function expectKeyError(fn: () => string, reason: string): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof RateLimitKeyError, `expected RateLimitKeyError, got ${String(error)}`);
    assert.equal(error.reason, reason);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Canonical key shape and round-trip
// ---------------------------------------------------------------------------

test('the canonical key follows known:<env>:ratelimit:v1:{att:<hmac>}:<route>:<window>', () => {
  const key = buildAttachmentRateLimitKey(buildInput());
  assert.match(key, /^known:test:ratelimit:v1:\{att:[A-Za-z0-9_-]{32}\}:issue:1750000000000$/u);
  const parsed = parseAttachmentRateLimitKey(key);
  assert.equal(parsed.kind, 'ok');
  if (parsed.kind !== 'ok') return;
  assert.equal(parsed.parts.keyPrefix, 'known');
  assert.equal(parsed.parts.environment, 'test');
  assert.equal(parsed.parts.schemaVersion, 1);
  assert.equal(parsed.parts.routeClass, 'issue');
  assert.equal(parsed.parts.windowStartEpochMs, 1_750_000_000_000);
  assert.match(parsed.parts.subjectHmac, /^[A-Za-z0-9_-]{32}$/u);
});

test('the schema version is fixed at v1', () => {
  assert.equal(RATE_LIMIT_KEY_SCHEMA_VERSION, 1);
  const key = buildAttachmentRateLimitKey(buildInput());
  assert.ok(key.includes(':ratelimit:v1:'));
  assert.equal(parseAttachmentRateLimitKey(key.replace(':ratelimit:v1:', ':ratelimit:v2:')).kind, 'rejected');
});

test('parse rejects non-canonical keys (normalization is fail-closed)', () => {
  const canonical = buildAttachmentRateLimitKey(buildInput());
  assert.equal(parseAttachmentRateLimitKey(canonical).kind, 'ok');
  // Leading-zero window is not canonical.
  assert.equal(parseAttachmentRateLimitKey(canonical.replace(':1750000000000', ':01750000000000')).kind, 'rejected');
  // Trailing garbage, empty segments, missing hash tag braces.
  assert.equal(parseAttachmentRateLimitKey(`${canonical}:extra`).kind, 'rejected');
  assert.equal(parseAttachmentRateLimitKey(canonical.replace('{att:', '{att')).kind, 'rejected');
  assert.equal(parseAttachmentRateLimitKey('').kind, 'rejected');
  assert.equal(parseAttachmentRateLimitKey('known:test:ratelimit:v1:issue:1750000000000').kind, 'rejected');
  // Window that is not a safe integer cannot parse.
  assert.equal(parseAttachmentRateLimitKey(canonical.replace(':1750000000000', ':9999999999999999')).kind, 'rejected');
});

// ---------------------------------------------------------------------------
// HMAC isolation and NUL-separated subject semantics
// ---------------------------------------------------------------------------

test('the same principal under a different secret yields a different key', () => {
  const first = buildAttachmentRateLimitKey(buildInput());
  const second = buildAttachmentRateLimitKey(buildInput({ keySecret: Buffer.from('a-different-secret-0123456789', 'utf8') }));
  assert.notEqual(first, second);
  const firstHmac = rateLimitSubjectHmac(KEY_SECRET, { principalId: 'principal-1', scope: 'collection-1' });
  const secondHmac = rateLimitSubjectHmac(Buffer.from('a-different-secret-0123456789', 'utf8'), { principalId: 'principal-1', scope: 'collection-1' });
  assert.notEqual(firstHmac, secondHmac);
});

test('the HMAC input is principalId + NUL + scope (no concatenation ambiguity)', () => {
  const a = rateLimitSubjectHmac(KEY_SECRET, { principalId: 'a', scope: 'bc' });
  const b = rateLimitSubjectHmac(KEY_SECRET, { principalId: 'ab', scope: 'c' });
  const c = rateLimitSubjectHmac(KEY_SECRET, { principalId: 'a', scope: 'b' });
  assert.notEqual(a, b, 'NUL separation must make a|bc distinct from ab|c');
  assert.notEqual(a, c);
  assert.equal(
    rateLimitSubjectHmac(KEY_SECRET, { principalId: 'a', scope: 'b' }),
    rateLimitSubjectHmac(KEY_SECRET, { principalId: 'a', scope: 'b' }),
  );
  // The digest is computed over the exact NUL-joined UTF-8 string.
  const expected = createHmac('sha256', KEY_SECRET).update('a\u0000b', 'utf8').digest('base64url');
  assert.equal(c, expected.slice(0, RATE_LIMIT_SUBJECT_HMAC_TRUNCATED_CHARS));
});

test('the subject HMAC is a base64url-truncated SHA-256 digest', () => {
  const hmac = rateLimitSubjectHmac(KEY_SECRET, { principalId: 'principal-1', scope: 'collection-1' });
  assert.equal(hmac.length, RATE_LIMIT_SUBJECT_HMAC_TRUNCATED_CHARS);
  assert.equal(RATE_LIMIT_SUBJECT_HMAC_TRUNCATED_CHARS, 32);
  assert.match(hmac, /^[A-Za-z0-9_-]{32}$/u);
  const full = createHmac('sha256', KEY_SECRET)
    .update('principal-1\u0000collection-1', 'utf8')
    .digest('base64url');
  assert.equal(hmac, full.slice(0, 32));
});

// ---------------------------------------------------------------------------
// Key dimension variation
// ---------------------------------------------------------------------------

test('environment, prefix, route class and window each change the key', () => {
  const base = buildAttachmentRateLimitKey(buildInput());
  assert.notEqual(buildAttachmentRateLimitKey(buildInput({ environment: 'prod' })), base);
  assert.notEqual(buildAttachmentRateLimitKey(buildInput({ keyPrefix: 'known2' })), base);
  assert.notEqual(buildAttachmentRateLimitKey(buildInput({ routeClass: 'complete' })), base);
  assert.notEqual(buildAttachmentRateLimitKey(buildInput({ routeClass: 'download' })), base);
  assert.notEqual(buildAttachmentRateLimitKey(buildInput({ windowStartEpochMs: 1_750_000_060_000 })), base);
  const parsed = parseAttachmentRateLimitKey(buildAttachmentRateLimitKey(buildInput({ environment: 'prod', routeClass: 'download' })));
  assert.equal(parsed.kind, 'ok');
  if (parsed.kind !== 'ok') return;
  assert.equal(parsed.parts.environment, 'prod');
  assert.equal(parsed.parts.routeClass, 'download');
});

// ---------------------------------------------------------------------------
// No raw identity or secret ever enters the key text
// ---------------------------------------------------------------------------

test('raw principal, scope, email, session, IP, filename, blob, generation and URL never enter the key', () => {
  const rawValues = [
    'principal-1',
    'user+rl02@example.com',
    'session-token-abc123',
    '203.0.113.9',
    'report-final-v3.pdf',
    'blob-7f8a...',
    'generation-0001',
    'https://example.com/private/url',
    KEY_SECRET.toString('utf8'),
  ];
  const subject: RateLimitSubjectInput = {
    principalId: 'principal-1',
    scope: 'user+rl02@example.com/session-token-abc123/203.0.113.9/report-final-v3.pdf/blob-7f8a.../generation-0001',
  };
  const key = buildAttachmentRateLimitKey(buildInput({ subject }));
  const parsed = parseAttachmentRateLimitKey(key);
  assert.equal(parsed.kind, 'ok');
  for (const raw of rawValues) {
    assert.ok(!key.includes(raw), `the raw value ${raw} leaked into the key: ${key}`);
  }
  // The HMAC segment itself is the only subject-derived text in the key.
  const expectedHmac = rateLimitSubjectHmac(KEY_SECRET, subject);
  assert.ok(key.includes(`{att:${expectedHmac}}`));
});

test('a raw principal pasted into the key fails normalization (anti-false-positive §4.1.11)', () => {
  // What a naive implementation would emit: the raw principal in the subject slot.
  const naiveKeys = [
    'known:test:ratelimit:v1:{att:principal-1}:issue:1750000000000',
    'known:test:ratelimit:v1:{att:user+rl02@example.com}:issue:1750000000000',
    'known:test:ratelimit:v1:principal-1:issue:1750000000000',
    'known:test:ratelimit:v1:{att:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA}:issue:0:principal-1',
  ];
  for (const key of naiveKeys) {
    const parsed = parseAttachmentRateLimitKey(key);
    assert.equal(parsed.kind, 'rejected', `raw-principal key must be rejected: ${key}`);
  }
});

test('the codec itself has no path that interpolates the raw principal into the key', () => {
  const key = buildAttachmentRateLimitKey(buildInput({ subject: { principalId: 'principal-raw-1', scope: 'collection-raw-1' } }));
  assert.ok(!key.includes('principal-raw-1'));
  assert.ok(!key.includes('collection-raw-1'));
  const parsed = parseAttachmentRateLimitKey(key);
  assert.equal(parsed.kind, 'ok');
  if (parsed.kind !== 'ok') return;
  assert.notEqual(parsed.parts.subjectHmac, 'principal-raw-1');
  assert.match(parsed.parts.subjectHmac, /^[A-Za-z0-9_-]{32}$/u);
});

// ---------------------------------------------------------------------------
// Fail-closed input validation
// ---------------------------------------------------------------------------

test('empty or overlong subjects are rejected before hashing', () => {
  expectKeyError(() => buildAttachmentRateLimitKey(buildInput({ subject: { principalId: '', scope: 'c-1' } })), 'malformed');
  expectKeyError(() => buildAttachmentRateLimitKey(buildInput({ subject: { principalId: 'p-1', scope: '' } })), 'malformed');
  expectKeyError(() => buildAttachmentRateLimitKey(buildInput({
    subject: { principalId: 'x'.repeat(RATE_LIMIT_SUBJECT_FIELD_MAX_LENGTH + 1), scope: 'c-1' },
  })), 'malformed');
  assert.throws(() => assertRateLimitSubject({ principalId: '', scope: 'c-1' }), RateLimitKeyError);
});

test('control characters (including NUL) are rejected in subject fields', () => {
  expectKeyError(() => buildAttachmentRateLimitKey(buildInput({
    subject: { principalId: 'p-1\u0000injected', scope: 'c-1' },
  })), 'malformed');
  expectKeyError(() => buildAttachmentRateLimitKey(buildInput({
    subject: { principalId: 'p-1', scope: 'c-1\nc-2' },
  })), 'malformed');
  expectKeyError(() => buildAttachmentRateLimitKey(buildInput({
    subject: { principalId: 'p-1\u2028', scope: 'c-1' },
  })), 'malformed');
});

test('the subject field ceiling is the unified issue collectionId contract (256, boundary-pinned)', () => {
  assert.equal(RATE_LIMIT_SUBJECT_FIELD_MAX_LENGTH, 256);
  // Exactly the ceiling is accepted for both subject fields...
  const atCeiling = buildAttachmentRateLimitKey(buildInput({
    subject: {
      principalId: 'p'.repeat(RATE_LIMIT_SUBJECT_FIELD_MAX_LENGTH),
      scope: 'c'.repeat(RATE_LIMIT_SUBJECT_FIELD_MAX_LENGTH),
    },
  }));
  assert.equal(parseAttachmentRateLimitKey(atCeiling).kind, 'ok');
  // ...one char over the ceiling is rejected before hashing: the 257/512
  // collectionId shapes the transport maps to a stable 422 pre-admission
  // (KA-P4-AM-02 unified collectionId schema + codec input ceiling).
  expectKeyError(() => buildAttachmentRateLimitKey(buildInput({
    subject: { principalId: 'p-1', scope: 'c'.repeat(RATE_LIMIT_SUBJECT_FIELD_MAX_LENGTH + 1) },
  })), 'malformed');
  expectKeyError(() => buildAttachmentRateLimitKey(buildInput({
    subject: { principalId: 'p-1', scope: 'c'.repeat(512) },
  })), 'malformed');
});

test('invalid key context fails closed with stable reasons', () => {
  expectKeyError(() => buildAttachmentRateLimitKey(buildInput({ keyPrefix: '-known' })), 'invalid_prefix');
  expectKeyError(() => buildAttachmentRateLimitKey(buildInput({ keyPrefix: 'known!' })), 'invalid_prefix');
  expectKeyError(() => buildAttachmentRateLimitKey(buildInput({ environment: '' })), 'invalid_environment');
  expectKeyError(() => buildAttachmentRateLimitKey(buildInput({ environment: 'prod:evil' })), 'invalid_environment');
  expectKeyError(() => buildAttachmentRateLimitKey(buildInput({ routeClass: 'admin' as never })), 'invalid_route_class');
  expectKeyError(() => buildAttachmentRateLimitKey(buildInput({ windowStartEpochMs: -1 })), 'invalid_window');
  expectKeyError(() => buildAttachmentRateLimitKey(buildInput({ windowStartEpochMs: 1.5 })), 'invalid_window');
  expectKeyError(() => buildAttachmentRateLimitKey(buildInput({ windowStartEpochMs: Number.NaN })), 'invalid_window');
});

test('the key length is bounded by a compile-time ceiling', () => {
  assert.equal(RATE_LIMIT_KEY_MAX_LENGTH, 512);
  const key = buildAttachmentRateLimitKey(buildInput());
  assert.ok(key.length < RATE_LIMIT_KEY_MAX_LENGTH);
  // The longest legal prefix+environment still fits below the ceiling.
  const longKey = buildAttachmentRateLimitKey(buildInput({
    keyPrefix: 'k'.repeat(64),
    environment: 'e'.repeat(64),
  }));
  assert.ok(longKey.length <= RATE_LIMIT_KEY_MAX_LENGTH);
});

test('parse round-trips every canonical key the builder can emit', () => {
  const cases: RateLimitKeyBuildInput[] = [
    buildInput(),
    buildInput({ keyPrefix: 'known2', environment: 'prod', routeClass: 'complete', windowStartEpochMs: 0 }),
    buildInput({ keyPrefix: 'k'.repeat(64), environment: 'e'.repeat(64), routeClass: 'download' }),
  ];
  for (const input of cases) {
    const key = buildAttachmentRateLimitKey(input);
    const parsed = parseAttachmentRateLimitKey(key);
    assert.equal(parsed.kind, 'ok');
    if (parsed.kind !== 'ok') return;
    assert.equal(parsed.parts.keyPrefix, input.keyPrefix ?? 'known');
    assert.equal(parsed.parts.environment, input.environment);
    assert.equal(parsed.parts.routeClass, input.routeClass);
    assert.equal(parsed.parts.windowStartEpochMs, input.windowStartEpochMs);
  }
});
