/**
 * P4A-I11 pure delivery-policy + capability-verifier unit suite.
 *
 * Pins the credential-free isolated-origin contract WITHOUT any I/O:
 *  - filename encoding for `Content-Disposition: attachment`
 *    (ASCII/CJK/RTL/CRLF/LF/quote/backslash injection; byte-bounded to
 *    255 UTF-8 bytes with extension-preserving, code-point-safe truncation
 *    and a final header hard cap; never a key/path/header interpolation;
 *    never a raw header injection);
 *  - restricted single-range parsing (0/end/out-of-range/multi-range ->
 *    416 or 206 semantics) and Content-Range formatting;
 *  - the hard response byte budget and read ceilings;
 *  - the GET/HEAD method allowlist and the fixed security-header set;
 *  - If-None-Match (weak comparison, `*` wildcard) -> 304 semantics;
 *  - the stable upstream-failure -> HTTP status mapping;
 *  - the I10 production capability verifier path: valid/invalid signature/
 *    duplicate (replay within TTL is valid)/wrong-audience/expired/
 *    not-yet-valid/tampered/wrong-method/wrong-kind/malformed;
 *  - the fixed request-log shape never carries tokens/keys/URLs.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  DELIVERY_ALLOWED_METHODS,
  DELIVERY_CACHE_CONTROL,
  DELIVERY_CONTENT_DISPOSITION_HARD_CAP,
  DELIVERY_CONTENT_TYPE,
  DELIVERY_DEFAULT_FILENAME,
  DELIVERY_FILENAME_MAX_UTF8_BYTES,
  DELIVERY_RESPONSE_HARD_CEILING_BYTES,
  asciiFilenameFallback,
  boundDownloadFilename,
  createHmacOwnerDeliveryCapabilitySigner,
  deliveryMethodAllowed,
  deliveryRangeLength,
  deliveryReadByteCeiling,
  deliveryResponseByteCeiling,
  deliverySecurityHeaders,
  deliveryUpstreamStatus,
  evaluateIfNoneMatch,
  evaluateIfRange,
  formatContentDisposition,
  formatContentRange,
  formatUnsatisfiableContentRange,
  parseSingleByteRange,
  rfc5987Filename,
  sanitizeDownloadFilename,
  verifyOwnerDeliveryCapability,
  type DeliveryRequestLogEntry,
} from '../../../src/modules/attachments/index.js';

const SECRET = Buffer.from('i11-unit-delivery-capability-hmac-secret-0123456789abcdef', 'utf8');
const AUDIENCE = 'http://127.0.0.2:12345';
const NOW = new Date('2026-08-08T12:00:00.000Z');

function signedToken(options: {
  blobId?: string;
  generationId?: string;
  ownerSubject?: string;
  ttlSeconds?: number;
  now?: Date;
  audience?: string;
} = {}): string {
  const signer = createHmacOwnerDeliveryCapabilitySigner({ secret: SECRET, audienceOrigin: AUDIENCE });
  return signer.sign({
    blobId: options.blobId ?? 'blob-1',
    generationId: options.generationId ?? 'generation-1',
    ownerSubject: options.ownerSubject ?? 'subject:owner-1',
    ttlSeconds: options.ttlSeconds ?? 60,
    now: options.now ?? NOW,
  }).token;
}

describe('P4A-I11 filename policy (Content-Disposition)', () => {
  test('ASCII filenames produce a quoted fallback plus an RFC 5987 encoded form', () => {
    const value = formatContentDisposition('report.pdf');
    assert.ok(value.startsWith('attachment; filename="report.pdf"; filename*=UTF-8\'\'report.pdf'));
    assert.equal(asciiFilenameFallback('report.pdf'), 'report.pdf');
    assert.equal(rfc5987Filename('report.pdf'), 'report.pdf');
  });

  test('CJK filenames are preserved in filename* and removed from the ASCII fallback', () => {
    const name = '报告.pdf';
    const value = formatContentDisposition(name);
    assert.ok(value.startsWith('attachment; filename="'));
    assert.equal(asciiFilenameFallback(name), '.pdf', 'the ASCII fallback keeps only printable ASCII');
    assert.equal(asciiFilenameFallback('报告'), 'download', 'a pure-CJK name falls back to the default');
    assert.equal(rfc5987Filename(name), '%E6%8A%A5%E5%91%8A.pdf');
    assert.ok(value.includes('filename*=UTF-8\'\'%E6%8A%A5%E5%91%8A.pdf'));
  });

  test('RTL script filenames are percent-encoded, never raw', () => {
    const name = 'דוח.pdf';
    const value = formatContentDisposition(name);
    assert.ok(value.includes('filename*=UTF-8\'\''));
    assert.ok(!/[\u0590-\u05FF]/u.test(value), 'RTL script bytes must be percent-encoded in the header');
  });

  test('CRLF / LF / control characters are stripped and can never inject headers', () => {
    const name = 'safe\r\nSet-Cookie: evil=1\nname.txt';
    const sanitized = sanitizeDownloadFilename(name);
    assert.ok(!sanitized.includes('\r') && !sanitized.includes('\n'));
    const value = formatContentDisposition(name);
    // The sanitizer strips control characters; the remaining literal text is
    // confined to the quoted/encoded header value and can never terminate the
    // header line, so a CRLF header injection is impossible.
    assert.ok(!value.includes('\r') && !value.includes('\n'), 'the header value must never contain CR/LF — header injection is impossible');
    assert.ok(value.includes('attachment; filename="'), 'the injection text is confined inside the quoted/encoded value');
    assert.ok(!value.includes('\nSet-Cookie') && !value.includes('\rSet-Cookie'), 'the CRLF-injected header text cannot become a new header line');
    for (const control of ['\u0000', '\u0007', '\u001F', '\u200E', '\u202E']) {
      assert.ok(!formatContentDisposition(`a${control}b`).includes(control), 'control characters are stripped');
    }
  });

  test('quote and backslash injection is neutralized in both header forms', () => {
    const name = 'a"b\\c';
    const value = formatContentDisposition(name);
    assert.ok(value.includes('filename="a\\"b\\\\c"'), 'quotes/backslashes are escaped in the quoted fallback');
    assert.ok(value.includes("filename*=UTF-8''a%22b%5Cc"), 'quotes/backslashes are percent-encoded in filename*');
  });

  test('empty or whitespace-only suggestions fall back to the default name', () => {
    assert.equal(sanitizeDownloadFilename(''), DELIVERY_DEFAULT_FILENAME);
    assert.equal(sanitizeDownloadFilename('   '), DELIVERY_DEFAULT_FILENAME);
    assert.equal(sanitizeDownloadFilename(undefined), DELIVERY_DEFAULT_FILENAME);
    assert.equal(formatContentDisposition('\r\n'), `attachment; filename="${DELIVERY_DEFAULT_FILENAME}"; filename*=UTF-8''${DELIVERY_DEFAULT_FILENAME}`);
  });

  test('the sanitized name stays confined to the Content-Disposition value (never a key/path)', () => {
    const name = '../../../etc/passwd%00.html';
    const sanitized = sanitizeDownloadFilename(name);
    assert.ok(!/[\u0000-\u001F\u007F]/u.test(sanitized), 'control characters (incl. NUL) never survive sanitization');
    const value = formatContentDisposition(name);
    assert.ok(value.startsWith('attachment; filename="'), 'the name stays inside the Content-Disposition header value');
    assert.ok(!value.includes('\r') && !value.includes('\n'), 'single-line header value, no injection');
    assert.ok(!/[\u0000-\u001F\u007F]/u.test(value), 'no raw control characters in the emitted header');
    assert.ok(value.includes('filename*=UTF-8\'\''), 'an RFC 5987 encoded form is always emitted');
  });
});

describe('P4A-I11 filename byte budget (Content-Disposition)', () => {
  const encoder = new TextEncoder();

  test('the byte budget is 255 UTF-8 bytes; legal and boundary-length names are unchanged', () => {
    assert.equal(DELIVERY_FILENAME_MAX_UTF8_BYTES, 255);
    assert.equal(boundDownloadFilename('report.pdf'), 'report.pdf', 'a legal short name passes through unchanged');
    const atLimit = 'a'.repeat(DELIVERY_FILENAME_MAX_UTF8_BYTES);
    assert.equal(boundDownloadFilename(atLimit), atLimit, 'a name exactly at the budget is unchanged');
    assert.equal(boundDownloadFilename('a'.repeat(256)), atLimit, 'one byte over truncates to the budget');
    assert.equal(formatContentDisposition('report.pdf'), 'attachment; filename="report.pdf"; filename*=UTF-8\'\'report.pdf');
  });

  test('over-limit ASCII names are truncated to the byte budget with the extension kept', () => {
    const name = `${'a'.repeat(300)}.pdf`;
    const bounded = boundDownloadFilename(name);
    assert.ok(bounded.endsWith('.pdf'), 'the safe extension survives truncation');
    assert.equal(encoder.encode(bounded).byteLength, DELIVERY_FILENAME_MAX_UTF8_BYTES);
    const value = formatContentDisposition(name);
    assert.equal(value, `attachment; filename="${bounded}"; filename*=UTF-8''${bounded}`);
    assert.ok(value.length <= DELIVERY_CONTENT_DISPOSITION_HARD_CAP);
  });

  test('over-limit multi-byte names truncate at code point boundaries and keep the extension', () => {
    const name = `${'报告'.repeat(200)}.pdf`;
    const bounded = boundDownloadFilename(name);
    assert.ok(bounded.startsWith('报告'), 'the CJK prefix survives');
    assert.ok(bounded.endsWith('.pdf'), 'the safe extension survives');
    const bytes = encoder.encode(bounded).byteLength;
    assert.ok(bytes <= DELIVERY_FILENAME_MAX_UTF8_BYTES, `must fit the byte budget (got ${bytes})`);
    assert.ok(bytes > 200, 'truncation keeps as much of the name as fits');
    const stem = bounded.slice(0, -'.pdf'.length);
    assert.equal(
      new TextDecoder('utf-8', { fatal: true }).decode(encoder.encode(stem)),
      stem,
      'truncation never splits a code point',
    );
    const value = formatContentDisposition(name);
    const match = /filename\*=UTF-8''([^;]*)/u.exec(value);
    assert.ok(match, 'the RFC 5987 form is present');
    assert.equal(decodeURIComponent(match![1]!), bounded, 'the header carries exactly the bounded name');
    assert.ok(value.length <= DELIVERY_CONTENT_DISPOSITION_HARD_CAP);
    assert.ok(!value.includes('\r') && !value.includes('\n'));
  });

  test('truncation prefers a safe ASCII extension and honors tiny budgets', () => {
    assert.equal(boundDownloadFilename('abcdefgh.pdf', 8), 'abcd.pdf', 'stem truncation keeps the extension');
    assert.equal(boundDownloadFilename('€€€.pdf', 7), '€.pdf', 'a multi-byte stem truncates at a code point boundary');
    assert.equal(boundDownloadFilename('é', 2), 'é', 'a two-byte name exactly at a tiny budget is unchanged');
    assert.equal(boundDownloadFilename('é', 1), DELIVERY_DEFAULT_FILENAME, 'nothing fits -> default name');
    assert.equal(boundDownloadFilename('abc', 0), DELIVERY_DEFAULT_FILENAME, 'a zero budget never emits a name');
    assert.equal(boundDownloadFilename('abcdef.pdf', 4), 'abcd', 'when the extension cannot be kept, the whole name is bounded');
  });

  test('control-only suggestions fall back to the default name', () => {
    const value = formatContentDisposition('\u0001\u0007\u001F'.repeat(300));
    assert.equal(
      value,
      `attachment; filename="${DELIVERY_DEFAULT_FILENAME}"; filename*=UTF-8''${DELIVERY_DEFAULT_FILENAME}`,
    );
  });

  test('escape-heavy names never push the final header over the hard cap', () => {
    const value = formatContentDisposition('\\'.repeat(2000));
    assert.ok(
      value.length <= DELIVERY_CONTENT_DISPOSITION_HARD_CAP,
      `header must stay under the hard cap (got ${value.length})`,
    );
    assert.ok(!value.includes('\r') && !value.includes('\n'), 'escaped names can never inject CRLF');
  });
});

describe('P4A-I11 restricted single-range parsing', () => {
  const SIZE = 10;

  test('no Range header means the full 200 representation', () => {
    assert.deepEqual(parseSingleByteRange(undefined, SIZE), { kind: 'none' });
    assert.deepEqual(parseSingleByteRange(null, SIZE), { kind: 'none' });
    assert.deepEqual(parseSingleByteRange('', SIZE), { kind: 'none' });
  });

  test('bytes=0-3 is a single satisfiable range', () => {
    assert.deepEqual(parseSingleByteRange('bytes=0-3', SIZE), { kind: 'single', start: 0, end: 3 });
  });

  test('open-ended and over-long ends clamp to the last byte', () => {
    assert.deepEqual(parseSingleByteRange('bytes=2-', SIZE), { kind: 'single', start: 2, end: 9 });
    assert.deepEqual(parseSingleByteRange('bytes=2-999', SIZE), { kind: 'single', start: 2, end: 9 });
  });

  test('suffix ranges resolve to the last K bytes and clamp when over-long', () => {
    assert.deepEqual(parseSingleByteRange('bytes=-3', SIZE), { kind: 'single', start: 7, end: 9 });
    assert.deepEqual(parseSingleByteRange('bytes=-999', SIZE), { kind: 'single', start: 0, end: 9 });
  });

  test('out-of-range, empty, and zero-length suffix are unsatisfiable (416)', () => {
    assert.deepEqual(parseSingleByteRange('bytes=10-', SIZE), { kind: 'unsatisfiable' });
    assert.deepEqual(parseSingleByteRange('bytes=5-3', SIZE), { kind: 'unsatisfiable' });
    assert.deepEqual(parseSingleByteRange('bytes=-0', SIZE), { kind: 'unsatisfiable' });
    assert.deepEqual(parseSingleByteRange('bytes=-', SIZE), { kind: 'unsatisfiable' });
  });

  test('multi-range and malformed/other-unit headers are unsatisfiable (restricted single-range)', () => {
    assert.deepEqual(parseSingleByteRange('bytes=0-1,3-4', SIZE), { kind: 'unsatisfiable' });
    assert.deepEqual(parseSingleByteRange('items=0-1', SIZE), { kind: 'unsatisfiable' });
    assert.deepEqual(parseSingleByteRange('bytes=abc', SIZE), { kind: 'unsatisfiable' });
    assert.deepEqual(parseSingleByteRange('bytes=0-', 0), { kind: 'unsatisfiable' });
  });

  test('range length and Content-Range formatting are exact', () => {
    assert.equal(deliveryRangeLength({ start: 0, end: 3 }), 4);
    assert.equal(formatContentRange({ start: 0, end: 3 }, SIZE), 'bytes 0-3/10');
    assert.equal(formatUnsatisfiableContentRange(SIZE), 'bytes */10');
  });
});

describe('P4A-I11 response budget, method allowlist, security headers, If-None-Match, If-Range', () => {
  test('the hard response ceiling is the compile-time single-PUT ceiling', () => {
    assert.equal(DELIVERY_RESPONSE_HARD_CEILING_BYTES, 64 * 1024 * 1024);
    assert.equal(deliveryResponseByteCeiling(5 * 1024 * 1024), 5 * 1024 * 1024);
    assert.equal(deliveryResponseByteCeiling(64 * 1024 * 1024), DELIVERY_RESPONSE_HARD_CEILING_BYTES);
    assert.equal(deliveryResponseByteCeiling(128 * 1024 * 1024), DELIVERY_RESPONSE_HARD_CEILING_BYTES);
  });

  test('read ceilings bound the full object and the requested range', () => {
    const ceiling = 100;
    assert.equal(deliveryReadByteCeiling(ceiling, 50, { kind: 'none' }), 50);
    assert.equal(deliveryReadByteCeiling(ceiling, 500, { kind: 'none' }), 100);
    assert.equal(deliveryReadByteCeiling(ceiling, 500, { kind: 'single', start: 0, end: 9 }), 10);
    assert.equal(deliveryReadByteCeiling(ceiling, 500, { kind: 'single', start: 0, end: 999 }), 100);
  });

  test('the method allowlist is exactly GET and HEAD', () => {
    assert.deepEqual([...DELIVERY_ALLOWED_METHODS], ['GET', 'HEAD']);
    assert.equal(deliveryMethodAllowed('GET'), true);
    assert.equal(deliveryMethodAllowed('HEAD'), true);
    assert.equal(deliveryMethodAllowed('POST'), false);
    assert.equal(deliveryMethodAllowed('PUT'), false);
    assert.equal(deliveryMethodAllowed('OPTIONS'), false);
    assert.equal(deliveryMethodAllowed(undefined), false);
  });

  test('the fixed security-header set is complete and private,no-store', () => {
    const headers = deliverySecurityHeaders();
    assert.equal(headers['x-content-type-options'], 'nosniff');
    assert.equal(headers['cache-control'], DELIVERY_CACHE_CONTROL);
    assert.equal(DELIVERY_CACHE_CONTROL, 'private,no-store');
    assert.equal(DELIVERY_CONTENT_TYPE, 'application/octet-stream');
    assert.ok(headers['content-security-policy']!.includes("default-src 'none'"));
    assert.ok(headers['content-security-policy']!.includes("frame-ancestors 'none'"));
    assert.equal(headers['x-frame-options'], 'DENY');
    assert.equal(headers['referrer-policy'], 'no-referrer');
    assert.equal(headers['cross-origin-resource-policy'], 'same-origin');
    assert.equal(headers['cross-origin-opener-policy'], 'same-origin');
    assert.ok(headers['permissions-policy']!.includes('camera=()'));
    assert.equal(Object.keys(headers).length, 8);
  });

  test('If-None-Match matches exactly, weakly, via wildcard, and across a list', () => {
    const etag = '"abc123"';
    assert.equal(evaluateIfNoneMatch(undefined, etag), false);
    assert.equal(evaluateIfNoneMatch(null, etag), false);
    assert.equal(evaluateIfNoneMatch('"abc123"', etag), true);
    assert.equal(evaluateIfNoneMatch('W/"abc123"', etag), true);
    assert.equal(evaluateIfNoneMatch('*', etag), true);
    assert.equal(evaluateIfNoneMatch('"other", "abc123"', etag), true);
    assert.equal(evaluateIfNoneMatch('"other"', etag), false);
    assert.equal(evaluateIfNoneMatch('W/"other"', etag), false);
  });

  test('If-Range honors ONLY a strong entity-tag exactly matching the current ETag (FIX-L-047)', () => {
    const etag = '"abc123"';
    // Absent header: no precondition, Range may be applied as usual.
    assert.equal(evaluateIfRange(undefined, etag), false);
    assert.equal(evaluateIfRange(null, etag), false);
    assert.equal(evaluateIfRange('', etag), false);
    assert.equal(evaluateIfRange('   ', etag), false);
    // Exact strong entity-tag match is the ONLY accepting case.
    assert.equal(evaluateIfRange('"abc123"', etag), true);
    assert.equal(evaluateIfRange('  "abc123"  ', etag), true, 'surrounding whitespace is tolerated');
    // Stale ETag (the audit scenario): must NOT match, so Range is ignored.
    assert.equal(evaluateIfRange('"other"', etag), false);
    // Weak entity-tags are invalid for If-Range (RFC 9110): never match.
    assert.equal(evaluateIfRange('W/"abc123"', etag), false);
    // The If-None-Match wildcard is not a valid If-Range validator.
    assert.equal(evaluateIfRange('*', etag), false);
    // HTTP-date form (not supported): explicitly ignored, never matches.
    assert.equal(evaluateIfRange('Wed, 21 Oct 2015 07:28:00 GMT', etag), false);
    // Malformed values never match.
    assert.equal(evaluateIfRange('abc123', etag), false);
    assert.equal(evaluateIfRange('"abc123" "other"', etag), false);
  });

  test('upstream failure classes map to stable zero-body statuses', () => {
    assert.equal(deliveryUpstreamStatus({ class: 'not_found' }), 404);
    assert.equal(deliveryUpstreamStatus({ class: 'etag_mismatch' }), 404);
    assert.equal(deliveryUpstreamStatus({ class: 'denied' }), 404);
    assert.equal(deliveryUpstreamStatus({ class: 'overflow' }), 403);
    assert.equal(deliveryUpstreamStatus({ class: 'retryable' }), 503);
    assert.equal(deliveryUpstreamStatus({ class: 'unknown' }), 503);
    assert.equal(deliveryUpstreamStatus({ class: 'contract_drift' }), 503);
  });
});

describe('P4A-I11 capability verification path (I10 production verifier)', () => {
  test('a valid capability verifies with the exact claims', () => {
    const verification = verifyOwnerDeliveryCapability({
      token: signedToken(),
      secret: SECRET,
      expectedAudience: AUDIENCE,
      now: NOW,
    });
    assert.equal(verification.outcome, 'valid');
    if (verification.outcome === 'valid') {
      assert.equal(verification.claims.blobId, 'blob-1');
      assert.equal(verification.claims.generationId, 'generation-1');
      assert.equal(verification.claims.audience, AUDIENCE);
      assert.equal(verification.claims.method, 'GET');
    }
  });

  test('duplicate credential (replay) within the TTL is valid — the exposure window IS the TTL', () => {
    const token = signedToken();
    for (let i = 0; i < 2; i += 1) {
      const verification = verifyOwnerDeliveryCapability({ token, secret: SECRET, expectedAudience: AUDIENCE, now: NOW });
      assert.equal(verification.outcome, 'valid');
    }
  });

  test('tampered payload, bad signature, and wrong secret are invalid', () => {
    const token = signedToken();
    const [version, payload, signature] = token.split('.') as [string, string, string];
    const tampered = `${version}.${payload!.slice(0, -2)}AA.${signature}`;
    assert.equal(verifyOwnerDeliveryCapability({
      token: tampered, secret: SECRET, expectedAudience: AUDIENCE, now: NOW,
    }).outcome, 'invalid');
    assert.equal(verifyOwnerDeliveryCapability({
      token, secret: Buffer.from('wrong-secret-wrong-secret-wrong-secret'), expectedAudience: AUDIENCE, now: NOW,
    }).outcome, 'invalid');
  });

  test('wrong audience, expired, not-yet-valid, wrong method, wrong kind, malformed are invalid', () => {
    assert.equal(verifyOwnerDeliveryCapability({
      token: signedToken(), secret: SECRET, expectedAudience: 'http://evil.example', now: NOW,
    }).outcome, 'invalid');

    const signer = createHmacOwnerDeliveryCapabilitySigner({ secret: SECRET, audienceOrigin: AUDIENCE });
    const expired = signer.sign({
      blobId: 'blob-1', generationId: 'generation-1', ownerSubject: 'subject:owner-1',
      ttlSeconds: 60, now: new Date(NOW.getTime() - 61_000),
    }).token;
    assert.equal(verifyOwnerDeliveryCapability({
      token: expired, secret: SECRET, expectedAudience: AUDIENCE, now: NOW,
    }).outcome, 'invalid');

    const notYet = signer.sign({
      blobId: 'blob-1', generationId: 'generation-1', ownerSubject: 'subject:owner-1',
      ttlSeconds: 60, now: new Date(NOW.getTime() + 1_000),
    }).token;
    assert.equal(verifyOwnerDeliveryCapability({
      token: notYet, secret: SECRET, expectedAudience: AUDIENCE, now: new Date(NOW.getTime() - 2_000),
    }).outcome, 'invalid');

    assert.equal(verifyOwnerDeliveryCapability({
      token: 'v1.garbage', secret: SECRET, expectedAudience: AUDIENCE, now: NOW,
    }).outcome, 'invalid');
    assert.equal(verifyOwnerDeliveryCapability({
      token: 'v2.abc.def', secret: SECRET, expectedAudience: AUDIENCE, now: NOW,
    }).outcome, 'invalid');
  });

  test('a forged method/kind surfaces as invalid, never valid', () => {
    const signer = createHmacOwnerDeliveryCapabilitySigner({ secret: SECRET, audienceOrigin: AUDIENCE });
    const { token } = signer.sign({
      blobId: 'blob-1', generationId: 'generation-1', ownerSubject: 'subject:owner-1',
      ttlSeconds: 60, now: NOW,
    });
    const [version, payload, signature] = token.split('.') as [string, string, string];
    const forged = JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8')) as Record<string, unknown>;
    forged.method = 'PUT';
    const forgedToken = `${version}.${Buffer.from(JSON.stringify(forged), 'utf8').toString('base64url')}.${signature}`;
    const verification = verifyOwnerDeliveryCapability({
      token: forgedToken, secret: SECRET, expectedAudience: AUDIENCE, now: NOW,
    });
    assert.equal(verification.outcome, 'invalid');
    assert.notEqual(verification.reason, 'valid');
  });
});

describe('P4A-I11 request log is non-sensitive', () => {
  test('the fixed log shape never carries tokens, keys, or URLs', () => {
    const token = signedToken();
    const entry: DeliveryRequestLogEntry = {
      status: 200, byteCount: 12, receivedCookies: true, receivedAuthorization: false,
      receivedReferer: false, setCookies: false, range: 'bytes=0-3',
    };
    const serialized = JSON.stringify(entry);
    assert.ok(!serialized.includes(token), 'the capability token must never be logged');
    assert.ok(!serialized.includes('attachments/live/'), 'the R2 key must never be logged');
    assert.ok(!serialized.includes('http://'), 'URLs must never be logged');
    assert.ok(!serialized.includes('blob-1') && !serialized.includes('generation-1'));
  });
});
