/**
 * Task C3 unit tests: the explicit account-linking facade
 * (modules/auth/application/account-linking.ts) and the recovery facade
 * (modules/auth/application/account-recovery.ts).
 *
 * Contract under test (plan §9 Task C3 steps 4-6):
 * - explicit link requires a CURRENT SESSION (A3 authority port), a valid
 *   re-auth proof (password or verified-email OTP), and a callback URL that
 *   resolves inside the Know-N origin (allowlisted returnTo);
 * - a provider that is already linked is refused before any OAuth round trip;
 * - unlink requires the same session + re-auth and is REFUSED when it would
 *   remove the last recovery method (credential or provider account);
 * - recovery only accepts verified-email OTP / password-reset-token proofs;
 *   a provider email claim is never a recovery proof.
 *
 * 假阴性防护: the authority port is a real BrowserSessionAuthority-shaped
 * fake that throws the REAL BrowserSessionAuthenticationError (the transport
 * maps that exact class), and the server/reauth ports are recording fakes so
 * every test asserts the exact port calls that must (and must not) happen.
 *
 * 假阳性防护: no test accepts a bare return value — each success asserts the
 * server port received the NORMALIZED callback URL and the right provider/
 * account arguments, and each refusal asserts the mutation port was NOT
 * called (no link/unlink write can happen behind a failed guard).
 */
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  AccountLinkingError,
  AccountRecoveryError,
  BrowserSessionAuthenticationError,
  assertAcceptableRecoveryProof,
  createAccountLinkingService,
  createAccountRecoveryService,
  resolveAllowlistedCallbackUrl,
  type AccountLinkingPorts,
  type AccountLinkingService,
  type AccountRecoveryService,
  type AuthenticatedBrowserActor,
  type BrowserSessionAuthority,
  type OAuthLinkServerPort,
  type ReauthVerifier,
  type RecoveryServerPort,
} from '../../../src/modules/auth/index.js';
import { buildBetterAuthConfig } from '../../../src/modules/auth/better-auth-config.js';
import type { Account, Session } from '../../../src/modules/identity/index.js';
import { TEST_SESSION_TOKEN_PROTECTION } from '../../support/better-auth-session-token-protection.js';

const PRODUCT_ORIGIN = 'https://app.example.test';

function testAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: 'account-1',
    subjectId: 'subject-1',
    status: 'active',
    email: 'owner@example.test',
    securityEpoch: 0n,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    deletedAt: null,
    ...overrides,
  };
}

function testSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-1',
    accountId: 'account-1',
    idleExpiresAt: new Date('2026-01-02T00:00:00.000Z'),
    absoluteExpiresAt: new Date('2026-01-31T00:00:00.000Z'),
    csrfTokenHash: 'csrf-hash-1',
    tokenHash: 'token-hash-1',
    securityEpoch: 0n,
    rotatedFromSessionId: null,
    lastSeenAt: new Date('2026-01-01T00:00:00.000Z'),
    revokedAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function testActor(overrides: Partial<AuthenticatedBrowserActor> = {}): AuthenticatedBrowserActor {
  const account = testAccount();
  return {
    account,
    session: testSession({ accountId: account.id }),
    ...overrides,
  };
}

/** A3-shaped fake: the REAL BrowserSessionAuthenticationError on failure. */
function fakeAuthority(actor: AuthenticatedBrowserActor | null): BrowserSessionAuthority {
  return {
    authenticate: async () => actor,
    requireMutationActor: async () => {
      if (!actor) {
        throw new BrowserSessionAuthenticationError('authentication_required', 'no session');
      }
      return actor;
    },
    bootstrap: async () => ({ authenticated: false }),
    signOut: async () => undefined,
    revokeAll: async () => ({ securityEpoch: 0n, revokedAuthSessions: 0, revokedLegacySessions: 0 }),
    revokeOthersKeepingCurrent: async () => ({ securityEpoch: 0n, revokedAuthSessions: 0, revokedLegacySessions: 0 }),
    listLiveSessions: async () => [],
    revokeSessionById: async () => ({ kind: 'not_found' }),
  };
}

interface FakeServerCalls {
  readonly startLink: Array<{
    cookie: string | undefined;
    providerId: string;
    callbackURL: string;
    errorCallbackURL?: string;
  }>;
  readonly listAccounts: Array<{ cookie: string | undefined }>;
  readonly unlinkAccount: Array<{ cookie: string | undefined; providerId: string; accountId: string }>;
  readonly getUserEmail: Array<{ cookie: string | undefined }>;
}

function fakeServer(
  overrides: {
    readonly accounts?: ReadonlyArray<{ readonly providerId: string; readonly accountId: string }>;
    readonly email?: string | null;
    readonly startLinkError?: unknown;
    readonly unlinkError?: AccountLinkingError;
  } = {},
): { readonly server: OAuthLinkServerPort; readonly calls: FakeServerCalls } {
  const calls: FakeServerCalls = { startLink: [], listAccounts: [], unlinkAccount: [], getUserEmail: [] };
  return {
    calls,
    server: {
      startLink: async (input) => {
        calls.startLink.push({ ...input });
        if (overrides.startLinkError) throw overrides.startLinkError;
        return { url: `${PRODUCT_ORIGIN}/authorize?provider=${input.providerId}`, stateCookies: ['known.state=abc; Path=/'] };
      },
      listAccounts: async (input) => {
        calls.listAccounts.push({ ...input });
        return overrides.accounts ?? [
          { providerId: 'credential', accountId: 'account-1' },
          { providerId: 'google', accountId: 'google-sub-1' },
        ];
      },
      unlinkAccount: async (input) => {
        calls.unlinkAccount.push({ ...input });
        if (overrides.unlinkError) throw overrides.unlinkError;
      },
      getUserEmail: async (input) => {
        calls.getUserEmail.push({ ...input });
        return overrides.email ?? 'owner@example.test';
      },
    },
  };
}

function fakeReauth(overrides: { readonly passwordOk?: boolean; readonly otpOk?: boolean } = {}): ReauthVerifier {
  return {
    verifyPassword: async () => overrides.passwordOk ?? true,
    verifyOtp: async () => overrides.otpOk ?? true,
  };
}

function makeService(
  options: {
    readonly actor?: AuthenticatedBrowserActor | null;
    readonly server?: OAuthLinkServerPort;
    readonly calls?: FakeServerCalls;
    readonly reauth?: ReauthVerifier;
  } = {},
): { readonly service: AccountLinkingService; readonly calls: FakeServerCalls } {
  // One recorder per construction: the default server AND the returned calls
  // must observe the SAME port calls (custom servers pass both halves).
  const defaultServer = fakeServer();
  const ports: AccountLinkingPorts = {
    authority: fakeAuthority(options.actor === undefined ? testActor() : options.actor),
    server: options.server ?? defaultServer.server,
    reauth: options.reauth ?? fakeReauth(),
    productOrigin: PRODUCT_ORIGIN,
  };
  return {
    service: createAccountLinkingService(ports),
    calls: options.calls ?? defaultServer.calls,
  };
}

describe('resolveAllowlistedCallbackUrl (Know-N origin + allowlisted returnTo)', () => {
  test('relative same-origin paths pass and resolve to the normalized path', () => {
    assert.equal(resolveAllowlistedCallbackUrl('/settings', PRODUCT_ORIGIN), '/settings');
    assert.equal(resolveAllowlistedCallbackUrl('/settings?tab=security', PRODUCT_ORIGIN), '/settings?tab=security');
    assert.equal(resolveAllowlistedCallbackUrl('/a/../b', PRODUCT_ORIGIN), '/b');
  });

  test('absolute URLs on the Know-N origin resolve to their relative path', () => {
    assert.equal(
      resolveAllowlistedCallbackUrl(`${PRODUCT_ORIGIN}/settings#security`, PRODUCT_ORIGIN),
      '/settings#security',
    );
  });

  test('foreign origins, protocol-relative URLs and hostile shapes are rejected', () => {
    assert.equal(resolveAllowlistedCallbackUrl('https://evil.example/steal', PRODUCT_ORIGIN), null);
    assert.equal(resolveAllowlistedCallbackUrl('//evil.example/steal', PRODUCT_ORIGIN), null);
    assert.equal(resolveAllowlistedCallbackUrl('https://app.example.test.evil.example/', PRODUCT_ORIGIN), null);
    assert.equal(resolveAllowlistedCallbackUrl('\\evil.example/steal', PRODUCT_ORIGIN), null);
    assert.equal(resolveAllowlistedCallbackUrl('/steal\u0000x', PRODUCT_ORIGIN), null);
    assert.equal(resolveAllowlistedCallbackUrl('javascript:alert(1)', PRODUCT_ORIGIN), null);
    assert.equal(resolveAllowlistedCallbackUrl('', PRODUCT_ORIGIN), null);
    assert.equal(resolveAllowlistedCallbackUrl(42, PRODUCT_ORIGIN), null);
    assert.equal(resolveAllowlistedCallbackUrl(undefined, PRODUCT_ORIGIN), null);
  });

  test('same-origin URLs whose path normalizes to `//host` are rejected (R15-20)', () => {
    assert.equal(resolveAllowlistedCallbackUrl(`${PRODUCT_ORIGIN}//evil.example`, PRODUCT_ORIGIN), null);
    assert.equal(resolveAllowlistedCallbackUrl('/.//evil.example', PRODUCT_ORIGIN), null);
  });
});

describe('beginProviderLink: current session + Origin/CSRF + re-auth -> OAuth start', () => {
  test('refuses without a current session (A3 authority error propagates)', async () => {
    const { service, calls } = makeService({ actor: null });
    await assert.rejects(
      service.beginProviderLink({
        cookie: undefined,
        providerId: 'google',
        callbackURL: '/settings',
        reauth: { kind: 'password', password: 'password-123' }, // secret-scan: allow 'password-123'
      }),
      (error: unknown) => error instanceof BrowserSessionAuthenticationError
        && error.code === 'authentication_required',
    );
    assert.equal(calls.startLink.length, 0);
  });

  test('refuses a callback URL outside the Know-N origin (open-redirect guard)', async () => {
    const { service, calls } = makeService();
    await assert.rejects(
      service.beginProviderLink({
        cookie: '__Host-known_session=abc',
        providerId: 'google',
        callbackURL: 'https://evil.example/steal',
        reauth: { kind: 'password', password: 'password-123' }, // secret-scan: allow 'password-123'
      }),
      (error: unknown) => error instanceof AccountLinkingError && error.code === 'invalid_callback_url',
    );
    assert.equal(calls.startLink.length, 0);
  });

  test('refuses a hostile error callback URL too', async () => {
    const { service, calls } = makeService();
    await assert.rejects(
      service.beginProviderLink({
        cookie: '__Host-known_session=abc',
        providerId: 'google',
        callbackURL: '/settings',
        errorCallbackURL: '//evil.example/steal',
        reauth: { kind: 'password', password: 'password-123' }, // secret-scan: allow 'password-123'
      }),
      (error: unknown) => error instanceof AccountLinkingError && error.code === 'invalid_callback_url',
    );
    assert.equal(calls.startLink.length, 0);
  });

  test('refuses a wrong password re-auth proof', async () => {
    const { service, calls } = makeService({ reauth: fakeReauth({ passwordOk: false }) });
    await assert.rejects(
      service.beginProviderLink({
        cookie: '__Host-known_session=abc',
        providerId: 'google',
        callbackURL: '/settings',
        reauth: { kind: 'password', password: 'wrong-password' }, // secret-scan: allow 'wrong-password'
      }),
      (error: unknown) => error instanceof AccountLinkingError && error.code === 'reauth_failed',
    );
    assert.equal(calls.startLink.length, 0);
  });

  test('OTP re-auth must target the CURRENT session user email (no cross-user proof)', async () => {
    const { service, calls } = makeService();
    await assert.rejects(
      service.beginProviderLink({
        cookie: '__Host-known_session=abc',
        providerId: 'google',
        callbackURL: '/settings',
        reauth: { kind: 'otp', email: 'someone-else@example.test', otp: '123456' },
      }),
      (error: unknown) => error instanceof AccountLinkingError && error.code === 'reauth_failed',
    );
    assert.equal(calls.startLink.length, 0);
  });

  test('refuses a wrong OTP even for the session user email', async () => {
    const { service, calls } = makeService({ reauth: fakeReauth({ otpOk: false }) });
    await assert.rejects(
      service.beginProviderLink({
        cookie: '__Host-known_session=abc',
        providerId: 'google',
        callbackURL: '/settings',
        reauth: { kind: 'otp', email: 'OWNER@example.test', otp: '000000' },
      }),
      (error: unknown) => error instanceof AccountLinkingError && error.code === 'reauth_failed',
    );
    assert.equal(calls.startLink.length, 0);
  });

  test('refuses a provider that is already linked before any OAuth round trip', async () => {
    const { service, calls } = makeService();
    await assert.rejects(
      service.beginProviderLink({
        cookie: '__Host-known_session=abc',
        providerId: 'google',
        callbackURL: '/settings',
        reauth: { kind: 'password', password: 'password-123' }, // secret-scan: allow 'password-123'
      }),
      (error: unknown) => error instanceof AccountLinkingError && error.code === 'already_linked',
    );
    assert.equal(calls.startLink.length, 0);
  });

  test('propagates provider-not-configured failures from the server port', async () => {
    const server = fakeServer({
      startLinkError: new AccountLinkingError('provider_not_configured', 'no such provider'),
    });
    const { service } = makeService({ server: server.server, calls: server.calls });
    await assert.rejects(
      service.beginProviderLink({
        cookie: '__Host-known_session=abc',
        providerId: 'github',
        callbackURL: '/settings',
        reauth: { kind: 'password', password: 'password-123' }, // secret-scan: allow 'password-123'
      }),
      (error: unknown) => error instanceof AccountLinkingError && error.code === 'provider_not_configured',
    );
  });

  test('wraps an unknown start-link failure as link_start_failed', async () => {
    const server = fakeServer({ startLinkError: new Error('provider timeout') });
    const { service } = makeService({ server: server.server, calls: server.calls });
    await assert.rejects(
      service.beginProviderLink({
        cookie: '__Host-known_session=abc',
        providerId: 'github',
        callbackURL: '/settings',
        reauth: { kind: 'password', password: 'password-123' }, // secret-scan: allow 'password-123'
      }),
      (error: unknown) => error instanceof AccountLinkingError && error.code === 'link_start_failed',
    );
  });

  test('success: session + re-auth pass, the callback URL is normalized, the OAuth start is issued', async () => {
    const { service, calls } = makeService();
    const result = await service.beginProviderLink({
      cookie: '__Host-known_session=abc',
      providerId: 'github',
      callbackURL: `${PRODUCT_ORIGIN}/settings?tab=security`,
      errorCallbackURL: '/error',
      reauth: { kind: 'password', password: 'password-123' }, // secret-scan: allow 'password-123'
    });
    assert.ok(result.url.includes('provider=github'));
    assert.deepEqual(result.stateCookies, ['known.state=abc; Path=/']);
    assert.equal(calls.startLink.length, 1);
    assert.equal(calls.startLink[0]!.providerId, 'github');
    assert.equal(calls.startLink[0]!.callbackURL, '/settings?tab=security', 'the callback URL must be normalized to a relative path');
    assert.equal(calls.startLink[0]!.errorCallbackURL, '/error');
    assert.equal(calls.getUserEmail.length, 0, 'password re-auth must not consult the user email');
  });

  test('OTP re-auth success requires the session user email match and verifies the OTP', async () => {
    const { service, calls } = makeService();
    const result = await service.beginProviderLink({
      cookie: '__Host-known_session=abc',
      providerId: 'github',
      callbackURL: '/settings',
      reauth: { kind: 'otp', email: 'owner@example.test', otp: '123456' },
    });
    assert.ok(result.url.length > 0);
    assert.equal(calls.getUserEmail.length, 1);
    assert.equal(calls.startLink.length, 1);
  });
});

describe('listLinkedProviders: session-gated social rows only + hasPassword', () => {
  test('refuses without a current session', async () => {
    const { service, calls } = makeService({ actor: null });
    await assert.rejects(
      () => service.listLinkedProviders({ cookie: undefined }),
      (error: unknown) => error instanceof BrowserSessionAuthenticationError,
    );
    assert.equal(calls.listAccounts.length, 0);
  });

  test('returns social providers, omits the credential row, and hasPassword is true', async () => {
    const { service, calls } = makeService();
    const listed = await service.listLinkedProviders({ cookie: '__Host-known_session=abc' });
    assert.deepEqual(listed.accounts, [{ providerId: 'google', accountId: 'google-sub-1' }]);
    assert.equal(listed.hasPassword, true);
    assert.equal(
      listed.accounts.some((account) => account.providerId === 'credential'),
      false,
      'the credential row must never appear in the social list',
    );
    assert.equal(calls.listAccounts.length, 1);
    assert.equal(calls.startLink.length, 0);
  });

  test('hasPassword is false when the session user has no credential row (OAuth-only)', async () => {
    const server = fakeServer({ accounts: [{ providerId: 'google', accountId: 'google-sub-1' }] });
    const { service } = makeService({ server: server.server, calls: server.calls });
    const listed = await service.listLinkedProviders({ cookie: '__Host-known_session=abc' });
    assert.deepEqual(listed.accounts, [{ providerId: 'google', accountId: 'google-sub-1' }]);
    assert.equal(listed.hasPassword, false);
  });

  test('credential-only users have hasPassword true and an empty social list', async () => {
    const server = fakeServer({ accounts: [{ providerId: 'credential', accountId: 'account-1' }] });
    const { service } = makeService({ server: server.server, calls: server.calls });
    const listed = await service.listLinkedProviders({ cookie: '__Host-known_session=abc' });
    assert.deepEqual(listed.accounts, []);
    assert.equal(listed.hasPassword, true);
  });
});

describe('unlinkProvider: only when another recovery method remains', () => {
  test('refuses without a current session', async () => {
    const { service, calls } = makeService({ actor: null });
    await assert.rejects(
      service.unlinkProvider({
        cookie: undefined,
        providerId: 'google',
        accountId: 'google-sub-1',
        reauth: { kind: 'password', password: 'password-123' }, // secret-scan: allow 'password-123'
      }),
      (error: unknown) => error instanceof BrowserSessionAuthenticationError,
    );
    assert.equal(calls.unlinkAccount.length, 0);
  });

  test('refuses a failed re-auth proof before touching any account row', async () => {
    const { service, calls } = makeService({ reauth: fakeReauth({ passwordOk: false }) });
    await assert.rejects(
      service.unlinkProvider({
        cookie: '__Host-known_session=abc',
        providerId: 'google',
        accountId: 'google-sub-1',
        reauth: { kind: 'password', password: 'wrong-password' }, // secret-scan: allow 'wrong-password'
      }),
      (error: unknown) => error instanceof AccountLinkingError && error.code === 'reauth_failed',
    );
    assert.equal(calls.unlinkAccount.length, 0);
  });

  test('refuses when the target account is not linked to the session user', async () => {
    const { service, calls } = makeService();
    await assert.rejects(
      service.unlinkProvider({
        cookie: '__Host-known_session=abc',
        providerId: 'google',
        accountId: 'some-other-sub',
        reauth: { kind: 'password', password: 'password-123' }, // secret-scan: allow 'password-123'
      }),
      (error: unknown) => error instanceof AccountLinkingError && error.code === 'account_not_found',
    );
    assert.equal(calls.unlinkAccount.length, 0);
  });

  test('refuses removing the LAST recovery method (provider-only account)', async () => {
    const server = fakeServer({ accounts: [{ providerId: 'google', accountId: 'google-sub-1' }] });
    const { service, calls } = makeService({ server: server.server, calls: server.calls });
    await assert.rejects(
      service.unlinkProvider({
        cookie: '__Host-known_session=abc',
        providerId: 'google',
        accountId: 'google-sub-1',
        reauth: { kind: 'otp', email: 'owner@example.test', otp: '123456' },
      }),
      (error: unknown) => error instanceof AccountLinkingError && error.code === 'last_recovery_method',
    );
    assert.equal(calls.unlinkAccount.length, 0, 'the last recovery method must never be deleted');
  });

  test('refuses removing the last credential (password-only account)', async () => {
    const server = fakeServer({ accounts: [{ providerId: 'credential', accountId: 'account-1' }] });
    const { service, calls } = makeService({ server: server.server, calls: server.calls });
    await assert.rejects(
      service.unlinkProvider({
        cookie: '__Host-known_session=abc',
        providerId: 'credential',
        accountId: 'account-1',
        reauth: { kind: 'password', password: 'password-123' }, // secret-scan: allow 'password-123'
      }),
      (error: unknown) => error instanceof AccountLinkingError && error.code === 'last_recovery_method',
    );
    assert.equal(calls.unlinkAccount.length, 0);
  });

  test('P7: every AccountLinkingError code the mapper must handle is produced by the facade', async () => {
    const codes = new Set<string>();
    const capture = (error: unknown): boolean => {
      if (error instanceof AccountLinkingError) codes.add(error.code);
      return error instanceof AccountLinkingError;
    };

    const alreadyLinked = makeService();
    await assert.rejects(alreadyLinked.service.beginProviderLink({
      cookie: '__Host-known_session=abc',
      providerId: 'google',
      callbackURL: '/settings',
      reauth: { kind: 'password', password: 'password-123' }, // secret-scan: allow 'password-123'
    }), capture);

    const hostileCallback = makeService();
    await assert.rejects(hostileCallback.service.beginProviderLink({
      cookie: '__Host-known_session=abc',
      providerId: 'github',
      callbackURL: 'https://evil.example/steal',
      reauth: { kind: 'password', password: 'password-123' }, // secret-scan: allow 'password-123'
    }), capture);

    const reauthFailed = makeService({ reauth: fakeReauth({ passwordOk: false }) });
    await assert.rejects(reauthFailed.service.beginProviderLink({
      cookie: '__Host-known_session=abc',
      providerId: 'github',
      callbackURL: '/settings',
      reauth: { kind: 'password', password: 'wrong-password' }, // secret-scan: allow 'wrong-password'
    }), capture);

    const notConfigured = fakeServer({
      startLinkError: new AccountLinkingError('provider_not_configured', 'no such provider'),
    });
    await assert.rejects(makeService({ server: notConfigured.server, calls: notConfigured.calls }).service.beginProviderLink({
      cookie: '__Host-known_session=abc',
      providerId: 'github',
      callbackURL: '/settings',
      reauth: { kind: 'password', password: 'password-123' }, // secret-scan: allow 'password-123'
    }), capture);

    const startFailed = fakeServer({ startLinkError: new Error('provider timeout') });
    await assert.rejects(makeService({ server: startFailed.server, calls: startFailed.calls }).service.beginProviderLink({
      cookie: '__Host-known_session=abc',
      providerId: 'github',
      callbackURL: '/settings',
      reauth: { kind: 'password', password: 'password-123' }, // secret-scan: allow 'password-123'
    }), capture);

    const notFound = makeService();
    await assert.rejects(notFound.service.unlinkProvider({
      cookie: '__Host-known_session=abc',
      providerId: 'google',
      accountId: 'missing-sub',
      reauth: { kind: 'password', password: 'password-123' }, // secret-scan: allow 'password-123'
    }), capture);

    const lastMethod = fakeServer({ accounts: [{ providerId: 'google', accountId: 'google-sub-1' }] });
    await assert.rejects(makeService({ server: lastMethod.server, calls: lastMethod.calls }).service.unlinkProvider({
      cookie: '__Host-known_session=abc',
      providerId: 'google',
      accountId: 'google-sub-1',
      reauth: { kind: 'otp', email: 'owner@example.test', otp: '123456' },
    }), capture);

    assert.deepEqual([...codes].sort(), [
      'account_not_found',
      'already_linked',
      'invalid_callback_url',
      'last_recovery_method',
      'link_start_failed',
      'provider_not_configured',
      'reauth_failed',
    ]);
  });

  test('success: another recovery method remains, only the target account is removed', async () => {
    const { service, calls } = makeService();
    await service.unlinkProvider({
      cookie: '__Host-known_session=abc',
      providerId: 'google',
      accountId: 'google-sub-1',
      reauth: { kind: 'password', password: 'password-123' }, // secret-scan: allow 'password-123'
    });
    assert.equal(calls.unlinkAccount.length, 1);
    assert.equal(calls.unlinkAccount[0]!.providerId, 'google');
    assert.equal(calls.unlinkAccount[0]!.accountId, 'google-sub-1');
    assert.equal(calls.unlinkAccount[0]!.cookie, '__Host-known_session=abc');
  });
});

describe('account recovery: verified-email OTP / password reset only', () => {
  function recoveryService(server: RecoveryServerPort): AccountRecoveryService {
    return createAccountRecoveryService(server);
  }

  function fakeRecoveryServer(overrides: { readonly requestError?: unknown; readonly resetError?: unknown } = {}): RecoveryServerPort & { readonly calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      async requestPasswordReset({ email }) {
        calls.push(`request:${email}`);
        if (overrides.requestError) throw overrides.requestError;
      },
      async resetPasswordWithEmailOtp({ email }) {
        calls.push(`reset:${email}`);
        if (overrides.resetError) throw overrides.resetError;
      },
    };
  }

  test('a provider email claim is never an acceptable recovery proof', () => {
    assert.doesNotThrow(() => assertAcceptableRecoveryProof('password-reset-token'));
    assert.doesNotThrow(() => assertAcceptableRecoveryProof('verified-email-otp'));
    assert.throws(
      () => assertAcceptableRecoveryProof('provider-email-claim'),
      (error: unknown) => error instanceof AccountRecoveryError && error.code === 'invalid_credentials',
    );
  });

  test('requestPasswordRecovery is non-enumerating (same success shape) and delivers through the port', async () => {
    const server = fakeRecoveryServer();
    const service = recoveryService(server);
    const result = await service.requestPasswordRecovery({ email: 'owner@example.test' });
    assert.deepEqual(result, { status: true });
    assert.deepEqual(server.calls, ['request:owner@example.test']);
  });

  test('a disabled reset delivery maps to the stable email_delivery_unavailable error', async () => {
    const server = fakeRecoveryServer({
      requestError: Object.assign(new Error('reset disabled'), { code: 'RESET_PASSWORD_DISABLED' }),
    });
    const service = recoveryService(server);
    await assert.rejects(
      service.requestPasswordRecovery({ email: 'owner@example.test' }),
      (error: unknown) => error instanceof AccountRecoveryError && error.code === 'email_delivery_unavailable',
    );
  });

  test('recoverWithVerifiedEmailOtp succeeds through the verified-email OTP proof', async () => {
    const server = fakeRecoveryServer();
    const service = recoveryService(server);
    const result = await service.recoverWithVerifiedEmailOtp({
      email: 'owner@example.test',
      otp: '123456',
      newPassword: 'new-password-456', // secret-scan: allow 'new-password-456'
    });
    assert.deepEqual(result, { status: true });
    assert.deepEqual(server.calls, ['reset:owner@example.test']);
  });

  test('invalid/expired/exhausted OTPs map to the non-enumerating invalid_credentials error', async () => {
    const server = fakeRecoveryServer({
      resetError: Object.assign(new Error('invalid otp'), { code: 'INVALID_OTP' }),
    });
    const service = recoveryService(server);
    await assert.rejects(
      service.recoverWithVerifiedEmailOtp({ email: 'owner@example.test', otp: '000000', newPassword: 'new-password-456' }), // secret-scan: allow 'new-password-456'
      (error: unknown) => error instanceof AccountRecoveryError && error.code === 'invalid_credentials',
    );
  });

  test('weak passwords map to invalid_request', async () => {
    const server = fakeRecoveryServer({
      resetError: Object.assign(new Error('too short'), { code: 'PASSWORD_TOO_SHORT' }),
    });
    const service = recoveryService(server);
    await assert.rejects(
      service.recoverWithVerifiedEmailOtp({ email: 'owner@example.test', otp: '123456', newPassword: 'short' }),
      (error: unknown) => error instanceof AccountRecoveryError && error.code === 'invalid_request',
    );
  });
});

describe('better-auth-config second line of defense: SOCIAL_ENABLED gating', () => {
  test('socialEnabled requires at least one configured provider at the module boundary', () => {
    assert.throws(
      () => buildBetterAuthConfig({
        enabled: true,
        cutoverMode: 'shadow',
        emailOtpEnabled: false,
        socialEnabled: true,
        baseUrl: PRODUCT_ORIGIN,
        basePath: '/api/v1/auth',
        secret: 'test-better-auth-secret-0123456789abcdef', // secret-scan: allow 'test-better-auth-secret-0123456789abcdef'
        sessionTokenProtection: TEST_SESSION_TOKEN_PROTECTION,
        trustedOrigins: [PRODUCT_ORIGIN],
        cookieName: '__Host-known_session',
        sessionExpiresInSeconds: 86_400,
        sessionUpdateAgeSeconds: 60,
        otpTtlSeconds: 300,
        otpMaxAttempts: 3,
        bodyLimitBytes: 1024,
        social: {},
      }),
      /at least one configured provider/u,
    );
    // Gated off: no providers is fine and the config carries no credentials.
    const disabled = buildBetterAuthConfig({
      enabled: true,
      cutoverMode: 'shadow',
      emailOtpEnabled: false,
      socialEnabled: false,
      baseUrl: PRODUCT_ORIGIN,
      basePath: '/api/v1/auth',
      secret: 'test-better-auth-secret-0123456789abcdef', // secret-scan: allow 'test-better-auth-secret-0123456789abcdef'
      sessionTokenProtection: TEST_SESSION_TOKEN_PROTECTION,
      trustedOrigins: [PRODUCT_ORIGIN],
      cookieName: '__Host-known_session',
      sessionExpiresInSeconds: 86_400,
      sessionUpdateAgeSeconds: 60,
      otpTtlSeconds: 300,
      otpMaxAttempts: 3,
      bodyLimitBytes: 1024,
      social: {},
    });
    assert.ok(disabled);
    assert.equal(disabled.social, null);
  });

  test('provider credentials flow from the typed config only when enabled', () => {
    const built = buildBetterAuthConfig({
      enabled: true,
      cutoverMode: 'shadow',
      emailOtpEnabled: false,
      socialEnabled: true,
      baseUrl: PRODUCT_ORIGIN,
      basePath: '/api/v1/auth',
      secret: 'test-better-auth-secret-0123456789abcdef', // secret-scan: allow 'test-better-auth-secret-0123456789abcdef'
      sessionTokenProtection: TEST_SESSION_TOKEN_PROTECTION,
      trustedOrigins: [PRODUCT_ORIGIN],
      cookieName: '__Host-known_session',
      sessionExpiresInSeconds: 86_400,
      sessionUpdateAgeSeconds: 60,
      otpTtlSeconds: 300,
      otpMaxAttempts: 3,
      bodyLimitBytes: 1024,
      social: {
        google: { clientId: 'google-client-id', clientSecret: 'google-client-secret' }, // secret-scan: allow 'google-client-secret'
      },
    });
    assert.ok(built);
    assert.deepEqual(built.social?.google, { clientId: 'google-client-id', clientSecret: 'google-client-secret' }); // secret-scan: allow 'google-client-secret'
    assert.equal(built.social?.github, undefined);
  });
});
