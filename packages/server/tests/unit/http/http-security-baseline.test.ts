import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import {
  assertOidcEndpointUrl,
  isMetadataHost,
  isPrivateOrLocalHost,
  oidcEndpointPolicyMode,
} from '../../../src/bootstrap/oidc-endpoint-policy.js';
import type { IdentityUnitOfWork } from '../../../src/modules/identity/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { version } from '../../../src/version.js';
import {
  AUTH_RATE_LIMITED_PATHS,
  authRateLimitRouteFamilyForPath,
  createFixedWindowRateLimiter,
  createMemoryAuthRateLimiter,
  createMemorySearchRateLimiter,
  isAuthRateLimitedPath,
} from '../../../src/transport/http-security.js';
import {
  type AuthRateLimiter,
  type SearchRateLimiter,
  createMemoryEmailCallbackRateLimiter,
} from '../../../src/infrastructure/rate-limit/index.js';
import { buildSessionSetCookie, SESSION_COOKIE_NAME } from '../../../src/transport/session-cookie.js';
import {
  effectPageRateLimitSharedEnv,
  productRouteRateLimitSharedEnv,
  productionEnv,
  publicActivityRateLimitSharedEnv,
  syncRateLimitSharedEnv,
  testEnv,
} from '../../support/http-security-config-env.js';

/** Minimal identity UoW so browser-auth routes register for rate-limit tests. */
function emptyIdentityUnitOfWork(): IdentityUnitOfWork {
  return {
    execute: async () => {
      throw new Error('identity work not expected in http-security tests');
    },
  };
}

const apps: Array<ReturnType<typeof buildApiApp>> = [];

/** Shared Search rate-limit adapter env (FIX-M-006). */
function searchSharedEnv(overrides: Record<string, string> = {}) {
  return {
    SEARCH_RATE_LIMIT_SHARED: 'true',
    SEARCH_RATE_LIMIT_REDIS_URL: 'redis://127.0.0.1:6379',
    SEARCH_RATE_LIMIT_KEY_SECRET: 'search-rate-limit-hmac-secret-006',
    ...overrides,
  };
}

/** Shared Publishing Insights ingest rate-limit adapter env (S-02). */
function insightsSharedEnv(overrides: Record<string, string> = {}) {
  return {
    PUBLISHING_INSIGHTS_RATE_LIMIT_SHARED: 'true',
    PUBLISHING_INSIGHTS_RATE_LIMIT_REDIS_URL: 'redis://127.0.0.1:6379',
    ...overrides,
  };
}

/** Shared collaboration-invite rate-limit adapter env (S-04). */
function collaborationInviteSharedEnv(overrides: Record<string, string> = {}) {
  return {
    COLLABORATION_INVITE_RATE_LIMIT_SHARED: 'true',
    COLLABORATION_INVITE_RATE_LIMIT_REDIS_URL: 'redis://127.0.0.1:6379',
    COLLABORATION_INVITE_RATE_LIMIT_KEY_SECRET: 'collaboration-invite-rate-limit-hmac-secret',
    ...overrides,
  };
}

/** Shared Explore / COLP Directory rate-limit adapter env (P-04). */
function exploreDirectorySharedEnv(overrides: Record<string, string> = {}) {
  return {
    EXPLORE_DIRECTORY_RATE_LIMIT_SHARED: 'true',
    EXPLORE_DIRECTORY_RATE_LIMIT_REDIS_URL: 'redis://127.0.0.1:6379',
    EXPLORE_DIRECTORY_RATE_LIMIT_KEY_SECRET: 'explore-directory-rate-limit-hmac-secret',
    ...overrides,
  };
}

afterEach(async () => {
  while (apps.length > 0) {
    const app = apps.pop();
    await app?.close();
  }
});

describe('OIDC endpoint policy', () => {
  test('production policy rejects HTTP, private, and metadata endpoints', () => {
    assert.throws(
      () => assertOidcEndpointUrl('OIDC_TOKEN_ENDPOINT', 'http://issuer.example/token', 'strict'),
      /must use https/,
    );
    assert.throws(
      () => assertOidcEndpointUrl('OIDC_JWKS_URI', 'https://127.0.0.1/jwks', 'strict'),
      /private, loopback, or link-local/,
    );
    assert.throws(
      () => assertOidcEndpointUrl('OIDC_JWKS_URI', 'https://10.0.0.5/jwks', 'strict'),
      /private, loopback, or link-local/,
    );
    assert.throws(
      () => assertOidcEndpointUrl('OIDC_JWKS_URI', 'https://169.254.169.254/latest', 'strict'),
      /metadata/,
    );
    assert.throws(
      () => assertOidcEndpointUrl('OIDC_ISSUER', 'https://user:pass@issuer.example/', 'strict'),
      /userinfo/,
    );
    assert.throws(
      () => assertOidcEndpointUrl('OIDC_JWKS_URI', 'https://metadata.google.internal/jwks', 'strict'),
      /metadata/,
    );
  });

  test('relaxed test mode allows http and private hosts but still blocks metadata', () => {
    assert.doesNotThrow(() =>
      assertOidcEndpointUrl('OIDC_TOKEN_ENDPOINT', 'http://127.0.0.1:8080/token', 'relaxed'));
    assert.doesNotThrow(() =>
      assertOidcEndpointUrl('OIDC_AUTHORIZATION_ENDPOINT', 'http://localhost:9000/auth', 'relaxed'));
    assert.throws(
      () => assertOidcEndpointUrl('OIDC_JWKS_URI', 'http://169.254.169.254/latest', 'relaxed'),
      /metadata/,
    );
  });

  test('private/local and metadata host classifiers', () => {
    assert.equal(isPrivateOrLocalHost('127.0.0.1'), true);
    assert.equal(isPrivateOrLocalHost('10.1.2.3'), true);
    assert.equal(isPrivateOrLocalHost('192.168.1.1'), true);
    assert.equal(isPrivateOrLocalHost('172.20.0.2'), true);
    assert.equal(isPrivateOrLocalHost('::1'), true);
    assert.equal(isPrivateOrLocalHost('issuer.example'), false);
    assert.equal(isMetadataHost('169.254.169.254'), true);
    assert.equal(isMetadataHost('metadata.google.internal'), true);
    assert.equal(isMetadataHost('issuer.example'), false);
  });

  test('production PUBLICATION_CACHE_PURGE_ENDPOINT uses OIDC-grade private/metadata policy', () => {
    assert.throws(
      () => loadConfig(productionEnv({
        PUBLICATION_CACHE_PURGE_ENDPOINT: 'https://169.254.169.254/purge',
      })),
      /PUBLICATION_CACHE_PURGE_ENDPOINT/,
    );
    assert.throws(
      () => loadConfig(productionEnv({
        PUBLICATION_CACHE_PURGE_ENDPOINT: 'https://10.0.0.5/purge',
      })),
      /PUBLICATION_CACHE_PURGE_ENDPOINT/,
    );
    assert.throws(
      () => loadConfig(productionEnv({
        PUBLICATION_CACHE_PURGE_ENDPOINT: 'https://metadata.google.internal/purge',
      })),
      /PUBLICATION_CACHE_PURGE_ENDPOINT/,
    );
    assert.doesNotThrow(() => loadConfig(productionEnv({
      PUBLICATION_CACHE_PURGE_ENDPOINT: 'https://purge.example.test/v1/cache',
    })));
  });

  test('loadConfig production rejects disallowed OIDC endpoints and http product origin', () => {
    assert.throws(
      () => loadConfig(productionEnv({ OIDC_TOKEN_ENDPOINT: 'http://issuer.example/token' })),
      /must use https/,
    );
    assert.throws(
      () => loadConfig(productionEnv({ OIDC_JWKS_URI: 'https://10.0.0.8/jwks' })),
      /private, loopback, or link-local/,
    );
    assert.throws(
      () => loadConfig(productionEnv({
        OIDC_TOKEN_ENDPOINT: 'https://tokens.example/token',
      })),
      /origin must match OIDC_ISSUER|OIDC_ENDPOINT_ALLOWED_ORIGINS/,
    );
    assert.doesNotThrow(() => loadConfig(productionEnv({
      OIDC_TOKEN_ENDPOINT: 'https://tokens.example/token',
      OIDC_ENDPOINT_ALLOWED_ORIGINS: 'https://tokens.example',
    })));
    assert.throws(
      () => loadConfig(productionEnv({
        OIDC_ENDPOINT_ALLOWED_ORIGINS: 'https://tokens.example/path',
      })),
      /exact origins/,
    );
    assert.throws(
      () => loadConfig(productionEnv({
        PRODUCT_ORIGIN: 'http://app.example.test',
        OIDC_REDIRECT_URI: 'http://app.example.test/api/v1/auth/oidc/callback',
      })),
      /PRODUCT_ORIGIN must use https/,
    );
    assert.throws(
      () => loadConfig(productionEnv({
        OIDC_REDIRECT_URI: 'https://evil.example/callback',
      })),
      /OIDC_REDIRECT_URI origin must match PRODUCT_ORIGIN/,
    );
  });

  test('loadConfig test mode allows private http OIDC endpoints', () => {
    const config = loadConfig(testEnv({
      OIDC_ISSUER: 'http://127.0.0.1:9999/realms/known',
      OIDC_AUTHORIZATION_ENDPOINT: 'http://127.0.0.1:9999/auth',
      OIDC_TOKEN_ENDPOINT: 'http://127.0.0.1:9999/token',
      OIDC_JWKS_URI: 'http://127.0.0.1:9999/jwks',
    }));
    assert.equal(config.oidc.allowTestProvider, true);
    assert.equal(config.oidc.tokenEndpoint, 'http://127.0.0.1:9999/token');
    assert.equal(oidcEndpointPolicyMode({
      nodeEnv: config.nodeEnv,
      allowTestProvider: config.oidc.allowTestProvider,
    }), 'relaxed');
  });

  test('test-provider enablement outside NODE_ENV=test fails closed', () => {
    assert.throws(
      () => loadConfig(testEnv({
        NODE_ENV: 'development',
        OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs',
      })),
      /OIDC_ALLOW_TEST_PROVIDER requires NODE_ENV=test/,
    );
    assert.throws(
      () => loadConfig(testEnv({ NODE_ENV: 'staging' })),
      /OIDC_ALLOW_TEST_PROVIDER requires NODE_ENV=test/,
    );
  });

  test('test-provider mode without an explicit HMAC secret fails closed', () => {
    const { OIDC_TEST_PROVIDER_HMAC_SECRET: _omitted, ...withoutSecret } = testEnv();
    assert.throws(
      () => loadConfig({ ...withoutSecret, OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs' }),
      /OIDC_TEST_PROVIDER_HMAC_SECRET is required when OIDC_ALLOW_TEST_PROVIDER=true/,
    );
  });
});

describe('EMAIL_OPS_TOKEN startup gate (SEC-T-08)', () => {
  test('a length-8 token refuses startup', () => {
    assert.throws(
      () => loadConfig(testEnv({ EMAIL_OPS_TOKEN: 'shorttok' })),
      /EMAIL_OPS_TOKEN must be at least 32 characters/u,
    );
  });

  test('unset EMAIL_OPS_TOKEN stays null', () => {
    const config = loadConfig(testEnv());
    assert.equal(config.email.opsToken, null);
  });

  test('EMAIL_OPS_TOKEN must not equal a loaded BETTER_AUTH_SECRET', () => {
    const secret = 'prod-better-auth-secret-0123456789abcdef'; // secret-scan: allow 'prod-better-auth-secret-0123456789abcdef'
    assert.throws(
      () => loadConfig(testEnv({
        BETTER_AUTH_ENABLED: 'true',
        BETTER_AUTH_SECRET: secret,
        EMAIL_OPS_TOKEN: secret,
      })),
      /EMAIL_OPS_TOKEN must not equal BETTER_AUTH_SECRET/u,
    );
  });
});

describe('session cookie production settings', () => {
  test('__Host- cookie attributes are production-safe', () => {
    assert.equal(SESSION_COOKIE_NAME, '__Host-known_session');
    const set = buildSessionSetCookie('raw-token', { maxAgeSeconds: 3_600 });
    assert.match(set, /^__Host-known_session=/);
    assert.match(set, /HttpOnly/);
    assert.match(set, /Secure/);
    assert.match(set, /SameSite=Lax/);
    assert.match(set, /Path=\//);
    assert.doesNotMatch(set, /Domain=/i);
    const clear = buildSessionSetCookie('', { maxAgeSeconds: 0, clear: true });
    assert.match(clear, /Max-Age=0/);
    assert.match(clear, /Secure/);
    assert.doesNotMatch(clear, /Domain=/i);
  });

  test('production config freezes session cookie name and HSTS flag', () => {
    const config = loadConfig(productionEnv());
    assert.equal(config.sessionCookieName, '__Host-known_session');
    assert.equal(config.httpSecurity.enableHsts, true);
    assert.equal(config.productOrigin.startsWith('https:'), true);
  });
});

describe('HTTP security headers and health isolation', () => {
  test('API responses include baseline security headers; production adds HSTS', async () => {
    const config = loadConfig(productionEnv());
    const app = buildApiApp({ config });
    apps.push(app);

    const health = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(health.statusCode, 200);
    assert.equal(health.headers['x-content-type-options'], 'nosniff');
    assert.equal(health.headers['x-frame-options'], 'DENY');
    assert.equal(health.headers['referrer-policy'], 'no-referrer');
    assert.match(String(health.headers['permissions-policy'] ?? ''), /camera=\(\)/);
    assert.equal(health.headers['cross-origin-resource-policy'], 'same-site');
    assert.equal(health.headers['cross-origin-opener-policy'], 'same-origin');
    assert.match(String(health.headers['content-security-policy'] ?? ''), /default-src 'none'/);
    assert.equal(health.headers['strict-transport-security'], 'max-age=31536000; includeSubDomains');

    const ready = await app.inject({ method: 'GET', url: '/ready' });
    assert.equal(ready.statusCode, 200);
    assert.equal(ready.headers['x-content-type-options'], 'nosniff');
  });

  test('non-production does not emit HSTS by default', async () => {
    const config = loadConfig(testEnv());
    const app = buildApiApp({ config });
    apps.push(app);
    const health = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(health.statusCode, 200);
    assert.equal(health.headers['strict-transport-security'], undefined);
    assert.equal(health.headers['x-content-type-options'], 'nosniff');
  });
});

describe('auth rate limit boundary and reset', () => {
  test('rate limiter enforces max and resets after window', () => {
    let now = 1_000;
    const limiter = createFixedWindowRateLimiter({
      maxRequests: 2,
      windowMs: 1_000,
      now: () => now,
    });
    assert.equal(limiter.consume('k').allowed, true);
    assert.equal(limiter.consume('k').allowed, true);
    const blocked = limiter.consume('k');
    assert.equal(blocked.allowed, false);
    if (!blocked.allowed) {
      assert.equal(blocked.retryAfterSeconds >= 1, true);
    }
    now = 2_100;
    assert.equal(limiter.consume('k').allowed, true);
    limiter.reset();
    assert.equal(limiter.size(), 0);
  });

  test('session/auth routes are rate limited; health is not', async () => {
    const limiter = createMemoryAuthRateLimiter({ maxRequests: 2, windowMs: 60_000 });
    const config = loadConfig(testEnv({
      AUTH_RATE_LIMIT_MAX: '2',
      AUTH_RATE_LIMIT_WINDOW_MS: '60000',
    }));
    const app = buildApiApp({
      config,
      authRateLimiter: limiter,
      identityUnitOfWork: emptyIdentityUnitOfWork(),
    });
    apps.push(app);

    for (const path of AUTH_RATE_LIMITED_PATHS) {
      assert.equal(isAuthRateLimitedPath(path), true);
    }
    assert.equal(isAuthRateLimitedPath('/health'), false);
    assert.equal(isAuthRateLimitedPath('/ready'), false);

    const first = await app.inject({ method: 'GET', url: '/api/v1/session' });
    const second = await app.inject({ method: 'GET', url: '/api/v1/session' });
    const third = await app.inject({ method: 'GET', url: '/api/v1/session' });
    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 200);
    assert.equal(third.statusCode, 429);
    assert.equal(third.json().error.code, 'rate_limited');
    assert.ok(third.headers['retry-after']);
    assert.equal(third.headers['ratelimit-policy'], 'auth:session:2:60000');
    assert.equal(typeof third.json().error.retryAfterSeconds, 'number');

    // Route-family isolation: /api/v1/me is a different family, so the same
    // client is still admitted (401 = unauthenticated, not 429) while the
    // session family stays exhausted.
    const me = await app.inject({ method: 'GET', url: '/api/v1/me' });
    assert.equal(me.statusCode, 401);
    assert.notEqual(me.statusCode, 429);
    const sessionAgain = await app.inject({ method: 'GET', url: '/api/v1/session' });
    assert.equal(sessionAgain.statusCode, 429, 'the session family stays exhausted');

    // Health remains available under auth rate pressure.
    const health = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(health.statusCode, 200);
    assert.deepEqual(health.json(), { status: 'ok', version });

    limiter.reset();
    const afterReset = await app.inject({ method: 'GET', url: '/api/v1/session' });
    assert.equal(afterReset.statusCode, 200);
  });

  test('avatar upload is auth-rate-limited and shares the /me family budget', async () => {
    const limiter = createMemoryAuthRateLimiter({ maxRequests: 2, windowMs: 60_000 });
    const config = loadConfig(testEnv({
      AUTH_RATE_LIMIT_MAX: '2',
      AUTH_RATE_LIMIT_WINDOW_MS: '60000',
    }));
    const app = buildApiApp({
      config,
      authRateLimiter: limiter,
      identityUnitOfWork: emptyIdentityUnitOfWork(),
    });
    apps.push(app);

    // The avatar upload path is part of the auth rate-limit surface and maps
    // to the existing 'me' family (no new sealed family).
    assert.equal(isAuthRateLimitedPath('/api/v1/me/avatar'), true);
    assert.equal(authRateLimitRouteFamilyForPath('/api/v1/me/avatar'), 'me');

    // POST /api/v1/me/avatar consumes the auth budget in the onRequest hook
    // (the route itself 401s unauthenticated, but the hook runs first): the
    // third request is denied with the auth rate-limit response.
    const first = await app.inject({ method: 'POST', url: '/api/v1/me/avatar' });
    const second = await app.inject({ method: 'POST', url: '/api/v1/me/avatar' });
    const third = await app.inject({ method: 'POST', url: '/api/v1/me/avatar' });
    assert.equal(first.statusCode, 401, 'unauthenticated upload is an auth failure, not a rate-limit denial');
    assert.equal(second.statusCode, 401);
    assert.equal(third.statusCode, 429);
    assert.equal(third.json().error.code, 'rate_limited');
    assert.ok(third.headers['retry-after']);
    assert.equal(third.headers['ratelimit-policy'], 'auth:me:2:60000');

    // Budget sharing: exhausting /api/v1/me must also throttle avatar uploads
    // (one 'me' counter serves both surfaces).
    limiter.reset();
    await app.inject({ method: 'GET', url: '/api/v1/me' });
    await app.inject({ method: 'GET', url: '/api/v1/me' });
    const meExhausted = await app.inject({ method: 'POST', url: '/api/v1/me/avatar' });
    assert.equal(meExhausted.statusCode, 429, 'exhausting /me must also throttle avatar uploads');
    assert.equal(meExhausted.json().error.code, 'rate_limited');

    // And the reverse: avatar uploads consume the same budget as /api/v1/me.
    limiter.reset();
    await app.inject({ method: 'POST', url: '/api/v1/me/avatar' });
    await app.inject({ method: 'POST', url: '/api/v1/me/avatar' });
    const avatarExhausted = await app.inject({ method: 'GET', url: '/api/v1/me' });
    assert.equal(avatarExhausted.statusCode, 429, 'exhausting avatar uploads must also throttle /me');

    // Other families keep their own budgets while 'me' is exhausted.
    const session = await app.inject({ method: 'GET', url: '/api/v1/session' });
    assert.equal(session.statusCode, 200);
  });
});

describe('in-memory limiter TTL sweep and capacity bound (FIX-M-002)', () => {
  test('expired buckets are swept once the interval elapses; size drops and evictions count', () => {
    let now = 0;
    const limiter = createFixedWindowRateLimiter({
      maxRequests: 100,
      windowMs: 1_000,
      sweepIntervalMs: 1_000,
      now: () => now,
    });
    for (let i = 0; i < 50; i += 1) {
      assert.equal(limiter.consume(`key-${i}`).allowed, true);
    }
    assert.equal(limiter.size(), 50);

    // Past one full window every bucket is expired; the next consume
    // triggers the amortized sweep and the map shrinks back down.
    now = 2_500;
    assert.equal(limiter.consume('probe').allowed, true);
    assert.equal(limiter.size(), 1);
    assert.equal(limiter.evictions(), 50);

    // A previously swept key starts with a fresh budget, not a stale bucket.
    now = 3_000;
    assert.equal(limiter.consume('key-0').allowed, true);
  });

  test('sweep removes only expired buckets; live count and resetAt are preserved', () => {
    let now = 0;
    const limiter = createFixedWindowRateLimiter({
      maxRequests: 2,
      windowMs: 2_000,
      sweepIntervalMs: 1_000,
      now: () => now,
    });
    assert.equal(limiter.consume('live').allowed, true);
    assert.equal(limiter.consume('live').allowed, true);
    assert.equal(limiter.consume('live').allowed, false);

    // Half a window later the sweep interval has elapsed but 'live' is not
    // expired: its count and resetAt must survive untouched.
    now = 1_500;
    assert.equal(limiter.consume('other').allowed, true);
    const blocked = limiter.consume('live');
    assert.equal(blocked.allowed, false, 'live bucket count must survive the sweep');
    if (!blocked.allowed) {
      assert.equal(blocked.retryAfterSeconds, 1, 'retry reflects the original resetAt');
    }
    assert.equal(limiter.evictions(), 0);
    assert.equal(limiter.size(), 2);
  });

  test('at capacity a new key is rejected without evicting live buckets', () => {
    let now = 0;
    const limiter = createFixedWindowRateLimiter({
      maxRequests: 5,
      windowMs: 10_000,
      maxBuckets: 2,
      now: () => now,
    });
    assert.equal(limiter.consume('a').allowed, true);
    assert.equal(limiter.consume('b').allowed, true);
    assert.equal(limiter.size(), 2);

    // Overload policy: the third distinct key is denied; existing buckets
    // are neither evicted nor reset.
    const blocked = limiter.consume('c');
    assert.equal(blocked.allowed, false);
    if (!blocked.allowed) {
      assert.ok(blocked.retryAfterSeconds >= 1);
    }
    assert.equal(limiter.capacityRejections(), 1);
    assert.equal(limiter.size(), 2);
    assert.equal(limiter.consume('a').allowed, true, 'existing live buckets keep working');

    // Once the window elapses the (default-interval) sweep frees capacity.
    now = 11_000;
    assert.equal(limiter.consume('c').allowed, true);
    assert.equal(limiter.evictions(), 2);
    assert.equal(limiter.size(), 1);
  });

  test('capacity rejection reports the time until the earliest bucket expires', () => {
    let now = 0;
    const limiter = createFixedWindowRateLimiter({
      maxRequests: 10,
      windowMs: 60_000,
      maxBuckets: 1,
      now: () => now,
    });
    assert.equal(limiter.consume('only').allowed, true);
    now = 30_000;
    const blocked = limiter.consume('other');
    assert.equal(blocked.allowed, false);
    if (!blocked.allowed) {
      assert.equal(blocked.retryAfterSeconds, 30);
    }
    assert.equal(limiter.size(), 1);
  });

  test('capacity retry uses the next expiry after an old key reopens, even across clock rollback', () => {
    let now = 0;
    const limiter = createFixedWindowRateLimiter({ maxRequests: 1, windowMs: 10_000,
      maxBuckets: 2, sweepIntervalMs: 100_000, now: () => now });
    limiter.consume('first');
    now = 5_000; limiter.consume('second');
    now = 10_000; limiter.consume('first');
    assert.deepEqual(limiter.consume('new'), { allowed: false, retryAfterSeconds: 5 });
    now = 1_000;
    assert.deepEqual(limiter.consume('new'), { allowed: false, retryAfterSeconds: 5 });
  });

  test('reset clears buckets, counters and the sweep schedule', () => {
    let now = 0;
    const limiter = createFixedWindowRateLimiter({
      maxRequests: 1,
      windowMs: 1_000,
      sweepIntervalMs: 500,
      maxBuckets: 1,
      now: () => now,
    });
    limiter.consume('a');
    now = 2_000;
    limiter.consume('a'); // triggers the sweep -> one eviction
    limiter.consume('b'); // capacity is still full -> one rejection
    assert.equal(limiter.evictions(), 1);
    assert.equal(limiter.capacityRejections(), 1);
    limiter.reset();
    assert.equal(limiter.size(), 0);
    assert.equal(limiter.evictions(), 0);
    assert.equal(limiter.capacityRejections(), 0);
  });

  test('memory auth adapter forwards size, eviction and capacity metrics', async () => {
    let now = 0;
    const limiter = createMemoryAuthRateLimiter({
      maxRequests: 10,
      windowMs: 1_000,
      sweepIntervalMs: 500,
      now: () => now,
    });
    const subject = { routeFamily: 'session' as const, clientIp: '203.0.113.10' };
    assert.equal((await limiter.consume(subject)).kind, 'allowed');
    assert.equal(limiter.size(), 1);
    now = 2_000;
    assert.equal((await limiter.consume({ ...subject, clientIp: '198.51.100.20' })).kind, 'allowed');
    assert.equal(limiter.evictions(), 1);
    assert.equal(limiter.capacityRejections(), 0);
  });

  test('invalid maxBuckets and sweepIntervalMs fail closed', () => {
    assert.throws(
      () => createFixedWindowRateLimiter({ maxRequests: 1, windowMs: 1_000, maxBuckets: 0 }),
      /maxBuckets/,
    );
    assert.throws(
      () => createFixedWindowRateLimiter({ maxRequests: 1, windowMs: 1_000, maxBuckets: 1.5 }),
      /maxBuckets/,
    );
    assert.throws(
      () => createFixedWindowRateLimiter({ maxRequests: 1, windowMs: 1_000, sweepIntervalMs: -1 }),
      /sweepIntervalMs/,
    );
  });
});

describe('trusted ingress allowlist (FIX-M-006)', () => {
  async function clientIpApp(overrides: Record<string, string> = {}) {
    const config = loadConfig(testEnv(overrides));
    const app = buildApiApp({ config });
    apps.push(app);
    let observedIp: string | undefined;
    app.get('/__test/client-ip', async (request) => {
      observedIp = request.ip;
      return { ip: request.ip, ips: request.ips ?? null };
    });
    return { app, observedIp: () => observedIp };
  }

  test('no allowlist and hops=0 does not trust spoofable X-Forwarded-For for rate limit keying', async () => {
    const limiter = createMemoryAuthRateLimiter({ maxRequests: 1, windowMs: 60_000 });
    const config = loadConfig(testEnv({
      TRUSTED_PROXY_HOPS: '0',
      AUTH_RATE_LIMIT_MAX: '1',
    }));
    assert.equal(config.httpSecurity.trustedProxyHops, 0);
    assert.deepEqual(config.httpSecurity.trustedIngress, []);
    const app = buildApiApp({
      config,
      authRateLimiter: limiter,
      identityUnitOfWork: emptyIdentityUnitOfWork(),
    });
    apps.push(app);

    const first = await app.inject({
      method: 'GET',
      url: '/api/v1/session',
      headers: { 'x-forwarded-for': '203.0.113.10' },
    });
    assert.equal(first.statusCode, 200);

    // Same peer, different spoofed XFF must still share the rate-limit bucket.
    const second = await app.inject({
      method: 'GET',
      url: '/api/v1/session',
      headers: { 'x-forwarded-for': '198.51.100.20' },
    });
    assert.equal(second.statusCode, 429);
  });

  test('a socket peer inside the allowlist resolves the forwarded client for request.ip', async () => {
    const { app, observedIp } = await clientIpApp({ TRUSTED_INGRESS: '127.0.0.1' });
    const response = await app.inject({
      method: 'GET',
      url: '/__test/client-ip',
      headers: { 'x-forwarded-for': '203.0.113.55' },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().ip, '203.0.113.55');
    assert.equal(observedIp(), '203.0.113.55');
  });

  test('CIDR allowlist entries match; an untrusted peer XFF is ignored (peer address wins)', async () => {
    const { app } = await clientIpApp({ TRUSTED_INGRESS: '10.0.0.0/8' });
    const trusted = await app.inject({
      method: 'GET',
      url: '/__test/client-ip',
      remoteAddress: '10.0.0.2',
      headers: { 'x-forwarded-for': '203.0.113.55' },
    });
    assert.equal(trusted.json().ip, '203.0.113.55', 'the trusted peer forwards the client');

    const direct = await app.inject({
      method: 'GET',
      url: '/__test/client-ip',
      remoteAddress: '198.51.100.9',
      headers: { 'x-forwarded-for': '203.0.113.55' },
    });
    assert.equal(direct.json().ip, '198.51.100.9', 'an untrusted peer can never spoof the client IP');
  });

  test('IPv4-mapped IPv6 peers match the allowlist (Node reports IPv4 peers as ::ffff:a.b.c.d)', async () => {
    const { app } = await clientIpApp({ TRUSTED_INGRESS: '10.0.0.0/8' });
    const mapped = await app.inject({
      method: 'GET',
      url: '/__test/client-ip',
      remoteAddress: '::ffff:10.0.0.2',
      headers: { 'x-forwarded-for': '203.0.113.55' },
    });
    assert.equal(mapped.json().ip, '203.0.113.55', 'the mapped peer is inside the IPv4 CIDR');

    // IPv4-mapped ENTRY normalization: ::ffff:10.0.0.2 == 10.0.0.2.
    const mappedEntry = loadConfig(testEnv({ TRUSTED_INGRESS: '::ffff:10.0.0.2' }));
    assert.deepEqual(mappedEntry.httpSecurity.trustedIngress, ['10.0.0.2']);
    const mappedEntryCidr = loadConfig(testEnv({ TRUSTED_INGRESS: '::ffff:10.0.0.0/104' }));
    assert.deepEqual(mappedEntryCidr.httpSecurity.trustedIngress, ['10.0.0.0/8']);
  });

  test('multi-level proxy chains resolve while every hop is trusted; client-injected leftmost XFF never wins', async () => {
    const { app } = await clientIpApp({ TRUSTED_INGRESS: '10.0.0.0/8' });
    // client -> LB (10.0.0.8) -> nginx (10.0.0.9) -> API; XFF appended by each hop.
    const chained = await app.inject({
      method: 'GET',
      url: '/__test/client-ip',
      remoteAddress: '10.0.0.9',
      headers: { 'x-forwarded-for': '203.0.113.55, 10.0.0.8' },
    });
    assert.equal(chained.json().ip, '203.0.113.55', 'both trusted hops are consumed before the client');

    // A client behind nginx spoofs X-Forwarded-For; nginx appends the real
    // client at the right, so the spoofed leftmost value is never used.
    const spoofed = await app.inject({
      method: 'GET',
      url: '/__test/client-ip',
      remoteAddress: '10.0.0.2',
      headers: { 'x-forwarded-for': '6.6.6.6, 203.0.113.55' },
    });
    assert.equal(spoofed.json().ip, '203.0.113.55', 'the spoofed first hop is ignored');

    // All hops trusted (client on the same subnet as the proxies) resolves
    // the left-most entry — the documented allowlist caveat.
    const allTrusted = await app.inject({
      method: 'GET',
      url: '/__test/client-ip',
      remoteAddress: '10.0.0.2',
      headers: { 'x-forwarded-for': '10.0.0.7, 10.0.0.8' },
    });
    assert.equal(allTrusted.json().ip, '10.0.0.7');
  });

  test('IPv6 CIDR allowlist entries resolve forwarded IPv6 clients', async () => {
    const { app } = await clientIpApp({ TRUSTED_INGRESS: 'fd00::/8' });
    const response = await app.inject({
      method: 'GET',
      url: '/__test/client-ip',
      remoteAddress: 'fd00::1',
      headers: { 'x-forwarded-for': '2001:db8::5' },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().ip, '2001:db8::5');
  });

  test('loadConfig parses and validates TRUSTED_INGRESS fail closed', () => {
    const ok = loadConfig(testEnv({ TRUSTED_INGRESS: '127.0.0.1, 10.0.0.0/8, fd00::/8, ::1' }));
    assert.deepEqual(ok.httpSecurity.trustedIngress, ['127.0.0.1', '10.0.0.0/8', 'fd00::/8', '::1']);
    assert.equal(ok.httpSecurity.trustedIngressDeclared, true);

    const undeclared = loadConfig(testEnv());
    assert.equal(undeclared.httpSecurity.trustedIngressDeclared, false);
    assert.deepEqual(undeclared.httpSecurity.trustedIngress, []);

    const declaredEmpty = loadConfig(testEnv({ TRUSTED_INGRESS: '' }));
    assert.equal(declaredEmpty.httpSecurity.trustedIngressDeclared, true);
    assert.deepEqual(declaredEmpty.httpSecurity.trustedIngress, []);

    for (const invalid of ['10.0.0.0/33', '10.0.0.0/0', 'garbage', '300.1.2.3', '::ffff:10.0.0.0/95',
      '::ffff:not-an-ip', '10.0.0.0/8/8', 'fd00::/129']) {
      assert.throws(
        () => loadConfig(testEnv({ TRUSTED_INGRESS: invalid })),
        /TRUSTED_INGRESS/,
        invalid,
      );
    }
  });

  test('loadConfig still validates TRUSTED_PROXY_HOPS bounds (non-production fallback)', () => {
    assert.throws(
      () => loadConfig(testEnv({ TRUSTED_PROXY_HOPS: '-1' })),
      /TRUSTED_PROXY_HOPS/,
    );
    assert.throws(
      () => loadConfig(testEnv({ TRUSTED_PROXY_HOPS: '99' })),
      /TRUSTED_PROXY_HOPS/,
    );
    const ok = loadConfig(testEnv({ TRUSTED_PROXY_HOPS: '2' }));
    assert.equal(ok.httpSecurity.trustedProxyHops, 2);
  });

  test('production + empty TRUSTED_INGRESS + TRUSTED_PROXY_HOPS>0 refuses startup', () => {
    assert.throws(
      () => loadConfig(productionEnv({ TRUSTED_INGRESS: '', TRUSTED_PROXY_HOPS: '1' })),
      /TRUSTED_PROXY_HOPS/,
    );
    // Hop-count is refused even when an allowlist is present; operators must
    // zero TRUSTED_PROXY_HOPS rather than leave a leftover hop count.
    assert.throws(
      () => loadConfig(productionEnv({ TRUSTED_INGRESS: '10.0.0.0/8', TRUSTED_PROXY_HOPS: '1' })),
      /TRUSTED_PROXY_HOPS/,
    );
  });

  test('production non-empty allowlist still resolves forwarded clients; hops is not a green condition', async () => {
    const proxied = loadConfig(productionEnv({ TRUSTED_INGRESS: '10.0.0.0/8' }));
    assert.equal(proxied.httpSecurity.trustedIngressDeclared, true);
    assert.deepEqual(proxied.httpSecurity.trustedIngress, ['10.0.0.0/8']);
    assert.equal(proxied.httpSecurity.trustedProxyHops, 0);
    const prodApp = buildApiApp({ config: proxied });
    apps.push(prodApp);
    prodApp.get('/__test/client-ip', async (request) => ({ ip: request.ip }));
    const trusted = await prodApp.inject({
      method: 'GET',
      url: '/__test/client-ip',
      remoteAddress: '10.0.0.2',
      headers: { 'x-forwarded-for': '203.0.113.55' },
    });
    assert.equal(trusted.json().ip, '203.0.113.55');
    assert.equal((await prodApp.inject({ method: 'GET', url: '/ready' })).statusCode, 200);
  });

  test('non-production hop-count fallback still trusts X-Forwarded-For when allowlist is undeclared', async () => {
    const { app } = await clientIpApp({ TRUSTED_PROXY_HOPS: '1' });
    const forwarded = await app.inject({
      method: 'GET',
      url: '/__test/client-ip',
      headers: { 'x-forwarded-for': '203.0.113.55' },
    });
    assert.equal(forwarded.statusCode, 200);
    assert.equal(forwarded.json().ip, '203.0.113.55');
  });

  test('explicit empty TRUSTED_INGRESS never falls back to hop-count trustProxy', async () => {
    const { app } = await clientIpApp({ TRUSTED_INGRESS: '', TRUSTED_PROXY_HOPS: '1' });
    const spoofed = await app.inject({
      method: 'GET',
      url: '/__test/client-ip',
      headers: { 'x-forwarded-for': '203.0.113.55' },
    });
    assert.equal(spoofed.statusCode, 200);
    assert.notEqual(spoofed.json().ip, '203.0.113.55');
  });

  test('production readiness fails closed until TRUSTED_INGRESS is explicitly declared', async () => {
    const { TRUSTED_INGRESS: _omitted, ...withoutDeclaration } = productionEnv();
    const undeclaredConfig = loadConfig(withoutDeclaration);
    assert.equal(undeclaredConfig.httpSecurity.trustedIngressDeclared, false);
    const undeclaredApp = buildApiApp({ config: undeclaredConfig });
    apps.push(undeclaredApp);
    const notReady = await undeclaredApp.inject({ method: 'GET', url: '/ready' });
    assert.equal(notReady.statusCode, 503);
    assert.deepEqual(notReady.json(), { status: 'not-ready' });

    // An explicit empty declaration (direct peer-only exposure) is valid.
    const direct = loadConfig(productionEnv({ TRUSTED_INGRESS: '' }));
    assert.equal(direct.httpSecurity.trustedIngressDeclared, true);
    const directApp = buildApiApp({ config: direct });
    apps.push(directApp);
    assert.equal((await directApp.inject({ method: 'GET', url: '/ready' })).statusCode, 200);

    // An explicit allowlist declaration is valid.
    const proxied = loadConfig(productionEnv({ TRUSTED_INGRESS: '10.0.0.0/8' }));
    const proxiedApp = buildApiApp({ config: proxied });
    apps.push(proxiedApp);
    assert.equal((await proxiedApp.inject({ method: 'GET', url: '/ready' })).statusCode, 200);

    // Non-production keeps the pre-existing behavior (no gate).
    const testApp = buildApiApp({ config: loadConfig(testEnv()) });
    apps.push(testApp);
    assert.equal((await testApp.inject({ method: 'GET', url: '/ready' })).statusCode, 200);
  });
});

describe('bounded request settings', () => {
  test('http security defaults and overrides are applied to config', () => {
    const defaults = loadConfig(testEnv());
    assert.equal(defaults.httpSecurity.bodyLimitBytes, 131_072);
    assert.equal(defaults.httpSecurity.requestTimeoutMs, 30_000);
    assert.equal(defaults.httpSecurity.connectionTimeoutMs, 10_000);
    assert.equal(defaults.httpSecurity.authRateLimit.maxRequests, 60);
    // FIX-M-006: independent anonymous Search budget (PUB-R03).
    assert.equal(defaults.httpSecurity.searchRateLimit.anonymousMaxRequests, 30);
    assert.equal(defaults.httpSecurity.searchRateLimit.accountMaxRequests, 120);
    assert.equal(defaults.httpSecurity.searchRateLimit.windowMs, 60_000);

    const custom = loadConfig(testEnv({
      HTTP_BODY_LIMIT_BYTES: '65536',
      HTTP_REQUEST_TIMEOUT_MS: '15000',
      AUTH_RATE_LIMIT_MAX: '12',
      AUTH_RATE_LIMIT_WINDOW_MS: '30000',
      SEARCH_ANON_RATE_LIMIT_MAX: '10',
      SEARCH_ACCOUNT_RATE_LIMIT_MAX: '200',
    }));
    assert.equal(custom.httpSecurity.bodyLimitBytes, 65_536);
    assert.equal(custom.httpSecurity.requestTimeoutMs, 15_000);
    assert.equal(custom.httpSecurity.authRateLimit.maxRequests, 12);
    assert.equal(custom.httpSecurity.authRateLimit.windowMs, 30_000);
    assert.equal(custom.httpSecurity.searchRateLimit.anonymousMaxRequests, 10);
    assert.equal(custom.httpSecurity.searchRateLimit.accountMaxRequests, 200);
  });
});

describe('shared auth rate-limit adapter config (FIX-M-001)', () => {
  const sharedEnv = (overrides: Record<string, string> = {}) => ({
    AUTH_RATE_LIMIT_SHARED: 'true',
    AUTH_RATE_LIMIT_REDIS_URL: 'redis://127.0.0.1:6379',
    AUTH_RATE_LIMIT_KEY_SECRET: 'auth-rate-limit-hmac-secret-001',
    ...overrides,
  });

  test('disabled by default; enabled parses URL/secret/prefix/timeouts fail closed', () => {
    const defaults = loadConfig(testEnv());
    assert.equal(defaults.httpSecurity.authRateLimit.shared.enabled, false);
    assert.equal(defaults.httpSecurity.authRateLimit.shared.redisUrl, null);
    assert.equal(defaults.httpSecurity.authRateLimit.shared.keySecret, null);
    assert.equal(defaults.httpSecurity.authRateLimit.shared.keyPrefix, 'known');
    assert.equal(defaults.httpSecurity.authRateLimit.shared.commandTimeoutMs, 75);
    assert.equal(defaults.httpSecurity.authRateLimit.shared.connectTimeoutMs, 1000);
    assert.equal(defaults.httpSecurity.authRateLimit.shared.maxRetriesPerRequest, 1);

    const enabled = loadConfig(testEnv(sharedEnv({
      AUTH_RATE_LIMIT_KEY_PREFIX: 'auth-test',
      AUTH_RATE_LIMIT_COMMAND_TIMEOUT_MS: '250',
      AUTH_RATE_LIMIT_CONNECT_TIMEOUT_MS: '2000',
      AUTH_RATE_LIMIT_MAX_RETRIES_PER_REQUEST: '2',
    })));
    const shared = enabled.httpSecurity.authRateLimit.shared;
    assert.equal(shared.enabled, true);
    assert.equal(shared.redisUrl, 'redis://127.0.0.1:6379');
    assert.equal(shared.keySecret?.toString('utf8'), 'auth-rate-limit-hmac-secret-001');
    assert.equal(shared.keyPrefix, 'auth-test');
    assert.equal(shared.commandTimeoutMs, 250);
    assert.equal(shared.connectTimeoutMs, 2000);
    assert.equal(shared.maxRetriesPerRequest, 2);
  });

  test('shared=true without URL or secret fails closed; invalid values are rejected', () => {
    assert.throws(
      () => loadConfig(testEnv({ AUTH_RATE_LIMIT_SHARED: 'true' })),
      /AUTH_RATE_LIMIT_REDIS_URL is required/,
    );
    assert.throws(
      () => loadConfig(testEnv(sharedEnv({ AUTH_RATE_LIMIT_REDIS_URL: '' }))),
      /AUTH_RATE_LIMIT_REDIS_URL is required/,
    );
    assert.throws(
      () => loadConfig(testEnv(sharedEnv({ AUTH_RATE_LIMIT_KEY_SECRET: '' }))),
      /AUTH_RATE_LIMIT_KEY_SECRET is required/,
    );
    assert.throws(
      () => loadConfig(testEnv({ AUTH_RATE_LIMIT_SHARED: 'maybe' })),
      /AUTH_RATE_LIMIT_SHARED must be true or false/,
    );
    assert.throws(
      () => loadConfig(testEnv(sharedEnv({ AUTH_RATE_LIMIT_REDIS_URL: 'http://127.0.0.1:6379' }))),
      /AUTH_RATE_LIMIT_REDIS_URL must use redis:\/\/ or rediss:\/\//,
    );
    assert.throws(
      () => loadConfig(testEnv(sharedEnv({ AUTH_RATE_LIMIT_KEY_PREFIX: 'bad prefix!' }))),
      /AUTH_RATE_LIMIT_KEY_PREFIX/,
    );
    assert.throws(
      () => loadConfig(testEnv(sharedEnv({ AUTH_RATE_LIMIT_COMMAND_TIMEOUT_MS: '99999' }))),
      /AUTH_RATE_LIMIT_COMMAND_TIMEOUT_MS/,
    );
  });

  test('production multi-replica declaration without the shared adapters fails startup', () => {
    assert.throws(
      () => loadConfig(productionEnv({ AUTH_API_REPLICAS: '2' })),
      /AUTH_API_REPLICAS > 1.*AUTH_RATE_LIMIT_SHARED=true/s,
    );
    // Single-instance production without the shared adapters stays valid.
    assert.doesNotThrow(() => loadConfig(productionEnv()));
    // Multi-replica production with ONLY the auth adapter fails (FIX-M-006:
    // Search must share ONE Redis quota across replicas too).
    assert.throws(
      () => loadConfig(productionEnv(sharedEnv({ AUTH_API_REPLICAS: '2' }))),
      /AUTH_API_REPLICAS > 1.*SEARCH_RATE_LIMIT_SHARED=true/s,
    );
    assert.throws(
      () => loadConfig(productionEnv(sharedEnv(searchSharedEnv({ AUTH_API_REPLICAS: '2' })))),
      /AUTH_API_REPLICAS > 1.*PUBLISHING_INSIGHTS_RATE_LIMIT_SHARED=true/s,
    );
    assert.throws(
      () => loadConfig(productionEnv(sharedEnv(searchSharedEnv(insightsSharedEnv({ AUTH_API_REPLICAS: '2' }))))),
      /AUTH_API_REPLICAS > 1.*COLLABORATION_INVITE_RATE_LIMIT_SHARED=true/s,
    );
    assert.throws(
      () => loadConfig(productionEnv(sharedEnv(searchSharedEnv(insightsSharedEnv(collaborationInviteSharedEnv({ AUTH_API_REPLICAS: '2' })))))),
      /AUTH_API_REPLICAS > 1.*EXPLORE_DIRECTORY_RATE_LIMIT_SHARED=true/s,
    );
    assert.throws(
      () => loadConfig(productionEnv(sharedEnv(searchSharedEnv(insightsSharedEnv(collaborationInviteSharedEnv(exploreDirectorySharedEnv({ AUTH_API_REPLICAS: '2' }))))))),
      /AUTH_API_REPLICAS > 1.*PUBLIC_ACTIVITY_RATE_LIMIT_SHARED=true/s,
    );
    assert.throws(
      () => loadConfig(productionEnv(sharedEnv(searchSharedEnv(insightsSharedEnv(collaborationInviteSharedEnv(exploreDirectorySharedEnv(publicActivityRateLimitSharedEnv({ AUTH_API_REPLICAS: '2' })))))))),
      /AUTH_API_REPLICAS > 1.*PRODUCT_ROUTE_RATE_LIMIT_SHARED=true/s,
    );
    // Multi-replica production requires every always-mounted family, including
    // public Activity and the eight product-route admission purposes.
    const ok = loadConfig(productionEnv(sharedEnv(searchSharedEnv(insightsSharedEnv(collaborationInviteSharedEnv(exploreDirectorySharedEnv(publicActivityRateLimitSharedEnv(productRouteRateLimitSharedEnv({ AUTH_API_REPLICAS: '2' })))))))));
    assert.equal(ok.httpSecurity.authApiReplicas, 2);
    assert.equal(ok.httpSecurity.authRateLimit.shared.enabled, true);
    assert.equal(ok.httpSecurity.searchRateLimit.shared.enabled, true);
    assert.equal(ok.publishingInsights.rateLimitShared.enabled, true);
    assert.equal(ok.collaborationInviteRateLimit.enabled, true);
    assert.equal(ok.exploreDirectoryRateLimit.shared.enabled, true);
    assert.equal(ok.publicActivityRateLimit.shared.enabled, true);
    assert.equal(ok.productRouteRateLimitShared.enabled, true);
    assert.equal(ok.exploreDirectoryRateLimit.shared.keyPrefix, 'known-explore');
    assert.notEqual(ok.exploreDirectoryRateLimit.shared.keyPrefix, ok.httpSecurity.searchRateLimit.shared.keyPrefix);
    assert.equal(ok.syncRateLimit.shared.enabled, false);
    assert.equal(ok.syncRateLimit.shared.keyPrefix, 'known-sync');
    assert.notEqual(ok.syncRateLimit.shared.keyPrefix, ok.httpSecurity.searchRateLimit.shared.keyPrefix);
    // Non-production multi-replica may keep the in-process limiters.
    assert.doesNotThrow(() => loadConfig(testEnv({ AUTH_API_REPLICAS: '2' })));
  });

  test('production without COLLABORATION_INVITE_RATE_LIMIT_KEY_SECRET refuses startup', () => {
    const { COLLABORATION_INVITE_RATE_LIMIT_KEY_SECRET: _omitted, ...withoutSecret } = productionEnv();
    assert.throws(
      () => loadConfig(withoutSecret),
      /COLLABORATION_INVITE_RATE_LIMIT_KEY_SECRET is required/,
    );
    assert.throws(
      () => loadConfig(productionEnv({ COLLABORATION_INVITE_RATE_LIMIT_KEY_SECRET: '' })),
      /COLLABORATION_INVITE_RATE_LIMIT_KEY_SECRET is required/,
    );
    assert.throws(
      () => loadConfig(productionEnv({
        COLLABORATION_INVITE_RATE_LIMIT_KEY_SECRET: 'dev-collaboration-invite-rate-limit-hmac-key',
      })),
      /COLLABORATION_INVITE_RATE_LIMIT_KEY_SECRET must not use the development default/,
    );
    const single = loadConfig(productionEnv());
    assert.equal(single.collaborationInviteRateLimit.enabled, false);
    assert.equal(
      single.collaborationInviteRateLimit.keySecret.toString('utf8'),
      'prod-collaboration-invite-rate-limit-hmac',
    );
    const firstDev = loadConfig(testEnv());
    const secondDev = loadConfig(testEnv());
    assert.equal(firstDev.collaborationInviteRateLimit.enabled, false);
    assert.equal(
      firstDev.collaborationInviteRateLimit.keySecret.toString('utf8'),
      'dev-collaboration-invite-rate-limit-hmac-key',
    );
    assert.equal(
      firstDev.collaborationInviteRateLimit.keySecret.toString('utf8'),
      secondDev.collaborationInviteRateLimit.keySecret.toString('utf8'),
    );
  });

  test('shared adapter enabled without an injected limiter fails closed at composition', () => {
    const config = loadConfig(testEnv(sharedEnv()));
    assert.throws(
      () => buildApiApp({ config, identityUnitOfWork: emptyIdentityUnitOfWork() }),
      /injected authRateLimiter.*AUTH_RATE_LIMIT_SHARED=true/s,
    );
    // Injecting the memory adapter for tests keeps the shared config inert.
    const app = buildApiApp({
      config,
      authRateLimiter: createMemoryAuthRateLimiter({
        maxRequests: config.httpSecurity.authRateLimit.maxRequests,
        windowMs: config.httpSecurity.authRateLimit.windowMs,
      }),
      identityUnitOfWork: emptyIdentityUnitOfWork(),
    });
    apps.push(app);
  });
});

describe('shared Search rate-limit adapter config (FIX-M-006)', () => {
  test('independent anonymous budget defaults; enabled parses URL/secret/prefix/timeouts fail closed', () => {
    const defaults = loadConfig(testEnv());
    const search = defaults.httpSecurity.searchRateLimit;
    assert.equal(search.anonymousMaxRequests, 30);
    assert.equal(search.accountMaxRequests, 120);
    assert.equal(search.windowMs, 60_000);
    assert.equal(search.shared.enabled, false);
    assert.equal(search.shared.redisUrl, null);
    assert.equal(search.shared.keySecret, null);
    assert.equal(search.shared.keyPrefix, 'known');
    assert.equal(search.shared.commandTimeoutMs, 75);
    assert.equal(search.shared.connectTimeoutMs, 1000);
    assert.equal(search.shared.maxRetriesPerRequest, 1);

    const enabled = loadConfig(testEnv(searchSharedEnv({
      SEARCH_ANON_RATE_LIMIT_MAX: '15',
      SEARCH_ACCOUNT_RATE_LIMIT_MAX: '250',
      SEARCH_RATE_LIMIT_WINDOW_MS: '30000',
      SEARCH_RATE_LIMIT_KEY_PREFIX: 'search-test',
      SEARCH_RATE_LIMIT_COMMAND_TIMEOUT_MS: '250',
      SEARCH_RATE_LIMIT_CONNECT_TIMEOUT_MS: '2000',
      SEARCH_RATE_LIMIT_MAX_RETRIES_PER_REQUEST: '2',
    })));
    const shared = enabled.httpSecurity.searchRateLimit;
    assert.equal(shared.anonymousMaxRequests, 15);
    assert.equal(shared.accountMaxRequests, 250);
    assert.equal(shared.windowMs, 30_000);
    assert.equal(shared.shared.enabled, true);
    assert.equal(shared.shared.redisUrl, 'redis://127.0.0.1:6379');
    assert.equal(shared.shared.keySecret?.toString('utf8'), 'search-rate-limit-hmac-secret-006');
    assert.equal(shared.shared.keyPrefix, 'search-test');
    assert.equal(shared.shared.commandTimeoutMs, 250);
    assert.equal(shared.shared.connectTimeoutMs, 2000);
    assert.equal(shared.shared.maxRetriesPerRequest, 2);
  });

  test('shared=true without URL or secret fails closed; invalid values are rejected', () => {
    assert.throws(
      () => loadConfig(testEnv({ SEARCH_RATE_LIMIT_SHARED: 'true' })),
      /SEARCH_RATE_LIMIT_REDIS_URL is required/,
    );
    assert.throws(
      () => loadConfig(testEnv(searchSharedEnv({ SEARCH_RATE_LIMIT_REDIS_URL: '' }))),
      /SEARCH_RATE_LIMIT_REDIS_URL is required/,
    );
    assert.throws(
      () => loadConfig(testEnv(searchSharedEnv({ SEARCH_RATE_LIMIT_KEY_SECRET: '' }))),
      /SEARCH_RATE_LIMIT_KEY_SECRET is required/,
    );
    assert.throws(
      () => loadConfig(testEnv({ SEARCH_RATE_LIMIT_SHARED: 'maybe' })),
      /SEARCH_RATE_LIMIT_SHARED must be true or false/,
    );
    assert.throws(
      () => loadConfig(testEnv(searchSharedEnv({ SEARCH_RATE_LIMIT_REDIS_URL: 'http://127.0.0.1:6379' }))),
      /SEARCH_RATE_LIMIT_REDIS_URL must use redis:\/\/ or rediss:\/\//,
    );
    assert.throws(
      () => loadConfig(testEnv(searchSharedEnv({ SEARCH_RATE_LIMIT_KEY_PREFIX: 'bad prefix!' }))),
      /SEARCH_RATE_LIMIT_KEY_PREFIX/,
    );
    assert.throws(
      () => loadConfig(testEnv(searchSharedEnv({ SEARCH_RATE_LIMIT_COMMAND_TIMEOUT_MS: '99999' }))),
      /SEARCH_RATE_LIMIT_COMMAND_TIMEOUT_MS/,
    );
  });

  test('shared adapter enabled without an injected searchRateLimiter fails closed at composition', () => {
    const config = loadConfig(testEnv(searchSharedEnv()));
    assert.throws(
      () => buildApiApp({ config, searchQuery: { execute: async () => searchResult() } }),
      /injected searchRateLimiter.*SEARCH_RATE_LIMIT_SHARED=true/s,
    );
    // Injecting the memory adapter for tests keeps the shared config inert.
    const app = buildApiApp({
      config,
      searchQuery: { execute: async () => searchResult() },
      searchRateLimiter: createMemorySearchRateLimiter({
        anonymousMaxRequests: config.httpSecurity.searchRateLimit.anonymousMaxRequests,
        accountMaxRequests: config.httpSecurity.searchRateLimit.accountMaxRequests,
        windowMs: config.httpSecurity.searchRateLimit.windowMs,
      }),
    });
    apps.push(app);
  });

  test('Search routes without an injected limiter fail closed even when shared is off', () => {
    const config = loadConfig(testEnv());
    assert.equal(config.httpSecurity.searchRateLimit.shared.enabled, false);
    assert.throws(
      () => buildApiApp({ config, searchQuery: { execute: async () => searchResult() } }),
      /injected searchRateLimiter whenever Search routes are registered/,
    );
  });
});

describe('shared Explore/directory rate-limit adapter config (P-04)', () => {
  test('disabled by default with distinct prefix; shared=true without secret or url fails closed', () => {
    const defaults = loadConfig(testEnv());
    assert.equal(defaults.exploreDirectoryRateLimit.anonymousMaxRequests, 30);
    assert.equal(defaults.exploreDirectoryRateLimit.accountMaxRequests, 120);
    assert.equal(defaults.exploreDirectoryRateLimit.windowMs, 60_000);
    assert.equal(defaults.exploreDirectoryRateLimit.shared.enabled, false);
    assert.equal(defaults.exploreDirectoryRateLimit.shared.redisUrl, null);
    assert.equal(defaults.exploreDirectoryRateLimit.shared.keySecret, null);
    assert.equal(defaults.exploreDirectoryRateLimit.shared.keyPrefix, 'known-explore');
    assert.notEqual(
      defaults.exploreDirectoryRateLimit.shared.keyPrefix,
      defaults.httpSecurity.searchRateLimit.shared.keyPrefix,
    );
    assert.equal(defaults.publicActivityRateLimit.shared.keyPrefix, 'known-public-activity');
    assert.notEqual(
      defaults.publicActivityRateLimit.shared.keyPrefix,
      defaults.exploreDirectoryRateLimit.shared.keyPrefix,
    );

    assert.throws(
      () => loadConfig(testEnv({ EXPLORE_DIRECTORY_RATE_LIMIT_SHARED: 'true' })),
      /EXPLORE_DIRECTORY_RATE_LIMIT_REDIS_URL is required/,
    );
    assert.throws(
      () => loadConfig(testEnv(exploreDirectorySharedEnv({ EXPLORE_DIRECTORY_RATE_LIMIT_KEY_SECRET: '' }))),
      /EXPLORE_DIRECTORY_RATE_LIMIT_KEY_SECRET is required/,
    );
    assert.throws(
      () => loadConfig(testEnv({ EXPLORE_DIRECTORY_RATE_LIMIT_SHARED: 'maybe' })),
      /EXPLORE_DIRECTORY_RATE_LIMIT_SHARED must be true or false/,
    );
    const reused = loadConfig(testEnv({
      EXPLORE_DIRECTORY_RATE_LIMIT_SHARED: 'true',
      SEARCH_RATE_LIMIT_REDIS_URL: 'redis://127.0.0.1:6379',
      EXPLORE_DIRECTORY_RATE_LIMIT_KEY_SECRET: 'explore-directory-rate-limit-hmac-secret',
    }));
    assert.equal(reused.exploreDirectoryRateLimit.shared.enabled, true);
    assert.equal(reused.exploreDirectoryRateLimit.shared.redisUrl, 'redis://127.0.0.1:6379');
    assert.throws(
      () => loadConfig(testEnv(exploreDirectorySharedEnv({
        EXPLORE_DIRECTORY_RATE_LIMIT_KEY_PREFIX: 'known',
      }))),
      /EXPLORE_DIRECTORY_RATE_LIMIT_KEY_PREFIX must be independent from SEARCH_RATE_LIMIT_KEY_PREFIX/,
    );
    assert.throws(
      () => loadConfig(testEnv(exploreDirectorySharedEnv({
        EXPLORE_DIRECTORY_RATE_LIMIT_KEY_SECRET: 'search-rate-limit-hmac-secret-006',
        SEARCH_RATE_LIMIT_KEY_SECRET: 'search-rate-limit-hmac-secret-006',
      }))),
      /EXPLORE_DIRECTORY_RATE_LIMIT_KEY_SECRET must not reuse/,
    );
  });
});

describe('shared Sync COLP rate-limit adapter config (P-09)', () => {
  function syncSessionEnv(overrides: Record<string, string> = {}) {
    return {
      SYNC_SESSION_ENABLED: 'true',
      SYNC_EXTENSION_IDS: 'abcdefghijklmnopabcdefghijklmnop',
      SYNC_OAUTH_ISSUER: 'https://issuer.example.test',
      SYNC_OAUTH_CLIENT_ID: 'known-extension',
      SYNC_OAUTH_AUDIENCE: 'known-sync-api',
      SYNC_OAUTH_AUTHORIZATION_ENDPOINT: 'https://issuer.example.test/oauth2/authorize',
      SYNC_OAUTH_TOKEN_ENDPOINT: 'https://issuer.example.test/oauth2/token',
      SYNC_OAUTH_JWKS_URI: 'https://issuer.example.test/.well-known/jwks.json',
      SYNC_OAUTH_REDIRECT_URI: 'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/callback',
      SYNC_OAUTH_SCOPES: 'openid known.sync',
      SYNC_OAUTH_ALGORITHMS: 'RS256',
      SYNC_SESSION_REPLAY_KEY: Buffer.alloc(32, 23).toString('base64'),
      SYNC_SNAPSHOT_CURSOR_KEY: Buffer.alloc(32, 29).toString('base64'),
      SYNC_SNAPSHOT_CURSOR_KEY_ID: 'test-sync-snapshot-v1',
      SYNC_PULL_CURSOR_KEY_ID: 'test-sync-pull-v1',
      SYNC_PULL_CURSOR_KEY: Buffer.alloc(32, 41).toString('base64'),
      SYNC_RECOVERY_CAPABILITY_KEY_ID: 'recovery-v1',
      SYNC_RECOVERY_CAPABILITY_KEY: Buffer.alloc(32, 44).toString('base64'),
      SYNC_PULL_LINEAGE_KEY_ID: 'lineage-v1',
      SYNC_PULL_LINEAGE_KEY: Buffer.alloc(32, 47).toString('base64'),
      ...overrides,
    };
  }

  const replicaShared = (overrides: Record<string, string> = {}) => ({
    AUTH_RATE_LIMIT_SHARED: 'true',
    AUTH_RATE_LIMIT_REDIS_URL: 'redis://127.0.0.1:6379',
    AUTH_RATE_LIMIT_KEY_SECRET: 'auth-rate-limit-hmac-secret-001',
    SEARCH_RATE_LIMIT_SHARED: 'true',
    SEARCH_RATE_LIMIT_REDIS_URL: 'redis://127.0.0.1:6379',
    SEARCH_RATE_LIMIT_KEY_SECRET: 'search-rate-limit-hmac-secret-006',
    PUBLISHING_INSIGHTS_RATE_LIMIT_SHARED: 'true',
    PUBLISHING_INSIGHTS_RATE_LIMIT_REDIS_URL: 'redis://127.0.0.1:6379',
    COLLABORATION_INVITE_RATE_LIMIT_SHARED: 'true',
    COLLABORATION_INVITE_RATE_LIMIT_REDIS_URL: 'redis://127.0.0.1:6379',
    COLLABORATION_INVITE_RATE_LIMIT_KEY_SECRET: 'collaboration-invite-rate-limit-hmac-secret',
    EXPLORE_DIRECTORY_RATE_LIMIT_SHARED: 'true',
    EXPLORE_DIRECTORY_RATE_LIMIT_REDIS_URL: 'redis://127.0.0.1:6379',
    EXPLORE_DIRECTORY_RATE_LIMIT_KEY_SECRET: 'explore-directory-rate-limit-hmac-secret',
    ...publicActivityRateLimitSharedEnv(),
    ...productRouteRateLimitSharedEnv(),
    AUTH_API_REPLICAS: '2',
    ...overrides,
  });

  test('disabled by default with distinct prefix; shared=true without secret or url fails closed', () => {
    const defaults = loadConfig(testEnv());
    assert.equal(defaults.syncRateLimit.shared.enabled, false);
    assert.equal(defaults.syncRateLimit.shared.redisUrl, null);
    assert.equal(defaults.syncRateLimit.shared.keySecret, null);
    assert.equal(defaults.syncRateLimit.shared.keyPrefix, 'known-sync');
    assert.notEqual(
      defaults.syncRateLimit.shared.keyPrefix,
      defaults.httpSecurity.searchRateLimit.shared.keyPrefix,
    );

    assert.throws(
      () => loadConfig(testEnv({ SYNC_RATE_LIMIT_SHARED: 'true' })),
      /SYNC_RATE_LIMIT_REDIS_URL is required/,
    );
    assert.throws(
      () => loadConfig(testEnv(syncRateLimitSharedEnv({ SYNC_RATE_LIMIT_KEY_SECRET: '' }))),
      /SYNC_RATE_LIMIT_KEY_SECRET is required/,
    );
    assert.throws(
      () => loadConfig(testEnv({ SYNC_RATE_LIMIT_SHARED: 'maybe' })),
      /SYNC_RATE_LIMIT_SHARED must be true or false/,
    );
    const reused = loadConfig(testEnv({
      SYNC_RATE_LIMIT_SHARED: 'true',
      SEARCH_RATE_LIMIT_REDIS_URL: 'redis://127.0.0.1:6379',
      SYNC_RATE_LIMIT_KEY_SECRET: 'sync-colp-rate-limit-hmac-secret',
    }));
    assert.equal(reused.syncRateLimit.shared.enabled, true);
    assert.equal(reused.syncRateLimit.shared.redisUrl, 'redis://127.0.0.1:6379');
    assert.equal(reused.syncRateLimit.shared.keyPrefix, 'known-sync');
    assert.throws(
      () => loadConfig(testEnv(syncRateLimitSharedEnv({
        SYNC_RATE_LIMIT_KEY_PREFIX: 'known',
      }))),
      /SYNC_RATE_LIMIT_KEY_PREFIX must be independent from SEARCH_RATE_LIMIT_KEY_PREFIX/,
    );
    assert.throws(
      () => loadConfig(testEnv(syncRateLimitSharedEnv({
        SYNC_RATE_LIMIT_KEY_SECRET: 'search-rate-limit-hmac-secret-006',
        SEARCH_RATE_LIMIT_KEY_SECRET: 'search-rate-limit-hmac-secret-006',
      }))),
      /SYNC_RATE_LIMIT_KEY_SECRET must not reuse/,
    );
  });

  test('production replicas>1 with Sync Sessions enabled requires SYNC_RATE_LIMIT_SHARED', () => {
    assert.throws(
      () => loadConfig(productionEnv(replicaShared(syncSessionEnv()))),
      /AUTH_API_REPLICAS > 1.*with Sync Sessions enabled requires SYNC_RATE_LIMIT_SHARED=true/s,
    );
    assert.throws(
      () => loadConfig(productionEnv(replicaShared(syncSessionEnv(syncRateLimitSharedEnv())))),
      /AUTH_API_REPLICAS > 1.*with Sync Sessions enabled requires SYNC_EFFECT_PAGE_RATE_LIMIT_SHARED=true/s,
    );
    const ok = loadConfig(productionEnv(replicaShared(syncSessionEnv({
      ...syncRateLimitSharedEnv(),
      ...effectPageRateLimitSharedEnv(),
    }))));
    assert.equal(ok.syncSession !== undefined, true);
    assert.equal(ok.syncRateLimit.shared.enabled, true);
    assert.equal(ok.syncRateLimit.shared.keyPrefix, 'known-sync');
    assert.equal(ok.syncEffectPageRateLimit.shared.enabled, true);
    assert.equal(ok.syncEffectPageRateLimit.shared.keyPrefix, 'known-effect-page');
    assert.doesNotThrow(() => loadConfig(productionEnv(replicaShared())));
  });

  test('shared adapter without Sync Sessions does not require an injected limiter', () => {
    const config = loadConfig(testEnv(syncRateLimitSharedEnv()));
    const app = buildApiApp({ config });
    apps.push(app);
  });

  test('Sync Sessions with shared adapter and no injected limiter fails closed at composition', () => {
    const config = loadConfig(testEnv(syncRateLimitSharedEnv(syncSessionEnv())));
    assert.throws(
      () => buildApiApp({ config }),
      /injected syncColpRateLimiter.*SYNC_RATE_LIMIT_SHARED=true/s,
    );
  });
});

describe('shared email callback rate-limit adapter config (FIX-L-061 / T-EMAIL-004)', () => {
  /** Auth shared adapter env (local copy: the FIX-M-001 helper is describe-scoped). */
  const authSharedEnv = (overrides: Record<string, string> = {}) => ({
    AUTH_RATE_LIMIT_SHARED: 'true',
    AUTH_RATE_LIMIT_REDIS_URL: 'redis://127.0.0.1:6379',
    AUTH_RATE_LIMIT_KEY_SECRET: 'auth-rate-limit-hmac-secret-001',
    ...overrides,
  });

  /** Email feature env with the callback ingress mounted (HMAC secret set). */
  const emailCallbackEnv = (overrides: Record<string, string> = {}) => ({
    KNOWN_FEATURE_EMAIL: 'true',
    EMAIL_DM_ACCOUNT_NAME: 'no-reply@example.invalid',
    EMAIL_DM_CALLBACK_HMAC_SECRET: 'p528-hmac-callback-secret-not-prod-default',
    ...overrides,
  });

  /** Email callback shared adapter env (T-EMAIL-004, mirrors the MCP loader). */
  const emailSharedEnv = (overrides: Record<string, string> = {}) => ({
    EMAIL_CALLBACK_RATE_LIMIT_SHARED: 'true',
    EMAIL_CALLBACK_RATE_LIMIT_REDIS_URL: 'redis://127.0.0.1:6379',
    EMAIL_CALLBACK_RATE_LIMIT_KEY_SECRET: 'email-callback-rate-limit-hmac-secret-061',
    ...overrides,
  });

  test('production multi-replica email callback ingress without the shared limiter fails startup', () => {
    // Email callback mounted + production + replicas>1 without the shared
    // limiter fails (the auth/search shared adapters are present so the
    // email callback gate is the one that fails startup).
    const prodMultiReplicaEmail = (overrides: Record<string, string> = {}) =>
      productionEnv(authSharedEnv(searchSharedEnv(insightsSharedEnv(collaborationInviteSharedEnv(exploreDirectorySharedEnv(publicActivityRateLimitSharedEnv(productRouteRateLimitSharedEnv(emailCallbackEnv({ AUTH_API_REPLICAS: '2', ...overrides })))))))));
    assert.throws(
      () => loadConfig(prodMultiReplicaEmail()),
      /AUTH_API_REPLICAS > 1.*EMAIL_CALLBACK_RATE_LIMIT_SHARED=true/s,
    );
    // The gate error must stay sanitized: never the Redis URL, the callback
    // HMAC secret, or the shared key secret.
    assert.throws(
      () => loadConfig(prodMultiReplicaEmail()),
      (err: Error) => !err.message.includes('redis://')
        && !err.message.includes('email-callback-rate-limit-hmac-secret-061')
        && !err.message.includes('p528-hmac-callback-secret-not-prod-default'),
    );
    // Single-instance production keeps the in-process memory limiter.
    const single = loadConfig(productionEnv(emailCallbackEnv()));
    assert.equal(single.email!.callbackRateLimitShared.enabled, false);
    // Callback HMAC unconfigured (the surface answers 404) never forces Redis.
    assert.doesNotThrow(() => loadConfig(productionEnv(authSharedEnv(searchSharedEnv(insightsSharedEnv(collaborationInviteSharedEnv(exploreDirectorySharedEnv(publicActivityRateLimitSharedEnv(productRouteRateLimitSharedEnv({
      AUTH_API_REPLICAS: '2',
      KNOWN_FEATURE_EMAIL: 'true',
      EMAIL_DM_ACCOUNT_NAME: 'no-reply@example.invalid',
    }))))))))));
    // Email feature off never forces Redis either.
    assert.doesNotThrow(() => loadConfig(productionEnv(authSharedEnv(searchSharedEnv(insightsSharedEnv(collaborationInviteSharedEnv(exploreDirectorySharedEnv(publicActivityRateLimitSharedEnv(productRouteRateLimitSharedEnv({ AUTH_API_REPLICAS: '2' }))))))))));
    // Multi-replica production WITH the shared email callback adapter is valid.
    const ok = loadConfig(prodMultiReplicaEmail(emailSharedEnv()));
    assert.equal(ok.httpSecurity.authApiReplicas, 2);
    assert.equal(ok.email!.callbackRateLimitShared.enabled, true);
    assert.equal(ok.email!.callbackRateLimitShared.redisUrl, 'redis://127.0.0.1:6379');
    // Non-production multi-replica may keep the in-process limiter.
    assert.doesNotThrow(() => loadConfig(testEnv(emailCallbackEnv({ AUTH_API_REPLICAS: '2' }))));
    const { OIDC_ALLOW_TEST_PROVIDER: _testProvider, ...devBase } = testEnv();
    assert.doesNotThrow(() => loadConfig({
      ...devBase,
      ...emailCallbackEnv({ AUTH_API_REPLICAS: '2' }),
      NODE_ENV: 'development',
      OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs',
    }));
  });

  test('shared=true without URL or secret keeps failing closed (FIX-L-061 parsing unchanged)', () => {
    assert.throws(
      () => loadConfig(testEnv(emailCallbackEnv({ EMAIL_CALLBACK_RATE_LIMIT_SHARED: 'true' }))),
      /EMAIL_CALLBACK_RATE_LIMIT_REDIS_URL is required/,
    );
    assert.throws(
      () => loadConfig(testEnv(emailCallbackEnv(emailSharedEnv({ EMAIL_CALLBACK_RATE_LIMIT_KEY_SECRET: '' })))),
      /EMAIL_CALLBACK_RATE_LIMIT_KEY_SECRET is required/,
    );
  });

  test('shared email callback adapter enabled without injected emailCallbackRoutes fails closed at composition', () => {
    const config = loadConfig(testEnv(emailCallbackEnv(emailSharedEnv())));
    assert.equal(config.email!.callbackRateLimitShared.enabled, true);
    assert.throws(
      () => buildApiApp({ config, identityUnitOfWork: emptyIdentityUnitOfWork() }),
      /injected emailCallbackRoutes.*EMAIL_CALLBACK_RATE_LIMIT_SHARED=true/s,
    );
    // Injecting the callback routes (memory limiter for tests) keeps the
    // shared config inert; the production composition injects the Redis
    // adapter and must never silently fall back to a memory limiter.
    const app = buildApiApp({
      config,
      identityUnitOfWork: emptyIdentityUnitOfWork(),
      emailCallbackRoutes: {
        enabled: true,
        rateLimiter: createMemoryEmailCallbackRateLimiter({
          ip: config.email!.callbackRateLimit,
        }),
      },
    });
    apps.push(app);
  });
});

describe('Search rate-limit port and fail-closed responses (FIX-M-006)', () => {
  test('memory adapter keys by family and subject with INDEPENDENT budgets', async () => {
    const limiter = createMemorySearchRateLimiter({
      anonymousMaxRequests: 2,
      accountMaxRequests: 3,
      windowMs: 60_000,
    });
    const anonymous = { family: 'anonymous' as const, subject: '203.0.113.10' };
    assert.equal((await limiter.consume(anonymous)).kind, 'allowed');
    assert.equal((await limiter.consume(anonymous)).kind, 'allowed');
    const third = await limiter.consume(anonymous);
    assert.equal(third.kind, 'denied');
    if (third.kind === 'denied') {
      assert.ok(third.decision.retryAfterSeconds >= 1);
    }

    // Same subject, different family: the account budget is independent.
    assert.equal((await limiter.consume({ family: 'account', subject: '203.0.113.10' })).kind, 'allowed');
    // Same family, different subject (another client IP): isolated bucket.
    assert.equal((await limiter.consume({ family: 'anonymous', subject: '198.51.100.20' })).kind, 'allowed');
    // The exhausted anonymous|203.0.113.10 bucket stays exhausted.
    assert.equal((await limiter.consume(anonymous)).kind, 'denied');
    // The account family carries its OWN budget (3), not the anonymous one.
    assert.equal((await limiter.consume({ family: 'account', subject: '203.0.113.10' })).kind, 'allowed');
    assert.equal((await limiter.consume({ family: 'account', subject: '203.0.113.10' })).kind, 'allowed');
    assert.equal((await limiter.consume({ family: 'account', subject: '203.0.113.10' })).kind, 'denied');

    assert.equal(limiter.policy.anonymous, 'search:anonymous:2:60000');
    assert.equal(limiter.policy.account, 'search:account:3:60000');
    assert.equal(limiter.readiness().status, 'healthy');
    limiter.reset();
    assert.equal(limiter.size(), 0);
    await limiter.close();
  });

  test('a Redis outage fails closed with 503 and never fabricates quota facts', async () => {
    const failingLimiter: SearchRateLimiter = {
      consume: async () => ({
        kind: 'failed',
        failure: { class: 'unavailable', code: 'rate_limit_unavailable' },
      }),
      readiness: () => ({ status: 'degraded', reason: 'last_command_failed', lastCheckedAtEpochMs: 0 }),
      policy: { anonymous: 'search:anonymous:30:60000', account: 'search:account:120:60000' },
      close: async () => undefined,
    };
    const app = buildApiApp({
      config: loadConfig(testEnv()),
      searchQuery: { execute: async () => searchResult() },
      searchRateLimiter: failingLimiter,
    });
    apps.push(app);

    const response = await app.inject({ method: 'GET', url: '/api/v1/search?q=probe' });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().error.code, 'feature_temporarily_unavailable');
    assert.equal(response.headers['retry-after'], undefined, 'a 503 never fabricates a quota fact');
    assert.equal(response.headers['ratelimit-policy'], undefined, 'a 503 never fabricates a quota policy');
    assert.equal(response.json().error.retryAfterSeconds, null);
  });

  test('a denied shared decision stays a 429 with Retry-After and RateLimit-Policy', async () => {
    const denyingLimiter: SearchRateLimiter = {
      consume: async () => ({
        kind: 'denied',
        decision: { allowed: false, retryAfterSeconds: 42 },
      }),
      readiness: () => ({ status: 'healthy', reason: 'none', lastCheckedAtEpochMs: 0 }),
      policy: { anonymous: 'search:anonymous:5:30000', account: 'search:account:50:30000' },
      close: async () => undefined,
    };
    const app = buildApiApp({
      config: loadConfig(testEnv()),
      searchQuery: { execute: async () => searchResult() },
      searchRateLimiter: denyingLimiter,
    });
    apps.push(app);

    const response = await app.inject({ method: 'GET', url: '/api/v1/search?q=probe' });
    assert.equal(response.statusCode, 429);
    assert.equal(response.json().error.code, 'rate_limited');
    assert.equal(response.headers['retry-after'], '42');
    assert.equal(response.headers['ratelimit-policy'], 'search:anonymous:5:30000');
  });

  test('shared Search store health participates in /ready when configured', async () => {
    const degradedLimiter: SearchRateLimiter = {
      consume: async () => ({ kind: 'allowed', decision: { allowed: true, retryAfterSeconds: 0 } }),
      readiness: () => ({ status: 'degraded', reason: 'connecting', lastCheckedAtEpochMs: 0 }),
      policy: { anonymous: 'search:anonymous:30:60000', account: 'search:account:120:60000' },
      close: async () => undefined,
    };
    const config = loadConfig(testEnv(searchSharedEnv()));
    const app = buildApiApp({
      config,
      searchQuery: { execute: async () => searchResult() },
      searchRateLimiter: degradedLimiter,
    });
    apps.push(app);
    const ready = await app.inject({ method: 'GET', url: '/ready' });
    assert.equal(ready.statusCode, 503);
    assert.deepEqual(ready.json(), { status: 'not-ready' });

    // A healthy shared store (or the in-memory adapter) keeps readiness.
    const healthy = buildApiApp({
      config,
      searchQuery: { execute: async () => searchResult() },
      searchRateLimiter: createMemorySearchRateLimiter({
        anonymousMaxRequests: 30,
        accountMaxRequests: 120,
        windowMs: 60_000,
      }),
    });
    apps.push(healthy);
    assert.equal((await healthy.inject({ method: 'GET', url: '/ready' })).statusCode, 200);
  });
});

function searchResult() {
  return {
    normalizedQuery: 'probe',
    types: ['collection', 'node', 'profile', 'annotation'] as const,
    items: [{ resourceType: 'collection' as const, resourceId: 'collection-1', title: 'Probe',
      snippet: 'A bounded plain-text result.', rank: 0.875 }],
    page: { returnedCount: 1, hasMore: false, nextCursor: null },
    cache: { class: 'shared-public' as const, partition: 'anonymous-representation-partition' },
    consistency: { authority: 'recheck-each-page' as const, ranking: 'restart-on-mutation' as const },
  };
}

describe('auth rate-limit port and fail-closed responses (FIX-M-001)', () => {
  test('memory adapter keys by route family and trusted client IP; budgets stay isolated', async () => {
    const limiter = createMemoryAuthRateLimiter({ maxRequests: 2, windowMs: 60_000 });
    const session = { routeFamily: 'session' as const, clientIp: '203.0.113.10' };
    assert.equal((await limiter.consume(session)).kind, 'allowed');
    assert.equal((await limiter.consume(session)).kind, 'allowed');
    const third = await limiter.consume(session);
    assert.equal(third.kind, 'denied');
    if (third.kind === 'denied') {
      assert.ok(third.decision.retryAfterSeconds >= 1);
    }
    // Same IP, different route family: isolated budget.
    assert.equal((await limiter.consume({ routeFamily: 'me', clientIp: '203.0.113.10' })).kind, 'allowed');
    // Same route family, different IP: isolated budget.
    assert.equal((await limiter.consume({ routeFamily: 'session', clientIp: '198.51.100.20' })).kind, 'allowed');
    // The exhausted session|203.0.113.10 bucket stays exhausted.
    assert.equal((await limiter.consume(session)).kind, 'denied');
    limiter.reset();
    assert.equal(limiter.size(), 0);
    assert.equal(limiter.readiness().status, 'healthy');
    await limiter.close();
  });

  test('route family mapping covers every auth path and nothing else', () => {
    assert.equal(authRateLimitRouteFamilyForPath('/api/v1/auth/oidc/start'), 'oidc-start');
    assert.equal(authRateLimitRouteFamilyForPath('/api/v1/auth/oidc/callback'), 'oidc-callback');
    assert.equal(authRateLimitRouteFamilyForPath('/api/v1/session'), 'session');
    assert.equal(authRateLimitRouteFamilyForPath('/api/v1/me'), 'me');
    assert.equal(authRateLimitRouteFamilyForPath('/api/v1/me/avatar'), 'me');
    assert.equal(authRateLimitRouteFamilyForPath('/api/v1/me?x=1'), null);
    assert.equal(authRateLimitRouteFamilyForPath('/health'), null);
    assert.equal(authRateLimitRouteFamilyForPath('/api/v1/auth/callback/google'), 'oauth-callback');
    assert.equal(authRateLimitRouteFamilyForPath('/api/v1/auth/oauth2/callback/github'), 'oauth-callback');
    assert.equal(isAuthRateLimitedPath('/api/v1/auth/callback/google'), true);
    assert.equal(isAuthRateLimitedPath('/api/v1/auth/oauth2/callback/github'), true);
    assert.equal(authRateLimitRouteFamilyForPath('/api/v1/auth/callback/google/extra'), null);
    assert.equal(authRateLimitRouteFamilyForPath('/api/v1/auth/callback'), null);
  });

  test('a Redis outage fails closed with 503 and never fabricates quota facts', async () => {
    const failingLimiter: AuthRateLimiter = {
      consume: async () => ({
        kind: 'failed',
        failure: { class: 'unavailable', code: 'rate_limit_unavailable' },
      }),
      readiness: () => ({ status: 'degraded', reason: 'last_command_failed', lastCheckedAtEpochMs: 0 }),
      close: async () => undefined,
    };
    const config = loadConfig(testEnv({ AUTH_RATE_LIMIT_MAX: '60' }));
    const app = buildApiApp({
      config,
      authRateLimiter: failingLimiter,
      identityUnitOfWork: emptyIdentityUnitOfWork(),
    });
    apps.push(app);

    const response = await app.inject({ method: 'GET', url: '/api/v1/session' });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().error.code, 'feature_temporarily_unavailable');
    assert.equal(response.headers['retry-after'], undefined, 'a 503 never fabricates a quota fact');
    assert.equal(response.headers['ratelimit-policy'], undefined, 'a 503 never fabricates a quota policy');
    assert.equal(response.json().error.retryAfterSeconds, null);

    // Non-auth routes are unaffected by the auth limiter outage.
    const health = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(health.statusCode, 200);
  });

  test('a denied shared decision stays a 429 with Retry-After and RateLimit-Policy', async () => {
    const denyingLimiter: AuthRateLimiter = {
      consume: async () => ({
        kind: 'denied',
        decision: { allowed: false, retryAfterSeconds: 42 },
      }),
      readiness: () => ({ status: 'healthy', reason: 'none', lastCheckedAtEpochMs: 0 }),
      close: async () => undefined,
    };
    const config = loadConfig(testEnv({
      AUTH_RATE_LIMIT_MAX: '5',
      AUTH_RATE_LIMIT_WINDOW_MS: '30000',
    }));
    const app = buildApiApp({
      config,
      authRateLimiter: denyingLimiter,
      identityUnitOfWork: emptyIdentityUnitOfWork(),
    });
    apps.push(app);

    const response = await app.inject({ method: 'GET', url: '/api/v1/session' });
    assert.equal(response.statusCode, 429);
    assert.equal(response.json().error.code, 'rate_limited');
    assert.equal(response.headers['retry-after'], '42');
    assert.equal(response.headers['ratelimit-policy'], 'auth:session:5:30000');
  });
});
