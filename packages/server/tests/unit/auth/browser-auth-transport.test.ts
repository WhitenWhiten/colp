import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, test } from 'vitest';
import { createMemoryOidcLoginTransactionRepository } from '../../support/memory-oidc.js';
import {
  SignJWT,
  exportJWK,
  generateKeyPair,
  type JWK,
  type KeyLike,
} from 'jose';
import { loadConfig } from '../../support/test-config.js';
import { DatabaseOperationError } from '../../../src/infrastructure/database/errors.js';
import { canonicalCommandFingerprint } from '../../../src/modules/commands/index.js';
import {
  ABOUT_MAX,
  AVATAR_MAX_BYTES,
  avatarUploadBodyFingerprint,
  createSession,
  createTestOidcTransactionSecrets,
  ensureAccountFromOidcIdentity,
  hashSecret,
  IdentityError,
  PROFILE_SETTINGS_COMMAND_SCOPE,
  profileSettingsCommandFingerprint,
  type Account,
  type AccountIdentity,
  type IdentityPorts,
  type IdentityUnitOfWork,
  type OidcLoginTransaction,
  type Profile,
  type ProfileHandle,
  type Session,
} from '../../../src/modules/identity/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import {
  classifyOidcCallbackFailure,
  OidcCallbackStageError,
} from '../../../src/transport/auth/browser-auth-routes.js';
import {
  createOidcProvider,
  createTestOidcProvider,
  mintTestAuthorizationCode,
  OidcExchangeError,
  pkceS256Challenge,
} from '../../../src/transport/auth/oidc-provider.js';
import {
  constantTimeEqualString,
  resolveBrowserReturnTo,
} from '../../../src/transport/auth/origin-csrf.js';
import { buildSessionSetCookie, SESSION_COOKIE_NAME } from '../../../src/transport/session-cookie.js';
import {
  createMemoryProductCommandReceiptPort,
  productCommandReceiptKey,
  type MemoryProductCommandReceipts,
} from '../../support/product-http-harness.js';

interface MemoryAvatarStore {
  readonly objects: Map<string, { contentType: string; body: Buffer }>;
  readonly deletedIds: string[];
  put(avatarId: string, body: Buffer, contentType: string): Promise<void>;
  get(avatarId: string): Promise<{ contentType: string; body: Buffer } | null>;
  delete(avatarId: string): Promise<void>;
}

function createMemoryAvatarStore(): MemoryAvatarStore {
  const objects = new Map<string, { contentType: string; body: Buffer }>();
  const deletedIds: string[] = [];
  return {
    objects,
    deletedIds,
    async put(avatarId, body, contentType) {
      objects.set(avatarId, { contentType, body: Buffer.from(body) });
    },
    async get(avatarId) {
      return objects.get(avatarId) ?? null;
    },
    async delete(avatarId) {
      objects.delete(avatarId);
      deletedIds.push(avatarId);
    },
  };
}

interface MemoryState {
  accounts: Map<string, Account>;
  profiles: Map<string, Profile>;
  handles: Map<string, ProfileHandle>;
  identities: Map<string, AccountIdentity>;
  identitiesByAccount: Map<string, string>;
  sessions: Map<string, Session>;
  sessionsByTokenHash: Map<string, string>;
  oidc: Map<string, OidcLoginTransaction>;
  receipts: MemoryProductCommandReceipts;
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
      async insert(account) {
        if (state.accounts.has(account.id)) throw new Error('duplicate account');
        state.accounts.set(account.id, account);
      },
      async findByEmail(email) {
        for (const account of state.accounts.values()) {
          if (account.email === email) return account;
        }
        return null;
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
    receipts: createMemoryProductCommandReceiptPort(state.receipts),
  };
}

function createHarness(avatarStore?: MemoryAvatarStore) {
  const state: MemoryState = {
    accounts: new Map(),
    profiles: new Map(),
    handles: new Map(),
    identities: new Map(),
    identitiesByAccount: new Map(),
    sessions: new Map(),
    sessionsByTokenHash: new Map(),
    oidc: new Map(),
    receipts: new Map(),
    now: new Date('2026-07-22T12:00:00.000Z'),
  };
  const ports = createMemoryPorts(state);
  const unitOfWork: IdentityUnitOfWork = {
    execute: async (work) => work(ports),
  };
  const config = loadConfig({
    DATABASE_URL: 'postgres://localhost/known_test',
    PRODUCT_ORIGIN: 'https://app.example.test',
    ALLOWED_ORIGINS: 'https://app.example.test',
    OIDC_ISSUER: 'https://issuer.example/realms/known',
    OIDC_CLIENT_ID: 'known-web',
    OIDC_REDIRECT_URI: 'https://app.example.test/api/v1/auth/oidc/callback',
    OIDC_AUTHORIZATION_ENDPOINT: 'https://issuer.example/realms/known/auth',
    OIDC_TOKEN_ENDPOINT: 'https://issuer.example/realms/known/token',
    OIDC_ALLOW_TEST_PROVIDER: 'true',
    OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    // Keep Fastify's framework bodyLimit above the avatar route's 2MiB
    // product-level limit so the transport tests exercise the product
    // admission 413 boundary (AVATAR_MAX_BYTES), not the 128KiB default.
    HTTP_BODY_LIMIT_BYTES: String(4 * 1024 * 1024),
  });
  const app = buildApiApp({
    config,
    identityUnitOfWork: unitOfWork,
    oidcProvider: createTestOidcProvider(config.oidc, config.oidc.testProviderHmacSecret),
    ...(avatarStore ? { avatarStore } : {}),
  });
  return { app, state, ports, unitOfWork, config, avatarStore };
}

function firstSetCookie(header: string | string[] | undefined): string {
  assert.ok(header, 'expected Set-Cookie header');
  const values = Array.isArray(header) ? header : [header];
  return values.find(value => value.startsWith(`${SESSION_COOKIE_NAME}=`)) ?? values[0]!;
}

function cookiePairFromSetCookie(setCookie: string): string {
  return setCookie.split(';', 1)[0]!;
}

function freshCommandId(): string {
  return randomUUID();
}

/** Full browser OIDC login: start → read TX → mint test code → callback. */
async function completeOidcLoginViaCallback(
  app: ReturnType<typeof buildApiApp>,
  config: ReturnType<typeof loadConfig>,
  state: MemoryState,
  ports: IdentityPorts,
  subject: string,
  email: string,
  returnTo = '/editor',
): Promise<{ statusCode: number; headers: { location?: string } }> {
  const start = await app.inject({
    method: 'GET',
    url: `/api/v1/auth/oidc/start?returnTo=${encodeURIComponent(returnTo)}`,
  });
  assert.equal(start.statusCode, 302);
  const authUrl = new URL(start.headers.location as string);
  const stateParam = authUrl.searchParams.get('state')!;
  const nonce = authUrl.searchParams.get('nonce')!;
  const digest = ports.oidcTransactionSecrets.digestState(stateParam);
  const tx = state.oidc.get(digest);
  assert.ok(tx, 'expected an OIDC login transaction row');
  const codeVerifier = ports.oidcTransactionSecrets.decryptPkceVerifier(
    tx.pkceVerifierCiphertext,
    tx.encryptionKeyId,
    tx.encryptionKeyVersion,
  );
  const code = mintTestAuthorizationCode({
    subject,
    nonce,
    codeVerifier,
    email,
    name: subject,
    issuer: config.oidc.issuer,
    audience: config.oidc.audience,
    hmacSecret: config.oidc.testProviderHmacSecret,
  });
  const callback = await app.inject({
    method: 'GET',
    url: `/api/v1/auth/oidc/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(stateParam)}`,
    headers: { cookie: cookiePairFromSetCookie(firstSetCookie(start.headers['set-cookie'])) },
  });
  return { statusCode: callback.statusCode, headers: { location: callback.headers.location } };
}

const apps: Array<ReturnType<typeof buildApiApp>> = [];

afterEach(async () => {
  while (apps.length > 0) {
    const app = apps.pop();
    await app?.close();
  }
});

describe('browser auth transport', () => {
  test('session cookie uses __Host-known_session attributes without Domain', () => {
    assert.equal(SESSION_COOKIE_NAME, '__Host-known_session');
    const cookie = buildSessionSetCookie('tok', { maxAgeSeconds: 3600 });
    assert.match(cookie, /^__Host-known_session=/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /Secure/);
    assert.match(cookie, /SameSite=Lax/);
    assert.match(cookie, /Path=\//);
    assert.doesNotMatch(cookie, /Domain=/i);
  });

  test('returnTo rejects open redirects (protocol-relative and absolute)', () => {
    const origin = 'https://app.example.test';
    assert.equal(resolveBrowserReturnTo('/editor', origin), '/editor');
    assert.equal(resolveBrowserReturnTo('//evil.example', origin), '/');
    assert.equal(resolveBrowserReturnTo('https://evil.example', origin), '/');
    assert.equal(resolveBrowserReturnTo('https://evil.example/phish', origin), '/');
    assert.equal(resolveBrowserReturnTo('/editor', 'not a valid origin'), '/');
    assert.equal(resolveBrowserReturnTo('/.//evil.example', origin), '/');
    assert.equal(resolveBrowserReturnTo(`${origin}/editor?x=1#h`, origin), '/editor?x=1#h');
  });

  test('constant-time string comparison handles equal, unequal, and different-length values', () => {
    assert.equal(constantTimeEqualString('csrf-token', 'csrf-token'), true);
    assert.equal(constantTimeEqualString('csrf-token', 'csrf-tokem'), false);
    assert.equal(constantTimeEqualString('short', 'longer'), false);
  });

  test('GET /api/v1/session without cookie returns authenticated false with no-store', async () => {
    const { app } = createHarness();
    apps.push(app);

    const response = await app.inject({ method: 'GET', url: '/api/v1/session' });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { authenticated: false });
    assert.match(String(response.headers['cache-control'] ?? ''), /no-store/);
  });

  test('OIDC start redirects to issuer with S256 code_challenge matching stored verifier', async () => {
    const { app, state, config, ports } = createHarness();
    apps.push(app);

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/oidc/start?returnTo=%2Feditor',
    });
    assert.equal(response.statusCode, 302);

    const location = response.headers.location;
    assert.ok(typeof location === 'string');
    const url = new URL(location);
    const authEndpoint = new URL(config.oidc.authorizationEndpoint);
    assert.equal(url.origin, authEndpoint.origin);
    assert.equal(url.pathname, authEndpoint.pathname);
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(url.searchParams.get('code_challenge'));
    assert.ok(url.searchParams.get('state'));
    assert.ok(url.searchParams.get('nonce'));

    assert.equal(state.oidc.size, 1);
    const tx = [...state.oidc.values()][0]!;
    assert.equal(tx.returnTo, '/editor');
    // Raw secrets must not be stored; challenge matches decrypted verifier.
    const browserState = url.searchParams.get('state')!;
    assert.notEqual(tx.state, browserState);
    assert.equal(tx.codeVerifier, '');
    assert.ok(tx.pkceVerifierCiphertext);
    const decrypted = ports.oidcTransactionSecrets.decryptPkceVerifier(
      tx.pkceVerifierCiphertext,
      tx.encryptionKeyId,
      tx.encryptionKeyVersion,
    );
    assert.equal(url.searchParams.get('code_challenge'), pkceS256Challenge(decrypted));
    assert.ok(ports.oidcTransactionSecrets.verifyStateDigest(browserState, tx.stateHash));
    assert.ok(ports.oidcTransactionSecrets.verifyNonceDigest(
      url.searchParams.get('nonce')!,
      tx.nonceHash,
    ));
  });
  test('OIDC start stores a canonical returnTo and drops a pathname that normalizes to //', async () => {
    const { app, state, ports } = createHarness();
    apps.push(app);
    const origin = 'https://app.example.test';

    const safe = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/oidc/start?returnTo=${encodeURIComponent(`${origin}/c/reading?view=list#top`)}`,
    });
    assert.equal(safe.statusCode, 302);
    const safeState = new URL(safe.headers.location as string).searchParams.get('state')!;
    const safeTx = state.oidc.get(ports.oidcTransactionSecrets.digestState(safeState));
    assert.equal(safeTx?.returnTo, '/c/reading?view=list#top');

    const dangerous = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/oidc/start?returnTo=${encodeURIComponent('/.//evil.example')}`,
    });
    assert.equal(dangerous.statusCode, 302);
    const dangerousState = new URL(dangerous.headers.location as string).searchParams.get('state')!;
    const dangerousTx = state.oidc.get(ports.oidcTransactionSecrets.digestState(dangerousState));
    assert.equal(dangerousTx?.returnTo, '/');
    assert.equal(String(dangerousTx?.returnTo).includes('evil.example'), false);
  });

  test('OIDC callback falls back when a persisted returnTo canonicalizes to //', async () => {
    const { app, state, config, ports } = createHarness();
    apps.push(app);
    const persisted = ['/.//evil.example', '/%2e//evil.example', 'https://app.example.test//evil.example'];
    for (const [index, returnTo] of persisted.entries()) {
      const start = await app.inject({ method: 'GET', url: '/api/v1/auth/oidc/start?returnTo=%2Feditor' });
      assert.equal(start.statusCode, 302);
      const authUrl = new URL(start.headers.location as string);
      const stateParam = authUrl.searchParams.get('state')!;
      const nonce = authUrl.searchParams.get('nonce')!;
      const digest = ports.oidcTransactionSecrets.digestState(stateParam);
      const tx = state.oidc.get(digest);
      assert.ok(tx);
      tx.returnTo = returnTo;
      const codeVerifier = ports.oidcTransactionSecrets.decryptPkceVerifier(
        tx.pkceVerifierCiphertext,
        tx.encryptionKeyId,
        tx.encryptionKeyVersion,
      );
      const code = mintTestAuthorizationCode({
        subject: `oidc-user-old-return-${index}`,
        nonce,
        codeVerifier,
        email: `old-return-${index}@example.test`,
        name: 'Old Return',
        issuer: config.oidc.issuer,
        audience: config.oidc.audience,
        hmacSecret: config.oidc.testProviderHmacSecret,
      });
      const callback = await app.inject({
        method: 'GET',
        url: `/api/v1/auth/oidc/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(stateParam)}`,
        headers: { cookie: cookiePairFromSetCookie(firstSetCookie(start.headers['set-cookie'])) },
      });
      assert.equal(callback.statusCode, 303, returnTo);
      assert.equal(callback.headers.location, '/', returnTo);
      assert.equal(String(callback.headers.location).includes('evil.example'), false);
    }
  });

  test('OIDC callback requires the state cookie from the initiating browser', async () => {
    const { app, state, ports } = createHarness();
    apps.push(app);
    const start = await app.inject({ method: 'GET', url: '/api/v1/auth/oidc/start' });
    const browserCookie = cookiePairFromSetCookie(firstSetCookie(start.headers['set-cookie']));
    assert.match(browserCookie, /^__Host-known_oidc_state=/);
    const stateParam = new URL(start.headers.location as string).searchParams.get('state')!;
    const digest = ports.oidcTransactionSecrets.digestState(stateParam);
    for (const cookie of [undefined, '__Host-known_oidc_state=another-browser']) {
      const response = await app.inject({ method: 'GET',
        url: `/api/v1/auth/oidc/callback?code=not-exchanged&state=${encodeURIComponent(stateParam)}`,
        ...(cookie === undefined ? {} : { headers: { cookie } }),
      });
      assert.equal(response.headers.location, '/login?auth=failed');
      assert.equal(state.oidc.get(digest)?.consumedAt, null);
      assert.equal(state.accounts.size, 0);
      assert.equal(state.sessions.size, 0);
    }
  });

  test('OIDC success sets session cookie; access_denied and replayed state fail closed', async () => {
    const { app, state, config, ports } = createHarness();
    apps.push(app);

    const start = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/oidc/start?returnTo=%2Fhome',
    });
    assert.equal(start.statusCode, 302);
    const authUrl = new URL(start.headers.location as string);
    const stateParam = authUrl.searchParams.get('state')!;
    const nonce = authUrl.searchParams.get('nonce')!;
    const digest = ports.oidcTransactionSecrets.digestState(stateParam);
    const tx = state.oidc.get(digest)!;
    assert.ok(tx);
    const codeVerifier = ports.oidcTransactionSecrets.decryptPkceVerifier(
      tx.pkceVerifierCiphertext,
      tx.encryptionKeyId,
      tx.encryptionKeyVersion,
    );

    const code = mintTestAuthorizationCode({
      subject: 'oidc-user-1',
      nonce,
      codeVerifier,
      email: 'user@example.test',
      name: 'User',
      issuer: config.oidc.issuer,
      audience: config.oidc.audience,
      hmacSecret: config.oidc.testProviderHmacSecret,
    });

    const success = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/oidc/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(stateParam)}`,
      headers: { cookie: cookiePairFromSetCookie(firstSetCookie(start.headers['set-cookie'])) },
    });
    assert.equal(success.statusCode, 303);
    assert.equal(success.headers.location, '/home');
    const cookieHeader = firstSetCookie(success.headers['set-cookie']);
    assert.match(cookieHeader, new RegExp(SESSION_COOKIE_NAME));
    assert.equal(state.accounts.size, 1);
    assert.equal(state.sessions.size, 1);
    assert.equal(state.handles.size, 1);
    const provisioned = [...state.handles.values()][0]!;
    assert.match(provisioned.handle, /^[a-z0-9._~-]{1,64}$/u);
    assert.equal(provisioned.handle.includes('oidc-user-1'), false);

    const start2 = await app.inject({ method: 'GET', url: '/api/v1/auth/oidc/start' });
    const state2 = new URL(start2.headers.location as string).searchParams.get('state')!;
    const beforeSessions = state.sessions.size;
    const fail = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/oidc/callback?error=access_denied&state=${encodeURIComponent(state2)}`,
      headers: { cookie: cookiePairFromSetCookie(firstSetCookie(start2.headers['set-cookie'])) },
    });
    assert.equal(fail.statusCode, 303);
    assert.equal(fail.headers.location, '/login?auth=failed');
    assert.equal(state.sessions.size, beforeSessions);

    const replay = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/oidc/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(stateParam)}`,
      headers: { cookie: cookiePairFromSetCookie(firstSetCookie(start.headers['set-cookie'])) },
    });
    assert.equal(replay.statusCode, 303);
    assert.equal(replay.headers.location, '/login?auth=failed');
  });

  test('concurrent first-login email race still converges to the returnTo target', async () => {
    // CI-shard regression: when the competing callback commits the same
    // (issuer, subject) binding with the same verified email between the
    // loser's identity lookup (miss) and its email-availability check (hit),
    // the loser must converge via the identity_conflict retry and land on
    // /editor. Before the fix the email check surfaced the terminal
    // email_conflict and the callback redirected to /login?auth=failed.
    const { state, ports, config } = createHarness();
    let hideNextIdentityLookup = false;
    let uowExecutions = 0;
    const wrappedPorts: IdentityPorts = {
      ...ports,
      accountIdentities: {
        ...ports.accountIdentities,
        async findByIssuerSubject(issuer, subject) {
          if (hideNextIdentityLookup) {
            hideNextIdentityLookup = false;
            return null;
          }
          return ports.accountIdentities.findByIssuerSubject(issuer, subject);
        },
      },
    };
    const unitOfWork: IdentityUnitOfWork = {
      execute: async (work) => {
        uowExecutions += 1;
        return work(wrappedPorts);
      },
    };
    const app = buildApiApp({
      config,
      identityUnitOfWork: unitOfWork,
      oidcProvider: createTestOidcProvider(config.oidc, config.oidc.testProviderHmacSecret),
    });
    apps.push(app);
    try {
      const winner = await completeOidcLoginViaCallback(
        app, config, state, ports, 'race-subject', 'race@example.test',
      );
      assert.equal(winner.statusCode, 303);
      assert.equal(winner.headers.location, '/editor');
      assert.equal(state.accounts.size, 1);
      assert.equal(state.sessions.size, 1);

      // Arm the interleaving only for the loser callback.
      hideNextIdentityLookup = true;
      uowExecutions = 0;
      const loser = await completeOidcLoginViaCallback(
        app, config, state, ports, 'race-subject', 'race@example.test',
      );
      assert.equal(loser.statusCode, 303);
      assert.equal(loser.headers.location, '/editor');
      // Exactly one fresh-transaction retry: start TX (1) + consume (2) +
      // first issue UoW (3) + single identity_conflict retry (4). Never more.
      assert.equal(uowExecutions, 4);
      assert.equal(state.accounts.size, 1);
      assert.equal(state.sessions.size, 2);
    } finally {
      await app.close();
    }
  });

  test('mixed concurrent race: foreign email holder fails closed with a single UoW and no retry', async () => {
    // T-OIDC-005 transport contract: when the (issuer, subject) binding lands
    // on account A while a foreign account B holds the verified email, the
    // loser must be classified as terminal email_conflict on the first call —
    // no fresh-transaction retry (UoW count stays at consume + one issue
    // run), no provisional account/profile/session, redirect auth=failed.
    const { state, ports, config } = createHarness();
    let identityLookups = 0;
    let injected = false;
    let uowExecutions = 0;
    const issuer = config.oidc.issuer;
    const subject = 'mixed-race-subject';
    const email = 'mixed-race@example.test';
    const boundAccount: Account = {
      id: 'mixed-bound-account',
      subjectId: 'mixed-bound-subject-id',
      status: 'active',
      email: 'bound-other@example.test',
      securityEpoch: 0n,
      createdAt: state.now,
      deletedAt: null,
    };
    const holderAccount: Account = {
      id: 'mixed-holder-account',
      subjectId: 'mixed-holder-subject-id',
      status: 'active',
      email,
      securityEpoch: 0n,
      createdAt: state.now,
      deletedAt: null,
    };
    const holderProfile: Profile = {
      accountId: holderAccount.id,
      displayName: 'Holder B',
      avatarUrl: null,
      about: '',
      updatedAt: state.now,
    };
    const boundIdentity: AccountIdentity = {
      id: 'mixed-bound-identity',
      accountId: boundAccount.id,
      issuer,
      subject,
      createdAt: state.now,
    };
    const identityKey = (i: string, s: string) => `${i}\0${s}`;
    const wrappedPorts: IdentityPorts = {
      ...ports,
      accountIdentities: {
        ...ports.accountIdentities,
        async findByIssuerSubject(i, s) {
          identityLookups += 1;
          return ports.accountIdentities.findByIssuerSubject(i, s);
        },
      },
      accounts: {
        ...ports.accounts,
        async findByEmail(e) {
          if (!injected && identityLookups >= 1 && e === email) {
            injected = true;
            state.accounts.set(holderAccount.id, holderAccount);
            state.profiles.set(holderAccount.id, holderProfile);
            state.identities.set(identityKey(issuer, subject), boundIdentity);
            state.identitiesByAccount.set(boundIdentity.accountId, boundIdentity.id);
          }
          return ports.accounts.findByEmail(e);
        },
      },
    };
    const unitOfWork: IdentityUnitOfWork = {
      execute: async (work) => {
        uowExecutions += 1;
        return work(wrappedPorts);
      },
    };
    const app = buildApiApp({
      config,
      identityUnitOfWork: unitOfWork,
      oidcProvider: createTestOidcProvider(config.oidc, config.oidc.testProviderHmacSecret),
    });
    apps.push(app);

    const loser = await completeOidcLoginViaCallback(
      app, config, state, ports, subject, email,
    );
    assert.equal(loser.statusCode, 303);
    assert.equal(loser.headers.location, '/login?auth=failed');
    // start TX (1) + consume (2) + single issue UoW (3): terminal
    // email_conflict must not trigger the identity_conflict fresh-transaction
    // retry (a retry would add a 4th execution).
    assert.equal(uowExecutions, 3);
    // No provisional account/profile/session from the loser — only the
    // injected foreign holder B and the A binding exist.
    assert.equal(state.accounts.size, 1);
    assert.equal(state.profiles.size, 1);
    assert.equal(state.identities.size, 1);
    assert.equal(state.sessions.size, 0);
    const bound = state.identities.get(identityKey(issuer, subject));
    assert.equal(bound?.accountId, 'mixed-bound-account');
  });

  test('getSession re-issues csrf without rotate below threshold; me and DELETE CSRF/Origin flow', async () => {
    const { app, unitOfWork, config, state } = createHarness();
    apps.push(app);

    const issued = await unitOfWork.execute(async (ports) => {
      const ensured = await ensureAccountFromOidcIdentity(ports, {
        issuer: config.oidc.issuer,
        subject: 'me-user',
        email: 'me@example.test',
        emailVerified: true,
        displayName: 'Me',
        handle: 'meuser',
      });
      return createSession(ports, { accountId: ensured.account.id });
    });

    const sessionsBefore = state.sessions.size;
    const cookie = `${SESSION_COOKIE_NAME}=${encodeURIComponent(issued.rawSessionToken)}`;
    const sessionResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/session',
      headers: { cookie },
    });
    assert.equal(sessionResponse.statusCode, 200);
    const sessionBody = sessionResponse.json() as {
      authenticated: boolean;
      csrfToken: string;
    };
    assert.equal(sessionBody.authenticated, true);
    assert.ok(sessionBody.csrfToken.length >= 16);
    // Below rotation age threshold: no new session row and no Set-Cookie rotation.
    assert.equal(state.sessions.size, sessionsBefore);
    assert.equal(sessionResponse.headers['set-cookie'], undefined);
    const sessionCookie = cookie;

    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { cookie: sessionCookie },
    });
    assert.equal(me.statusCode, 200);
    const meBody = me.json() as {
      account: { email: string | null };
      profile: { handle: string; about: string };
    };
    assert.equal(meBody.account.email, 'me@example.test');
    assert.equal(meBody.profile.handle, 'meuser');
    assert.equal(meBody.profile.about, '');

    const badLogout = await app.inject({
      method: 'DELETE',
      url: '/api/v1/session',
      headers: { cookie: sessionCookie },
    });
    assert.equal(badLogout.statusCode, 403);
    assert.equal((badLogout.json() as { error: { code: string } }).error.code, 'csrf_failed');

    const logout = await app.inject({
      method: 'DELETE',
      url: '/api/v1/session',
      headers: {
        cookie: sessionCookie,
        origin: config.productOrigin,
        'x-csrf-token': sessionBody.csrfToken,
      },
    });
    assert.equal(logout.statusCode, 204);

    const logout2 = await app.inject({
      method: 'DELETE',
      url: '/api/v1/session',
      headers: {
        cookie: sessionCookie,
        origin: config.productOrigin,
        'x-csrf-token': sessionBody.csrfToken,
      },
    });
    assert.equal(logout2.statusCode, 204);
  });

  test('GET me fails closed when the persisted OIDC handle invariant is broken', async () => {
    const { app, unitOfWork, config, state } = createHarness();
    apps.push(app);
    const issued = await unitOfWork.execute(async (ports) => {
      const ensured = await ensureAccountFromOidcIdentity(ports, {
        issuer: config.oidc.issuer, subject: 'broken-handle-user', displayName: 'Broken Handle',
      });
      state.handles.clear();
      return createSession(ports, { accountId: ensured.account.id });
    });
    const response = await app.inject({
      method: 'GET', url: '/api/v1/me',
      headers: { cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(issued.rawSessionToken)}` },
    });
    assert.equal(response.statusCode, 503);
    assert.equal((response.json() as { error: { code: string } }).error.code, 'feature_temporarily_unavailable');
  });

  test('PATCH me enforces CSRF and updates the stored handle/displayName with field errors', async () => {
    const { app, unitOfWork, config, state } = createHarness();
    apps.push(app);
    let accountId = '';
    const issued = await unitOfWork.execute(async (ports) => {
      const ensured = await ensureAccountFromOidcIdentity(ports, {
        issuer: config.oidc.issuer, subject: 'settings-user', displayName: 'Before', handle: 'before_user',
      });
      accountId = ensured.account.id;
      return createSession(ports, { accountId: ensured.account.id });
    });
    const cookie = `${SESSION_COOKIE_NAME}=${encodeURIComponent(issued.rawSessionToken)}`;
    const sessionHeaders = {
      cookie,
      origin: config.productOrigin,
      'x-csrf-token': issued.rawCsrfToken,
      'content-type': 'application/json',
    };
    const patchHeaders = () => ({ ...sessionHeaders, 'known-command-id': freshCommandId() });

    const csrf = await app.inject({
      method: 'PATCH', url: '/api/v1/me',
      headers: {
        cookie,
        'x-csrf-token': issued.rawCsrfToken,
        'known-command-id': freshCommandId(),
        'content-type': 'application/json',
      },
      payload: { handle: 'after_user', displayName: 'After' },
    });
    assert.equal(csrf.statusCode, 403);
    assert.equal((csrf.json() as { error: { code: string } }).error.code, 'csrf_failed');

    const invalid = await app.inject({ method: 'PATCH', url: '/api/v1/me', headers: patchHeaders(), payload: { handle: null, displayName: 'After' } });
    assert.equal(invalid.statusCode, 422);
    const invalidBody = invalid.json() as { error: { code: string; fieldErrors: Array<{ path: string }> } };
    assert.equal(invalidBody.error.code, 'invalid_handle');
    assert.deepEqual(invalidBody.error.fieldErrors.map(({ path }) => path), ['/handle']);

    await unitOfWork.execute(async (ports) => {
      await ensureAccountFromOidcIdentity(ports, {
        issuer: config.oidc.issuer, subject: 'settings-handle-owner', handle: 'claimed_elsewhere',
      });
    });
    const conflict = await app.inject({ method: 'PATCH', url: '/api/v1/me', headers: patchHeaders(), payload: { handle: 'claimed_elsewhere', displayName: 'After' } });
    assert.equal(conflict.statusCode, 409);
    assert.equal((conflict.json() as { error: { code: string } }).error.code, 'handle_taken');

    const updated = await app.inject({ method: 'PATCH', url: '/api/v1/me', headers: patchHeaders(), payload: { handle: 'After_User', displayName: 'After' } });
    assert.equal(updated.statusCode, 200);
    const body = updated.json() as { profile: { handle: string; displayName: string } };
    assert.equal(body.profile.handle, 'after_user');
    assert.equal(body.profile.displayName, 'After');

    const idempotent = await app.inject({ method: 'PATCH', url: '/api/v1/me', headers: patchHeaders(), payload: { handle: 'after_user', displayName: 'After' } });
    assert.equal(idempotent.statusCode, 200);
    assert.equal((idempotent.json() as { profile: { handle: string } }).profile.handle, 'after_user');

    const withAvatar = await app.inject({ method: 'PATCH', url: '/api/v1/me', headers: patchHeaders(), payload: { handle: 'after_user', displayName: 'After', avatarUrl: 'https://app.example.test/api/v1/avatar/123e4567-e89b-42d3-a456-426614174000' } });
    assert.equal(withAvatar.statusCode, 200);
    assert.equal((withAvatar.json() as { profile: { avatarUrl: string | null } }).profile.avatarUrl, 'https://app.example.test/api/v1/avatar/123e4567-e89b-42d3-a456-426614174000');

    const invalidAvatar = await app.inject({ method: 'PATCH', url: '/api/v1/me', headers: patchHeaders(), payload: { handle: 'after_user', displayName: 'After', avatarUrl: 'javascript:alert(1)' } });
    assert.equal(invalidAvatar.statusCode, 400);
    assert.equal((invalidAvatar.json() as { error: { code: string } }).error.code, 'invalid_request');

    const clearAvatar = await app.inject({ method: 'PATCH', url: '/api/v1/me', headers: patchHeaders(), payload: { handle: 'after_user', displayName: 'After', avatarUrl: null } });
    assert.equal(clearAvatar.statusCode, 200);
    assert.equal((clearAvatar.json() as { profile: { avatarUrl: string | null } }).profile.avatarUrl, null);

    const withAbout = await app.inject({ method: 'PATCH', url: '/api/v1/me', headers: patchHeaders(), payload: { handle: 'after_user', displayName: 'After', about: 'I collect bookmarks.' } });
    assert.equal(withAbout.statusCode, 200);
    assert.equal((withAbout.json() as { profile: { about: string } }).profile.about, 'I collect bookmarks.');

    const omitAbout = await app.inject({ method: 'PATCH', url: '/api/v1/me', headers: patchHeaders(), payload: { handle: 'after_user', displayName: 'After' } });
    assert.equal(omitAbout.statusCode, 200);
    assert.equal((omitAbout.json() as { profile: { about: string } }).profile.about, 'I collect bookmarks.');

    const whitespaceAbout = await app.inject({ method: 'PATCH', url: '/api/v1/me', headers: patchHeaders(), payload: { handle: 'after_user', displayName: 'After', about: '   ' } });
    assert.equal(whitespaceAbout.statusCode, 422);
    assert.equal((whitespaceAbout.json() as { error: { code: string } }).error.code, 'invalid_about');

    const clearAbout = await app.inject({ method: 'PATCH', url: '/api/v1/me', headers: patchHeaders(), payload: { handle: 'after_user', displayName: 'After', about: null } });
    assert.equal(clearAbout.statusCode, 200);
    assert.equal((clearAbout.json() as { profile: { about: string } }).profile.about, '');

    const emptyAbout = await app.inject({ method: 'PATCH', url: '/api/v1/me', headers: patchHeaders(), payload: { handle: 'after_user', displayName: 'After', about: '' } });
    assert.equal(emptyAbout.statusCode, 200);
    assert.equal((emptyAbout.json() as { profile: { about: string } }).profile.about, '');

    const typedAbout = await app.inject({ method: 'PATCH', url: '/api/v1/me', headers: patchHeaders(), payload: { handle: 'after_user', displayName: 'After', about: 12 } });
    assert.equal(typedAbout.statusCode, 400);
    assert.equal((typedAbout.json() as { error: { code: string } }).error.code, 'invalid_request');

    const maxAbout = await app.inject({ method: 'PATCH', url: '/api/v1/me', headers: patchHeaders(), payload: { handle: 'after_user', displayName: 'After', about: 'x'.repeat(ABOUT_MAX) } });
    assert.equal(maxAbout.statusCode, 200);
    assert.equal((maxAbout.json() as { profile: { about: string } }).profile.about.length, ABOUT_MAX);

    const overlongAbout = await app.inject({ method: 'PATCH', url: '/api/v1/me', headers: patchHeaders(), payload: { handle: 'after_user', displayName: 'After', about: 'x'.repeat(ABOUT_MAX + 1) } });
    assert.equal(overlongAbout.statusCode, 422);
    assert.equal((overlongAbout.json() as { error: { code: string } }).error.code, 'invalid_about');
    assert.equal(state.profiles.get(accountId)?.about.length, ABOUT_MAX);
  });

  test('PATCH me omitting avatarUrl preserves the stored avatar', async () => {
    const { app, unitOfWork, config, state } = createHarness();
    apps.push(app);
    let accountId = '';
    const issued = await unitOfWork.execute(async (ports) => {
      const ensured = await ensureAccountFromOidcIdentity(ports, {
        issuer: config.oidc.issuer, subject: 'avatar-preserve-user', displayName: 'Avatar Preserve', handle: 'avatar_preserve',
      });
      accountId = ensured.account.id;
      return createSession(ports, { accountId: ensured.account.id });
    });
    const cookie = `${SESSION_COOKIE_NAME}=${encodeURIComponent(issued.rawSessionToken)}`;
    const sessionHeaders = {
      cookie,
      origin: config.productOrigin,
      'x-csrf-token': issued.rawCsrfToken,
      'content-type': 'application/json',
    };
    const patchHeaders = () => ({ ...sessionHeaders, 'known-command-id': freshCommandId() });

    const setAvatar = await app.inject({ method: 'PATCH', url: '/api/v1/me', headers: patchHeaders(), payload: { handle: 'avatar_preserve', displayName: 'Avatar Preserve', avatarUrl: 'https://app.example.test/api/v1/avatar/123e4567-e89b-42d3-a456-426614174000' } });
    assert.equal(setAvatar.statusCode, 200);
    assert.equal((setAvatar.json() as { profile: { avatarUrl: string | null } }).profile.avatarUrl, 'https://app.example.test/api/v1/avatar/123e4567-e89b-42d3-a456-426614174000');

    // Body deliberately omits avatarUrl: only handle/displayName are sent.
    const omitAvatar = await app.inject({ method: 'PATCH', url: '/api/v1/me', headers: patchHeaders(), payload: { handle: 'avatar_preserve', displayName: 'Avatar Preserve Updated' } });
    assert.equal(omitAvatar.statusCode, 200);
    const omitted = omitAvatar.json() as { profile: { avatarUrl: string | null; displayName: string } };
    // displayName changing proves the request was processed, not silently ignored.
    assert.equal(omitted.profile.displayName, 'Avatar Preserve Updated');
    assert.equal(omitted.profile.avatarUrl, 'https://app.example.test/api/v1/avatar/123e4567-e89b-42d3-a456-426614174000');
    // Persisted state must keep the value too, not just the response body.
    const stored = state.profiles.get(accountId);
    assert.equal(stored?.avatarUrl, 'https://app.example.test/api/v1/avatar/123e4567-e89b-42d3-a456-426614174000');
  });

  test('PATCH me rejects non-compliant avatarUrl values with 400 invalid_request and never persists them', async () => {
    const { app, unitOfWork, config, state } = createHarness();
    apps.push(app);
    let accountId = '';
    const issued = await unitOfWork.execute(async (ports) => {
      const ensured = await ensureAccountFromOidcIdentity(ports, {
        issuer: config.oidc.issuer, subject: 'avatar-shape-user', displayName: 'Avatar Shape', handle: 'avatar_shape',
      });
      accountId = ensured.account.id;
      return createSession(ports, { accountId: ensured.account.id });
    });
    const cookie = `${SESSION_COOKIE_NAME}=${encodeURIComponent(issued.rawSessionToken)}`;
    const sessionHeaders = {
      cookie,
      origin: config.productOrigin,
      'x-csrf-token': issued.rawCsrfToken,
      'content-type': 'application/json',
    };
    const patchHeaders = () => ({ ...sessionHeaders, 'known-command-id': freshCommandId() });
    const describeUrl = (value: string): string =>
      value.length > 60 ? `${JSON.stringify(value.slice(0, 60))}…` : JSON.stringify(value);

    // Control group: a same-origin /api/v1/avatar/<uuid> URL is accepted and
    // stored, proving the 400s below come from avatarUrl validation and not
    // from a broken request (CSRF/Origin/body parsing). The 2048-character
    // canonical boundary stays covered at the domain level
    // (identity-avatar-url.test.ts): a compliant same-origin avatar path is
    // fixed-length (origin + /api/v1/avatar/<uuid>), so no such URL can reach
    // the 2048 limit and the transport can no longer exercise that boundary.
    const sameOriginAvatarUrl = 'https://app.example.test/api/v1/avatar/123e4567-e89b-42d3-a456-426614174000';
    const control = await app.inject({
      method: 'PATCH', url: '/api/v1/me', headers: patchHeaders(),
      payload: { handle: 'avatar_shape', displayName: 'Avatar Shape', avatarUrl: sameOriginAvatarUrl },
    });
    assert.equal(control.statusCode, 200, 'expected the same-origin control avatarUrl to be accepted');
    assert.equal((control.json() as { profile: { avatarUrl: string | null } }).profile.avatarUrl, sameOriginAvatarUrl);
    const storedAvatarUrl = state.profiles.get(accountId)?.avatarUrl;
    assert.equal(storedAvatarUrl, sameOriginAvatarUrl);

    const invalidAvatarUrls = [
      // External https URLs are never accepted as manually set avatars (S8):
      // rendering them in other users' browsers would leak visitor IPs to the
      // foreign host.
      'https://cdn.example.test/ok.png',
      'https://cdn.example.test/avatar.png',
      'https://gravatar.com/x.png',
      // Plain http is not https.
      'http://cdn.example.test/a.png',
      // userinfo in plain and percent-encoded form.
      'https://user:pass@cdn.example.test/a.png',
      'https://user@cdn.example.test/a.png',
      'https://user%40name@cdn.example.test/a.png',
      // An explicit non-default port; only the default 443 normalizes away.
      'https://cdn.example.test:8443/a.png',
      // Fragments are rejected even when empty.
      'https://cdn.example.test/a.png#fragment',
      'https://cdn.example.test/a.png#',
      // Non-image scheme.
      'data:text/html;base64,PHNjcmlwdD4=',
      // Canonical form exceeds 2048 characters after percent-encoding while the
      // raw body stays within the 1024-byte transport budget, so the URL
      // validator must be the one rejecting it.
      `https://cdn.example.test/${'头'.repeat(240)}`,
      // Same-origin but not an avatar object path.
      'https://app.example.test/api/v1/me',
      'https://app.example.test/avatar/123e4567-e89b-42d3-a456-426614174000',
      // Same-origin avatar path with a non-UUID tail.
      'https://app.example.test/api/v1/avatar/not-a-uuid',
      // Same-origin host but a different protocol or port.
      'http://app.example.test/api/v1/avatar/123e4567-e89b-42d3-a456-426614174000',
      'https://app.example.test:8443/api/v1/avatar/123e4567-e89b-42d3-a456-426614174000',
    ];

    for (const avatarUrl of invalidAvatarUrls) {
      const response = await app.inject({
        method: 'PATCH', url: '/api/v1/me', headers: patchHeaders(),
        payload: { handle: 'avatar_shape', displayName: 'Avatar Shape', avatarUrl },
      });
      assert.equal(response.statusCode, 400, `expected 400 for avatarUrl ${describeUrl(avatarUrl)}`);
      const errorBody = response.json() as { error: { code: string; fieldErrors?: Array<{ path: string }> } };
      assert.equal(errorBody.error.code, 'invalid_request', `expected invalid_request for ${describeUrl(avatarUrl)}`);
      assert.ok(
        errorBody.error.fieldErrors?.some(({ path }) => path === '/avatarUrl'),
        `expected an /avatarUrl field error for ${describeUrl(avatarUrl)}`,
      );
      // A rejected request must not mutate the stored profile avatar.
      assert.equal(
        state.profiles.get(accountId)?.avatarUrl,
        storedAvatarUrl,
        `stored avatarUrl must stay unchanged after rejecting ${describeUrl(avatarUrl)}`,
      );
    }

    // An ASCII URL beyond 2048 characters now fits the PATCH /me body budget
    // (4096 bytes, raised so an ABOUT_MAX-character about can round-trip) and is
    // rejected by avatarUrl validation as 400 invalid_request. Bodies over
    // 4096 bytes still fail closed at the transport limit.
    const asciiOverLimitUrl = `https://cdn.example.test/${'a'.repeat(2049)}`;
    const overLimitUrl = await app.inject({
      method: 'PATCH', url: '/api/v1/me', headers: patchHeaders(),
      payload: { handle: 'avatar_shape', displayName: 'Avatar Shape', avatarUrl: asciiOverLimitUrl },
    });
    assert.equal(overLimitUrl.statusCode, 400);
    assert.equal((overLimitUrl.json() as { error: { code: string } }).error.code, 'invalid_request');
    assert.equal(state.profiles.get(accountId)?.avatarUrl, storedAvatarUrl);

    const overLimitBody = await app.inject({
      method: 'PATCH', url: '/api/v1/me', headers: patchHeaders(),
      payload: { handle: 'avatar_shape', displayName: 'Avatar Shape', about: 'x'.repeat(4500) },
    });
    assert.equal(overLimitBody.statusCode, 413);
    assert.equal((overLimitBody.json() as { error: { code: string } }).error.code, 'payload_too_large');
    assert.equal(state.profiles.get(accountId)?.avatarUrl, storedAvatarUrl);
  });

  test('PATCH me round-trips the same-origin avatarUrl produced by an upload', async () => {
    // S8 regression: the upload flow mints a same-origin /api/v1/avatar/<uuid>
    // URL; the manual PATCH /me path must accept that exact URL back so an
    // uploaded avatar is never rejected by the same-origin policy.
    const avatarStore = createMemoryAvatarStore();
    const { app, unitOfWork, config, state } = createHarness(avatarStore);
    apps.push(app);
    let accountId = '';
    const issued = await unitOfWork.execute(async (ports) => {
      const ensured = await ensureAccountFromOidcIdentity(ports, {
        issuer: config.oidc.issuer, subject: 'avatar-roundtrip', displayName: 'Avatar Roundtrip', handle: 'avatar_roundtrip',
      });
      accountId = ensured.account.id;
      return createSession(ports, { accountId: ensured.account.id });
    });
    const cookie = `${SESSION_COOKIE_NAME}=${encodeURIComponent(issued.rawSessionToken)}`;
    const png = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000182e403790000000049454e44ae426082',
      'hex',
    );
    const upload = await app.inject({
      method: 'POST', url: '/api/v1/me/avatar',
      headers: {
        cookie,
        origin: config.productOrigin,
        'x-csrf-token': issued.rawCsrfToken,
        'known-command-id': '123e4567-e89b-42d3-a456-426614174000',
        'content-type': 'image/png',
      },
      payload: png,
    });
    assert.equal(upload.statusCode, 200);
    const uploadedUrl = (upload.json() as { profile: { avatarUrl: string } }).profile.avatarUrl;
    assert.match(uploadedUrl, /^https:\/\/app\.example\.test\/api\/v1\/avatar\/[a-f0-9-]{36}$/u);

    const patch = await app.inject({
      method: 'PATCH', url: '/api/v1/me',
      headers: {
        cookie,
        origin: config.productOrigin,
        'x-csrf-token': issued.rawCsrfToken,
        'known-command-id': '223e4567-e89b-42d3-a456-426614174001',
        'content-type': 'application/json',
      },
      payload: { handle: 'avatar_roundtrip', displayName: 'Avatar Roundtrip', avatarUrl: uploadedUrl },
    });
    assert.equal(patch.statusCode, 200);
    assert.equal((patch.json() as { profile: { avatarUrl: string } }).profile.avatarUrl, uploadedUrl);
    assert.equal(state.profiles.get(accountId)?.avatarUrl, uploadedUrl);
  });

  test('PATCH me replays the same Command-Id and body as byte-identical 200 without a second write', async () => {
    const { app, unitOfWork, config, state } = createHarness();
    apps.push(app);
    let accountId = '';
    const issued = await unitOfWork.execute(async (ports) => {
      const ensured = await ensureAccountFromOidcIdentity(ports, {
        issuer: config.oidc.issuer, subject: 'me-receipt-replay', displayName: 'Before', handle: 'me_replay',
      });
      accountId = ensured.account.id;
      return createSession(ports, { accountId: ensured.account.id });
    });
    const cookie = `${SESSION_COOKIE_NAME}=${encodeURIComponent(issued.rawSessionToken)}`;
    const commandId = freshCommandId();
    const headers = {
      cookie,
      origin: config.productOrigin,
      'x-csrf-token': issued.rawCsrfToken,
      'known-command-id': commandId,
      'content-type': 'application/json',
    };
    const payload = { handle: 'me_replay_after', displayName: 'After Replay' };

    const first = await app.inject({ method: 'PATCH', url: '/api/v1/me', headers, payload });
    assert.equal(first.statusCode, 200);
    const firstUpdatedAt = state.profiles.get(accountId)?.updatedAt;
    assert.ok(firstUpdatedAt);

    const replay = await app.inject({ method: 'PATCH', url: '/api/v1/me', headers, payload });
    assert.equal(replay.statusCode, 200);
    assert.deepEqual(replay.rawPayload, first.rawPayload, 'the replay must return the identical response bytes');
    assert.equal(state.profiles.get(accountId)?.updatedAt, firstUpdatedAt, 'replay must not mutate the profile again');
    assert.equal((replay.json() as { profile: { handle: string } }).profile.handle, 'me_replay_after');

    const reversedKeys = await app.inject({
      method: 'PATCH', url: '/api/v1/me', headers,
      payload: '{"displayName":"After Replay","handle":"me_replay_after"}',
    });
    assert.equal(reversedKeys.statusCode, 200);
    assert.deepEqual(reversedKeys.rawPayload, first.rawPayload, 'canonical JSON key order must not change the fingerprint');
  });

  test('PATCH me with the same Command-Id and a different body is command_id_reused and does not overwrite', async () => {
    const { app, unitOfWork, config, state } = createHarness();
    apps.push(app);
    let accountId = '';
    const issued = await unitOfWork.execute(async (ports) => {
      const ensured = await ensureAccountFromOidcIdentity(ports, {
        issuer: config.oidc.issuer, subject: 'me-receipt-reuse', displayName: 'First', handle: 'me_reuse_first',
      });
      accountId = ensured.account.id;
      return createSession(ports, { accountId: ensured.account.id });
    });
    const cookie = `${SESSION_COOKIE_NAME}=${encodeURIComponent(issued.rawSessionToken)}`;
    const headers = {
      cookie,
      origin: config.productOrigin,
      'x-csrf-token': issued.rawCsrfToken,
      'known-command-id': freshCommandId(),
      'content-type': 'application/json',
    };

    const first = await app.inject({
      method: 'PATCH', url: '/api/v1/me', headers,
      payload: { handle: 'me_reuse_first', displayName: 'First Name' },
    });
    assert.equal(first.statusCode, 200);
    assert.equal((first.json() as { profile: { displayName: string } }).profile.displayName, 'First Name');

    const reused = await app.inject({
      method: 'PATCH', url: '/api/v1/me', headers,
      payload: { handle: 'me_reuse_second', displayName: 'Second Name' },
    });
    assert.equal(reused.statusCode, 409);
    assert.equal((reused.json() as { error: { code: string } }).error.code, 'command_id_reused');
    assert.equal(state.profiles.get(accountId)?.displayName, 'First Name');
    assert.equal(state.handles.get('me_reuse_first')?.accountId, accountId);
    assert.equal(state.handles.has('me_reuse_second'), false);
  });

  test('PATCH me with a different Command-Id applies a second profile update', async () => {
    const { app, unitOfWork, config, state } = createHarness();
    apps.push(app);
    let accountId = '';
    const issued = await unitOfWork.execute(async (ports) => {
      const ensured = await ensureAccountFromOidcIdentity(ports, {
        issuer: config.oidc.issuer, subject: 'me-receipt-fresh', displayName: 'First', handle: 'me_fresh_first',
      });
      accountId = ensured.account.id;
      return createSession(ports, { accountId: ensured.account.id });
    });
    const cookie = `${SESSION_COOKIE_NAME}=${encodeURIComponent(issued.rawSessionToken)}`;
    const sessionHeaders = {
      cookie,
      origin: config.productOrigin,
      'x-csrf-token': issued.rawCsrfToken,
      'content-type': 'application/json',
    };

    const first = await app.inject({
      method: 'PATCH', url: '/api/v1/me',
      headers: { ...sessionHeaders, 'known-command-id': freshCommandId() },
      payload: { handle: 'me_fresh_first', displayName: 'First Name' },
    });
    assert.equal(first.statusCode, 200);

    const second = await app.inject({
      method: 'PATCH', url: '/api/v1/me',
      headers: { ...sessionHeaders, 'known-command-id': freshCommandId() },
      payload: { handle: 'me_fresh_second', displayName: 'Second Name' },
    });
    assert.equal(second.statusCode, 200);
    assert.equal((second.json() as { profile: { handle: string; displayName: string } }).profile.handle, 'me_fresh_second');
    assert.equal((second.json() as { profile: { displayName: string } }).profile.displayName, 'Second Name');
    assert.equal(state.profiles.get(accountId)?.displayName, 'Second Name');
    assert.equal(state.handles.has('me_fresh_first'), false);
    assert.equal(state.handles.get('me_fresh_second')?.accountId, accountId);
  });

  test('PATCH me still requires a canonical Known-Command-Id', async () => {
    const { app, unitOfWork, config } = createHarness();
    apps.push(app);
    const issued = await unitOfWork.execute(async (ports) => {
      const ensured = await ensureAccountFromOidcIdentity(ports, {
        issuer: config.oidc.issuer, subject: 'me-receipt-command-id', displayName: 'Cmd', handle: 'me_cmd',
      });
      return createSession(ports, { accountId: ensured.account.id });
    });
    const cookie = `${SESSION_COOKIE_NAME}=${encodeURIComponent(issued.rawSessionToken)}`;
    const sessionHeaders = {
      cookie,
      origin: config.productOrigin,
      'x-csrf-token': issued.rawCsrfToken,
      'content-type': 'application/json',
    };
    const payload = { handle: 'me_cmd', displayName: 'Cmd' };

    const missing = await app.inject({ method: 'PATCH', url: '/api/v1/me', headers: sessionHeaders, payload });
    assert.equal(missing.statusCode, 400);
    assert.equal((missing.json() as { error: { code: string } }).error.code, 'invalid_request');

    const malformed = await app.inject({
      method: 'PATCH', url: '/api/v1/me',
      headers: { ...sessionHeaders, 'known-command-id': 'not-a-uuid' },
      payload,
    });
    assert.equal(malformed.statusCode, 400);
    assert.equal((malformed.json() as { error: { code: string } }).error.code, 'invalid_request');

    const uppercase = await app.inject({
      method: 'PATCH', url: '/api/v1/me',
      headers: { ...sessionHeaders, 'known-command-id': '123E4567-E89B-42D3-A456-426614174000' },
      payload,
    });
    assert.equal(uppercase.statusCode, 400);
    assert.equal((uppercase.json() as { error: { code: string } }).error.code, 'invalid_request');
  });

  test('PATCH me returns 409 command_in_progress for a claimed-but-incomplete receipt', async () => {
    const { app, unitOfWork, config, state } = createHarness();
    apps.push(app);
    let accountId = '';
    const issued = await unitOfWork.execute(async (ports) => {
      const ensured = await ensureAccountFromOidcIdentity(ports, {
        issuer: config.oidc.issuer, subject: 'me-receipt-inflight', displayName: 'Inflight', handle: 'me_inflight',
      });
      accountId = ensured.account.id;
      return createSession(ports, { accountId: ensured.account.id });
    });
    const cookie = `${SESSION_COOKIE_NAME}=${encodeURIComponent(issued.rawSessionToken)}`;
    const commandId = freshCommandId();
    const payload = { handle: 'me_inflight', displayName: 'Should Not Apply' };
    const fingerprint = profileSettingsCommandFingerprint(payload);
    state.receipts.set(
      productCommandReceiptKey({ principalId: accountId, commandScope: PROFILE_SETTINGS_COMMAND_SCOPE, commandId }),
      { fingerprint, status: 'in_progress' },
    );

    const response = await app.inject({
      method: 'PATCH', url: '/api/v1/me',
      headers: {
        cookie,
        origin: config.productOrigin,
        'x-csrf-token': issued.rawCsrfToken,
        'known-command-id': commandId,
        'content-type': 'application/json',
      },
      payload,
    });
    assert.equal(response.statusCode, 409);
    const envelope = response.json() as { error: { code: string; retryAfterSeconds: number | null } };
    assert.equal(envelope.error.code, 'command_in_progress');
    assert.equal(envelope.error.retryAfterSeconds, 1);
    assert.equal(response.headers['retry-after'], '1');
    assert.equal(state.profiles.get(accountId)?.displayName, 'Inflight');
  });

  test('avatar upload requires authentication and CSRF', async () => {
    const { app } = createHarness(createMemoryAvatarStore());
    apps.push(app);

    const anonymous = await app.inject({ method: 'POST', url: '/api/v1/me/avatar', headers: { 'content-type': 'image/png' }, payload: Buffer.from('89504e470d0a1a0a', 'hex') });
    assert.equal(anonymous.statusCode, 401);

    const { app: authedApp, unitOfWork, config } = createHarness(createMemoryAvatarStore());
    apps.push(authedApp);
    const issued = await unitOfWork.execute(async (ports) => {
      const ensured = await ensureAccountFromOidcIdentity(ports, {
        issuer: config.oidc.issuer, subject: 'avatar-csrf', displayName: 'Avatar CSRF', handle: 'avatar_csrf',
      });
      return createSession(ports, { accountId: ensured.account.id });
    });
    const cookie = `${SESSION_COOKIE_NAME}=${encodeURIComponent(issued.rawSessionToken)}`;
    const noCsrf = await authedApp.inject({
      method: 'POST', url: '/api/v1/me/avatar',
      headers: { cookie, 'content-type': 'image/png', 'known-command-id': '123e4567-e89b-42d3-a456-426614174000' },
      payload: Buffer.from('89504e470d0a1a0a', 'hex'),
    });
    assert.equal(noCsrf.statusCode, 403);
    assert.equal((noCsrf.json() as { error: { code: string } }).error.code, 'csrf_failed');
  });

  test('avatar upload fails closed when the session is revoked between authentication and upload (TOCTOU)', async () => {
    // F5 (avatar audit #4): the route authenticates once outside the UoW for
    // Origin/CSRF admission and must re-authenticate inside the upload
    // transaction. This test revokes the session exactly between those two
    // points (a concurrent logout) and asserts the upload is refused: 401,
    // nothing written to the store, profile untouched. Before the fix the
    // upload completed with the stale outer authentication and returned 200.
    const avatarStore = createMemoryAvatarStore();
    const harness = createHarness(avatarStore);
    await harness.app.close();
    const { state, ports, config } = harness;
    let accountId = '';
    const issued = await harness.unitOfWork.execute(async (identityPorts) => {
      const ensured = await ensureAccountFromOidcIdentity(identityPorts, {
        issuer: config.oidc.issuer, subject: 'avatar-toctou', displayName: 'Avatar Toctou', handle: 'avatar_toctou',
      });
      accountId = ensured.account.id;
      return createSession(identityPorts, { accountId: ensured.account.id });
    });

    // The POST handler runs exactly two unitOfWork executions: the outer
    // authentication (used for Origin/CSRF admission) and the upload
    // transaction. Revoke the session at the start of the second execution so
    // the outer authentication and CSRF admission still succeed.
    let executions = 0;
    let revokeFired = false;
    let armed = false;
    const unitOfWork: IdentityUnitOfWork = {
      execute: async (work) => {
        executions += 1;
        if (armed && !revokeFired && executions === 2) {
          revokeFired = true;
          await ports.sessions.revoke(issued.session.id, new Date());
        }
        return work(ports);
      },
    };
    const app = buildApiApp({
      config,
      identityUnitOfWork: unitOfWork,
      oidcProvider: createTestOidcProvider(config.oidc, config.oidc.testProviderHmacSecret),
      avatarStore,
    });
    apps.push(app);

    const cookie = `${SESSION_COOKIE_NAME}=${encodeURIComponent(issued.rawSessionToken)}`;
    const headers = {
      cookie,
      origin: config.productOrigin,
      'x-csrf-token': issued.rawCsrfToken,
      'known-command-id': '123e4567-e89b-42d3-a456-426614174000',
      'content-type': 'image/png',
    };
    const png = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000182e403790000000049454e44ae426082',
      'hex',
    );

    armed = true;
    const revoked = await app.inject({ method: 'POST', url: '/api/v1/me/avatar', headers, payload: png });
    assert.equal(revoked.statusCode, 401);
    assert.equal((revoked.json() as { error: { code: string } }).error.code, 'authentication_required');
    assert.equal(avatarStore.objects.size, 0, 'a revoked session must not write any avatar object');
    assert.equal(state.profiles.get(accountId)?.avatarUrl, null, 'the profile must stay unchanged');

    // Control group: a live session (fresh session for the same account) still
    // uploads 200 — the re-authentication did not break the happy path.
    const fresh = await harness.unitOfWork.execute(async (identityPorts) =>
      createSession(identityPorts, { accountId }));
    const control = await app.inject({
      method: 'POST', url: '/api/v1/me/avatar',
      headers: {
        ...headers,
        cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(fresh.rawSessionToken)}`,
        'x-csrf-token': fresh.rawCsrfToken,
        'known-command-id': '223e4567-e89b-42d3-a456-426614174001',
      },
      payload: png,
    });
    assert.equal(control.statusCode, 200);
    assert.equal(avatarStore.objects.size, 1, 'the live-session control upload must write exactly one object');
    assert.match(
      (control.json() as { profile: { avatarUrl: string } }).profile.avatarUrl,
      /^https:\/\/app\.example\.test\/api\/v1\/avatar\//u,
    );
  });

  test('avatar upload rejects unsupported media and non-image bytes', async () => {
    const { app, unitOfWork, config } = createHarness(createMemoryAvatarStore());
    apps.push(app);
    const issued = await unitOfWork.execute(async (ports) => {
      const ensured = await ensureAccountFromOidcIdentity(ports, {
        issuer: config.oidc.issuer, subject: 'avatar-invalid', displayName: 'Avatar Invalid', handle: 'avatar_invalid',
      });
      return createSession(ports, { accountId: ensured.account.id });
    });
    const cookie = `${SESSION_COOKIE_NAME}=${encodeURIComponent(issued.rawSessionToken)}`;
    const baseHeaders = {
      cookie,
      origin: config.productOrigin,
      'x-csrf-token': issued.rawCsrfToken,
      'known-command-id': '123e4567-e89b-42d3-a456-426614174000',
    };

    const unsupported = await app.inject({
      method: 'POST', url: '/api/v1/me/avatar',
      headers: { ...baseHeaders, 'content-type': 'text/plain' },
      payload: Buffer.from('not an image'),
    });
    assert.equal(unsupported.statusCode, 415);

    const badMagic = await app.inject({
      method: 'POST', url: '/api/v1/me/avatar',
      headers: { ...baseHeaders, 'content-type': 'image/png' },
      payload: Buffer.from('this is not a png'),
    });
    assert.equal(badMagic.statusCode, 400);
    assert.equal((badMagic.json() as { error: { code: string } }).error.code, 'invalid_request');
  });

  test('avatar upload rejects oversized bodies with 413 payload_too_large and writes nothing to the store', async () => {
    const avatarStore = createMemoryAvatarStore();
    const { app, unitOfWork, config } = createHarness(avatarStore);
    apps.push(app);
    const issued = await unitOfWork.execute(async (ports) => {
      const ensured = await ensureAccountFromOidcIdentity(ports, {
        issuer: config.oidc.issuer, subject: 'avatar-oversize', displayName: 'Avatar Oversize', handle: 'avatar_oversize',
      });
      return createSession(ports, { accountId: ensured.account.id });
    });
    const cookie = `${SESSION_COOKIE_NAME}=${encodeURIComponent(issued.rawSessionToken)}`;
    const oversized = Buffer.alloc(AVATAR_MAX_BYTES + 1);
    // PNG magic prefix: the body is over the limit, so admission must return
    // 413 before any magic-bytes validation runs.
    oversized.write('89504e470d0a1a0a', 0, 'hex');
    const response = await app.inject({
      method: 'POST', url: '/api/v1/me/avatar',
      headers: {
        cookie,
        origin: config.productOrigin,
        'x-csrf-token': issued.rawCsrfToken,
        'known-command-id': '123e4567-e89b-42d3-a456-426614174000',
        'content-type': 'image/png',
      },
      payload: oversized,
    });
    assert.equal(response.statusCode, 413);
    assert.equal((response.json() as { error: { code: string } }).error.code, 'payload_too_large');
    assert.equal(avatarStore.objects.size, 0, 'an oversized request must not write any avatar object');
  });

  test('avatar upload does not 413 a body exactly at the byte limit (magic mismatch still 400)', async () => {
    const avatarStore = createMemoryAvatarStore();
    const { app, unitOfWork, config } = createHarness(avatarStore);
    apps.push(app);
    const issued = await unitOfWork.execute(async (ports) => {
      const ensured = await ensureAccountFromOidcIdentity(ports, {
        issuer: config.oidc.issuer, subject: 'avatar-limit', displayName: 'Avatar Limit', handle: 'avatar_limit',
      });
      return createSession(ports, { accountId: ensured.account.id });
    });
    const cookie = `${SESSION_COOKIE_NAME}=${encodeURIComponent(issued.rawSessionToken)}`;
    // Exactly AVATAR_MAX_BYTES of non-image bytes: the byte limit must not
    // reject it (that would be a 413), so the request falls through to
    // magic-bytes validation and fails as a 400 invalid_request instead.
    const atLimit = Buffer.alloc(AVATAR_MAX_BYTES, 0x41);
    const response = await app.inject({
      method: 'POST', url: '/api/v1/me/avatar',
      headers: {
        cookie,
        origin: config.productOrigin,
        'x-csrf-token': issued.rawCsrfToken,
        'known-command-id': '123e4567-e89b-42d3-a456-426614174000',
        'content-type': 'image/png',
      },
      payload: atLimit,
    });
    assert.equal(response.statusCode, 400);
    assert.equal((response.json() as { error: { code: string } }).error.code, 'invalid_request');
    assert.equal(avatarStore.objects.size, 0);
  });

  test('avatar upload persists a real PNG and public GET serves the same bytes', async () => {
    const avatarStore = createMemoryAvatarStore();
    const { app, unitOfWork, config, state } = createHarness(avatarStore);
    apps.push(app);
    let accountId = '';
    const issued = await unitOfWork.execute(async (ports) => {
      const ensured = await ensureAccountFromOidcIdentity(ports, {
        issuer: config.oidc.issuer, subject: 'avatar-upload', displayName: 'Avatar Upload', handle: 'avatar_upload',
      });
      accountId = ensured.account.id;
      return createSession(ports, { accountId: ensured.account.id });
    });
    const cookie = `${SESSION_COOKIE_NAME}=${encodeURIComponent(issued.rawSessionToken)}`;
    const png = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000182e403790000000049454e44ae426082',
      'hex',
    );
    const upload = await app.inject({
      method: 'POST', url: '/api/v1/me/avatar',
      headers: {
        cookie,
        origin: config.productOrigin,
        'x-csrf-token': issued.rawCsrfToken,
        'known-command-id': '123e4567-e89b-42d3-a456-426614174000',
        'content-type': 'image/png',
      },
      payload: png,
    });
    assert.equal(upload.statusCode, 200);
    const me = upload.json() as { profile: { avatarUrl: string } };
    assert.match(me.profile.avatarUrl, /^https:\/\/app\.example\.test\/api\/v1\/avatar\/[a-f0-9-]+$/u);
    const avatarId = me.profile.avatarUrl.split('/').pop()!;
    const stored = avatarStore.objects.get(avatarId);
    assert.ok(stored, 'avatar bytes must be stored in the avatar store');
    assert.equal(stored.contentType, 'image/png');
    assert.deepEqual(stored.body, png);

    const publicGet = await app.inject({ method: 'GET', url: `/api/v1/avatar/${avatarId}` });
    assert.equal(publicGet.statusCode, 200);
    assert.equal(publicGet.headers['content-type'], 'image/png');
    assert.deepEqual(publicGet.rawPayload, png);
    assert.match(String(publicGet.headers['cache-control'] ?? ''), /public/u);

    const profile = state.profiles.get(accountId);
    assert.equal(profile?.avatarUrl, me.profile.avatarUrl);
  });

  test('re-uploading an avatar preserves old bytes until asynchronous GC', async () => {
    const avatarStore = createMemoryAvatarStore();
    const { app, unitOfWork, config } = createHarness(avatarStore);
    apps.push(app);
    const issued = await unitOfWork.execute(async (ports) => {
      const ensured = await ensureAccountFromOidcIdentity(ports, {
        issuer: config.oidc.issuer, subject: 'avatar-replace', displayName: 'Avatar Replace', handle: 'avatar_replace',
      });
      return createSession(ports, { accountId: ensured.account.id });
    });
    const cookie = `${SESSION_COOKIE_NAME}=${encodeURIComponent(issued.rawSessionToken)}`;
    const headers = {
      cookie,
      origin: config.productOrigin,
      'x-csrf-token': issued.rawCsrfToken,
      'known-command-id': '123e4567-e89b-42d3-a456-426614174000',
      'content-type': 'image/png',
    };
    const png = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000182e403790000000049454e44ae426082',
      'hex',
    );

    const firstUpload = await app.inject({ method: 'POST', url: '/api/v1/me/avatar', headers, payload: png });
    assert.equal(firstUpload.statusCode, 200);
    const firstUrl = (firstUpload.json() as { profile: { avatarUrl: string } }).profile.avatarUrl;
    const firstId = firstUrl.split('/').pop()!;
    assert.ok(avatarStore.objects.has(firstId), 'the first upload must be stored');
    assert.deepEqual(avatarStore.deletedIds, [], 'no previous avatar existed yet');

    // A re-upload is a NEW command (fresh command id): it must replace the
    // previous object instead of replaying the first upload's result.
    const secondUpload = await app.inject({
      method: 'POST', url: '/api/v1/me/avatar',
      headers: { ...headers, 'known-command-id': '223e4567-e89b-42d3-a456-426614174001' },
      payload: png,
    });
    assert.equal(secondUpload.statusCode, 200);
    const secondUrl = (secondUpload.json() as { profile: { avatarUrl: string } }).profile.avatarUrl;
    const secondId = secondUrl.split('/').pop()!;
    assert.notEqual(secondId, firstId, 'every upload must mint a fresh object id');

    assert.deepEqual(avatarStore.deletedIds, [], 'profile commands cannot synchronously delete bytes');
    assert.equal(avatarStore.objects.has(firstId), true, 'old bytes await committed-reference GC');
    assert.ok(avatarStore.objects.has(secondId), 'the new object must be stored');

    const oldGet = await app.inject({ method: 'GET', url: `/api/v1/avatar/${firstId}` });
    assert.equal(oldGet.statusCode, 200, 'old bytes remain until the persistent cleanup grace expires');
    const newGet = await app.inject({ method: 'GET', url: `/api/v1/avatar/${secondId}` });
    assert.equal(newGet.statusCode, 200);
    assert.equal(newGet.headers['content-type'], 'image/png');
    assert.deepEqual(newGet.rawPayload, png);
  });

  test('avatar command replay preserves the response and leaves unused preparation for GC', async () => {
    const avatarStore = createMemoryAvatarStore();
    const { app, unitOfWork, config, state } = createHarness(avatarStore);
    apps.push(app);
    let accountId = '';
    const issued = await unitOfWork.execute(async (ports) => {
      const ensured = await ensureAccountFromOidcIdentity(ports, {
        issuer: config.oidc.issuer, subject: 'avatar-idempotent', displayName: 'Avatar Idempotent', handle: 'avatar_idem',
      });
      accountId = ensured.account.id;
      return createSession(ports, { accountId: ensured.account.id });
    });
    const cookie = `${SESSION_COOKIE_NAME}=${encodeURIComponent(issued.rawSessionToken)}`;
    const headers = {
      cookie,
      origin: config.productOrigin,
      'x-csrf-token': issued.rawCsrfToken,
      'known-command-id': '123e4567-e89b-42d3-a456-426614174000',
      'content-type': 'image/png',
    };
    const png = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000182e403790000000049454e44ae426082',
      'hex',
    );

    const first = await app.inject({ method: 'POST', url: '/api/v1/me/avatar', headers, payload: png });
    assert.equal(first.statusCode, 200);
    const firstMe = first.json() as { profile: { avatarUrl: string } };
    assert.equal(avatarStore.objects.size, 1);

    // Retry carries the same command id (frontend mutationCall replay after a
    // lost response while R2 was already written): the server must return the
    // stored result instead of uploading a second object.
    const replay = await app.inject({ method: 'POST', url: '/api/v1/me/avatar', headers, payload: png });
    assert.equal(replay.statusCode, 200);
    assert.deepEqual(replay.json(), firstMe, 'the replay must return the identical me view');
    assert.deepEqual(replay.rawPayload, first.rawPayload, 'the replay must return the identical response bytes');
    assert.equal(avatarStore.objects.size, 2, 'unreferenced replay preparation awaits orphan GC');
    assert.deepEqual(avatarStore.deletedIds, [], 'the replay must not delete anything');
    const storedProfile = state.profiles.get(accountId);
    assert.equal(storedProfile?.avatarUrl, firstMe.profile.avatarUrl, 'the replay must not change the profile');
  });

  test('avatar upload with the same command id but a different image is rejected as command_id_reused', async () => {
    const avatarStore = createMemoryAvatarStore();
    const { app, unitOfWork, config } = createHarness(avatarStore);
    apps.push(app);
    const issued = await unitOfWork.execute(async (ports) => {
      const ensured = await ensureAccountFromOidcIdentity(ports, {
        issuer: config.oidc.issuer, subject: 'avatar-reuse', displayName: 'Avatar Reuse', handle: 'avatar_reuse',
      });
      return createSession(ports, { accountId: ensured.account.id });
    });
    const cookie = `${SESSION_COOKIE_NAME}=${encodeURIComponent(issued.rawSessionToken)}`;
    const baseHeaders = {
      cookie,
      origin: config.productOrigin,
      'x-csrf-token': issued.rawCsrfToken,
      'known-command-id': '123e4567-e89b-42d3-a456-426614174000',
    };
    const png = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000182e403790000000049454e44ae426082',
      'hex',
    );
    const jpeg = Buffer.from('ffd8ffdb004300ffff', 'hex');

    const first = await app.inject({
      method: 'POST', url: '/api/v1/me/avatar',
      headers: { ...baseHeaders, 'content-type': 'image/png' },
      payload: png,
    });
    assert.equal(first.statusCode, 200);
    assert.equal(avatarStore.objects.size, 1);

    const conflict = await app.inject({
      method: 'POST', url: '/api/v1/me/avatar',
      headers: { ...baseHeaders, 'content-type': 'image/jpeg' },
      payload: jpeg,
    });
    assert.equal(conflict.statusCode, 409);
    assert.equal((conflict.json() as { error: { code: string } }).error.code, 'command_id_reused');
    assert.equal(avatarStore.objects.size, 2, 'unused preparation awaits orphan GC');
    assert.deepEqual(avatarStore.deletedIds, [], 'a reused command id must not delete anything');
  });

  test('avatar upload with a different command id is a fresh upload that replaces the previous object', async () => {
    const avatarStore = createMemoryAvatarStore();
    const { app, unitOfWork, config } = createHarness(avatarStore);
    apps.push(app);
    const issued = await unitOfWork.execute(async (ports) => {
      const ensured = await ensureAccountFromOidcIdentity(ports, {
        issuer: config.oidc.issuer, subject: 'avatar-fresh-command', displayName: 'Avatar Fresh', handle: 'avatar_fresh',
      });
      return createSession(ports, { accountId: ensured.account.id });
    });
    const cookie = `${SESSION_COOKIE_NAME}=${encodeURIComponent(issued.rawSessionToken)}`;
    const baseHeaders = {
      cookie,
      origin: config.productOrigin,
      'x-csrf-token': issued.rawCsrfToken,
      'known-command-id': '123e4567-e89b-42d3-a456-426614174000',
      'content-type': 'image/png',
    };
    const png = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000182e403790000000049454e44ae426082',
      'hex',
    );

    const first = await app.inject({ method: 'POST', url: '/api/v1/me/avatar', headers: baseHeaders, payload: png });
    assert.equal(first.statusCode, 200);
    const firstId = (first.json() as { profile: { avatarUrl: string } }).profile.avatarUrl.split('/').pop()!;

    const second = await app.inject({
      method: 'POST', url: '/api/v1/me/avatar',
      headers: { ...baseHeaders, 'known-command-id': '223e4567-e89b-42d3-a456-426614174001' },
      payload: png,
    });
    assert.equal(second.statusCode, 200);
    const secondId = (second.json() as { profile: { avatarUrl: string } }).profile.avatarUrl.split('/').pop()!;
    assert.notEqual(secondId, firstId, 'a fresh command must mint a new object id');
    assert.deepEqual(avatarStore.deletedIds, [], 'GC owns object deletion');
    assert.equal(avatarStore.objects.has(firstId), true);
    assert.ok(avatarStore.objects.has(secondId));
  });

  test('avatar upload returns 429 while the same command is in progress and leaves preparation for GC', async () => {
    const avatarStore = createMemoryAvatarStore();
    const { app, unitOfWork, config, state } = createHarness(avatarStore);
    apps.push(app);
    let accountId = '';
    const issued = await unitOfWork.execute(async (ports) => {
      const ensured = await ensureAccountFromOidcIdentity(ports, {
        issuer: config.oidc.issuer, subject: 'avatar-inflight', displayName: 'Avatar Inflight', handle: 'avatar_inflight',
      });
      accountId = ensured.account.id;
      return createSession(ports, { accountId: ensured.account.id });
    });
    const cookie = `${SESSION_COOKIE_NAME}=${encodeURIComponent(issued.rawSessionToken)}`;
    const commandId = '123e4567-e89b-42d3-a456-426614174000';
    const png = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000182e403790000000049454e44ae426082',
      'hex',
    );
    // Simulate a concurrent first request that claimed the command but has not
    // completed it yet (response in flight / worker still writing). The claim
    // fingerprint must match the one uploadAvatar derives from this request.
    const fingerprint = canonicalCommandFingerprint({
      method: 'POST', route: '/api/v1/me/avatar', mediaType: 'image/png', body: avatarUploadBodyFingerprint(png),
    });
    state.receipts.set(
      productCommandReceiptKey({ principalId: accountId, commandScope: 'avatar:upload', commandId }),
      { fingerprint, status: 'in_progress' },
    );

    const response = await app.inject({
      method: 'POST', url: '/api/v1/me/avatar',
      headers: {
        cookie,
        origin: config.productOrigin,
        'x-csrf-token': issued.rawCsrfToken,
        'known-command-id': commandId,
        'content-type': 'image/png',
      },
      payload: png,
    });
    assert.equal(response.statusCode, 429);
    const envelope = response.json() as { error: { code: string; retryAfterSeconds: number | null } };
    assert.equal(envelope.error.code, 'rate_limited');
    assert.equal(envelope.error.retryAfterSeconds, 1);
    assert.equal(response.headers['retry-after'], '1');
    assert.equal(avatarStore.objects.size, 1, 'in-progress response leaves recoverable preparation');
    assert.deepEqual(avatarStore.deletedIds, []);
  });

  test('avatar upload persists a real JPEG and public GET serves the same bytes', async () => {
    const avatarStore = createMemoryAvatarStore();
    const { app, unitOfWork, config, state } = createHarness(avatarStore);
    apps.push(app);
    let accountId = '';
    const issued = await unitOfWork.execute(async (ports) => {
      const ensured = await ensureAccountFromOidcIdentity(ports, {
        issuer: config.oidc.issuer, subject: 'avatar-jpeg', displayName: 'Avatar JPEG', handle: 'avatar_jpeg',
      });
      accountId = ensured.account.id;
      return createSession(ports, { accountId: ensured.account.id });
    });
    const cookie = `${SESSION_COOKIE_NAME}=${encodeURIComponent(issued.rawSessionToken)}`;
    const jpeg = Buffer.from('ffd8ffdb004300ffff', 'hex');
    const upload = await app.inject({
      method: 'POST', url: '/api/v1/me/avatar',
      headers: {
        cookie,
        origin: config.productOrigin,
        'x-csrf-token': issued.rawCsrfToken,
        'known-command-id': '123e4567-e89b-42d3-a456-426614174000',
        'content-type': 'image/jpeg',
      },
      payload: jpeg,
    });
    assert.equal(upload.statusCode, 200);
    const me = upload.json() as { profile: { avatarUrl: string } };
    assert.match(me.profile.avatarUrl, /^https:\/\/app\.example\.test\/api\/v1\/avatar\/[a-f0-9-]{36}$/u);
    const avatarId = me.profile.avatarUrl.split('/').pop()!;
    const stored = avatarStore.objects.get(avatarId);
    assert.ok(stored, 'avatar bytes must be stored in the avatar store');
    assert.equal(stored.contentType, 'image/jpeg');
    assert.deepEqual(stored.body, jpeg);

    const publicGet = await app.inject({ method: 'GET', url: `/api/v1/avatar/${avatarId}` });
    assert.equal(publicGet.statusCode, 200);
    assert.equal(publicGet.headers['content-type'], 'image/jpeg');
    assert.deepEqual(publicGet.rawPayload, jpeg);
    assert.match(String(publicGet.headers['cache-control'] ?? ''), /public/u);

    const profile = state.profiles.get(accountId);
    assert.equal(profile?.avatarUrl, me.profile.avatarUrl);
  });

  test('avatar upload persists a real WebP and public GET serves the same bytes', async () => {
    const avatarStore = createMemoryAvatarStore();
    const { app, unitOfWork, config, state } = createHarness(avatarStore);
    apps.push(app);
    let accountId = '';
    const issued = await unitOfWork.execute(async (ports) => {
      const ensured = await ensureAccountFromOidcIdentity(ports, {
        issuer: config.oidc.issuer, subject: 'avatar-webp', displayName: 'Avatar WebP', handle: 'avatar_webp',
      });
      accountId = ensured.account.id;
      return createSession(ports, { accountId: ensured.account.id });
    });
    const cookie = `${SESSION_COOKIE_NAME}=${encodeURIComponent(issued.rawSessionToken)}`;
    const webp = Buffer.from('52494646' + '00000000' + '57454250' + '00000000', 'hex');
    const upload = await app.inject({
      method: 'POST', url: '/api/v1/me/avatar',
      headers: {
        cookie,
        origin: config.productOrigin,
        'x-csrf-token': issued.rawCsrfToken,
        'known-command-id': '123e4567-e89b-42d3-a456-426614174000',
        'content-type': 'image/webp',
      },
      payload: webp,
    });
    assert.equal(upload.statusCode, 200);
    const me = upload.json() as { profile: { avatarUrl: string } };
    assert.match(me.profile.avatarUrl, /^https:\/\/app\.example\.test\/api\/v1\/avatar\/[a-f0-9-]{36}$/u);
    const avatarId = me.profile.avatarUrl.split('/').pop()!;
    const stored = avatarStore.objects.get(avatarId);
    assert.ok(stored, 'avatar bytes must be stored in the avatar store');
    assert.equal(stored.contentType, 'image/webp');
    assert.deepEqual(stored.body, webp);

    const publicGet = await app.inject({ method: 'GET', url: `/api/v1/avatar/${avatarId}` });
    assert.equal(publicGet.statusCode, 200);
    assert.equal(publicGet.headers['content-type'], 'image/webp');
    assert.deepEqual(publicGet.rawPayload, webp);
    assert.match(String(publicGet.headers['cache-control'] ?? ''), /public/u);

    const profile = state.profiles.get(accountId);
    assert.equal(profile?.avatarUrl, me.profile.avatarUrl);
  });

  test('avatar routes fail closed when no avatar store is configured', async () => {
    const { app, unitOfWork, config } = createHarness();
    apps.push(app);
    const issued = await unitOfWork.execute(async (ports) => {
      const ensured = await ensureAccountFromOidcIdentity(ports, {
        issuer: config.oidc.issuer, subject: 'avatar-disabled', displayName: 'Avatar Disabled', handle: 'avatar_disabled',
      });
      return createSession(ports, { accountId: ensured.account.id });
    });
    const cookie = `${SESSION_COOKIE_NAME}=${encodeURIComponent(issued.rawSessionToken)}`;
    const upload = await app.inject({
      method: 'POST', url: '/api/v1/me/avatar',
      headers: {
        cookie,
        origin: config.productOrigin,
        'x-csrf-token': issued.rawCsrfToken,
        'known-command-id': '123e4567-e89b-42d3-a456-426614174000',
        'content-type': 'image/png',
      },
      payload: Buffer.from('89504e470d0a1a0a', 'hex'),
    });
    assert.equal(upload.statusCode, 503);
    assert.equal((upload.json() as { error: { code: string } }).error.code, 'feature_temporarily_unavailable');

    const missing = await app.inject({ method: 'GET', url: '/api/v1/avatar/00000000-0000-0000-0000-000000000000' });
    assert.equal(missing.statusCode, 404);
  });

  test('public avatar GET returns 404 for unknown ids', async () => {
    const { app } = createHarness(createMemoryAvatarStore());
    apps.push(app);
    const missing = await app.inject({ method: 'GET', url: '/api/v1/avatar/not-found' });
    assert.equal(missing.statusCode, 404);
  });

  test('public avatar GET returns 404 resource_not_found for a well-formed UUID absent from the store', async () => {
    // Store exists and holds a real object under a different id: the 404 below
    // must come from the store.get miss branch, not from the UUID format gate
    // (the present-object GET proves the format gate is passed and the store is
    // actually consulted).
    const avatarStore = createMemoryAvatarStore();
    const { app } = createHarness(avatarStore);
    apps.push(app);
    const presentId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const presentBody = Buffer.from('89504e470d0a1a0a', 'hex');
    await avatarStore.put(presentId, presentBody, 'image/png');

    const present = await app.inject({ method: 'GET', url: `/api/v1/avatar/${presentId}` });
    assert.equal(present.statusCode, 200);
    assert.equal(present.headers['content-type'], 'image/png');
    assert.deepEqual(present.rawPayload, presentBody);

    const missing = await app.inject({
      method: 'GET',
      url: '/api/v1/avatar/123e4567-e89b-42d3-a456-426614174000',
    });
    assert.equal(missing.statusCode, 404);
    assert.equal((missing.json() as { error: { code: string } }).error.code, 'resource_not_found');
  });

  test('public avatar GET re-validates stored objects and refuses non-image content', async () => {
    // Polluted-store simulation: an object with a non-allowlisted Content-Type
    // lands under the avatar prefix (shared bucket / config overlap, or any
    // other writer). The public GET must not trust the stored Content-Type —
    // a text/html object served same-origin would be executable content
    // (storage XSS), so it must be treated as not found.
    const avatarStore = createMemoryAvatarStore();
    const { app } = createHarness(avatarStore);
    apps.push(app);

    const htmlId = '11111111-2222-3333-4444-555555555555';
    const htmlBody = Buffer.from('<script>alert(1)</script>');
    await avatarStore.put(htmlId, htmlBody, 'text/html');

    const htmlGet = await app.inject({ method: 'GET', url: `/api/v1/avatar/${htmlId}` });
    assert.equal(htmlGet.statusCode, 404, 'a text/html object must never be served as an avatar');
    assert.equal((htmlGet.json() as { error: { code: string } }).error.code, 'resource_not_found');
    assert.notEqual(htmlGet.headers['content-type'], 'text/html', 'the stored content type must never be reflected');

    // Polluted-store simulation: allowlisted Content-Type but body magic bytes
    // do not match (another writer stored garbage under image/png).
    const garbageId = '66666666-7777-8888-9999-000000000000';
    const garbageBody = Buffer.from('not a png');
    await avatarStore.put(garbageId, garbageBody, 'image/png');

    const garbageGet = await app.inject({ method: 'GET', url: `/api/v1/avatar/${garbageId}` });
    assert.equal(garbageGet.statusCode, 404, 'an object whose magic bytes do not match its content type must not be served');
    assert.equal((garbageGet.json() as { error: { code: string } }).error.code, 'resource_not_found');

    // Control group: a legitimate PNG object (valid magic) still serves 200,
    // proving the re-validation does not reject valid avatars.
    const png = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000182e403790000000049454e44ae426082',
      'hex',
    );
    const okId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    await avatarStore.put(okId, png, 'image/png');

    const okGet = await app.inject({ method: 'GET', url: `/api/v1/avatar/${okId}` });
    assert.equal(okGet.statusCode, 200);
    assert.equal(okGet.headers['content-type'], 'image/png');
    assert.deepEqual(okGet.rawPayload, png);
    assert.match(String(okGet.headers['x-content-type-options'] ?? ''), /nosniff/);
    assert.match(String(okGet.headers['cache-control'] ?? ''), /public/u);
  });

  test('callback with wrong iss query fails closed without reflecting evil issuer', async () => {
    const { app, state, config, ports } = createHarness();
    apps.push(app);

    const start = await app.inject({ method: 'GET', url: '/api/v1/auth/oidc/start' });
    const startUrl = new URL(start.headers.location as string);
    const stateParam = startUrl.searchParams.get('state')!;
    const nonce = startUrl.searchParams.get('nonce')!;
    const digest = ports.oidcTransactionSecrets.digestState(stateParam);
    const tx = state.oidc.get(digest)!;
    const codeVerifier = ports.oidcTransactionSecrets.decryptPkceVerifier(
      tx.pkceVerifierCiphertext,
      tx.encryptionKeyId,
      tx.encryptionKeyVersion,
    );
    const code = mintTestAuthorizationCode({
      subject: 'x',
      nonce,
      codeVerifier,
      issuer: config.oidc.issuer,
      audience: config.oidc.audience,
      hmacSecret: config.oidc.testProviderHmacSecret,
    });

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/oidc/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(stateParam)}&iss=${encodeURIComponent('https://evil.example')}`,
      headers: { cookie: cookiePairFromSetCookie(firstSetCookie(start.headers['set-cookie'])) },
    });
    assert.equal(response.statusCode, 303);
    assert.equal(response.headers.location, '/login?auth=failed');
    assert.doesNotMatch(String(response.headers.location), /evil/i);
  });

  test('pkceS256Challenge is base64url S256 and not the secret hash helper', () => {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const challenge = pkceS256Challenge(verifier);
    assert.match(challenge, /^[A-Za-z0-9_-]+$/);
    assert.notEqual(challenge, hashSecret(verifier));
  });

  test('production OIDC callback rejects forged ID token before account/session mutation', async () => {
    const { publicKey } = await generateKeyPair('RS256', { extractable: true });
    const publicJwk = await exportJWK(publicKey) as JWK;
    publicJwk.kid = 'prod-1';
    publicJwk.alg = 'RS256';
    publicJwk.use = 'sig';
    // Sign with a different key so JWKS verification fails.
    const { privateKey: attackerKey } = await generateKeyPair('RS256', { extractable: true });

    const jwksUri = 'https://issuer.example/realms/known/jwks';
    const tokenEndpoint = 'https://issuer.example/realms/known/token';
    const config = loadConfig({
      DATABASE_URL: 'postgres://localhost/known_test',
      PRODUCT_ORIGIN: 'https://app.example.test',
      ALLOWED_ORIGINS: 'https://app.example.test',
      OIDC_ISSUER: 'https://issuer.example/realms/known',
      OIDC_CLIENT_ID: 'known-web',
      OIDC_REDIRECT_URI: 'https://app.example.test/api/v1/auth/oidc/callback',
      OIDC_AUTHORIZATION_ENDPOINT: 'https://issuer.example/realms/known/auth',
      OIDC_TOKEN_ENDPOINT: tokenEndpoint,
      OIDC_JWKS_URI: jwksUri,
      OIDC_ALLOW_TEST_PROVIDER: 'false',
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
    });

    const state: MemoryState = {
      accounts: new Map(),
      profiles: new Map(),
      handles: new Map(),
      identities: new Map(),
      identitiesByAccount: new Map(),
      sessions: new Map(),
      sessionsByTokenHash: new Map(),
      oidc: new Map(),
      receipts: new Map(),
      now: new Date('2026-07-22T12:00:00.000Z'),
    };
    const ports = createMemoryPorts(state);
    let accountInserts = 0;
    let identityInserts = 0;
    let sessionInserts = 0;
    const originalInsertAccount = ports.accounts.insert.bind(ports.accounts);
    const originalInsertIdentity = ports.accountIdentities.insert.bind(ports.accountIdentities);
    const originalInsertIfAbsent = ports.accountIdentities.insertIfAbsent.bind(ports.accountIdentities);
    const originalInsertSession = ports.sessions.insert.bind(ports.sessions);
    ports.accounts.insert = async (account) => {
      accountInserts += 1;
      return originalInsertAccount(account);
    };
    ports.accountIdentities.insert = async (identity) => {
      identityInserts += 1;
      return originalInsertIdentity(identity);
    };
    ports.accountIdentities.insertIfAbsent = async (identity) => {
      identityInserts += 1;
      return originalInsertIfAbsent(identity);
    };
    ports.sessions.insert = async (session) => {
      sessionInserts += 1;
      return originalInsertSession(session);
    };
    const unitOfWork: IdentityUnitOfWork = {
      execute: async (work) => work(ports),
    };

    const holder: { token: string } = { token: '' };
    const nowSec = Math.floor(state.now.getTime() / 1000);
    const oidcProvider = createOidcProvider(config.oidc, {
      fetchImpl: (async (input) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url === jwksUri) {
          return new Response(JSON.stringify({ keys: [publicJwk] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url === tokenEndpoint) {
          return new Response(JSON.stringify({ id_token: holder.token }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }) as typeof fetch,
      now: () => state.now,
    });

    const app = buildApiApp({
      config,
      identityUnitOfWork: unitOfWork,
      oidcProvider,
    });
    apps.push(app);

    const start = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/oidc/start?returnTo=%2Fhome',
    });
    assert.equal(start.statusCode, 302);
    const authUrl = new URL(start.headers.location as string);
    const stateParam = authUrl.searchParams.get('state')!;
    const nonce = authUrl.searchParams.get('nonce')!;

    holder.token = await new SignJWT({
      iss: config.oidc.issuer,
      sub: 'forged-subject',
      aud: config.oidc.audience,
      nonce,
      email: 'forged@example.test',
      email_verified: true,
      name: 'Forged',
      iat: nowSec - 60,
      exp: nowSec + 3_600,
    } as never)
      .setProtectedHeader({ alg: 'RS256', kid: 'prod-1', typ: 'JWT' })
      .sign(attackerKey);

    assert.equal(state.accounts.size, 0);
    assert.equal(state.sessions.size, 0);

    const callback = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/oidc/callback?code=auth-code&state=${encodeURIComponent(stateParam)}`,
      headers: { cookie: cookiePairFromSetCookie(firstSetCookie(start.headers['set-cookie'])) },
    });

    assert.equal(callback.statusCode, 303);
    assert.equal(callback.headers.location, '/login?auth=failed');
    assert.equal(state.accounts.size, 0, 'forged token must not create an account');
    assert.equal(state.sessions.size, 0, 'forged token must not create a session');
    assert.equal(state.identities.size, 0, 'forged token must not create an identity');
    assert.equal(accountInserts, 0);
    assert.equal(identityInserts, 0);
    assert.equal(sessionInserts, 0);
    // Failure path clears any session cookie; must not set a live session token.
    const setCookie = String(callback.headers['set-cookie'] ?? '');
    if (setCookie.includes(SESSION_COOKIE_NAME)) {
      assert.match(setCookie, /Max-Age=0/i);
    }
  });

  test('production OIDC callback accepts valid JWKS-signed ID token and issues session', async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
    const publicJwk = await exportJWK(publicKey) as JWK;
    publicJwk.kid = 'prod-ok';
    publicJwk.alg = 'RS256';
    publicJwk.use = 'sig';

    const jwksUri = 'https://issuer.example/realms/known/jwks';
    const tokenEndpoint = 'https://issuer.example/realms/known/token';
    const config = loadConfig({
      DATABASE_URL: 'postgres://localhost/known_test',
      PRODUCT_ORIGIN: 'https://app.example.test',
      ALLOWED_ORIGINS: 'https://app.example.test',
      OIDC_ISSUER: 'https://issuer.example/realms/known',
      OIDC_CLIENT_ID: 'known-web',
      OIDC_REDIRECT_URI: 'https://app.example.test/api/v1/auth/oidc/callback',
      OIDC_AUTHORIZATION_ENDPOINT: 'https://issuer.example/realms/known/auth',
      OIDC_TOKEN_ENDPOINT: tokenEndpoint,
      OIDC_JWKS_URI: jwksUri,
      OIDC_ALLOW_TEST_PROVIDER: 'false',
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
    });

    const state: MemoryState = {
      accounts: new Map(),
      profiles: new Map(),
      handles: new Map(),
      identities: new Map(),
      identitiesByAccount: new Map(),
      sessions: new Map(),
      sessionsByTokenHash: new Map(),
      oidc: new Map(),
      receipts: new Map(),
      now: new Date('2026-07-22T12:00:00.000Z'),
    };
    const ports = createMemoryPorts(state);
    const unitOfWork: IdentityUnitOfWork = {
      execute: async (work) => work(ports),
    };

    const holder: { token: string } = { token: '' };
    const nowSec = Math.floor(state.now.getTime() / 1000);
    const oidcProvider = createOidcProvider(config.oidc, {
      fetchImpl: (async (input) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url === jwksUri) {
          return new Response(JSON.stringify({ keys: [publicJwk] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url === tokenEndpoint) {
          return new Response(JSON.stringify({ id_token: holder.token }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }) as typeof fetch,
      now: () => state.now,
    });

    const app = buildApiApp({
      config,
      identityUnitOfWork: unitOfWork,
      oidcProvider,
    });
    apps.push(app);

    const start = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/oidc/start?returnTo=%2Fhome',
    });
    assert.equal(start.statusCode, 302);
    const authUrl = new URL(start.headers.location as string);
    const stateParam = authUrl.searchParams.get('state')!;
    const nonce = authUrl.searchParams.get('nonce')!;

    holder.token = await new SignJWT({
      iss: config.oidc.issuer,
      sub: 'verified-subject',
      aud: config.oidc.audience,
      nonce,
      email: 'verified@example.test',
      email_verified: true,
      name: 'Verified User',
      iat: nowSec - 60,
      exp: nowSec + 3_600,
    } as never)
      .setProtectedHeader({ alg: 'RS256', kid: 'prod-ok', typ: 'JWT' })
      .sign(privateKey as KeyLike);

    const callback = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/oidc/callback?code=auth-code&state=${encodeURIComponent(stateParam)}`,
      headers: { cookie: cookiePairFromSetCookie(firstSetCookie(start.headers['set-cookie'])) },
    });

    assert.equal(callback.statusCode, 303);
    assert.equal(callback.headers.location, '/home');
    assert.equal(state.accounts.size, 1);
    assert.equal(state.sessions.size, 1);
    assert.equal(state.identities.size, 1);
    const identity = [...state.identities.values()][0]!;
    assert.equal(identity.subject, 'verified-subject');
    assert.equal(identity.issuer, config.oidc.issuer);
    const account = [...state.accounts.values()][0]!;
    assert.equal(account.email, 'verified@example.test');
    assert.equal(state.handles.size, 1);
    const storedHandle = [...state.handles.values()][0]!;
    assert.equal(storedHandle.accountId, account.id);
    assert.equal(storedHandle.handle.includes('verified-subject'), false);
    assert.equal(storedHandle.handle.includes('verified'), false);
    const cookieHeader = firstSetCookie(callback.headers['set-cookie']);
    assert.match(cookieHeader, new RegExp(SESSION_COOKIE_NAME));
  });

  test('provider success then local DB failure redirects to auth=restart without partial identity', async () => {
    const base = createHarness();
    await base.app.close();

    const state = base.state;
    const ports = createMemoryPorts(state);
    // Snapshot-rollback UoW: partial account/session work must not survive.
    const unitOfWork: IdentityUnitOfWork = {
      execute: async (work) => {
        const snapshot = {
          accounts: new Map(state.accounts),
          profiles: new Map(state.profiles),
          handles: new Map(state.handles),
          identities: new Map(state.identities),
          identitiesByAccount: new Map(state.identitiesByAccount),
          sessions: new Map(state.sessions),
          sessionsByTokenHash: new Map(state.sessionsByTokenHash),
          oidc: new Map(state.oidc),
        };
        try {
          return await work(ports);
        } catch (error: unknown) {
          state.accounts.clear();
          for (const [k, v] of snapshot.accounts) state.accounts.set(k, v);
          state.profiles.clear();
          for (const [k, v] of snapshot.profiles) state.profiles.set(k, v);
          state.handles.clear();
          for (const [k, v] of snapshot.handles) state.handles.set(k, v);
          state.identities.clear();
          for (const [k, v] of snapshot.identities) state.identities.set(k, v);
          state.identitiesByAccount.clear();
          for (const [k, v] of snapshot.identitiesByAccount) state.identitiesByAccount.set(k, v);
          state.sessions.clear();
          for (const [k, v] of snapshot.sessions) state.sessions.set(k, v);
          state.sessionsByTokenHash.clear();
          for (const [k, v] of snapshot.sessionsByTokenHash) state.sessionsByTokenHash.set(k, v);
          state.oidc.clear();
          for (const [k, v] of snapshot.oidc) state.oidc.set(k, v);
          throw error;
        }
      },
    };

    // Fail after ensureAccount wrote provisional rows inside the post-exchange UoW.
    ports.sessions.insert = async () => {
      throw new DatabaseOperationError(
        'database_failure',
        new Error('injected local session failure'),
      );
    };

    const app = buildApiApp({
      config: base.config,
      identityUnitOfWork: unitOfWork,
      oidcProvider: createTestOidcProvider(base.config.oidc, base.config.oidc.testProviderHmacSecret),
    });
    apps.push(app);

    const start = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/oidc/start?returnTo=%2Fhome',
    });
    const authUrl = new URL(start.headers.location as string);
    const stateParam = authUrl.searchParams.get('state')!;
    const nonce = authUrl.searchParams.get('nonce')!;
    const digest = ports.oidcTransactionSecrets.digestState(stateParam);
    const tx = state.oidc.get(digest)!;
    const codeVerifier = ports.oidcTransactionSecrets.decryptPkceVerifier(
      tx.pkceVerifierCiphertext,
      tx.encryptionKeyId,
      tx.encryptionKeyVersion,
    );
    const code = mintTestAuthorizationCode({
      subject: 'local-fail-user',
      nonce,
      codeVerifier,
      email: 'local-fail@example.test',
      name: 'Local Fail',
      issuer: base.config.oidc.issuer,
      audience: base.config.oidc.audience,
      hmacSecret: base.config.oidc.testProviderHmacSecret,
    });

    const callback = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/oidc/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(stateParam)}`,
      headers: { cookie: cookiePairFromSetCookie(firstSetCookie(start.headers['set-cookie'])) },
    });

    assert.equal(callback.statusCode, 303);
    assert.equal(callback.headers.location, '/login?auth=restart');
    assert.doesNotMatch(String(callback.headers.location), /local-fail|code=|state=/i);
    // TX consumed once (separate UoW); account/session rolled back.
    assert.ok(state.oidc.get(digest)?.consumedAt);
    assert.equal(state.accounts.size, 0, 'partial account must not survive');
    assert.equal(state.identities.size, 0, 'partial identity must not survive');
    assert.equal(state.sessions.size, 0, 'partial session must not survive');
    assert.equal(state.profiles.size, 0);
    const setCookie = String(callback.headers['set-cookie'] ?? '');
    if (setCookie.includes(SESSION_COOKIE_NAME)) {
      assert.match(setCookie, /Max-Age=0/i);
    }

    // Replay of the same consumed code/state is terminal (never re-exchange).
    const replay = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/oidc/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(stateParam)}`,
      headers: { cookie: cookiePairFromSetCookie(firstSetCookie(start.headers['set-cookie'])) },
    });
    assert.equal(replay.statusCode, 303);
    assert.equal(replay.headers.location, '/login?auth=failed');
    assert.equal(state.accounts.size, 0);
    assert.equal(state.sessions.size, 0);
  });

  test('retryable pre-exchange token endpoint failure after consume redirects to auth=restart', async () => {
    const harness = createHarness();
    await harness.app.close();
    const { state, ports, config } = harness;
    const unitOfWork: IdentityUnitOfWork = {
      execute: async (work) => work(ports),
    };
    let exchangeCalls = 0;
    const baseProvider = createTestOidcProvider(config.oidc, config.oidc.testProviderHmacSecret);
    const provider = {
      buildAuthorizationUrl: (input: Parameters<typeof baseProvider.buildAuthorizationUrl>[0]) =>
        baseProvider.buildAuthorizationUrl(input),
      async exchangeAuthorizationCode() {
        exchangeCalls += 1;
        throw new OidcExchangeError('token_endpoint_error');
      },
    };

    const app = buildApiApp({
      config,
      identityUnitOfWork: unitOfWork,
      oidcProvider: provider,
    });
    apps.push(app);

    const start = await app.inject({ method: 'GET', url: '/api/v1/auth/oidc/start' });
    const stateParam = new URL(start.headers.location as string).searchParams.get('state')!;
    const digest = ports.oidcTransactionSecrets.digestState(stateParam);

    const callback = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/oidc/callback?code=any-code&state=${encodeURIComponent(stateParam)}`,
      headers: { cookie: cookiePairFromSetCookie(firstSetCookie(start.headers['set-cookie'])) },
    });
    assert.equal(callback.statusCode, 303);
    assert.equal(callback.headers.location, '/login?auth=restart');
    assert.equal(exchangeCalls, 1);
    assert.ok(state.oidc.get(digest)?.consumedAt, 'TX must stay consumed (consume-once)');
    assert.equal(state.accounts.size, 0);
    assert.equal(state.sessions.size, 0);

    // Same state cannot be resurrected.
    const replay = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/oidc/callback?code=any-code&state=${encodeURIComponent(stateParam)}`,
      headers: { cookie: cookiePairFromSetCookie(firstSetCookie(start.headers['set-cookie'])) },
    });
    assert.equal(replay.headers.location, '/login?auth=failed');
    assert.equal(exchangeCalls, 1, 'must not re-exchange after consumed TX');
  });

  test('terminal invalid_grant after consume redirects to auth=failed (not restart loop)', async () => {
    const harness = createHarness();
    await harness.app.close();
    const { state, ports, config } = harness;
    const unitOfWork: IdentityUnitOfWork = {
      execute: async (work) => work(ports),
    };
    const baseProvider = createTestOidcProvider(config.oidc, config.oidc.testProviderHmacSecret);
    const provider = {
      buildAuthorizationUrl: (input: Parameters<typeof baseProvider.buildAuthorizationUrl>[0]) =>
        baseProvider.buildAuthorizationUrl(input),
      async exchangeAuthorizationCode() {
        throw new OidcExchangeError('invalid_grant');
      },
    };
    const app = buildApiApp({
      config,
      identityUnitOfWork: unitOfWork,
      oidcProvider: provider,
    });
    apps.push(app);

    const start = await app.inject({ method: 'GET', url: '/api/v1/auth/oidc/start' });
    const stateParam = new URL(start.headers.location as string).searchParams.get('state')!;

    const callback = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/oidc/callback?code=used-code&state=${encodeURIComponent(stateParam)}`,
      headers: { cookie: cookiePairFromSetCookie(firstSetCookie(start.headers['set-cookie'])) },
    });
    assert.equal(callback.statusCode, 303);
    assert.equal(callback.headers.location, '/login?auth=failed');
    assert.equal(state.accounts.size, 0);
    assert.equal(state.sessions.size, 0);
  });

  test('retryable pre-exchange invalid iss leaves TX unconsumed for a later correct callback', async () => {
    const { app, state, config, ports } = createHarness();
    apps.push(app);

    const start = await app.inject({ method: 'GET', url: '/api/v1/auth/oidc/start' });
    const startUrl = new URL(start.headers.location as string);
    const stateParam = startUrl.searchParams.get('state')!;
    const nonce = startUrl.searchParams.get('nonce')!;
    const digest = ports.oidcTransactionSecrets.digestState(stateParam);
    const tx = state.oidc.get(digest)!;
    assert.equal(tx.consumedAt, null);
    const codeVerifier = ports.oidcTransactionSecrets.decryptPkceVerifier(
      tx.pkceVerifierCiphertext,
      tx.encryptionKeyId,
      tx.encryptionKeyVersion,
    );
    const code = mintTestAuthorizationCode({
      subject: 'iss-retry-user',
      nonce,
      codeVerifier,
      email: 'iss-retry@example.test',
      issuer: config.oidc.issuer,
      audience: config.oidc.audience,
      hmacSecret: config.oidc.testProviderHmacSecret,
    });

    const badIss = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/oidc/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(stateParam)}&iss=${encodeURIComponent('https://evil.example')}`,
      headers: { cookie: cookiePairFromSetCookie(firstSetCookie(start.headers['set-cookie'])) },
    });
    assert.equal(badIss.statusCode, 303);
    assert.equal(badIss.headers.location, '/login?auth=failed');
    assert.equal(state.oidc.get(digest)?.consumedAt, null, 'pre-exchange iss failure must not consume TX');
    assert.equal(state.accounts.size, 0);

    // Correct callback without evil iss can still complete (retryable pre-exchange).
    const ok = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/oidc/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(stateParam)}`,
      headers: { cookie: cookiePairFromSetCookie(firstSetCookie(start.headers['set-cookie'])) },
    });
    assert.equal(ok.statusCode, 303);
    assert.equal(ok.headers.location, '/');
    assert.equal(state.accounts.size, 1);
    assert.equal(state.sessions.size, 1);
    assert.ok(state.oidc.get(digest)?.consumedAt);
  });
});
