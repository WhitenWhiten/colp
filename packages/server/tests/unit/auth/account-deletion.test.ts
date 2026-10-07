/**
 * P10 unit tests: account deletion facade
 * (modules/auth/application/account-deletion.ts).
 *
 * Missing/wrong reauth must refuse before revokeAll / markDeleted / BA
 * deleteUser. Wrong confirmation must leave the account active. Success
 * marks the business account deleted-status (email null) and removes the
 * Better Auth user.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  AccountDeletionError,
  AccountLinkingError,
  BrowserSessionAuthenticationError,
  createAccountDeletionService,
  type AccountDeletionPorts,
  type AccountDeletionService,
  type AuthenticatedBrowserActor,
  type BetterAuthUserDeletionPort,
  type BrowserSessionAuthority,
  type OAuthLinkServerPort,
  type ReauthVerifier,
} from '../../../src/modules/auth/index.js';
import type { Account, Session } from '../../../src/modules/identity/index.js';

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

function fakeAuthority(actor: AuthenticatedBrowserActor | null): BrowserSessionAuthority & {
  readonly revokeAllCalls: string[];
} {
  const revokeAllCalls: string[] = [];
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
    revokeAll: async (accountId) => {
      revokeAllCalls.push(accountId);
      return { securityEpoch: 1n, revokedAuthSessions: 1, revokedLegacySessions: 0 };
    },
    revokeOthersKeepingCurrent: async () => ({ securityEpoch: 0n, revokedAuthSessions: 0, revokedLegacySessions: 0 }),
    listLiveSessions: async () => [],
    revokeSessionById: async () => ({ kind: 'not_found' }),
    revokeAllCalls,
  };
}

function fakeServer(email: string | null = 'owner@example.test'): Pick<OAuthLinkServerPort, 'getUserEmail'> {
  return {
    getUserEmail: async () => email,
  };
}

function fakeReauth(overrides: { readonly passwordOk?: boolean; readonly otpOk?: boolean } = {}): ReauthVerifier {
  return {
    verifyPassword: async () => overrides.passwordOk ?? true,
    verifyOtp: async () => overrides.otpOk ?? true,
  };
}

function makeService(options: {
  readonly actor?: AuthenticatedBrowserActor | null;
  readonly reauth?: ReauthVerifier;
  readonly email?: string | null;
} = {}): {
  readonly service: AccountDeletionService;
  readonly accounts: Map<string, Account>;
  readonly baUsers: Set<string>;
  readonly revokeAllCalls: string[];
  readonly deletedBaUsers: string[];
} {
  const actor = options.actor === undefined ? testActor() : options.actor;
  const accounts = new Map<string, Account>();
  if (actor) accounts.set(actor.account.id, { ...actor.account });
  const baUsers = new Set<string>(['ba-user-1']);
  const deletedBaUsers: string[] = [];
  const authority = fakeAuthority(actor);
  const betterAuthUsers: BetterAuthUserDeletionPort = {
    getAuthUserId: async () => (baUsers.has('ba-user-1') ? 'ba-user-1' : null),
  };
  const ports: AccountDeletionPorts = {
    authority,
    server: fakeServer(options.email),
    reauth: options.reauth ?? fakeReauth(),
    store: {
      complete: async (accountId, authUserId) => {
        const account = accounts.get(accountId);
        if (!account) throw new Error('missing account');
        await authority.revokeAll(accountId);
        accounts.set(accountId, { ...account, status: 'deleted', deletedAt: new Date('2026-08-18T00:00:00.000Z'), email: null });
        baUsers.delete(authUserId);
        deletedBaUsers.push(authUserId);
      },
    },
    betterAuthUsers,
  };
  return {
    service: createAccountDeletionService(ports),
    accounts,
    baUsers,
    revokeAllCalls: authority.revokeAllCalls,
    deletedBaUsers,
  };
}

describe('deleteAccount: reauth + typed confirmation + irreversible order', () => {
  test('refuses without a current session before any mutation', async () => {
    const { service, revokeAllCalls, deletedBaUsers, accounts } = makeService({ actor: null });
    await assert.rejects(
      service.deleteAccount({
        cookie: undefined,
        confirmation: 'DELETE',
        reauth: { kind: 'password', password: 'password-123' }, // secret-scan: allow 'password-123'
      }),
      (error: unknown) => error instanceof BrowserSessionAuthenticationError
        && error.code === 'authentication_required',
    );
    assert.equal(revokeAllCalls.length, 0);
    assert.equal(deletedBaUsers.length, 0);
    assert.equal(accounts.size, 0);
  });

  test('failed reauth is refused and leaves the account active', async () => {
    const { service, revokeAllCalls, deletedBaUsers, accounts, baUsers } = makeService({
      reauth: fakeReauth({ passwordOk: false }),
    });
    await assert.rejects(
      service.deleteAccount({
        cookie: '__Host-known_session=abc',
        confirmation: 'DELETE',
        reauth: { kind: 'password', password: 'wrong-password' }, // secret-scan: allow 'wrong-password'
      }),
      (error: unknown) => error instanceof AccountLinkingError && error.code === 'reauth_failed',
    );
    assert.equal(revokeAllCalls.length, 0);
    assert.equal(deletedBaUsers.length, 0);
    assert.equal(accounts.get('account-1')?.status, 'active');
    assert.equal(accounts.get('account-1')?.email, 'owner@example.test');
    assert.equal(baUsers.has('ba-user-1'), true);
  });

  test('wrong confirmation is invalid_request and leaves the account active', async () => {
    const { service, revokeAllCalls, deletedBaUsers, accounts, baUsers } = makeService();
    await assert.rejects(
      service.deleteAccount({
        cookie: '__Host-known_session=abc',
        confirmation: 'delete',
        reauth: { kind: 'password', password: 'password-123' }, // secret-scan: allow 'password-123'
      }),
      (error: unknown) => error instanceof AccountDeletionError && error.code === 'invalid_confirmation',
    );
    assert.equal(revokeAllCalls.length, 0);
    assert.equal(deletedBaUsers.length, 0);
    assert.equal(accounts.get('account-1')?.status, 'active');
    assert.equal(accounts.get('account-1')?.deletedAt, null);
    assert.equal(accounts.get('account-1')?.email, 'owner@example.test');
    assert.equal(baUsers.has('ba-user-1'), true);
  });

  test('success: account is deleted-status with email null and BA user is gone', async () => {
    const { service, revokeAllCalls, deletedBaUsers, accounts, baUsers } = makeService();
    await service.deleteAccount({
      cookie: '__Host-known_session=abc',
      confirmation: 'DELETE',
      reauth: { kind: 'password', password: 'password-123' }, // secret-scan: allow 'password-123'
    });
    assert.deepEqual(revokeAllCalls, ['account-1']);
    const deleted = accounts.get('account-1');
    assert.ok(deleted);
    assert.equal(deleted.status, 'deleted');
    assert.deepEqual(deleted.deletedAt, new Date('2026-08-18T00:00:00.000Z'));
    assert.equal(deleted.email, null);
    assert.deepEqual(deletedBaUsers, ['ba-user-1']);
    assert.equal(baUsers.has('ba-user-1'), false);
  });
});
