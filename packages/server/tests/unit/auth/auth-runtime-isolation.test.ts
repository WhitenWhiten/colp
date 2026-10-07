/**
 * Task F2 unit tests: legacy OIDC/Logto runtime isolation when Better Auth is
 * enabled (plan §12 Task F2; G1 ADR §16 config matrix).
 *
 * 假阴性防护:
 * - the fetch spy covers BOTH global fetch (composition/readiness zero
 *   outbound) and the legacy discovery probe itself (the spy proves it would
 *   catch the discovery fetch, so the BA-mode gate is the only path);
 * - the route-absence evidence comes from the REAL Fastify app
 *   (printRoutes + app.inject through the installed hooks), never from a
 *   static grep;
 * - the rate-limit family evidence is behavioral: the injected memory
 *   limiter must NOT create a bucket for the legacy OIDC paths in BA mode
 *   while legacy mode consumes one (family live), and the 404/500 statuses
 *   come from real requests;
 * - the config matrix builds a FRESH env per assertion (no reuse of a
 *   previous test's env) and covers production AND test, present AND absent
 *   values, including the OIDC_TRANSACTION_* secrets that legacy production
 *   requires.
 *
 * 假阳性防护:
 * - setting the OIDC env to an empty string is never used as evidence:
 *   every "zero OIDC env" case DELETES the keys entirely;
 * - the OpenAPI assertion verifies the legacy operations REMAIN (rollback
 *   contract, frozen 1.15.0 baseline) while being marked deprecated, and the
 *   coverage assertion proves legacy mode still REQUIRES them;
 * - test-flag rejection is asserted in production under BETTER_AUTH_ENABLED
 *   (any BA mode), not only in legacy mode.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, test, vi } from 'vitest';
import { Kysely, PostgresDialect } from 'kysely';
import { parse } from 'yaml';
import { legacyOidcDiscoveryProbeRequired } from '../../../src/bootstrap/api.js';
import { readApiCompositionSource } from '../../support/api-composition-source.js';
import { composeBetterAuthComposition } from '../../../src/bootstrap/composition.js';
import { loadConfig } from '../../support/test-config.js';
import { composeReadinessProbe } from '../../../src/infrastructure/health.js';
import type { DatabaseSchema } from '../../../src/infrastructure/database/runtime.js';
import { createLogger, redactSensitiveText } from '../../../src/infrastructure/telemetry/index.js';
import type { IdentityUnitOfWork } from '../../../src/modules/identity/index.js';
import type { AuthEmailSender } from '../../../src/modules/auth/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { AUTH_ROUTE_MANIFEST } from '../../../src/transport/auth/auth-route-manifest.js';
import { createMemoryAuthRateLimiter } from '../../../src/transport/http-security.js';
import { verifyOidcDiscoveryMetadata } from '../../../src/transport/auth/oidc-provider.js';
import {
  LEGACY_OIDC_OPERATION_IDS,
  assertProductRouteCoverage,
} from '../../../src/transport/product-route-manifest.js';
import { PRODUCT_ROUTE_MANIFEST } from '../../../generated/openapi/product-v1.routes.js';

const backendRoot = resolve(import.meta.dirname, '../../..');

/** Better Auth test env with ZERO OIDC_* keys (deleted, never blanked). */
function baTestEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    DATABASE_URL: 'postgres://localhost/known_test',
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    PRODUCT_ORIGIN: 'https://app.example.test',
    ALLOWED_ORIGINS: 'https://app.example.test',
    BETTER_AUTH_ENABLED: 'true',
    BETTER_AUTH_SECRET: 'test-better-auth-secret-0123456789abcdef1',
    ...overrides,
  };
}

/** Production-legal base env WITHOUT any OIDC_* / OIDC_TRANSACTION_* keys. */
function baProductionEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    DATABASE_URL: 'postgres://localhost/known_test',
    NODE_ENV: 'production',
    PRODUCT_ORIGIN: 'https://app.example.test',
    PRODUCT_EDITOR_CURSOR_HMAC_KEY: 'prod-product-editor-cursor-hmac-key-not-dev-default',
    PRODUCT_EDITOR_CURSOR_KEY_ID: 'prod-editor-v1',
    PRODUCT_OWNED_COLLECTIONS_CURSOR_HMAC_KEY: 'prod-owned-collections-cursor-key-not-dev-default',
    PRODUCT_OWNED_COLLECTIONS_CURSOR_KEY_ID: 'prod-owned-v1',
    PRODUCT_LINK_HEALTH_CURSOR_HMAC_KEY: 'prod-link-health-cursor-hmac-key-not-dev-default',
    PRODUCT_LINK_HEALTH_CURSOR_KEY_ID: 'prod-link-health-v1',
    PRODUCT_CLASSIFY_INBOX_CURSOR_HMAC_KEY: 'prod-classify-inbox-cursor-hmac-key-not-dev-default',
    PRODUCT_CLASSIFY_INBOX_CURSOR_KEY_ID: 'prod-classify-inbox-v1',
    PRODUCT_COLLECTION_VERSIONS_CURSOR_HMAC_KEY: 'prod-collection-versions-cursor-hmac-key-not-dev-default',
    PRODUCT_COLLECTION_VERSIONS_CURSOR_KEY_ID: 'prod-collection-versions-v1',
    PUBLISHING_INSIGHTS_VISITOR_HMAC_KEY: 'prod-publishing-insights-visitor-hmac-key-32b',
    PUBLISHING_INSIGHTS_RATELIMIT_HMAC_KEY: 'prod-publishing-insights-ratelimit-hmac-key-32b',
    COLLABORATION_INVITE_RATE_LIMIT_KEY_SECRET: 'prod-collaboration-invite-rate-limit-hmac',
    PRODUCT_EDITOR_CURSOR_ISSUANCE_FORMAT: 'keyed',
    PUBLICATION_SERVER_UUID: '019f9031-c541-74d0-bc83-15a5526fbb54',
    PUBLICATION_CURSOR_ACTIVE_KEY_ID: 'prod-publication-v1',
    PUBLICATION_CURSOR_ACTIVE_SECRET: Buffer.alloc(32, 17).toString('base64'),
    FOLLOW_CURSOR_ACTIVE_KEY_ID: 'prod-follow-v1',
    FOLLOW_CURSOR_ACTIVE_SECRET: Buffer.alloc(32, 19).toString('base64'),
    FEED_CURSOR_ACTIVE_KEY_ID: 'prod-feed-v1',
    FEED_CURSOR_ACTIVE_SECRET: Buffer.alloc(32, 21).toString('base64'),
    PUBLIC_ACTIVITY_CURSOR_ACTIVE_KEY_ID: 'prod-public-activity-v1',
    PUBLIC_ACTIVITY_CURSOR_ACTIVE_SECRET: Buffer.alloc(32, 27).toString('base64'),
    NOTIFICATION_CURSOR_ACTIVE_KEY_ID: 'prod-notification-v1',
    NOTIFICATION_CURSOR_ACTIVE_SECRET: Buffer.alloc(32, 23).toString('base64'),
    FOLLOWED_COLLECTIONS_CURSOR_ACTIVE_KEY_ID: 'prod-followed-collections-v1',
    FOLLOWED_COLLECTIONS_CURSOR_ACTIVE_SECRET: Buffer.alloc(32, 37).toString('base64'),
    COMMUNITY_CURSOR_HMAC_KEY: Buffer.alloc(32, 43).toString('base64'),
    BETTER_AUTH_ENABLED: 'true',
    BETTER_AUTH_SECRET: 'prod-better-auth-secret-0123456789abcdef',
    BETTER_AUTH_SESSION_TOKEN_KEYS: `1:${Buffer.alloc(32, 31).toString('base64')}`,
    ...overrides,
  };
}

/** Legacy OIDC test env (test provider explicitly enabled). */
function legacyTestEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    DATABASE_URL: 'postgres://localhost/known_test',
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    PRODUCT_ORIGIN: 'https://app.example.test',
    ALLOWED_ORIGINS: 'https://app.example.test',
    OIDC_ISSUER: 'http://localhost:3310/__test__/oidc',
    OIDC_CLIENT_ID: 'known-web-real-stack',
    OIDC_AUDIENCE: 'known-web-real-stack',
    OIDC_REDIRECT_URI: 'https://app.example.test/api/v1/auth/oidc/callback',
    OIDC_AUTHORIZATION_ENDPOINT: 'http://localhost:3310/__test__/oidc/authorize',
    OIDC_TOKEN_ENDPOINT: 'http://localhost:3310/__test__/oidc/token',
    OIDC_CLIENT_AUTH_MODE: 'none',
    OIDC_ALLOW_TEST_PROVIDER: 'true',
    OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
    KNOWN_ENABLE_E2E_TEST_IDENTITY: 'true',
    ...overrides,
  };
}

/** Minimal identity unit of work: never executed (route-presence tests only). */
const stubIdentityUnitOfWork: IdentityUnitOfWork = {
  async execute() {
    throw new Error('unused identity unit-of-work stub');
  },
};

/** Real Kysely/transaction path with a deterministic local acquisition failure; no DNS/TCP. */
function inertDatabase(connect: () => Promise<never>): Kysely<DatabaseSchema> {
  return new Kysely<DatabaseSchema>({
    dialect: new PostgresDialect({
      pool: { options: {}, connect, async end() {} },
    }),
  });
}

const stubAuthEmailSender: AuthEmailSender = {
  async sendAuthEmail() {
    return {
      outcome: 'email_delivery_unavailable',
      correlationId: 'stub-correlation',
      redactedReason: 'stub sender (never contacted)',
    };
  },
};

/** Minimal runtime stub: registers nothing (route absence is the assertion). */
const stubBetterAuthRuntime = {
  mount() {},
};

describe('F2 config matrix (G1 §16): OIDC env non-required in Better Auth mode', () => {
  test('production with BETTER_AUTH_ENABLED=true and zero OIDC env loads (secrets non-required)', () => {
    const config = loadConfig(baProductionEnv());
    assert.equal(config.betterAuth.enabled, true);
    assert.equal(config.oidc.jwksUri, null);
    assert.equal(config.oidc.allowTestProvider, false);
    assert.equal(config.testIdentityProviderEnabled, false);
    // The legacy transaction secrets stay inert dev values in BA mode: never
    // composed (startApi skips them), never logged.
    assert.ok(config.oidcTransactionSecrets.hmacSecret.length > 0);
    assert.ok(config.oidcTransactionSecrets.encryptionKeys.length >= 1);
  });

  test('legacy mode with zero OIDC env fails closed in production (JWKS required)', () => {
    const env = baProductionEnv();
    delete env.BETTER_AUTH_ENABLED;
    delete env.BETTER_AUTH_SECRET;
    assert.throws(() => loadConfig(env), /OIDC_JWKS_URI is required/u);
  });

  test('legacy mode with OIDC_JWKS_URI but zero transaction secrets fails closed in production', () => {
    const env = baProductionEnv({ OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs' });
    delete env.BETTER_AUTH_ENABLED;
    delete env.BETTER_AUTH_SECRET;
    assert.throws(() => loadConfig(env), /OIDC_TRANSACTION_HMAC_SECRET is required/u);
    const withHmac = {
      ...env,
      OIDC_TRANSACTION_HMAC_SECRET: 'prod-oidc-transaction-hmac-secret-not-dev-default',
    };
    assert.throws(() => loadConfig(withHmac), /OIDC_TRANSACTION_ENCRYPTION_KEYS is required/u);
  });

  test('production test flags stay fail-closed in every Better Auth mode', () => {
    assert.throws(
      () => loadConfig(baProductionEnv({ OIDC_ALLOW_TEST_PROVIDER: 'true' })),
      /OIDC_ALLOW_TEST_PROVIDER must not be enabled in production/u,
    );
    assert.throws(
      () => loadConfig(baProductionEnv({
        OIDC_ALLOW_TEST_PROVIDER: 'true',
        OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
      })),
      /OIDC_ALLOW_TEST_PROVIDER must not be enabled in production/u,
    );
    assert.throws(
      () => loadConfig(baProductionEnv({ KNOWN_ENABLE_E2E_TEST_IDENTITY: 'true' })),
      /KNOWN_ENABLE_E2E_TEST_IDENTITY requires NODE_ENV=test/u,
    );
  });

  test('test mode with BETTER_AUTH_ENABLED=true and zero OIDC env loads', () => {
    const config = loadConfig(baTestEnv());
    assert.equal(config.betterAuth.enabled, true);
    assert.equal(config.oidc.jwksUri, null);
  });
});

describe('F2 runtime composition isolation (real Fastify app)', () => {
  test('Better Auth mode registers zero legacy OIDC routes and zero test-authorize route', async () => {
    const config = loadConfig(baTestEnv());
    const app = buildApiApp({
      config,
      identityUnitOfWork: stubIdentityUnitOfWork,
      betterAuthRuntime: stubBetterAuthRuntime,
    });

    // commonPrefix: false prints FULL paths (default tree compression hoists
    // shared prefixes, so the literal path string never appears); the
    // absence evidence must not depend on display compression.
    const routes = app.printRoutes({ commonPrefix: false });
    assert.equal(routes.includes('/api/v1/auth/oidc/start'), false, 'legacy OIDC start must be absent');
    assert.equal(routes.includes('/api/v1/auth/oidc/callback'), false, 'legacy OIDC callback must be absent');
    assert.equal(routes.includes('/__test__/oidc/authorize'), false, 'legacy test authorize must be absent');

    for (const path of ['/api/v1/auth/oidc/start', '/api/v1/auth/oidc/callback', '/__test__/oidc/authorize']) {
      const response = await app.inject({ method: 'GET', url: path });
      assert.equal(response.statusCode, 404, `${path} must answer 404 in Better Auth mode`);
      assert.match(response.body, /resource_not_found/u);
    }
    await app.close();
  });

  test('legacy mode keeps the legacy OIDC routes and the test-authorize route (rollback semantics)', async () => {
    const config = loadConfig(legacyTestEnv());
    const app = buildApiApp({ config, identityUnitOfWork: stubIdentityUnitOfWork });

    // commonPrefix: false prints FULL paths (see the BA-mode test note).
    const routes = app.printRoutes({ commonPrefix: false });
    assert.equal(routes.includes('/api/v1/auth/oidc/start'), true, 'legacy OIDC start must stay registered');
    assert.equal(routes.includes('/api/v1/auth/oidc/callback'), true, 'legacy OIDC callback must stay registered');
    assert.equal(routes.includes('/__test__/oidc/authorize'), true, 'legacy test authorize must stay registered');

    const response = await app.inject({ method: 'GET', url: '/api/v1/auth/oidc/start' });
    assert.notEqual(response.statusCode, 404, 'the registered legacy route must not answer 404');
    await app.close();
  });

  test('legacy OIDC rate-limit families are not live in Better Auth mode (no bucket, no family)', async () => {
    const config = loadConfig(baTestEnv());
    const limiter = createMemoryAuthRateLimiter({ maxRequests: 100, windowMs: 60_000 });
    const app = buildApiApp({
      config,
      identityUnitOfWork: stubIdentityUnitOfWork,
      betterAuthRuntime: stubBetterAuthRuntime,
      authRateLimiter: limiter,
    });

    const response = await app.inject({ method: 'GET', url: '/api/v1/auth/oidc/start' });
    assert.equal(response.statusCode, 404);
    assert.equal(limiter.size(), 0, 'no oidc-start/oidc-callback bucket may be created in Better Auth mode');
    await app.close();
  });

  test('legacy mode keeps the legacy OIDC rate-limit families live', async () => {
    const config = loadConfig(legacyTestEnv());
    const limiter = createMemoryAuthRateLimiter({ maxRequests: 100, windowMs: 60_000 });
    const app = buildApiApp({ config, identityUnitOfWork: stubIdentityUnitOfWork, authRateLimiter: limiter });

    const response = await app.inject({ method: 'GET', url: '/api/v1/auth/oidc/start' });
    assert.notEqual(response.statusCode, 404);
    assert.equal(limiter.size(), 1, 'legacy mode must consume the oidc-start family bucket');
    await app.close();
  });

  test('Better Auth composition makes zero outbound fetch (global fetch spy)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const config = loadConfig(baTestEnv());
      const app = buildApiApp({
        config,
        identityUnitOfWork: stubIdentityUnitOfWork,
        betterAuthRuntime: stubBetterAuthRuntime,
      });
      await app.inject({ method: 'GET', url: '/health' });
      await app.inject({ method: 'GET', url: '/ready' });
      await app.inject({ method: 'GET', url: '/api/v1/auth/oidc/start' });
      assert.equal(fetchSpy.mock.calls.length, 0, 'no OIDC discovery/JWKS/issuer fetch may happen in BA mode');
      await app.close();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test('the legacy discovery probe is the ONLY path to discovery and BA mode skips it', async () => {
    const baConfig = loadConfig(baTestEnv());
    assert.equal(legacyOidcDiscoveryProbeRequired(baConfig), false);

    const legacyConfig = loadConfig({
      DATABASE_URL: 'postgres://localhost/known_test',
      NODE_ENV: 'test',
      OIDC_ISSUER: 'https://issuer.example/realms/known',
      OIDC_AUTHORIZATION_ENDPOINT: 'https://issuer.example/realms/known/auth',
      OIDC_TOKEN_ENDPOINT: 'https://issuer.example/realms/known/token',
      OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs',
      OIDC_REDIRECT_URI: 'https://app.example.test/api/v1/auth/oidc/callback',
    });
    assert.equal(legacyOidcDiscoveryProbeRequired(legacyConfig), true);

    // The spy must be able to observe the discovery fetch (proving the gate
    // above is the only path that can produce network traffic).
    const calls: string[] = [];
    const fetchImpl = async (url: string | URL | Request): Promise<Response> => {
      calls.push(String(url));
      return new Response(JSON.stringify({
        issuer: legacyConfig.oidc.issuer,
        authorization_endpoint: legacyConfig.oidc.authorizationEndpoint,
        token_endpoint: legacyConfig.oidc.tokenEndpoint,
        jwks_uri: legacyConfig.oidc.jwksUri,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    await verifyOidcDiscoveryMetadata(legacyConfig.oidc, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    assert.equal(calls.length, 1);
    assert.match(calls[0] ?? '', /\/\.well-known\/openid-configuration$/u);
  });

  test('readiness in Better Auth mode never probes a legacy issuer', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const app = buildApiApp({ config: loadConfig(baTestEnv()) });
      const ready = await app.inject({ method: 'GET', url: '/ready' });
      assert.equal(ready.statusCode, 200);
      assert.deepEqual(ready.json(), { status: 'ready' });
      assert.equal(fetchSpy.mock.calls.length, 0, 'readiness must not probe the legacy OIDC issuer');
      await app.close();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test('composeReadinessProbe runs only the actually-enabled probes', async () => {
    const calls: string[] = [];
    const probe = (name: string) => ({ async verifyReady() { calls.push(name); } });
    const composed = composeReadinessProbe([probe('db'), null, undefined, probe('email')]);
    await composed.verifyReady();
    assert.deepEqual(calls, ['db', 'email']);

    const empty = composeReadinessProbe([null, undefined]);
    await empty.verifyReady();
    assert.deepEqual(calls, ['db', 'email'], 'no probes must not fail readiness (alwaysReady semantics)');
  });

  test('composeBetterAuthComposition constructs NOTHING when Better Auth is disabled', async () => {
    const config = loadConfig({
      DATABASE_URL: 'postgres://localhost/known_test',
      NODE_ENV: 'test',
      OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs',
    });
    const connect = vi.fn(async () => { throw new Error('unexpected_database_acquisition'); });
    const db = inertDatabase(connect);
    try { const composition = composeBetterAuthComposition({
      config,
      db,
      authEmail: stubAuthEmailSender,
      logger: createLogger('silent'),
    });
    assert.equal(composition.browserSessionAuthority, undefined);
    assert.equal(composition.betterAuthRuntime, undefined);
    assert.equal(composition.securityEpochBridge, undefined);
    assert.equal(composition.betterAuth, undefined);
    assert.equal(connect.mock.calls.length, 0);
    } finally { await db.destroy(); }
  });

  test('composeBetterAuthComposition wires runtime + authority + epoch bridge in Better Auth mode', async () => {
    const config = loadConfig(baTestEnv());
    const acquisitionFailure = new Error('fixture_database_acquisition');
    const connect = vi.fn(async () => { throw acquisitionFailure; });
    const db = inertDatabase(connect);
    try { const composition = composeBetterAuthComposition({
      config,
      db,
      authEmail: stubAuthEmailSender,
      logger: createLogger('silent'),
    });
    assert.ok(composition.browserSessionAuthority, 'BA mode must construct the browser session authority');
    assert.ok(composition.betterAuthRuntime, 'BA mode must construct the runtime bridge');
    assert.ok(composition.securityEpochBridge, 'BA mode must construct the security-epoch bridge');
    assert.ok(composition.betterAuth, 'BA mode must expose the shared Better Auth instance');
    assert.equal(
      composition.betterAuth,
      composition.betterAuthRuntime.auth,
      'mount, authority, and C3 auth.api must share one instance',
    );

    assert.equal(connect.mock.calls.length, 0, 'composition itself must remain free of database IO');
    // The REAL authority must attempt its revoke-all transaction. Reject at
    // the pool seam instead of relying on an external DNS/network failure.
    await assert.rejects(
      () => composition.securityEpochBridge!.raiseAccountSecurityEvent('password_reset', 'missing-account'),
      (error: unknown) => error === acquisitionFailure,
    );
    assert.equal(connect.mock.calls.length, 1, 'the real authority path must reach acquisition exactly once');
    } finally { await db.destroy(); }
  });
});

describe('AUTH-P1-a: one Better Auth instance for mount, authority, and C3 auth.api', () => {
  test('api.ts C3 uses the composed instance (no third betterAuth constructor)', () => {
    const api = readApiCompositionSource(backendRoot);
    assert.doesNotMatch(api, /import \{ betterAuth \} from 'better-auth'/u);
    assert.doesNotMatch(api, /betterAuth\s*\(\s*buildBetterAuthOptions/u);
    assert.match(api, /betterAuth:\s*recoveryLinkingAuth/u);
    assert.match(api, /sharedAuth\.api\.resetPasswordEmailOTP/u);
    assert.match(api, /sharedAuth\.api\.linkSocialAccount|sharedAuth\.api\.oAuth2LinkAccount/u);
  });

  test('composition shares runtime.auth and retains explicit occupancy adoption wiring', () => {
    const source = readFileSync(resolve(backendRoot, 'src/bootstrap/composition.ts'), 'utf8');
    assert.doesNotMatch(source, /betterAuth\s*\(\s*buildBetterAuthOptions/u);
    assert.match(source, /createBetterAuthServerApi\(runtime\.auth\)/u);
    assert.match(source, /onOAuthOccupancyAdopted:/u);
    assert.match(source, /betterAuth:\s*runtime\.auth/u);
  });
});

describe('F2 OpenAPI / route-manifest alignment', () => {
  test('legacy OIDC operations stay contract-stable but marked deprecated in the OpenAPI', () => {
    const document = parse(readFileSync(resolve(backendRoot, 'openapi/product-v1.yaml'), 'utf8')) as {
      paths?: Record<string, Record<string, Record<string, unknown>>>;
    };
    const byId = new Map<string, Record<string, unknown>>();
    const methods = new Set(['get', 'post', 'put', 'delete', 'patch', 'head', 'options', 'trace']);
    for (const item of Object.values(document.paths ?? {})) {
      for (const [method, operation] of Object.entries(item ?? {})) {
        if (!methods.has(method)) continue;
        const operationId = operation?.operationId;
        if (typeof operationId === 'string') byId.set(operationId, operation);
      }
    }
    for (const operationId of ['startOidcAuthorization', 'completeOidcAuthorization']) {
      const operation = byId.get(operationId);
      assert.ok(operation, `${operationId} must remain in the OpenAPI (deprecated legacy contract, rollback-safe)`);
      assert.match(String(operation.summary ?? ''), /deprecated/iu, `${operationId} summary must mark deprecation`);
      assert.match(String(operation.description ?? ''), /legacy|BETTER_AUTH_ENABLED/iu, `${operationId} description must document the legacy status`);
    }
  });

  test('the auth manifest keeps legacy OIDC entries for legacy mode; the OpenAPI operationIds stay stable', () => {
    const legacyEntries = AUTH_ROUTE_MANIFEST.filter((entry) => entry.scope === 'legacy-oidc');
    assert.deepEqual(
      legacyEntries.map((entry) => `${entry.method} ${entry.path}`),
      ['GET /api/v1/auth/oidc/start', 'GET /api/v1/auth/oidc/callback'],
    );
    assert.equal(legacyEntries.every((entry) => entry.status === 'registered'), true,
      'legacy OIDC entries stay registered for legacy mode (F3 removes them)');
    assert.deepEqual(legacyEntries.map((entry) => entry.operationId).sort(),
      ['completeOidcAuthorization', 'startOidcAuthorization']);
    assert.deepEqual([...LEGACY_OIDC_OPERATION_IDS].sort(), ['completeOidcAuthorization', 'startOidcAuthorization']);
  });

  test('product route coverage requires legacy OIDC in legacy mode and excludes it in Better Auth mode', () => {
    const all = new Set(PRODUCT_ROUTE_MANIFEST.map((route) => `${route.method} ${route.path}`));
    const withoutLegacyOidc = new Set([...all].filter((key) => !key.includes('/api/v1/auth/oidc/')));
    assert.equal(all.size - withoutLegacyOidc.size, 2, 'the generated manifest must still carry both legacy OIDC paths');

    assert.throws(() => assertProductRouteCoverage(withoutLegacyOidc), /oidc\/start/u);
    assert.doesNotThrow(() => assertProductRouteCoverage(withoutLegacyOidc, LEGACY_OIDC_OPERATION_IDS));
  });
});

describe('F2 telemetry redaction (Better Auth session material)', () => {
  test('structured log bindings redact Better Auth session/password/OTP/csrf fields', async () => {
    const lines: string[] = [];
    const destination = {
      write(chunk: string) {
        lines.push(chunk);
      },
    };
    const logger = createLogger('info', destination as never);
    logger.info({
      password: 'super-secret-pw', // secret-scan: allow 'super-secret-pw'
      otp: '123456',
      sessionToken: 'raw-session-token-value',
      sessionTokenHash: 'raw-token-hash-value',
      csrfToken: 'raw-csrf-token-value',
      cookie: '__Host-known_session=abc.def',
    }, 'auth event');
    const output = lines.join('');
    for (const secret of [
      'super-secret-pw',
      '123456',
      'raw-session-token-value',
      'raw-token-hash-value',
      'raw-csrf-token-value',
      'abc.def',
    ]) {
      assert.equal(output.includes(secret), false, `${secret} must be redacted from log output`);
    }
    assert.match(output, /\[REDACTED\]/u);
  });

  test('redactSensitiveText covers the BA session cookie and csrf values', () => {
    const redacted = redactSensitiveText(
      '__Host-known_session=abcdefghijklmnopqrstuvwxyz012345.signature==; csrfToken=csrf-raw-value; password=hunter2',
    );
    for (const secret of ['abcdefghijklmnopqrstuvwxyz012345', 'csrf-raw-value', 'hunter2']) {
      assert.equal(redacted.includes(secret), false, `${secret} must be redacted`);
    }
  });
});

describe('F3 zero-call contract: the active frontend carries no legacy OIDC entry (plan §12 F3 class 5)', () => {
  test('startOidcLogin / loginWithOidc / /api/v1/auth/oidc are gone from Known-Frontend/web/src with a positive control', () => {
    const webSrcRoot = resolve(backendRoot, '../Known-Frontend/web/src');
    const files = walkSourceFiles(webSrcRoot);
    assert.ok(files.length > 0, 'the active frontend source tree must be scanned');

    const patterns = [
      { id: 'symbol:startOidcLogin', pattern: /\bstartOidcLogin\b/u },
      { id: 'symbol:loginWithOidc', pattern: /\bloginWithOidc\b/u },
      { id: 'route:/api/v1/auth/oidc', pattern: /\/api\/v1\/auth\/oidc\b/u },
    ];
    const hits: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const { id, pattern } of patterns) {
        if (pattern.test(source)) {
          hits.push(`${file.replace(`${webSrcRoot}/`, '')}: ${id}`);
        }
      }
    }
    assert.deepEqual(hits, [], `F3 removed the legacy OIDC browser entries; undeclared hits: ${hits.join(', ')}`);

    // Positive control: the new OAuth entry must still exist — the scan is
    // never vacuously green (mirrors auth-runtime-evidence class 5).
    const authClient = readFileSync(resolve(webSrcRoot, 'api/authClient.ts'), 'utf8');
    assert.match(authClient, /\bstartOAuth\b/u, 'authClient.startOAuth (the new OAuth entry) must still exist');
  });
});

/** Recursive walk of a source root returning .ts/.tsx files (skips build/vendor dirs). */
function walkSourceFiles(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        if (['node_modules', 'dist', 'build', 'coverage'].includes(entry.name)) continue;
        stack.push(path);
      } else if (/\.(?:ts|tsx|mts|cts)$/u.test(entry.name)) {
        out.push(path);
      }
    }
  }
  return out;
}
