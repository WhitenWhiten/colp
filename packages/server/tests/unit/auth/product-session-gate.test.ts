/**
 * A1-1 / A1-5 / A1-2 post-response seam unit tests.
 *
 * 假阴性防护:
 * - the gated set is asserted EXACTLY, so adding a mounted identity-mutating
 *   Better Auth endpoint without gating it fails this test (A1-1);
 * - the authorize carrier rule distinguishes a live BA session (product check
 *   runs) from a cookie that no longer resolves (BA owns the login redirect),
 *   which is the A1-5 regression;
 * - a re-dispatched authorize keeps the fresh session already established on
 *   the endpoint context instead of re-reading (and clearing) the cookie;
 * - the email-change seam is invoked with the SAME session that Better Auth
 *   re-issued, and a revoke failure stays post-commit guarded.
 *
 * 假阳性防护:
 * - public/read-only endpoints are asserted NOT to gate, so a blanket
 *   "gate every path" change would fail;
 * - the seam is not called before a committed change (no newSession) or
 *   without a callback.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  PRODUCT_SESSION_AUTHENTICATED_PATHS,
  completeEmailChangeSessionRevocation,
  liveAuthSessionIdOf,
  requiresProductSessionCheck,
  resolveProductSessionCarrier,
  type ProductSessionCarrier,
} from '../../../src/infrastructure/auth/product-session-gate.js';

type ProductSessionGateContext = Parameters<typeof resolveProductSessionCarrier>[0];

function gateContext(session: ProductSessionCarrier): ProductSessionGateContext {
  return { context: { session }, headers: new Headers() } as unknown as ProductSessionGateContext;
}

describe('product-session gate path set (A1-1)', () => {
  test('every mounted identity-mutating / code-minting Better Auth endpoint is gated', () => {
    assert.deepEqual([...PRODUCT_SESSION_AUTHENTICATED_PATHS].sort(), [
      '/change-password',
      '/email-otp/change-email',
      '/email-otp/request-email-change',
      '/oauth2/authorize',
      '/oauth2/consent',
    ]);
  });

  test('public and read-only Better Auth endpoints never run the gate', () => {
    for (const path of [
      '/sign-up/email',
      '/sign-in/email',
      '/sign-in/social',
      '/sign-in/oauth2',
      '/callback/:providerId',
      '/oauth2/callback/:providerId',
      '/get-session',
      '/sign-out',
      '/revoke-session',
      '/reset-password',
      '/request-password-reset',
      '/verify-email',
      '/send-verification-email',
      '/email-otp/send-verification-otp',
      '/sign-in/email-otp',
      '/email-otp/check-verification-otp',
      '/email-otp/verify-email',
      '/email-otp/request-password-reset',
      '/email-otp/reset-password',
      '/forget-password/email-otp',
      '/oauth2/token',
      '/oauth2/userinfo',
      '/jwks',
      '/oauth2/public-client',
      '/oauth2/consent-transaction',
      '/oauth2/register',
    ]) {
      assert.equal(requiresProductSessionCheck(path, 'session-1'), false, path);
      assert.equal(requiresProductSessionCheck(path, null), false, path);
    }
  });
});

describe('product-session gate carrier rules (A1-5)', () => {
  test('authorize with no live Better Auth carrier falls through to the login redirect', () => {
    // A stale-but-present cookie resolves to no BA session: Better Auth must
    // handle the request so it can redirect to /login instead of a JSON 401.
    assert.equal(requiresProductSessionCheck('/oauth2/authorize', null), false);
  });

  test('authorize with a live carrier still runs the product metadata/epoch check', () => {
    assert.equal(requiresProductSessionCheck('/oauth2/authorize', 'session-1'), true);
  });

  test('other gated endpoints fail closed when the carrier does not resolve', () => {
    for (const path of [
      '/oauth2/consent',
      '/change-password',
      '/email-otp/request-email-change',
      '/email-otp/change-email',
    ]) {
      assert.equal(requiresProductSessionCheck(path, null), true, path);
    }
  });

  test('path matching is exact and never prefix-based', () => {
    assert.equal(requiresProductSessionCheck('/oauth2/authorize/extra', 'session-1'), false);
    assert.equal(requiresProductSessionCheck('/oauth2/consent/extra', 'session-1'), false);
    assert.equal(requiresProductSessionCheck('/change-password/../change-password', 'session-1'), false);
    assert.equal(requiresProductSessionCheck(undefined, 'session-1'), false);
  });

  test('a re-dispatched authorize keeps and gates the fresh context session', async () => {
    // OAuth Provider 1.7.1 resumes a paused authorize by re-dispatching
    // `/oauth2/authorize` with the signed-in session on the context before its
    // cookie is presented. Re-reading the cookie here used to clear that
    // session, skip the gate, and bounce the browser back to /login.
    const fresh = { session: { id: 'fresh-session' }, user: { id: 'auth-user-1' } };
    const ctx = gateContext(fresh as unknown as ProductSessionCarrier);
    const carrier = await resolveProductSessionCarrier(ctx);
    assert.equal(carrier, fresh);
    assert.equal(ctx.context.session, fresh, 'the fresh context session must survive the gate');
    assert.equal(liveAuthSessionIdOf(carrier), 'fresh-session');
    assert.equal(requiresProductSessionCheck('/oauth2/authorize', liveAuthSessionIdOf(carrier)), true);
  });

  test('the live carrier id is null unless the context session has a usable id', () => {
    assert.equal(liveAuthSessionIdOf(null), null);
    assert.equal(liveAuthSessionIdOf({ session: { id: '' }, user: {} } as unknown as ProductSessionCarrier), null);
    assert.equal(liveAuthSessionIdOf({ session: {}, user: {} } as unknown as ProductSessionCarrier), null);
  });
});

describe('email-change post-response seam (A1-2)', () => {
  test('targets the other-session revoke at the session that changed its email', async () => {
    const calls: Array<{ readonly authUserId: string; readonly currentAuthSessionId: string }> = [];
    await completeEmailChangeSessionRevocation({
      newSession: { user: { id: 'auth-user-1' }, session: { id: 'auth-session-1' } },
      onEmailChanged: async (event) => {
        calls.push(event);
      },
    });
    assert.deepEqual(calls, [{ authUserId: 'auth-user-1', currentAuthSessionId: 'auth-session-1' }]);
  });

  test('does nothing before a committed change (no newSession) or without a callback', async () => {
    let calls = 0;
    const onEmailChanged = async (): Promise<void> => {
      calls += 1;
    };
    await completeEmailChangeSessionRevocation({ newSession: null, onEmailChanged });
    await completeEmailChangeSessionRevocation({ newSession: undefined, onEmailChanged });
    await completeEmailChangeSessionRevocation({
      newSession: { user: { id: 'auth-user-1' }, session: null },
      onEmailChanged,
    });
    await completeEmailChangeSessionRevocation({
      newSession: { session: { id: 'auth-session-1' } },
      onEmailChanged,
    });
    await completeEmailChangeSessionRevocation({
      newSession: { user: { id: 'auth-user-1' }, session: { id: 'auth-session-1' } },
    });
    assert.equal(calls, 0);
  });

  test('a revoke failure is guarded after the committed email change', async () => {
    const warnings: Array<{ readonly bindings: object; readonly message: string }> = [];
    await completeEmailChangeSessionRevocation({
      newSession: { user: { id: 'auth-user-1' }, session: { id: 'auth-session-1' } },
      onEmailChanged: async () => {
        throw new Error('revoke unavailable');
      },
      logger: {
        warn(bindings, message) {
          warnings.push({ bindings, message });
        },
      },
    });
    assert.equal(warnings.length, 1);
    assert.equal(
      (warnings[0]!.bindings as { readonly classification?: string }).classification,
      'email_change_session_revoke_failed',
    );
  });
});
