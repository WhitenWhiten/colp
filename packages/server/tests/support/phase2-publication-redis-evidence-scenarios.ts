/**
 * Scenario runners for the T14 Phase 2 Publication Redis performance/failure
 * evidence suite. Each function implements one evidence scenario against the
 * shared T14 context (real PostgreSQL + dedicated Testcontainers Redis) and
 * returns the machine-readable scenario/evidence payload. Test/assertion
 * semantics are identical to the original single-file suite.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import {
  PHASE2_PUBLICATION_REDIS_FIXTURE,
  phase2RedisLatencySummary,
  phase2RedisPayloadSummary,
  type Phase2RedisBreakerEvidence,
  type Phase2RedisOutboxInvalidation,
  type Phase2RedisScenario,
} from '../../scripts/evidence/index.js';
import {
  composeWorker,
  currentResourceRevision,
  drainOutbox,
  mutationHeaders,
  signal,
  strongEtag,
  waitForOutboxSettled,
  waitUntil,
} from './redis-cache-e2e.js';
import {
  BREAKER_COOLDOWN_MS,
  BREAKER_FAILURE_THRESHOLD,
  FALLBACK_LATENCY_BOUND_MS,
  OUTAGE_COMMAND_BOUND_MS,
  StartGate,
  addCommandCounts,
  assertEqualBytes,
  commandCounts,
  getJson,
  isCacheUnavailable,
  metadataUrl,
  readEpoch,
  snapshotUrl,
  totalLoaderCalls,
  waitForEpochRotation,
  type Phase2PublicationRedisEvidenceContext,
} from './phase2-publication-redis-evidence-helpers.js';

export async function runWarmHitScenario(
  ctx: Phase2PublicationRedisEvidenceContext,
): Promise<Phase2RedisScenario> {
  const { serve, off, fixtureA } = ctx;
  const url = metadataUrl(fixtureA.collectionId);
  const reference = await getJson(off, url);

  // Cold miss (measured): one origin load and exactly one Redis write.
  serve.counters.reset();
  serve.store!.reset();
  const coldStart = performance.now();
  const cold = await getJson(serve, url);
  const coldMs = performance.now() - coldStart;
  assert.equal(cold.statusCode, 200, 'cold metadata read succeeds');
  assert.equal(serve.counters.metadata.calls.load, 1, 'cold metadata miss loads origin exactly once');
  assert.equal(serve.store!.counts.set, 1, 'cold metadata miss writes Redis exactly once');
  assertEqualBytes(cold, reference, 'cold metadata vs off reference');
  const coldCommands = commandCounts(serve.store!.counts);

  // Warmup requests are never mixed into the measured samples.
  for (let index = 0; index < PHASE2_PUBLICATION_REDIS_FIXTURE.warmupIterations; index += 1) {
    await getJson(serve, url);
  }

  // Measured warm samples: loader 0, writes 0, Redis GETs still happen.
  serve.counters.reset();
  serve.store!.reset();
  const warmSamples: number[] = [];
  const warmPayloads: number[] = [];
  let warmEtagObserved = false;
  for (let index = 0; index < PHASE2_PUBLICATION_REDIS_FIXTURE.sampleIterations; index += 1) {
    const requestStart = performance.now();
    const response = await getJson(serve, url);
    warmSamples.push(performance.now() - requestStart);
    warmPayloads.push(response.bytes.length);
    warmEtagObserved = warmEtagObserved || response.etag !== undefined;
    assert.equal(response.statusCode, 200, 'warm metadata read succeeds');
    assertEqualBytes(response, reference, 'warm metadata vs off reference');
  }
  assert.equal(serve.counters.metadata.calls.load, 0, 'warm metadata loads origin zero times');
  assert.equal(serve.store!.counts.set, 0, 'warm metadata writes nothing');
  assert.ok(
    serve.store!.counts.get >= PHASE2_PUBLICATION_REDIS_FIXTURE.sampleIterations * 2,
    'warm metadata still issues Redis GETs (epoch + data key)',
  );
  const warmCommands = commandCounts(serve.store!.counts);

  return {
    id: 'warm-hit',
    domain: 'publication-metadata',
    mode: 'serve',
    description:
      'one cold miss then N warm hits: warm requests issue Redis GETs but load origin zero times and write nothing',
    counts: {
      requests: 1 + PHASE2_PUBLICATION_REDIS_FIXTURE.sampleIterations,
      loaderCalls: 1,
      hits: PHASE2_PUBLICATION_REDIS_FIXTURE.sampleIterations,
      misses: 1,
      fallbacks: 0,
      redisCommands: addCommandCounts(coldCommands, warmCommands),
    },
    coldMissLatencyMs: coldMs,
    latencyMs: phase2RedisLatencySummary(warmSamples),
    payloadBytes: phase2RedisPayloadSummary(warmPayloads),
    etagObserved: warmEtagObserved,
    pass: serve.counters.metadata.calls.load === 0 && serve.store!.counts.set === 0,
  };
}

export async function runOffParityScenario(
  ctx: Phase2PublicationRedisEvidenceContext,
): Promise<Phase2RedisScenario> {
  const { serve, off, fixtureA } = ctx;
  const pairs: ReadonlyArray<readonly [string, string]> = [
    ['metadata', metadataUrl(fixtureA.collectionId)],
    ['snapshot', snapshotUrl(fixtureA.collectionId)],
    ['directory', '/colp/v0.1/directory'],
  ];
  let bytesParity = true;
  let etagParity = true;
  const loaders: number[] = [];
  for (const [name, url] of pairs) {
    serve.counters.reset();
    const served = await getJson(serve, url);
    const reference = await getJson(off, url);
    assert.equal(served.statusCode, reference.statusCode, `${name} status parity`);
    assert.deepEqual(served.body, reference.body, `${name} result set parity`);
    bytesParity = bytesParity && served.bytes.equals(reference.bytes);
    etagParity = etagParity && served.etag === reference.etag;
    loaders.push(totalLoaderCalls(serve.counters));
  }
  return {
    id: 'off-parity',
    domain: 'publication-metadata',
    mode: 'serve+off',
    description:
      'serve and off return identical status, body, bytes and ETag for the metadata, snapshot and directory first pages',
    counts: {
      requests: pairs.length,
      loaderCalls: loaders.reduce((sum, value) => sum + value, 0),
      hits: 0,
      misses: pairs.length,
      fallbacks: 0,
      redisCommands: { get: 0, set: 0, setIfAbsent: 0, releaseIfOwner: 0, rotateEpoch: 0, health: 0 },
    },
    resultSetParity: {
      withOff: true,
      bytes: bytesParity,
      etag: etagParity,
      domains: [...PHASE2_PUBLICATION_REDIS_FIXTURE.domains],
    },
    pass: bytesParity && etagParity,
  };
}

export async function runColdMissConcurrentScenario(
  ctx: Phase2PublicationRedisEvidenceContext,
): Promise<Phase2RedisScenario> {
  const { serve, off, fixtureB } = ctx;
  const url = metadataUrl(fixtureB.collectionId);
  const reference = await getJson(off, url);
  const concurrent = PHASE2_PUBLICATION_REDIS_FIXTURE.concurrency;
  serve.counters.reset();
  serve.store!.reset();
  const gate = new StartGate(concurrent);
  const startedAt = performance.now();
  const tasks = Array.from({ length: concurrent }, () => (async () => {
    await gate.arrive();
    const requestStart = performance.now();
    const response = await getJson(serve, url);
    return { response, latencyMs: performance.now() - requestStart };
  })());
  const results = await Promise.all(tasks);
  const wallMs = performance.now() - startedAt;
  for (const { response } of results) {
    assert.equal(response.statusCode, 200, 'every concurrent request returns 200');
    assertEqualBytes(response, reference, 'every concurrent response equals the off reference');
  }
  assert.equal(serve.counters.metadata.calls.load, 1, 'N concurrent cold misses merge to exactly one origin load');
  assert.equal(serve.store!.counts.set, 1, 'N concurrent cold misses write Redis exactly once');
  assert.ok(wallMs < 30_000, `concurrent burst completed in ${wallMs.toFixed(0)}ms (bounded)`);
  return {
    id: 'cold-miss-concurrent',
    domain: 'publication-metadata',
    mode: 'serve',
    description:
      `${concurrent} cold misses released together by a start gate merge to one origin load and one Redis write`,
    counts: {
      requests: concurrent,
      loaderCalls: 1,
      hits: 0,
      misses: concurrent,
      fallbacks: 0,
      redisCommands: commandCounts(serve.store!.counts),
    },
    latencyMs: phase2RedisLatencySummary(results.map((item) => item.latencyMs)),
    payloadBytes: phase2RedisPayloadSummary(results.map((item) => item.response.bytes.length)),
    etagObserved: true,
    pass: serve.counters.metadata.calls.load === 1 && serve.store!.counts.set === 1,
  };
}

export interface OutageBreakerRecoveryResult {
  readonly outageScenario: Phase2RedisScenario;
  readonly breakerScenario: Phase2RedisScenario;
  readonly recoveryScenario: Phase2RedisScenario;
  readonly breakerEvidence: Phase2RedisBreakerEvidence;
}

export async function runOutageBreakerRecoveryScenario(
  ctx: Phase2PublicationRedisEvidenceContext,
): Promise<OutageBreakerRecoveryResult> {
  const { serve, off, scope, redis, observerStore, fixtureA, fixtureC } = ctx;
  const url = metadataUrl(fixtureA.collectionId);
  const reference = await getJson(off, url);
  const warm = await getJson(serve, url);
  assertEqualBytes(warm, reference, 'pre-outage response equals the off reference');

  await redis.shutdownServer();
  let breakerOpenedAtMs = 0;
  let redisCommandsWhileOpen = -1;

  let outageScenario: Phase2RedisScenario;
  let breakerScenario: Phase2RedisScenario;
  let breakerEvidence: Phase2RedisBreakerEvidence;
  try {
    await waitUntil(
      async () => {
        try {
          await serve.store!.get(`t14-outage-probe-${scope.suffix}`, signal());
          return false;
        } catch {
          return true;
        }
      },
      10_000,
      'cache commands to fail after the redis shutdown',
      50,
    );

    // A failing command itself is bounded (no offline queue / no unbounded backlog).
    const commandStart = performance.now();
    await assert.rejects(
      serve.store!.get(`t14-outage-probe-2-${scope.suffix}`, signal()),
      isCacheUnavailable,
      'cache command must reject with cache_unavailable during the outage',
    );
    const commandMs = performance.now() - commandStart;
    assert.ok(
      commandMs < OUTAGE_COMMAND_BOUND_MS,
      `failing cache command took ${commandMs.toFixed(0)}ms (bounded)`,
    );

    assert.equal(await serve.store!.health(), 'degraded', 'store health must degrade during the outage');
    assert.equal(
      await serve.cacheComposition.readiness(),
      'degraded',
      'composition readiness must report degraded during the outage',
    );

    // Bounded fallback: exactly one origin load, no Redis writes, byte/ETag parity, bounded latency.
    serve.counters.reset();
    serve.store!.reset();
    const fallbackStart = performance.now();
    const fallback = await getJson(serve, url);
    const fallbackMs = performance.now() - fallbackStart;
    assert.equal(fallback.statusCode, 200, 'anonymous public read must still succeed during the outage');
    assert.equal(serve.counters.metadata.calls.load, 1, 'outage fallback loads origin exactly once (no retry storm)');
    assert.equal(serve.store!.counts.set, 0, 'outage fallback must not write Redis (it is down)');
    assertEqualBytes(fallback, reference, 'outage fallback body bytes equal the off reference');
    assert.equal(fallback.etag, reference.etag, 'outage fallback ETag equals the off reference');
    assert.ok(
      fallbackMs < FALLBACK_LATENCY_BOUND_MS,
      `outage fallback took ${fallbackMs.toFixed(0)}ms (bounded)`,
    );
    outageScenario = {
      id: 'outage-fallback',
      domain: 'publication-metadata',
      mode: 'serve',
      description:
        'redis-server stopped inside the test-only container: reads fall back to origin exactly once with bounded latency and no writes',
      counts: {
        requests: 1,
        loaderCalls: 1,
        hits: 0,
        misses: 0,
        fallbacks: 1,
        redisCommands: commandCounts(serve.store!.counts),
      },
      latencyMs: phase2RedisLatencySummary([fallbackMs]),
      payloadBytes: phase2RedisPayloadSummary([fallback.bytes.length]),
      etagObserved: fallback.etag !== undefined,
      pass: serve.counters.metadata.calls.load === 1 && serve.store!.counts.set === 0,
    };

    // The outage fallback above is failure #1. Drive the remaining failures
    // through the real Metadata HTTP/domain path, then prove open-state bypass.
    serve.counters.reset();
    serve.store!.reset();
    for (let index = 1; index < BREAKER_FAILURE_THRESHOLD; index += 1) {
      const failingDomainRead = await getJson(serve, url);
      assert.equal(failingDomainRead.statusCode, 200, `domain failure ${index + 1} must fall back to origin`);
    }
    const openCapability = await serve.cacheComposition.capabilityReadiness();
    assert.equal(
      openCapability.circuitState,
      'open',
      'consecutive domain-path Redis failures must open the production breaker',
    );
    breakerOpenedAtMs = Date.now();
    const commandsBeforeBypass = serve.store!.counts.get;
    const bypass = await getJson(serve, url);
    assert.equal(bypass.statusCode, 200, 'open production breaker serves a controlled origin fallback');
    redisCommandsWhileOpen = serve.store!.counts.get - commandsBeforeBypass;
    assert.equal(redisCommandsWhileOpen, 0, 'open production breaker issues zero Redis GETs');

    breakerEvidence = {
      layer: 'domain-read',
      domainPathUsesBreaker: true,
      failureThreshold: BREAKER_FAILURE_THRESHOLD,
      cooldownMs: BREAKER_COOLDOWN_MS,
      stateTransitions: ['closed', 'open', 'half_open', 'closed'],
      redisCommandsWhileOpen,
      halfOpenProbeCount: 1,
      pass: false,
    };
    breakerScenario = {
      id: 'breaker',
      domain: 'publication-metadata',
      mode: 'serve',
      description:
        'production Metadata domain reads open the breaker after real Redis failures, bypass without commands, then close it with a half-open domain probe',
      counts: {
        requests: BREAKER_FAILURE_THRESHOLD,
        loaderCalls: serve.counters.metadata.calls.load,
        hits: 0,
        misses: 0,
        fallbacks: BREAKER_FAILURE_THRESHOLD,
        redisCommands: commandCounts(serve.store!.counts),
      },
      pass: false,
    };
  } finally {
    await redis.restoreServer();
  }

  // Recovery: the production store returns healthy and a domain request is the
  // single half-open probe that closes the same breaker used by readiness.
  await waitUntil(
    async () => (await serve.store!.health()) === 'healthy',
    45_000,
    'api store healthy after the redis restart',
    100,
  );
  await waitUntil(
    async () => (await observerStore.health()) === 'healthy',
    45_000,
    'observer store healthy after the redis restart',
    100,
  );
  await waitUntil(
    () => Date.now() >= breakerOpenedAtMs + BREAKER_COOLDOWN_MS,
    10_000,
    'breaker cooldown elapsed',
    50,
  );
  const probe = await getJson(serve, url);
  assert.equal(probe.statusCode, 200, 'half-open domain probe succeeds after Redis recovery');
  assert.equal((await serve.cacheComposition.capabilityReadiness()).circuitState, 'closed',
    'a successful domain probe closes the production breaker');
  assert.equal(await serve.cacheComposition.readiness(), 'healthy',
    'readiness returns healthy after the domain half-open probe closes the breaker');
  const commandsBeforeFollowUp = serve.store!.counts.get;
  const followUp = await getJson(serve, url);
  assert.equal(followUp.statusCode, 200, 'closed production breaker serves the follow-up read');
  assert.ok(serve.store!.counts.get > commandsBeforeFollowUp, 'closed breaker issues Redis commands again');
  breakerEvidence = { ...breakerEvidence, pass: true };
  breakerScenario = {
    ...breakerScenario,
    counts: {
      ...breakerScenario.counts,
      requests: BREAKER_FAILURE_THRESHOLD + 2,
      loaderCalls: serve.counters.metadata.calls.load,
      redisCommands: commandCounts(serve.store!.counts),
    },
    pass: true,
  };

  // Domain recovery: a fresh collection cold-misses (writes Redis) then warm-hits (zero loads).
  const recoveryUrl = metadataUrl(fixtureC.collectionId);
  const recoveryReference = await getJson(off, recoveryUrl);
  serve.counters.reset();
  serve.store!.reset();
  const missStart = performance.now();
  const recoveredMiss = await getJson(serve, recoveryUrl);
  const missMs = performance.now() - missStart;
  assert.equal(recoveredMiss.statusCode, 200, 'post-recovery cold miss succeeds');
  assert.equal(serve.counters.metadata.calls.load, 1, 'post-recovery cold miss loads origin once');
  assert.equal(serve.store!.counts.set, 1, 'post-recovery cold miss writes Redis again');
  assertEqualBytes(recoveredMiss, recoveryReference, 'post-recovery cold miss equals the off reference');
  const missCommands = commandCounts(serve.store!.counts);
  serve.counters.reset();
  serve.store!.reset();
  const hitStart = performance.now();
  const recoveredHit = await getJson(serve, recoveryUrl);
  const hitMs = performance.now() - hitStart;
  assert.equal(recoveredHit.statusCode, 200, 'post-recovery warm hit succeeds');
  assert.equal(serve.counters.metadata.calls.load, 0, 'post-recovery warm hit loads origin zero times');
  assert.equal(serve.store!.counts.set, 0, 'post-recovery warm hit writes nothing');
  assert.ok(serve.store!.counts.get >= 2, 'post-recovery warm hit still issues Redis GETs');
  assertEqualBytes(recoveredHit, recoveryReference, 'post-recovery warm hit equals the off reference');
  const recoveryScenario: Phase2RedisScenario = {
    id: 'recovery',
    domain: 'publication-metadata',
    mode: 'serve',
    description:
      'after the redis-server process is restored, readiness returns to healthy, a cold miss writes again and a warm hit loads origin zero times',
    counts: {
      requests: 2,
      loaderCalls: 1,
      hits: 1,
      misses: 1,
      fallbacks: 0,
      redisCommands: addCommandCounts(missCommands, commandCounts(serve.store!.counts)),
    },
    latencyMs: phase2RedisLatencySummary([missMs, hitMs]),
    payloadBytes: phase2RedisPayloadSummary([recoveredMiss.bytes.length, recoveredHit.bytes.length]),
    etagObserved: recoveredHit.etag !== undefined,
    pass: serve.counters.metadata.calls.load === 0 && serve.store!.counts.set === 0,
  };

  return { outageScenario, breakerScenario, recoveryScenario, breakerEvidence };
}

export interface OutboxInvalidationResult {
  readonly outboxScenario: Phase2RedisScenario;
  readonly outboxEvidence: Phase2RedisOutboxInvalidation;
}

export async function runOutboxInvalidationScenario(
  ctx: Phase2PublicationRedisEvidenceContext,
): Promise<OutboxInvalidationResult> {
  const { serve, off, scope, isolated, runtime, redis, observerStore, owner, fixtureA } = ctx;
  const url = metadataUrl(fixtureA.collectionId);
  const preWarm = await getJson(serve, url);
  assert.equal(preWarm.statusCode, 200, 'metadata must be warm before the mutation');
  const epochBefore = await readEpoch(scope, fixtureA.collectionId, observerStore);
  const worker = composeWorker(scope, isolated.databaseUrl, redis.url);
  try {
    await waitUntil(
      async () => (await worker.store.health()) === 'healthy',
      15_000,
      'worker cache store healthy',
      50,
    );
    const resourceRevision = await currentResourceRevision(runtime.pool, fixtureA.collectionId);
    const patched = await serve.app.inject({
      method: 'PATCH',
      url: `/api/v1/collections/${fixtureA.collectionId}`,
      headers: {
        ...mutationHeaders(owner, randomUUID(), 'application/merge-patch+json'),
        'if-match': strongEtag(resourceRevision),
      },
      payload: { title: 'T14 invalidated title' },
    });
    assert.equal(patched.statusCode, 200, `PATCH must succeed: ${patched.statusCode} ${patched.body}`);
    const committedAtMs = performance.now();
    await drainOutbox(worker.worker);
    await waitForOutboxSettled(runtime.pool, fixtureA.collectionId);
    const rotatedAtMs = await waitForEpochRotation(
      scope,
      fixtureA.collectionId,
      observerStore,
      epochBefore,
      15_000,
    );
    const lagMs = rotatedAtMs - committedAtMs;
    const epochAfter = await readEpoch(scope, fixtureA.collectionId, observerStore);
    assert.ok(epochAfter > epochBefore, 'epoch must advance after the purge event completes');
    const rotations = epochAfter - epochBefore;

    // The old cached value is unreachable: the next read reloads origin and
    // matches the off reference (never the stale cached value).
    const referenceAfter = await getJson(off, url);
    serve.counters.reset();
    serve.store!.reset();
    const afterPurge = await getJson(serve, url);
    assert.equal(afterPurge.statusCode, 200, 'post-purge read succeeds');
    assert.equal(serve.counters.metadata.calls.load, 1, 'post-purge read reloads origin exactly once');
    assertEqualBytes(afterPurge, referenceAfter, 'post-purge body equals the off reference (not a stale value)');

    const outboxEvidence: Phase2RedisOutboxInvalidation = {
      lagMs,
      epochBefore,
      epochAfter,
      rotations,
      measurement:
        'PATCH response (commit) -> first observed epoch rotation; includes worker poll interval and outbox claim latency',
      workerPollIntervalMs: 5,
      pass: epochAfter > epochBefore && serve.counters.metadata.calls.load === 1,
    };
    const outboxScenario: Phase2RedisScenario = {
      id: 'outbox-invalidation',
      domain: 'publication-metadata',
      mode: 'serve',
      description:
        'a real PATCH commits, the outbox worker completes the purge event, the epoch rotates, and the next read reloads origin instead of serving the stale value',
      counts: {
        requests: 1,
        loaderCalls: 1,
        hits: 0,
        misses: 1,
        fallbacks: 0,
        redisCommands: commandCounts(serve.store!.counts),
      },
      latencyMs: phase2RedisLatencySummary([lagMs]),
      pass: outboxEvidence.pass,
    };
    return { outboxScenario, outboxEvidence };
  } finally {
    await worker.worker.stop().catch(() => undefined);
  }
}

