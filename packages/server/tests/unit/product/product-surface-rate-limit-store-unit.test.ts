/**
 * PERIPH-P1-c product-surface Redis store: purposes never share a counter;
 * raw consume keys never reach EVALSHA.
 */
import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  buildProductSurfaceRateLimitKey,
  createRedisProductSurfaceRateLimitStore,
  parseProductSurfaceRateLimitKey,
  type ProductSurfaceRateLimiter,
  type ProductSurfaceRateLimitPurpose,
  type RateLimitRedisClientLike,
  type RateLimitRedisClientOptions,
} from '../../../src/infrastructure/rate-limit/index.js';

const ENVIRONMENT = 'test';
const KEY_SECRET = Buffer.from('product-surface-unit-hmac-secret', 'utf8');
const MAX = 2;
const WINDOW_MS = 60_000;
const NOW_MS = 1_750_000_000_000;
const SUBJECT = '/api/v1/feed|203.0.113.10';

interface FakeCall {
  readonly kind: 'script_load' | 'evalsha';
  readonly args: readonly unknown[];
}

class FakeRateLimitClient implements RateLimitRedisClientLike {
  status = 'ready';
  readonly calls: FakeCall[] = [];
  scriptLoadImpl: (script: string) => Promise<string> = async () => 'a'.repeat(40);
  evalshaImpl: (sha: string, args: readonly (string | number)[]) => Promise<unknown> =
    async () => [1, 1, MAX - 1, 60, Math.floor(NOW_MS / WINDOW_MS) * WINDOW_MS];

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

function makeStore(
  fake: FakeRateLimitClient,
  purpose: ProductSurfaceRateLimitPurpose,
): ProductSurfaceRateLimiter {
  return createRedisProductSurfaceRateLimitStore({
    redisUrl: 'redis://127.0.0.1:6379',
    environment: ENVIRONMENT,
    keySecret: KEY_SECRET,
    purpose,
    keyPrefix: `known-${purpose}`,
    maxRequests: MAX,
    windowMs: WINDOW_MS,
    commandTimeoutMs: 75,
    connectTimeoutMs: 1000,
    maxRetriesPerRequest: 1,
    createClient: (_url: string, _options: RateLimitRedisClientOptions) => fake,
    now: () => NOW_MS,
  });
}

test('follow and feed purposes HMAC distinct keys and never interpolate the raw subject', async () => {
  const followFake = new FakeRateLimitClient();
  const feedFake = new FakeRateLimitClient();
  const follow = makeStore(followFake, 'follow');
  const feed = makeStore(feedFake, 'feed');
  const allowed = await follow.consume(SUBJECT);
  assert.equal(allowed.kind, 'allowed');
  const evalsha = followFake.calls.find((call) => call.kind === 'evalsha');
  assert.ok(evalsha);
  const key = String(evalsha!.args[2]);
  assert.equal(key.includes(SUBJECT), false);
  assert.equal(parseProductSurfaceRateLimitKey(key).kind, 'ok');
  const parsed = parseProductSurfaceRateLimitKey(key);
  assert.equal(parsed.kind, 'ok');
  if (parsed.kind === 'ok') assert.equal(parsed.parts.purpose, 'follow');
  await feed.consume(SUBJECT);
  const feedKey = String(feedFake.calls.find((call) => call.kind === 'evalsha')!.args[2]);
  assert.notEqual(key, feedKey);
  const expectedFollow = buildProductSurfaceRateLimitKey({
    keyPrefix: 'known-follow',
    environment: ENVIRONMENT,
    keySecret: KEY_SECRET,
    purpose: 'follow',
    subject: SUBJECT,
    windowStartEpochMs: Math.floor(NOW_MS / WINDOW_MS) * WINDOW_MS,
  });
  assert.equal(key, expectedFollow);
  await follow.close();
  await feed.close();
});

test('circuit-open Redis outage is failed, never denied', async () => {
  const fake = new FakeRateLimitClient();
  fake.evalshaImpl = async () => {
    throw Object.assign(new Error('ECONNREFUSED'), { name: 'Error' });
  };
  const store = makeStore(fake, 'notification');
  const first = await store.consume(SUBJECT);
  assert.equal(first.kind, 'failed');
  if (first.kind === 'failed') assert.equal(first.failure.class, 'unavailable');
  await store.close();
});

test('all product-route purposes remain sealed, parseable, and counter-isolated', async () => {
  const purposes = [
    'library-order',
    'link-health',
    'classify-inbox',
    'export-job',
    'organize-plan',
    'collection-version',
    'readable-replica',
    'public-object',
    'credits-read',
    'credentials',
    'credential-issuance',
    'automation-token-credential',
    'automation-token-client',
    'favicon-policy',
    'community-vote',
    'community-comment',
    'community-curation',
    'community-public-reads',
  ] as const satisfies readonly ProductSurfaceRateLimitPurpose[];
  const keys = new Set<string>();
  for (const purpose of purposes) {
    const fake = new FakeRateLimitClient();
    const store = makeStore(fake, purpose);
    const outcome = await store.consume(SUBJECT);
    assert.equal(outcome.kind, 'allowed');
    const call = fake.calls.find((candidate) => candidate.kind === 'evalsha');
    assert.ok(call);
    const key = String(call.args[2]);
    assert.equal(key.includes(SUBJECT), false);
    const parsed = parseProductSurfaceRateLimitKey(key);
    assert.equal(parsed.kind, 'ok');
    if (parsed.kind === 'ok') assert.equal(parsed.parts.purpose, purpose);
    assert.equal(keys.has(key), false, `${purpose} unexpectedly shared a counter key`);
    keys.add(key);
    await store.close();
  }
  assert.equal(keys.size, purposes.length);
});
