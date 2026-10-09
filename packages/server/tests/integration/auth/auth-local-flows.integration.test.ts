import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, test, vi } from 'vitest';
import { betterAuth } from 'better-auth';
import Fastify from 'fastify';
import { loadConfig } from '../../support/test-config.js';
import { buildBetterAuthConfig } from '../../../src/modules/auth/better-auth-config.js';
import {
  applyFetchResponse,
  buildBetterAuthOptions,
  fastifyRequestToFetchRequest,
  SIGNUP_OTP_INTENT_HEADER,
  SIGNUP_OTP_INTENT_VALUE,
} from '../../../src/infrastructure/auth/better-auth-runtime.js';
import { createArgon2idPasswordHasher } from '../../../src/infrastructure/auth/argon2id-password-hasher.js';
import { createVerificationDigestStore } from '../../../src/infrastructure/auth/verification-digest-store.js';
import { createPostgresBusinessAccountUnitOfWork } from '../../../src/infrastructure/auth/business-account-unit-of-work.js';
import { createAuthEmailAdapter, createInProcessMailboxSink } from '../../../src/infrastructure/email/auth-email-adapter.js';
import { createLogger } from '../../../src/infrastructure/telemetry/index.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';
import {
  authEmailIdempotencyKey,
  otpIdentifierDigest,
  otpValueDigest,
  resetIdentifierDigest,
} from '../../../src/modules/auth/index.js';
import { translateBetterAuthError } from '../../../src/transport/product-error.js';
import { processBetterAuthResponse } from '../../../src/transport/auth/better-auth-routes.js';
import { BETTER_AUTH_PRODUCT_WIRE } from '../../support/better-auth-product-wire.js';

/**
 * Task C2 local auth flows over REAL PostgreSQL + the REAL Better Auth 1.7.1
 * handler through the verified Fastify bridge (G0 §3.1) with the C1 auth
 * email sender (in-process mailbox sink in test mode) and the A2 business
 * account establishment unit of work.
 *
 * 假阴性防护:
 * - auth_verifications rows are READ from PostgreSQL and asserted digest-only:
 *   identifier/value never equal the sent OTP/token (spike §4.3);
 * - OTP TTL is covered with a fake clock (vi fake Date), attempts are counted
 *   on the real stored row, the Argon2id password is verified with a REAL
 *   @node-rs/argon2 verify, and wrong/unknown email sign-in latency is
 *   measured over multiple requests (median), never a single sample;
 * - resend rotation is proven by two DIFFERENT delivered OTPs and the old OTP
 *   failing after the resend.
 *
 * 假阳性防护:
 * - no flow is accepted on `success: true` alone: every success completes the
 *   session cookie (native BA get-session), the business mapping
 *   (auth_user_account_map + accounts rows created through the A2 facade),
 *   and a cookie-reusing mutation (change-password);
 * - the product endpoints `/api/v1/session` and `/api/v1/me` are NOT used:
 *   A3 (BrowserSessionAuthority) is not committed yet, so session evidence is
 *   BA native get-session + mapping checks (plan §9 Task C2 note).
 */

const TRUSTED_ORIGIN = 'https://app.example.test';
const BASE_PATH = '/api/v1/auth';
const PASSWORD = 'password-123'; // secret-scan: allow 'password-123'
const NEW_PASSWORD = 'new-password-456';

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
    BETTER_AUTH_EMAIL_OTP_ENABLED: 'true',
    ...overrides,
  };
}

function captureLogger() {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk: unknown, _encoding: unknown, done: () => void) {
      lines.push(String(chunk));
      done();
    },
  });
  return { logger: createLogger('info', destination), lines };
}

function uniqueEmail(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}@example.test`;
}

describeWithPostgres('C2 local auth flows: Argon2id + digest-only OTP/reset/verification (real PostgreSQL)', () => {
  let isolated: IsolatedPostgresRuntime;
  let app: ReturnType<typeof Fastify>;
  let sink: ReturnType<typeof createInProcessMailboxSink>;
  let runtimeLog: ReturnType<typeof captureLogger>;
  let digestStore: ReturnType<typeof createVerificationDigestStore>;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('c2_auth_local_flows', {
      maxConnections: 10,
      applicationName: 'known-c2-auth-local-flows-test',
    });
    await runMigrations(isolated.runtime.db, 'latest');

    const config = loadConfig(testEnv());
    const built = buildBetterAuthConfig(config.betterAuth);
    assert.ok(built, 'enabled config must produce Better Auth settings');

    sink = createInProcessMailboxSink();
    const sender = createAuthEmailAdapter({ provider: sink.provider, logger: createLogger('silent') });
    runtimeLog = captureLogger();
    const unitOfWork = createPostgresBusinessAccountUnitOfWork(isolated.runtime.db);

    const auth = betterAuth(buildBetterAuthOptions({
      enabled: true,
      config: built,
      database: { db: isolated.runtime.db, type: 'postgres', transaction: true },
      authEmail: sender,
      businessAccount: { unitOfWork },
      logger: runtimeLog.logger,
    }));

    // Test-only full-surface mount: every BA endpoint through the REAL bridge
    // (the allowlist mount is A1/A4's concern; this suite needs the emailOTP
    // plugin and reset/verification endpoints).
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

    digestStore = createVerificationDigestStore(isolated.runtime.db);
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

  function sessionCookie(res: { cookies?: unknown }): string | null {
    const cookies = (res.cookies ?? []) as Array<{ name: string; value: string }>;
    return cookies.find((cookie) => cookie.name === '__Host-known_session')?.value ?? null;
  }

  async function getSession(cookie: string | null): Promise<{ statusCode: number; body: string }> {
    const headers = cookie === null ? {} : { cookie: `__Host-known_session=${cookie}` };
    return get('/get-session?disableRefresh=true', headers);
  }

  async function signUp(email: string, password = PASSWORD) {
    return post('/sign-up/email', { name: 'C2 User', email, password });
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
    if (autoCookie !== null) {
      await post('/sign-out', {}, { ...JSON_POST_HEADERS, cookie: `__Host-known_session=${autoCookie}` });
    }
  }

  async function signUpVerified(email: string, password = PASSWORD): Promise<{
    readonly cookie: string;
    readonly userId: string;
  }> {
    const signup = await signUp(email, password);
    assert.equal(signup.statusCode, 200);
    await verifyMailbox(email);
    const signin = await post('/sign-in/email', { email, password });
    assert.equal(signin.statusCode, 200, 'verified password sign-in must issue a session');
    const cookie = sessionCookie(signin);
    assert.ok(cookie, 'verified sign-in must set the session cookie');
    const userId = await userIdForEmail(email);
    assert.ok(userId);
    return { cookie, userId };
  }

  function sinkEntriesFor(email: string) {
    return sink.entries.filter((entry) => entry.to === email);
  }

  function lastOtpFor(email: string): string {
    const entry = sinkEntriesFor(email).at(-1);
    assert.ok(entry, `no OTP email was delivered to ${email}`);
    const match = entry.textBody.match(/\b\d{6}\b/u);
    assert.ok(match, 'OTP email body must contain the 6-digit code');
    return match[0];
  }

  async function userIdForEmail(email: string): Promise<string | null> {
    const result = await isolated.runtime.pool.query<{ id: string }>(
      `select id from "auth_users" where email = $1`, [email],
    );
    return result.rows[0]?.id ?? null;
  }

  async function sessionCount(userId: string): Promise<number> {
    const result = await isolated.runtime.pool.query<{ n: number }>(
      `select count(*)::int n from auth_sessions where "userId" = $1`, [userId],
    );
    return result.rows[0]?.n ?? 0;
  }

  async function tableCount(table: string): Promise<number> {
    const result = await isolated.runtime.pool.query<{ n: number }>(
      `select count(*)::int n from ${table}`,
    );
    return result.rows[0]?.n ?? 0;
  }

  /**
   * This suite mounts the BA Fastify bridge without production onSend
   * (wrapping the catch-all onRequest + applyFetchResponse route is fragile).
   * Keep asserting the runtime still emits the BA code, then prove the
   * product wire by running the production translators on the inject body.
   */
  function assertBaCodeAndProductWire(
    res: { readonly statusCode: number; readonly body: string },
    baCode: string,
    product: { readonly code: string; readonly status: number; readonly message: string },
  ): void {
    const baBody = JSON.parse(res.body) as { readonly code?: string; readonly message?: string };
    assert.equal(baBody.code, baCode, `BA bridge must still emit ${baCode}`);

    const translated = translateBetterAuthError(res.statusCode, baBody);
    assert.ok(translated, `${baCode} must have a product translation`);
    assert.equal(translated.productCode, product.code, `${baCode} -> product code`);
    assert.equal(translated.statusCode, product.status, `${baCode} -> canonical product status`);
    assert.equal(translated.message, product.message, `${baCode} -> fixed product message`);

    const reply = { statusCode: res.statusCode, getHeader: () => undefined };
    const payload = processBetterAuthResponse(
      { id: 'c2-ba-bridge-product-wire' } as never,
      reply as never,
      res.body,
    );
    assert.equal(
      reply.statusCode,
      product.status,
      `${baCode}: onSend rewrites BA status ${res.statusCode} to canonical ${product.status}`,
    );
    const envelope = JSON.parse(String(payload)) as { error?: { code?: string; message?: string }; code?: string };
    assert.equal(envelope.error?.code, product.code);
    assert.equal(envelope.error?.message, product.message);
    assert.equal(envelope.code, undefined, 'product wire is the nested envelope, not a bare BA code');
    const wire = String(payload);
    assert.equal(wire.includes(baCode), false, `${baCode} must not appear on the product wire`);
    if (typeof baBody.message === 'string' && baBody.message.length > 0) {
      assert.equal(wire.includes(baBody.message), false, `${baCode}: BA message must never reach the product wire`);
    }
  }

  function productWire(baCode: keyof typeof BETTER_AUTH_PRODUCT_WIRE): {
    readonly code: string;
    readonly status: number;
    readonly message: string;
  } {
    const row = BETTER_AUTH_PRODUCT_WIRE[baCode];
    return { code: row.productCode, status: row.statusCode, message: row.message };
  }

  const PRODUCT_INVALID_OTP = productWire('INVALID_OTP');
  const PRODUCT_OTP_EXPIRED = productWire('OTP_EXPIRED');
  const PRODUCT_TOO_MANY_ATTEMPTS = productWire('TOO_MANY_ATTEMPTS');
  const PRODUCT_SIGNUP_OCCUPANCY = productWire('USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL');

  test('new sign-up: Argon2id credential, no product actor until verified', async () => {
    const email = uniqueEmail('signup');
    const res = await signUp(email);
    assert.equal(res.statusCode, 200);
    const cookie = sessionCookie(res);
    assert.equal(cookie, null, 'password sign-up must not admit a product session while unverified');

    const session = await getSession(null);
    assert.equal(session.statusCode, 200);
    assert.equal(session.body, 'null', 'no BA session exists after unverified sign-up');

    const userId = await userIdForEmail(email);
    assert.ok(userId, 'sign-up must still create the auth user');

    // Real Argon2id storage: the PHC string carries the frozen parameters and
    // a REAL verify round-trips (never a string compare).
    const credential = await isolated.runtime.pool.query<{ password: string }>(
      `select password from auth_accounts where "userId" = $1 and "providerId" = 'credential'`,
      [userId],
    );
    assert.equal(credential.rows.length, 1);
    const storedHash = credential.rows[0]!.password;
    assert.match(storedHash, /^\$argon2id\$v=19\$m=19456,t=2,p=1\$/u);
    assert.equal(storedHash.includes(PASSWORD), false, 'plaintext password must never be stored');
    const hasher = createArgon2idPasswordHasher();
    assert.equal(await hasher.verify({ hash: storedHash, password: PASSWORD }), true);
    assert.equal(await hasher.verify({ hash: storedHash, password: 'wrong-password' }), false); // secret-scan: allow 'wrong-password'

    // Business account establishment through the A2 facade (post-commit hook).
    const established = await isolated.runtime.pool.query<{ accounts: number; profiles: number; handles: number; mappings: number }>(
      `select
         (select count(*)::int from accounts a join auth_user_account_map m on m.account_id = a.id where m.auth_user_id = $1) accounts,
         (select count(*)::int from profiles p join auth_user_account_map m on m.account_id = p.account_id where m.auth_user_id = $1) profiles,
         (select count(*)::int from profile_handles h join auth_user_account_map m on m.account_id = h.account_id where m.auth_user_id = $1) handles,
         (select count(*)::int from auth_user_account_map m where m.auth_user_id = $1) mappings`,
      [userId],
    );
    const establishedRow = established.rows[0];
    assert.ok(establishedRow);
    assert.equal(establishedRow.accounts, 1, 'sign-up must create the business account');
    assert.equal(establishedRow.profiles, 1, 'sign-up must create the profile');
    assert.equal(establishedRow.handles, 1, 'sign-up must create the profile handle');
    assert.equal(establishedRow.mappings, 1, 'sign-up must establish the mapping');
    const accountEmail = await isolated.runtime.pool.query<{ email: string | null }>(
      `select a.email from accounts a join auth_user_account_map m on m.account_id = a.id where m.auth_user_id = $1`,
      [userId],
    );
    assert.equal(accountEmail.rows[0]?.email, null, 'an unverified email must not be stored on the business account');

    // sign-up with sendOnSignUp queues the verification email through C1.
    const entries = sinkEntriesFor(email);
    assert.equal(entries.length, 1);
    assert.match(entries[0]!.subject, /Verify your Know-N email/u);
    assert.equal(entries[0]!.idempotencyKey.includes(email), false, 'idempotency key must be digest-only');
    assert.equal(entries[0]!.idempotencyKey, authEmailIdempotencyKey('email-verification', email));

    const unverifiedSignIn = await post('/sign-in/email', { email, password: PASSWORD });
    assert.equal(unverifiedSignIn.statusCode, 403, 'unverified password sign-in must be EMAIL_NOT_VERIFIED');
    assert.equal((JSON.parse(unverifiedSignIn.body) as { code?: string }).code, 'EMAIL_NOT_VERIFIED');
    assert.equal(sessionCookie(unverifiedSignIn), null, 'unverified sign-in must not issue a session');

    await verifyMailbox(email);
    const verifiedSignIn = await post('/sign-in/email', { email, password: PASSWORD });
    assert.equal(verifiedSignIn.statusCode, 200);
    const verifiedCookie = sessionCookie(verifiedSignIn);
    assert.ok(verifiedCookie, 'after verification, password sign-in must issue a session');
    const verifiedSession = await getSession(verifiedCookie);
    const verifiedBody = JSON.parse(verifiedSession.body) as { user?: { email?: string; emailVerified?: boolean } };
    assert.equal(verifiedBody.user?.email, email);
    assert.equal(verifiedBody.user?.emailVerified, true);
    const productEmail = await isolated.runtime.pool.query<{ email: string | null }>(
      `select a.email from accounts a join auth_user_account_map m on m.account_id = a.id where m.auth_user_id = $1`,
      [userId],
    );
    assert.equal(productEmail.rows[0]?.email, email, 'mailbox verification must write accounts.email');
  });

  test('duplicate registration is rejected without creating a second user or account', async () => {
    const email = uniqueEmail('duplicate');
    const first = await signUp(email);
    assert.equal(first.statusCode, 200);
    const usersBefore = await isolated.runtime.pool.query<{ n: number }>(
      `select count(*)::int n from "auth_users" where email = $1`, [email],
    );
    assert.equal(usersBefore.rows[0]?.n, 1);
    const second = await signUp(email);
    // requireEmailVerification returns a non-enumerating 200 synthetic user
    // (token null, no second row) instead of USER_ALREADY_EXISTS.
    assert.equal(second.statusCode, 200);
    assert.equal(sessionCookie(second), null, 'duplicate sign-up must not issue a session');
    const userId = await userIdForEmail(email);
    assert.ok(userId, 'the first registration must have created the auth user');
    const usersAfter = await isolated.runtime.pool.query<{ n: number }>(
      `select count(*)::int n from "auth_users" where email = $1`, [email],
    );
    assert.equal(usersAfter.rows[0]?.n, 1, 'duplicate sign-up must not create a second auth user');
    const mappingCount = await isolated.runtime.pool.query<{ n: number }>(
      `select count(*)::int n from auth_user_account_map where auth_user_id = $1`, [userId],
    );
    assert.equal(mappingCount.rows[0]?.n, 1, 'duplicate registration must not mint a second mapping');
  });

  test('sign-in: wrong password and unknown email are indistinguishable (status, body, timing)', async () => {
    const email = uniqueEmail('timing');
    const signup = await signUp(email);
    assert.equal(signup.statusCode, 200);
    const knownUserId = await userIdForEmail(email);
    assert.ok(knownUserId);

    // One warm-up request per path before measuring.
    await post('/sign-in/email', { email, password: 'definitely-wrong' }); // secret-scan: allow 'definitely-wrong'
    await post('/sign-in/email', { email: uniqueEmail('nobody'), password: 'definitely-wrong' }); // secret-scan: allow 'definitely-wrong'

    async function medianLatency(target: { email: string; password: string }): Promise<number> {
      const samples: number[] = [];
      for (let i = 0; i < 5; i += 1) {
        const start = performance.now();
        const res = await post('/sign-in/email', target);
        assert.equal(res.statusCode, 401);
        samples.push(performance.now() - start);
      }
      samples.sort((a, b) => a - b);
      return samples[2]!;
    }

    const wrongBody = (await post('/sign-in/email', { email, password: 'wrong-password-1' })).body; // secret-scan: allow 'wrong-password-1'
    const unknownEmail = uniqueEmail('ghost');
    const unknownBody = (await post('/sign-in/email', { email: unknownEmail, password: 'wrong-password-1' })).body; // secret-scan: allow 'wrong-password-1'
    assert.deepEqual(JSON.parse(unknownBody), JSON.parse(wrongBody), 'unknown email must return the identical 401 body');
    assert.equal((JSON.parse(wrongBody) as { code?: string }).code, 'INVALID_EMAIL_OR_PASSWORD');

    const wrongMs = await medianLatency({ email, password: 'wrong-password-1' }); // secret-scan: allow 'wrong-password-1'
    const unknownMs = await medianLatency({ email: unknownEmail, password: 'wrong-password-1' }); // secret-scan: allow 'wrong-password-1'
    // Two-sided timing bound: the unknown-email path must be neither
    // measurably faster (the enumeration oracle — BA's dummy argon2 hash
    // keeps it honest today) nor pathologically slower than the wrong-email
    // path. Median of 5 samples per side, generous 3x+25ms margin.
    assert.ok(
      unknownMs <= wrongMs * 3 + 25 && wrongMs <= unknownMs * 3 + 25,
      `unknown email must not be measurably faster or slower than wrong password (unknown=${unknownMs.toFixed(1)}ms wrong=${wrongMs.toFixed(1)}ms)`,
    );

    const success = await post('/sign-in/email', { email, password: PASSWORD });
    assert.equal(success.statusCode, 403);
    assert.equal((JSON.parse(success.body) as { code?: string }).code, 'EMAIL_NOT_VERIFIED');
    await verifyMailbox(email);
    const verified = await post('/sign-in/email', { email, password: PASSWORD });
    assert.equal(verified.statusCode, 200);
    const cookie = sessionCookie(verified);
    assert.ok(cookie);
    const session = await getSession(cookie);
    assert.equal(JSON.parse(session.body).user.email, email);
  });

  test('OTP sign-in: digest-only storage, single use, correct-code success with cookie', async () => {
    const email = uniqueEmail('otp-ok');
    const signup = await signUp(email);
    assert.equal(signup.statusCode, 200);

    const send = await post('/email-otp/send-verification-otp', { email, type: 'sign-in' });
    assert.equal(send.statusCode, 200);
    assert.equal((JSON.parse(send.body) as { success?: boolean }).success, true);
    const otp = lastOtpFor(email);

    // Digest-only storage: the stored identifier/value never equal the sent
    // OTP and match the frozen sha256 base64url contract exactly.
    const row = await digestStore.findOtpRow('sign-in', email);
    assert.ok(row, 'OTP row must exist under the digest identifier');
    assert.equal(row.identifier, otpIdentifierDigest('sign-in', email));
    assert.equal(row.value, otpValueDigest(otp, 0));
    digestStore.assertOtpRowDigestOnly(row, { type: 'sign-in', email, sentOtp: otp });
    const rawRows = await isolated.runtime.pool.query<{ identifier: string; value: string }>(
      `select "identifier", "value" from auth_verifications`,
    );
    for (const raw of rawRows.rows) {
      assert.notEqual(raw.value, otp, 'the plaintext OTP must never appear in a verification row');
      assert.notEqual(raw.identifier, `sign-in-otp-${email}`, 'the raw identifier must never be stored');
    }

    // The hashed storage refuses to reveal the OTP: BA's plaintext read-back
    // endpoint (`get-verification-otp`) is serverOnly, i.e. NEVER mounted over
    // HTTP, so the request must 404 and the response must not contain the OTP.
    const leak = await get(`/email-otp/get-verification-otp?email=${encodeURIComponent(email)}&type=sign-in`);
    assert.equal(leak.statusCode, 404);
    assert.equal(leak.body.includes(otp), false, 'the 404 response must not leak the plaintext OTP');

    // Correct OTP completes the sign-in: session cookie + mapping already in place.
    const verify = await post('/sign-in/email-otp', { email, otp });
    assert.equal(verify.statusCode, 200);
    const cookie = sessionCookie(verify);
    assert.ok(cookie, 'OTP sign-in must set the session cookie');
    const session = await getSession(cookie);
    assert.equal(JSON.parse(session.body).user.email, email);
    assert.equal(await digestStore.findOtpRow('sign-in', email), null, 'OTP must be single-use (row consumed)');

    // Replay is rejected.
    const replay = await post('/sign-in/email-otp', { email, otp });
    assert.equal(replay.statusCode, 400);
    assertBaCodeAndProductWire(replay, 'INVALID_OTP', PRODUCT_INVALID_OTP);
  });

  test('OTP: invalid code increments the stored attempt counter, exhaustion is 403 and deletes the row', async () => {
    const email = uniqueEmail('otp-attempts');
    const signup = await signUp(email);
    assert.equal(signup.statusCode, 200);

    const send = await post('/email-otp/send-verification-otp', { email, type: 'sign-in' });
    assert.equal(send.statusCode, 200);
    const otp = lastOtpFor(email);

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const wrongOtp = otp === '000000' ? '000001' : '000000';
      const wrong = await post('/sign-in/email-otp', { email, otp: wrongOtp });
      assert.equal(wrong.statusCode, 400, `wrong attempt ${attempt}`);
      assertBaCodeAndProductWire(wrong, 'INVALID_OTP', PRODUCT_INVALID_OTP);
      const row = await digestStore.findOtpRow('sign-in', email);
      assert.ok(row, `row must survive wrong attempt ${attempt}`);
      assert.equal(row.value, otpValueDigest(otp, attempt), `attempt counter must be ${attempt} on the stored value`);
    }

    // The 4th attempt (even with the correct OTP) hits the 3-attempt cap.
    const exhausted = await post('/sign-in/email-otp', { email, otp });
    assert.equal(exhausted.statusCode, 403, 'BA still emits 403 FORBIDDEN for lockout');
    assertBaCodeAndProductWire(exhausted, 'TOO_MANY_ATTEMPTS', PRODUCT_TOO_MANY_ATTEMPTS);
    assert.equal(await digestStore.findOtpRow('sign-in', email), null, 'exhaustion must delete the row');
  });

  test('OTP: TTL expiry via fake clock returns OTP_EXPIRED and deletes the row', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const t0 = Date.now();
      vi.setSystemTime(t0);
      const email = uniqueEmail('otp-expiry');
      const signup = await post('/sign-up/email', { name: 'C2 User', email, password: PASSWORD });
      assert.equal(signup.statusCode, 200);

      const send = await post('/email-otp/send-verification-otp', { email, type: 'sign-in' });
      assert.equal(send.statusCode, 200);
      const otp = lastOtpFor(email);
      const row = await digestStore.findOtpRow('sign-in', email);
      assert.ok(row);

      vi.setSystemTime(t0 + 301_000);
      const verify = await post('/sign-in/email-otp', { email, otp });
      assert.equal(verify.statusCode, 400);
      assertBaCodeAndProductWire(verify, 'OTP_EXPIRED', PRODUCT_OTP_EXPIRED);
      assert.equal(await digestStore.findOtpRow('sign-in', email), null, 'expired OTP rows must be deleted');
    } finally {
      vi.useRealTimers();
    }
  });

  test('OTP resend rotates the code: the old OTP stops working, the new one signs in', async () => {
    const email = uniqueEmail('otp-rotate');
    const signup = await signUp(email);
    assert.equal(signup.statusCode, 200);

    const first = await post('/email-otp/send-verification-otp', { email, type: 'sign-in' });
    assert.equal(first.statusCode, 200);
    const otp1 = lastOtpFor(email);

    const second = await post('/email-otp/send-verification-otp', { email, type: 'sign-in' });
    assert.equal(second.statusCode, 200);
    const signInKey = authEmailIdempotencyKey('otp:sign-in', email);
    const entries = sinkEntriesFor(email).filter((entry) => entry.idempotencyKey === signInKey);
    assert.equal(entries.length, 2, 'resend must deliver a second OTP email for the same purpose');
    const otp2 = lastOtpFor(email);
    assert.notEqual(otp1, otp2, 'resend must rotate to a new code (hashed storage cannot reuse)');

    const row = await digestStore.findOtpRow('sign-in', email);
    assert.ok(row);
    assert.equal(row.value, otpValueDigest(otp2, 0), 'the stored value must match the NEW code');

    const oldCode = await post('/sign-in/email-otp', { email, otp: otp1 });
    assert.equal(oldCode.statusCode, 400, 'the rotated-out code must be rejected');
    const newCode = await post('/sign-in/email-otp', { email, otp: otp2 });
    assert.equal(newCode.statusCode, 200);
    assert.ok(sessionCookie(newCode));
  });

  test('OTP send for an unknown email is non-enumerating (same success shape, no silent signup)', async () => {
    // P6 login anchor: send type=sign-in WITHOUT the signup-intent header.
    // Deleting this byte-identical assertion (or making login enumerate) must fail CI.
    const knownEmail = uniqueEmail('otp-known');
    const knownSignup = await signUp(knownEmail);
    assert.equal(knownSignup.statusCode, 200);
    const knownSend = await post('/email-otp/send-verification-otp', { email: knownEmail, type: 'sign-in' });
    assert.equal(knownSend.statusCode, 200);
    const knownSignInKey = authEmailIdempotencyKey('otp:sign-in', knownEmail);
    assert.equal(
      sinkEntriesFor(knownEmail).filter((entry) => entry.idempotencyKey === knownSignInKey).length,
      1,
      'known-user login send must still deliver',
    );
    assert.ok(await digestStore.findOtpRow('sign-in', knownEmail), 'known-user login send must store the OTP');

    const unknownEmail = uniqueEmail('otp-unknown');
    const unknownSend = await post('/email-otp/send-verification-otp', { email: unknownEmail, type: 'sign-in' });
    assert.equal(unknownSend.statusCode, 200);
    assert.equal(
      unknownSend.body,
      knownSend.body,
      'P6: known vs unknown login send must be byte-identical HTTP 200 bodies',
    );
    assert.equal(sinkEntriesFor(unknownEmail).length, 0,
      'P2 disableSignUp: login send must not deliver an OTP for an unknown mailbox');
    assert.equal(await digestStore.findOtpRow('sign-in', unknownEmail), null,
      'P2 disableSignUp: login send must not leave an OTP row for an unknown mailbox');
    assert.equal(await userIdForEmail(unknownEmail), null, 'login send must not create an auth user');
  });

  test('login OTP verify for an unknown email does not create an auth user', async () => {
    const email = uniqueEmail('otp-login-unknown-verify');
    const verify = await post('/sign-in/email-otp', { email, otp: '123456' });
    assert.equal(verify.statusCode, 400);
    assertBaCodeAndProductWire(verify, 'INVALID_OTP', PRODUCT_INVALID_OTP);
    assert.equal(sessionCookie(verify), null);
    assert.equal(await userIdForEmail(email), null, 'login OTP must never create a user');
  });

  test('sign-up OTP intent refuses an existing email without sending', async () => {
    // P6 register anchor: WITH x-known-auth-intent: sign-up the already-registered
    // copy stays. Deleting the header check must fail this test. Same mailbox
    // without the header stays HTTP 200 (login non-enumeration).
    const email = uniqueEmail('otp-signup-existing');
    const signup = await signUp(email);
    assert.equal(signup.statusCode, 200);

    const loginSend = await post('/email-otp/send-verification-otp', { email, type: 'sign-in' });
    assert.equal(loginSend.statusCode, 200, 'P6: login send without the signup-intent header must not enumerate');

    const mailBefore = sink.sentCount;
    const send = await post('/email-otp/send-verification-otp', { email, type: 'sign-in' }, {
      ...JSON_POST_HEADERS,
      [SIGNUP_OTP_INTENT_HEADER]: SIGNUP_OTP_INTENT_VALUE,
    });
    assert.equal(send.statusCode, 422);
    assertBaCodeAndProductWire(send, 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL', PRODUCT_SIGNUP_OCCUPANCY);
    assert.equal(sink.sentCount, mailBefore, 'must not deliver a sign-up OTP to an existing mailbox');
  });

  test('sign-up OTP intent still sends for an unknown email', async () => {
    const email = uniqueEmail('otp-signup-new');
    const send = await post('/email-otp/send-verification-otp', { email, type: 'sign-in' }, {
      ...JSON_POST_HEADERS,
      [SIGNUP_OTP_INTENT_HEADER]: SIGNUP_OTP_INTENT_VALUE,
    });
    assert.equal(send.statusCode, 200);
    assert.equal(sinkEntriesFor(email).length, 1, 'a new mailbox must still receive the sign-up code');
    assert.ok(await digestStore.findOtpRow('sign-in', email), 'sign-up send must store the OTP for verify');
    assert.equal(await userIdForEmail(email), null, 'occupancy happens at verify, not send');
  });

  test('sign-up OTP verify with name + intent creates a verified user and session', async () => {
    const email = uniqueEmail('otp-signup-complete');
    const send = await post('/email-otp/send-verification-otp', { email, type: 'sign-in' }, {
      ...JSON_POST_HEADERS,
      [SIGNUP_OTP_INTENT_HEADER]: SIGNUP_OTP_INTENT_VALUE,
    });
    assert.equal(send.statusCode, 200);
    const otp = lastOtpFor(email);

    const verify = await post('/sign-in/email-otp', { email, otp, name: 'Ada Lovelace' }, {
      ...JSON_POST_HEADERS,
      [SIGNUP_OTP_INTENT_HEADER]: SIGNUP_OTP_INTENT_VALUE,
    });
    assert.equal(verify.statusCode, 200, 'explicit register OTP must create the session');
    const cookie = sessionCookie(verify);
    assert.ok(cookie, 'register OTP must set the session cookie');
    const userId = await userIdForEmail(email);
    assert.ok(userId, 'register OTP must create the auth user');
    const verified = await isolated.runtime.pool.query<{ emailVerified: boolean; name: string }>(
      `select "emailVerified", name from "auth_users" where id = $1`, [userId],
    );
    assert.equal(verified.rows[0]?.emailVerified, true, 'register OTP is mailbox proof');
    assert.equal(verified.rows[0]?.name, 'Ada Lovelace');
    const session = await getSession(cookie);
    assert.equal(JSON.parse(session.body).user.email, email);
    assert.equal(JSON.parse(session.body).user.emailVerified, true);
    assert.equal(await digestStore.findOtpRow('sign-in', email), null, 'OTP must be single-use');
    const mapping = await isolated.runtime.pool.query<{ n: number }>(
      `select count(*)::int n from auth_user_account_map where auth_user_id = $1`, [userId],
    );
    assert.equal(mapping.rows[0]?.n, 1, 'register OTP must establish the business mapping');
  });

  test('sign-up OTP verify without the intent header does not create a user', async () => {
    const email = uniqueEmail('otp-signup-no-header');
    const send = await post('/email-otp/send-verification-otp', { email, type: 'sign-in' }, {
      ...JSON_POST_HEADERS,
      [SIGNUP_OTP_INTENT_HEADER]: SIGNUP_OTP_INTENT_VALUE,
    });
    assert.equal(send.statusCode, 200);
    const otp = lastOtpFor(email);

    const verify = await post('/sign-in/email-otp', { email, otp, name: 'Ada Lovelace' });
    assert.equal(verify.statusCode, 400);
    assertBaCodeAndProductWire(verify, 'INVALID_OTP', PRODUCT_INVALID_OTP);
    assert.equal(sessionCookie(verify), null);
    assert.equal(await userIdForEmail(email), null, 'login-shaped verify must not create');
  });

  test('sign-up OTP verify refuses an existing email', async () => {
    const email = uniqueEmail('otp-signup-verify-existing');
    const signup = await signUp(email);
    assert.equal(signup.statusCode, 200);
    const usersBefore = await isolated.runtime.pool.query<{ n: number }>(
      `select count(*)::int n from "auth_users" where email = $1`, [email],
    );
    const verify = await post('/sign-in/email-otp', { email, otp: '123456', name: 'Ada Lovelace' }, {
      ...JSON_POST_HEADERS,
      [SIGNUP_OTP_INTENT_HEADER]: SIGNUP_OTP_INTENT_VALUE,
    });
    assert.equal(verify.statusCode, 422);
    assertBaCodeAndProductWire(verify, 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL', PRODUCT_SIGNUP_OCCUPANCY);
    const usersAfter = await isolated.runtime.pool.query<{ n: number }>(
      `select count(*)::int n from "auth_users" where email = $1`, [email],
    );
    assert.equal(usersAfter.rows[0]?.n, usersBefore.rows[0]?.n);
  });

  test('email verification (JWT): success, replay is an idempotent no-op, no resend', async () => {
    const email = uniqueEmail('verify');
    const signup = await signUp(email);
    assert.equal(signup.statusCode, 200);
    const userId = await userIdForEmail(email);
    assert.ok(userId);

    const verifyKey = authEmailIdempotencyKey('email-verification', email);
    const entries = sinkEntriesFor(email).filter((entry) => entry.idempotencyKey === verifyKey);
    assert.equal(entries.length, 1, 'sign-up (sendOnSignUp) must deliver the verification email');
    const lastBody = entries.at(-1)!.textBody;
    assert.ok(lastBody.includes(`${TRUSTED_ORIGIN}/verify-email?token=`),
      'the verification link must land on the product /verify-email page');
    assert.equal(lastBody.includes('/api/v1/auth/verify-email'), false,
      'the verification link must not point at the Better Auth API path');
    const token = lastBody.match(/token=([A-Za-z0-9._~-]+)/u)?.[1];
    assert.ok(token, 'the verification email must carry the JWT');

    const verify = await get(`/verify-email?token=${token}`);
    assert.equal(verify.statusCode, 200);
    assert.equal((JSON.parse(verify.body) as { status?: boolean }).status, true);
    const verified = await isolated.runtime.pool.query<{ emailVerified: boolean }>(
      `select "emailVerified" from "auth_users" where id = $1`, [userId],
    );
    assert.equal(verified.rows[0]?.emailVerified, true);
    assert.equal(sessionCookie(verify), null,
      'mailbox verification must preserve the pre-existing browser session');
    const signin = await post('/sign-in/email', { email, password: PASSWORD });
    assert.equal(signin.statusCode, 200, 'verified password sign-in must issue a session');
    const cookie = sessionCookie(signin);
    assert.ok(cookie, 'explicit verified sign-in must mint the session');

    // Replay of the same JWT is an idempotent no-op: same response, no state
    // change, no new session, no second email.
    const sessionsBefore = await sessionCount(userId);
    const mailBefore = sink.sentCount;
    const replay = await get(`/verify-email?token=${token}`);
    assert.equal(replay.statusCode, 200);
    assert.deepEqual(JSON.parse(replay.body), { status: true, user: null });
    assert.equal(await sessionCount(userId), sessionsBefore, 'replay must not mint a session');
    assert.equal(sink.sentCount, mailBefore, 'replay must not resend the verification email');

    // A verified user cannot request another verification email (no spam).
    const resend = await post('/send-verification-email', { email }, { ...JSON_POST_HEADERS, cookie: `__Host-known_session=${cookie}` });
    assert.equal(resend.statusCode, 400);
    assert.equal((JSON.parse(resend.body) as { code?: string }).code, 'EMAIL_ALREADY_VERIFIED');
  });

  test('sessionless verification request: known and unknown email are indistinguishable and timed', async () => {
    const knownEmail = uniqueEmail('verify-sessionless');
    const signup = await signUp(knownEmail);
    assert.equal(signup.statusCode, 200);
    const mailBefore = sink.sentCount;

    async function timedRequest(email: string): Promise<{ statusCode: number; body: string; ms: number }> {
      const start = performance.now();
      const res = await post('/send-verification-email', { email });
      return { statusCode: res.statusCode, body: res.body, ms: performance.now() - start };
    }

    const known = await timedRequest(knownEmail);
    const unknown = await timedRequest(uniqueEmail('verify-ghost'));
    assert.equal(known.statusCode, 200);
    assert.equal(unknown.statusCode, 200);
    assert.deepEqual(JSON.parse(unknown.body), JSON.parse(known.body), 'identical non-enumerating response');
    assert.equal(sink.sentCount, mailBefore + 1, 'only the known unverified email receives the mail');
    assert.ok(known.ms >= 450, `sessionless verification must enforce the constant-time floor (${known.ms.toFixed(0)}ms)`);
    assert.ok(unknown.ms >= 450, `unknown email must pay the same floor (${unknown.ms.toFixed(0)}ms)`);
    assert.ok(unknown.ms <= known.ms + 600, 'unknown must not be faster than known by more than delivery noise');
  });

  test('password reset (token): digest-only row, revokeSessionsOnPasswordReset, single-use replay', async () => {
    const email = uniqueEmail('reset');
    const signup = await signUp(email);
    assert.equal(signup.statusCode, 200);
    const userId = await userIdForEmail(email);
    assert.ok(userId);
    assert.equal(await sessionCount(userId), 0, 'password sign-up must not mint a session');
    await verifyMailbox(email);

    const request = await post('/request-password-reset', { email });
    assert.equal(request.statusCode, 200);
    const requestBody = JSON.parse(request.body) as { status?: boolean };
    assert.equal(requestBody.status, true);
    const resetEntry = sinkEntriesFor(email).find((entry) => entry.subject.includes('Reset'));
    assert.ok(resetEntry, 'the reset email must be delivered through the C1 sender');
    const token = resetEntry.textBody.match(/reset-password\/([A-Za-z0-9_-]+)/u)?.[1];
    assert.ok(token);

    // Digest-only reset row: identifier is the token digest, value is the user id.
    const row = await digestStore.findResetRow(token);
    assert.ok(row, 'reset row must exist under the digest identifier');
    assert.equal(row.identifier, resetIdentifierDigest(token));
    assert.notEqual(row.identifier, `reset-password:${token}`, 'the raw token must never be stored');
    assert.equal(row.value, userId, 'reset rows carry the user id as value (G1 §8)');
    digestStore.assertResetRowDigestOnly(row, token);

    // The callback redirect validates the row over HTTP.
    const callback = await get(`/reset-password/${token}?callbackURL=${encodeURIComponent(`${TRUSTED_ORIGIN}/`)}`);
    assert.equal(callback.statusCode, 302);
    assert.match(String(callback.headers.location), /token=/u);

    const reset = await post('/reset-password', { token, newPassword: NEW_PASSWORD });
    assert.equal(reset.statusCode, 200);
    assert.equal(await sessionCount(userId), 0, 'revokeSessionsOnPasswordReset must delete every session');
    assert.equal(await digestStore.findResetRow(token), null, 'reset tokens are single-use');

    // Old password dead, new password works, and the session is usable.
    const oldPassword = await post('/sign-in/email', { email, password: PASSWORD });
    assert.equal(oldPassword.statusCode, 401);
    const newPassword = await post('/sign-in/email', { email, password: NEW_PASSWORD });
    assert.equal(newPassword.statusCode, 200);
    assert.ok(sessionCookie(newPassword));
    const session = await getSession(sessionCookie(newPassword));
    assert.equal(JSON.parse(session.body).user.email, email);

    // Replay of the consumed token is rejected.
    const replay = await post('/reset-password', { token, newPassword: 'another-password-789' });
    assert.equal(replay.statusCode, 400);
    assert.equal((JSON.parse(replay.body) as { code?: string }).code, 'INVALID_TOKEN');
  });

  test('password reset for an unknown email returns the identical non-enumerating response', async () => {
    const email = uniqueEmail('reset-known');
    const signup = await signUp(email);
    assert.equal(signup.statusCode, 200);
    const known = await post('/request-password-reset', { email });
    assert.equal(known.statusCode, 200);

    const mailBefore = sink.sentCount;
    const unknown = await post('/request-password-reset', { email: uniqueEmail('reset-ghost') });
    assert.equal(unknown.statusCode, 200);
    assert.deepEqual(JSON.parse(unknown.body), JSON.parse(known.body), 'identical status/message for unknown email');
    assert.equal(sink.sentCount, mailBefore, 'no reset email may be sent for unknown emails');
  });

  test('OTP password reset: OTP proof, session revocation, verified email, single-use', async () => {
    const email = uniqueEmail('reset-otp');
    const signup = await signUp(email);
    assert.equal(signup.statusCode, 200);
    const userId = await userIdForEmail(email);
    assert.ok(userId);

    const send = await post('/email-otp/send-verification-otp', { email, type: 'forget-password' });
    assert.equal(send.statusCode, 200);
    const otp = lastOtpFor(email);
    const row = await digestStore.findOtpRow('forget-password', email);
    assert.ok(row);
    assert.equal(row.value, otpValueDigest(otp, 0));

    const reset = await post('/email-otp/reset-password', { email, otp, password: NEW_PASSWORD });
    assert.equal(reset.statusCode, 200);
    assert.equal(await sessionCount(userId), 0, 'OTP reset must revoke every session');
    assert.equal(await digestStore.findOtpRow('forget-password', email), null, 'the OTP is single-use');
    const verified = await isolated.runtime.pool.query<{ emailVerified: boolean }>(
      `select "emailVerified" from "auth_users" where id = $1`, [userId],
    );
    assert.equal(verified.rows[0]?.emailVerified, true, 'a forget-password OTP is a verified-email proof');

    const oldPassword = await post('/sign-in/email', { email, password: PASSWORD });
    assert.equal(oldPassword.statusCode, 401);
    const newPassword = await post('/sign-in/email', { email, password: NEW_PASSWORD });
    assert.equal(newPassword.statusCode, 200);

    const replay = await post('/email-otp/reset-password', { email, otp, password: 'another-password-789' }); // secret-scan: allow 'another-password-789'
    assert.equal(replay.statusCode, 400);
    assertBaCodeAndProductWire(replay, 'INVALID_OTP', PRODUCT_INVALID_OTP);
  });

  test('change-password: always revokes other sessions and keeps the successor', async () => {
    const email = uniqueEmail('change-pw');
    const { cookie: cookieA, userId } = await signUpVerified(email);

    const signin = await post('/sign-in/email', { email, password: PASSWORD });
    const cookieB = sessionCookie(signin);
    assert.ok(cookieB);
    assert.notEqual(cookieA, cookieB);
    assert.equal(await sessionCount(userId), 2);

    const change = await post('/change-password', { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
      { ...JSON_POST_HEADERS, cookie: `__Host-known_session=${cookieA}` });
    assert.equal(change.statusCode, 200);
    assert.equal(await sessionCount(userId), 1, 'change-password must leave exactly one session');
    const newCookie = sessionCookie(change);
    assert.ok(newCookie);
    assert.notEqual(newCookie, cookieA, 'the current session must be replaced by a fresh one');
    for (const cookie of [cookieA, cookieB]) {
      const session = await getSession(cookie);
      assert.equal(JSON.parse(session.body), null, 'revoked sessions must no longer resolve (get-session null)');
    }
    const fresh = await getSession(newCookie);
    assert.equal(JSON.parse(fresh.body).user.email, email);

    const oldPassword = await post('/sign-in/email', { email, password: PASSWORD });
    assert.equal(oldPassword.statusCode, 401);
  });

  test('OTP purposes are stored separately: sign-in and forget-password never collide', async () => {
    const email = uniqueEmail('purposes');
    const signup = await signUp(email);
    assert.equal(signup.statusCode, 200);

    await post('/email-otp/send-verification-otp', { email, type: 'sign-in' });
    await post('/email-otp/send-verification-otp', { email, type: 'forget-password' });
    const signInKey = authEmailIdempotencyKey('otp:sign-in', email);
    const forgetKey = authEmailIdempotencyKey('otp:forget-password', email);
    const signInOtp = sinkEntriesFor(email).filter((entry) => entry.idempotencyKey === signInKey).at(-1);
    const forgetOtp = sinkEntriesFor(email).filter((entry) => entry.idempotencyKey === forgetKey).at(-1);
    assert.ok(signInOtp && forgetOtp, 'each purpose must deliver its own email under its own digest key');
    assert.equal(signInOtp.subject, 'Your Know-N sign-in code');
    assert.equal(forgetOtp.subject, 'Your Know-N password reset code');
    assert.notEqual(signInOtp.idempotencyKey, forgetOtp.idempotencyKey, 'purpose separation must enter the email key');

    const signInRow = await digestStore.findOtpRow('sign-in', email);
    const forgetRow = await digestStore.findOtpRow('forget-password', email);
    assert.ok(signInRow && forgetRow, 'both purpose rows must exist under their own digest identifiers');
    assert.notEqual(signInRow.identifier, forgetRow.identifier, 'purpose separation must enter the identifier digest');

    // A forget-password OTP must not sign in.
    const misuse = await post('/sign-in/email-otp', { email, otp: lastOtpFor(email) });
    assert.equal(misuse.statusCode, 400, 'cross-purpose OTP use must be rejected');
  });

  test('P9: verified session changes email via OTP to a fresh mailbox (same auth_users.id)', async () => {
    const current = uniqueEmail('email-from');
    const next = uniqueEmail('email-to');
    const { cookie, userId } = await signUpVerified(current);
    const cookieHeader = { ...JSON_POST_HEADERS, cookie: `__Host-known_session=${cookie}` };

    const request = await post('/email-otp/request-email-change', { newEmail: next }, cookieHeader);
    assert.equal(request.statusCode, 200);
    assert.equal((JSON.parse(request.body) as { success?: boolean }).success, true);
    const changeKey = authEmailIdempotencyKey('otp:change-email', next);
    const changeMail = sinkEntriesFor(next).find((entry) => entry.idempotencyKey === changeKey);
    assert.ok(changeMail, 'change-email OTP must be delivered to the new mailbox');
    assert.equal(changeMail.subject, 'Your Know-N email change code');
    const otp = lastOtpFor(next);

    const confirm = await post('/email-otp/change-email', { newEmail: next, otp }, cookieHeader);
    assert.equal(confirm.statusCode, 200, 'change-email with the delivered OTP must succeed');
    const confirmBody = JSON.parse(confirm.body) as Record<string, unknown>;
    assert.equal('token' in confirmBody, false, 'R9: product/BA JSON must not include the session token');

    const row = await isolated.runtime.pool.query<{ id: string; email: string; emailVerified: boolean }>(
      `select id, email, "emailVerified" as "emailVerified" from "auth_users" where id = $1`,
      [userId],
    );
    assert.equal(row.rows[0]?.id, userId, 'email change must keep the same auth user id');
    assert.equal(row.rows[0]?.email, next);
    assert.equal(row.rows[0]?.emailVerified, true);
    const product = await isolated.runtime.pool.query<{ email: string | null }>(
      `select a.email from accounts a join auth_user_account_map m on m.account_id = a.id where m.auth_user_id = $1`,
      [userId],
    );
    assert.equal(product.rows[0]?.email, next, 'P9 must sync accounts.email to the new mailbox');
    assert.equal(await userIdForEmail(current), null, 'the previous mailbox must be unoccupied');

    const nextCookie = sessionCookie(confirm) ?? cookie;
    const session = await getSession(nextCookie);
    const sessionBody = JSON.parse(session.body) as { user?: { id?: string; email?: string; emailVerified?: boolean } };
    assert.equal(sessionBody.user?.id, userId);
    assert.equal(sessionBody.user?.email, next);
    assert.equal(sessionBody.user?.emailVerified, true);
  });

  test('P9: occupied target is non-enumerating on send and fail-closed on confirm', async () => {
    const current = uniqueEmail('email-holder');
    const taken = uniqueEmail('email-taken');
    const { cookie, userId } = await signUpVerified(current);
    const takenUser = await signUpVerified(taken);
    const takenMailBefore = sinkEntriesFor(taken).length;
    const changeKey = authEmailIdempotencyKey('otp:change-email', taken);
    const cookieHeader = { ...JSON_POST_HEADERS, cookie: `__Host-known_session=${cookie}` };

    const request = await post('/email-otp/request-email-change', { newEmail: taken }, cookieHeader);
    assert.equal(request.statusCode, 200, 'occupied target must not enumerate on send');
    assert.equal((JSON.parse(request.body) as { success?: boolean }).success, true);
    assert.equal(sinkEntriesFor(taken).length, takenMailBefore, 'occupied mailbox must not receive change-email mail');
    assert.equal(
      sinkEntriesFor(taken).filter((entry) => entry.idempotencyKey === changeKey).length,
      0,
    );

    const currentRow = await isolated.runtime.pool.query<{ email: string }>(
      `select email from "auth_users" where id = $1`,
      [userId],
    );
    assert.equal(currentRow.rows[0]?.email, current, 'first user email must stay unchanged after occupied send');

    const confirm = await post(
      '/email-otp/change-email',
      { newEmail: taken, otp: '000000' },
      cookieHeader,
    );
    assert.notEqual(confirm.statusCode, 200, 'guessed OTP must not steal an occupied mailbox');
    const afterCurrent = await isolated.runtime.pool.query<{ email: string }>(
      `select email from "auth_users" where id = $1`,
      [userId],
    );
    const afterTaken = await isolated.runtime.pool.query<{ email: string }>(
      `select email from "auth_users" where id = $1`,
      [takenUser.userId],
    );
    assert.equal(afterCurrent.rows[0]?.email, current, 'fail-closed: first email must not change');
    assert.equal(afterTaken.rows[0]?.email, taken, 'fail-closed: taken mailbox must stay with the second user');
  });

  test('P9: unauthenticated request-email-change is 401', async () => {
    const res = await post('/email-otp/request-email-change', { newEmail: uniqueEmail('anon-change') });
    assert.equal(res.statusCode, 401);
  });

  test('P10: Better Auth HTTP /delete-user stays disabled (product route owns deletion)', async () => {
    const email = uniqueEmail('ba-delete-disabled');
    const { cookie } = await signUpVerified(email);
    const res = await post('/delete-user', { password: PASSWORD }, {
      ...JSON_POST_HEADERS,
      cookie: `__Host-known_session=${cookie}`,
    });
    assert.equal(res.statusCode, 404, 'BA HTTP /delete-user must not be enabled');
    const stillThere = await userIdForEmail(email);
    assert.ok(stillThere, 'disabled BA delete-user must not remove the auth user');
  });

  test('password sign-up does not create a session even if auth_sessions is missing', async () => {
    const email = uniqueEmail('db-fail');
    const accountsBefore = await tableCount('accounts');
    const mappingsBefore = await tableCount('auth_user_account_map');
    const usersBefore = await tableCount('"auth_users"');
    const mailBefore = sink.sentCount;

    // P1: requireEmailVerification skips auto sign-in, so occupancy must
    // succeed without touching auth_sessions. Reverting that flag would
    // createSession against the dropped table and fail this test.
    await isolated.runtime.pool.query('drop table auth_sessions cascade');

    const res = await post('/sign-up/email', { name: 'Db Fail', email, password: PASSWORD });
    assert.equal(res.statusCode, 200, 'unverified occupancy must not depend on session creation');
    assert.equal(sessionCookie(res), null);
    assert.equal(sink.sentCount, mailBefore + 1, 'sign-up must still queue the verification email');

    assert.equal(await tableCount('"auth_users"'), usersBefore + 1);
    assert.equal(await tableCount('accounts'), accountsBefore + 1);
    assert.equal(await tableCount('auth_user_account_map'), mappingsBefore + 1);
    const userId = await userIdForEmail(email);
    assert.ok(userId, 'the auth user must survive without a session row');
  });
});
