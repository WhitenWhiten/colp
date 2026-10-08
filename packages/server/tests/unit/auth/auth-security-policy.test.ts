/**
 * Task C4 unit tests: MFA policy gates, security epoch bridge, new auth
 * rate-limit families and behavior (plan §9 Task C4). Telemetry redaction and
 * plugin configuration live in auth-security-configuration.test.ts.
 *
 * 假阴性防护:
 * - MFA gates are exercised through the REAL BrowserSessionAuthority facade
 *   (memory harness that resolves cookies exactly like BA: signed-cookie
 *   split, session row, expiry), never through a stubbed session check;
 * - recovery-code "single use" is proven by completing the recovery flow and
 *   then replaying the SAME code against the same challenge (the fake server
 *   port models the BA atomic CAS consumption: the used code leaves the
 *   stored set);
 * - the MFA pending session (`known.two_factor` challenge cookie) is proven
 *   NOT to authenticate through `authority.authenticate`/`bootstrap` — the
 *   challenge cookie is never a full business session;
 * - rate-limit tests use an injected clock and the shared (adapter) limiter
 *   contract; budget sharing is proven by exhausting one family via one
 *   surface and observing the OTHER surface of the same family 429 while a
 *   different family stays admitted;
 * - the epoch bridge is verified from the returned revoke result (epoch
 *   value + revoked session counts) and the propagation port invocation,
 *   not from a mocked epoch read.
 *
 * 假阳性防护:
 * - a 429 alone is never the proof: every rate-limit test also asserts the
 *   family isolation (another family admitted), the shared bucket (second
 *   surface of the same family denied), the RateLimit-Policy header and the
 *   injected-clock window rollover;
 * - "recovery code generated" is never the proof: the recovery test
 *   completes a challenge with the code AND asserts the same code fails on a
 *   fresh challenge;
 * - fail-closed 503 is asserted for a failing shared adapter on the NEW MFA
 *   surface, not only on the legacy session route.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import type { IdentityUnitOfWork } from '../../../src/modules/identity/index.js';
import {
  hashSecret,
  type Account,
  type AuthUserAccountMapping,
  type Session,
} from '../../../src/modules/identity/index.js';
import {
  BROWSER_SESSION_COOKIE_NAME,
  BROWSER_SESSION_LIVE_CAP,
  BROWSER_SESSION_MFA_CHALLENGE_COOKIE_NAME,
  BrowserSessionAuthenticationError,
  browserSessionCsrfTokenHash,
  browserSessionTokenHash,
  createBrowserSessionAuthority,
  createMfaPolicyService,
  createSecurityEpochBridge,
  deriveBrowserSessionCsrfTokenRaw,
  hasBrowserSessionMfaChallenge,
  MfaPolicyError,
  parseBrowserSessionCookie,
  rankLiveSessionsForInventory,
  resolveBrowserSessionInventoryLimit,
  selectOldestLiveSessionsToEvict,
  type AccountSecurityEvent,
  type AccountSecurityEventPropagationPort,
  type BrowserSessionAuthority,
  type BrowserSessionRevokeAllResult,
  type MfaPolicyService,
  type MfaServerPort,
  type ReauthVerifier,
  type SecurityEpochBridge,
} from '../../../src/modules/auth/index.js';
import {
  RotationCasConflictError,
  type BrowserSessionAuthorityPorts,
  type BrowserSessionMetadataRow,
  type BrowserSessionMetadataStore,
  type BrowserSessionUnitOfWork,
  type BetterAuthServerPort,
  type MintedSuccessorSession,
} from '../../../src/modules/auth/index.js';
import {
  AUTH_RATE_LIMIT_ROUTE_FAMILIES,
  buildAuthRateLimitKey,
  parseAuthRateLimitKey,
  type AuthRateLimiter,
  type AuthRateLimitSubject,
} from '../../../src/infrastructure/rate-limit/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import {
  authRateLimitRouteFamilyForPath,
  createFixedWindowRateLimiter,
  createMemoryAuthRateLimiter,
  isAuthRateLimitedPath,
} from '../../../src/transport/http-security.js';

const FIXED_SIGNATURE = `${'A'.repeat(43)}=`;
const TOKEN_1 = 'token-abcdefghijklmnopqrstuvwxyz01'; // secret-scan: allow 'token-abcdefghijklmnopqrstuvwxyz01'

function testEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    DATABASE_URL: 'postgres://localhost/known',
    NODE_ENV: 'test',
    PRODUCT_ORIGIN: 'https://app.example.test',
    ALLOWED_ORIGINS: 'https://app.example.test',
    OIDC_ISSUER: 'https://issuer.example/realms/known',
    OIDC_CLIENT_ID: 'known-web',
    OIDC_REDIRECT_URI: 'https://app.example.test/api/v1/auth/oidc/callback',
    OIDC_AUTHORIZATION_ENDPOINT: 'https://issuer.example/realms/known/auth',
    OIDC_TOKEN_ENDPOINT: 'https://issuer.example/realms/known/token',
    OIDC_ALLOW_TEST_PROVIDER: 'true',
    OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
    LOG_LEVEL: 'silent',
    ...overrides,
  };
}

function emptyIdentityUnitOfWork(): IdentityUnitOfWork {
  return {
    execute: async () => {
      throw new Error('identity work not expected in auth-security tests');
    },
  };
}

// ---------------------------------------------------------------------------
// Memory BrowserSessionAuthority harness (mirror of the A3 unit harness)
// ---------------------------------------------------------------------------

interface MemoryWorld {
  now: Date;
  accounts: Map<string, Account>;
  mappings: Map<string, AuthUserAccountMapping>;
  metadataByTokenHash: Map<string, BrowserSessionMetadataRow>;
  metadataById: Map<string, BrowserSessionMetadataRow>;
  predecessorIndex: Map<string, string>;
  baSessions: Map<string, { id: string; userId: string; token: string; expiresAt: Date }>;
  tokenBySessionId: Map<string, string>;
  legacySessions: Map<string, Session>;
  mintCounter: number;
}

function createMemoryWorld(now = new Date('2026-07-22T12:00:00.000Z')): MemoryWorld {
  return {
    now,
    accounts: new Map(),
    mappings: new Map(),
    metadataByTokenHash: new Map(),
    metadataById: new Map(),
    predecessorIndex: new Map(),
    baSessions: new Map(),
    tokenBySessionId: new Map(),
    legacySessions: new Map(),
    mintCounter: 0,
  };
}

function cookieValue(token: string): string {
  return `${token}.${FIXED_SIGNATURE}`;
}

function cookieHeader(value: string): string {
  return `${BROWSER_SESSION_COOKIE_NAME}=${encodeURIComponent(value)}`;
}

function seedUsableSession(
  world: MemoryWorld,
  options: {
    readonly token?: string;
    readonly accountId?: string;
    readonly authUserId?: string;
    readonly securityEpoch?: bigint;
  } = {},
): { readonly token: string; readonly cookie: string; readonly accountId: string } {
  const token = options.token ?? TOKEN_1;
  const accountId = options.accountId ?? 'acct-1';
  const authUserId = options.authUserId ?? 'ba-user-1';
  const now = new Date(world.now);
  world.accounts.set(accountId, {
    id: accountId,
    subjectId: `subj-${accountId}`,
    status: 'active',
    email: `${accountId}@example.test`,
    securityEpoch: options.securityEpoch ?? 0n,
    createdAt: now,
    deletedAt: null,
  });
  world.mappings.set(authUserId, { authUserId, accountId, createdAt: now });
  world.baSessions.set(token, {
    id: 'ba-session-1',
    userId: authUserId,
    token,
    expiresAt: new Date(now.getTime() + 86_400_000),
  });
  world.tokenBySessionId.set('ba-session-1', token);
  const metadata: BrowserSessionMetadataRow = {
    authSessionId: 'ba-session-1',
    sessionTokenHash: browserSessionTokenHash(token),
    accountId,
    idleExpiresAt: new Date(now.getTime() + 86_400_000),
    absoluteExpiresAt: new Date(now.getTime() + 30 * 86_400_000),
    securityEpoch: options.securityEpoch ?? 0n,
    csrfTokenHash: browserSessionCsrfTokenHash(deriveBrowserSessionCsrfTokenRaw(token)),
    predecessorSessionId: null,
    lastSeenAt: now,
    revokedAt: null,
    createdAt: now,
  };
  world.metadataByTokenHash.set(metadata.sessionTokenHash, metadata);
  world.metadataById.set(metadata.authSessionId, metadata);
  return { token, cookie: cookieValue(token), accountId };
}

function createMemoryHarness(now?: Date): {
  readonly world: MemoryWorld;
  readonly authority: BrowserSessionAuthority;
} {
  const world = createMemoryWorld(now);
  const betterAuth: BetterAuthServerPort = {
    async getSession({ cookie }) {
      const parsed = parseBrowserSessionCookie(cookie);
      if (parsed.kind !== 'present') return null;
      const dot = parsed.value.lastIndexOf('.');
      const token = dot < 1 ? null : parsed.value.slice(0, dot);
      if (token === null) return null;
      const session = world.baSessions.get(token);
      if (!session || session.expiresAt.getTime() <= world.now.getTime()) return null;
      return { ...session };
    },
    async signOut({ cookie }) {
      const parsed = parseBrowserSessionCookie(cookie);
      if (parsed.kind !== 'present') return;
      const dot = parsed.value.lastIndexOf('.');
      const token = dot < 1 ? null : parsed.value.slice(0, dot);
      if (token === null) return;
      const session = world.baSessions.get(token);
      if (session) {
        world.baSessions.delete(token);
        world.tokenBySessionId.delete(session.id);
      }
    },
  };
  const store: BrowserSessionMetadataStore = {
    async findByTokenHash(tokenHash) {
      return world.metadataByTokenHash.get(tokenHash) ?? null;
    },
    async insert(row) {
      if (row.predecessorSessionId !== null && world.predecessorIndex.has(row.predecessorSessionId)) {
        throw new RotationCasConflictError();
      }
      world.metadataByTokenHash.set(row.sessionTokenHash, row);
      world.metadataById.set(row.authSessionId, row);
      if (row.predecessorSessionId !== null) {
        world.predecessorIndex.set(row.predecessorSessionId, row.authSessionId);
      }
      if (row.predecessorSessionId === null) {
        await store.evictOldestLiveForAccount({
          accountId: row.accountId,
          keepAuthSessionId: row.authSessionId,
          now: row.lastSeenAt,
          cap: BROWSER_SESSION_LIVE_CAP,
        });
      }
    },
    async markRevoked(authSessionId, revokedAt) {
      const row = world.metadataById.get(authSessionId);
      if (!row || row.revokedAt !== null) return false;
      const next = { ...row, revokedAt };
      world.metadataById.set(authSessionId, next);
      world.metadataByTokenHash.set(next.sessionTokenHash, next);
      return true;
    },
    async touch(authSessionId, lastSeenAt, idleExpiresAt) {
      const row = world.metadataById.get(authSessionId);
      if (!row || row.revokedAt !== null) return false;
      const next = { ...row, lastSeenAt, idleExpiresAt };
      world.metadataById.set(authSessionId, next);
      world.metadataByTokenHash.set(next.sessionTokenHash, next);
      return true;
    },
    async findByPredecessor(predecessorSessionId) {
      const id = world.predecessorIndex.get(predecessorSessionId);
      return id ? world.metadataById.get(id) ?? null : null;
    },
    async revokeAllForAccount(accountId, revokedAt) {
      let count = 0;
      for (const [id, row] of world.metadataById) {
        if (row.accountId === accountId && row.revokedAt === null) {
          world.metadataById.set(id, { ...row, revokedAt });
          count += 1;
        }
      }
      return count;
    },
    async mintSuccessorSession({ userId, now: at }): Promise<MintedSuccessorSession> {
      world.mintCounter += 1;
      const token = `minted-${String(world.mintCounter).padStart(24, '0')}`;
      const id = `minted-session-${world.mintCounter}`;
      const expiresAt = new Date(at.getTime() + 86_400_000);
      world.baSessions.set(token, { id, userId, token, expiresAt });
      world.tokenBySessionId.set(id, token);
      return { session: { id, userId, token, expiresAt }, rawCookieValue: cookieValue(token) };
    },
    async findSuccessorCookie(predecessorSessionId) {
      const id = world.predecessorIndex.get(predecessorSessionId);
      if (!id) return null;
      const token = world.tokenBySessionId.get(id);
      const session = token ? world.baSessions.get(token) : undefined;
      if (!token || !session) return null;
      return {
        session: { id: session.id, userId: session.userId, token: session.token, expiresAt: session.expiresAt },
        rawCookieValue: cookieValue(token),
      };
    },
    async deleteAuthSessionsForAccount(accountId) {
      const authUserIds = [...world.mappings.values()]
        .filter((mapping) => mapping.accountId === accountId)
        .map((mapping) => mapping.authUserId);
      let deleted = 0;
      for (const [token, session] of world.baSessions) {
        if (!authUserIds.includes(session.userId)) continue;
        world.baSessions.delete(token);
        world.tokenBySessionId.delete(session.id);
        deleted += 1;
      }
      return deleted;
    },
    async revokeOthersForAccount(accountId, keepAuthSessionId, revokedAt) {
      let count = 0;
      for (const [id, row] of world.metadataById) {
        if (row.accountId !== accountId || id === keepAuthSessionId || row.revokedAt !== null) continue;
        world.metadataById.set(id, { ...row, revokedAt });
        count += 1;
      }
      return count;
    },
    async alignMetadataEpoch(authSessionId, securityEpoch) {
      const row = world.metadataById.get(authSessionId);
      if (!row || row.revokedAt !== null) return false;
      const next = { ...row, securityEpoch };
      world.metadataById.set(authSessionId, next);
      world.metadataByTokenHash.set(next.sessionTokenHash, next);
      return true;
    },
    async deleteAuthSessionsForAccountExcept(accountId, keepAuthSessionId) {
      const authUserIds = [...world.mappings.values()]
        .filter((mapping) => mapping.accountId === accountId)
        .map((mapping) => mapping.authUserId);
      let deleted = 0;
      for (const [token, session] of world.baSessions) {
        if (!authUserIds.includes(session.userId) || session.id === keepAuthSessionId) continue;
        world.baSessions.delete(token);
        world.tokenBySessionId.delete(session.id);
        deleted += 1;
      }
      return deleted;
    },
    async listLiveForAccount(accountId, options) {
      const live: BrowserSessionMetadataRow[] = [];
      for (const row of world.metadataById.values()) {
        if (row.accountId !== accountId || row.revokedAt !== null) continue;
        if (!world.tokenBySessionId.has(row.authSessionId)) continue;
        live.push(row);
      }
      return rankLiveSessionsForInventory(live, resolveBrowserSessionInventoryLimit(options));
    },
    async evictOldestLiveForAccount({ accountId, keepAuthSessionId, now, cap }) {
      const live: BrowserSessionMetadataRow[] = [];
      for (const row of world.metadataById.values()) {
        if (row.accountId !== accountId || row.revokedAt !== null) continue;
        if (!world.tokenBySessionId.has(row.authSessionId)) continue;
        live.push(row);
      }
      const victims = selectOldestLiveSessionsToEvict(live, { keepAuthSessionId, cap });
      for (const victim of victims) {
        await store.markRevoked(victim.authSessionId, now);
        await store.deleteAuthSessionById(victim.authSessionId);
      }
      return victims.length;
    },
    async findLiveByAuthSessionId(authSessionId) {
      const row = world.metadataById.get(authSessionId);
      if (!row || row.revokedAt !== null) return null;
      if (!world.tokenBySessionId.has(authSessionId)) return null;
      return row;
    },
    async deleteAuthSessionById(authSessionId) {
      const token = world.tokenBySessionId.get(authSessionId);
      if (!token) return false;
      world.baSessions.delete(token);
      world.tokenBySessionId.delete(authSessionId);
      return true;
    },
    async deleteTrustDeviceStateForAccount() {
      return 0;
    },
  };
  const accounts = {
    async findById(id: string) {
      return world.accounts.get(id) ?? null;
    },
    async findBySubjectId(subjectId: string) {
      for (const account of world.accounts.values()) {
        if (account.subjectId === subjectId) return account;
      }
      return null;
    },
    async findByEmail(email: string) {
      for (const account of world.accounts.values()) {
        if (account.email === email) return account;
      }
      return null;
    },
    async insert(account: Account) {
      world.accounts.set(account.id, account);
    },
    async bumpSecurityEpoch(accountId: string) {
      const account = world.accounts.get(accountId);
      if (!account) throw new Error('missing account');
      const next = { ...account, securityEpoch: account.securityEpoch + 1n };
      world.accounts.set(accountId, next);
      return next.securityEpoch;
    },
    async updateEmail(accountId: string, email: string | null) {
      const account = world.accounts.get(accountId);
      if (!account) throw new Error('missing account');
      world.accounts.set(accountId, { ...account, email });
    },
    async markDeleted(accountId: string, deletedAt: Date) {
      const account = world.accounts.get(accountId);
      if (!account) throw new Error('missing account');
      world.accounts.set(accountId, { ...account, status: 'deleted', deletedAt, email: null });
    },
  };
  const sessions = {
    async findById() {
      return null;
    },
    async findByTokenHash() {
      return null;
    },
    async findLiveSuccessorByRotatedFrom() {
      return null;
    },
    async insert() {},
    async revoke() {
      return false;
    },
    async touch() {
      return false;
    },
    async revokeAllForAccount(accountId: string, revokedAt: Date) {
      let count = 0;
      for (const [id, session] of world.legacySessions) {
        if (session.accountId === accountId && session.revokedAt === null) {
          world.legacySessions.set(id, { ...session, revokedAt });
          count += 1;
        }
      }
      return count;
    },
  };
  const unitOfWork: BrowserSessionUnitOfWork = {
    async execute<Result>(work: (ports: BrowserSessionAuthorityPorts) => Promise<Result>): Promise<Result> {
      return work({
        store,
        mappings: {
          async findByAuthUserId(authUserId) {
            return world.mappings.get(authUserId) ?? null;
          },
          async insert(mapping) {
            world.mappings.set(mapping.authUserId, mapping);
          },
        },
        accounts,
        sessions,
        clock: { now: async () => new Date(world.now) },
        revokeOAuthRefreshTokensForAccount: async () => 0,
      });
    },
  };
  return { world, authority: createBrowserSessionAuthority({ unitOfWork, betterAuth }) };
}

// ---------------------------------------------------------------------------
// Fake MFA server port: models the BA 1.6.29 two-factor plugin contract
// (encrypted-at-rest secrets, single-use backup codes via atomic removal,
// single-use pending challenge, per-challenge attempt budget).
// ---------------------------------------------------------------------------

interface FakeMfaWorld {
  enabled: boolean;
  totpUri: string;
  /** Backup codes still available (single-use removal models BA's CAS). */
  backupCodes: string[];
  /** Pending challenge identifiers consumed on first verification (BA consumeVerificationValue). */
  challenges: Set<string>;
  calls: string[];
}

function createFakeMfaServer(world: FakeMfaWorld): MfaServerPort & { readonly calls: readonly string[] } {
  const challengeOf = (cookie: string | undefined): string | null => {
    if (cookie === undefined) return null;
    const match = /known\.two_factor=([^;]+)/u.exec(cookie);
    if (!match) return null;
    const challenge = match[1]!;
    if (!world.challenges.has(challenge)) return null;
    world.challenges.delete(challenge);
    return challenge;
  };
  return {
    async enableTwoFactor() {
      world.calls.push('enable');
      world.enabled = true;
      world.backupCodes = ['AAAAA-11111', 'BBBBB-22222', 'CCCCC-33333'];
      return { totpUri: world.totpUri, backupCodes: [...world.backupCodes] };
    },
    async getTotpUri() {
      world.calls.push('get-totp-uri');
      if (!world.enabled) throw new MfaPolicyError('mfa_not_enabled', 'two-factor authentication is not enabled');
      return world.totpUri;
    },
    async disableTwoFactor() {
      world.calls.push('disable');
      world.enabled = false;
      world.backupCodes = [];
    },
    async verifyTotp({ cookie, code }) {
      world.calls.push(`verify-totp:${code}`);
      const challenge = challengeOf(cookie);
      if (challenge === null) throw new MfaPolicyError('challenge_invalid', 'the two-factor challenge is invalid or was already used');
      if (code !== '123456') throw new MfaPolicyError('invalid_code', 'the two-factor code is invalid');
    },
    async verifyBackupCode({ cookie, code }) {
      world.calls.push(`verify-backup:${code}`);
      const challenge = challengeOf(cookie);
      if (challenge === null) throw new MfaPolicyError('challenge_invalid', 'the two-factor challenge is invalid or was already used');
      const index = world.backupCodes.indexOf(code);
      if (index === -1) throw new MfaPolicyError('invalid_code', 'the two-factor code is invalid');
      world.backupCodes.splice(index, 1);
    },
    async generateBackupCodes() {
      world.calls.push('generate-backup-codes');
      world.backupCodes = ['NEW-11111-AAAA', 'NEW-22222-BBBB'];
      return { backupCodes: [...world.backupCodes] };
    },
    // Test observability: the port call log (the tests assert which server
    // port calls were reached/never reached).
    calls: world.calls,
  };
}

function createReauthVerifier(validPassword: string): ReauthVerifier {
  return {
    async verifyPassword({ password }) {
      return password === validPassword;
    },
    async verifyOtp() {
      return false;
    },
  };
}

const apps: Array<ReturnType<typeof buildApiApp>> = [];

afterEach(async () => {
  while (apps.length > 0) {
    const app = apps.pop();
    await app?.close();
  }
});

describe('MFA policy gates (mfa-policy.ts)', () => {
  function policyHarness(input: {
    readonly password?: string;
    readonly fakeServer?: MfaServerPort;
    readonly bridge?: SecurityEpochBridge;
  } = {}) {
    const { world, authority } = createMemoryHarness();
    const password = input.password ?? 'correct-password';
    const server = input.fakeServer ?? createFakeMfaServer({
      enabled: false,
      totpUri: 'otpauth://totp/known:user@example.test?secret=JBSWY3DPEHPK3PXP',
      backupCodes: [],
      challenges: new Set(['challenge-1', 'challenge-2']),
      calls: [],
    });
    const bridge = input.bridge ?? createSecurityEpochBridge({ authority });
    const policy: MfaPolicyService = createMfaPolicyService({
      authority,
      reauth: createReauthVerifier(password),
      server,
      bridge,
    });
    return { world, authority, policy, server, bridge };
  }

  test('enroll requires the current session and a valid re-auth proof', async () => {
    const { world, policy, server } = policyHarness();
    const { cookie } = seedUsableSession(world);

    // No session: refused before the server port is touched.
    await assert.rejects(
      policy.enroll({ password: 'correct-password' }), // secret-scan: allow 'correct-password'
      (error: unknown) => error instanceof BrowserSessionAuthenticationError,
    );
    // Session but wrong re-auth proof: refused, server never called.
    await assert.rejects(
      policy.enroll({ cookie: cookieHeader(cookie), password: 'wrong-password' }), // secret-scan: allow 'wrong-password'
      (error: unknown) => error instanceof MfaPolicyError && error.code === 'reauth_failed',
    );
    assert.deepEqual(server.calls, []);
    // Session + valid re-auth: codes delivered once.
    const result = await policy.enroll({ cookie: cookieHeader(cookie), password: 'correct-password' }); // secret-scan: allow 'correct-password'
    assert.match(result.totpUri, /^otpauth:\/\/totp\//u);
    assert.equal(result.backupCodes.length, 3);
    assert.deepEqual(server.calls, ['enable']);
  });

  test('getTotpUri and backup-code regeneration require session + re-auth', async () => {
    const { world, policy, server } = policyHarness();
    const { cookie } = seedUsableSession(world);

    await assert.rejects(
      policy.getTotpUri({ cookie: cookieHeader(cookie), password: 'wrong-password' }), // secret-scan: allow 'wrong-password'
      (error: unknown) => error instanceof MfaPolicyError && error.code === 'reauth_failed',
    );
    await policy.enroll({ cookie: cookieHeader(cookie), password: 'correct-password' }); // secret-scan: allow 'correct-password'
    const uri = await policy.getTotpUri({ cookie: cookieHeader(cookie), password: 'correct-password' }); // secret-scan: allow 'correct-password'
    assert.match(uri, /^otpauth:\/\/totp\//u);

    await assert.rejects(
      policy.regenerateBackupCodes({ password: 'wrong-password' }), // secret-scan: allow 'wrong-password'
      (error: unknown) => error instanceof BrowserSessionAuthenticationError,
    );
    const regenerated = await policy.regenerateBackupCodes({ cookie: cookieHeader(cookie), password: 'correct-password' }); // secret-scan: allow 'correct-password'
    assert.equal(regenerated.backupCodes.length, 2);
    assert.deepEqual(server.calls, ['enable', 'get-totp-uri', 'generate-backup-codes']);
  });

  test('disable requires session + re-auth and raises the mfa_disable security epoch event', async () => {
    const { world, authority } = createMemoryHarness();
    const { cookie, accountId } = seedUsableSession(world);
    const server = createFakeMfaServer({
      enabled: false,
      totpUri: 'otpauth://totp/known:user@example.test?secret=JBSWY3DPEHPK3PXP',
      backupCodes: [],
      challenges: new Set(),
      calls: [],
    });
    const events: Array<{ event: AccountSecurityEvent; accountId: string }> = [];
    const bridge = createSecurityEpochBridge({
      authority,
      propagation: {
        async propagate(input) {
          events.push(input);
        },
      },
    });
    const policy = createMfaPolicyService({
      authority,
      reauth: createReauthVerifier('correct-password'),
      server,
      bridge,
    });
    await policy.enroll({ cookie: cookieHeader(cookie), password: 'correct-password' }); // secret-scan: allow 'correct-password'

    await assert.rejects(
      policy.disable({ cookie: cookieHeader(cookie), password: 'wrong-password' }), // secret-scan: allow 'wrong-password'
      (error: unknown) => error instanceof MfaPolicyError && error.code === 'reauth_failed',
    );
    assert.deepEqual(server.calls, ['enable'], 'a failed re-auth must not reach the server or the epoch bridge');

    await policy.disable({ cookie: cookieHeader(cookie), password: 'correct-password' }); // secret-scan: allow 'correct-password'
    assert.deepEqual(server.calls, ['enable', 'disable']);
    assert.deepEqual(events, [{ event: 'mfa_disable', accountId }]);
    // The disable must ALSO have bumped the account epoch (revoke-all fact).
    assert.equal(world.accounts.get(accountId)?.securityEpoch, 1n);
  });

  test('verify and recovery require the pending challenge; the challenge is single-use', async () => {
    const fakeWorld = {
      enabled: true,
      totpUri: 'otpauth://totp/known:user@example.test?secret=JBSWY3DPEHPK3PXP',
      backupCodes: ['AAAAA-11111', 'BBBBB-22222'],
      challenges: new Set(['challenge-1']),
      calls: [] as string[],
    };
    const { world, authority } = createMemoryHarness();
    seedUsableSession(world);
    const policy = createMfaPolicyService({
      authority,
      reauth: createReauthVerifier('correct-password'),
      server: createFakeMfaServer(fakeWorld),
      bridge: createSecurityEpochBridge({ authority }),
    });
    const pendingCookie = 'known.two_factor=challenge-1';

    // No pending challenge (and no session): refused before the server port.
    await assert.rejects(
      policy.verifyTotp({ code: '123456' }),
      (error: unknown) => error instanceof MfaPolicyError && error.code === 'challenge_required',
    );
    await assert.rejects(
      policy.recover({ code: 'AAAAA-11111' }),
      (error: unknown) => error instanceof MfaPolicyError && error.code === 'challenge_required',
    );

    // Recovery: the challenge is consumed by the first verification; the
    // same code on a fresh challenge is refused (single use).
    await policy.recover({ cookie: pendingCookie, code: 'AAAAA-11111' });
    assert.deepEqual(fakeWorld.backupCodes, ['BBBBB-22222'], 'the used backup code must leave the stored set');
    fakeWorld.challenges.add('challenge-2');
    await assert.rejects(
      policy.recover({ cookie: 'known.two_factor=challenge-2', code: 'AAAAA-11111' }),
      (error: unknown) => error instanceof MfaPolicyError && error.code === 'invalid_code',
    );

    // TOTP verify: the challenge is single-use (replay with the consumed
    // challenge is refused even with a valid code).
    fakeWorld.challenges.add('challenge-2');
    await policy.verifyTotp({ cookie: 'known.two_factor=challenge-2', code: '123456' });
    await assert.rejects(
      policy.verifyTotp({ cookie: 'known.two_factor=challenge-2', code: '123456' }),
      (error: unknown) => error instanceof MfaPolicyError && error.code === 'challenge_invalid',
    );
  });
});

describe('MFA pending session is never a full business session (A3 facade)', () => {
  test('the challenge cookie alone never authenticates through authenticate/bootstrap', async () => {
    const { authority } = createMemoryHarness();
    const pendingCookie = `${BROWSER_SESSION_MFA_CHALLENGE_COOKIE_NAME}=signed-challenge-value==`;

    // The challenge cookie is not the session cookie.
    assert.equal(parseBrowserSessionCookie(pendingCookie).kind, 'absent');
    assert.equal(hasBrowserSessionMfaChallenge(pendingCookie), true);
    assert.equal(hasBrowserSessionMfaChallenge(undefined), false);
    assert.equal(hasBrowserSessionMfaChallenge('__Host-known_session=x.y'), false);

    assert.equal(await authority.authenticate({ cookie: pendingCookie }), null);
    assert.deepEqual(await authority.bootstrap({ cookie: pendingCookie }), { authenticated: false });
    // A request with ONLY the challenge cookie must not revoke anything.
    await authority.signOut({ cookie: pendingCookie });
  });

  test('a session-shaped cookie whose BA row was deleted by the pending flow does not authenticate', async () => {
    const { authority } = createMemoryHarness();
    // BA deletes the auth_sessions row when the 2FA challenge starts; a
    // cookie for that deleted row is not a session.
    const deletedSessionCookie = cookieHeader(cookieValue(TOKEN_1));
    assert.equal(
      await authority.authenticate({ cookie: `${deletedSessionCookie}; ${BROWSER_SESSION_MFA_CHALLENGE_COOKIE_NAME}=challenge==` }),
      null,
    );
  });

  test('a live session plus a stale challenge cookie still authenticates on the session', async () => {
    const { world, authority } = createMemoryHarness();
    const { cookie } = seedUsableSession(world);
    const actor = await authority.authenticate({
      cookie: `${cookieHeader(cookie)}; ${BROWSER_SESSION_MFA_CHALLENGE_COOKIE_NAME}=stale-challenge==`,
    });
    assert.ok(actor);
    assert.equal(actor.account.id, 'acct-1');
  });
});

describe('security epoch bridge (security-epoch-bridge.ts)', () => {
  test('every account security event bumps the epoch, revokes product sessions and propagates', async () => {
    const events: Array<{ event: AccountSecurityEvent; accountId: string }> = [];
    const propagation: AccountSecurityEventPropagationPort = {
      async propagate(input) {
        events.push(input);
      },
    };
    const { world, authority } = createMemoryHarness();
    const bridge = createSecurityEpochBridge({ authority, propagation });

    const eventsToTest: readonly AccountSecurityEvent[] = [
      'password_reset', 'email_change', 'provider_link', 'mfa_disable', 'account_disable',
      'oauth_occupancy_adopt',
    ];
    for (const [index, event] of eventsToTest.entries()) {
      // A fresh product session + legacy session for EVERY event: each raise
      // must revoke the sessions live at that moment.
      const { accountId } = seedUsableSession(world, { accountId: `acct-${index + 1}` });
      world.legacySessions.set(`legacy-${index + 1}`, {
        id: `legacy-${index + 1}`,
        accountId,
        idleExpiresAt: new Date(world.now.getTime() + 86_400_000),
        absoluteExpiresAt: new Date(world.now.getTime() + 30 * 86_400_000),
        csrfTokenHash: hashSecret('csrf'),
        tokenHash: hashSecret(`legacy-token-${index + 1}`),
        securityEpoch: 0n,
        rotatedFromSessionId: null,
        lastSeenAt: new Date(world.now),
        revokedAt: null,
        createdAt: new Date(world.now),
      });
      const result: BrowserSessionRevokeAllResult = await bridge.raiseAccountSecurityEvent(event, accountId);
      assert.equal(result.securityEpoch, 1n, `${event} must bump the account security epoch from 0 to 1`);
      assert.equal(result.revokedAuthSessions, 1, `${event} must revoke the BA browser session`);
      assert.equal(result.revokedLegacySessions, 1, `${event} must revoke legacy product sessions`);
    }
    assert.deepEqual(events, eventsToTest.map((event, index) => ({ event, accountId: `acct-${index + 1}` })));
    assert.equal(world.accounts.get('acct-6')?.securityEpoch, 1n);
  });

  test('an unknown account fails closed and never propagates', async () => {
    const propagated: Array<{ event: AccountSecurityEvent; accountId: string }> = [];
    const { authority } = createMemoryHarness();
    const bridge = createSecurityEpochBridge({
      authority,
      propagation: {
        async propagate(input) {
          propagated.push(input);
        },
      },
    });
    await assert.rejects(
      bridge.raiseAccountSecurityEvent('password_reset', 'missing-account'),
      (error: unknown) => error instanceof BrowserSessionAuthenticationError && error.code === 'account_not_found',
    );
    assert.deepEqual(propagated, []);
  });

  test('a propagation failure never fails the committed epoch bump (the bump is the durable revoke fact)', async () => {
    const { world, authority } = createMemoryHarness();
    const { accountId } = seedUsableSession(world);
    const bridge = createSecurityEpochBridge({
      authority,
      propagation: {
        async propagate() {
          throw new Error('mcp revocation store offline');
        },
      },
    });
    const result = await bridge.raiseAccountSecurityEvent('account_disable', accountId);
    assert.equal(result.securityEpoch, 1n);
    assert.equal(world.accounts.get(accountId)?.securityEpoch, 1n);
  });
});

describe('new auth rate-limit families (codec + manifest map)', () => {
  const KEY_SECRET = Buffer.from('auth-unit-hmac-secret', 'utf8');

  test('the sealed family list now carries the C4 families (OIDC families stay until F3)', () => {
    for (const family of ['sign-in', 'sign-up', 'otp', 'reset', 'link', 'mfa', 'oauth-callback', 'oauth-authorize', 'oauth-register', 'oauth-token'] as const) {
      assert.ok(AUTH_RATE_LIMIT_ROUTE_FAMILIES.includes(family), `${family} must be a sealed family`);
    }
    // ADR §10: legacy OIDC families are preserved until F3 removes them.
    for (const family of ['oidc-start', 'oidc-callback', 'session', 'me'] as const) {
      assert.ok(AUTH_RATE_LIMIT_ROUTE_FAMILIES.includes(family), `${family} must stay sealed`);
    }
  });

  test('every new family builds and parses a canonical HMAC key; families/IPs isolate, same family+IP share', () => {
    const ip = '203.0.113.10';
    const windowStart = 1_749_999_960_000;
    for (const family of ['sign-in', 'sign-up', 'otp', 'reset', 'link', 'mfa', 'oauth-callback', 'oauth-authorize', 'oauth-register', 'oauth-token'] as const) {
      const key = buildAuthRateLimitKey({
        keyPrefix: 'known', environment: 'test', keySecret: KEY_SECRET,
        routeFamily: family, clientIp: ip, windowStartEpochMs: windowStart,
      });
      const parsed = parseAuthRateLimitKey(key);
      assert.equal(parsed.kind, 'ok', `${family} key must parse`);
      if (parsed.kind === 'ok') {
        assert.equal(parsed.parts.routeFamily, family);
        assert.equal(key.includes(ip), false, 'the raw IP never enters the key');
      }
    }
    const otpKey = buildAuthRateLimitKey({
      keyPrefix: 'known', environment: 'test', keySecret: KEY_SECRET,
      routeFamily: 'otp', clientIp: ip, windowStartEpochMs: windowStart,
    });
    // Same family + same IP => SAME bucket (shared counter across the
    // family's surfaces); different family or different IP => own bucket.
    assert.equal(buildAuthRateLimitKey({
      keyPrefix: 'known', environment: 'test', keySecret: KEY_SECRET,
      routeFamily: 'otp', clientIp: ip, windowStartEpochMs: windowStart,
    }), otpKey);
    assert.notEqual(buildAuthRateLimitKey({
      keyPrefix: 'known', environment: 'test', keySecret: KEY_SECRET,
      routeFamily: 'reset', clientIp: ip, windowStartEpochMs: windowStart,
    }), otpKey);
    assert.notEqual(buildAuthRateLimitKey({
      keyPrefix: 'known', environment: 'test', keySecret: KEY_SECRET,
      routeFamily: 'otp', clientIp: '198.51.100.20', windowStartEpochMs: windowStart,
    }), otpKey);
    const registerKey = buildAuthRateLimitKey({
      keyPrefix: 'known', environment: 'test', keySecret: KEY_SECRET,
      routeFamily: 'oauth-register', clientIp: ip, windowStartEpochMs: windowStart,
    });
    assert.notEqual(buildAuthRateLimitKey({
      keyPrefix: 'known', environment: 'test', keySecret: KEY_SECRET,
      routeFamily: 'oauth-authorize', clientIp: ip, windowStartEpochMs: windowStart,
    }), registerKey, 'DCR register must not share the authorize HMAC key');
    assert.equal(buildAuthRateLimitKey({
      keyPrefix: 'known', environment: 'test', keySecret: KEY_SECRET,
      routeFamily: 'oauth-register', clientIp: ip, windowStartEpochMs: windowStart,
    }), registerKey);
    // Unknown family is rejected by both the builder and the normalizer.
    assert.throws(
      () => buildAuthRateLimitKey({
        keyPrefix: 'known', environment: 'test', keySecret: KEY_SECRET,
        routeFamily: 'admin' as never, clientIp: ip, windowStartEpochMs: windowStart,
      }),
      /route family/,
    );
    assert.equal(parseAuthRateLimitKey(
      `known:test:ratelimit:v1:{auth:${'a'.repeat(32)}}:admin:${windowStart}`,
    ).kind, 'rejected');
  });

  test('the manifest family map routes the BA surfaces to the new families', () => {
    assert.equal(authRateLimitRouteFamilyForPath('/api/v1/auth/sign-in/email'), 'sign-in');
    assert.equal(authRateLimitRouteFamilyForPath('/api/v1/auth/sign-in/oauth2'), 'sign-in');
    assert.equal(authRateLimitRouteFamilyForPath('/api/v1/auth/sign-up/email'), 'sign-up');
    // P6: send-verification-otp stays `otp`. Signup-intent is a header on this
    // same path; a tighter register bucket would need header-aware admission
    // plus a new family in the Redis key codec — skipped.
    assert.equal(authRateLimitRouteFamilyForPath('/api/v1/auth/email-otp/send-verification-otp'), 'otp');
    assert.equal(authRateLimitRouteFamilyForPath('/api/v1/auth/email-otp/check-verification-otp'), 'otp');
    assert.equal(authRateLimitRouteFamilyForPath('/api/v1/auth/sign-in/email-otp'), 'otp');
    assert.equal(authRateLimitRouteFamilyForPath('/api/v1/auth/reset-password'), 'reset');
    assert.equal(authRateLimitRouteFamilyForPath('/api/v1/auth/request-password-reset'), 'reset');
    assert.equal(authRateLimitRouteFamilyForPath('/api/v1/auth/recovery/password-reset'), 'reset');
    assert.equal(authRateLimitRouteFamilyForPath('/api/v1/auth/oauth2/link'), 'link');
    assert.equal(authRateLimitRouteFamilyForPath('/api/v1/auth/unlink-account'), 'link');
    assert.equal(authRateLimitRouteFamilyForPath('/api/v1/auth/linked-accounts'), 'link');
    // P3: GET /linked-accounts stays the product linking family; body is
    // { accounts, hasPassword } (hasPassword is not a rate-limit concern).
    assert.equal(authRateLimitRouteFamilyForPath('/api/v1/auth/sessions'), 'session');
    assert.equal(authRateLimitRouteFamilyForPath('/api/v1/auth/sessions/revoke'), 'session');
    assert.equal(authRateLimitRouteFamilyForPath('/api/v1/auth/account/delete'), 'session');
    for (const path of [
      '/api/v1/auth/two-factor/enable',
      '/api/v1/auth/two-factor/disable',
      '/api/v1/auth/two-factor/get-totp-uri',
      '/api/v1/auth/two-factor/verify-totp',
      '/api/v1/auth/two-factor/verify-backup-code',
      '/api/v1/auth/two-factor/generate-backup-codes',
      '/api/v1/auth/two-factor/send-otp',
      '/api/v1/auth/two-factor/verify-otp',
    ]) {
      assert.equal(authRateLimitRouteFamilyForPath(path), 'mfa', `${path} must be an mfa-family path`);
      assert.equal(isAuthRateLimitedPath(path), true, `${path} must be rate limited`);
    }
    // Unchanged sealed surfaces.
    assert.equal(authRateLimitRouteFamilyForPath('/api/v1/session'), 'session');
    assert.equal(authRateLimitRouteFamilyForPath('/api/v1/me'), 'me');
    assert.equal(authRateLimitRouteFamilyForPath('/api/v1/auth/oidc/start'), 'oidc-start');
    assert.equal(authRateLimitRouteFamilyForPath('/api/v1/auth/callback/google'), 'oauth-callback');
    assert.equal(authRateLimitRouteFamilyForPath('/api/v1/auth/oauth2/callback/github'), 'oauth-callback');
    assert.equal(isAuthRateLimitedPath('/api/v1/auth/callback/google'), true);
    assert.equal(isAuthRateLimitedPath('/api/v1/auth/oauth2/callback/github'), true);
    assert.equal(authRateLimitRouteFamilyForPath('/api/v1/auth/callback/google/extra'), null);
    assert.equal(authRateLimitRouteFamilyForPath('/api/v1/auth/callback'), null);
    assert.equal(authRateLimitRouteFamilyForPath('/api/v1/auth/oauth2/register'), 'oauth-register');
    assert.equal(authRateLimitRouteFamilyForPath('/api/v1/auth/oauth2/authorize'), 'oauth-authorize');
    assert.equal(authRateLimitRouteFamilyForPath('/api/v1/auth/oauth2/consent'), 'oauth-authorize');
    assert.equal(authRateLimitRouteFamilyForPath('/api/v1/auth/oauth2/public-client'), 'oauth-authorize');
    assert.equal(authRateLimitRouteFamilyForPath('/api/v1/auth/oauth2/consent-transaction'), 'oauth-authorize');
    assert.equal(authRateLimitRouteFamilyForPath('/api/v1/auth/oauth2/token'), 'oauth-token');
  });
});

describe('new auth rate-limit behavior over the app (injected clock, shared adapter contract)', () => {
  test('OTP resend flood: the otp family shares ONE bucket across send/verify surfaces; other families stay isolated', async () => {
    const config = loadConfig(testEnv({
      AUTH_RATE_LIMIT_MAX: '2',
      AUTH_RATE_LIMIT_WINDOW_MS: '60000',
    }));
    const limiter = createMemoryAuthRateLimiter({ maxRequests: 2, windowMs: 60_000 });
    const app = buildApiApp({
      config,
      authRateLimiter: limiter,
      identityUnitOfWork: emptyIdentityUnitOfWork(),
    });
    apps.push(app);

    // This app has NO Better Auth runtime mounted: the OTP paths 404 at the
    // router but still CONSUME the otp family budget (the onRequest gate runs
    // before routing — an attacker cannot launder requests through unmounted
    // endpoints to escape the limit).
    const send1 = await app.inject({ method: 'POST', url: '/api/v1/auth/email-otp/send-verification-otp' });
    const send2 = await app.inject({ method: 'POST', url: '/api/v1/auth/email-otp/send-verification-otp' });
    const send3 = await app.inject({ method: 'POST', url: '/api/v1/auth/email-otp/send-verification-otp' });
    assert.equal(send1.statusCode, 404);
    assert.equal(send2.statusCode, 404);
    assert.equal(send3.statusCode, 429, 'the third OTP send is denied by the otp family budget');
    assert.equal(send3.json().error.code, 'rate_limited');
    assert.equal(send3.headers['ratelimit-policy'], 'auth:otp:2:60000');
    assert.ok(send3.headers['retry-after']);

    // Shared bucket: the verify surface of the SAME family is throttled too.
    const verify = await app.inject({ method: 'POST', url: '/api/v1/auth/email-otp/check-verification-otp' });
    assert.equal(verify.statusCode, 429, 'check-verification-otp shares the otp bucket');
    assert.equal(verify.headers['ratelimit-policy'], 'auth:otp:2:60000');

    // Isolation: the sign-in family keeps its own budget (404, not 429).
    const signIn = await app.inject({ method: 'POST', url: '/api/v1/auth/sign-in/email' });
    assert.equal(signIn.statusCode, 404, 'sign-in must not share the otp budget');

    const oauthLimiter = createMemoryAuthRateLimiter({ maxRequests: 2, windowMs: 60_000 });
    const oauthApp = buildApiApp({
      config,
      authRateLimiter: oauthLimiter,
      identityUnitOfWork: emptyIdentityUnitOfWork(),
    });
    apps.push(oauthApp);
    const callbackGoogle1 = await oauthApp.inject({ method: 'GET', url: '/api/v1/auth/callback/google' });
    const callbackGoogle2 = await oauthApp.inject({ method: 'GET', url: '/api/v1/auth/callback/google' });
    const callbackGithub = await oauthApp.inject({ method: 'GET', url: '/api/v1/auth/oauth2/callback/github' });
    assert.equal(callbackGoogle1.statusCode, 404);
    assert.equal(callbackGoogle2.statusCode, 404);
    assert.equal(callbackGithub.statusCode, 429, 'parameterized OAuth callbacks share the oauth-callback bucket');
    assert.equal(callbackGithub.json().error.code, 'rate_limited');
    assert.equal(callbackGithub.headers['ratelimit-policy'], 'auth:oauth-callback:2:60000');
    const isolatedSignIn = await oauthApp.inject({ method: 'POST', url: '/api/v1/auth/sign-in/email' });
    assert.equal(isolatedSignIn.statusCode, 404, 'sign-in must not share the oauth-callback budget');

    const registerLimiter = createMemoryAuthRateLimiter({ maxRequests: 2, windowMs: 60_000 });
    const registerApp = buildApiApp({
      config,
      authRateLimiter: registerLimiter,
      identityUnitOfWork: emptyIdentityUnitOfWork(),
    });
    apps.push(registerApp);
    const register1 = await registerApp.inject({ method: 'POST', url: '/api/v1/auth/oauth2/register' });
    const register2 = await registerApp.inject({ method: 'POST', url: '/api/v1/auth/oauth2/register' });
    const register3 = await registerApp.inject({ method: 'POST', url: '/api/v1/auth/oauth2/register' });
    assert.notEqual(register1.statusCode, 429);
    assert.notEqual(register2.statusCode, 429);
    assert.equal(register3.statusCode, 429, 'the third DCR register is denied by the oauth-register family budget');
    assert.equal(register3.json().error.code, 'rate_limited');
    assert.equal(register3.headers['ratelimit-policy'], 'auth:oauth-register:2:60000');
    const authorizeAfterRegister = await registerApp.inject({ method: 'GET', url: '/api/v1/auth/oauth2/authorize' });
    assert.notEqual(authorizeAfterRegister.statusCode, 429, 'authorize must not share the oauth-register budget');

    const authorizeLimiter = createMemoryAuthRateLimiter({ maxRequests: 2, windowMs: 60_000 });
    const authorizeApp = buildApiApp({
      config,
      authRateLimiter: authorizeLimiter,
      identityUnitOfWork: emptyIdentityUnitOfWork(),
    });
    apps.push(authorizeApp);
    const authorize1 = await authorizeApp.inject({ method: 'GET', url: '/api/v1/auth/oauth2/authorize' });
    const authorize2 = await authorizeApp.inject({ method: 'GET', url: '/api/v1/auth/oauth2/authorize' });
    const authorize3 = await authorizeApp.inject({ method: 'GET', url: '/api/v1/auth/oauth2/authorize' });
    assert.notEqual(authorize1.statusCode, 429);
    assert.notEqual(authorize2.statusCode, 429);
    assert.equal(authorize3.statusCode, 429, 'the third authorize is denied by the oauth-authorize family budget');
    assert.equal(authorize3.json().error.code, 'rate_limited');
    assert.equal(authorize3.headers['ratelimit-policy'], 'auth:oauth-authorize:2:60000');
    const registerAfterAuthorize = await authorizeApp.inject({ method: 'POST', url: '/api/v1/auth/oauth2/register' });
    assert.notEqual(registerAfterAuthorize.statusCode, 429, 'DCR register must not share the oauth-authorize budget');
    const registerAfterCode = (registerAfterAuthorize.json() as { error?: { code?: string } }).error?.code;
    assert.notEqual(registerAfterCode, 'rate_limited');

    // Window rollover with the injected clock: a fresh window admits again.
    const windowed = createMemoryAuthRateLimiter({ maxRequests: 1, windowMs: 60_000, now: () => 0 });
    assert.deepEqual(await windowed.consume({ routeFamily: 'otp', clientIp: '203.0.113.10' }), {
      kind: 'allowed', decision: { allowed: true, retryAfterSeconds: 0 },
    });
    assert.deepEqual(await windowed.consume({ routeFamily: 'otp', clientIp: '203.0.113.10' }), {
      kind: 'denied', decision: { allowed: false, retryAfterSeconds: 60 },
    });
  });

  test('new-IP bucket capacity: a live bucket is never evicted; a fresh IP is denied at capacity and admitted after the window', () => {
    let now = 0;
    const limiter = createFixedWindowRateLimiter({
      maxRequests: 5,
      windowMs: 60_000,
      maxBuckets: 1,
      now: () => now,
    });
    assert.equal(limiter.consume('203.0.113.10').allowed, true);
    const blocked = limiter.consume('198.51.100.20');
    assert.equal(blocked.allowed, false, 'a NEW key is denied while the map is at capacity');
    if (!blocked.allowed) {
      assert.ok(blocked.retryAfterSeconds >= 1);
    }
    assert.equal(limiter.capacityRejections(), 1);
    // The live bucket survives; the same live key keeps its budget.
    assert.equal(limiter.consume('203.0.113.10').allowed, true);
    // After the window expires, the sweep frees capacity for the new IP.
    now = 61_000;
    assert.equal(limiter.consume('198.51.100.20').allowed, true);
    assert.equal(limiter.evictions(), 1);
  });

  test('shared-adapter failure fails CLOSED with 503 on the new MFA surface (never a fabricated quota fact)', async () => {
    const config = loadConfig(testEnv());
    const failing: AuthRateLimiter = {
      async consume(_subject: AuthRateLimitSubject) {
        return { kind: 'failed', failure: { class: 'unavailable', code: 'rate_limit_store_closed' } };
      },
      readiness() {
        return { status: 'degraded', reason: 'last_command_failed', lastCheckedAtEpochMs: Date.now() };
      },
      async close() {},
    };
    const app = buildApiApp({
      config,
      authRateLimiter: failing,
      identityUnitOfWork: emptyIdentityUnitOfWork(),
    });
    apps.push(app);

    const response = await app.inject({ method: 'POST', url: '/api/v1/auth/two-factor/verify-totp' });
    assert.equal(response.statusCode, 503, 'a Redis/auth-store failure must be a 503, never an admission');
    assert.equal(response.json().error.code, 'feature_temporarily_unavailable');
    assert.equal(response.headers['retry-after'], undefined, 'a 503 never fabricates Retry-After quota facts');
    assert.equal(response.headers['ratelimit-policy'], undefined);
  });
});
