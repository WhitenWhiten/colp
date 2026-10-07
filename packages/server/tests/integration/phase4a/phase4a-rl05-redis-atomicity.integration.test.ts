/**
 * P4A-RL05 real-Redis adapter contract — atomicity / server time / TTL
 * (plan §3.6, §4.2.5, §4.3, §8 RL05).
 *
 * Everything a fake cannot prove (plan §3.6 rule 6) about the FROZEN Lua
 * fixed-window script (rate-limit-lua.ts):
 *
 *  - MULTI-CLIENT ATOMICITY (plan §4.3 "Redis Lua 改为应用 GET/SET" mutation):
 *    N=40 independent production stores (each with its own ioredis connection,
 *    circuit breaker and codec key — no pipeline, no shared client, no fake,
 *    no sequential Promise, no final-counter-only check) race the SAME
 *    server-time window behind a start gate. The assertions that go red under
 *    a GET/SET implementation are (a) the allowed total EXACTLY equals the
 *    budget, (b) every other attempt is a denied DECISION (429 fact, never a
 *    failure), and (c) the single shared counter holds EXACTLY the total
 *    attempt count — a lost update breaks (a) or (c) with practical certainty;
 *  - WINDOW ROLLOVER: a spent window denies until the SERVER-time window
 *    rolls, then the next window starts fresh on the same grid;
 *  - SERVER TIME identity (plan §2.3): the window is floor-aligned to Redis
 *    server time, never host time; a deliberately SKEWED host clock (the
 *    documented `now` injection seam) changes neither the window identity nor
 *    the written key — the host-time seed is replaced inside the script;
 *  - TTL (plan §4.3 "Redis 每次 INCR 都刷新 TTL" mutation): the first write of
 *    a window sets PEXPIRE (exists, loose range §4.2.5) and high-frequency
 *    hits NEVER extend it — the strictly-decreasing PTTL sequence is the
 *    assertion that goes red if every INCR refreshed the TTL.
 *
 * Fixture / isolation (plan §4.2.6): one dedicated Testcontainers container
 * (`redis:7-alpine`, override KNOW_REDIS_IMAGE); a failed start is an
 * ENVIRONMENT failure that throws — never a skip. Every key comes from the
 * production key codec under a random run prefix; cleanup force-expires
 * exactly this run's known keys (no FLUSHALL/FLUSHDB; SCAN/KEYS are never an
 * application algorithm). Barriers (StartGate) and polling (waitUntil /
 * server-time headroom) are the only synchronization primitives.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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
    keySecretRef: 'known/rl05/atomicity/hmac',
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

/** Only the issue budget changes per test; the other routes stay fixed. */
function issueRoutes(issue: { readonly rateMax: number; readonly rateWindowMs: number }): AttachmentRateLimitConfig['routes'] {
  return Object.freeze({
    issue: Object.freeze(issue),
    complete: Object.freeze({ rateMax: 60, rateWindowMs: 60000 }),
    download: Object.freeze({ rateMax: 30, rateWindowMs: 60000 }),
    status: Object.freeze({ rateMax: 60, rateWindowMs: 60000 }),
  });
}

interface StoreFactoryOverrides {
  readonly now?: () => number;
  readonly failureThreshold?: number;
  readonly cooldownMs?: number;
}

function makeStore(
  configOverrides: Partial<AttachmentRateLimitConfig> = {},
  factoryOverrides: StoreFactoryOverrides = {},
): RateLimitStore {
  const store = createRedisRateLimitStore({
    config: makeConfig(configOverrides),
    environment: ENVIRONMENT,
    keySecret,
    now: factoryOverrides.now,
    failureThreshold: factoryOverrides.failureThreshold,
    cooldownMs: factoryOverrides.cooldownMs,
  });
  stores.push(store);
  return store;
}

/** Store with the connection READY (health barrier): lazy-connect +
 * offline-queue-off fails commands before `ready` by design, so every test
 * synchronizes on readiness before its first check. */
async function makeHealthyStore(
  configOverrides: Partial<AttachmentRateLimitConfig> = {},
  factoryOverrides: StoreFactoryOverrides = {},
): Promise<RateLimitStore> {
  const store = makeStore(configOverrides, factoryOverrides);
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
 * subject (a run that starts near a server-time window boundary legitimately
 * splits attempts across two counter keys; the SUM is the exact attempt count
 * in every case).
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

/** Redis SERVER time in epoch ms (the authoritative window clock, plan §2.3). */
async function serverTimeMs(): Promise<number> {
  const [seconds, micros] = (await raw!.time()) as [number, number];
  return Number(seconds) * 1000 + Math.floor(Number(micros) / 1000);
}

/**
 * Waits until the current server-time window has between `minRemainingMs`
 * and `maxRemainingMs` left, so a subsequent burst cannot straddle a window
 * boundary AND the first hit provably starts at least `windowMs -
 * maxRemainingMs` into the window (polling on Redis server time — never a
 * fixed sleep, plan §4.2.2). The lower age bound matters when a test reads
 * the spent-window counter AFTER the rollover: the key carries PEXPIRE =
 * windowMs, so it expires `ageAtFirstHit` ms after the roll — the caller can
 * guarantee the counter is still alive for its post-roll assertions.
 */
async function waitForWindowHeadroom(
  windowMs: number,
  minRemainingMs: number,
  maxRemainingMs?: number,
): Promise<void> {
  await waitUntil(async () => {
    const nowMs = await serverTimeMs();
    const remaining = windowMs - (nowMs % windowMs);
    if (maxRemainingMs !== undefined) {
      return remaining >= minRemainingMs && remaining <= maxRemainingMs;
    }
    return remaining >= minRemainingMs;
  }, windowMs + 30_000, `server window headroom in [${minRemainingMs}, ${maxRemainingMs ?? '∞'}ms`, 50);
}

describe('P4A-RL05 real Redis: atomic admission, server time and TTL contract', () => {
  beforeAll(async () => {
    let started: StartedTestContainer;
    try {
      started = await new GenericContainer(REDIS_IMAGE)
        .withExposedPorts(6379)
        // Daemonized redis under a keep-alive shell (the RL03 pattern): a
        // later file stops/restarts the SERVER process without dropping the
        // published port mapping; here it just keeps the container alive.
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
          console.warn(`[rl05-atomicity] best-effort exact-key cleanup failed for ${key}: ${String(error)}`);
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
      throw new Error(`P4A-RL05 atomicity cleanup failed: ${errors.map((error) => String(error)).join(' | ')}`);
    }
  }, 60_000);

  test('forty independent clients race one window: exactly the budget is allowed, everything else is denied (atomic INCR)', async () => {
    const CLIENT_COUNT = 40;
    const BUDGET = 24;
    const ATTEMPTS_PER_CLIENT = 2;
    // A one-hour window makes a boundary straddle during the race impossible,
    // so the budget assertions are deterministic (plan §4.3 GET/SET mutation:
    // a non-atomic implementation must exceed the budget or lose counts).
    const clients = Array.from({ length: CLIENT_COUNT }, () =>
      makeStore({ routes: issueRoutes({ rateMax: BUDGET, rateWindowMs: 3_600_000 }) }));
    for (const client of clients) {
      await waitUntil(() => client.readiness().status === 'healthy', 10_000, 'client store healthy', 25);
    }
    const owner = subject('concurrent');
    const gate = new StartGate(CLIENT_COUNT);
    const results = await Promise.all(clients.map(async (client) => {
      gate.arrive();
      await gate.waitForGo();
      const local: Array<'allowed' | 'denied'> = [];
      for (let i = 0; i < ATTEMPTS_PER_CLIENT; i += 1) {
        const outcome = await check(client, 'issue', owner);
        if (outcome.kind === 'allowed') local.push('allowed');
        else if (outcome.kind === 'denied') local.push('denied');
        else throw new Error(`concurrent check failed unexpectedly: ${outcome.failure.code}`);
      }
      return local;
    }));
    const flat = results.flat();
    const allowed = flat.filter((kind) => kind === 'allowed').length;
    const denied = flat.filter((kind) => kind === 'denied').length;
    assert.equal(allowed, BUDGET, 'exactly the budget is allowed across 40 clients — a GET/SET implementation over-allows');
    assert.equal(denied, CLIENT_COUNT * ATTEMPTS_PER_CLIENT - BUDGET, 'every remaining attempt is a denied DECISION (429 fact), never a failure');

    // Server-side proof: exactly ONE counter key exists for the shared
    // subject/route (every decision reported the same server-time window),
    // and its value is EXACTLY the total attempt count — a lost update
    // (non-atomic GET/SET) would leave the counter below 80 while the budget
    // assertion would already be red.
    const counterKeys = [...trackedKeys].filter((key) => {
      const parsed = parseAttachmentRateLimitKey(key);
      return parsed.kind === 'ok'
        && parsed.parts.routeClass === 'issue'
        && parsed.parts.subjectHmac === rateLimitSubjectHmac(keySecret, owner);
    });
    assert.equal(counterKeys.length, 1, 'all 80 attempts land on exactly one counter key (one shared window)');
    assert.equal(await raw!.get(counterKeys[0]!), String(CLIENT_COUNT * ATTEMPTS_PER_CLIENT),
      'the shared counter counts every attempt exactly once (atomic INCR)');
    const parsedSingle = parseAttachmentRateLimitKey(counterKeys[0]!);
    assert.equal(parsedSingle.kind, 'ok');
    if (parsedSingle.kind === 'ok') {
      assert.ok(parsedSingle.parts.windowStartEpochMs % 3_600_000 === 0, 'the shared window is floor-aligned');
    }
  }, 120_000);

  test('a spent window denies until the server-time window rolls over, then starts fresh', async () => {
    const store = await makeHealthyStore({ routes: issueRoutes({ rateMax: 3, rateWindowMs: 900 }) });
    // Ensure the three budget hits cannot straddle the 900ms boundary AND the
    // first hit starts >= 200ms into the window: the spent-window counter key
    // carries PEXPIRE = 900ms, so it expires `ageAtFirstHit` ms after the
    // rollover — the band keeps it alive for the post-roll counter assertions.
    await waitForWindowHeadroom(900, 500, 700);
    const owner = subject('roll');
    const first = await check(store, 'issue', owner);
    assert.equal(first.kind, 'allowed');
    if (first.kind !== 'allowed') return;
    const window0 = first.decision.windowStartEpochMs;
    assert.equal((await check(store, 'issue', owner)).kind, 'allowed', 'hit 2 of 3');
    assert.equal((await check(store, 'issue', owner)).kind, 'allowed', 'hit 3 of 3');

    let sawDeniedInWindow = false;
    let totalChecks = 3;
    let recoveredWindowStart = 0;
    await waitUntil(async () => {
      const outcome = await check(store, 'issue', owner);
      totalChecks += 1;
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
    assert.equal(recoveredWindowStart, window0 + 900, 'recovery lands exactly on the next server-time grid window');
    assert.equal(await raw!.get(counterKey('issue', owner, recoveredWindowStart)), '1', 'a fresh counter in the recovered window');
    assert.equal(await sumSubjectCounters(owner), totalChecks, 'every attempt (allowed and denied) hit the atomic counter');
  }, 60_000);

  test('the window identity comes from Redis server time, compared to host time only by range', async () => {
    const store = await makeHealthyStore();
    const owner = subject('servertime');
    const t1 = await serverTimeMs();
    const first = await check(store, 'issue', owner);
    const t2 = await serverTimeMs();
    assert.equal(first.kind, 'allowed');
    if (first.kind !== 'allowed') return;
    // The decision window must equal the server-time grid the script ran on
    // (TIME read before and after the check; a boundary crossed between the
    // two reads admits either adjacent grid window — never a third value).
    const windowBefore = Math.floor(t1 / 60000) * 60000;
    const windowAfter = Math.floor(t2 / 60000) * 60000;
    assert.ok(
      first.decision.windowStartEpochMs === windowBefore || first.decision.windowStartEpochMs === windowAfter,
      `decision window ${first.decision.windowStartEpochMs} is on the server-time grid (${windowBefore}/${windowAfter})`,
    );
    // plan §4.2.5: host time is only compared as a RANGE, never exact.
    assert.ok(
      Math.abs(first.decision.windowStartEpochMs - Date.now()) < 120_000,
      `window ${first.decision.windowStartEpochMs} is within range of host time (${Date.now()})`,
    );
    // Monotonic consistency: a second check in the same window reports the
    // SAME window identity; a boundary crossing can only advance to the next
    // grid window (server-derived, never host-derived).
    const second = await check(store, 'issue', owner);
    assert.equal(second.kind, 'allowed');
    if (second.kind === 'allowed') {
      const delta = second.decision.windowStartEpochMs - first.decision.windowStartEpochMs;
      assert.ok(delta === 0 || delta === 60000, `window identity is server-monotonic (delta ${delta})`);
    }
  });

  test('a skewed host clock cannot move the window: the server-derived identity wins and the seed never leaks', async () => {
    const realStore = await makeHealthyStore();
    // The documented `now` seam is the ONLY host-clock input to the adapter;
    // it feeds the codec window seed and readiness timestamps (plan §8 RL03).
    const SKEW_MS = 15 * 60_000;
    const skewedStore = await makeHealthyStore({}, { now: () => Date.now() + SKEW_MS });
    const owner = subject('skew');

    const realFirst = await check(realStore, 'issue', owner);
    assert.equal(realFirst.kind, 'allowed');
    if (realFirst.kind !== 'allowed') return;
    const t1 = await serverTimeMs();
    const skewed = await check(skewedStore, 'issue', owner);
    const t2 = await serverTimeMs();
    assert.equal(skewed.kind, 'allowed');
    if (skewed.kind !== 'allowed') return;

    // The skewed store's decision window is identical to the real store's —
    // both come from Redis server time, not from the +15min host clock. A
    // server-time boundary crossed between the two checks may only advance
    // the skewed store one grid window (never by the skew).
    const windowDelta = skewed.decision.windowStartEpochMs - realFirst.decision.windowStartEpochMs;
    assert.ok(
      windowDelta === 0 || windowDelta === 60000,
      `a +15min host skew changes nothing: the server-time window identity wins (delta ${windowDelta})`,
    );
    const gridBefore = Math.floor(t1 / 60000) * 60000;
    const gridAfter = Math.floor(t2 / 60000) * 60000;
    assert.ok(
      skewed.decision.windowStartEpochMs === gridBefore || skewed.decision.windowStartEpochMs === gridAfter,
      'the skewed decision still lands on the real server-time grid',
    );

    // The counter was written at the REAL window; the skewed-grid key (what a
    // host-time implementation would have written) does not exist, and both
    // stores shared one atomic counter across the server-derived windows.
    assert.equal(await sumSubjectCounters(owner), 2,
      'both stores shared the atomic counters at the server-derived windows');
    const skewedGrid = Math.floor((Date.now() + SKEW_MS) / 60000) * 60000;
    assert.equal(await raw!.get(counterKey('issue', owner, skewedGrid)), null,
      'the skewed host-time window seed never becomes a real Redis key (plan §2.3)');
  });

  test('first-call PEXPIRE exists in a loose range and high-frequency hits never refresh the TTL (plan §4.3 mutation)', async () => {
    const store = await makeHealthyStore({ routes: issueRoutes({ rateMax: 50, rateWindowMs: 3000 }) });
    // Keep the whole burst inside one 3s server window so the PTTL sequence
    // is measured on a single key.
    await waitForWindowHeadroom(3000, 1500);
    const owner = subject('ttl');
    const first = await check(store, 'issue', owner);
    assert.equal(first.kind, 'allowed');
    if (first.kind !== 'allowed') return;
    const key = counterKey('issue', owner, first.decision.windowStartEpochMs);
    // plan §4.2.5: TTL assertions use existence + a LOOSE range, never exact ms.
    const firstPttl = await raw!.pttl(key);
    assert.ok(firstPttl > 0 && firstPttl <= 3000 + 500, `first-call PEXPIRE within bounds (${firstPttl}ms)`);

    const pttls: number[] = [firstPttl];
    for (let i = 0; i < 8; i += 1) {
      // Redis reports PTTL in whole milliseconds. Let authoritative time move
      // before each hit so an unchanged integer sample cannot masquerade as a
      // refreshed TTL (or make the strictly-decreasing assertion flaky).
      await waitForRealTime(60, 'observe the real Redis PTTL count down before each high-frequency hit');
      const outcome = await check(store, 'issue', owner);
      assert.equal(outcome.kind, 'allowed', 'rateMax 50 never denies nine hits');
      pttls.push(await raw!.pttl(key));
    }
    for (let i = 1; i < pttls.length; i += 1) {
      assert.ok(
        pttls[i]! < pttls[i - 1]!,
        `the TTL must count down, never refresh (${pttls[i - 1]} -> ${pttls[i]}); ` +
          'a per-INCR PEXPIRE would reset it to ~3000ms (plan §4.3 mutation)',
      );
    }
    assert.ok(
      pttls[pttls.length - 1]! < 3000 - 300,
      `after ~500ms of hits the TTL is far below the window (${pttls[pttls.length - 1]}ms)`,
    );
    assert.equal(await sumSubjectCounters(owner), 9, 'all nine hits share one atomic counter');
  }, 60_000);
});
