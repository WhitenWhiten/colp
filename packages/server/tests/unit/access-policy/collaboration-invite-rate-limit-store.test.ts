/**
 * S-04 collaboration-invite rate-limit store: memory quotas, maxBuckets
 * fail-closed, Redis scripted fake sharing, denied vs failed.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import { readApiCompositionSource } from '../../support/api-composition-source.js';
import {
  RATE_LIMIT_LUA_SCRIPT,
  buildCollaborationInviteRateLimitKey,
  collaborationInviteRateLimitSubjectHmac,
  composeCollaborationInviteRateLimiter,
  createMemoryCollaborationInviteRateLimiter,
  createRedisCollaborationInviteRateLimitStore,
  parseCollaborationInviteRateLimitKey,
  type CollaborationInviteRateLimitOutcome,
  type CollaborationInviteRateLimiter,
  type RateLimitRedisClientLike,
  type RateLimitRedisClientOptions,
} from '../../../src/infrastructure/rate-limit/index.js';

const TEST_SECRET = Buffer.from('collaboration-invite-unit-hmac-secret', 'utf8');
const AUTH_PEPPER = Buffer.alloc(32, 1);
const ENVIRONMENT = 'test';
const KEY_PREFIX = 'collab-unit';
const REDIS_URL = 'redis://127.0.0.1:6379';
const NOW_MS = 1_750_000_000_000;
const WINDOW_MS = 60 * 60 * 1000;
const WINDOW_START = Math.floor(NOW_MS / WINDOW_MS) * WINDOW_MS;
const PRINCIPAL = 'principal-owner-0001';

interface FakeCall {
  readonly kind: 'script_load' | 'evalsha';
  readonly args: readonly unknown[];
}

class FakeRateLimitClient implements RateLimitRedisClientLike {
  status = 'ready';
  readonly calls: FakeCall[] = [];
  scriptLoadImpl: (script: string) => Promise<string> = async () => 'a'.repeat(40);
  evalshaImpl: (sha: string, args: readonly (string | number)[]) => Promise<unknown> =
    async () => [1, 1, 19, 60, WINDOW_START];

  connect(): Promise<void> { return Promise.resolve(); }
  disconnect(): void {}
  quit(): Promise<'OK'> { return Promise.resolve('OK'); }
  removeAllListeners(): this { return this; }
  on(): this { return this; }
  script(subcommand: 'LOAD', script: string): Promise<string> {
    this.calls.push({ kind: 'script_load', args: [subcommand, script] });
    return this.scriptLoadImpl(script);
  }
  evalsha(sha: string, numkeys: number, ...args: (string | number)[]): Promise<unknown> {
    this.calls.push({ kind: 'evalsha', args: [sha, numkeys, ...args] });
    return this.evalshaImpl(sha, args);
  }
}

function makeRedisStore(
  fake: FakeRateLimitClient,
  overrides: {
    readonly inviteLimit?: number;
    readonly now?: () => number;
    readonly failureThreshold?: number;
  } = {},
): CollaborationInviteRateLimiter {
  return createRedisCollaborationInviteRateLimitStore({
    redisUrl: 'redis://127.0.0.1:6379',
    environment: ENVIRONMENT,
    keySecret: TEST_SECRET,
    keyPrefix: KEY_PREFIX,
    inviteLimit: overrides.inviteLimit ?? 20,
    commandTimeoutMs: 75,
    connectTimeoutMs: 1000,
    maxRetriesPerRequest: 1,
    createClient: (_url: string, _options: RateLimitRedisClientOptions) => fake,
    now: overrides.now ?? (() => NOW_MS),
    ...(overrides.failureThreshold === undefined ? {} : { failureThreshold: overrides.failureThreshold }),
  });
}

function assertFailure(outcome: CollaborationInviteRateLimitOutcome, failureClass: string, code: string): void {
  assert.equal(outcome.kind, 'failed');
  if (outcome.kind !== 'failed') return;
  assert.equal(outcome.failure.class, failureClass);
  assert.equal(outcome.failure.code, code);
}

test('memory: 20 invites then denied with retryAfterSeconds >= 1', async () => {
  const limiter = createMemoryCollaborationInviteRateLimiter({
    keySecret: TEST_SECRET,
    environment: ENVIRONMENT,
    now: () => NOW_MS,
    inviteLimit: 20,
  });
  for (let index = 0; index < 20; index += 1) {
    const outcome = await limiter.consumeInvite(PRINCIPAL);
    assert.equal(outcome.kind, 'allowed');
  }
  const denied = await limiter.consumeInvite(PRINCIPAL);
  assert.equal(denied.kind, 'denied');
  if (denied.kind !== 'denied') return;
  assert.equal(denied.decision.allowed, false);
  assert.ok(denied.decision.retryAfterSeconds >= 1);
});

test('memory maxBuckets overflow returns failed, distinct from denied', async () => {
  const limiter = createMemoryCollaborationInviteRateLimiter({
    keySecret: TEST_SECRET,
    environment: ENVIRONMENT,
    now: () => NOW_MS,
    inviteLimit: 20,
    maxBuckets: 1,
  });
  const first = await limiter.consumeInvite(PRINCIPAL);
  assert.equal(first.kind, 'allowed');
  const overflow = await limiter.consumeInvite('principal-other-0002');
  assertFailure(overflow, 'unavailable', 'rate_limit_capacity_exhausted');
  const sameBucket = await limiter.consumeInvite(PRINCIPAL);
  assert.equal(sameBucket.kind, 'allowed');
  assert.notEqual(overflow.kind, 'denied');
  assert.notEqual(overflow.kind, sameBucket.kind);
});

test('Redis scripted fake: two stores share the counter; EVALSHA key uses collaboration codec', async () => {
  const counters = new Map<string, number>();
  const fake = new FakeRateLimitClient();
  fake.evalshaImpl = async (_sha, args) => {
    const key = String(args[0]);
    const rateMax = Number(args[1]);
    const windowMs = Number(args[2]);
    const next = (counters.get(key) ?? 0) + 1;
    counters.set(key, next);
    const remaining = Math.max(0, rateMax - next);
    const allowed = next <= rateMax ? 1 : 0;
    const retryAfter = Math.max(1, Math.ceil(windowMs / 1000));
    return [allowed, next, remaining, retryAfter, WINDOW_START];
  };
  const left = makeRedisStore(fake, { inviteLimit: 2 });
  const right = makeRedisStore(fake, { inviteLimit: 2 });
  assert.equal((await left.consumeInvite(PRINCIPAL)).kind, 'allowed');
  assert.equal((await right.consumeInvite(PRINCIPAL)).kind, 'allowed');
  const denied = await left.consumeInvite(PRINCIPAL);
  assert.equal(denied.kind, 'denied');

  const evalsha = fake.calls.find((call) => call.kind === 'evalsha');
  assert.ok(evalsha);
  const key = evalsha.args[2] as string;
  const expected = buildCollaborationInviteRateLimitKey({
    keyPrefix: KEY_PREFIX,
    environment: ENVIRONMENT,
    keySecret: TEST_SECRET,
    principalId: PRINCIPAL,
    action: 'invite',
    windowStartEpochMs: WINDOW_START,
  });
  assert.equal(key, expected);
  const parsed = parseCollaborationInviteRateLimitKey(key);
  assert.equal(parsed.kind, 'ok');
  if (parsed.kind === 'ok') {
    assert.equal(parsed.parts.action, 'invite');
    assert.equal(parsed.parts.subjectHmac, collaborationInviteRateLimitSubjectHmac(TEST_SECRET, PRINCIPAL));
  }
  assert.equal(key.includes(PRINCIPAL), false);
  assert.equal(key.includes(TEST_SECRET.toString('utf8')), false);
  assert.equal(fake.calls[0]?.kind, 'script_load');
  assert.equal(fake.calls[0]?.args[1], RATE_LIMIT_LUA_SCRIPT);
});

test('compose Redis limiter forwards URL and invite pepper; two instances share the counter', async () => {
  const counters = new Map<string, number>();
  const fake = new FakeRateLimitClient();
  fake.evalshaImpl = async (_sha, args) => {
    const key = String(args[0]);
    const rateMax = Number(args[1]);
    const windowMs = Number(args[2]);
    const next = (counters.get(key) ?? 0) + 1;
    counters.set(key, next);
    const remaining = Math.max(0, rateMax - next);
    const allowed = next <= rateMax ? 1 : 0;
    const retryAfter = Math.max(1, Math.ceil(windowMs / 1000));
    return [allowed, next, remaining, retryAfter, WINDOW_START];
  };
  const seenUrls: string[] = [];
  const composeShared = (keySecret: Buffer) => composeCollaborationInviteRateLimiter({
    environment: ENVIRONMENT,
    keySecret,
    shared: {
      enabled: true,
      redisUrl: REDIS_URL,
      keyPrefix: KEY_PREFIX,
      commandTimeoutMs: 75,
      connectTimeoutMs: 1000,
      maxRetriesPerRequest: 1,
    },
    createClient: (url: string, _options: RateLimitRedisClientOptions) => {
      seenUrls.push(url);
      return fake;
    },
  });
  const left = composeShared(TEST_SECRET);
  const authPepper = composeShared(AUTH_PEPPER);
  const right = composeShared(TEST_SECRET);
  assert.deepEqual(seenUrls, [REDIS_URL, REDIS_URL, REDIS_URL]);
  assert.equal(left.constructor.name, 'RedisCollaborationInviteRateLimitStore');
  assert.equal((await left.consumeInvite(PRINCIPAL)).kind, 'allowed');
  assert.equal((await authPepper.consumeInvite(PRINCIPAL)).kind, 'allowed');
  for (let index = 0; index < 19; index += 1) {
    assert.equal((await left.consumeInvite(PRINCIPAL)).kind, 'allowed');
  }
  assert.equal((await right.consumeInvite(PRINCIPAL)).kind, 'denied');
  const evalsha = fake.calls.find((call) => call.kind === 'evalsha');
  assert.ok(evalsha);
  const key = evalsha.args[2] as string;
  const parsed = parseCollaborationInviteRateLimitKey(key);
  assert.equal(parsed.kind, 'ok');
  assert.ok(parsed.kind === 'ok');
  assert.equal(parsed.parts.action, 'invite');
  assert.equal(parsed.parts.subjectHmac, collaborationInviteRateLimitSubjectHmac(TEST_SECRET, PRINCIPAL));
  assert.equal(
    key,
    buildCollaborationInviteRateLimitKey({
      keyPrefix: KEY_PREFIX,
      environment: ENVIRONMENT,
      keySecret: TEST_SECRET,
      principalId: PRINCIPAL,
      action: 'invite',
      windowStartEpochMs: parsed.parts.windowStartEpochMs,
    }),
  );
  assert.notEqual(
    parsed.parts.subjectHmac,
    collaborationInviteRateLimitSubjectHmac(AUTH_PEPPER, PRINCIPAL),
  );
  const memory = composeCollaborationInviteRateLimiter({
    environment: ENVIRONMENT,
    keySecret: TEST_SECRET,
    shared: {
      enabled: false,
      redisUrl: null,
      keyPrefix: 'known',
      commandTimeoutMs: 75,
      connectTimeoutMs: 1000,
      maxRetriesPerRequest: 1,
    },
  });
  assert.notEqual(memory.constructor.name, 'RedisCollaborationInviteRateLimitStore');
  assert.equal(typeof (memory as { size?: () => number }).size, 'function');
});

test('Redis malformed reply is failed, not denied; circuit then fails closed', async () => {
  const fake = new FakeRateLimitClient();
  fake.evalshaImpl = async () => [1, 5];
  const store = makeRedisStore(fake, { failureThreshold: 1 });
  const first = await store.consumeInvite(PRINCIPAL);
  assertFailure(first, 'malformed', 'rate_limit_malformed_reply');
  const second = await store.consumeInvite(PRINCIPAL);
  assertFailure(second, 'unavailable', 'rate_limit_circuit_open');
  assert.notEqual(first.kind, 'denied');
});

test('bootstrap api.ts composes the invite limiter and does not bake an HMAC default', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readApiCompositionSource(resolve(here, '../../..'));
  assert.equal(source.includes('composeCollaborationInviteRateLimiter('), true);
  assert.equal(source.includes('known-collaboration-invite-rate-limit-v1'), false);
  assert.equal(source.includes('randomBytes(32)'), false);
  assert.equal(source.includes('keySecret: config.collaborationInviteRateLimit.keySecret ??'), false);
  assert.match(source, /keySecret:\s*config\.collaborationInviteRateLimit\.keySecret,/);
});

test('production AUTH_API_REPLICAS>1 without collaboration shared fails loadConfig', () => {
  const prod = {
    DATABASE_URL: 'postgres://localhost/known',
    NODE_ENV: 'production',
    PRODUCT_ORIGIN: 'https://app.example.test',
    ALLOWED_ORIGINS: 'https://app.example.test',
    OIDC_ISSUER: 'https://issuer.example/realms/known',
    OIDC_CLIENT_ID: 'known-web',
    OIDC_REDIRECT_URI: 'https://app.example.test/api/v1/auth/oidc/callback',
    OIDC_AUTHORIZATION_ENDPOINT: 'https://issuer.example/realms/known/auth',
    OIDC_TOKEN_ENDPOINT: 'https://issuer.example/realms/known/token',
    OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs',
    OIDC_ALLOW_TEST_PROVIDER: 'false',
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
    TRUSTED_INGRESS: '',
    OIDC_TRANSACTION_HMAC_SECRET: 'prod-oidc-transaction-hmac-secret-not-dev-default',
    OIDC_TRANSACTION_ENCRYPTION_KEYS: `1:oidc-pkce-prod:${Buffer.alloc(32, 5).toString('base64')}`,
    AUTH_API_REPLICAS: '2',
    AUTH_RATE_LIMIT_SHARED: 'true',
    AUTH_RATE_LIMIT_REDIS_URL: 'redis://127.0.0.1:6379',
    AUTH_RATE_LIMIT_KEY_SECRET: 'auth-rate-limit-hmac-secret-001',
    SEARCH_RATE_LIMIT_SHARED: 'true',
    SEARCH_RATE_LIMIT_REDIS_URL: 'redis://127.0.0.1:6379',
    SEARCH_RATE_LIMIT_KEY_SECRET: 'search-rate-limit-hmac-secret-006',
    PUBLISHING_INSIGHTS_RATE_LIMIT_SHARED: 'true',
    PUBLISHING_INSIGHTS_RATE_LIMIT_REDIS_URL: 'redis://127.0.0.1:6379',
  } as NodeJS.ProcessEnv;
  assert.throws(
    () => loadConfig(prod),
    /AUTH_API_REPLICAS > 1.*COLLABORATION_INVITE_RATE_LIMIT_SHARED=true/s,
  );
});

test('shared=true without KEY_SECRET refuses startup', () => {
  assert.throws(
    () => loadConfig({
      DATABASE_URL: 'postgres://localhost/known',
      OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs',
      COLLABORATION_INVITE_RATE_LIMIT_SHARED: 'true',
      COLLABORATION_INVITE_RATE_LIMIT_REDIS_URL: 'redis://127.0.0.1:6379',
    }),
    /COLLABORATION_INVITE_RATE_LIMIT_KEY_SECRET is required/,
  );
});
