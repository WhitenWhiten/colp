/**
 * FIX-M-018 unified MCP rate-limit port contract (request / approval /
 * commit-distinct-plan) over the in-memory adapter AND the Redis adapter
 * over a SCRIPTED fake client (same scope rule as P4A-RL03: "pure unit 可用
 * scripted client 定位错误").
 *
 * The three named policies must NEVER share a counter (三类预算不可互相覆盖);
 * every key is an HMAC over stable principal/client/binding facts (raw
 * facts never reach the key text); the commit policy keeps the distinct-plan
 * semantics (an exact retry of a known plan is free, distinct plans charge
 * slots) and the reply parser pins the frozen wire contract fail-closed.
 *
 * This is NOT a Map/fake substitute for Redis: atomicity, real TTLs, server
 * time and multi-instance sharing are proven by the real Redis suite
 * (tests/integration/phase4a/phase4a-rl06-multi-replica-http-redis.integration.test.ts).
 */
import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { McpAuthenticatedAuthorizationBinding } from '@know-n/colp/mcp';
import {
  MCP_RATE_LIMIT_POLICIES,
  RATE_LIMIT_DISTINCT_LUA_SCRIPT,
  RATE_LIMIT_DISTINCT_LUA_SCRIPT_NAME,
  RATE_LIMIT_DISTINCT_LUA_SCRIPT_VERSION,
  RATE_LIMIT_LUA_SCRIPT,
  buildMcpRateLimitKey,
  createMcpChangePlanRateLimitPort,
  createMemoryMcpRateLimiter,
  createRedisMcpRateLimitStore,
  mcpRateLimitBindingFacts,
  mcpRateLimitSubjectHmac,
  parseMcpRateLimitKey,
  type McpRateLimitOutcome,
  type McpRateLimiter,
  type McpRateLimitPolicyName,
  type McpRateLimitSubject,
  type RateLimitRedisClientLike,
  type RateLimitRedisClientOptions,
} from '../../../src/infrastructure/rate-limit/index.js';

const ENVIRONMENT = 'test';
const KEY_PREFIX = 'mcp-unit';
const KEY_SECRET = Buffer.from('mcp-unit-hmac-secret', 'utf8');
const WINDOW_MS = 60_000;
const NOW_MS = 1_750_000_000_000;
const WINDOW_START = 1_749_999_960_000;

const BINDING: McpAuthenticatedAuthorizationBinding = Object.freeze({
  kind: 'authenticated',
  principalId: 'principal-1',
  clientId: 'client-1',
  credentialBindingId: 'credential-1',
  resourceAudience: 'https://collections.example.test/collections/-/mcp',
  securityEpoch: 'epoch-1',
});

function requestFacts(principal: string, client = 'client-1', credential = 'credential-1', epoch = 'epoch-1'): string {
  return ['authenticated', principal, client, credential,
    'https://collections.example.test/collections/-/mcp', epoch].join(':');
}

function approvalFacts(family: string, principal: string): string {
  return `${family}:principal:${principal}`;
}

function subject(
  policy: McpRateLimitPolicyName,
  facts: string,
  distinct?: string,
): McpRateLimitSubject {
  return distinct === undefined ? { policy, facts } : { policy, facts, distinct };
}

function assertFailed(outcome: McpRateLimitOutcome, failureClass: string, code: string): void {
  assert.equal(outcome.kind, 'failed');
  if (outcome.kind !== 'failed') return;
  assert.equal(outcome.failure.class, failureClass, `expected failure class ${failureClass}`);
  assert.equal(outcome.failure.code, code);
}

interface FakeCall {
  readonly kind: 'script_load' | 'evalsha';
  readonly args: readonly unknown[];
}

/** ReplyError-shaped error like ioredis's redis-errors ReplyError. */
function replyError(message: string): Error {
  const error = new Error(message);
  error.name = 'ReplyError';
  return error;
}

class FakeRateLimitClient implements RateLimitRedisClientLike {
  status = 'ready';
  readonly calls: FakeCall[] = [];
  scriptLoadImpl: (script: string) => Promise<string> = async () => 'a'.repeat(40);
  // Default reply honors the wire invariant remaining = max(0, rateMax - count)
  // so the parser accepts it for any policy budget. The evalsha ARGV layout is
  // [key, rateMax, windowMs, ...distinct] (the key is KEYS[1], never ARGV[0]),
  // so the budget lives at args[1] — same convention as the RL03/auth fakes.
  evalshaImpl: (sha: string, args: readonly (string | number)[]) => Promise<unknown> = async (_sha, args) => {
    const rateMax = Number(args[1]);
    return [1, 1, Math.max(0, rateMax - 1), 60, WINDOW_START];
  };

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
    readonly requestMax?: number;
    readonly approvalMax?: number;
    readonly commitMax?: number;
    readonly now?: () => number;
    readonly failureThreshold?: number;
    readonly cooldownMs?: number;
    readonly onFailure?: (policy: McpRateLimitPolicyName, failure: { class: string; code: string }) => void;
  } = {},
): McpRateLimiter {
  return createRedisMcpRateLimitStore({
    redisUrl: 'redis://127.0.0.1:6379',
    environment: ENVIRONMENT,
    keySecret: KEY_SECRET,
    keyPrefix: KEY_PREFIX,
    request: { maxRequests: overrides.requestMax ?? 3, windowMs: WINDOW_MS },
    approval: { maxRequests: overrides.approvalMax ?? 2, windowMs: WINDOW_MS },
    commit: { maxPlans: overrides.commitMax ?? 2, windowMs: WINDOW_MS },
    commandTimeoutMs: 75,
    connectTimeoutMs: 1000,
    maxRetriesPerRequest: 1,
    createClient: (_url: string, _clientOptions: RateLimitRedisClientOptions) => fake,
    now: overrides.now,
    failureThreshold: overrides.failureThreshold,
    cooldownMs: overrides.cooldownMs,
    onFailure: overrides.onFailure,
  });
}

function expectedKey(policy: McpRateLimitPolicyName, facts: string, windowStartEpochMs: number): string {
  return buildMcpRateLimitKey({
    keyPrefix: KEY_PREFIX,
    environment: ENVIRONMENT,
    keySecret: KEY_SECRET,
    policy,
    facts,
    windowStartEpochMs,
  });
}

// ---------------------------------------------------------------------------
// Key codec: stable principal/client/binding facts, never raw facts in keys
// ---------------------------------------------------------------------------

test('the codec builds canonical per-policy keys whose subject is an HMAC of the facts', () => {
  const facts = requestFacts('principal-1');
  for (const policy of MCP_RATE_LIMIT_POLICIES) {
    const key = buildMcpRateLimitKey({
      keyPrefix: KEY_PREFIX,
      environment: ENVIRONMENT,
      keySecret: KEY_SECRET,
      policy,
      facts,
      windowStartEpochMs: WINDOW_START,
    });
    const parsed = parseMcpRateLimitKey(key);
    assert.equal(parsed.kind, 'ok');
    if (parsed.kind !== 'ok') continue;
    assert.equal(parsed.parts.keyPrefix, KEY_PREFIX);
    assert.equal(parsed.parts.environment, ENVIRONMENT);
    assert.equal(parsed.parts.policy, policy);
    assert.equal(parsed.parts.subjectHmac, mcpRateLimitSubjectHmac(KEY_SECRET, facts));
    assert.equal(parsed.parts.windowStartEpochMs, WINDOW_START);
    // Raw facts (principal/client/credential/audience/epoch) never reach the key text.
    assert.equal(key.includes(facts), false);
    assert.equal(key.includes('principal-1'), false);
    assert.equal(key.includes('client-1'), false);
    assert.equal(key.includes('credential-1'), false);
    assert.equal(key.includes(KEY_SECRET.toString('utf8')), false);
  }
  // The three policies are distinct key namespaces: same facts, three keys.
  const keys = new Set(MCP_RATE_LIMIT_POLICIES.map((policy) => expectedKey(policy, facts, WINDOW_START)));
  assert.equal(keys.size, 3, 'each named policy owns a separate key namespace');
});

test('the codec rejects non-canonical keys, unknown policies and control characters in facts', () => {
  const facts = requestFacts('principal-1');
  const key = expectedKey('request', facts, WINDOW_START);
  assert.equal(parseMcpRateLimitKey(key).kind, 'ok');
  assert.equal(parseMcpRateLimitKey(key.replace('{mcp:', '{att:')).kind, 'rejected', 'wrong hash-tag segment');
  assert.equal(parseMcpRateLimitKey(
    `${KEY_PREFIX}:${ENVIRONMENT}:ratelimit:v1:{mcp:${'a'.repeat(32)}}:admin:${WINDOW_START}`,
  ).kind, 'rejected', 'unknown policy token');
  assert.equal(parseMcpRateLimitKey(
    `${KEY_PREFIX}:${ENVIRONMENT}:ratelimit:v1:{mcp:${facts}}:request:${WINDOW_START}`,
  ).kind, 'rejected', 'raw facts in the subject segment are non-canonical');
  assert.throws(
    () => buildMcpRateLimitKey({
      keyPrefix: KEY_PREFIX,
      environment: ENVIRONMENT,
      keySecret: KEY_SECRET,
      policy: 'admin' as never,
      facts,
      windowStartEpochMs: WINDOW_START,
    }),
    /policy/u,
  );
  assert.throws(
    () => buildMcpRateLimitKey({
      keyPrefix: KEY_PREFIX,
      environment: ENVIRONMENT,
      keySecret: KEY_SECRET,
      policy: 'request',
      facts: 'a\u0000b',
      windowStartEpochMs: WINDOW_START,
    }),
    /control characters/u,
  );
});

test('the binding facts helper is deterministic and covers the stable binding fields', () => {
  assert.equal(
    mcpRateLimitBindingFacts(BINDING),
    'authenticated:principal-1:client-1:credential-1:https://collections.example.test/collections/-/mcp:epoch-1',
  );
  assert.equal(
    mcpRateLimitBindingFacts(Object.freeze({ ...BINDING, principalId: 'principal-2' })),
    'authenticated:principal-2:client-1:credential-1:https://collections.example.test/collections/-/mcp:epoch-1',
  );
});

// ---------------------------------------------------------------------------
// In-memory adapter: three independent policies, commit distinct-plan semantics
// ---------------------------------------------------------------------------

test('memory adapter counts request policy per facts and rolls the window over', async () => {
  let now = NOW_MS;
  const limiter = createMemoryMcpRateLimiter({
    request: { maxRequests: 2, windowMs: WINDOW_MS },
    now: () => now,
  });
  const facts = requestFacts('principal-1');
  assert.equal((await limiter.consume(subject('request', facts))).kind, 'allowed');
  assert.equal((await limiter.consume(subject('request', facts))).kind, 'allowed');
  const denied = await limiter.consume(subject('request', facts));
  assert.equal(denied.kind, 'denied');
  if (denied.kind === 'denied') {
    assert.equal(denied.decision.allowed, false);
    assert.ok(denied.decision.retryAfterSeconds >= 1, 'the denied decision carries the retry-after fact');
  }
  // Window rollover restores the budget.
  now += WINDOW_MS;
  assert.equal((await limiter.consume(subject('request', facts))).kind, 'allowed');
});

test('memory adapter at capacity reclaims expired buckets before the periodic sweep (bounded step)', async () => {
  let now = NOW_MS;
  const maxBuckets = 1_000;
  const limiter = createMemoryMcpRateLimiter({
    request: { maxRequests: 5, windowMs: WINDOW_MS },
    commit: { maxPlans: 5, windowMs: WINDOW_MS },
    now: () => now,
    maxBuckets,
    sweepIntervalMs: 60 * 60 * 1000,
  });
  for (let index = 0; index < maxBuckets; index += 1) {
    assert.equal((await limiter.consume(subject('request', requestFacts(`fill-${index}`)))).kind, 'allowed');
    assert.equal((await limiter.consume(subject('commit-distinct-plan', requestFacts(`fill-${index}`), 'plan-1'))).kind, 'allowed');
  }
  // Saturated and nothing expired: a new key is denied with a forward-looking retry hint.
  const denied = await limiter.consume(subject('request', requestFacts('late-1')));
  assert.equal(denied.kind, 'denied');
  if (denied.kind === 'denied') assert.equal(denied.decision.retryAfterSeconds, WINDOW_MS / 1000);
  assert.equal((await limiter.consume(subject('commit-distinct-plan', requestFacts('late-1'), 'plan-1'))).kind, 'denied');
  // Existing keys keep their budgets while saturated (no eviction).
  assert.equal((await limiter.consume(subject('request', requestFacts('fill-0')))).kind, 'allowed');

  // Windows elapse but the periodic sweep is still far away: new keys must be
  // admitted by reclaiming expired buckets, and far more than the bounded scan
  // limit of new keys must succeed because each admission frees at least one slot.
  now += WINDOW_MS;
  const sizeBefore = limiter.size();
  for (let index = 0; index < 500; index += 1) {
    assert.equal((await limiter.consume(subject('request', requestFacts(`late-${index}`)))).kind, 'allowed', `request key ${index}`);
    assert.equal(
      (await limiter.consume(subject('commit-distinct-plan', requestFacts(`late-${index}`), 'plan-1'))).kind,
      'allowed',
      `commit key ${index}`,
    );
  }
  assert.ok(limiter.size() <= sizeBefore, 'reclaim replaces expired buckets instead of growing past the cap');

  // Another window later every bucket is expired again. Re-admitting all the
  // original keys (half of them via restart-in-place, half via reclaim) must
  // succeed, and a restarted key is re-inserted at the tail so the head of
  // the map keeps holding the oldest windows for later reclaims.
  now += WINDOW_MS;
  for (let index = 0; index < maxBuckets; index += 1) {
    assert.equal((await limiter.consume(subject('request', requestFacts(`fill-${index}`)))).kind, 'allowed', `refill ${index}`);
  }
  now += WINDOW_MS;
  assert.equal((await limiter.consume(subject('request', requestFacts('tail-key')))).kind, 'allowed');
});

test('memory adapter re-inserts a restarted bucket at the tail so the bounded reclaim still finds expired heads', async () => {
  let now = NOW_MS;
  const maxBuckets = 200; // larger than the 64-entry reclaim scan
  const limiter = createMemoryMcpRateLimiter({
    request: { maxRequests: 5, windowMs: WINDOW_MS },
    now: () => now,
    maxBuckets,
    sweepIntervalMs: 60 * 60 * 1000,
  });
  for (let index = 0; index < maxBuckets; index += 1) {
    assert.equal((await limiter.consume(subject('request', requestFacts(`k-${index}`)))).kind, 'allowed');
  }
  now += WINDOW_MS;
  // Restart the first 100 keys in place; without tail re-insertion they would
  // keep the head of the map and hide the 100 expired buckets behind them.
  for (let index = 0; index < 100; index += 1) {
    assert.equal((await limiter.consume(subject('request', requestFacts(`k-${index}`)))).kind, 'allowed');
  }
  assert.equal(limiter.size(), maxBuckets);
  assert.equal((await limiter.consume(subject('request', requestFacts('fresh')))).kind, 'allowed');
  assert.ok(limiter.size() <= maxBuckets, 'the admitted key replaced expired buckets instead of growing past the cap');
});

test('memory adapter keeps the three named policies fully isolated (no shared counter)', async () => {
  const limiter = createMemoryMcpRateLimiter({
    request: { maxRequests: 1, windowMs: WINDOW_MS },
    approval: { maxRequests: 1, windowMs: WINDOW_MS },
    commit: { maxPlans: 1, windowMs: WINDOW_MS },
  });
  const facts = requestFacts('principal-1');
  assert.equal((await limiter.consume(subject('request', facts))).kind, 'allowed');
  assert.equal((await limiter.consume(subject('request', facts))).kind, 'denied', 'request exhausted');
  // The SAME facts string under the approval and commit policies is untouched.
  assert.equal((await limiter.consume(subject('approval', approvalFacts('/api/v1/mcp/approvals', 'principal-1')))).kind, 'allowed');
  assert.equal((await limiter.consume(subject('commit-distinct-plan', facts, 'plan-1'))).kind, 'allowed');
  // Exhausting approval does not touch commit, and vice versa.
  assert.equal((await limiter.consume(subject('approval', approvalFacts('/api/v1/mcp/approvals', 'principal-1')))).kind, 'denied');
  assert.equal((await limiter.consume(subject('commit-distinct-plan', facts, 'plan-2'))).kind, 'denied', 'commit distinct-plan exhausted');
});

test('memory adapter commit policy: exact replay is free, distinct plans charge slots, window rollover resets', async () => {
  let now = NOW_MS;
  const limiter = createMemoryMcpRateLimiter({
    commit: { maxPlans: 2, windowMs: WINDOW_MS },
    now: () => now,
  });
  const facts = mcpRateLimitBindingFacts(BINDING);
  assert.equal((await limiter.consume(subject('commit-distinct-plan', facts, 'plan-1'))).kind, 'allowed');
  assert.equal((await limiter.consume(subject('commit-distinct-plan', facts, 'plan-1'))).kind, 'allowed', 'MRTR retry is free');
  assert.equal((await limiter.consume(subject('commit-distinct-plan', facts, 'plan-2'))).kind, 'allowed');
  assert.equal((await limiter.consume(subject('commit-distinct-plan', facts, 'plan-3'))).kind, 'denied', 'third distinct plan is charged');
  assert.equal((await limiter.consume(subject('commit-distinct-plan', facts, 'plan-1'))).kind, 'allowed', 'a known plan stays free even when full');
  // A different binding owns its own budget.
  assert.equal((await limiter.consume(subject('commit-distinct-plan',
    mcpRateLimitBindingFacts(Object.freeze({ ...BINDING, principalId: 'principal-2' })), 'plan-3'))).kind, 'allowed');
  now += WINDOW_MS;
  assert.equal((await limiter.consume(subject('commit-distinct-plan', facts, 'plan-3'))).kind, 'allowed', 'new window restores the budget');
});

test('memory adapter fails closed on unconfigured policies and invalid subjects; reset clears buckets', async () => {
  const limiter = createMemoryMcpRateLimiter({ request: { maxRequests: 1, windowMs: WINDOW_MS } });
  assertFailed(
    await limiter.consume(subject('approval', approvalFacts('/api/v1/mcp/approvals', 'principal-1'))),
    'internal',
    'rate_limit_policy_unconfigured',
  );
  assertFailed(
    await limiter.consume(subject('commit-distinct-plan', mcpRateLimitBindingFacts(BINDING), 'plan-1')),
    'internal',
    'rate_limit_policy_unconfigured',
  );
  assertFailed(await limiter.consume(subject('request', 'a\u0000b')), 'internal', 'rate_limit_invalid_input');
  assertFailed(await limiter.consume(subject('request', '')), 'internal', 'rate_limit_invalid_input');

  const facts = requestFacts('principal-1');
  assert.equal((await limiter.consume(subject('request', facts))).kind, 'allowed');
  assert.equal((await limiter.consume(subject('request', facts))).kind, 'denied');
  limiter.reset();
  assert.equal((await limiter.consume(subject('request', facts))).kind, 'allowed', 'reset restores the budget');
  assert.equal(limiter.size(), 1, 'one live bucket after reset + one consume');
});

test('memory adapter factories reject unbounded or invalid budgets', () => {
  assert.throws(
    () => createMemoryMcpRateLimiter({ request: { maxRequests: 0, windowMs: WINDOW_MS } }),
    /positive safe integer/u,
  );
  assert.throws(
    () => createMemoryMcpRateLimiter({ request: { maxRequests: 10_001, windowMs: WINDOW_MS } }),
    /must be <= 10000/u,
  );
  assert.throws(
    () => createMemoryMcpRateLimiter({ approval: { maxRequests: 1, windowMs: 3_600_001 } }),
    /windowMs must be <= 3600000/u,
  );
  assert.throws(
    () => createMemoryMcpRateLimiter({ commit: { maxPlans: 0, windowMs: WINDOW_MS } }),
    /positive safe integer/u,
  );
  assert.throws(
    () => createMcpChangePlanRateLimitPort({ maxPlans: 10_001, windowMs: WINDOW_MS }),
    /maxPlans must be <= 10000/u,
  );
});

// ---------------------------------------------------------------------------
// Redis adapter: frozen scripts, codec keys, stable failure classification
// ---------------------------------------------------------------------------

test('the Redis adapter loads the frozen counter script for request/approval and the frozen distinct script for commit', async () => {
  const fake = new FakeRateLimitClient();
  const store = makeRedisStore(fake, { now: () => NOW_MS });
  const facts = requestFacts('principal-1');

  const requestOutcome = await store.consume(subject('request', facts));
  assert.equal(requestOutcome.kind, 'allowed');
  if (requestOutcome.kind !== 'allowed') return;
  assert.deepEqual(requestOutcome.decision, { allowed: true, retryAfterSeconds: 60 });

  assert.equal(fake.calls.length, 2, 'one script load + one evalsha');
  assert.equal(fake.calls[0]?.kind, 'script_load');
  assert.equal(fake.calls[0]?.args[1], RATE_LIMIT_LUA_SCRIPT, 'the EXACT frozen counter script is what gets loaded');
  const requestEvalsha = fake.calls[1]?.args as readonly unknown[];
  assert.equal(requestEvalsha[1], 1, 'one KEYS slot');
  assert.equal(requestEvalsha[2], expectedKey('request', facts, WINDOW_START), 'the store consumes the codec key');
  assert.deepEqual(requestEvalsha.slice(3), [3, WINDOW_MS], 'counter script receives maxRequests + windowMs');

  const commitOutcome = await store.consume(subject('commit-distinct-plan', mcpRateLimitBindingFacts(BINDING), 'plan-1'));
  assert.equal(commitOutcome.kind, 'allowed');
  const commitLoad = fake.calls.find((call) => call.kind === 'script_load' && call.args[1] === RATE_LIMIT_DISTINCT_LUA_SCRIPT);
  assert.ok(commitLoad, 'the commit policy loads the frozen distinct script');
  const commitEvalsha = fake.calls.filter((call) => call.kind === 'evalsha').at(-1)?.args as readonly unknown[];
  assert.equal(commitEvalsha[2], expectedKey('commit-distinct-plan', mcpRateLimitBindingFacts(BINDING), WINDOW_START));
  assert.deepEqual(commitEvalsha.slice(3), [2, WINDOW_MS, 'plan-1'], 'the distinct script receives maxPlans + windowMs + the planId as ARGV[3]');
  assert.equal(String(commitEvalsha[2]).includes('plan-1'), false, 'the planId never enters the key text');
});

test('a denied script reply becomes a denied DECISION (quota fact), never a failure class', async () => {
  const fake = new FakeRateLimitClient();
  fake.evalshaImpl = async () => [0, 3, 0, 30, WINDOW_START];
  const store = makeRedisStore(fake, { now: () => NOW_MS });
  const outcome = await store.consume(subject('request', requestFacts('principal-1')));
  assert.equal(outcome.kind, 'denied');
  if (outcome.kind !== 'denied') return;
  assert.equal(outcome.decision.allowed, false);
  assert.equal(outcome.decision.retryAfterSeconds, 30);
});

test('the Redis adapter reports sanitized failure metrics with sealed policy + class labels only', async () => {
  const fake = new FakeRateLimitClient();
  fake.evalshaImpl = async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:6379'); };
  const failures: Array<{ policy: McpRateLimitPolicyName; failureClass: string; code: string }> = [];
  const store = makeRedisStore(fake, {
    now: () => NOW_MS,
    onFailure: (policy, failure) => failures.push({ policy, failureClass: failure.class, code: failure.code }),
  });
  const outcome = await store.consume(subject('request', requestFacts('principal-1')));
  assertFailed(outcome, 'unavailable', 'rate_limit_unavailable');
  assert.deepEqual(failures, [
    { policy: 'request', failureClass: 'unavailable', code: 'rate_limit_unavailable' },
  ], 'the failure metric carries ONLY sealed policy/class/code labels — never facts or keys');
});

test('a malformed script reply is classified malformed and opens the circuit fast-fail', async () => {
  const fake = new FakeRateLimitClient();
  fake.evalshaImpl = async () => [1, 5];
  const store = makeRedisStore(fake, { now: () => NOW_MS, failureThreshold: 1 });
  const first = await store.consume(subject('request', requestFacts('principal-1')));
  assertFailed(first, 'malformed', 'rate_limit_malformed_reply');
  const second = await store.consume(subject('request', requestFacts('principal-1')));
  assertFailed(second, 'unavailable', 'rate_limit_circuit_open');
  assert.equal(fake.calls.filter((call) => call.kind === 'evalsha').length, 1, 'no command reaches the client while open');
});

test('NOSCRIPT reloads the script once and retries exactly once', async () => {
  const fake = new FakeRateLimitClient();
  let noscriptRemaining = 1;
  fake.evalshaImpl = async () => {
    if (noscriptRemaining > 0) {
      noscriptRemaining -= 1;
      throw replyError('NOSCRIPT No matching script. Please use EVAL.');
    }
    return [1, 1, 1, 60, WINDOW_START];
  };
  const store = makeRedisStore(fake, { now: () => NOW_MS });
  const outcome = await store.consume(subject('approval', approvalFacts('/api/v1/mcp/approvals', 'principal-1')));
  assert.equal(outcome.kind, 'allowed', 'the NOSCRIPT recovery retries and succeeds');
  assert.deepEqual(
    fake.calls.map((call) => call.kind),
    ['script_load', 'evalsha', 'script_load', 'evalsha'],
    'reload happens exactly once between the two evalsha attempts',
  );
});

test('timeout, disconnect, ACL and max-retries map to stable failure classes; an outage is never a denial', async () => {
  const cases: Array<{ error: () => Error; failureClass: string; code: string }> = [
    { error: () => new Error('Connection is closed.'), failureClass: 'unavailable', code: 'rate_limit_unavailable' },
    { error: () => replyError('NOAUTH Authentication required.'), failureClass: 'acl', code: 'rate_limit_acl_denied' },
    { error: () => Object.assign(new Error('Reconnecting 0 times'), { name: 'MaxRetriesPerRequestError' }), failureClass: 'unavailable', code: 'rate_limit_max_retries_exhausted' },
    { error: () => replyError('ERR RATE_LIMIT_KEY_MALFORMED'), failureClass: 'malformed', code: 'rate_limit_key_malformed' },
    { error: () => replyError('ERR unknown command'), failureClass: 'internal', code: 'rate_limit_redis_error' },
    { error: () => new Error('Command timed out'), failureClass: 'timeout', code: 'rate_limit_command_timeout' },
  ];
  for (const { error, failureClass, code } of cases) {
    const fake = new FakeRateLimitClient();
    fake.evalshaImpl = async () => { throw error(); };
    const store = makeRedisStore(fake, { now: () => NOW_MS });
    const outcome = await store.consume(subject('request', requestFacts('principal-1')));
    assertFailed(outcome, failureClass, code);
  }
});

test('a hung command fails with the timeout class within the bounded command timeout', async () => {
  const fake = new FakeRateLimitClient();
  fake.evalshaImpl = async () => new Promise<never>(() => { /* never settles */ });
  const store = makeRedisStore(fake, { now: () => NOW_MS });
  const started = performance.now();
  const outcome = await store.consume(subject('commit-distinct-plan', mcpRateLimitBindingFacts(BINDING), 'plan-1'));
  const elapsed = performance.now() - started;
  assertFailed(outcome, 'timeout', 'rate_limit_command_timeout');
  assert.ok(elapsed < 2_000, `the timeout race bounds the command (${elapsed.toFixed(0)}ms)`);
});

test('invalid policy/facts/distinct input is an internal failure and never issues a Redis command', async () => {
  const fake = new FakeRateLimitClient();
  const store = makeRedisStore(fake, { now: () => NOW_MS });
  assertFailed(await store.consume(subject('admin' as never, requestFacts('principal-1'))), 'internal', 'rate_limit_invalid_input');
  assertFailed(await store.consume(subject('request', 'a\u0000b')), 'internal', 'rate_limit_invalid_input');
  assertFailed(await store.consume(subject('request', '')), 'internal', 'rate_limit_invalid_input');
  assertFailed(
    await store.consume(subject('commit-distinct-plan', mcpRateLimitBindingFacts(BINDING), '')),
    'internal',
    'rate_limit_invalid_input',
  );
  assertFailed(
    await store.consume(subject('commit-distinct-plan', mcpRateLimitBindingFacts(BINDING), 'a\u0000b')),
    'internal',
    'rate_limit_invalid_input',
  );
  assert.equal(fake.calls.length, 0, 'invalid input never reaches the client');
});

test('a closed store fails fast and close is idempotent; readiness reflects circuit and close', async () => {
  const fake = new FakeRateLimitClient();
  const store = makeRedisStore(fake, { now: () => NOW_MS, failureThreshold: 1 });
  await store.consume(subject('request', requestFacts('principal-1')));
  assert.deepEqual(
    { status: store.readiness().status, reason: store.readiness().reason },
    { status: 'healthy', reason: 'none' },
  );

  fake.evalshaImpl = async () => { throw new Error('Connection is closed.'); };
  await store.consume(subject('request', requestFacts('principal-1')));
  assert.equal(store.readiness().status, 'degraded');
  assert.equal(store.readiness().reason, 'last_command_failed');

  await store.close();
  await store.close();
  assertFailed(await store.consume(subject('request', requestFacts('principal-1'))), 'unavailable', 'rate_limit_store_closed');
  assert.equal(store.readiness().status, 'degraded');
  assert.equal(store.readiness().reason, 'closed');
  assert.equal(fake.calls.filter((call) => call.kind === 'evalsha').length, 2, 'no command after close');
});

test('the Redis factory fails closed on empty secrets, empty environments and invalid budgets', () => {
  assert.throws(
    () => createRedisMcpRateLimitStore({
      redisUrl: 'redis://127.0.0.1:6379',
      environment: ENVIRONMENT,
      keySecret: Buffer.alloc(0),
      keyPrefix: KEY_PREFIX,
      request: { maxRequests: 3, windowMs: WINDOW_MS },
      approval: { maxRequests: 2, windowMs: WINDOW_MS },
      commit: { maxPlans: 2, windowMs: WINDOW_MS },
      commandTimeoutMs: 75,
      connectTimeoutMs: 1000,
      maxRetriesPerRequest: 1,
    }),
    /key secret/i,
  );
  assert.throws(
    () => createRedisMcpRateLimitStore({
      redisUrl: 'redis://127.0.0.1:6379',
      environment: '',
      keySecret: KEY_SECRET,
      keyPrefix: KEY_PREFIX,
      request: { maxRequests: 3, windowMs: WINDOW_MS },
      approval: { maxRequests: 2, windowMs: WINDOW_MS },
      commit: { maxPlans: 2, windowMs: WINDOW_MS },
      commandTimeoutMs: 75,
      connectTimeoutMs: 1000,
      maxRetriesPerRequest: 1,
    }),
    /environment/,
  );
  assert.throws(
    () => createRedisMcpRateLimitStore({
      redisUrl: 'redis://127.0.0.1:6379',
      environment: ENVIRONMENT,
      keySecret: KEY_SECRET,
      keyPrefix: KEY_PREFIX,
      request: { maxRequests: 0, windowMs: WINDOW_MS },
      approval: { maxRequests: 2, windowMs: WINDOW_MS },
      commit: { maxPlans: 2, windowMs: WINDOW_MS },
      commandTimeoutMs: 75,
      connectTimeoutMs: 1000,
      maxRetriesPerRequest: 1,
    }),
    /maxRequests/,
  );
  assert.throws(
    () => createRedisMcpRateLimitStore({
      redisUrl: 'redis://127.0.0.1:6379',
      environment: ENVIRONMENT,
      keySecret: KEY_SECRET,
      keyPrefix: KEY_PREFIX,
      request: { maxRequests: 3, windowMs: WINDOW_MS },
      approval: { maxRequests: 2, windowMs: WINDOW_MS },
      commit: { maxPlans: 0, windowMs: WINDOW_MS },
      commandTimeoutMs: 75,
      connectTimeoutMs: 1000,
      maxRetriesPerRequest: 1,
    }),
    /maxPlans/,
  );
});

// ---------------------------------------------------------------------------
// Frozen distinct-plan Lua script contract
// ---------------------------------------------------------------------------

test('the distinct script is a frozen, versioned constant with set-based distinct-plan semantics', () => {
  assert.equal(RATE_LIMIT_DISTINCT_LUA_SCRIPT_VERSION, 1);
  assert.equal(RATE_LIMIT_DISTINCT_LUA_SCRIPT_NAME, 'rate_limit_distinct_window_v1');
  assert.equal(typeof RATE_LIMIT_DISTINCT_LUA_SCRIPT, 'string');
  assert.ok(RATE_LIMIT_DISTINCT_LUA_SCRIPT.length > 300, 'the script carries the full distinct-plan semantics');
  assert.equal(RATE_LIMIT_DISTINCT_LUA_SCRIPT.includes('${'), false, 'the script text must be a plain constant');
  assert.ok(RATE_LIMIT_DISTINCT_LUA_SCRIPT.includes("redis.call('time')"), 'server-time window identity');
  assert.ok(RATE_LIMIT_DISTINCT_LUA_SCRIPT.includes("redis.call('sadd'"), 'SADD adds the distinct element once');
  assert.ok(RATE_LIMIT_DISTINCT_LUA_SCRIPT.includes("redis.call('scard'"), 'SCARD counts DISTINCT elements');
  assert.ok(RATE_LIMIT_DISTINCT_LUA_SCRIPT.includes("redis.call('pexpire'"), 'the window TTL is set');
  assert.ok(
    /if created == 0 then[\s\S]*redis\.call\('pexpire'/u.test(RATE_LIMIT_DISTINCT_LUA_SCRIPT),
    'PEXPIRE must run only on the FIRST write of a window',
  );
  assert.equal(RATE_LIMIT_DISTINCT_LUA_SCRIPT.includes("redis.call('incr'"), false, 'the distinct script never INCRs');
});
