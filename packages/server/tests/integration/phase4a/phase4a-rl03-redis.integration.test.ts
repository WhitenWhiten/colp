/**
 * P4A-RL03 real-Redis adapter contract (plan §3.6/§4.2.6/§8 RL03).
 *
 * Everything a fake cannot prove (plan §3.6 rule 6): the fixed Lua script's
 * atomic INCR under multi-client concurrency, real PEXPIRE TTLs on first
 * write, TTL NON-refresh under high-frequency hits (plan §4.3 mutation), the
 * server-time window identity, NOSCRIPT recovery after a script-cache flush,
 * and bounded unavailable/timeout failures during a real server stop with
 * recovery (which also reloads the script after the restart).
 *
 * Fixture / isolation (plan §4.1.9/§4.2.6 + RL05 groundwork):
 *  - one dedicated Testcontainers container (`redis:7-alpine`, override
 *    KNOW_REDIS_IMAGE); a failed start/stop/restart is an ENVIRONMENT failure
 *    that throws — never a skip;
 *  - the container keeps a daemonized redis-server under a keep-alive shell so
 *    the outage test can stop/restart the SERVER process without dropping the
 *    published port mapping;
 *  - every test uses the production adapter + production key codec under a
 *    random run prefix; cleanup force-expires exactly this run's known keys
 *    (built from the server-reported window start) — FLUSHALL/FLUSHDB are
 *    never used and SCAN/KEYS are never an application algorithm;
 *  - barriers (StartGate) and polling (waitUntil) are the synchronization
 *    primitives; TTL assertions use loose ranges (plan §4.2.5).
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, test } from 'vitest';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import {
  RATE_LIMIT_LUA_SCRIPT,
  createRedisRateLimitStore,
} from '../../../src/infrastructure/rate-limit/index.js';
import {
  buildAttachmentRateLimitKey,
  parseAttachmentRateLimitKey,
  rateLimitSubjectHmac,
  type AttachmentRateLimitConfig,
  type AttachmentRateLimitDecision,
  type AttachmentRateLimitRouteClass,
  type RateLimitStore,
  type RateLimitStoreOutcome,
  type RateLimitSubject,
} from '../../../src/modules/attachments/index.js';
import { StartGate, waitUntil } from '../../support/redis-runtime-test-helpers.js';
import { waitForRealTime } from '../../support/async-test-helpers.js';

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
    keySecretRef: 'known/rl03/test/hmac',
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

/** Route budgets helper: only the issue budget changes per test. */
function issueRoutes(issue: { readonly rateMax: number; readonly rateWindowMs: number }): AttachmentRateLimitConfig['routes'] {
  return Object.freeze({
    issue: Object.freeze(issue),
    complete: Object.freeze({ rateMax: 60, rateWindowMs: 60000 }),
    download: Object.freeze({ rateMax: 30, rateWindowMs: 60000 }),
    status: Object.freeze({ rateMax: 60, rateWindowMs: 60000 }),
  });
}

function makeStore(overrides: Partial<AttachmentRateLimitConfig> = {}): RateLimitStore {
  const store = createRedisRateLimitStore({
    config: makeConfig(overrides),
    environment: ENVIRONMENT,
    keySecret,
  });
  stores.push(store);
  return store;
}

/**
 * Store with the connection READY (health barrier, §8 RL06-style): the
 * client is lazy-connect + offline-queue-off by design (commands issued
 * before `ready` fail fast as `unavailable`), so every test synchronizes on
 * readiness before its first check instead of racing the initial connect.
 */
async function makeHealthyStore(overrides: Partial<AttachmentRateLimitConfig> = {}): Promise<RateLimitStore> {
  const store = makeStore(overrides);
  await waitUntil(() => store.readiness().status === 'healthy', 15_000, 'store connection ready', 25);
  return store;
}

function subject(seed: string = randomUUID()): RateLimitSubject {
  return { principalId: `principal-${seed}`, scope: `collection-${seed}` };
}

/** The EXACT counter key the script uses: prefix + server-derived window. */
function counterKey(
  routeClass: AttachmentRateLimitRouteClass,
  subjectValue: RateLimitSubject,
  windowStartEpochMs: number,
): string {
  return buildAttachmentRateLimitKey({
    keyPrefix: runPrefix,
    environment: ENVIRONMENT,
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
): RateLimitStoreOutcome {
  if (outcome.kind === 'allowed' || outcome.kind === 'denied') {
    trackedKeys.add(counterKey(routeClass, subjectValue, outcome.decision.windowStartEpochMs));
  }
  return outcome;
}

/**
 * Sums the server-side counters of EVERY counter key this run created for the
 * subject (window-straddling runs legitimately spread attempts across two
 * counter keys: the Lua window identity is server time, so a run that starts
 * near a window boundary splits its attempts; the SUM is the exact attempt
 * count in every case).
 */
async function sumSubjectCounters(subjectValue: RateLimitSubject): Promise<number> {
  const hmac = rateLimitSubjectHmac(keySecret, subjectValue);
  let total = 0;
  for (const key of trackedKeys) {
    const parsed = parseAttachmentRateLimitKey(key);
    if (parsed.kind === 'ok' && parsed.parts.subjectHmac === hmac) {
      total += Number((await raw!.get(key)) ?? '0');
    }
  }
  return total;
}

async function check(
  store: RateLimitStore,
  routeClass: AttachmentRateLimitRouteClass,
  subjectValue: RateLimitSubject,
): Promise<RateLimitStoreOutcome> {
  return track(await store.check({ routeClass, subject: subjectValue }), routeClass, subjectValue);
}

describe('P4A-RL03 Redis admission adapter against real Redis', () => {
  beforeAll(async () => {
    let started: StartedTestContainer;
    try {
      started = await new GenericContainer(REDIS_IMAGE)
        .withExposedPorts(6379)
        // Daemonized redis under a keep-alive shell: the outage test stops and
        // restarts the redis-server PROCESS inside this container, keeping the
        // published port mapping intact on every Docker runtime.
        .withCommand(['sh', '-c', 'redis-server --daemonize yes; while true; do sleep 3600; done'])
        .withStartupTimeout(120_000)
        .start();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `P4A-RL03 fail-closed: could not start a dedicated Redis container (image ${REDIS_IMAGE}). ` +
          `The real-Redis rate-limit contract suite requires Docker/Testcontainers and never reuses ` +
          `a developer's Redis: ${detail}`,
      );
    }
    container = started;
    redisUrl = `redis://127.0.0.1:${started.getMappedPort(6379)}`;
    runPrefix = `rl03-${randomUUID()}`;
    keySecret = Buffer.from(`rl03-run-secret-${randomUUID()}`, 'utf8');
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
          console.warn(`[rl03] best-effort exact-key cleanup failed for ${key}: ${String(error)}`);
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
      throw new Error(`P4A-RL03 cleanup failed: ${errors.map((error) => String(error)).join(' | ')}`);
    }
  }, 60_000);

  test('first check sets the counter key with a real TTL and reports the fixed-window shape', async () => {
    const store = await makeHealthyStore();
    const owner = subject('first');
    const first = await check(store, 'issue', owner);
    assert.equal(first.kind, 'allowed');
    if (first.kind !== 'allowed') return;
    assert.equal(first.decision.allowed, true);
    assert.equal(first.decision.remaining, 29, 'remaining starts at rateMax - 1');
    assert.ok(
      first.decision.retryAfterSeconds >= 1 && first.decision.retryAfterSeconds <= 60,
      `retry-after is the seconds-to-rollover (${first.decision.retryAfterSeconds})`,
    );
    assert.equal(first.decision.windowStartEpochMs % 60000, 0, 'the window start is floor-aligned');

    const key = counterKey('issue', owner, first.decision.windowStartEpochMs);
    assert.equal(await raw!.get(key), '1', 'the counter key holds the first hit');
    // Loose TTL bounds only (plan §4.2.5): exists, within the window.
    const pttl = await raw!.pttl(key);
    assert.ok(pttl > 0 && pttl <= 60000 + 500, `first-call PEXPIRE within bounds (${pttl}ms)`);

    const second = await check(store, 'issue', owner);
    assert.equal(second.kind, 'allowed');
    if (second.kind === 'allowed') assert.equal(second.decision.remaining, 28);
    assert.equal(await raw!.get(key), '2', 'a second hit increments the same window counter');

    // plan §4.1.11: the key text carries only the HMAC subject segment.
    assert.equal(key.includes(owner.principalId), false, 'no raw principal in the key');
    assert.equal(key.includes(owner.scope), false, 'no raw scope in the key');
    assert.equal(key.includes(keySecret.toString('utf8')), false, 'no secret text in the key');
  });

  test('quota exhausts exactly at rateMax; the denial is a quota DECISION with retry-after (429 fact)', async () => {
    const store = await makeHealthyStore({ routes: issueRoutes({ rateMax: 3, rateWindowMs: 60000 }) });
    const owner = subject('exhaust');
    let allowed = 0;
    let denied = 0;
    let deniedDecision: AttachmentRateLimitDecision | undefined;
    for (let i = 0; i < 5; i += 1) {
      const outcome = await check(store, 'issue', owner);
      if (outcome.kind === 'allowed') allowed += 1;
      else if (outcome.kind === 'denied') {
        denied += 1;
        deniedDecision ??= outcome.decision;
      } else {
        assert.fail(`unexpected failure outcome during quota tests: ${outcome.failure.code}`);
      }
    }
    assert.equal(allowed, 3, 'exactly rateMax allowed');
    assert.equal(denied, 2, 'the remaining attempts are denied decisions');
    assert.ok(deniedDecision, 'a denied decision must exist');
    assert.equal(deniedDecision.allowed, false);
    assert.equal(deniedDecision.remaining, 0);
    assert.ok(
      deniedDecision.retryAfterSeconds >= 1 && deniedDecision.retryAfterSeconds <= 60,
      `the denied decision carries a real retry-after (${deniedDecision.retryAfterSeconds})`,
    );
    const key = counterKey('issue', owner, deniedDecision.windowStartEpochMs);
    // The counter counts EVERY attempt (3 allowed + 2 denied = 5), not just
    // the allowed ones: denied checks still INCR before the comparison.
    assert.equal(await sumSubjectCounters(owner), 5, 'the server-side counter counts all five attempts');
    assert.ok((await raw!.pttl(key)) > 0, 'the exhausted window still carries its TTL');
  });

  test('high-frequency hits never refresh the fixed-window TTL (plan §4.3 mutation)', async () => {
    const store = await makeHealthyStore({ routes: issueRoutes({ rateMax: 100, rateWindowMs: 2000 }) });
    const owner = subject('ttl');
    const first = await check(store, 'issue', owner);
    assert.equal(first.kind, 'allowed');
    if (first.kind !== 'allowed') return;
    const key = counterKey('issue', owner, first.decision.windowStartEpochMs);

    const pttls: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      const outcome = await check(store, 'issue', owner);
      assert.equal(outcome.kind, 'allowed', 'rateMax 100 never denies seven hits');
      pttls.push(await raw!.pttl(key));
      await waitForRealTime(40, 'observe the real Redis PTTL count down between high-frequency hits');
    }
    for (let i = 1; i < pttls.length; i += 1) {
      assert.ok(
        pttls[i]! < pttls[i - 1]!,
        `the TTL must count down, never refresh (${pttls[i - 1]} -> ${pttls[i]}); ` +
          'a per-INCR PEXPIRE would reset it to ~2000ms (plan §4.3 mutation)',
      );
    }
    assert.ok(
      pttls[pttls.length - 1]! < 2000 - 120,
      `after ~250ms of hits the TTL is far below the window (${pttls[pttls.length - 1]}ms)`,
    );
    // The SUM across every counter key this subject touched equals the seven
    // attempts (a run that starts near the 2s server-time window boundary
    // legitimately splits attempts across two counter keys).
    assert.equal(await sumSubjectCounters(owner), 7, 'all seven hits share one atomic counter');
  });

  test('a spent window denies until the server-time window rolls over, then starts fresh', async () => {
    const store = await makeHealthyStore({ routes: issueRoutes({ rateMax: 2, rateWindowMs: 700 }) });
    const owner = subject('roll');
    const first = await check(store, 'issue', owner);
    assert.equal(first.kind, 'allowed');
    if (first.kind !== 'allowed') return;
    const window0 = first.decision.windowStartEpochMs;
    assert.equal((await check(store, 'issue', owner)).kind, 'allowed', 'the second hit is still allowed');

    let sawDeniedInWindow = false;
    let recoveredWindowStart = 0;
    await waitUntil(async () => {
      const outcome = await check(store, 'issue', owner);
      if (outcome.kind === 'denied') {
        sawDeniedInWindow = true;
        return false;
      }
      if (outcome.kind === 'allowed') {
        recoveredWindowStart = outcome.decision.windowStartEpochMs;
        return recoveredWindowStart > window0;
      }
      return false;
    }, 10_000, 'denials inside the spent window, then recovery in the next window', 25);
    assert.equal(sawDeniedInWindow, true, 'the spent window must deny further hits');
    // The recovery is observed on the 700ms server-time grid. Normally the
    // first check of the next window sees a fresh counter (w0 + 700); a check
    // whose INCR executed server-side but whose reply was lost (timeout /
    // dropped connection, plan §4.2.9: each network attempt may count) can
    // consume up to one invisible window before the recovery is observed.
    assert.ok(
      recoveredWindowStart >= window0 + 700 && recoveredWindowStart <= window0 + 1400
        && (recoveredWindowStart - window0) % 700 === 0,
      `the recovery lands on the server-time window grid `
        + `(window0=${window0}, recovered=${recoveredWindowStart})`,
    );
    assert.equal(await raw!.get(counterKey('issue', owner, recoveredWindowStart)), '1', 'a fresh counter');
  });

  test('five independent clients share one atomic quota through the same Redis (barrier)', async () => {
    const clients = Array.from({ length: 5 }, () => makeStore({ routes: issueRoutes({ rateMax: 10, rateWindowMs: 60000 }) }));
    for (const client of clients) {
      await waitUntil(() => client.readiness().status === 'healthy', 10_000, 'client store healthy', 25);
    }
    const owner = subject('concurrent');
    const gate = new StartGate(clients.length);
    const results = await Promise.all(clients.map(async (client) => {
      gate.arrive();
      await gate.waitForGo();
      const local: Array<'allowed' | 'denied'> = [];
      for (let i = 0; i < 3; i += 1) {
        const outcome = await check(client, 'issue', owner);
        if (outcome.kind === 'allowed') local.push('allowed');
        else if (outcome.kind === 'denied') local.push('denied');
        else throw new Error(`concurrent check failed unexpectedly: ${outcome.failure.code}`);
      }
      return local;
    }));
    const flat = results.flat();
    assert.equal(flat.filter((kind) => kind === 'allowed').length, 10, 'exactly rateMax allowed across five clients');
    assert.equal(flat.filter((kind) => kind === 'denied').length, 5, 'the remaining five attempts are denied');

    // Server-side proof: one counter key, exactly fifteen — the Lua INCR
    // runs for EVERY attempt (allowed AND denied), so after 5 clients x 3
    // attempts the counter holds 15 while exactly the 10 first attempts were
    // allowed (plan §4.3 GET/SET mutation control: the INCR never
    // double-spends under concurrency).
    const counterKeys = [...trackedKeys].filter((key) => {
      const parsed = parseAttachmentRateLimitKey(key);
      return parsed.kind === 'ok' && parsed.parts.routeClass === 'issue';
    });
    assert.equal(counterKeys.length, 1, 'all five clients hit exactly one counter key');
    assert.equal(await raw!.get(counterKeys[0]!), '15', 'the shared counter counts every attempt (10 allowed + 5 denied)');
  });

  test('server stop: bounded unavailable/timeout failures (never denied); restart recovers and reloads the script', async () => {
    assert.ok(container, 'container fixture must be running');
    assert.ok(raw, 'raw client fixture must exist');
    const store = await makeHealthyStore();
    const owner = subject('outage');
    const baseline = await check(store, 'issue', owner);
    assert.equal(baseline.kind, 'allowed', 'the store is healthy before the outage');
    assert.equal(store.readiness().status, 'healthy');

    // Real "Redis process completely stopped" outage on the dedicated
    // container only: shutdown the daemonized server process (the keep-alive
    // shell keeps the container and its published port mapping alive).
    const shutdown = await container.exec(['redis-cli', 'shutdown', 'nosave']);
    if (shutdown.exitCode !== 0) {
      throw new Error(`redis-cli shutdown failed (exit ${shutdown.exitCode}): ${shutdown.output}`);
    }
    try {
      await waitUntil(async () => {
        const outcome = await check(store, 'issue', owner);
        return outcome.kind === 'failed';
      }, 10_000, 'commands to fail after the server stops', 50);

      const started = performance.now();
      for (let i = 0; i < 3; i += 1) {
        const outcome = await check(store, 'issue', owner);
        assert.equal(outcome.kind, 'failed', 'outage checks fail; they never decide');
        if (outcome.kind === 'failed') {
          assert.ok(
            outcome.failure.class === 'unavailable' || outcome.failure.class === 'timeout',
            `outage failures classify unavailable|timeout, got ${outcome.failure.class} (plan §4.1.10: never denied)`,
          );
        }
      }
      const elapsed = performance.now() - started;
      assert.ok(elapsed < 9_000, `three outage checks were bounded (${elapsed.toFixed(0)}ms)`);
      assert.equal(store.readiness().status, 'degraded', 'readiness degrades during the outage');
    } finally {
      const restore = await container.exec(['redis-server', '--daemonize', 'yes']);
      if (restore.exitCode !== 0) {
        throw new Error(`redis-server restart failed (exit ${restore.exitCode}): ${restore.output}`);
      }
    }

    // Recovery: probe through the circuit until a check succeeds and readiness
    // recovers. The restart wiped the script cache, so the first probe that
    // reaches Redis exercises the NOSCRIPT reload path end to end.
    let recoveredWindowStart = 0;
    await waitUntil(async () => {
      const outcome = await check(store, 'issue', owner);
      if (outcome.kind !== 'allowed') return false;
      recoveredWindowStart = outcome.decision.windowStartEpochMs;
      return store.readiness().status === 'healthy';
    }, 30_000, 'a probe check succeeds after restart and readiness recovers', 100);
    const sha1 = createHash('sha1').update(RATE_LIMIT_LUA_SCRIPT).digest('hex');
    const exists = await raw.script('EXISTS', sha1);
    assert.deepEqual(exists, [1], 'the restart wiped the script cache; the recovered probe reloaded the frozen script (NOSCRIPT path)');
    // The dedicated container runs bare redis-server with NO persistence and
    // the outage shuts down with `shutdown nosave`: the restart therefore
    // starts with an EMPTY dataset (the baseline counter is gone) and the
    // recovered probe opens a fresh counter at 1 in the same window.
    assert.equal(
      await raw!.get(counterKey('issue', owner, recoveredWindowStart)),
      '1',
      'the restart wiped the dataset (nosave, no persistence): the recovered probe starts a fresh counter',
    );
  }, 90_000);

  test('SCRIPT FLUSH is recovered by one reload and retry of the exact frozen script', async () => {
    const store = await makeHealthyStore();
    const owner = subject('noscript');
    const first = await check(store, 'issue', owner);
    assert.equal(first.kind, 'allowed');
    if (first.kind !== 'allowed') return;

    await raw!.script('FLUSH');
    const second = await check(store, 'issue', owner);
    assert.equal(second.kind, 'allowed', 'the adapter reloads the script and retries exactly once');

    const sha1 = createHash('sha1').update(RATE_LIMIT_LUA_SCRIPT).digest('hex');
    const exists = await raw!.script('EXISTS', sha1);
    assert.deepEqual(exists, [1], 'the exact production script is back in the Redis script cache');

    if (second.kind === 'allowed') {
      const key = counterKey('issue', owner, second.decision.windowStartEpochMs);
      assert.equal(await raw!.get(key), '2', 'both checks share one counter');
    }
  });

  test('every run key is a canonical codec key with no raw identity or secret (plan §4.1.11)', async () => {
    const store = await makeHealthyStore();
    const alice = subject('alice');
    const bob = subject('bob');
    for (const [routeClass, s] of [['issue', alice], ['download', bob], ['issue', bob]] as const) {
      const outcome = await check(store, routeClass, s);
      assert.equal(outcome.kind, 'allowed', `${routeClass} check for a run key must be allowed`);
    }
    const keys = await raw!.keys(`${runPrefix}:*`);
    assert.ok(keys.length >= 3, `the run keys exist under the run prefix (${keys.length} found)`);
    for (const key of keys) {
      const parsed = parseAttachmentRateLimitKey(key);
      assert.equal(parsed.kind, 'ok', `key ${key} must parse with the production normalizer`);
      if (parsed.kind !== 'ok') continue;
      assert.equal(parsed.parts.keyPrefix, runPrefix);
      assert.equal(parsed.parts.environment, ENVIRONMENT);
      assert.equal(parsed.parts.windowStartEpochMs % 60000, 0, 'windows are floor-aligned');
      assert.equal(key.includes('alice'), false, 'no raw principal text in the key');
      assert.equal(key.includes('bob'), false, 'no raw principal text in the key');
      assert.equal(key.includes(keySecret.toString('utf8')), false, 'no secret text in the key');
    }
  });
});
