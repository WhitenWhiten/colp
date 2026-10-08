/**
 * Task E2 unit contract: the unified Better Auth error contract (plan §7 A4
 * step 5; G1 §10 / §12.3) pinned directly on the transport translation table.
 *
 * 假阴性防护:
 * - EVERY frozen BA 1.7.1 code is exercised through the REAL
 *   `translateBetterAuthError` with a POISONED body (BA message + email +
 *   OTP + raw token) and the assertion is on the serialized wire envelope:
 *   stable `error.code`, the FIXED product message, the canonical status and
 *   zero secret material anywhere in the body;
 * - the R9 stripping contract is asserted on arbitrarily nested JSON
 *   (arrays + objects), not only on the flat sign-in shape;
 * - `processBetterAuthResponse` is exercised with real Fastify request ids
 *   and a poisoned BA body, proving the onSend pipeline itself never echoes
 *   secrets and never double-translates an existing product envelope.
 *
 * 假阳性防护:
 * - "passes through" cases are asserted on the exact payload identity
 *   (non-JSON bytes, null bodies, 2xx JSON) — a rewrite would fail them;
 * - unknown BA codes and code-less 4xx bodies must fail CLOSED to the stable
 *   invalid_request envelope (a pass-through of the BA message would be a
 *   false positive for "handled").
 */
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { productErrorStatus } from '../../../src/transport/product-codes.js';
import {
  ProductHttpError,
  productErrorEnvelope,
  translateBetterAuthError,
} from '../../../src/transport/product-error.js';
import {
  processBetterAuthResponse,
  stripBetterAuthRawTokens,
} from '../../../src/transport/auth/better-auth-routes.js';

const REQUEST_ID = '11111111-2222-4333-8444-555555555555';

/** Poisoned BA error body: the BA message plus every secret category. */
function poisonedBody(code: string, message = 'the real BA message with sensitive detail'): unknown {
  return {
    code,
    message,
    email: 'victim@example.test',
    otp: '123456',
    token: 'raw-bearer-token-value',
  };
}

/** Frozen BA 1.7.1 codes -> expected product translation (G1 §10 mapping). */
const FROZEN_TRANSLATIONS: Readonly<Record<string, { readonly code: string; readonly status: number; readonly message: string; readonly recovery: 'user_action' | 'none' | 'same_request' }>> = Object.freeze({
  PASSWORD_TOO_SHORT: { code: 'invalid_request', status: productErrorStatus('invalid_request'),
    message: 'The password is too short.', recovery: 'user_action' },
  PASSWORD_TOO_LONG: { code: 'invalid_request', status: productErrorStatus('invalid_request'),
    message: 'The password is too long.', recovery: 'user_action' },
  INVALID_PASSWORD: { code: 'invalid_credentials', status: productErrorStatus('invalid_credentials'),
    message: 'The email or password is incorrect.', recovery: 'user_action' },
  SESSION_EXPIRED: { code: 'authentication_required', status: productErrorStatus('authentication_required'),
    message: 'Authentication is required.', recovery: 'user_action' },
  SESSION_NOT_FRESH: { code: 'authentication_required', status: productErrorStatus('authentication_required'),
    message: 'Please sign in again to complete this action.', recovery: 'user_action' },
  INVALID_EMAIL_OR_PASSWORD: {
    code: 'invalid_credentials',
    status: productErrorStatus('invalid_credentials'),
    message: 'The email or password is incorrect.',
    recovery: 'user_action',
  },
  USER_ALREADY_EXISTS: {
    code: 'invalid_credentials',
    status: productErrorStatus('invalid_credentials'),
    message: 'The email or password is incorrect.',
    recovery: 'user_action',
  },
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: {
    code: 'invalid_credentials',
    status: productErrorStatus('invalid_credentials'),
    message: 'The email or password is incorrect.',
    recovery: 'user_action',
  },
  EMAIL_NOT_VERIFIED: {
    code: 'verification_required',
    status: productErrorStatus('verification_required'),
    message: 'Email verification is required to complete this action.',
    recovery: 'user_action',
  },
  UNAUTHORIZED: {
    code: 'authentication_required',
    status: productErrorStatus('authentication_required'),
    message: 'Authentication is required.',
    recovery: 'user_action',
  },
  SESSION_REQUIRED: {
    code: 'authentication_required',
    status: productErrorStatus('authentication_required'),
    message: 'Authentication is required.',
    recovery: 'user_action',
  },
  INVALID_ORIGIN: {
    code: 'csrf_failed',
    status: productErrorStatus('csrf_failed'),
    message: 'The request failed CSRF or Origin validation.',
    recovery: 'user_action',
  },
  MISSING_OR_NULL_ORIGIN: {
    code: 'csrf_failed',
    status: productErrorStatus('csrf_failed'),
    message: 'The request failed CSRF or Origin validation.',
    recovery: 'user_action',
  },
  CROSS_SITE_NAVIGATION_LOGIN_BLOCKED: {
    code: 'csrf_failed',
    status: productErrorStatus('csrf_failed'),
    message: 'The request failed CSRF or Origin validation.',
    recovery: 'user_action',
  },
  SOCIAL_ACCOUNT_ALREADY_LINKED: {
    code: 'account_link_required',
    status: productErrorStatus('account_link_required'),
    message: 'This account must be linked explicitly before it can be used.',
    recovery: 'user_action',
  },
  LINKED_ACCOUNT_ALREADY_EXISTS: {
    code: 'account_link_required',
    status: productErrorStatus('account_link_required'),
    message: 'This account must be linked explicitly before it can be used.',
    recovery: 'user_action',
  },
  VERIFICATION_EMAIL_NOT_ENABLED: {
    code: 'email_delivery_unavailable',
    status: productErrorStatus('email_delivery_unavailable'),
    message: 'Email delivery is temporarily unavailable. Please try again later.',
    recovery: 'none',
  },
  RESET_PASSWORD_DISABLED: {
    code: 'email_delivery_unavailable',
    status: productErrorStatus('email_delivery_unavailable'),
    message: 'Email delivery is temporarily unavailable. Please try again later.',
    recovery: 'none',
  },
  TOO_MANY_REQUESTS: {
    code: 'rate_limited',
    status: productErrorStatus('rate_limited'),
    message: 'Too many requests. Please try again later.',
    recovery: 'same_request',
  },
  INVALID_OTP: {
    code: 'invalid_request',
    status: productErrorStatus('invalid_request'),
    message: 'That code did not work. Try again.',
    recovery: 'user_action',
  },
  OTP_EXPIRED: {
    code: 'invalid_request',
    status: productErrorStatus('invalid_request'),
    message: 'That code has expired. Request a new one.',
    recovery: 'user_action',
  },
  TOO_MANY_ATTEMPTS: {
    code: 'rate_limited',
    status: productErrorStatus('rate_limited'),
    message: 'Too many requests. Please try again later.',
    recovery: 'same_request',
  },
});

describe('E2 auth error contract: frozen Better Auth translation table', () => {
  test('every frozen BA code maps to the stable code, the fixed message and the canonical status', () => {
    for (const [baCode, expected] of Object.entries(FROZEN_TRANSLATIONS)) {
      const status = expected.code === 'rate_limited' ? 429 : 400;
      const translated = translateBetterAuthError(status, poisonedBody(baCode));
      assert.ok(translated, `${baCode} must be translated`);
      assert.equal(translated.productCode, expected.code, `${baCode} -> product code`);
      assert.equal(translated.statusCode, expected.status, `${baCode} -> canonical status`);
      assert.equal(translated.message, expected.message, `${baCode} -> FIXED message (BA message never echoed)`);
      assert.equal(translated.recovery, expected.recovery, `${baCode} -> recovery class`);
    }
  });

  test('the serialized wire envelope never contains the BA message, email, OTP or raw token', () => {
    for (const [baCode] of Object.entries(FROZEN_TRANSLATIONS)) {
      const status = baCode === 'TOO_MANY_REQUESTS' ? 429 : 400;
      const translated = translateBetterAuthError(status, poisonedBody(baCode));
      assert.ok(translated);
      const wire = JSON.stringify(productErrorEnvelope(REQUEST_ID, translated));
      for (const secret of ['victim@example.test', '123456', 'raw-bearer-token-value', 'sensitive detail', 'the real BA message']) {
        assert.equal(wire.includes(secret), false, `${baCode}: ${secret} must never reach the wire`);
      }
      const parsed = JSON.parse(wire) as { error: { code: string; message: string; requestId: string } };
      assert.equal(parsed.error.code, FROZEN_TRANSLATIONS[baCode]!.code);
      assert.equal(parsed.error.message, FROZEN_TRANSLATIONS[baCode]!.message);
      assert.equal(parsed.error.requestId, REQUEST_ID);
    }
  });

  test('unknown BA codes and code-less 4xx bodies fail closed to invalid_request', () => {
    const unknown = translateBetterAuthError(400, poisonedBody('SOME_FUTURE_CODE'));
    assert.ok(unknown);
    assert.equal(unknown.productCode, 'invalid_request');
    assert.equal(unknown.statusCode, productErrorStatus('invalid_request'));
    assert.equal(unknown.message, 'The request is invalid.');
    const wire = JSON.stringify(productErrorEnvelope(REQUEST_ID, unknown));
    assert.equal(wire.includes('SOME_FUTURE_CODE'), false, 'the unknown BA code must not leak');
    assert.equal(wire.includes('sensitive detail'), false);

    const codeless = translateBetterAuthError(400, { message: 'provider internal detail' });
    assert.ok(codeless);
    assert.equal(codeless.productCode, 'invalid_request');
    assert.equal(codeless.message, 'The request is invalid.');
  });

  test('a code-less 429 translates to rate_limited with the Retry-After header preserved', () => {
    const translated = translateBetterAuthError(429, { message: 'slow down' }, 37);
    assert.ok(translated);
    assert.equal(translated.productCode, 'rate_limited');
    assert.equal(translated.statusCode, 429);
    assert.equal(translated.retryAfterSeconds, 37);
    assert.equal(translated.sameRequestRetrySafe, true);
    assert.deepEqual(translated.headers, { 'Retry-After': '37' });
  });

  test('an already-product envelope is never double-translated', () => {
    const envelope = productErrorEnvelope(REQUEST_ID, new ProductHttpError({
      statusCode: 400,
      code: 'invalid_request',
      message: 'The request is invalid.',
    }));
    const translated = translateBetterAuthError(400, envelope);
    assert.equal(translated, null, 'a product envelope must pass through untouched');
  });

  test('2xx statuses are never error translations', () => {
    assert.equal(translateBetterAuthError(200, poisonedBody('INVALID_EMAIL_OR_PASSWORD')), null);
    assert.equal(translateBetterAuthError(302, { code: 'INVALID_ORIGIN' }), null);
  });

  test('BA status 403 + TOO_MANY_ATTEMPTS still yields canonical 429 rate_limited (BA status is not trusted)', () => {
    const translated = translateBetterAuthError(403, poisonedBody('TOO_MANY_ATTEMPTS', 'Too many attempts'), 19);
    assert.ok(translated);
    assert.equal(translated.productCode, 'rate_limited');
    assert.equal(translated.statusCode, 429);
    assert.equal(translated.recovery, 'same_request');
    assert.equal(translated.sameRequestRetrySafe, true);
    assert.equal(translated.retryAfterSeconds, 19);
    assert.deepEqual(translated.headers, { 'Retry-After': '19' });
    assert.equal(translated.message, 'Too many requests. Please try again later.');
    assert.equal(translated.message.includes('Too many attempts'), false);
    const wire = JSON.stringify(productErrorEnvelope(REQUEST_ID, translated));
    for (const secret of ['Too many attempts', 'victim@example.test', '123456', 'raw-bearer-token-value']) {
      assert.equal(wire.includes(secret), false, `${secret} must never reach the wire`);
    }
  });

  test('OTP BA phrases never appear on the wire', () => {
    const cases: ReadonlyArray<{ readonly baCode: string; readonly baStatus: number; readonly baMessage: string }> = [
      { baCode: 'INVALID_OTP', baStatus: 400, baMessage: 'Invalid OTP' },
      { baCode: 'OTP_EXPIRED', baStatus: 400, baMessage: 'OTP expired' },
      { baCode: 'TOO_MANY_ATTEMPTS', baStatus: 403, baMessage: 'Too many attempts' },
    ];
    for (const item of cases) {
      const translated = translateBetterAuthError(item.baStatus, poisonedBody(item.baCode, item.baMessage));
      assert.ok(translated);
      const wire = JSON.stringify(productErrorEnvelope(REQUEST_ID, translated));
      assert.equal(wire.includes(item.baMessage), false, `${item.baCode}: BA phrase must not leak`);
      assert.equal(wire.includes(item.baCode), false, `${item.baCode}: BA code must not leak`);
      assert.equal(translated.message, FROZEN_TRANSLATIONS[item.baCode]!.message);
    }
  });
});

describe('E2 auth error contract: R9 raw-token stripping and the onSend pipeline', () => {
  test('stripBetterAuthRawTokens removes every nested token field and keeps everything else', () => {
    const input = {
      token: 'top-level-token',
      user: {
        id: 'user-1',
        token: 'nested-token',
        email: 'user@example.test',
      },
      session: {
        token: 'session-token',
        expiresAt: '2026-01-01T00:00:00.000Z',
        attributes: [{ token: 'array-token', name: 'x' }, { name: 'y' }],
      },
      list: ['a', { token: 'deep-token' }],
    };
    const stripped = stripBetterAuthRawTokens(input) as Record<string, unknown>;
    assert.equal('token' in stripped, false);
    assert.equal((stripped.user as Record<string, unknown>).token, undefined);
    assert.equal((stripped.user as Record<string, unknown>).email, 'user@example.test');
    const session = stripped.session as { token?: unknown; expiresAt: string; attributes: Array<Record<string, unknown>> };
    assert.equal(session.token, undefined);
    assert.equal(session.expiresAt, '2026-01-01T00:00:00.000Z');
    assert.equal(session.attributes[0]?.token, undefined);
    assert.equal(session.attributes[0]?.name, 'x');
    const list = stripped.list as unknown[];
    assert.equal((list[1] as Record<string, unknown>).token, undefined);
    // Scalars and non-objects pass through.
    assert.equal(stripBetterAuthRawTokens('plain'), 'plain');
    assert.equal(stripBetterAuthRawTokens(42), 42);
    assert.equal(stripBetterAuthRawTokens(null), null);
    assert.deepEqual(stripBetterAuthRawTokens(['token', { token: 1 }]), ['token', {}]);
  });

  test('processBetterAuthResponse strips tokens from 2xx JSON and translates 4xx JSON', () => {
    const request = { id: REQUEST_ID } as never;
    const stripped = processBetterAuthResponse(request as never, { statusCode: 200 } as never, JSON.stringify({
      token: 'raw-token', user: { token: 'nested', email: 'user@example.test' },
    }));
    const parsed = JSON.parse(String(stripped)) as { token?: unknown; user: { token?: unknown; email: string } };
    assert.equal(parsed.token, undefined);
    assert.equal(parsed.user.token, undefined);
    assert.equal(parsed.user.email, 'user@example.test');

    const errorReply = { statusCode: 400, getHeader: () => undefined } as never;
    const translated = processBetterAuthResponse(request as never, errorReply, JSON.stringify(poisonedBody('INVALID_EMAIL_OR_PASSWORD')));
    const envelope = JSON.parse(String(translated)) as { error: { code: string; message: string } };
    assert.equal(envelope.error.code, 'invalid_credentials');
    assert.equal(envelope.error.message, 'The email or password is incorrect.');
    for (const secret of ['victim@example.test', '123456', 'raw-bearer-token-value', 'sensitive detail']) {
      assert.equal(String(translated).includes(secret), false, `${secret} must not reach the wire`);
    }
  });

  test('processBetterAuthResponse preserves non-JSON, null, and non-object payloads byte-identically', () => {
    const request = { id: REQUEST_ID } as never;
    const reply200 = { statusCode: 200 } as never;
    const reply400 = { statusCode: 400, getHeader: () => undefined } as never;
    assert.equal(processBetterAuthResponse(request as never, reply200, 'not-json-at-all'), 'not-json-at-all');
    assert.equal(processBetterAuthResponse(request as never, reply400, 'not-json-at-all'), 'not-json-at-all');
    assert.equal(processBetterAuthResponse(request as never, reply200, null), null);
    assert.equal(processBetterAuthResponse(request as never, reply200, undefined), undefined);
    const buffer = Buffer.from('plain-bytes');
    assert.equal(processBetterAuthResponse(request as never, reply200, buffer), buffer);
  });

  test('processBetterAuthResponse never rewrites an existing product envelope (no double translation)', () => {
    const request = { id: REQUEST_ID } as never;
    const reply = { statusCode: 400, getHeader: () => undefined } as never;
    const envelope = JSON.stringify(productErrorEnvelope(REQUEST_ID, new ProductHttpError({
      statusCode: 400,
      code: 'invalid_request',
      message: 'The request is invalid.',
    })));
    assert.equal(processBetterAuthResponse(request as never, reply, envelope), envelope);
  });

  test('a 429 with the x-retry-after header flows retryAfterSeconds into the envelope', () => {
    const request = { id: REQUEST_ID } as never;
    const reply = { statusCode: 429, getHeader: () => '12' } as never;
    const translated = processBetterAuthResponse(request as never, reply, JSON.stringify({ message: 'slow down' }));
    const envelope = JSON.parse(String(translated)) as { error: { code: string; retryAfterSeconds: number | null } };
    assert.equal(envelope.error.code, 'rate_limited');
    assert.equal(envelope.error.retryAfterSeconds, 12);
  });

  test('processBetterAuthResponse rewrites BA 403 TOO_MANY_ATTEMPTS onto 429 rate_limited', () => {
    const request = { id: REQUEST_ID } as never;
    const reply = { statusCode: 403, getHeader: () => undefined } as { statusCode: number; getHeader: () => undefined };
    const payload = processBetterAuthResponse(
      request as never,
      reply as never,
      JSON.stringify(poisonedBody('TOO_MANY_ATTEMPTS', 'Too many attempts')),
    );
    assert.equal(reply.statusCode, 429);
    const envelope = JSON.parse(String(payload)) as { error: { code: string; message: string } };
    assert.equal(envelope.error.code, 'rate_limited');
    assert.equal(envelope.error.message, 'Too many requests. Please try again later.');
    for (const secret of ['Too many attempts', 'TOO_MANY_ATTEMPTS', 'victim@example.test', '123456', 'raw-bearer-token-value']) {
      assert.equal(String(payload).includes(secret), false, `${secret} must not reach the wire`);
    }
  });
});
