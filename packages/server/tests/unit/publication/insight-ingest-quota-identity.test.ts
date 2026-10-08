import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { afterEach, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import { createVisitorHashPort } from '../../../src/infrastructure/publication/index.js';
import {
  composePublishingInsightsIngestRateLimiter,
  createMemoryPublishingInsightsIngestRateLimiter,
  type PublishingInsightsIngestRateLimitSubject,
  type PublishingInsightsIngestRateLimiter,
  type RateLimitRedisClientLike,
  type RateLimitRedisClientOptions,
} from '../../../src/infrastructure/rate-limit/index.js';
import {
  recordInsightEvent,
  type PublicationInsightCollectionFacts,
  type PublicationInsightFactsPort,
  type PublicationInsightStore,
  type RecordInsightEventPorts,
  type VisitorHashPort,
} from '../../../src/modules/publication/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import {
  INSIGHT_COOKIE_MAC_PURPOSE,
  INSIGHT_COOKIE_TICKET_PATTERN,
  mintInsightCookieTicket,
  verifyInsightCookieTicket,
} from '../../../src/transport/product/insight-cookie.js';
import { createInMemoryBetterAuthTestFactory } from '../../support/better-auth-test-factory.js';
import {
  createIdentityMemoryState,
  createIdentityMemoryUnitOfWork,
} from '../../support/product-http-harness.js';

const ORIGIN = 'https://known.example';
const INSTANT = '2026-08-18T12:00:00.000Z';
const PEPPER = Buffer.alloc(32, 19);
const RATE_PEPPER = Buffer.alloc(32, 23);
const AUTH_PEPPER = Buffer.alloc(32, 1);
const REDIS_URL = 'redis://127.0.0.1:6379';
const INSIGHTS_KEY_PREFIX = 'insights-unit';
const HASH = Uint8Array.from({ length: 32 }, (_, index) => index + 3);

const PUBLIC_FACTS: PublicationInsightCollectionFacts = {
  collectionId: 'col-public',
  ownerSubjectId: 'owner-subject',
  visibility: 'public',
  publicationSlug: 'public-notes',
  deletedAt: null,
};

const identityUnitOfWork = createIdentityMemoryUnitOfWork(createIdentityMemoryState(INSTANT));
const factory = createInMemoryBetterAuthTestFactory({ identityUnitOfWork });
const config = loadConfig({
  DATABASE_URL: 'postgres://unused/known',
  PRODUCT_ORIGIN: ORIGIN,
  PUBLICATION_ORIGIN: ORIGIN,
  LOG_LEVEL: 'silent',
  OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs',
});

const apps: Array<ReturnType<typeof buildApiApp>> = [];
const limiters: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  while (apps.length > 0) await apps.pop()?.close();
  while (limiters.length > 0) await limiters.pop()?.close();
});

test('minted insight cookie verifies; illegal tickets are rejected', () => {
  const ticket = mintInsightCookieTicket(PEPPER);
  assert.match(ticket, INSIGHT_COOKIE_TICKET_PATTERN);
  assert.equal(verifyInsightCookieTicket(PEPPER, ticket), true);
  assert.equal(verifyInsightCookieTicket(Buffer.alloc(32, 8), ticket), false);
  assert.equal(verifyInsightCookieTicket(PEPPER, randomBytes(16).toString('base64url')), false);
  assert.equal(verifyInsightCookieTicket(PEPPER, 'a'.repeat(200)), false);
  assert.equal(verifyInsightCookieTicket(PEPPER, 'not a ticket'), false);
  assert.equal(verifyInsightCookieTicket(PEPPER, `${ticket.slice(0, 22)}.${'A'.repeat(32)}`), false);
  const visitorDigest = createHmac('sha256', PEPPER).update(`anon|${ticket}`, 'utf8').digest('base64url');
  const mac = ticket.slice(ticket.indexOf('.') + 1);
  assert.notEqual(mac, visitorDigest.slice(0, 32));
  assert.equal(INSIGHT_COOKIE_MAC_PURPOSE.startsWith('anon|'), false);
});

test('rotating a new random cookie each request from the same IP is 429 on the second view', async () => {
  const app = buildQuotaApp();
  const first = await ingest(app, { cookie: `__Host-known_insight=${randomBytes(16).toString('base64url')}` });
  assert.equal(first.statusCode, 204);
  const second = await ingest(app, { cookie: `__Host-known_insight=${randomBytes(16).toString('base64url')}` });
  assert.equal(second.statusCode, 429);
  assert.equal(second.json().error.code, 'rate_limited');
});

test('illegal, overlong, and unsigned cookies are not independent quota identities', async () => {
  const app = buildQuotaApp();
  const first = await ingest(app, { cookie: `__Host-known_insight=${'a'.repeat(200)}` });
  assert.equal(first.statusCode, 204);
  const second = await ingest(app, { cookie: `__Host-known_insight=${randomBytes(16).toString('base64url')}` });
  assert.equal(second.statusCode, 429);
  assert.equal(second.json().error.code, 'rate_limited');
  const charset = await ingest(buildQuotaApp(), { cookie: '__Host-known_insight=////++++====' });
  assert.equal(charset.statusCode, 204);
  const charsetSecond = await ingest(apps[apps.length - 1]!, {
    cookie: '__Host-known_insight=not.a.valid.ticket.value',
  });
  assert.equal(charsetSecond.statusCode, 429);
});

test('a valid signed cookie still shares the IP quota', async () => {
  const app = buildQuotaApp();
  const first = await ingest(app);
  assert.equal(first.statusCode, 204);
  const ticket = cookieValue(first.headers['set-cookie']);
  assert.match(ticket, INSIGHT_COOKIE_TICKET_PATTERN);
  const second = await ingest(app, { cookie: `__Host-known_insight=${ticket}` });
  assert.equal(second.statusCode, 429);
  assert.equal(second.json().error.code, 'rate_limited');
});

test('a second IP still receives 204 after the first IP is exhausted', async () => {
  const app = buildQuotaApp();
  const first = await ingest(app, { remoteAddress: '203.0.113.10' });
  assert.equal(first.statusCode, 204);
  const exhausted = await ingest(app, { remoteAddress: '203.0.113.10' });
  assert.equal(exhausted.statusCode, 429);
  assert.equal(exhausted.json().error.code, 'rate_limited');
  const otherIp = await ingest(app, { remoteAddress: '198.51.100.20' });
  assert.equal(otherIp.statusCode, 204);
});

test('memory adapter exceeding maxBuckets returns failed, not a silent new bucket', async () => {
  const limiter = createMemoryPublishingInsightsIngestRateLimiter({
    keySecret: RATE_PEPPER,
    maxBuckets: 1,
    sweepIntervalMs: 60_000,
  });
  const first = await limiter.consume(ipuaSubject('203.0.113.10', 'alpha-notes'));
  assert.equal(first.kind, 'allowed');
  assert.equal(limiter.size(), 1);
  const overflow = await limiter.consume(ipuaSubject('198.51.100.20', 'alpha-notes'));
  assert.equal(overflow.kind, 'failed');
  if (overflow.kind === 'failed') {
    assert.equal(overflow.failure.class, 'unavailable');
    assert.equal(overflow.failure.code, 'rate_limit_capacity_exhausted');
  }
  assert.equal(limiter.size(), 1);
  const existing = await limiter.consume(ipuaSubject('203.0.113.10', 'alpha-notes'));
  assert.equal(existing.kind, 'denied');
  assert.throws(
    () => createMemoryPublishingInsightsIngestRateLimiter({ keySecret: RATE_PEPPER, maxBuckets: 0 }),
    /maxBuckets/,
  );
});

test('compose Redis ingest limiter forwards URL, prefix, and insights pepper into EVALSHA keys', async () => {
  const counters = new Map<string, number>();
  const fake = new FakeRateLimitClient(counters);
  const seenUrls: string[] = [];
  const seenOptions: RateLimitRedisClientOptions[] = [];
  const composeShared = (keySecret: Buffer) => composePublishingInsightsIngestRateLimiter({
    environment: 'test',
    keySecret,
    shared: {
      enabled: true,
      redisUrl: REDIS_URL,
      keyPrefix: INSIGHTS_KEY_PREFIX,
      commandTimeoutMs: 75,
      connectTimeoutMs: 1000,
      maxRetriesPerRequest: 1,
    },
    createClient: (url: string, options: RateLimitRedisClientOptions) => {
      seenUrls.push(url);
      seenOptions.push(options);
      return fake;
    },
  });
  const insights = composeShared(RATE_PEPPER);
  const authPepper = composeShared(AUTH_PEPPER);
  const sharedInsights = composeShared(RATE_PEPPER);
  limiters.push(insights, authPepper, sharedInsights);
  assert.deepEqual(seenUrls, [REDIS_URL, REDIS_URL, REDIS_URL]);
  assert.equal(seenOptions[0]?.commandTimeout, 75);
  assert.equal(insights.constructor.name, 'RedisPublishingInsightsIngestRateLimitStore');
  const subject = ipuaSubject('203.0.113.10', 'alpha-notes');
  assert.equal((await insights.consume(subject)).kind, 'allowed');
  assert.equal((await authPepper.consume(subject)).kind, 'allowed');
  assert.equal((await sharedInsights.consume(subject)).kind, 'denied');
  const keys = fake.evalshaKeys();
  assert.equal(keys.length, 3);
  assert.equal(keys[0], keys[2]);
  assert.notEqual(keys[0], keys[1]);
  assert.match(keys[0]!, new RegExp(`^${INSIGHTS_KEY_PREFIX}:test:ratelimit:v1:\\{insights-ingest:`));
  assert.equal(keys[0]!.includes(RATE_PEPPER.toString('utf8')), false);
  assert.equal(keys[0]!.includes('203.0.113.10'), false);
  const memory = composePublishingInsightsIngestRateLimiter({
    environment: 'test',
    keySecret: RATE_PEPPER,
    shared: {
      enabled: false,
      redisUrl: null,
      keyPrefix: 'known',
      commandTimeoutMs: 75,
      connectTimeoutMs: 1000,
      maxRetriesPerRequest: 1,
    },
  });
  assert.notEqual(memory.constructor.name, 'RedisPublishingInsightsIngestRateLimitStore');
  assert.equal(typeof (memory as { size?: () => number }).size, 'function');
});

test('production AUTH_API_REPLICAS>1 without insights shared fails loadConfig', () => {
  const prod = productionEnv({
    AUTH_API_REPLICAS: '2',
    AUTH_RATE_LIMIT_SHARED: 'true',
    AUTH_RATE_LIMIT_REDIS_URL: 'redis://127.0.0.1:6379',
    AUTH_RATE_LIMIT_KEY_SECRET: 'auth-rate-limit-hmac-secret-001',
    SEARCH_RATE_LIMIT_SHARED: 'true',
    SEARCH_RATE_LIMIT_REDIS_URL: 'redis://127.0.0.1:6379',
    SEARCH_RATE_LIMIT_KEY_SECRET: 'search-rate-limit-hmac-secret-006',
  });
  assert.throws(
    () => loadConfig(prod),
    /AUTH_API_REPLICAS > 1.*PUBLISHING_INSIGHTS_RATE_LIMIT_SHARED=true/s,
  );
  const ok = loadConfig(productionEnv({
    AUTH_API_REPLICAS: '2',
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
    PUBLIC_ACTIVITY_RATE_LIMIT_SHARED: 'true',
    PUBLIC_ACTIVITY_RATE_LIMIT_REDIS_URL: 'redis://127.0.0.1:6379',
    PUBLIC_ACTIVITY_RATE_LIMIT_KEY_SECRET: 'public-activity-rate-limit-hmac-secret',
    PRODUCT_ROUTE_RATE_LIMIT_SHARED: 'true',
    PRODUCT_ROUTE_RATE_LIMIT_REDIS_URL: 'redis://127.0.0.1:6379',
    PRODUCT_ROUTE_RATE_LIMIT_KEY_SECRET: 'product-route-rate-limit-hmac-secret',
  }));
  assert.equal(ok.publishingInsights.rateLimitShared.enabled, true);
  assert.equal(ok.publishingInsights.rateLimitShared.redisUrl, 'redis://127.0.0.1:6379');
  assert.equal(ok.publishingInsights.rateLimitHmacKey.toString('utf8'), 'prod-publishing-insights-ratelimit-hmac-key-32b');
});

test('insights shared flag parses URL/prefix/timeouts and may reuse search Redis URL', () => {
  const testBase = {
    DATABASE_URL: 'postgres://localhost/known',
    OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs',
  };
  assert.throws(
    () => loadConfig({ ...testBase, PUBLISHING_INSIGHTS_RATE_LIMIT_SHARED: 'true' }),
    /PUBLISHING_INSIGHTS_RATE_LIMIT_REDIS_URL is required/,
  );
  const reused = loadConfig({
    ...testBase,
    PUBLISHING_INSIGHTS_RATE_LIMIT_SHARED: 'true',
    SEARCH_RATE_LIMIT_REDIS_URL: 'redis://127.0.0.1:6379',
  });
  assert.equal(reused.publishingInsights.rateLimitShared.enabled, true);
  assert.equal(reused.publishingInsights.rateLimitShared.redisUrl, 'redis://127.0.0.1:6379');
  const explicit = loadConfig({
    ...testBase,
    PUBLISHING_INSIGHTS_RATE_LIMIT_SHARED: 'true',
    PUBLISHING_INSIGHTS_RATE_LIMIT_REDIS_URL: 'redis://10.0.0.8:6379',
    PUBLISHING_INSIGHTS_RATE_LIMIT_KEY_PREFIX: 'insights-test',
    PUBLISHING_INSIGHTS_RATE_LIMIT_COMMAND_TIMEOUT_MS: '250',
    PUBLISHING_INSIGHTS_RATE_LIMIT_CONNECT_TIMEOUT_MS: '2000',
    PUBLISHING_INSIGHTS_RATE_LIMIT_MAX_RETRIES_PER_REQUEST: '2',
  });
  const shared = explicit.publishingInsights.rateLimitShared;
  assert.equal(shared.redisUrl, 'redis://10.0.0.8:6379');
  assert.equal(shared.keyPrefix, 'insights-test');
  assert.equal(shared.commandTimeoutMs, 250);
  assert.equal(shared.connectTimeoutMs, 2000);
  assert.equal(shared.maxRetriesPerRequest, 2);
  assert.throws(
    () => loadConfig({ ...testBase, PUBLISHING_INSIGHTS_RATE_LIMIT_SHARED: 'maybe' }),
    /PUBLISHING_INSIGHTS_RATE_LIMIT_SHARED must be true or false/,
  );
});

test('ingest limiter failure is 503 feature_temporarily_unavailable', async () => {
  const app = buildQuotaApp({
    consume: async () => ({
      kind: 'failed' as const,
      failure: { class: 'unavailable' as const, code: 'rate_limit_unavailable' },
    }),
    readiness: () => ({ status: 'degraded' as const, reason: 'last_command_failed' }),
    policy: { 'publishing-insights-ingest': 'test' },
    close: async () => undefined,
  });
  const response = await ingest(app);
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().error.code, 'feature_temporarily_unavailable');
});

function buildQuotaApp(rateLimiter?: PublishingInsightsIngestRateLimiter) {
  const memory = createMemoryInsight();
  const limiter = rateLimiter ?? createMemoryPublishingInsightsIngestRateLimiter({
    keySecret: RATE_PEPPER,
  });
  const visitorHash = createVisitorHashPort(PEPPER);
  const app = buildApiApp({
    config,
    identityUnitOfWork,
    browserSessionAuthority: factory.authority,
    productPublicInsight: {
      allowedOrigins: config.allowedOrigins,
      identityUnitOfWork,
      visitorHash,
      rateLimiter: limiter,
      rateLimitKeySecret: RATE_PEPPER,
      insightCookieSigningKey: PEPPER,
      record: (input) => recordInsightEvent(memory.ports, input),
      now: () => new Date(INSTANT),
    },
  });
  apps.push(app);
  return app;
}

function ingest(
  app: ReturnType<typeof buildApiApp>,
  options: { readonly cookie?: string; readonly remoteAddress?: string } = {},
) {
  const headers: Record<string, string> = {
    origin: ORIGIN,
    'content-type': 'application/json',
    'user-agent': 'Mozilla/5.0',
  };
  if (options.cookie !== undefined) headers.cookie = options.cookie;
  return app.inject({
    method: 'POST',
    url: '/api/v1/public-collections/public-notes/insight-events',
    headers,
    ...(options.remoteAddress === undefined ? {} : { remoteAddress: options.remoteAddress }),
    payload: { eventType: 'collection_view' },
  });
}

function cookieValue(value: string | string[] | undefined): string {
  const header = Array.isArray(value)
    ? value.find((item) => item.startsWith('__Host-known_insight='))
    : value;
  assert.ok(typeof header === 'string');
  const match = /^__Host-known_insight=([^;]+)/u.exec(header);
  assert.ok(match);
  return decodeURIComponent(match[1]!);
}

function ipuaSubject(ip: string, slug: string): PublishingInsightsIngestRateLimitSubject {
  return {
    visitor: { kind: 'ipua', ip, userAgent: 'Mozilla/5.0' },
    slug,
    eventType: 'collection_view',
  };
}

function productionEnv(overrides: Record<string, string> = {}) {
  return {
    DATABASE_URL: 'postgres://localhost/known',
    NODE_ENV: 'production',
    PRODUCT_ORIGIN: 'https://app.example.test',
    OIDC_REDIRECT_URI: 'https://app.example.test/api/v1/auth/oidc/callback',
    OIDC_JWKS_URI: 'https://issuer.example/jwks',
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
    OIDC_ALLOW_TEST_PROVIDER: 'false',
    // Product default is on; this fixture keeps social surfaces opted-out unless a test sets them.
    KNOWN_FEATURE_COLLECTION_FOLLOW: 'false',
    OIDC_TRANSACTION_HMAC_SECRET: 'prod-hmac-secret-not-dev-default',
    OIDC_TRANSACTION_ENCRYPTION_KEYS: `1:oidc-pkce-prod:${Buffer.alloc(32, 5).toString('base64')}`,
    TRUSTED_INGRESS: '',
    ...overrides,
  };
}

class FakeRateLimitClient implements RateLimitRedisClientLike {
  status = 'ready';
  private readonly counters: Map<string, number>;
  private readonly keys: string[] = [];

  constructor(counters: Map<string, number> = new Map()) {
    this.counters = counters;
  }

  evalshaKeys(): readonly string[] {
    return this.keys;
  }

  connect(): Promise<void> { return Promise.resolve(); }
  disconnect(): void {}
  quit(): Promise<'OK'> { return Promise.resolve('OK'); }
  removeAllListeners(): this { return this; }
  on(): this { return this; }
  script(): Promise<string> { return Promise.resolve('a'.repeat(40)); }
  evalsha(_sha: string, _numkeys: number, ...args: (string | number)[]): Promise<unknown> {
    const key = String(args[0]);
    const rateMax = Number(args[1]);
    const windowMs = Number(args[2]);
    this.keys.push(key);
    const next = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, next);
    const remaining = Math.max(0, rateMax - next);
    const allowed = next <= rateMax ? 1 : 0;
    const retryAfter = Math.max(1, Math.ceil(windowMs / 1000));
    return Promise.resolve([allowed, next, remaining, retryAfter, 0]);
  }
}

function createMemoryInsight(): {
  readonly ports: RecordInsightEventPorts;
} {
  const collections: Record<string, PublicationInsightCollectionFacts> = {
    'public-notes': PUBLIC_FACTS,
  };
  const facts: PublicationInsightFactsPort = {
    async loadBySlug(slug) {
      return collections[slug] ?? null;
    },
    async liveBookmarkExists() {
      return false;
    },
  };
  const store: PublicationInsightStore = {
    async insertEvent() {},
    async incrementDaily() {},
    async purgeExpired() { return { events: 0, daily: 0 }; },
  };
  const hash: VisitorHashPort = {
    hashAnonymous() { return HASH; },
    hashSubject() { return HASH; },
  };
  return { ports: { facts, store, visitorHash: hash } };
}
