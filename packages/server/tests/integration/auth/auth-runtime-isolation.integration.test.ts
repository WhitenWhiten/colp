/**
 * Task F2 integration test: the REAL production startApi process in Better
 * Auth mode with ZERO legacy OIDC env (plan §12 Task F2; G1 ADR §16).
 *
 * 假阴性防护:
 * - the startup smoke runs as a CHILD PROCESS (`node --import tsx
 *   src/bootstrap/api.ts`): startApi initializes the process, so monkey-
 *   patching inside an already-initialized test process could never prove
 *   the composition (this suite patches nothing);
 * - every OIDC_* key AND KNOWN_ENABLE_E2E_TEST_IDENTITY is DELETED from the
 *   child env (empty-string values are never used as evidence) and the test
 *   provider flag is off, so any legacy discovery fetch would target the
 *   reserved `.example` default issuer and fail startup — a child that
 *   reaches /ready is zero-discovery evidence;
 * - route absence is asserted over REAL HTTP against the listening child
 *   (legacy OIDC start/callback + the legacy test-authorize route must all
 *   answer 404 with the product envelope).
 *
 * 假阳性防护:
 * - the child must actually listen and pass /ready; an exited process with
 *   the right-looking assertions is a failure (exitCode checked with stderr
 *   captured);
 * - NODE_ENV=test is explicit and BETTER_AUTH_ENABLED=true is explicit; the
 *   child inherits the rest of the environment unchanged.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { Pool } from 'pg';
import pg from 'pg';
import { afterAll, beforeAll, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import { composeBetterAuthComposition } from '../../../src/bootstrap/composition.js';
import { createBetterAuthSessionTokenProtector, type BetterAuthSessionTokenProtector } from '../../../src/infrastructure/auth/better-auth-session-token-protection.js';
import { createAuthEmailAdapter } from '../../../src/infrastructure/email/auth-email-adapter.js';
import { createPostgresIdentityUnitOfWork } from '../../../src/infrastructure/identity/index.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { createLogger } from '../../../src/infrastructure/telemetry/index.js';
import {
  browserSessionCsrfTokenHash,
  browserSessionTokenHash,
  deriveBrowserSessionCsrfTokenRaw,
} from '../../../src/modules/auth/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { createMemoryAuthRateLimiter } from '../../../src/transport/http-security.js';
import { createAuthTestMailbox } from '../../support/auth-test-mailbox.js';
import {
  F3_PASSWORD,
  F3_SESSION_COOKIE_NAME,
  F3_TRUSTED_ORIGIN,
  f3CookieHeader,
  f3SessionCookieOf,
  f3TestEnv,
} from '../../support/auth-runtime-isolation-helpers.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';
import { reserveTcpPort, waitForChildReady } from '../../support/runtime-process.js';

const backendRoot = resolve(import.meta.dirname, '../../..');

describeWithPostgres('F2 auth runtime isolation (real startApi child process, zero OIDC env)', () => {
  let isolated: IsolatedPostgresRuntime;
  let child: ChildProcess | undefined;
  let baseUrl: string;
  let childStdout = '';
  let childStderr = '';

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('f2_runtime_isolation');
    await runMigrations(isolated.runtime.db, 'latest');
    const port = await reserveTcpPort();

    // Zero legacy OIDC env: delete every OIDC_* key and the E2E test-identity
    // flag from the inherited environment (never blank them).
    const childEnv: Record<string, string | undefined> = { ...process.env };
    for (const key of Object.keys(childEnv)) {
      if (key.startsWith('OIDC_') || key === 'KNOWN_ENABLE_E2E_TEST_IDENTITY') {
        delete childEnv[key];
      }
    }
    Object.assign(childEnv, {
      DATABASE_URL: isolated.databaseUrl,
      HOST: '127.0.0.1',
      PORT: String(port),
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      BETTER_AUTH_ENABLED: 'true',
      // The child runs the real production entrypoint and this suite provisions
      // no private EXPORT_R2_*; mirror tests/support/test-config.ts.
      KNOWN_FEATURE_EXPORT_JOBS: 'false',
    });

    child = spawn(process.execPath, ['--import', 'tsx', 'src/bootstrap/api.ts'], {
      cwd: backendRoot,
      env: childEnv as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (chunk: Buffer) => { childStdout += chunk.toString('utf8'); });
    child.stderr?.on('data', (chunk: Buffer) => { childStderr += chunk.toString('utf8'); });
    baseUrl = `http://127.0.0.1:${port}`;
    await waitForChildReady(baseUrl, child, () => childStderr);
  }, 120_000);

  afterAll(async () => {
    if (child !== undefined && child.exitCode === null) {
      child.kill('SIGTERM');
    }
    if (child !== undefined) {
      await new Promise((resolveExit) => {
        if (child.exitCode !== null) resolveExit();
        else child.once('exit', resolveExit);
      });
    }
    await isolated?.close();
  });

  test('the Better Auth process starts with zero OIDC env and passes readiness', () => {
    assert.equal(child?.exitCode, null, `API child must stay alive (stderr: ${childStderr})`);
  });

  test('legacy OIDC routes and the legacy test-authorize route answer 404 on the real process', async () => {
    for (const path of ['/api/v1/auth/oidc/start', '/api/v1/auth/oidc/callback', '/__test__/oidc/authorize']) {
      const response = await fetch(`${baseUrl}${path}`);
      assert.equal(response.status, 404, `${path} must be absent in Better Auth mode`);
      const body = await response.text();
      assert.match(body, /resource_not_found/u, `${path} must answer the product 404 envelope`);
    }
  });
});

// ---------------------------------------------------------------------------
// Task F3 evidence class 6: database query audit (plan §12 Task F3)
//
// The F2 child-process evidence above proves startup/readiness/route
// isolation. This block proves the strongest DB claim: a REAL Better Auth
// flow (sign-up -> verify -> sign-in -> session bootstrap -> product /me -> CSRF-guarded mutation
// -> sign-out) executed against the REAL composed app never touches the
// legacy OIDC LOGIN runtime tables (`sessions`, `oidc_login_transactions`,
// `legacy_oidc_identity_archive`) and the AUTH runtime never touches
// `account_identities`.
//
// `account_identities` is a LIVE product table (plan §4.1: the extension
// identity contract stays Know-N-owned, never reused as a Better Auth
// account table). The product /api/v1/me routes LEGITIMATELY read it
// (extension identity view); the audit therefore asserts ZERO
// account_identities statements in the auth-runtime segments (sign-up
// establishment, authority bootstrap, sign-out) and treats the /me reads as
// a POSITIVE control that the product contract still works while the legacy
// LOGIN path stays zero-call.
//
// 假阴性防护:
// - the audit patches `pg.Client.prototype.query` at the process level:
//   EVERY statement — Kysely (Better Auth adapter + business UoW), raw
//   `pool.query` (callback-form connect) and prepared paths alike — is
//   captured; no acquisition path can bypass it;
// - the assertion is QUERY-level (reads AND writes), which a row-count
//   check alone could never prove;
// - the legacy tables are proven to still EXIST (plan §1.3 retention) —
//   "zero queries" is about the runtime, never about the schema being gone.
//
// 假阳性防护:
// - positive control A: the audit captures the flow's REAL auth traffic
//   (auth_sessions/auth_users statements present), so an empty capture can
//   never look green;
// - positive control B: a deliberate legacy-table query executed through the
//   same instrumented pool IS captured — the audit is not blind;
// - the legacy-name match is a standalone-identifier regex: `auth_sessions`
//   and `known_auth_session_metadata` never match `\bsessions\b`.
// ---------------------------------------------------------------------------

async function f3EstablishSessionMetadata(
  pool: Pool,
  sessionTokenProtector: BetterAuthSessionTokenProtector,
  sessionValue: string,
): Promise<void> {
  const token = sessionValue.slice(0, sessionValue.lastIndexOf('.'));
  const sessionRow = await pool.query<{ id: string; userId: string; token: string }>(
    `select id, "userId", token from auth_sessions where "tokenLookupHash" = any($1::text[])`,
    [sessionTokenProtector.lookupHashes(token)],
  );
  assert.equal(sessionRow.rows.length, 1, 'the BA session row must exist for the issued cookie');
  assert.notEqual(sessionRow.rows[0]!.token, token, 'the raw bearer token must not be stored');
  const sessionId = sessionRow.rows[0]!.id;
  const authUserId = sessionRow.rows[0]!.userId;
  const accountRow = await pool.query<{ account_id: string }>(
    `select account_id from auth_user_account_map where auth_user_id = $1`, [authUserId],
  );
  assert.ok(accountRow.rows[0], 'the A2 establishment must have mapped the auth user');
  const accountId = accountRow.rows[0]!.account_id;
  const epochRow = await pool.query<{ security_epoch: string }>(
    `select security_epoch from accounts where id = $1`, [accountId],
  );
  assert.equal(epochRow.rowCount, 1);
  const securityEpoch = epochRow.rows[0]!.security_epoch;
  const now = new Date();
  await pool.query(
    `insert into known_auth_session_metadata (
       auth_session_id, session_token_hash, account_id, idle_expires_at, absolute_expires_at,
       security_epoch, csrf_token_hash, predecessor_session_id, last_seen_at, revoked_at, created_at
     ) values ($1,$2,$3,$4,$5,$6,$7,NULL,$8,NULL,$9)
     on conflict (auth_session_id) do nothing`,
    [
      sessionId,
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

interface F3QueryAudit {
  readonly snapshot: () => number;
  readonly statements: () => readonly string[];
  readonly restore: () => void;
}

/**
 * Process-level pg statement audit: wraps `pg.Client.prototype.query` so
 * EVERY statement — Kysely, raw `pool.query` (callback-form connect) and
 * prepared paths alike — is captured. Restored in afterAll; the F2
 * child-process evidence runs in a separate OS process and is unaffected.
 */
function installPgClientQueryAudit(): F3QueryAudit {
  const prototype = pg.Client.prototype;
  const originalQuery = prototype.query;
  const statements: string[] = [];
  prototype.query = function (this: unknown, ...args: unknown[]) {
    const first = args[0];
    const text = typeof first === 'string' ? first : (first as { text?: string } | null | undefined)?.text;
    if (typeof text === 'string') statements.push(text);
    return Reflect.apply(originalQuery, this, args);
  } as unknown as typeof prototype.query;
  return {
    snapshot: () => statements.length,
    statements: () => statements,
    restore: () => {
      prototype.query = originalQuery;
    },
  };
}

/** Legacy tables the Better Auth runtime must never touch (plan §1.3 retention). */
const F3_LOGIN_RUNTIME_TABLES = ['sessions', 'oidc_login_transactions', 'legacy_oidc_identity_archive'] as const;

/** All audited legacy tables, including the live extension-identity table. */
const F3_LEGACY_TABLE_NAMES = ['sessions', 'account_identities', 'oidc_login_transactions', 'legacy_oidc_identity_archive'] as const;

const F3_LEGACY_TABLE_PATTERNS = F3_LEGACY_TABLE_NAMES.map((name) => ({
  name,
  pattern: new RegExp(`\\b${name}\\b`, 'u'),
}));

function f3LegacyHits(statements: readonly string[], tables: readonly string[] = F3_LEGACY_TABLE_NAMES): string[] {
  const patterns = F3_LEGACY_TABLE_PATTERNS.filter(({ name }) => (tables as readonly string[]).includes(name));
  return statements
    .map((sql) => patterns.filter(({ pattern }) => pattern.test(sql)).map(({ name }) => name))
    .flat();
}

function f3AssertZeroLegacy(statements: readonly string[], segment: string, tables: readonly string[] = F3_LEGACY_TABLE_NAMES): void {
  const hits = f3LegacyHits(statements, tables);
  assert.deepEqual(hits, [], `${segment}: audited tables must stay zero-call (${hits.join(', ')})`);
}

describeWithPostgres('F3 legacy zero-call DB query audit (real auth flow, pg statement audit)', () => {
  let isolated: IsolatedPostgresRuntime;
  let app: ReturnType<typeof buildApiApp>;
  let audit: F3QueryAudit;
  let mailbox: ReturnType<typeof createAuthTestMailbox>;
  let sessionTokenProtector: BetterAuthSessionTokenProtector;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('f3_zero_call_audit');
    await runMigrations(isolated.runtime.db, 'latest');
    // Install the statement audit before the first flow query: every client
    // query executed from here on is captured (Kysely + raw pool.query).
    audit = installPgClientQueryAudit();

    const config = loadConfig(f3TestEnv());
    assert.ok(config.betterAuth.sessionTokenProtection);
    sessionTokenProtector = createBetterAuthSessionTokenProtector(
      config.betterAuth.sessionTokenProtection,
    );
    mailbox = createAuthTestMailbox();
    const sender = createAuthEmailAdapter({ provider: mailbox.provider, logger: createLogger('silent') });
    const composition = composeBetterAuthComposition({
      config,
      db: isolated.runtime.db,
      authEmail: sender,
      logger: createLogger('silent'),
    });
    assert.ok(composition.browserSessionAuthority, 'the F3 audit flow needs the BA authority');
    assert.ok(composition.betterAuthRuntime, 'the F3 audit flow needs the BA runtime');
    app = buildApiApp({
      config,
      identityUnitOfWork: createPostgresIdentityUnitOfWork(isolated.runtime.db),
      browserSessionAuthority: composition.browserSessionAuthority,
      betterAuthRuntime: composition.betterAuthRuntime,
      authRateLimiter: createMemoryAuthRateLimiter({ maxRequests: 1_000_000, windowMs: 60_000 }),
    });
  }, 120_000);

  afterAll(async () => {
    audit?.restore();
    await app?.close().catch(() => undefined);
    await isolated?.close();
  });

  test('positive controls: legacy tables are retained and a deliberate legacy query IS captured', async () => {
    // Retention contract (plan §1.3): the legacy tables still exist — "zero
    // queries" is about the RUNTIME, not about the schema being gone.
    const tables = await isolated.runtime.pool.query<{ table_name: string }>(
      `select table_name from information_schema.tables
        where table_schema = current_schema()
          and table_name in ('sessions', 'account_identities', 'oidc_login_transactions', 'legacy_oidc_identity_archive')`,
    );
    assert.deepEqual(
      [...tables.rows.map((row) => row.table_name)].sort(),
      [...F3_LEGACY_TABLE_NAMES].sort(),
      'all legacy tables must still exist (F3 zero-call evidence, not zero-schema)',
    );

    // Positive control B: the audit must capture deliberate legacy SQL
    // executed through the raw pool (callback-form connect path).
    const before = audit.snapshot();
    await isolated.runtime.pool.query('select count(*) as n from sessions');
    const probed = audit.statements().slice(before);
    assert.ok(
      probed.some((sql) => /\bsessions\b/u.test(sql)),
      'the statement audit must capture a deliberate legacy-table query (not blind)',
    );
  });

  test('auth segments never touch legacy OIDC login tables; /api/v1/me keeps only its extension-identity reads', async () => {
    const email = `f3-audit-${randomUUID().slice(0, 8)}@example.test`;
    const segments: Array<{ name: string; statements: readonly string[] }> = [];
    const runSegment = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
      const before = audit.snapshot();
      const result = await fn();
      segments.push({ name, statements: audit.statements().slice(before) });
      return result;
    };

    // --- segment: sign-up (BA runtime + A2 business mapping) ---
    const signup = await runSegment('sign-up', () =>
      app.inject({
        method: 'POST',
        url: '/api/v1/auth/sign-up/email',
        headers: { 'content-type': 'application/json', origin: F3_TRUSTED_ORIGIN },
        payload: JSON.stringify({ name: 'F3 Audit User', email, password: F3_PASSWORD }),
      }),
    );
    assert.equal(signup.statusCode, 200, 'sign-up must succeed over the real BA bridge');
    assert.equal(f3SessionCookieOf(signup), null, 'password sign-up must not issue a session while unverified');

    // --- segment: mailbox verification + password sign-in (P1 product actor) ---
    const verified = await runSegment('verify+sign-in', async () => {
      const mail = mailbox.lastMailFor({ email, purpose: 'email-verification' });
      assert.ok(mail, 'sign-up must deliver the verification email');
      const token = mail.textBody.match(/token=([A-Za-z0-9._~-]+)/u)?.[1];
      assert.ok(token, 'the verification email must carry the JWT');
      const verify = await app.inject({
        method: 'GET',
        url: `/api/v1/auth/verify-email?token=${token}`,
        headers: { origin: F3_TRUSTED_ORIGIN },
      });
      assert.equal(verify.statusCode, 200, 'mailbox verification must succeed');
      const autoCookie = f3SessionCookieOf(verify);
      if (autoCookie !== null && autoCookie !== '') {
        await app.inject({
          method: 'POST',
          url: '/api/v1/auth/sign-out',
          headers: {
            cookie: f3CookieHeader(F3_SESSION_COOKIE_NAME, decodeURIComponent(autoCookie)),
            origin: F3_TRUSTED_ORIGIN,
            'content-type': 'application/json',
          },
          payload: '{}',
        });
      }
      const signIn = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/sign-in/email',
        headers: { 'content-type': 'application/json', origin: F3_TRUSTED_ORIGIN },
        payload: JSON.stringify({ email, password: F3_PASSWORD }),
      });
      assert.equal(signIn.statusCode, 200, 'verified password sign-in must issue a session');
      return signIn;
    });
    const cookieValue = f3SessionCookieOf(verified);
    assert.ok(cookieValue, 'verified sign-in must issue the session cookie');
    const decodedCookie = decodeURIComponent(cookieValue);
    const cookieHeader = f3CookieHeader(F3_SESSION_COOKIE_NAME, decodedCookie);

    // --- segment: A3 metadata establishment + session bootstrap (authority) ---
    let csrfToken: string | undefined;
    await runSegment('metadata+bootstrap', async () => {
      await f3EstablishSessionMetadata(isolated.runtime.pool, sessionTokenProtector, decodedCookie);
      const sessionRes = await app.inject({ method: 'GET', url: '/api/v1/session', headers: { cookie: cookieHeader } });
      assert.equal(sessionRes.statusCode, 200, '/api/v1/session must authenticate the BA cookie');
      const sessionBody = sessionRes.json() as { authenticated?: boolean; csrfToken?: string };
      assert.equal(sessionBody.authenticated, true);
      assert.ok(sessionBody.csrfToken, 'bootstrap must return the product CSRF token');
      csrfToken = sessionBody.csrfToken;
    });

    // --- segment: GET /api/v1/me (product route) ---
    await runSegment('get-me', async () => {
      const me = await app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie: cookieHeader } });
      assert.equal(me.statusCode, 200, '/api/v1/me must resolve the mapped business account');
    });

    // --- segment: PATCH /api/v1/me (real product mutation behind Origin/CSRF) ---
    await runSegment('patch-me', async () => {
      const patch = await app.inject({
        method: 'PATCH',
        url: '/api/v1/me',
        headers: {
          cookie: cookieHeader,
          origin: F3_TRUSTED_ORIGIN,
          'x-csrf-token': csrfToken!,
          'known-command-id': randomUUID(),
          'content-type': 'application/json',
        },
        payload: JSON.stringify({ handle: `f3_${randomUUID().slice(0, 6)}`, displayName: 'F3 Audited' }),
      });
      assert.equal(patch.statusCode, 200, 'the CSRF-guarded product mutation must succeed');
    });

    // --- segment: sign-out (BA session revoke) ---
    await runSegment('sign-out', async () => {
      const signOut = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/sign-out',
        headers: { cookie: cookieHeader, origin: F3_TRUSTED_ORIGIN, 'content-type': 'application/json' },
        payload: '{}',
      });
      assert.equal(signOut.statusCode, 200, 'sign-out must revoke the BA session');
    });

    const all = segments.flatMap((segment) => segment.statements);

    // Positive control A: the audit captured the flow's REAL auth traffic.
    assert.ok(all.length > 0, 'the statement audit must capture the auth flow queries');
    assert.ok(
      all.some((sql) => /\bfrom\s+"?auth_(?:sessions|users)"?/u.test(sql)),
      'the audit must capture auth_sessions/auth_users traffic (capture is not blind)',
    );

    // The F3 assertion, per segment:
    // - auth-runtime segments: ZERO statements on ALL audited legacy tables
    //   (the legacy OIDC login tables AND the extension identity table);
    // - product /me segments: ZERO statements on the legacy OIDC login
    //   runtime tables; the account_identities reads are the live extension
    //   identity contract (plan §4.1) — exactly one read per route, never a
    //   write.
    const authSegments = ['sign-up', 'verify+sign-in', 'metadata+bootstrap', 'sign-out'];
    const productSegments = ['get-me', 'patch-me'];
    for (const segment of segments.filter((entry) => authSegments.includes(entry.name))) {
      f3AssertZeroLegacy(segment.statements, `auth-runtime segment "${segment.name}"`);
    }
    for (const segment of segments.filter((entry) => productSegments.includes(entry.name))) {
      f3AssertZeroLegacy(segment.statements, `product segment "${segment.name}"`, F3_LOGIN_RUNTIME_TABLES);
      const identityReads = segment.statements.filter((sql) => /\baccount_identities\b/u.test(sql));
      assert.equal(
        identityReads.length,
        1,
        `${segment.name}: exactly one account_identities read (extension identity view)`,
      );
      assert.match(
        identityReads[0] ?? '',
        /^\s*select\b/iu,
        `${segment.name}: the account_identities access must be a read, never a write`,
      );
    }
  });
});
