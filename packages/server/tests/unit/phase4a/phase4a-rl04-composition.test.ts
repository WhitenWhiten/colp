/**
 * P4A-RL04 route-composition unit contract (plan §8 RL04, §2.2.4, §4.1.9,
 * §4.2.7, §13.1/§13.2). No Redis, no PostgreSQL, no browser.
 *
 * Pins the mode semantics of the RL04 route facade over a SCRIPTED store
 * (the production store factory with the RL03-style fake client; atomicity/
 * TTL/server-time stay the real-Redis suites' job):
 *
 *  - `off`    -> zero store (the facade factory REFUSES one), issue/complete
 *               allowed like the RL01 baseline, download keeps the bounded
 *               local reference (I10) 429 semantics; close is a no-op;
 *  - `shadow` -> the local reference decides (unchanged route semantics) and
 *               the Redis decision runs alongside: every disagreement is a
 *               `shadow_mismatch` metric/log entry and Redis NEVER denies;
 *  - `enforce`-> Redis decides; issue/download fail closed on
 *               unavailable (503, no quota facts), complete runs the bounded
 *               emergency limiter and reports fallback/fallback_denied;
 *  - readiness follows plan §13.1 step 3/4: enforce+required + degraded
 *    blocks attachments, shadow/optional-enforce degrade without blocking;
 *  - metrics/logs only carry the sealed fixed labels (never subject text).
 *
 * Also pins the bootstrap wiring: `loadConfig` parses
 * `ATTACHMENTS_RATE_LIMIT_*` orthogonally to KNOWN_CACHE_MODE (plan §2.2.5),
 * the production multi-replica gate fails closed at startup (plan §2.2.6),
 * and `composeAttachmentRateLimit` creates zero clients in `off` mode and
 * exactly one shared store otherwise.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'vitest';
import {
  loadConfig,
  sanitizedRuntimeCapacity,
} from '../../support/test-config.js';
import {
  ATTACHMENT_RATE_LIMIT_SHADOW_MISMATCH_METRIC,
  composeAttachmentRateLimit,
} from '../../../src/bootstrap/attachments-rate-limit-composition.js';
import {
  EmergencyRateLimiter,
  createAttachmentRouteRateLimitFacade,
  createRedisRateLimitStore,
  type RateLimitRedisClientLike,
  type RateLimitRedisClientOptions,
} from '../../../src/infrastructure/rate-limit/index.js';
import { InMemoryMetrics } from '../../../src/infrastructure/telemetry/index.js';
import {
  createDeliveryRateLimiter,
  evaluateAttachmentRateLimitReadiness,
  rateLimitSubjectHmac,
  type AttachmentMetricRateLimitDecision,
  type AttachmentRateLimitConfig,
  type AttachmentRateLimitLogEntry,
  type RateLimitStore,
  type RateLimitSubject,
} from '../../../src/modules/attachments/index.js';

const ENVIRONMENT = 'test';
const KEY_PREFIX = 'rl04-unit';
const KEY_SECRET = Buffer.from('rl04-unit-hmac-secret', 'utf8');
const NOW_MS = 1_750_000_000_000;

function makeConfig(overrides: Partial<AttachmentRateLimitConfig> = {}): AttachmentRateLimitConfig {
  const base: AttachmentRateLimitConfig = {
    mode: 'enforce',
    required: true,
    redisUrl: 'redis://127.0.0.1:6379',
    keySecretRef: 'known/rl04/unit/hmac',
    keyPrefix: KEY_PREFIX,
    commandTimeoutMs: 75,
    connectTimeoutMs: 1000,
    maxRetriesPerRequest: 1,
    routes: Object.freeze({
      issue: Object.freeze({ rateMax: 3, rateWindowMs: 60000 }),
      complete: Object.freeze({ rateMax: 5, rateWindowMs: 60000 }),
      download: Object.freeze({ rateMax: 3, rateWindowMs: 60000 }),
      status: Object.freeze({ rateMax: 3, rateWindowMs: 60000 }),
    }),
    completeEmergency: Object.freeze({ rateMax: 2, rateWindowMs: 60000 }),
  };
  return Object.freeze({ ...base, ...overrides }) as AttachmentRateLimitConfig;
}

class FakeRateLimitClient implements RateLimitRedisClientLike {
  status = 'ready';
  scriptLoads = 0;
  evalshaCalls = 0;
  scriptLoadImpl: (script: string) => Promise<string> = async () => 'a'.repeat(40);
  evalshaImpl: (sha: string, args: readonly (string | number)[]) => Promise<unknown> = async () => [1, 1, 2, 60, 1_749_999_960_000];

  connect(): Promise<void> { return Promise.resolve(); }
  disconnect(): void {}
  quit(): Promise<'OK'> { return Promise.resolve('OK'); }
  removeAllListeners(): this { return this; }
  on(): this { return this; }
  script(subcommand: 'LOAD', script: string): Promise<string> {
    this.scriptLoads += 1;
    return this.scriptLoadImpl(script);
  }
  evalsha(sha: string, numkeys: number, ...args: (string | number)[]): Promise<unknown> {
    this.evalshaCalls += 1;
    return this.evalshaImpl(sha, args);
  }
}

function makeStore(
  fake: FakeRateLimitClient,
  overrides: Partial<AttachmentRateLimitConfig> = {},
): RateLimitStore {
  return createRedisRateLimitStore({
    config: makeConfig(overrides),
    environment: ENVIRONMENT,
    keySecret: KEY_SECRET,
    createClient: (_url: string, _clientOptions: RateLimitRedisClientOptions) => fake,
    now: () => NOW_MS,
  });
}

function subject(seed: string = randomUUID()): RateLimitSubject {
  return { principalId: `principal-${seed}`, scope: `collection-${seed}` };
}

interface RecordedMetric {
  readonly operation: string;
  readonly decision: AttachmentMetricRateLimitDecision;
}

interface FacadeHarness {
  readonly metrics: InMemoryMetrics;
  readonly recorded: RecordedMetric[];
  readonly logEntries: AttachmentRateLimitLogEntry[];
  facade(overrides?: {
    readonly config?: AttachmentRateLimitConfig;
    readonly store?: RateLimitStore | null;
    readonly localLimiter?: ReturnType<typeof createDeliveryRateLimiter>;
    readonly emergency?: EmergencyRateLimiter;
  }): ReturnType<typeof createAttachmentRouteRateLimitFacade>;
}

function harness(): FacadeHarness {
  const metrics = new InMemoryMetrics();
  const recorded: RecordedMetric[] = [];
  const logEntries: AttachmentRateLimitLogEntry[] = [];
  return {
    metrics,
    recorded,
    logEntries,
    facade(overrides = {}) {
      return createAttachmentRouteRateLimitFacade({
        config: overrides.config ?? makeConfig(),
        store: overrides.store === undefined ? makeStore(new FakeRateLimitClient()) : overrides.store,
        localLimiter: overrides.localLimiter,
        subjectKeyFor: (s) => rateLimitSubjectHmac(KEY_SECRET, s),
        emergency: overrides.emergency,
        metrics: {
          recordDecision: (operation, decision) => recorded.push({ operation, decision }),
          incrementShadowMismatch: () => metrics.increment(ATTACHMENT_RATE_LIMIT_SHADOW_MISMATCH_METRIC),
        },
        log: (entry) => logEntries.push(entry),
        now: () => NOW_MS,
      });
    },
  };
}

function decisions(recorded: readonly RecordedMetric[]): AttachmentMetricRateLimitDecision[] {
  return recorded.map((entry) => entry.decision);
}

// ---------------------------------------------------------------------------
// off mode: zero store, bounded local reference, RL01-baseline issue/complete
// ---------------------------------------------------------------------------

test('off mode: the facade factory refuses a store (zero Redis client contract) and reports healthy readiness', () => {
  const h = harness();
  assert.throws(
    () => h.facade({ config: makeConfig({ mode: 'off', required: false }), store: makeStore(new FakeRateLimitClient()) }),
    /MODE=off/,
  );
  const facade = h.facade({ config: makeConfig({ mode: 'off', required: false }), store: null });
  assert.equal(facade.mode, 'off');
  assert.equal(facade.readiness().status, 'healthy');
});

test('off mode: issue/complete are allowed like the RL01 baseline and download keeps the bounded local 429 semantics', async () => {
  const h = harness();
  const localLimiter = createDeliveryRateLimiter({ windowSeconds: 60, maxPerWindow: 2, maxTrackedPrincipals: 8 });
  const facade = h.facade({
    config: makeConfig({ mode: 'off', required: false }),
    store: null,
    localLimiter,
  });
  const owner = subject('off');

  assert.equal((await facade.checkAdmission({ routeClass: 'issue', subject: owner })).kind, 'allowed');
  assert.equal((await facade.checkAdmission({ routeClass: 'complete', subject: owner })).kind, 'allowed');

  assert.equal((await facade.checkAdmission({ routeClass: 'download', subject: owner })).kind, 'allowed');
  assert.equal((await facade.checkAdmission({ routeClass: 'download', subject: owner })).kind, 'allowed');
  const third = await facade.checkAdmission({ routeClass: 'download', subject: owner });
  assert.equal(third.kind, 'denied');
  if (third.kind === 'denied') {
    assert.equal(third.decision.allowed, false);
    assert.ok(third.decision.retryAfterSeconds >= 1 && third.decision.retryAfterSeconds <= 60,
      `the local denial carries a real retry-after (${third.decision.retryAfterSeconds})`);
  }

  assert.deepEqual([...decisions(h.recorded)].sort(), ['allowed', 'allowed', 'allowed', 'allowed', 'denied']);
  for (const entry of h.logEntries) {
    assert.equal(entry.mode, 'off');
    assert.equal(entry.shadowMismatch, false);
    assert.equal(entry.failureClass, null);
    assert.ok(!JSON.stringify(entry).includes('principal-'), 'log entries never carry subject text');
  }
  await facade.close();
  await facade.close();
});

// ---------------------------------------------------------------------------
// shadow mode: local reference decides, Redis runs alongside and never denies
// ---------------------------------------------------------------------------

test('shadow mode: a Redis denial never denies the request and is recorded as a shadow mismatch', async () => {
  const h = harness();
  const fake = new FakeRateLimitClient();
  fake.evalshaImpl = async () => [0, 4, 0, 45, 1_749_999_960_000]; // Redis: denied
  const facade = h.facade({
    config: makeConfig({ mode: 'shadow', required: false }),
    store: makeStore(fake, { mode: 'shadow', required: false }),
  });
  const owner = subject('shadow');

  const outcome = await facade.checkAdmission({ routeClass: 'issue', subject: owner });
  assert.equal(outcome.kind, 'allowed', 'shadow mode must never deny on a Redis denial');
  assert.equal(outcome.mode, 'shadow');
  assert.equal(h.metrics.get(ATTACHMENT_RATE_LIMIT_SHADOW_MISMATCH_METRIC), 1, 'the disagreement is counted');
  const logEntry = h.logEntries.at(-1)!;
  assert.equal(logEntry.decision, 'allowed');
  assert.equal(logEntry.shadowMismatch, true, 'the log entry carries the mismatch fact');
  assert.equal(logEntry.failureClass, null);
  assert.ok(!decisions(h.recorded).includes('denied'),
    'the ROUTE decision metric is the local reference (allowed), never the Redis denial');
});

test('shadow mode: a local denial still gates download (existing route semantics) and disagrees with an allowed Redis', async () => {
  const h = harness();
  const fake = new FakeRateLimitClient();
  fake.evalshaImpl = async () => [1, 1, 2, 60, 1_749_999_960_000]; // Redis: allowed
  const localLimiter = createDeliveryRateLimiter({ windowSeconds: 60, maxPerWindow: 1, maxTrackedPrincipals: 8 });
  const facade = h.facade({
    config: makeConfig({ mode: 'shadow', required: false }),
    store: makeStore(fake, { mode: 'shadow', required: false }),
    localLimiter,
  });
  const owner = subject('shadow-local');

  assert.equal((await facade.checkAdmission({ routeClass: 'download', subject: owner })).kind, 'allowed');
  const second = await facade.checkAdmission({ routeClass: 'download', subject: owner });
  assert.equal(second.kind, 'denied', 'the local reference (I10) 429 semantics are unchanged in shadow');
  if (second.kind === 'denied') assert.ok(second.decision.retryAfterSeconds >= 1);
  assert.equal(h.metrics.get(ATTACHMENT_RATE_LIMIT_SHADOW_MISMATCH_METRIC), 1,
    'local denied vs Redis allowed is a mismatch');
});

test('shadow mode: a Redis FAILURE never changes the route decision and records the fixed failure class', async () => {
  const h = harness();
  const fake = new FakeRateLimitClient();
  fake.evalshaImpl = async () => { throw new Error('ECONNREFUSED 127.0.0.1:6379'); };
  const facade = h.facade({
    config: makeConfig({ mode: 'shadow', required: false }),
    store: makeStore(fake, { mode: 'shadow', required: false }),
  });
  const owner = subject('shadow-fail');

  const outcome = await facade.checkAdmission({ routeClass: 'complete', subject: owner });
  assert.equal(outcome.kind, 'allowed', 'a shadow Redis failure never denies');
  const logEntry = h.logEntries.at(-1)!;
  assert.equal(logEntry.decision, 'allowed');
  assert.equal(logEntry.failureClass, 'unavailable', 'the fixed failure class is recorded');
  assert.equal(logEntry.shadowMismatch, false, 'a failure is not a decision mismatch');
  assert.equal(h.metrics.get(ATTACHMENT_RATE_LIMIT_SHADOW_MISMATCH_METRIC), 0, 'no mismatch for failures');
});

// ---------------------------------------------------------------------------
// enforce mode: Redis decides; issue/download fail closed; complete falls back
// ---------------------------------------------------------------------------

test('enforce: Redis allowed/denied map to allowed/denied decisions with the Redis quota facts', async () => {
  const h = harness();
  const fake = new FakeRateLimitClient();
  let call = 0;
  fake.evalshaImpl = async () => {
    call += 1;
    return call === 1 ? [1, 1, 2, 60, 1_749_999_960_000] : [0, 3, 0, 30, 1_749_999_960_000];
  };
  const facade = h.facade({ config: makeConfig(), store: makeStore(fake) });
  const owner = subject('enforce');

  const allowed = await facade.checkAdmission({ routeClass: 'issue', subject: owner });
  assert.equal(allowed.kind, 'allowed');
  if (allowed.kind === 'allowed') assert.equal(allowed.decision.retryAfterSeconds, 60);
  const denied = await facade.checkAdmission({ routeClass: 'issue', subject: owner });
  assert.equal(denied.kind, 'denied');
  if (denied.kind === 'denied') {
    assert.equal(denied.decision.retryAfterSeconds, 30, 'the denied decision carries the real Redis retry-after');
    assert.equal(denied.mode, 'enforce');
  }
  assert.deepEqual([...decisions(h.recorded)].sort(), ['allowed', 'denied']);
  assert.equal(h.logEntries.at(-1)!.failureClass, null);
});

test('enforce: issue/download fail closed (unavailable, no quota facts) when Redis is unavailable', async () => {
  const h = harness();
  const fake = new FakeRateLimitClient();
  fake.evalshaImpl = async () => { throw new Error('ECONNREFUSED 127.0.0.1:6379'); };
  const facade = h.facade({ config: makeConfig(), store: makeStore(fake) });
  const owner = subject('enforce-fail');

  for (const routeClass of ['issue', 'download'] as const) {
    const outcome = await facade.checkAdmission({ routeClass, subject: owner });
    assert.equal(outcome.kind, 'unavailable', `${routeClass} must fail closed`);
    if (outcome.kind === 'unavailable') {
      assert.equal(outcome.failure.class, 'unavailable');
      assert.equal(outcome.mode, 'enforce');
    }
  }
  assert.equal(decisions(h.recorded).filter((decision) => decision === 'unavailable').length, 2);
  for (const entry of h.logEntries) assert.equal(entry.failureClass, 'unavailable');
});

test('enforce: complete recovers through the BOUNDED emergency budget and reports fallback/fallback_denied', async () => {
  const h = harness();
  const fake = new FakeRateLimitClient();
  fake.evalshaImpl = async () => { throw new Error('Command timed out'); };
  const facade = h.facade({
    config: makeConfig({ completeEmergency: Object.freeze({ rateMax: 2, rateWindowMs: 60000 }) }),
    store: makeStore(fake),
  });
  const owner = subject('enforce-emergency');

  const first = await facade.checkAdmission({ routeClass: 'complete', subject: owner });
  assert.equal(first.kind, 'fallback', 'the first failure recovers through the emergency budget');
  if (first.kind === 'fallback') {
    assert.equal(first.decision.allowed, true);
    assert.equal(first.failure.class, 'timeout');
    assert.equal(first.mode, 'enforce');
  }
  assert.equal((await facade.checkAdmission({ routeClass: 'complete', subject: owner })).kind, 'fallback');
  const third = await facade.checkAdmission({ routeClass: 'complete', subject: owner });
  assert.equal(third.kind, 'denied', 'the emergency budget is exhausted: a REAL local quota fact');
  if (third.kind === 'denied') assert.equal(third.decision.allowed, false);

  assert.deepEqual([...decisions(h.recorded)].sort(), ['denied', 'fallback', 'fallback']);
  for (const entry of h.logEntries) assert.equal(entry.failureClass, 'timeout');
});

test('enforce: the emergency limiter is bounded — a full map fails closed instead of admitting a new subject', async () => {
  const h = harness();
  const fake = new FakeRateLimitClient();
  fake.evalshaImpl = async () => { throw new Error('ECONNRESET'); };
  const facade = h.facade({
    config: makeConfig(),
    store: makeStore(fake),
    emergency: new EmergencyRateLimiter(makeConfig(), { maxSubjects: 1, clock: () => NOW_MS }),
  });
  assert.equal((await facade.checkAdmission({ routeClass: 'complete', subject: subject('cap-a') })).kind, 'fallback');
  const second = await facade.checkAdmission({ routeClass: 'complete', subject: subject('cap-b') });
  assert.equal(second.kind, 'unavailable', 'a full emergency map fails closed (never unbounded admission)');
});

// ---------------------------------------------------------------------------
// Readiness (plan §13.1 step 3/4)
// ---------------------------------------------------------------------------

test('readiness: enforce+required + degraded blocks attachments; shadow/optional degrade without blocking', () => {
  assert.deepEqual(
    evaluateAttachmentRateLimitReadiness({ mode: 'off', required: false, storeStatus: 'degraded' }),
    { status: 'healthy', blocksAttachments: false, reason: 'none' },
  );
  assert.deepEqual(
    evaluateAttachmentRateLimitReadiness({ mode: 'shadow', required: false, storeStatus: 'degraded' }),
    { status: 'degraded', blocksAttachments: false, reason: 'redis_unavailable' },
  );
  assert.deepEqual(
    evaluateAttachmentRateLimitReadiness({ mode: 'enforce', required: false, storeStatus: 'degraded' }),
    { status: 'degraded', blocksAttachments: false, reason: 'redis_unavailable' },
  );
  assert.deepEqual(
    evaluateAttachmentRateLimitReadiness({ mode: 'enforce', required: true, storeStatus: 'degraded' }),
    { status: 'degraded', blocksAttachments: true, reason: 'redis_unavailable' },
  );
});

// ---------------------------------------------------------------------------
// Bootstrap composition: zero clients in off, one shared store otherwise
// ---------------------------------------------------------------------------

test('composeAttachmentRateLimit: off mode creates zero clients and never resolves the HMAC secret', async () => {
  let createClientCalls = 0;
  let resolveCalls = 0;
  const composition = await composeAttachmentRateLimit({
    config: makeConfig({ mode: 'off', required: false, redisUrl: null, keySecretRef: null }),
    environment: ENVIRONMENT,
    resolveKeySecret: async () => { resolveCalls += 1; throw new Error('must not resolve in off mode'); },
    createClient: (() => { createClientCalls += 1; throw new Error('must not create a client in off mode'); }) as never,
  });
  assert.equal(createClientCalls, 0);
  assert.equal(resolveCalls, 0);
  assert.equal(composition.mode, 'off');
  assert.equal(composition.facade.mode, 'off');
  assert.equal(composition.readiness().blocksAttachments, false);
  await composition.close();
  await composition.close();
});

test('composeAttachmentRateLimit: enforce mode creates exactly one shared store and close is idempotent', async () => {
  const clients: FakeRateLimitClient[] = [];
  const composition = await composeAttachmentRateLimit({
    config: makeConfig(),
    environment: ENVIRONMENT,
    resolveKeySecret: async (ref) => {
      assert.equal(ref, 'known/rl04/unit/hmac');
      return KEY_SECRET;
    },
    createClient: (_url: string, _options: RateLimitRedisClientOptions) => {
      const fake = new FakeRateLimitClient();
      clients.push(fake);
      return fake;
    },
  });
  assert.equal(clients.length, 1, 'all routes share one Redis client');
  assert.equal(composition.mode, 'enforce');
  const owner = subject('compose');
  const outcome = await composition.facade.checkAdmission({ routeClass: 'issue', subject: owner });
  assert.equal(outcome.kind, 'allowed');
  assert.equal(clients[0]!.scriptLoads, 1, 'one script load shared by every route');
  await composition.close();
  await composition.close();
  assert.equal(composition.facade.readiness().status, 'degraded', 'closed stores report degraded');
});

// ---------------------------------------------------------------------------
// loadConfig wiring: orthogonality with KNOWN_CACHE_MODE + production gate
// ---------------------------------------------------------------------------

const baseEnv = {
  DATABASE_URL: 'postgresql://known:known@127.0.0.1:5432/known',
  NODE_ENV: 'test',
  OIDC_ALLOW_TEST_PROVIDER: 'true',
  OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
  PRODUCT_ORIGIN: 'https://app.known.example',
  LOG_LEVEL: 'silent',
};

function rateLimitEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    ATTACHMENTS_RATE_LIMIT_MODE: 'enforce',
    ATTACHMENTS_RATE_LIMIT_REQUIRED: 'true',
    ATTACHMENTS_RATE_LIMIT_REDIS_URL: 'redis://127.0.0.1:6379',
    ATTACHMENTS_RATE_LIMIT_KEY_SECRET: 'known/rl04/config/hmac',
    ...overrides,
  };
}

test('loadConfig parses the rate-limit contract with the off default and never couples it to KNOWN_CACHE_MODE', () => {
  const defaulted = loadConfig(baseEnv);
  assert.equal(defaulted.attachmentsRateLimit.mode, 'off');
  assert.equal(defaulted.attachmentsRateLimit.required, false);
  assert.equal(defaulted.cache.redis.mode, 'off');

  // KNOWN_CACHE_MODE=off + rate enforce: turning the Publication cache off
  // never disables Attachment rate limiting (plan §2.2.5).
  const cacheOffRateEnforce = loadConfig({ ...baseEnv, ...rateLimitEnv() });
  assert.equal(cacheOffRateEnforce.cache.redis.mode, 'off');
  assert.equal(cacheOffRateEnforce.attachmentsRateLimit.mode, 'enforce');
  assert.equal(cacheOffRateEnforce.attachmentsRateLimit.required, true);

  // The reverse: cache serve + rate off — the limiter stays off independently.
  const cacheServeRateOff = loadConfig({
    ...baseEnv,
    KNOWN_CACHE_MODE: 'serve',
    REDIS_URL: 'redis://127.0.0.1:6380',
    ATTACHMENTS_RATE_LIMIT_MODE: 'off',
  });
  assert.equal(cacheServeRateOff.cache.redis.mode, 'serve');
  assert.equal(cacheServeRateOff.attachmentsRateLimit.mode, 'off');
});

test('loadConfig rejects an invalid rate-limit mode and an invalid replica count', () => {
  assert.throws(
    () => loadConfig({ ...baseEnv, ...rateLimitEnv({ ATTACHMENTS_RATE_LIMIT_MODE: 'sometimes' }) }),
    /off, shadow or enforce/,
  );
  assert.throws(
    () => loadConfig({ ...baseEnv, ATTACHMENTS_API_REPLICAS: 'many' }),
    /ATTACHMENTS_API_REPLICAS/,
  );
});

test('the production multi-replica gate fails closed at startup (plan §2.2.6/§13.1)', () => {
  const productionBase = {
    ...baseEnv,
    NODE_ENV: 'production',
    ALLOWED_ORIGINS: 'https://app.known.example',
    OIDC_ISSUER: 'https://issuer.example/realms/known',
    OIDC_CLIENT_ID: 'known-web',
    OIDC_REDIRECT_URI: 'https://app.known.example/api/v1/auth/oidc/callback',
    OIDC_AUTHORIZATION_ENDPOINT: 'https://issuer.example/realms/known/auth',
    OIDC_TOKEN_ENDPOINT: 'https://issuer.example/realms/known/token',
    OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs',
    OIDC_ALLOW_TEST_PROVIDER: 'false',
    OIDC_TRANSACTION_HMAC_SECRET: 'prod-oidc-transaction-hmac-secret-not-dev-default',
    OIDC_TRANSACTION_ENCRYPTION_KEYS: `1:oidc-pkce-prod:${Buffer.alloc(32, 5).toString('base64')}`,
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
    };
  const attachmentsEnabled = {
    ATTACHMENTS_ENABLED: 'true',
    ATTACHMENTS_R2_ENDPOINT: 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
    ATTACHMENTS_R2_REGION: 'auto',
    ATTACHMENTS_R2_BUCKET: 'known-private-attachments',
    ATTACHMENTS_R2_LIVE_PREFIX: 'attachments/live/',
    ATTACHMENTS_R2_PROBE_PREFIX: 'attachments/probe/',
    ATTACHMENTS_R2_RW_SECRET_REF: 'known/r2/rw/primary',
    ATTACHMENTS_R2_RO_SECRET_REF: 'known/r2/ro/primary',
    ATTACHMENTS_ISOLATED_DELIVERY_ORIGIN: 'https://delivery.known.test',
    ATTACHMENTS_DELIVERY_CAPABILITY_SECRET_REF: 'known/delivery/hmac/primary',
    ATTACHMENTS_DELIVERY_CAPABILITY_TTL_SECONDS: '60',
    ATTACHMENTS_ALLOWED_MEDIA: 'image/png',
    ATTACHMENTS_GRANT_TTL_SECONDS: '60',
    ATTACHMENTS_SINGLE_PUT_MAX_BYTES: '5242880',
    ATTACHMENTS_VERIFICATION_LEASE_MS: '60000',
    ATTACHMENTS_VERIFICATION_TIMEOUT_MS: '15000',
    ATTACHMENTS_VERIFICATION_RETRY_COUNT: '2',
    ATTACHMENTS_INTENT_RETENTION_HOURS: '24',
    ATTACHMENTS_STORED_RETENTION_DAYS: '30',
    ATTACHMENTS_RETIRED_RETENTION_DAYS: '90',
    ATTACHMENTS_CLEANUP_BATCH_SIZE: '100',
    ATTACHMENTS_CLEANUP_LEASE_MS: '60000',
    ATTACHMENTS_CLEANUP_RETRY_COUNT: '2',
  };

  // multi-replica production with attachments enabled and mode=off must fail.
  assert.throws(
    () => loadConfig({
      ...productionBase,
      ...attachmentsEnabled,
      ATTACHMENTS_API_REPLICAS: '2',
      ATTACHMENTS_RATE_LIMIT_MODE: 'off',
    }),
    /multi-replica production requires ATTACHMENTS_RATE_LIMIT_MODE=enforce/,
  );
  // shadow on multi-replica production also fails closed.
  assert.throws(
    () => loadConfig({
      ...productionBase,
      ...attachmentsEnabled,
      ATTACHMENTS_API_REPLICAS: '2',
      ...rateLimitEnv({ ATTACHMENTS_RATE_LIMIT_MODE: 'shadow', ATTACHMENTS_RATE_LIMIT_REQUIRED: 'false' }),
    }),
    /multi-replica production requires ATTACHMENTS_RATE_LIMIT_MODE=enforce/,
  );
  // enforce+required passes, and a single-replica profile may explicitly
  // record off (plan §2.2.6).
  const enforced = loadConfig({
    ...productionBase,
    ...attachmentsEnabled,
    ATTACHMENTS_API_REPLICAS: '2',
    ...rateLimitEnv(),
  });
  assert.equal(enforced.attachmentsRateLimit.mode, 'enforce');
  assert.equal(enforced.attachmentsRateLimit.required, true);
  const single = loadConfig({
    ...productionBase,
    ...attachmentsEnabled,
    ATTACHMENTS_RATE_LIMIT_MODE: 'off',
  });
  assert.equal(single.attachmentsRateLimit.mode, 'off');
});

test('the sanitized capacity snapshot never leaks the rate-limit URL or secret reference', () => {
  const config = loadConfig({ ...baseEnv, ...rateLimitEnv() });
  const snapshot = sanitizedRuntimeCapacity(config);
  const serialized = JSON.stringify(snapshot.attachmentsRateLimit);
  assert.ok(!serialized.includes('127.0.0.1:6379'), 'the URL host must not leak into the capacity snapshot');
  assert.ok(!serialized.includes('known/rl04/config/hmac'), 'the secret reference must not leak');
  assert.equal(snapshot.attachmentsRateLimit.mode, 'enforce');
  assert.equal(snapshot.attachmentsRateLimit.redisConfigured, true);
});
