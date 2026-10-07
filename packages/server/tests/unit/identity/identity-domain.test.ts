import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'vitest';
import {
  ABOUT_MAX,
  IdentityError,
  assertAccountCanIssueSession,
  assertSafeRelativeReturnTo,
  assertSessionUsable,
  assertValidAbout,
  assertValidAvatarUrl,
  assertValidDisplayName,
  assertValidEmail,
  assertValidHandle,
  computeSessionExpiryWindow,
  deriveCsrfTokenRaw,
  hashSecret,
  isSafeRelativeReturnTo,
  resolveTrustedOidcClaims,
  secretsMatch,
  shouldRotateSession,
  shouldTouchSession,
  type Account,
  type Session,
} from '../../../src/modules/identity/index.js';

function account(overrides: Partial<Account> = {}): Account {
  return {
    id: 'account-1',
    subjectId: 'subject-1',
    status: 'active',
    email: 'user@example.test',
    securityEpoch: 1n,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    deletedAt: null,
    ...overrides,
  };
}

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-1',
    accountId: 'account-1',
    tokenHash: 'token-hash',
    csrfTokenHash: 'csrf-hash',
    securityEpoch: 1n,
    idleExpiresAt: new Date('2026-01-02T00:00:00.000Z'),
    absoluteExpiresAt: new Date('2026-01-31T00:00:00.000Z'),
    lastSeenAt: new Date('2026-01-01T00:00:00.000Z'),
    rotatedFromSessionId: null,
    revokedAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function expectIdentityCode(run: () => unknown, code: string): void {
  try {
    run();
    assert.fail(`expected IdentityError with code ${code}`);
  } catch (error: unknown) {
    assert.ok(error instanceof IdentityError, `expected IdentityError, got ${String(error)}`);
    assert.equal(error.code, code);
  }
}

describe('identity domain: session usability', () => {
  const now = new Date('2026-01-01T12:00:00.000Z');

  test('accepts an active session within idle and absolute windows', () => {
    assert.doesNotThrow(() => assertSessionUsable(session(), account(), now));
  });

  test('rejects idle expiry', () => {
    expectIdentityCode(
      () => assertSessionUsable(
        session({ idleExpiresAt: new Date('2026-01-01T11:00:00.000Z') }),
        account(),
        now,
      ),
      'session_expired',
    );
  });

  test('rejects absolute expiry', () => {
    expectIdentityCode(
      () => assertSessionUsable(
        session({ absoluteExpiresAt: new Date('2026-01-01T11:00:00.000Z') }),
        account(),
        now,
      ),
      'session_expired',
    );
  });

  test('rejects revoked sessions', () => {
    expectIdentityCode(
      () => assertSessionUsable(session({ revokedAt: now }), account(), now),
      'session_revoked',
    );
  });

  test('rejects security epoch mismatch', () => {
    expectIdentityCode(
      () => assertSessionUsable(session({ securityEpoch: 1n }), account({ securityEpoch: 2n }), now),
      'session_security_epoch_mismatch',
    );
  });

  test('rejects disabled accounts from issuing sessions', () => {
    expectIdentityCode(
      () => assertAccountCanIssueSession(account({ status: 'disabled' })),
      'account_disabled',
    );
  });
});

describe('identity domain: returnTo and handles', () => {
  test('accepts same-origin relative paths and rejects open redirects', () => {
    assert.equal(assertSafeRelativeReturnTo('/dashboard'), '/dashboard');
    assert.equal(assertSafeRelativeReturnTo('/a/../b?x=1#h'), '/b?x=1#h');
    assert.equal(isSafeRelativeReturnTo('//evil.example'), false);
    assert.equal(isSafeRelativeReturnTo('/.//evil.example'), false);
    assert.equal(isSafeRelativeReturnTo('/%2e//evil.example'), false);
    assert.throws(() => assertSafeRelativeReturnTo('https://evil.example'));
    assert.throws(() => assertSafeRelativeReturnTo('//evil.example'));
    assert.throws(() => assertSafeRelativeReturnTo('/.//evil.example'));
  });

  test('validates profile handles', () => {
    assert.equal(assertValidHandle('alice'), 'alice');
    assert.throws(() => assertValidHandle('bad handle'));
    assert.throws(() => assertValidHandle('.'));
    assert.throws(() => assertValidHandle('..'));
  });
});

describe('identity domain: secrets', () => {
  test('hashes secrets without retaining raw values and compares constantly', () => {
    const raw = 'super-secret-token-value';
    const hashed = hashSecret(raw);
    assert.notEqual(hashed, raw);
    assert.ok(secretsMatch(raw, hashed));
    assert.equal(secretsMatch('other', hashed), false);
  });

  test('deriveCsrfTokenRaw is deterministic and session-bound', () => {
    const token = 'session-cookie-secret-value';
    const a = deriveCsrfTokenRaw(token);
    const b = deriveCsrfTokenRaw(token);
    assert.equal(a, b);
    assert.notEqual(a, token);
    assert.notEqual(deriveCsrfTokenRaw(`${token}-other`), a);
    assert.ok(secretsMatch(a, hashSecret(a)));
  });
});

describe('identity domain: rotation and touch thresholds', () => {
  const base = session();
  const created = base.createdAt;

  test('shouldRotateSession is false below min age and true at/above', () => {
    assert.equal(
      shouldRotateSession(base, new Date(created.getTime() + 15 * 60 * 1000 - 1), 15 * 60 * 1000),
      false,
    );
    assert.equal(
      shouldRotateSession(base, new Date(created.getTime() + 15 * 60 * 1000), 15 * 60 * 1000),
      true,
    );
  });

  test('shouldTouchSession is false below min interval and true at/above', () => {
    const lastSeen = base.lastSeenAt;
    assert.equal(
      shouldTouchSession(base, new Date(lastSeen.getTime() + 60_000 - 1), 60_000),
      false,
    );
    assert.equal(
      shouldTouchSession(base, new Date(lastSeen.getTime() + 60_000), 60_000),
      true,
    );
  });

  test('rejects negative rotation and touch thresholds', () => {
    expectIdentityCode(
      () => shouldRotateSession(base, created, -1),
      'invalid_identity_input',
    );
    expectIdentityCode(
      () => shouldTouchSession(base, base.lastSeenAt, -1),
      'invalid_identity_input',
    );
  });
});

describe('identity domain: session TTL boundaries', () => {
  const frozenNow = new Date('2026-01-01T12:00:00.000Z');

  test('rejects zero, negative, and idle-above-absolute TTL combinations', () => {
    for (const options of [
      { idleTtlMs: 0 },
      { absoluteTtlMs: 0 },
      { idleTtlMs: -1 },
      { absoluteTtlMs: -1 },
      { idleTtlMs: 60_001, absoluteTtlMs: 60_000 },
    ]) {
      expectIdentityCode(
        () => computeSessionExpiryWindow(frozenNow, options),
        'invalid_identity_input',
      );
    }
  });

  test('accepts minimum positive TTLs and default constants at exact boundaries', () => {
    const min = computeSessionExpiryWindow(frozenNow, { idleTtlMs: 1, absoluteTtlMs: 1 });
    assert.equal(min.idleExpiresAt.getTime(), frozenNow.getTime() + 1);
    assert.equal(min.absoluteExpiresAt.getTime(), frozenNow.getTime() + 1);

    const defaults = computeSessionExpiryWindow(frozenNow);
    assert.equal(defaults.idleExpiresAt.getTime() - frozenNow.getTime(), 24 * 60 * 60 * 1000);
    assert.equal(defaults.absoluteExpiresAt.getTime() - frozenNow.getTime(), 30 * 24 * 60 * 60 * 1000);
  });
});

describe('identity domain: profile claim validation boundaries', () => {
  test('validates displayName, about, and email length boundaries with stable codes', () => {
    assert.equal(assertValidDisplayName('a'), 'a');
    assert.equal(assertValidDisplayName('x'.repeat(120)), 'x'.repeat(120));
    expectIdentityCode(
      () => assertValidDisplayName('x'.repeat(121)),
      'invalid_display_name',
    );
    expectIdentityCode(
      () => assertValidDisplayName('', { allowEmpty: false }),
      'invalid_display_name',
    );

    assert.equal(assertValidAbout(''), '');
    assert.equal(assertValidAbout('hello world'), 'hello world');
    assert.equal(assertValidAbout('x'.repeat(ABOUT_MAX)), 'x'.repeat(ABOUT_MAX));
    expectIdentityCode(
      () => assertValidAbout('x'.repeat(ABOUT_MAX + 1)),
      'invalid_about',
    );
    expectIdentityCode(
      () => assertValidAbout('   '),
      'invalid_about',
    );
    expectIdentityCode(
      () => assertValidAbout(' \t\n'),
      'invalid_about',
    );

    const local = 'user';
    const domain = `${'a'.repeat(310)}.test`;
    const boundaryEmail = `${local}@${domain}`.slice(0, 320);
    assert.equal(boundaryEmail.length, 320);
    assert.equal(assertValidEmail(boundaryEmail), boundaryEmail);
    expectIdentityCode(() => assertValidEmail(''), 'invalid_email');
    expectIdentityCode(() => assertValidEmail(`${boundaryEmail}x`), 'invalid_email');
  });

  test('profiles_about_length CHECK is pinned to ABOUT_MAX', () => {
    const source = readFileSync(
      new URL('../../../migrations/202609060100_identity_profile_about.ts', import.meta.url),
      'utf8',
    );
    assert.match(source, new RegExp(`CHECK \\(length\\(about\\) <= ${ABOUT_MAX}\\)`));
  });

  test('rejects empty and overlong avatar URLs', () => {
    assert.equal(assertValidAvatarUrl(null), null);
    assert.equal(assertValidAvatarUrl('https://cdn.example/a.png'), 'https://cdn.example/a.png');
    assert.equal(assertValidAvatarUrl('https://cdn.example/' + 'a'.repeat(2028)), 'https://cdn.example/' + 'a'.repeat(2028));
    expectIdentityCode(() => assertValidAvatarUrl(''), 'invalid_identity_input');
    expectIdentityCode(
      () => assertValidAvatarUrl('https://cdn.example/' + 'a'.repeat(2049)),
      'invalid_identity_input',
    );
  });

  test('invalid or empty provider pictures are discarded to null instead of failing login', () => {
    // FIX-M-003: an untrusted provider picture never blocks login; the claim
    // is discarded to null (strict URL validation lives in assertValidAvatarUrl).
    assert.equal(resolveTrustedOidcClaims({ avatarUrl: '' }).trustedAvatarUrl, null);
    assert.equal(
      resolveTrustedOidcClaims({ avatarUrl: 'https://cdn.example/' + 'a'.repeat(2049) }).trustedAvatarUrl,
      null,
    );
    assert.equal(
      resolveTrustedOidcClaims({ avatarUrl: 'javascript:alert(1)' }).trustedAvatarUrl,
      null,
    );
  });
});

describe('identity domain: OIDC trusted claims policy', () => {
  test('only trusts email when email_verified is true', () => {
    assert.equal(
      resolveTrustedOidcClaims({ email: 'a@example.test' }).emailTrusted,
      false,
    );
    assert.equal(
      resolveTrustedOidcClaims({ email: 'a@example.test', emailVerified: false }).emailTrusted,
      false,
    );
    assert.equal(
      resolveTrustedOidcClaims({ email: 'a@example.test', emailVerified: true }).trustedEmail,
      'a@example.test',
    );
    assert.equal(
      resolveTrustedOidcClaims({ email: 'a@example.test', emailVerified: true }).emailTrusted,
      true,
    );
  });

  test('treats empty displayName as absent for overwrite policy', () => {
    const claims = resolveTrustedOidcClaims({ displayName: '' });
    assert.equal(claims.trustedDisplayName, null);
  });

  test('distinguishes absent avatar claim from explicit null', () => {
    assert.equal(resolveTrustedOidcClaims({}).trustedAvatarUrl, undefined);
    assert.equal(resolveTrustedOidcClaims({ avatarUrl: null }).trustedAvatarUrl, null);
    assert.equal(
      resolveTrustedOidcClaims({ avatarUrl: 'https://cdn.example/a.png' }).trustedAvatarUrl,
      'https://cdn.example/a.png',
    );
  });

  test('requireVerifiedEmail policy rejects unverified claims', () => {
    try {
      resolveTrustedOidcClaims({
        email: 'a@example.test',
        emailVerified: false,
        emailTrustPolicy: { requireVerifiedEmail: true },
      });
      assert.fail('expected email_unverified');
    } catch (error: unknown) {
      assert.ok(error instanceof IdentityError);
      assert.equal(error.code, 'email_unverified');
    }
  });
});
