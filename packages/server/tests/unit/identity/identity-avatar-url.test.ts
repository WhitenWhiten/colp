import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { createMemoryOidcLoginTransactionRepository } from '../../support/memory-oidc.js';
import {
  IdentityError,
  OIDC_AVATAR_URL_REJECTED_METRIC,
  assertValidAvatarUrl,
  createIdentityApplication,
  createTestOidcTransactionSecrets,
  isValidAvatarUrl,
  resolveTrustedOidcClaims,
  type Account,
  type AccountIdentity,
  type IdentityPorts,
  type IdentityUnitOfWork,
  type OidcClaimSyncMetrics,
  type OidcLoginTransaction,
  type Profile,
  type ProfileHandle,
  type Session,
} from '../../../src/modules/identity/index.js';

const NOW = new Date('2026-01-01T12:00:00.000Z');

/**
 * FIX-M-003: the HttpsUrl contract (docs/08 §7.3) requires absolute https,
 * no userinfo, no fragment, no explicit non-default port, and a canonical
 * value of at most 2048 characters. These tests prove the strict validator,
 * the discard-to-null OIDC policy with a sanitized metric, the application
 * write path, and the fail-closed read adapter never emit a raw invalid URL.
 */

function expectInvalidAvatarUrl(value: string): void {
  try {
    assertValidAvatarUrl(value);
    assert.fail(`expected IdentityError for avatarUrl ${JSON.stringify(value)}`);
  } catch (error: unknown) {
    assert.ok(error instanceof IdentityError, `expected IdentityError, got ${String(error)}`);
    assert.equal(error.code, 'invalid_identity_input');
  }
}

describe('identity avatar URL: strict HttpsUrl validation', () => {
  test('accepts absolute https URLs and returns the canonical serialization', () => {
    assert.equal(assertValidAvatarUrl('https://cdn.example/a.png'), 'https://cdn.example/a.png');
    // Explicit default port normalizes away.
    assert.equal(assertValidAvatarUrl('https://cdn.example:443/a.png'), 'https://cdn.example/a.png');
    assert.equal(assertValidAvatarUrl('https://cdn.example:0443/a.png'), 'https://cdn.example/a.png');
    // Scheme and host case normalize; path case is preserved.
    assert.equal(assertValidAvatarUrl('HTTPS://CDN.EXAMPLE/A.png'), 'https://cdn.example/A.png');
    // IDN hosts normalize to punycode and non-ASCII path bytes are encoded.
    assert.equal(
      assertValidAvatarUrl('https://例子.测试/头像.png'),
      'https://xn--fsqu00a.xn--0zwm56d/%E5%A4%B4%E5%83%8F.png',
    );
    // Spaces and empty userinfo normalize to a canonical safe form.
    assert.equal(assertValidAvatarUrl('https://cdn.example/a b.png'), 'https://cdn.example/a%20b.png');
    assert.equal(assertValidAvatarUrl('https://@host/x'), 'https://host/x');
    // Query strings are preserved.
    assert.equal(assertValidAvatarUrl('https://cdn.example/a.png?v=1'), 'https://cdn.example/a.png?v=1');
    assert.equal(assertValidAvatarUrl(null), null);
    assert.equal(assertValidAvatarUrl(undefined), null);
  });

  test('enforces the 2048-character limit on the canonical value', () => {
    const boundary = `https://cdn.example/${'a'.repeat(2028)}`;
    assert.equal(boundary.length, 2048);
    assert.equal(assertValidAvatarUrl(boundary), boundary);
    expectInvalidAvatarUrl(`https://cdn.example/${'a'.repeat(2049)}`);
    // Non-ASCII input below the raw limit can still exceed 2048 canonical
    // characters after percent-encoding, and must be rejected.
    assert.equal(assertValidAvatarUrl(`https://cdn.example/${'头'.repeat(224)}`).length, 2036);
    expectInvalidAvatarUrl(`https://cdn.example/${'头'.repeat(240)}`);
  });

  test('rejects empty strings and non-https schemes', () => {
    expectInvalidAvatarUrl('');
    expectInvalidAvatarUrl('javascript:alert(1)');
    expectInvalidAvatarUrl('javascript:alert(1)//https://cdn.example/a.png');
    expectInvalidAvatarUrl('data:text/html;base64,PHNjcmlwdD4=');
    expectInvalidAvatarUrl('http://cdn.example/a.png');
    expectInvalidAvatarUrl('ftp://cdn.example/a.png');
    expectInvalidAvatarUrl('HTTP://CDN.EXAMPLE/a.png');
  });

  test('rejects relative and hostless URLs', () => {
    expectInvalidAvatarUrl('/a.png');
    expectInvalidAvatarUrl('a.png');
    expectInvalidAvatarUrl('//cdn.example/a.png');
    expectInvalidAvatarUrl('https://');
    expectInvalidAvatarUrl('https://?x');
  });

  test('rejects userinfo in plain and percent-encoded form', () => {
    expectInvalidAvatarUrl('https://user:pass@cdn.example/a.png');
    expectInvalidAvatarUrl('https://user@cdn.example/a.png');
    expectInvalidAvatarUrl('https://user%40name@cdn.example/a.png');
    expectInvalidAvatarUrl('https://user%3Aname%40x@cdn.example/a.png');
  });

  test('rejects fragments, non-default ports, and control characters', () => {
    expectInvalidAvatarUrl('https://cdn.example/a.png#fragment');
    expectInvalidAvatarUrl('https://cdn.example/a.png#');
    expectInvalidAvatarUrl('https://cdn.example:8443/a.png');
    expectInvalidAvatarUrl('https://cdn.example:443:8443/a.png');
    // The URL parser silently strips tab/newline; the raw input must be
    // rejected instead of silently normalizing into a different host.
    expectInvalidAvatarUrl('https://exa\nmple.com/a.png');
    expectInvalidAvatarUrl('https://exa\tmple.com/a.png');
  });

  test('isValidAvatarUrl mirrors the validator without throwing', () => {
    assert.equal(isValidAvatarUrl('https://cdn.example/a.png'), true);
    assert.equal(isValidAvatarUrl('https://cdn.example:443/a.png'), true);
    assert.equal(isValidAvatarUrl('javascript:alert(1)'), false);
    assert.equal(isValidAvatarUrl('http://cdn.example/a.png'), false);
    assert.equal(isValidAvatarUrl('//cdn.example/a.png'), false);
    assert.equal(isValidAvatarUrl('https://user@cdn.example/a.png'), false);
    assert.equal(isValidAvatarUrl('https://cdn.example/a.png#x'), false);
    assert.equal(isValidAvatarUrl('https://cdn.example:8443/a.png'), false);
    assert.equal(isValidAvatarUrl(`https://cdn.example/${'a'.repeat(2049)}`), false);
  });
});

interface CapturedMetrics {
  readonly counters: Map<string, number>;
  readonly metrics: OidcClaimSyncMetrics;
}

function captureMetrics(): CapturedMetrics {
  const counters = new Map<string, number>();
  return {
    counters,
    metrics: {
      increment(name: string, value = 1): void {
        counters.set(name, (counters.get(name) ?? 0) + value);
      },
    },
  };
}

describe('identity avatar URL: OIDC claim discard-to-null policy', () => {
  test('absent claim stays undefined and explicit null stays null without metrics', () => {
    const captured = captureMetrics();
    assert.equal(resolveTrustedOidcClaims({ metrics: captured.metrics }).trustedAvatarUrl, undefined);
    assert.equal(
      resolveTrustedOidcClaims({ avatarUrl: null, metrics: captured.metrics }).trustedAvatarUrl,
      null,
    );
    assert.deepEqual([...captured.counters.keys()], []);
  });

  test('valid provider pictures are trusted and canonicalized without metrics', () => {
    const captured = captureMetrics();
    const claims = resolveTrustedOidcClaims({
      avatarUrl: 'HTTPS://CDN.EXAMPLE:443/pic.png',
      metrics: captured.metrics,
    });
    assert.equal(claims.trustedAvatarUrl, 'https://cdn.example/pic.png');
    assert.deepEqual([...captured.counters.keys()], []);
  });

  test('invalid provider pictures are discarded to null and counted with a fixed sanitized metric', () => {
    for (const raw of [
      '',
      'javascript:alert(1)',
      'data:text/html;base64,PHNjcmlwdD4=',
      'http://cdn.example/pic.png',
      '/relative.png',
      '//cdn.example/pic.png',
      'https://user:pass@cdn.example/pic.png',
      'https://user%40name@cdn.example/pic.png',
      'https://cdn.example/pic.png#frag',
      'https://cdn.example:8443/pic.png',
      `https://cdn.example/${'a'.repeat(2049)}`,
    ]) {
      const captured = captureMetrics();
      const claims = resolveTrustedOidcClaims({ avatarUrl: raw, metrics: captured.metrics });
      assert.equal(claims.trustedAvatarUrl, null, `expected discard for ${JSON.stringify(raw)}`);
      assert.equal(captured.counters.get(OIDC_AVATAR_URL_REJECTED_METRIC), 1);
      assert.deepEqual(
        [...captured.counters.keys()],
        [OIDC_AVATAR_URL_REJECTED_METRIC],
        'metric name must be a fixed token and never carry the raw value',
      );
    }
  });

  test('discarding an invalid picture never blocks login resolution', () => {
    const captured = captureMetrics();
    const claims = resolveTrustedOidcClaims({
      email: 'user@example.test',
      emailVerified: true,
      displayName: 'User',
      avatarUrl: 'javascript:alert(1)',
      metrics: captured.metrics,
    });
    assert.equal(claims.emailTrusted, true);
    assert.equal(claims.trustedEmail, 'user@example.test');
    assert.equal(claims.trustedDisplayName, 'User');
    assert.equal(claims.trustedAvatarUrl, null);
  });
});

interface MemoryState {
  accounts: Map<string, Account>;
  profiles: Map<string, Profile>;
  handles: Map<string, ProfileHandle>;
  identities: Map<string, AccountIdentity>;
  identitiesByAccount: Map<string, string>;
  sessions: Map<string, Session>;
  sessionsByTokenHash: Map<string, string>;
  oidc: Map<string, OidcLoginTransaction>;
  now: Date;
}

function createMemoryPorts(state: MemoryState): IdentityPorts {
  const key = (issuer: string, subject: string) => `${issuer}\0${subject}`;
  return {
    clock: { now: async () => new Date(state.now) },
    accounts: {
      async findById(id) {
        return state.accounts.get(id) ?? null;
      },
      async findBySubjectId(subjectId) {
        for (const account of state.accounts.values()) {
          if (account.subjectId === subjectId) return account;
        }
        return null;
      },
      async findByEmail(email) {
        for (const account of state.accounts.values()) {
          if (account.email === email) return account;
        }
        return null;
      },
      async insert(account) {
        if (state.accounts.has(account.id)) throw new Error('duplicate account');
        state.accounts.set(account.id, account);
      },
      async bumpSecurityEpoch(accountId) {
        const account = state.accounts.get(accountId);
        if (!account) throw new Error('missing account');
        const next = { ...account, securityEpoch: account.securityEpoch + 1n };
        state.accounts.set(accountId, next);
        return next.securityEpoch;
      },
      async updateEmail(accountId, email) {
        const account = state.accounts.get(accountId);
        if (!account) throw new Error('missing account');
        state.accounts.set(accountId, { ...account, email });
      },
      async markDeleted(accountId, deletedAt) {
        const account = state.accounts.get(accountId);
        if (!account) throw new Error('missing account');
        state.accounts.set(accountId, { ...account, status: 'deleted', deletedAt, email: null });
      },
    },
    accountIdentities: {
      async findByIssuerSubject(issuer, subject) {
        return state.identities.get(key(issuer, subject)) ?? null;
      },
      async findByAccountId(accountId) {
        const id = state.identitiesByAccount.get(accountId);
        if (!id) return null;
        for (const identity of state.identities.values()) {
          if (identity.id === id) return identity;
        }
        return null;
      },
      async insert(identity) {
        state.identities.set(key(identity.issuer, identity.subject), identity);
        state.identitiesByAccount.set(identity.accountId, identity.id);
      },
      async insertIfAbsent(identity) {
        const existing = state.identities.get(key(identity.issuer, identity.subject));
        if (existing) return existing;
        state.identities.set(key(identity.issuer, identity.subject), identity);
        state.identitiesByAccount.set(identity.accountId, identity.id);
        return identity;
      },
    },
    profiles: {
      async findByAccountId(accountId) {
        return state.profiles.get(accountId) ?? null;
      },
      async insert(profile) {
        state.profiles.set(profile.accountId, profile);
      },
      async update(profile) {
        state.profiles.set(profile.accountId, profile);
      },
    },
    handles: {
      async findByHandle(handle) {
        return state.handles.get(handle) ?? null;
      },
      async findByAccountId(accountId) {
        for (const handle of state.handles.values()) {
          if (handle.accountId === accountId) return handle;
        }
        return null;
      },
      async insert(handle) {
        if (state.handles.has(handle.handle)) throw new Error('handle taken');
        state.handles.set(handle.handle, handle);
      },
      async tryInsert(handle) {
        if (state.handles.has(handle.handle)) return false;
        for (const row of state.handles.values()) {
          if (row.accountId === handle.accountId) return false;
        }
        state.handles.set(handle.handle, handle);
        return true;
      },
      async deleteByAccountId(accountId) {
        for (const [h, row] of state.handles) {
          if (row.accountId === accountId) {
            state.handles.delete(h);
            return true;
          }
        }
        return false;
      },
      async deleteByHandle(handle) {
        return state.handles.delete(handle);
      },
    },
    sessions: {
      async findById(id) {
        return state.sessions.get(id) ?? null;
      },
      async findByTokenHash(tokenHash) {
        const id = state.sessionsByTokenHash.get(tokenHash);
        return id ? state.sessions.get(id) ?? null : null;
      },
      async findLiveSuccessorByRotatedFrom(predecessorSessionId) {
        for (const session of state.sessions.values()) {
          if (session.rotatedFromSessionId === predecessorSessionId && session.revokedAt === null) {
            return session;
          }
        }
        return null;
      },
      async insert(session) {
        state.sessions.set(session.id, session);
        state.sessionsByTokenHash.set(session.tokenHash, session.id);
      },
      async revoke(sessionId, revokedAt) {
        const session = state.sessions.get(sessionId);
        if (!session || session.revokedAt) return false;
        state.sessions.set(sessionId, { ...session, revokedAt });
        return true;
      },
      async touch(sessionId, lastSeenAt, idleExpiresAt) {
        const session = state.sessions.get(sessionId);
        if (!session || session.revokedAt) return false;
        state.sessions.set(sessionId, { ...session, lastSeenAt, idleExpiresAt });
        return true;
      },
      async revokeAllForAccount(accountId, revokedAt) {
        let count = 0;
        for (const [id, session] of state.sessions) {
          if (session.accountId === accountId && !session.revokedAt) {
            state.sessions.set(id, { ...session, revokedAt });
            count += 1;
          }
        }
        return count;
      },
    },
    oidcLoginTransactions: createMemoryOidcLoginTransactionRepository(state.oidc),
    oidcTransactionSecrets: createTestOidcTransactionSecrets(),
  };
}

function createHarness() {
  const state: MemoryState = {
    accounts: new Map(),
    profiles: new Map(),
    handles: new Map(),
    identities: new Map(),
    identitiesByAccount: new Map(),
    sessions: new Map(),
    sessionsByTokenHash: new Map(),
    oidc: new Map(),
    now: new Date(NOW),
  };
  const ports = createMemoryPorts(state);
  const unitOfWork: IdentityUnitOfWork = {
    execute: async (work) => work(ports),
  };
  const app = createIdentityApplication({ unitOfWork });
  return { state, ports, app };
}

describe('identity avatar URL: application write path', () => {
  test('invalid provider picture does not block first login and persists null', async () => {
    const { app, state } = createHarness();
    const captured = captureMetrics();
    const result = await app.ensureAccountFromOidcIdentity({
      issuer: 'https://issuer.example',
      subject: 'evil-picture-subject',
      displayName: 'User',
      avatarUrl: 'javascript:alert(1)',
      metrics: captured.metrics,
    });
    assert.equal(state.accounts.size, 1, 'account must be created despite invalid picture');
    assert.equal(result.profile.avatarUrl, null);
    assert.equal(captured.counters.get(OIDC_AVATAR_URL_REJECTED_METRIC), 1);
  });

  test('re-login with an invalid picture discards to null and overwrites the stored avatar', async () => {
    const { app } = createHarness();
    await app.ensureAccountFromOidcIdentity({
      issuer: 'https://issuer.example',
      subject: 'avatar-downgrade',
      avatarUrl: 'https://cdn.example/before.png',
    });
    const second = await app.ensureAccountFromOidcIdentity({
      issuer: 'https://issuer.example',
      subject: 'avatar-downgrade',
      avatarUrl: 'http://cdn.example/evil.png',
    });
    assert.equal(second.profile.avatarUrl, null);
  });

  test('re-login with a valid picture stores the canonical value', async () => {
    const { app } = createHarness();
    await app.ensureAccountFromOidcIdentity({
      issuer: 'https://issuer.example',
      subject: 'avatar-canonical',
      avatarUrl: 'https://cdn.example/old.png',
    });
    const second = await app.ensureAccountFromOidcIdentity({
      issuer: 'https://issuer.example',
      subject: 'avatar-canonical',
      avatarUrl: 'HTTPS://CDN.EXAMPLE:443/new.png',
    });
    assert.equal(second.profile.avatarUrl, 'https://cdn.example/new.png');
  });

  test('absent claim keeps the stored avatar and records no metric', async () => {
    const { app } = createHarness();
    const captured = captureMetrics();
    await app.ensureAccountFromOidcIdentity({
      issuer: 'https://issuer.example',
      subject: 'avatar-absent',
      avatarUrl: 'https://cdn.example/keep.png',
    });
    const second = await app.ensureAccountFromOidcIdentity({
      issuer: 'https://issuer.example',
      subject: 'avatar-absent',
      metrics: captured.metrics,
    });
    assert.equal(second.profile.avatarUrl, 'https://cdn.example/keep.png');
    assert.deepEqual([...captured.counters.keys()], []);
  });
});
