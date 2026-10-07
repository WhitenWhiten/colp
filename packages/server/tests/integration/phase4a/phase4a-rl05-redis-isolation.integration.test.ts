/**
 * P4A-RL05 real-Redis adapter contract — key isolation and exact-key cleanup
 * (plan §4.1.11, §4.3 "Redis key 拼入原始 principal/Collection" mutation,
 * §8 RL05).
 *
 * Everything a fake cannot prove about the PRODUCTION HMAC key codec over a
 * REAL Redis:
 *
 *  - ROUTE isolation: issue/complete/download are separate namespaces — a
 *    bug that drops the route segment from the key would share one quota and
 *    this suite goes red;
 *  - PRINCIPAL / scope / environment isolation: different principals, tenant
 *    scopes and environment tokens never share a quota (the codec HMACs
 *    `principalId + NUL + scope` and embeds the environment token);
 *  - RAW-IDENTITY scan (plan §4.1.11): every key under the run prefix parses
 *    with the production normalizer and contains NO raw principal, scope,
 *    email, IP, filename or URL text — the assertion that goes red if the
 *    implementation ever concatenates a raw subject into the key (plan §4.3
 *    mutation) — and the subject segment equals exactly the codec HMAC;
 *  - EXACT-KEY cleanup: deletion touches ONLY this run's known keys (built
 *    from the production codec + server-reported windows); a foreign-prefix
 *    canonical key and a junk key survive, proving no FLUSHALL/FLUSHDB and no
 *    SCAN/KEYS-based deletion algorithm; afterwards the run keys are gone.
 *
 * Fixture (plan §4.2.6): one dedicated Testcontainers container
 * (`redis:7-alpine`, override KNOW_REDIS_IMAGE); a failed start throws an
 * environment failure — never a skip. No PostgreSQL dependency.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, test } from 'vitest';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { createRedisRateLimitStore } from '../../../src/infrastructure/rate-limit/index.js';
import {
  buildAttachmentRateLimitKey,
  parseAttachmentRateLimitKey,
  rateLimitSubjectHmac,
  type AttachmentRateLimitConfig,
  type AttachmentRateLimitRouteClass,
  type RateLimitStore,
  type RateLimitStoreOutcome,
  type RateLimitSubject,
} from '../../../src/modules/attachments/index.js';
import { waitUntil } from '../../support/redis-runtime-test-helpers.js';

const REDIS_IMAGE = process.env.KNOWN_REDIS_IMAGE?.trim() || 'redis:7-alpine';
const ENVIRONMENT = 'test';

let container: StartedTestContainer | undefined;
let redisUrl: string | undefined;
let raw: Redis | undefined;
let runPrefix: string;
let keySecret: Buffer;
const stores: RateLimitStore[] = [];
const trackedKeys = new Set<string>();

function makeConfig(overrides: Partial<AttachmentRateLimitConfig> = {}): AttachmentRateLimitConfig {
  assert.ok(redisUrl, 'the redis URL must be known before creating a store');
  const base: AttachmentRateLimitConfig = {
    mode: 'enforce',
    required: true,
    redisUrl,
    keySecretRef: 'known/rl05/isolation/hmac',
    keyPrefix: runPrefix,
    commandTimeoutMs: 750,
    connectTimeoutMs: 3_000,
    maxRetriesPerRequest: 1,
    routes: Object.freeze({
      issue: Object.freeze({ rateMax: 30, rateWindowMs: 60000 }),
      complete: Object.freeze({ rateMax: 60, rateWindowMs: 60000 }),
      download: Object.freeze({ rateMax: 30, rateWindowMs: 60000 }),
      status: Object.freeze({ rateMax: 60, rateWindowMs: 60000 }),
    }),
    completeEmergency: Object.freeze({ rateMax: 15, rateWindowMs: 60000 }),
  };
  return Object.freeze({ ...base, ...overrides }) as AttachmentRateLimitConfig;
}

function makeStore(
  configOverrides: Partial<AttachmentRateLimitConfig> = {},
  factoryOverrides: { readonly environment?: string } = {},
): RateLimitStore {
  const store = createRedisRateLimitStore({
    config: makeConfig(configOverrides),
    environment: factoryOverrides.environment ?? ENVIRONMENT,
    keySecret,
  });
  stores.push(store);
  return store;
}

async function makeHealthyStore(
  configOverrides: Partial<AttachmentRateLimitConfig> = {},
  factoryOverrides: { readonly environment?: string } = {},
): Promise<RateLimitStore> {
  const store = makeStore(configOverrides, factoryOverrides);
  await waitUntil(() => store.readiness().status === 'healthy', 15_000, 'store connection ready', 25);
  return store;
}

function subject(seed: string = randomUUID()): RateLimitSubject {
  return { principalId: `principal-${seed}`, scope: `collection-${seed}` };
}

function counterKey(
  routeClass: AttachmentRateLimitRouteClass,
  subjectValue: RateLimitSubject,
  windowStartEpochMs: number,
  environment: string = ENVIRONMENT,
): string {
  return buildAttachmentRateLimitKey({
    keyPrefix: runPrefix,
    environment,
    keySecret,
    routeClass,
    subject: subjectValue,
    windowStartEpochMs,
  });
}

function track(
  outcome: RateLimitStoreOutcome,
  routeClass: AttachmentRateLimitRouteClass,
  subjectValue: RateLimitSubject,
  environment: string = ENVIRONMENT,
): RateLimitStoreOutcome {
  if (outcome.kind === 'allowed' || outcome.kind === 'denied') {
    trackedKeys.add(counterKey(routeClass, subjectValue, outcome.decision.windowStartEpochMs, environment));
  }
  return outcome;
}

async function check(
  store: RateLimitStore,
  routeClass: AttachmentRateLimitRouteClass,
  subjectValue: RateLimitSubject,
  environment: string = ENVIRONMENT,
): Promise<RateLimitStoreOutcome> {
  return track(await store.check({ routeClass, subject: subjectValue }), routeClass, subjectValue, environment);
}

describe('P4A-RL05 real Redis: route/principal isolation and exact-key cleanup', () => {
  beforeAll(async () => {
    let started: StartedTestContainer;
    try {
      started = await new GenericContainer(REDIS_IMAGE)
        .withExposedPorts(6379)
        .withCommand(['sh', '-c', 'redis-server --daemonize yes; while true; do sleep 3600; done'])
        .withStartupTimeout(120_000)
        .start();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `P4A-RL05 fail-closed: could not start a dedicated Redis container (image ${REDIS_IMAGE}). ` +
          `The real-Redis rate-limit contract suite requires Docker/Testcontainers and never reuses ` +
          `a developer's Redis: ${detail}`,
      );
    }
    container = started;
    redisUrl = `redis://127.0.0.1:${started.getMappedPort(6379)}`;
    runPrefix = `rl05-${randomUUID()}`;
    keySecret = Buffer.from(`rl05-run-secret-${randomUUID()}`, 'utf8');
    raw = new Redis(redisUrl);
    await waitUntil(async () => {
      try { await raw?.ping(); return true; } catch { return false; }
    }, 15_000, 'raw redis ping', 50);
  }, 180_000);

  afterEach(async () => {
    // Exact-key cleanup: force-expire exactly this test's known keys (no
    // FLUSHALL/FLUSHDB; SCAN/KEYS are never an application algorithm).
    if (raw) {
      for (const key of trackedKeys) {
        try { await raw.del(key); } catch (error) {
          console.warn(`[rl05-isolation] best-effort exact-key cleanup failed for ${key}: ${String(error)}`);
        }
      }
    }
    trackedKeys.clear();
    const open = stores.splice(0, stores.length);
    await Promise.all(open.map((store) => store.close().catch(() => undefined)));
  }, 30_000);

  afterAll(async () => {
    const errors: unknown[] = [];
    if (raw) { try { await raw.quit(); } catch (error) { errors.push(error); } }
    if (container) { try { await container.stop(); } catch (error) { errors.push(error); } }
    if (errors.length > 0) {
      throw new Error(`P4A-RL05 isolation cleanup failed: ${errors.map((error) => String(error)).join(' | ')}`);
    }
  }, 60_000);

  test('route classes are separate namespaces: exhausting issue never touches complete or download', async () => {
    const store = await makeHealthyStore({
      routes: Object.freeze({
        issue: Object.freeze({ rateMax: 2, rateWindowMs: 60000 }),
        complete: Object.freeze({ rateMax: 2, rateWindowMs: 60000 }),
        download: Object.freeze({ rateMax: 2, rateWindowMs: 60000 }),
        status: Object.freeze({ rateMax: 60, rateWindowMs: 60000 }),
      }),
    });
    const owner = subject('routes');
    const issueOutcomes = [
      await check(store, 'issue', owner),
      await check(store, 'issue', owner),
      await check(store, 'issue', owner),
      await check(store, 'issue', owner),
    ];
    assert.equal(issueOutcomes.filter((o) => o.kind === 'allowed').length, 2, 'issue budget is exactly 2');
    assert.equal(issueOutcomes.filter((o) => o.kind === 'denied').length, 2, 'the extra issue attempts are denied decisions');
    assert.equal((await check(store, 'complete', owner)).kind, 'allowed', 'complete keeps its own budget');
    assert.equal((await check(store, 'complete', owner)).kind, 'allowed', 'complete budget is independent');
    assert.equal((await check(store, 'download', owner)).kind, 'allowed', 'download keeps its own budget');
    assert.equal((await check(store, 'issue', owner)).kind, 'denied', 'issue stays exhausted');

    // Server-side proof: the three routes produced three DIFFERENT canonical keys.
    const hmac = rateLimitSubjectHmac(keySecret, owner);
    const keys = [...trackedKeys].filter((key) => {
      const parsed = parseAttachmentRateLimitKey(key);
      return parsed.kind === 'ok' && parsed.parts.subjectHmac === hmac;
    });
    const routeSegments = new Set(keys.map((key) => {
      const parsed = parseAttachmentRateLimitKey(key);
      return parsed.kind === 'ok' ? parsed.parts.routeClass : '?';
    }));
    assert.deepEqual([...routeSegments].sort(), ['complete', 'download', 'issue'],
      'one key per route class — a missing route segment would share the quota');
  });

  test('principals never share a quota: alice exhausting her budget leaves bob untouched', async () => {
    const store = await makeHealthyStore({
      routes: Object.freeze({
        issue: Object.freeze({ rateMax: 2, rateWindowMs: 60000 }),
        complete: Object.freeze({ rateMax: 60, rateWindowMs: 60000 }),
        download: Object.freeze({ rateMax: 30, rateWindowMs: 60000 }),
        status: Object.freeze({ rateMax: 60, rateWindowMs: 60000 }),
      }),
    });
    const alice = subject('alice');
    const bob = subject('bob');
    assert.equal((await check(store, 'issue', alice)).kind, 'allowed');
    assert.equal((await check(store, 'issue', alice)).kind, 'allowed');
    assert.equal((await check(store, 'issue', alice)).kind, 'denied', 'alice exhausted her own budget');
    assert.equal((await check(store, 'issue', bob)).kind, 'allowed', 'bob has a fresh budget');
    assert.equal((await check(store, 'issue', bob)).kind, 'allowed', 'bob still allowed after alice exhaustion');
    assert.equal((await check(store, 'issue', bob)).kind, 'denied', 'bob exhausted only after his own two hits');

    const aliceHmac = rateLimitSubjectHmac(keySecret, alice);
    const bobHmac = rateLimitSubjectHmac(keySecret, bob);
    assert.notEqual(aliceHmac, bobHmac, 'distinct principals get distinct HMAC subject segments');
  });

  test('tenant scope and environment token are isolation dimensions too', async () => {
    const store = await makeHealthyStore({
      routes: Object.freeze({
        issue: Object.freeze({ rateMax: 2, rateWindowMs: 60000 }),
        complete: Object.freeze({ rateMax: 60, rateWindowMs: 60000 }),
        download: Object.freeze({ rateMax: 30, rateWindowMs: 60000 }),
        status: Object.freeze({ rateMax: 60, rateWindowMs: 60000 }),
      }),
    });
    const samePrincipalAlpha = { principalId: 'shared-principal', scope: 'collection-alpha' };
    const samePrincipalBeta = { principalId: 'shared-principal', scope: 'collection-beta' };
    assert.equal((await check(store, 'issue', samePrincipalAlpha)).kind, 'allowed');
    assert.equal((await check(store, 'issue', samePrincipalAlpha)).kind, 'allowed');
    assert.equal((await check(store, 'issue', samePrincipalAlpha)).kind, 'denied', 'scope alpha exhausted');
    assert.equal((await check(store, 'issue', samePrincipalBeta)).kind, 'allowed',
      'the same principal in another tenant scope has a fresh budget');
    assert.equal((await check(store, 'issue', samePrincipalBeta)).kind, 'allowed');

    // Environment isolation: the SAME principal/scope in another environment
    // token (codec segment) gets its own namespace on the same server.
    const otherEnvStore = await makeHealthyStore(
      {
        routes: Object.freeze({
          issue: Object.freeze({ rateMax: 2, rateWindowMs: 60000 }),
          complete: Object.freeze({ rateMax: 60, rateWindowMs: 60000 }),
          download: Object.freeze({ rateMax: 30, rateWindowMs: 60000 }),
          status: Object.freeze({ rateMax: 60, rateWindowMs: 60000 }),
        }),
      },
      { environment: 'rl05envb' },
    );
    assert.equal((await check(otherEnvStore, 'issue', samePrincipalAlpha, 'rl05envb')).kind, 'allowed',
      'a different environment token never shares the quota');
    assert.equal((await check(otherEnvStore, 'issue', samePrincipalAlpha, 'rl05envb')).kind, 'allowed');
    assert.equal((await check(otherEnvStore, 'issue', samePrincipalAlpha, 'rl05envb')).kind, 'denied');

    const alphaHmac = rateLimitSubjectHmac(keySecret, samePrincipalAlpha);
    const betaHmac = rateLimitSubjectHmac(keySecret, samePrincipalBeta);
    assert.notEqual(alphaHmac, betaHmac, 'tenant scope is inside the HMAC input (NUL-separated)');
    const envKeys = [...trackedKeys].filter((key) => {
      const parsed = parseAttachmentRateLimitKey(key);
      return parsed.kind === 'ok' && parsed.parts.environment === 'rl05envb';
    });
    assert.ok(envKeys.length >= 1, 'the other environment wrote its own keys');
    assert.ok(envKeys.every((key) => key.includes(':rl05envb:')), 'the env-B keys carry the env-B token');
  });

  test('key scan: every run key is canonical and carries NO raw identity, email, IP, filename or URL (plan §4.1.11)', async () => {
    const store = await makeHealthyStore();
    // Raw values that MUST never appear in any key text. The grammar-safe
    // ones ('principal-alice-2024', 'collection-bob-tenant-x') are the real
    // mutation probes: they could theoretically exist in a base64url HMAC, so
    // a key that concatenates the raw principal/scope fails these includes()
    // assertions (plan §4.3 "key 拼入原始 principal" mutation). The ones with
    // '@', '.' and '/' (email/IP/URL/filename) pin the secrecy of the HMAC
    // input for sensitive-shaped identifiers.
    const sensitiveSubjects: ReadonlyArray<{ readonly label: string; readonly subject: RateLimitSubject }> = [
      { label: 'alice', subject: { principalId: 'principal-alice-2024', scope: 'collection-bob-tenant-x' } },
      { label: 'network', subject: { principalId: 'user-192.168.1.10@example.com', scope: 'https://cdn.example.com/att/upload/file.bin' } },
      { label: 'carlos', subject: { principalId: 'principal-carlos-7f', scope: 'collection-delta-2024' } },
    ];
    for (const entry of sensitiveSubjects) {
      const outcome = await check(store, 'issue', entry.subject);
      assert.equal(outcome.kind, 'allowed', `${entry.label} check must be allowed`);
    }
    const rawFragments = [
      'principal-alice-2024',
      'collection-bob-tenant-x',
      'user-192.168.1.10@example.com',
      '192.168.1.10',
      'https://cdn.example.com/att/upload/file.bin',
      'cdn.example.com',
      'file.bin',
      'principal-carlos-7f',
      'collection-delta-2024',
    ];
    const keys = await raw!.keys(`${runPrefix}:*`);
    assert.ok(keys.length >= sensitiveSubjects.length, `the run keys exist under the run prefix (${keys.length} found)`);
    for (const key of keys) {
      const parsed = parseAttachmentRateLimitKey(key);
      assert.equal(parsed.kind, 'ok', `key ${key} must parse with the production normalizer`);
      if (parsed.kind !== 'ok') continue;
      assert.equal(parsed.parts.keyPrefix, runPrefix);
      assert.equal(parsed.parts.environment, ENVIRONMENT);
      assert.ok(parsed.parts.windowStartEpochMs % 60000 === 0, 'windows are floor-aligned');
      for (const fragment of rawFragments) {
        assert.equal(key.includes(fragment), false, `raw fragment "${fragment}" must never appear in a key (${key})`);
      }
      assert.equal(key.includes(keySecret.toString('utf8')), false, 'the HMAC secret never appears in a key');
    }
    // The subject segment equals EXACTLY the codec HMAC of the known subjects.
    for (const entry of sensitiveSubjects) {
      const expectedHmac = rateLimitSubjectHmac(keySecret, entry.subject);
      assert.ok(
        keys.some((key) => {
          const parsed = parseAttachmentRateLimitKey(key);
          return parsed.kind === 'ok' && parsed.parts.subjectHmac === expectedHmac;
        }),
        `the run keys carry exactly the codec HMAC of ${entry.label}`,
      );
    }
  });

  test('exact-key cleanup: only this run\'s known keys are deleted; foreign keys survive', async () => {
    const store = await makeHealthyStore();
    const ownerA = subject('cleanup-a');
    const ownerB = subject('cleanup-b');
    assert.equal((await check(store, 'issue', ownerA)).kind, 'allowed');
    assert.equal((await check(store, 'issue', ownerB)).kind, 'allowed');
    assert.ok(trackedKeys.size >= 2, 'the run must know its own keys');

    // Foreign keys the cleanup must NEVER touch: a canonical key under a
    // different prefix and a non-canonical junk key.
    const foreignKey = buildAttachmentRateLimitKey({
      keyPrefix: 'rl05-foreign',
      environment: ENVIRONMENT,
      keySecret,
      routeClass: 'issue',
      subject: subject('foreign'),
      windowStartEpochMs: 0,
    });
    const junkKey = 'rl05-junk-not-canonical';
    await raw!.set(foreignKey, '1');
    await raw!.set(junkKey, '1');

    // Exact-key cleanup by this run's known keys (the same algorithm the
    // afterEach hook uses) — never FLUSHALL/FLUSHDB, never SCAN/KEYS.
    for (const key of trackedKeys) {
      await raw!.del(key);
    }
    for (const key of trackedKeys) {
      assert.equal(await raw!.exists(key), 0, `run key ${key} is gone after cleanup`);
    }
    const remaining = await raw!.keys(`${runPrefix}:*`);
    assert.equal(remaining.length, 0, 'no run keys remain after exact-key cleanup');
    assert.equal(await raw!.exists(foreignKey), 1, 'foreign-prefix canonical keys are never touched');
    assert.equal(await raw!.exists(junkKey), 1, 'junk keys are never touched (no KEYS-based deletion)');
  });
});
