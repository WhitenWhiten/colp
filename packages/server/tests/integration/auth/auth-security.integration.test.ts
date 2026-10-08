/**
 * Task C4 integration: MFA/TOTP over REAL PostgreSQL + REAL Better Auth
 * 1.7.1, security epoch revocation through the REAL Sync and MCP verifier
 * entries, and the MFA pending-session contract (plan §9 Task C4).
 *
 * 假阴性防护:
 * - TOTP codes are computed from the DECRYPTED stored secret with a test-side
 *   RFC 6238 HOTP (never a fixed never-expiring code) and the plugin's real
 *   verify path is exercised with current/adjacent/past counters;
 * - the recovery-code proof completes a full sign-in (pending challenge ->
 *   backup code -> session cookie) AND replays the SAME code on a fresh
 *   challenge (single use), never just "a code was generated";
 * - the epoch test verifies old credentials through the REAL Sync session
 *   verifier (`createPostgresSyncSessionIssuer.verify`) and the REAL MCP
 *   OAuth verifier (`createMcpOauthVerifier`) — a raw SQL epoch update is
 *   never the proof, the bridge raises the event;
 * - the MFA pending session is asserted non-authenticating through the REAL
 *   BA get-session AND the A3 BrowserSessionAuthority facade.
 *
 * 假阳性防护:
 * - enrollment is never proven by the 200 alone: the auth_two_factor row is
 *   read and its secret/backupCodes must be encrypted-at-rest (decryptable
 *   only with the BA secret) while the response codes were shown once;
 * - a session is never "proven" by a status code: every sign-in completion
 *   is followed by a real get-session / authority authenticate with the
 *   issued cookie;
 * - the sync/MCP negative assertions assert the STABLE error class
 *   (SyncSessionIssueError code, McpOauthVerificationError reason), not a
 *   generic rejection.
 */
import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, test } from 'vitest';
import { betterAuth } from 'better-auth';
import Fastify from 'fastify';
import { generateKeyPair, exportJWK, SignJWT, type JSONWebKeySet, type KeyLike } from 'jose';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hexToBytes, managedNonce } from '@noble/ciphers/utils.js';
import { loadConfig } from '../../support/test-config.js';
import { buildBetterAuthConfig } from '../../../src/modules/auth/better-auth-config.js';
import {
  applyFetchResponse,
  buildBetterAuthOptions,
  fastifyRequestToFetchRequest,
  type BetterAuthRuntimeConfig,
} from '../../../src/infrastructure/auth/better-auth-runtime.js';
import { createAuthEmailAdapter, createInProcessMailboxSink } from '../../../src/infrastructure/email/auth-email-adapter.js';
import { createLogger } from '../../../src/infrastructure/telemetry/index.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { createPostgresBusinessAccountUnitOfWork } from '../../../src/infrastructure/auth/business-account-unit-of-work.js';
import {
  createBetterAuthServerApi,
  createBetterAuthSessionAuthority,
} from '../../../src/infrastructure/auth/better-auth-session-authority.js';
import { createBetterAuthSessionTokenProtector } from '../../../src/infrastructure/auth/better-auth-session-token-protection.js';
import { createPostgresSyncSessionIssuer, SyncSessionIssueError } from '../../../src/infrastructure/sync/index.js';
import { createPostgresReplicaStore } from '../../../src/infrastructure/sync/index.js';
import type { ReplicaRecord } from '../../../src/modules/sync/index.js';
import type { VerifiedExtensionCredential } from '../../../src/modules/identity/index.js';
import {
  createInMemoryMcpOauthRevocationStore,
  createMcpOauthVerifier,
  McpOauthVerificationError,
  type McpOauthRevocationStore,
} from '../../../src/modules/mcp/index.js';
import type { JwksProvider } from '../../../src/modules/identity/index.js';
import {
  BROWSER_SESSION_MFA_CHALLENGE_COOKIE_NAME,
  BROWSER_SESSION_TRUST_DEVICE_COOKIE_NAME,
  browserSessionCsrfTokenHash,
  browserSessionTokenHash,
  createMfaPolicyService,
  createSecurityEpochBridge,
  deriveBrowserSessionCsrfTokenRaw,
  MfaPolicyError,
  type MfaPolicyService,
  type MfaServerPort,
  type ReauthVerifier,
} from '../../../src/modules/auth/index.js';
import type { BrowserSessionAuthority } from '../../../src/modules/auth/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';
import { applyBetterAuth17LibrarySchemaExpand } from '../../support/better-auth-postgres.js';
import { mintVerifiedExtensionCredentialFixture } from '../../support/extension-credential.js';
import { waitForCondition } from '../../support/async-test-helpers.js';

const TRUSTED_ORIGIN = 'https://app.example.test';
const BASE_PATH = '/api/v1/auth';
const PASSWORD = 'password-123'; // secret-scan: allow 'password-123'
const NEW_PASSWORD = 'new-password-456';
const MFA_COOKIE_NAME = BROWSER_SESSION_MFA_CHALLENGE_COOKIE_NAME;
const TRUST_DEVICE_COOKIE_NAME = BROWSER_SESSION_TRUST_DEVICE_COOKIE_NAME;
const SESSION_COOKIE_NAME = '__Host-known_session';

const SYNC_ISSUER = 'https://issuer.example';
const SYNC_AUDIENCE = 'known-api';
const SYNC_CLIENT_ID = 'known-extension';
const SYNC_REPLAY_KEY = Buffer.alloc(32, 7);

const MCP_ISSUER = 'https://issuer.example.test/realms/known';
const MCP_AUDIENCE = 'https://collections.example.test/collections/-/mcp';
const MCP_CLIENT_ID = 'known-mcp-oauth-client';
const MCP_SCOPES = ['mcp:read:public', 'mcp:read:own'];

function testEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    DATABASE_URL: 'postgres://localhost/known_test',
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    PRODUCT_ORIGIN: TRUSTED_ORIGIN,
    ALLOWED_ORIGINS: TRUSTED_ORIGIN,
    OIDC_ALLOW_TEST_PROVIDER: 'true',
    OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
    BETTER_AUTH_ENABLED: 'true',
    BETTER_AUTH_SECRET: 'test-better-auth-secret-0123456789abcdef',
    BETTER_AUTH_EMAIL_OTP_ENABLED: 'false',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test-side RFC 6238 HOTP/TOTP + BA 1.7.1 symmetric decrypt mirror
// (better-auth/dist is not an exported subpath, so the test mirrors the
// library's rawEncrypt/rawDecrypt + createOTP primitives).
// ---------------------------------------------------------------------------

function hotp(secret: Uint8Array, counter: number, digits = 6): string {
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', secret).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const binary = ((hmac[offset]! & 0x7f) << 24)
    | (hmac[offset + 1]! << 16)
    | (hmac[offset + 2]! << 8)
    | hmac[offset + 3]!;
  return (binary % 10 ** digits).toString().padStart(digits, '0');
}

function totpForCounter(secret: Uint8Array, counter: number): string {
  return hotp(secret, counter, 6);
}

function currentTotpCounter(periodSeconds = 30): number {
  return Math.floor(Date.now() / (periodSeconds * 1000));
}

/** Mirrors better-auth 1.7.1 `rawDecrypt` (xchacha20poly1305 + sha256 key). */
function baDecrypt(secret: string, hex: string): Uint8Array {
  const key = createHash('sha256').update(secret, 'utf8').digest();
  return managedNonce(xchacha20poly1305)(new Uint8Array(key)).decrypt(hexToBytes(hex));
}

// ---------------------------------------------------------------------------
// MCP OAuth verifier fixture (REAL verifier, REAL store, jose-signed token)
// ---------------------------------------------------------------------------

async function createMcpFixture(): Promise<{
  readonly store: McpOauthRevocationStore;
  readonly verifier: ReturnType<typeof createMcpOauthVerifier>;
  readonly key: KeyLike;
  readonly kid: string;
}> {
  const pair = await generateKeyPair('RS256', { extractable: true });
  const jwk = await exportJWK(pair.publicKey);
  Object.assign(jwk, { kid: 'c4-mcp-kid', alg: 'RS256', use: 'sig' });
  const store = createInMemoryMcpOauthRevocationStore();
  const jwks: JwksProvider = {
    async getKeySet(): Promise<JSONWebKeySet> {
      return { keys: [jwk] } as JSONWebKeySet;
    },
  };
  const verifier = createMcpOauthVerifier({
    issuer: MCP_ISSUER,
    audience: MCP_AUDIENCE,
    allowedScopes: MCP_SCOPES,
    jwks,
    isRevoked: async (input) => store.isRevoked({
      issuer: input.issuer,
      subject: input.subject,
      clientId: input.clientId,
      tokenId: input.tokenId,
      credentialDigest: input.credentialDigest,
      issuedAtSeconds: input.issuedAtSeconds,
    }),
    securityEpoch: () => store.securityEpoch(),
    resolveAccountBySubject: async (sub) => ({
      id: `account:${sub}`,
      subjectId: sub,
      status: 'active',
    }),
  });
  return { store, verifier, key: pair.privateKey, kid: 'c4-mcp-kid' };
}

async function mintMcpToken(
  key: KeyLike,
  kid: string,
  subject: string,
  issuedAtSeconds: number,
): Promise<string> {
  return new SignJWT({ scope: MCP_SCOPES.join(' '), client_id: MCP_CLIENT_ID })
    .setProtectedHeader({ alg: 'RS256', kid })
    .setIssuer(MCP_ISSUER)
    .setSubject(subject)
    .setAudience(MCP_AUDIENCE)
    .setIssuedAt(issuedAtSeconds)
    .setExpirationTime(issuedAtSeconds + 3_600)
    .setJti(`c4-mcp-${randomUUID()}`)
    .sign(key);
}

describeWithPostgres('C4 auth security: MFA, pending sessions, epoch revocation, recovery single-use (real PostgreSQL)', () => {
  let isolated: IsolatedPostgresRuntime;
  let app: ReturnType<typeof Fastify>;
  let sink: ReturnType<typeof createInProcessMailboxSink>;
  let auth: ReturnType<typeof betterAuth>;
  let authority: BrowserSessionAuthority;
  let mfaPolicy: MfaPolicyService;
  let reauth: ReauthVerifier;
  let mfaServer: MfaServerPort;
  let bridge: ReturnType<typeof createSecurityEpochBridge>;
  let mcpStore: McpOauthRevocationStore;
  let mcpVerifier: ReturnType<typeof createMcpOauthVerifier>;
  let mcpKey: KeyLike;
  let mcpKid: string;
  let baSecret: string;
  let runtimeConfig: BetterAuthRuntimeConfig;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('c4_auth_security', {
      maxConnections: 12,
      applicationName: 'known-c4-auth-security-test',
    });
    await runMigrations(isolated.runtime.db, 'latest');
    // The two-factor plugin schema (auth_two_factor + auth_users.
    // "twoFactorEnabled") is landed ADDITIVELY by the C4 migration
    // migrations/202609051000_better_auth_mfa_schema.ts (plan §9 Task C4
    // "data migration") — the identical shape the suite used to create
    // manually before the migration existed.

    const config = loadConfig(testEnv());
    const built = buildBetterAuthConfig({ ...config.betterAuth, mfa: { enabled: true } });
    assert.ok(built, 'enabled config must produce Better Auth settings');
    assert.ok(built.mfa, 'MFA must be enabled for this suite');
    runtimeConfig = built;
    baSecret = built.secret;

    sink = createInProcessMailboxSink();
    const sender = createAuthEmailAdapter({ provider: sink.provider, logger: createLogger('silent') });
    const unitOfWork = createPostgresBusinessAccountUnitOfWork(isolated.runtime.db);

    const baOptions = buildBetterAuthOptions({
      enabled: true,
      config: built,
      database: { db: isolated.runtime.db, type: 'postgres', transaction: true },
      authEmail: sender,
      businessAccount: { unitOfWork },
      logger: createLogger('silent'),
    });
    // T-02 lands issuer on migrateToLatest; this expand is then a no-op.
    await applyBetterAuth17LibrarySchemaExpand(baOptions);
    auth = betterAuth(baOptions);

    // Test-only full-surface mount: every BA endpoint through the REAL bridge
    // (the allowlist mount is A1/A4's concern; this suite needs the
    // two-factor plugin endpoints and the reset flow).
    app = Fastify({ logger: false });
    app.route({
      method: ['GET', 'POST'],
      url: `${BASE_PATH}/*`,
      onRequest: async (request, reply) => {
        const response = await auth.handler(fastifyRequestToFetchRequest(request, reply));
        await applyFetchResponse(reply, response);
      },
      handler: async (_request, reply) => reply.code(500).send({ error: 'internal_error', message: 'unreachable' }),
    });
    await app.ready();

    authority = createBetterAuthSessionAuthority({
      db: isolated.runtime.db,
      betterAuth: createBetterAuthServerApi(auth),
      secret: built.secret,
      sessionExpiresInSeconds: built.sessionExpiresInSeconds,
      sessionTokenProtector: createBetterAuthSessionTokenProtector(built.sessionTokenProtection),
    });

    const mcpFixture = await createMcpFixture();
    mcpStore = mcpFixture.store;
    mcpVerifier = mcpFixture.verifier;
    mcpKey = mcpFixture.key;
    mcpKid = mcpFixture.kid;
    bridge = createSecurityEpochBridge({
      authority,
      propagation: {
        async propagate() {
          // This fixture's propagate is an explicit global incident bump.
          // Production account events do not call bumpSecurityEpoch.
          await mcpStore.bumpSecurityEpoch(`known.mcp.oauth.v1:${Date.now()}`);
        },
      },
    });

    reauth = {
      async verifyPassword({ cookie, password }) {
        const headers = cookie === undefined ? {} : { cookie };
        try {
          // BA verifyPassword returns { status: true } and THROWS
          // INVALID_PASSWORD on a mismatch — both map to the boolean proof.
          const result = await auth.api.verifyPassword({ headers, body: { password } });
          return result.status === true;
        } catch {
          return false;
        }
      },
      async verifyOtp() {
        return false;
      },
    };
    mfaServer = {
      async enableTwoFactor({ cookie, password }) {
        try {
          const result = await auth.api.enableTwoFactor({
            headers: { cookie }, body: { password },
          });
          return { totpUri: result.totpURI, backupCodes: result.backupCodes };
        } catch (error) {
          throw mapMfaServerError(error);
        }
      },
      async getTotpUri({ cookie, password }) {
        try {
          const result = await auth.api.getTOTPURI({ headers: { cookie }, body: { password } });
          return result.totpURI;
        } catch (error) {
          throw mapMfaServerError(error);
        }
      },
      async disableTwoFactor({ cookie, password }) {
        try {
          await auth.api.disableTwoFactor({ headers: { cookie }, body: { password } });
        } catch (error) {
          throw mapMfaServerError(error);
        }
      },
      async verifyTotp({ cookie, code, trustDevice }) {
        try {
          await auth.api.verifyTOTP({
            headers: { cookie },
            body: { code, ...(trustDevice === true ? { trustDevice: true } : {}) },
          });
        } catch (error) {
          throw mapMfaServerError(error);
        }
      },
      async verifyBackupCode({ cookie, code, trustDevice }) {
        try {
          await auth.api.verifyBackupCode({
            headers: { cookie },
            body: { code, ...(trustDevice === true ? { trustDevice: true } : {}) },
          });
        } catch (error) {
          throw mapMfaServerError(error);
        }
      },
      async generateBackupCodes({ cookie, password }) {
        try {
          const result = await auth.api.generateBackupCodes({ headers: { cookie }, body: { password } });
          return { backupCodes: result.backupCodes };
        } catch (error) {
          throw mapMfaServerError(error);
        }
      },
    };
    mfaPolicy = createMfaPolicyService({ authority, reauth, server: mfaServer, bridge });
  }, 120_000);

  afterAll(async () => {
    await app?.close().catch(() => undefined);
    await isolated?.close();
  });

  const JSON_POST_HEADERS = { 'content-type': 'application/json', origin: TRUSTED_ORIGIN };

  function post(path: string, body: unknown, headers: Record<string, string> = JSON_POST_HEADERS) {
    return app.inject({ method: 'POST', url: `${BASE_PATH}${path}`, headers, payload: JSON.stringify(body) });
  }

  function get(path: string, headers: Record<string, string> = {}) {
    return app.inject({ method: 'GET', url: `${BASE_PATH}${path}`, headers });
  }

  function cookiesOf(res: { cookies?: unknown }): Array<{ name: string; value: string }> {
    return (res.cookies ?? []) as Array<{ name: string; value: string }>;
  }

  function sessionCookie(res: { cookies?: unknown }): string | null {
    return cookiesOf(res).find((cookie) => cookie.name === SESSION_COOKIE_NAME)?.value ?? null;
  }

  function mfaPendingCookie(res: { cookies?: unknown }): string | null {
    return cookiesOf(res).find((cookie) => cookie.name === MFA_COOKIE_NAME)?.value ?? null;
  }

  function trustDeviceCookie(res: { cookies?: unknown }): { name: string; value: string; maxAge?: number } | undefined {
    return cookiesOf(res).find((cookie) => cookie.name === TRUST_DEVICE_COOKIE_NAME) as
      | { name: string; value: string; maxAge?: number }
      | undefined;
  }

  function trustDeviceExpiredOnResponse(res: { cookies?: unknown; headers: { [key: string]: unknown } }): boolean {
    const parsed = trustDeviceCookie(res);
    if (parsed && (parsed.maxAge === 0 || parsed.value === '')) return true;
    const raw = res.headers['set-cookie'];
    const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
    return list.some((entry) => typeof entry === 'string'
      && /^known\.trust_device=/i.test(entry)
      && /max-age=0/i.test(entry));
  }

  function cookieHeaderValue(name: string, value: string): string {
    return `${name}=${value}`;
  }

  async function signUp(email: string) {
    return post('/sign-up/email', { name: 'C4 User', email, password: PASSWORD });
  }

  function verificationTokenFor(email: string): string {
    const entry = sinkEntriesFor(email).find((item) => item.subject.includes('Verify'))
      ?? sinkEntriesFor(email)[0];
    assert.ok(entry, `no verification email was delivered to ${email}`);
    const token = entry.textBody.match(/token=([A-Za-z0-9._~-]+)/u)?.[1];
    assert.ok(token, 'the verification email must carry the JWT');
    return token;
  }

  async function verifyMailbox(email: string): Promise<void> {
    const token = verificationTokenFor(email);
    const verify = await get(`/verify-email?token=${token}`);
    assert.equal(verify.statusCode, 200, 'mailbox verification must succeed');
    const autoCookie = sessionCookie(verify);
    if (autoCookie !== null && autoCookie !== '') {
      await post('/sign-out', {}, { ...JSON_POST_HEADERS, cookie: cookieHeaderValue(SESSION_COOKIE_NAME, autoCookie) });
    }
  }

  async function signUpVerified(email: string): Promise<{ readonly cookie: string }> {
    const signup = await signUp(email);
    assert.equal(signup.statusCode, 200);
    assert.equal(sessionCookie(signup), null, 'password sign-up must not issue a session while unverified');
    await verifyMailbox(email);
    const signin = await post('/sign-in/email', { email, password: PASSWORD });
    assert.equal(signin.statusCode, 200, 'verified password sign-in must issue a session');
    const cookie = sessionCookie(signin);
    assert.ok(cookie, 'verified sign-in must set the session cookie');
    return { cookie };
  }

  async function userIdForEmail(email: string): Promise<string | null> {
    const result = await isolated.runtime.pool.query<{ id: string }>(
      'select id from "auth_users" where email = $1', [email],
    );
    return result.rows[0]?.id ?? null;
  }

  async function accountIdForAuthUser(authUserId: string): Promise<string | null> {
    const result = await isolated.runtime.pool.query<{ account_id: string }>(
      'select account_id from auth_user_account_map where auth_user_id = $1', [authUserId],
    );
    return result.rows[0]?.account_id ?? null;
  }

  /**
   * Establishes the A3 product metadata row for a BA-native session cookie
   * (the authority never authenticates a live BA session without metadata —
   * orphan sessions are rejected by design). The metadata snapshots the
   * CURRENT account epoch, so a later epoch bump revokes it.
   */
  async function establishSessionMetadata(sessionValue: string, accountId: string): Promise<void> {
    const token = sessionValue.slice(0, sessionValue.lastIndexOf('.'));
    const lookupHashes = createBetterAuthSessionTokenProtector(
      runtimeConfig.sessionTokenProtection,
    ).lookupHashes(token);
    const sessionRow = await isolated.runtime.pool.query<{ id: string; token: string }>(
      'select id, token from auth_sessions where "tokenLookupHash" = any($1::text[])',
      [lookupHashes],
    );
    const row = sessionRow.rows[0];
    assert.ok(row, 'the BA session row must exist for the issued cookie');
    assert.notEqual(row.token, token, 'the raw bearer token must not be stored');
    // The metadata SNAPSHOTS the account epoch at mint time (the authority
    // compares it with the CURRENT account epoch on every authenticate), so
    // the helper reads the live epoch instead of hard-coding a zero.
    const epochRow = await isolated.runtime.pool.query<{ security_epoch: string }>(
      'select security_epoch from accounts where id = $1', [accountId],
    );
    assert.equal(epochRow.rowCount, 1, 'the account must exist for the metadata row');
    const securityEpoch = epochRow.rows[0]!.security_epoch;
    const now = new Date();
    await isolated.runtime.pool.query(
      `insert into known_auth_session_metadata (
        auth_session_id, session_token_hash, account_id, idle_expires_at, absolute_expires_at,
        security_epoch, csrf_token_hash, predecessor_session_id, last_seen_at, revoked_at, created_at
       ) values ($1,$2,$3,$4,$5,$6,$7,NULL,$8,NULL,$9)
       on conflict (auth_session_id) do nothing`,
      [
        row.id,
        browserSessionTokenHash(token),
        accountId,
        new Date(now.getTime() + 86_400_000),
        new Date(now.getTime() + 30 * 86_400_000),
        securityEpoch,
        browserSessionCsrfTokenHash(deriveBrowserSessionCsrfTokenRaw(token)),
        now,
        now,
      ],
    );
  }

  /** Sign-in with 2FA enabled; returns the pending challenge cookie. */
  async function startPendingSignIn(email: string): Promise<{ readonly pendingCookie: string }> {
    const res = await post('/sign-in/email', { email, password: PASSWORD });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body) as { twoFactorRedirect?: boolean; twoFactorMethods?: string[] };
    assert.equal(body.twoFactorRedirect, true, '2FA-enabled sign-in must enter the pending challenge');
    assert.deepEqual(body.twoFactorMethods, ['totp']);
    // No USABLE session cookie may be issued during the challenge (BA may
    // include an expired/cleared session cookie; an empty value is not a
    // session).
    const session = sessionCookie(res);
    assert.equal(session === null || session === '', true, 'no usable session cookie may be issued during the challenge');
    const pending = mfaPendingCookie(res);
    assert.ok(pending, 'the pending challenge cookie must be set');
    return { pendingCookie: cookieHeaderValue(MFA_COOKIE_NAME, pending) };
  }

  function sinkEntriesFor(email: string) {
    return sink.entries.filter((entry) => entry.to === email);
  }

  async function enableMfa(email: string): Promise<{ readonly cookie: string; readonly backupCodes: string[] }> {
    const { cookie } = await signUpVerified(email);
    const sessionHeader = cookieHeaderValue(SESSION_COOKIE_NAME, cookie);
    const enroll = await post('/two-factor/enable', { password: PASSWORD }, {
      'content-type': 'application/json', origin: TRUSTED_ORIGIN, cookie: sessionHeader,
    });
    assert.equal(enroll.statusCode, 200);
    const body = JSON.parse(enroll.body) as { totpURI?: string; backupCodes?: string[] };
    assert.match(body.totpURI ?? '', /^otpauth:\/\/totp\//u);
    assert.ok(body.backupCodes && body.backupCodes.length === 10, 'enrollment must show ten backup codes once');

    // The plugin keeps `twoFactorEnabled=false` until the FIRST successful
    // TOTP verification (enrollment proof). Verify with the session and the
    // real code computed from the encrypted stored secret; the plugin then
    // rotates the session cookie.
    const userId = await userIdForEmail(email);
    assert.ok(userId);
    const row = await isolated.runtime.pool.query<{ secret: string }>(
      'select secret from auth_two_factor where "userId" = $1', [userId],
    );
    assert.equal(row.rows.length, 1);
    const secret = Buffer.from(baDecrypt(baSecret, row.rows[0]!.secret));
    const verify = await post('/two-factor/verify-totp', {
      code: totpForCounter(secret, currentTotpCounter(30)),
    }, {
      'content-type': 'application/json', origin: TRUSTED_ORIGIN, cookie: sessionHeader,
    });
    assert.equal(verify.statusCode, 200, 'the enrollment TOTP must verify');
    const rotated = sessionCookie(verify) ?? cookie;
    const flag = await isolated.runtime.pool.query<{ twoFactorEnabled: boolean }>(
      'select "twoFactorEnabled" from auth_users where id = $1', [userId],
    );
    assert.equal(flag.rows[0]?.twoFactorEnabled, true, 'the enrollment verification must enable the flag');
    return { cookie: rotated, backupCodes: body.backupCodes };
  }

  async function totpSecretForUser(userId: string): Promise<Uint8Array> {
    const row = await isolated.runtime.pool.query<{ secret: string }>(
      'select secret from auth_two_factor where "userId" = $1', [userId],
    );
    assert.equal(row.rows.length, 1, 'the twoFactor row must remain after a security event');
    return Buffer.from(baDecrypt(baSecret, row.rows[0]!.secret));
  }

  async function currentTotpForUser(userId: string): Promise<string> {
    return totpForCounter(await totpSecretForUser(userId), currentTotpCounter(30));
  }

  async function verificationRowsForUser(userId: string): Promise<number> {
    const result = await isolated.runtime.pool.query<{ n: number }>(
      'select count(*)::int n from auth_verifications where value = $1', [userId],
    );
    return result.rows[0]!.n;
  }

  // -------------------------------------------------------------------------
  // MFA / TOTP
  // -------------------------------------------------------------------------

  test('TOTP enrollment stores the secret and backup codes encrypted at rest and shows the codes once', async () => {
    const email = uniqueEmail('mfa-enroll');
    const { cookie, backupCodes } = await enableMfa(email);
    const userId = await userIdForEmail(email);
    assert.ok(userId);

    const row = await isolated.runtime.pool.query<{ secret: string; backupCodes: string; verified: boolean }>(
      'select secret, "backupCodes", verified from auth_two_factor where "userId" = $1', [userId],
    );
    assert.equal(row.rows.length, 1);
    const stored = row.rows[0]!;
    assert.equal(stored.verified, true);
    // Encrypted at rest: the stored secret is hex ciphertext, not a
    // plaintext/base32 secret; the backup code blob is not the JSON array.
    assert.match(stored.secret, /^[0-9a-f]+$/u);
    assert.equal(stored.secret.includes(backupCodes[0]!), false);
    assert.equal(stored.backupCodes.includes(backupCodes[0]!), false, 'backup codes must be encrypted, not plaintext JSON');
    const rawSecret = Buffer.from(baDecrypt(baSecret, stored.secret));
    assert.equal(rawSecret.length, 32, 'the decrypted TOTP secret must be the 32-char random secret');
    const decryptedCodes = JSON.parse(Buffer.from(baDecrypt(baSecret, stored.backupCodes)).toString('utf8')) as string[];
    assert.deepEqual(decryptedCodes, backupCodes, 'the encrypted blob must round-trip to the shown codes');

    // viewBackupCodes is serverOnly in 1.7.1 — it must never be mounted.
    const view = await get('/two-factor/view-backup-codes');
    assert.equal(view.statusCode, 404, 'the server-only view-backup-codes endpoint must not be exposed');

    // The shown codes complete a REAL sign-in (recovery proof is covered by
    // the dedicated single-use test below).

    // Two-factor flag on the auth user.
    const userFlag = await isolated.runtime.pool.query<{ twoFactorEnabled: boolean }>(
      'select "twoFactorEnabled" from auth_users where id = $1', [userId],
    );
    assert.equal(userFlag.rows[0]?.twoFactorEnabled, true);

    // The session that enabled MFA stays usable (after the A3 metadata row
    // is established for the BA-native session).
    const enrollAccountId = await accountIdForAuthUser(userId);
    assert.ok(enrollAccountId);
    await establishSessionMetadata(cookie, enrollAccountId);
    const actor = await authority.authenticate({ cookie: cookieHeaderValue(SESSION_COOKIE_NAME, cookie) });
    assert.ok(actor, 'the enrolling session remains a valid business session');
  });

  test('recovery codes are single-use: the code completes one sign-in and fails on the next challenge', async () => {
    const email = uniqueEmail('mfa-recovery');
    const { backupCodes } = await enableMfa(email);

    // First challenge: code #1 completes the sign-in (session issued).
    const first = await startPendingSignIn(email);
    const ok = await post('/two-factor/verify-backup-code', { code: backupCodes[0] }, {
      'content-type': 'application/json', origin: TRUSTED_ORIGIN, cookie: first.pendingCookie,
    });
    assert.equal(ok.statusCode, 200);
    const firstSession = sessionCookie(ok);
    assert.ok(firstSession, 'a successful recovery must issue the session cookie');
    const session = await get('/get-session?disableRefresh=true', {
      cookie: cookieHeaderValue(SESSION_COOKIE_NAME, firstSession),
    });
    assert.equal(JSON.parse(session.body).user.email, email);

    // Second challenge: the SAME code is refused (single use).
    const second = await startPendingSignIn(email);
    const replay = await post('/two-factor/verify-backup-code', { code: backupCodes[0] }, {
      'content-type': 'application/json', origin: TRUSTED_ORIGIN, cookie: second.pendingCookie,
    });
    assert.equal(replay.statusCode, 401);
    assert.equal((JSON.parse(replay.body) as { code?: string }).code, 'INVALID_BACKUP_CODE');
    assert.equal(sessionCookie(replay), null, 'a replayed code must not issue a session');

    // A fresh code still works on the same challenge.
    const fresh = await post('/two-factor/verify-backup-code', { code: backupCodes[1] }, {
      'content-type': 'application/json', origin: TRUSTED_ORIGIN, cookie: second.pendingCookie,
    });
    assert.equal(fresh.statusCode, 200);
    assert.ok(sessionCookie(fresh));
  });

  test('P5: password change expires 2FA trust-device so a copied cookie cannot skip TOTP', async () => {
    const email = uniqueEmail('mfa-trust-change');
    const { cookie: enrollCookie } = await enableMfa(email);
    const userId = await userIdForEmail(email);
    assert.ok(userId);
    await post('/sign-out', {}, {
      ...JSON_POST_HEADERS, cookie: cookieHeaderValue(SESSION_COOKIE_NAME, enrollCookie),
    });
    const pending = await startPendingSignIn(email);
    const trusted = await post('/two-factor/verify-totp', {
      code: await currentTotpForUser(userId),
      trustDevice: true,
    }, {
      'content-type': 'application/json', origin: TRUSTED_ORIGIN, cookie: pending.pendingCookie,
    });
    assert.equal(trusted.statusCode, 200, 'TOTP with trustDevice must complete the challenge');
    const trustedSession = sessionCookie(trusted);
    assert.ok(trustedSession, 'trustDevice verify must issue a session');
    const trust = trustDeviceCookie(trusted);
    assert.ok(trust && trust.value, 'trustDevice must set known.trust_device');
    assert.ok(await verificationRowsForUser(userId) >= 1, 'the plugin must persist a trust-device verification row');

    await post('/sign-out', {}, {
      ...JSON_POST_HEADERS, cookie: cookieHeaderValue(SESSION_COOKIE_NAME, trustedSession),
    });
    const skipped = await post('/sign-in/email', { email, password: PASSWORD }, {
      ...JSON_POST_HEADERS, cookie: cookieHeaderValue(TRUST_DEVICE_COOKIE_NAME, trust.value),
    });
    assert.equal(skipped.statusCode, 200);
    const skippedBody = JSON.parse(skipped.body) as { twoFactorRedirect?: boolean };
    assert.notEqual(skippedBody.twoFactorRedirect, true, 'precondition: a trusted browser must skip TOTP');
    const skippedSession = sessionCookie(skipped);
    assert.ok(skippedSession, 'precondition: trusted sign-in must issue a session');

    const changed = await post('/change-password', {
      currentPassword: PASSWORD, newPassword: NEW_PASSWORD,
    }, {
      ...JSON_POST_HEADERS, cookie: cookieHeaderValue(SESSION_COOKIE_NAME, skippedSession),
    });
    assert.equal(changed.statusCode, 200, 'change-password must succeed');
    const successor = sessionCookie(changed);
    assert.ok(successor, 'the current successor session must still be issued');
    assert.ok(trustDeviceExpiredOnResponse(changed), 'change-password must Set-Cookie Max-Age=0 on known.trust_device');
    const successorSession = await get('/get-session?disableRefresh=true', {
      cookie: cookieHeaderValue(SESSION_COOKIE_NAME, successor),
    });
    assert.equal(JSON.parse(successorSession.body).user.email, email, 'the successor session must still be a logged-in session');
    assert.equal(await verificationRowsForUser(userId), 0, 'trust-device verification rows must be gone');
    const flag = await isolated.runtime.pool.query<{ twoFactorEnabled: boolean }>(
      'select "twoFactorEnabled" from auth_users where id = $1', [userId],
    );
    assert.equal(flag.rows[0]?.twoFactorEnabled, true, 'password change must not disable 2FA');
    assert.equal((await totpSecretForUser(userId)).length, 32, 'the TOTP secret must remain');

    const again = await post('/sign-in/email', { email, password: NEW_PASSWORD }, {
      ...JSON_POST_HEADERS, cookie: cookieHeaderValue(TRUST_DEVICE_COOKIE_NAME, trust.value),
    });
    assert.equal(again.statusCode, 200);
    const againBody = JSON.parse(again.body) as { twoFactorRedirect?: boolean; twoFactorMethods?: string[] };
    assert.equal(againBody.twoFactorRedirect, true, 'a copied trust cookie must not skip TOTP after password change');
    assert.deepEqual(againBody.twoFactorMethods, ['totp']);
    const againSession = sessionCookie(again);
    assert.equal(againSession === null || againSession === '', true, 'no usable session until TOTP');
  });

  test('P5: password reset clears 2FA trust-device so the next sign-in requires TOTP', async () => {
    const email = uniqueEmail('mfa-trust-reset');
    const { cookie: enrollCookie } = await enableMfa(email);
    const userId = await userIdForEmail(email);
    assert.ok(userId);
    await post('/sign-out', {}, {
      ...JSON_POST_HEADERS, cookie: cookieHeaderValue(SESSION_COOKIE_NAME, enrollCookie),
    });
    const pending = await startPendingSignIn(email);
    const trusted = await post('/two-factor/verify-totp', {
      code: await currentTotpForUser(userId),
      trustDevice: true,
    }, {
      'content-type': 'application/json', origin: TRUSTED_ORIGIN, cookie: pending.pendingCookie,
    });
    assert.equal(trusted.statusCode, 200);
    const trust = trustDeviceCookie(trusted);
    assert.ok(trust && trust.value, 'trustDevice must set known.trust_device');

    await post('/sign-out', {}, {
      ...JSON_POST_HEADERS,
      cookie: cookieHeaderValue(SESSION_COOKIE_NAME, sessionCookie(trusted) ?? ''),
    });
    const skipped = await post('/sign-in/email', { email, password: PASSWORD }, {
      ...JSON_POST_HEADERS, cookie: cookieHeaderValue(TRUST_DEVICE_COOKIE_NAME, trust.value),
    });
    assert.notEqual(
      (JSON.parse(skipped.body) as { twoFactorRedirect?: boolean }).twoFactorRedirect,
      true,
      'precondition: trusted sign-in must skip TOTP before reset',
    );
    assert.ok(sessionCookie(skipped));

    const request = await post('/request-password-reset', { email });
    assert.equal(request.statusCode, 200);
    const resetEntry = sinkEntriesFor(email).find((entry) => entry.subject.includes('Reset'));
    assert.ok(resetEntry);
    const resetToken = resetEntry.textBody.match(/reset-password\/([A-Za-z0-9_-]+)/u)?.[1];
    assert.ok(resetToken);
    const reset = await post('/reset-password', { token: resetToken, newPassword: NEW_PASSWORD });
    assert.equal(reset.statusCode, 200, 'the password reset must complete');
    assert.equal(await verificationRowsForUser(userId), 0, 'reset must drop trust-device verification rows');
    const flag = await isolated.runtime.pool.query<{ twoFactorEnabled: boolean }>(
      'select "twoFactorEnabled" from auth_users where id = $1', [userId],
    );
    assert.equal(flag.rows[0]?.twoFactorEnabled, true, 'password reset must not disable 2FA');

    const again = await post('/sign-in/email', { email, password: NEW_PASSWORD }, {
      ...JSON_POST_HEADERS, cookie: cookieHeaderValue(TRUST_DEVICE_COOKIE_NAME, trust.value),
    });
    assert.equal(again.statusCode, 200);
    const againBody = JSON.parse(again.body) as { twoFactorRedirect?: boolean; twoFactorMethods?: string[] };
    assert.equal(againBody.twoFactorRedirect, true, 'a copied trust cookie must not skip TOTP after password reset');
    assert.deepEqual(againBody.twoFactorMethods, ['totp']);
    const againSession = sessionCookie(again);
    assert.equal(againSession === null || againSession === '', true, 'no usable session until TOTP');
  });

  test('TOTP verify: real code completes the challenge; the pending challenge is single-use (replay denied)', async () => {
    const email = uniqueEmail('mfa-totp');
    const { cookie } = await enableMfa(email);
    const userId = await userIdForEmail(email);
    assert.ok(userId);
    const row = await isolated.runtime.pool.query<{ secret: string }>(
      'select secret from auth_two_factor where "userId" = $1', [userId],
    );
    const secret = Buffer.from(baDecrypt(baSecret, row.rows[0]!.secret));

    // The enroll session is revoked by sign-out; a fresh sign-in enters the
    // pending challenge.
    await authority.signOut({ cookie: cookieHeaderValue(SESSION_COOKIE_NAME, cookie) });
    const challenge = await startPendingSignIn(email);

    const code = totpForCounter(secret, currentTotpCounter(30));
    const verify = await post('/two-factor/verify-totp', { code }, {
      'content-type': 'application/json', origin: TRUSTED_ORIGIN, cookie: challenge.pendingCookie,
    });
    assert.equal(verify.statusCode, 200);
    const issued = sessionCookie(verify);
    assert.ok(issued, 'a valid TOTP must complete the sign-in');
    const session = await get('/get-session?disableRefresh=true', {
      cookie: cookieHeaderValue(SESSION_COOKIE_NAME, issued),
    });
    assert.equal(JSON.parse(session.body).user.email, email);

    // Replay: the pending challenge was consumed — the same cookie is
    // refused even with a fresh valid code.
    const replayChallenge = await startPendingSignIn(email);
    const replayed = await post('/two-factor/verify-totp', { code: totpForCounter(secret, currentTotpCounter(30)) }, {
      'content-type': 'application/json', origin: TRUSTED_ORIGIN, cookie: replayChallenge.pendingCookie,
    });
    assert.equal(replayed.statusCode, 200, 'the first use of the fresh challenge succeeds');
    const replay2 = await post('/two-factor/verify-totp', { code: totpForCounter(secret, currentTotpCounter(30)) }, {
      'content-type': 'application/json', origin: TRUSTED_ORIGIN, cookie: replayChallenge.pendingCookie,
    });
    assert.equal(replay2.statusCode, 401);
    assert.equal((JSON.parse(replay2.body) as { code?: string }).code, 'INVALID_TWO_FACTOR_COOKIE');
  });

  test('TOTP clock skew: a code two periods in the past is rejected, one period in the past is accepted (window=1)', async () => {
    const email = uniqueEmail('mfa-skew');
    await enableMfa(email);
    const userId = await userIdForEmail(email);
    assert.ok(userId);
    const row = await isolated.runtime.pool.query<{ secret: string }>(
      'select secret from auth_two_factor where "userId" = $1', [userId],
    );
    const secret = Buffer.from(baDecrypt(baSecret, row.rows[0]!.secret));

    // The plugin verifies against ITS OWN floor(now/period) with a ±1
    // window, so a probe is meaningful only when the 30s boundary does not
    // roll over between the code computation and the server verification.
    // Read the counter right before the request and RE-RUN the probe (fresh
    // challenge, fresh counter) when the boundary rolled over in flight — a
    // failed code never consumes the challenge, so a rolled-over attempt is
    // simply discarded and retried.
    const attemptWithOffset = async (offset: number, attemptsLeft = 3) => {
      const before = currentTotpCounter(30);
      const challenge = await startPendingSignIn(email);
      const response = await post('/two-factor/verify-totp', { code: totpForCounter(secret, before + offset) }, {
        'content-type': 'application/json', origin: TRUSTED_ORIGIN, cookie: challenge.pendingCookie,
      });
      if (currentTotpCounter(30) === before) return response;
      if (attemptsLeft <= 0) throw new Error('the TOTP skew probe raced a 30s boundary on every attempt');
      return attemptWithOffset(offset, attemptsLeft - 1);
    };

    const stale = await attemptWithOffset(-2);
    assert.equal(stale.statusCode, 401, 'a code two periods old is outside the ±1 window (INVALID_CODE)');
    assert.equal((JSON.parse(stale.body) as { code?: string }).code, 'INVALID_CODE');

    const skew = await attemptWithOffset(-1);
    assert.equal(skew.statusCode, 200, 'a code one period old is inside the ±1 window');
    assert.ok(sessionCookie(skew));
  });

  test('the MFA pending session is never a full business session (real BA + A3 facade)', async () => {
    const email = uniqueEmail('mfa-pending');
    await enableMfa(email);
    const pending = await startPendingSignIn(email);

    // Real BA get-session with ONLY the pending cookie: no session.
    const baSession = await get('/get-session?disableRefresh=true', { cookie: pending.pendingCookie });
    assert.deepEqual(JSON.parse(baSession.body), null, 'BA must not resolve a session from the pending cookie');

    // A3 facade: the pending cookie never authenticates and never bootstraps.
    assert.equal(await authority.authenticate({ cookie: pending.pendingCookie }), null);
    assert.deepEqual(await authority.bootstrap({ cookie: pending.pendingCookie }), { authenticated: false });
    // signOut with only the pending cookie is a no-op (nothing to revoke).
    await authority.signOut({ cookie: pending.pendingCookie });
  });

  // -------------------------------------------------------------------------
  // Security epoch bridge (real Sync + MCP verifier entries)
  // -------------------------------------------------------------------------

  test('password reset raises the epoch: product session, Sync session and MCP OAuth credential all die via real verifiers', async () => {
    const email = uniqueEmail('epoch-reset');
    const { cookie: sessionValue } = await signUpVerified(email);
    const sessionHeader = cookieHeaderValue(SESSION_COOKIE_NAME, sessionValue);
    const userId = await userIdForEmail(email);
    assert.ok(userId);
    const accountId = await accountIdForAuthUser(userId);
    assert.ok(accountId);
    await establishSessionMetadata(sessionValue, accountId);

    const actor = await authority.authenticate({ cookie: sessionHeader });
    assert.ok(actor, 'the verified session must authenticate through the authority');
    const subjectId = actor.account.subjectId;

    // --- Sync session bound to the account at the CURRENT epoch ---
    // The collection <-> root-node FKs are circular (collections_root_fk is
    // DEFERRABLE INITIALLY DEFERRED, nodes.collection_id is immediate), so
    // the fixture rows must be written in ONE transaction — the deferred
    // constraint is only checked at commit, while the immediate FK needs the
    // collection row to exist before the node insert.
    await isolated.runtime.pool.query(
      "insert into resource_id_ledger(resource_id,resource_type) values ($1,'collection'),($2,'node') on conflict do nothing",
      [`c4-col-${accountId}`, `c4-root-${accountId}`],
    );
    const fixtureClient = await isolated.runtime.pool.connect();
    try {
      await fixtureClient.query('begin');
      await fixtureClient.query(
        `insert into collections
          (id,owner_subject_id,title,kind,root_node_id,resource_revision,content_revision,policy_revision)
          values ($1,$2,'C4','bookmarks',$3,'r1','c1','p1') on conflict do nothing`,
        [`c4-col-${accountId}`, subjectId, `c4-root-${accountId}`],
      );
      await fixtureClient.query(
        `insert into nodes (id,collection_id,kind,is_root,title,resource_revision,children_revision)
          values ($1,$2,'folder',true,'Root','r1','ch1') on conflict do nothing`,
        [`c4-root-${accountId}`, `c4-col-${accountId}`],
      );
      // The Sync issuer resolves the account through account_identities
      // (issuer+subject), the same binding the verifier re-checks on every
      // verify (credential_digest + security_epoch snapshot).
      await fixtureClient.query(
        `insert into account_identities(id,account_id,issuer,subject) values ($1,$2,$3,$4) on conflict do nothing`,
        [`c4-identity-${accountId}`, accountId, SYNC_ISSUER, subjectId],
      );
      await fixtureClient.query('commit');
    } catch (error) {
      await fixtureClient.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      fixtureClient.release();
    }
    const syncCredential: VerifiedExtensionCredential = await mintVerifiedExtensionCredentialFixture({
      issuer: SYNC_ISSUER, audience: SYNC_AUDIENCE, clientId: SYNC_CLIENT_ID,
      subject: subjectId, credentialId: `c4-sync-${randomUUID()}`,
    });
    const replicaStore = createPostgresReplicaStore(isolated.runtime.db, { ids: {
      deviceId: () => `c4-device-${accountId}`,
      replicaId: () => `c4-replica-${accountId}`,
      leaseId: () => `c4-lease-${accountId}`,
    } });
    const replica: ReplicaRecord = await replicaStore.create({
      accountId, collectionId: `c4-col-${accountId}`, deviceName: 'Laptop', replicaName: 'Chrome',
      kind: 'browser_extension',
      adapter: { profile: 'chromium-bookmarks-v1', version: '1.0.0' },
      capabilities: {
        read: true, write: true, events: true, separator: false, alias: false,
        annotations: 'sidecar' as const, maxBatchOperations: 1,
      },
      binding: { browserProfileId: `c4-profile-${accountId}`, mountMode: 'mounted-folder',
        browserGeneration: `c4-install-${accountId}` },
      leaseDurationSeconds: 3_600,
    }, { actorAccountId: accountId });
    const syncIssuer = createPostgresSyncSessionIssuer(isolated.runtime.db, {
      issuer: SYNC_ISSUER, audience: SYNC_AUDIENCE, clientId: SYNC_CLIENT_ID,
      replayEncryptionKey: SYNC_REPLAY_KEY, sessionDurationSeconds: 900,
      replicaLeaseExtensionSeconds: 3_600, tombstoneRetentionSeconds: 86_400,
      maxBatchOperations: 1, replayEncryptionKeyVersion: 7,
      endpointCapabilities: ['syncSnapshot', 'syncPush', 'syncPull', 'syncAck', 'syncConflict'],
    });
    const issued = await syncIssuer.issue({
      credential: syncCredential,
      idempotencyKey: `c4-idem-${randomUUID()}`,
      requestFingerprint: `c4-fp-${randomUUID()}`,
      collectionId: `c4-col-${accountId}`,
      replicaId: replica.replicaId,
      expectedLeaseGeneration: replica.leaseGeneration,
      expectedLifecycleRevision: replica.lifecycleRevision,
      binding: replica.binding,
      requestedScopes: ['sync:bootstrap', 'sync:pull', 'sync:push'],
      origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop',
    });
    const syncSessionId = issued.envelope.sessionId;
    // The sync session is usable BEFORE the security event (setup proof).
    const verifiedSync = await syncIssuer.verify({
      credential: syncCredential, sessionId: syncSessionId,
      collectionId: `c4-col-${accountId}`, replicaId: replica.replicaId,
    });
    // VerifiedSyncSession is the active session record itself (top-level
    // status), not a wrapper object.
    assert.equal(verifiedSync.status, 'active');

    // --- MCP OAuth credential issued BEFORE the security event ---
    // Mint at the current unix second so setup verify cannot lose to the
    // store's creation-second boundary (iat < effectiveAt). After mint,
    // wait until a later unix second so the bump's effectiveAt is strictly
    // after this credential's iat and the post-event verify is revoked.
    const issuedAt = Math.floor(Date.now() / 1000);
    const mcpToken = await mintMcpToken(mcpKey, mcpKid, subjectId, issuedAt);
    const mcpResult = await mcpVerifier.verify({ authorization: `Bearer ${mcpToken}` });
    assert.equal(mcpResult.evidence.principalId, `account:${subjectId}`);
    assert.equal(mcpResult.accountSubjectId, subjectId);

    // --- The security event: real password reset + the epoch bridge ---
    const request = await post('/request-password-reset', { email });
    assert.equal(request.statusCode, 200);
    const resetEntry = sinkEntriesFor(email).find((entry) => entry.subject.includes('Reset'));
    assert.ok(resetEntry);
    const resetToken = resetEntry.textBody.match(/reset-password\/([A-Za-z0-9_-]+)/u)?.[1];
    assert.ok(resetToken);
    const reset = await post('/reset-password', { token: resetToken, newPassword: NEW_PASSWORD });
    assert.equal(reset.statusCode, 200, 'the password reset must complete');
    await waitForCondition(
      () => Math.floor(Date.now() / 1000) > issuedAt,
      {
        timeoutMs: 2_000,
        pollIntervalMs: 10,
        description: 'the security-event epoch to cross the credential issuance second',
      },
    );
    const result = await bridge.raiseAccountSecurityEvent('password_reset', accountId);
    assert.ok(result.securityEpoch > 0n);
    const epochRow = await isolated.runtime.pool.query<{ security_epoch: string }>(
      'select security_epoch from accounts where id = $1', [accountId],
    );
    assert.equal(BigInt(epochRow.rows[0]!.security_epoch), result.securityEpoch);

    // Product session: the pre-event browser session is dead.
    assert.equal(await authority.authenticate({ cookie: sessionHeader }), null);
    // New sign-in with the NEW password works and the epoch is inherited.
    const freshSignIn = await post('/sign-in/email', { email, password: NEW_PASSWORD });
    assert.equal(freshSignIn.statusCode, 200);
    const freshSession = sessionCookie(freshSignIn);
    assert.ok(freshSession);
    await establishSessionMetadata(freshSession, accountId);
    const freshActor = await authority.authenticate({ cookie: cookieHeaderValue(SESSION_COOKIE_NAME, freshSession) });
    assert.ok(freshActor);
    assert.equal(freshActor.account.id, accountId, 'the same business account survives the reset');

    // Sync: the pre-event session is rejected by the REAL verifier (epoch
    // snapshot mismatch), even though the credential itself is untouched.
    await assert.rejects(
      syncIssuer.verify({
        credential: syncCredential, sessionId: syncSessionId,
        collectionId: `c4-col-${accountId}`, replicaId: replica.replicaId,
      }),
      (error: unknown) => error instanceof SyncSessionIssueError
        && (error.code === 'credential_invalid' || error.code === 'session_revoked'),
    );

    // MCP OAuth: the pre-event credential is rejected by the REAL verifier
    // through the revocation store epoch boundary.
    await assert.rejects(
      mcpVerifier.verify({ authorization: `Bearer ${mcpToken}` }),
      (error: unknown) => error instanceof McpOauthVerificationError && error.reason === 'revoked',
    );
    // A credential issued AFTER the event is accepted.
    const freshToken = await mintMcpToken(mcpKey, mcpKid, subjectId, Math.floor(Date.now() / 1000));
    const freshMcp = await mcpVerifier.verify({ authorization: `Bearer ${freshToken}` });
    assert.equal(freshMcp.evidence.principalId, `account:${subjectId}`);
    assert.equal(freshMcp.accountSubjectId, subjectId);
  });

  test('MFA disable through the policy raises the epoch and revokes the current session', async () => {
    const email = uniqueEmail('mfa-disable');
    const { cookie, backupCodes } = await enableMfa(email);
    const userId = await userIdForEmail(email);
    assert.ok(userId);
    const enrollAccountId = await accountIdForAuthUser(userId);
    assert.ok(enrollAccountId);
    const sessionHeader = cookieHeaderValue(SESSION_COOKIE_NAME, cookie);
    await establishSessionMetadata(cookie, enrollAccountId);
    const actor = await authority.authenticate({ cookie: sessionHeader });
    assert.ok(actor);
    const accountId = actor.account.id;
    assert.equal(accountId, enrollAccountId);

    // Complete one full 2FA sign-in so a post-enroll session exists.
    await authority.signOut({ cookie: sessionHeader });
    const pending = await startPendingSignIn(email);
    const verified = await post('/two-factor/verify-backup-code', { code: backupCodes[2] }, {
      'content-type': 'application/json', origin: TRUSTED_ORIGIN, cookie: pending.pendingCookie,
    });
    assert.equal(verified.statusCode, 200);
    const postMfaSession = sessionCookie(verified);
    assert.ok(postMfaSession);
    const postMfaHeader = cookieHeaderValue(SESSION_COOKIE_NAME, postMfaSession);
    await establishSessionMetadata(postMfaSession, accountId);
    assert.ok(await authority.authenticate({ cookie: postMfaHeader }));

    // Disable through the policy (session + re-auth): the epoch must bump.
    await mfaPolicy.disable({ cookie: postMfaHeader, password: PASSWORD });
    const epochRow = await isolated.runtime.pool.query<{ security_epoch: string }>(
      'select security_epoch from accounts where id = $1', [accountId],
    );
    assert.equal(BigInt(epochRow.rows[0]!.security_epoch), 1n, 'MFA disable must bump the account security epoch');
    assert.equal(await authority.authenticate({ cookie: postMfaHeader }), null, 'the pre-disable session must be revoked');

    // The MFA state is gone: a fresh sign-in no longer challenges.
    const signIn = await post('/sign-in/email', { email, password: PASSWORD });
    assert.equal(signIn.statusCode, 200);
    assert.ok(sessionCookie(signIn), 'after disable, password sign-in completes without a challenge');
  });

  test('wrong re-auth on MFA operations is refused before any server write', async () => {
    const email = uniqueEmail('mfa-reauth');
    const { cookie } = await enableMfa(email);
    // The enroll session must be a full A3 business session BEFORE the
    // disable attempt: the policy gate (requireMutationActor) refuses
    // orphan BA sessions that lack the product metadata row.
    const userId = await userIdForEmail(email);
    assert.ok(userId);
    const accountId = await accountIdForAuthUser(userId);
    assert.ok(accountId);
    await establishSessionMetadata(cookie, accountId);
    const sessionHeader = cookieHeaderValue(SESSION_COOKIE_NAME, cookie);

    await assert.rejects(
      mfaPolicy.disable({ cookie: sessionHeader, password: 'wrong-password' }), // secret-scan: allow 'wrong-password'
      (error: unknown) => error instanceof MfaPolicyError && error.code === 'reauth_failed',
    );
    const row = await isolated.runtime.pool.query<{ n: number }>(
      `select count(*)::int n from auth_two_factor t join auth_users u on u.id = t."userId" where u.email = $1`,
      [email],
    );
    assert.equal(row.rows[0]!.n, 1, 'a failed re-auth must not delete the twoFactor row');
    const flag = await isolated.runtime.pool.query<{ twoFactorEnabled: boolean }>(
      `select "twoFactorEnabled" from auth_users where email = $1`, [email],
    );
    assert.equal(flag.rows[0]?.twoFactorEnabled, true, 'a failed re-auth must not disable MFA');
  });
});

function uniqueEmail(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}@example.test`;
}

function mapMfaServerError(error: unknown): never {
  if (error instanceof MfaPolicyError) throw error;
  const code = error instanceof Error && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : error instanceof Error && typeof (error as { body?: { code?: unknown } }).body?.code === 'string'
      ? (error as { body: { code: string } }).body.code
      : '';
  switch (code) {
    case 'INVALID_PASSWORD':
      throw new MfaPolicyError('reauth_failed', 'the re-authentication proof is invalid');
    case 'INVALID_TWO_FACTOR_COOKIE':
      throw new MfaPolicyError('challenge_invalid', 'the two-factor challenge is invalid or was already used');
    case 'INVALID_CODE':
    case 'INVALID_BACKUP_CODE':
      throw new MfaPolicyError('invalid_code', 'the two-factor code is invalid');
    case 'TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE':
      throw new MfaPolicyError('too_many_attempts', 'too many verification attempts; start a new sign-in');
    case 'ACCOUNT_TEMPORARILY_LOCKED':
      throw new MfaPolicyError('account_locked', 'the account is temporarily locked');
    case 'TOTP_NOT_ENABLED':
      throw new MfaPolicyError('mfa_not_enabled', 'two-factor authentication is not enabled');
    default:
      throw new MfaPolicyError('mfa_unavailable', 'the two-factor service is temporarily unavailable');
  }
}
