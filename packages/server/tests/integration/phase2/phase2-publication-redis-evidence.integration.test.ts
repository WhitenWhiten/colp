/**
 * T14 performance and failure evidence runner
 * (plan 12-redis-hot-data-cache-plan.md §6.4 T14, §7.5/§7.6).
 *
 * Produces the machine-readable Phase 2 Publication Redis evidence artifact
 * against REAL PostgreSQL (provisioned by scripts/with-postgres.mjs) and a
 * dedicated Testcontainers Redis (never a developer Redis; no FLUSHALL/FLUSHDB).
 *
 * Scenarios and gates (implemented in tests/support/...-scenarios.ts):
 * 1. warm-hit   — one cold metadata miss then N warm hits: warm requests load
 *                 origin zero times, write nothing and still issue Redis GETs.
 * 2. off-parity — serve vs KNOWN_CACHE_MODE=off reference: identical
 *                 status/body bytes/ETag across metadata, snapshot, directory.
 * 3. cold-miss-concurrent — N=16 cold misses released together by a start gate
 *                 merge to exactly one origin load and one Redis write.
 * 4. outage     — redis-server process stopped inside the test-only container:
 *                 commands reject fast (bounded, no offline queue), health/
 *                 readiness degrade, an anonymous read falls back to origin
 *                 exactly once with bounded latency and byte/ETag parity.
 * 5. breaker    — the production Metadata domain path is driven against the
 *                 SAME real outage: 3 consecutive failures open the breaker,
 *                 open-state reads issue zero Redis commands, then a domain
 *                 half-open probe succeeds after restore and closes it.
 * 6. recovery   — readiness auto-returns to healthy; a fresh cold miss writes
 *                 Redis again and a subsequent warm hit loads origin zero times.
 * 7. outbox-invalidation — a real PATCH commits, the outbox worker completes the
 *                 purge event, the epoch rotates, and the next read reloads origin
 *                 instead of serving the stale value; invalidation lag is recorded.
 *
 * The artifact is schema-validated against
 * tests/fixtures/phase2-publication/redis-evidence.schema.json before it is
 * written. It never contains secrets or business body content. Cleanup always
 * runs in the shared context's finally-equivalent close().
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, beforeAll, test } from 'vitest';
import {
  PHASE2_PUBLICATION_REDIS_EVIDENCE_FORMAT,
  PHASE2_PUBLICATION_REDIS_EVIDENCE_SCHEMA_REF,
  assertPhase2PublicationRedisEvidenceShape,
  defaultPhase2PublicationRedisEvidenceArtifactPath,
  type Phase2PublicationRedisEvidence,
  type Phase2RedisScenario,
} from '../../../scripts/evidence/index.js';
import {
  createPhase2PublicationRedisEvidenceContext,
  aggregateCounts,
  buildFixture,
  collectVersions,
  compileArtifactValidator,
  gitHeadSha,
  gitWorktreeDirty,
  writeArtifact,
  type Phase2PublicationRedisEvidenceContext,
} from '../../support/phase2-publication-redis-evidence-helpers.js';
import {
  runColdMissConcurrentScenario,
  runOffParityScenario,
  runOutageBreakerRecoveryScenario,
  runOutboxInvalidationScenario,
  runWarmHitScenario,
} from '../../support/phase2-publication-redis-evidence-scenarios.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';

describeWithPostgres('Phase 2 Publication Redis performance and failure evidence (T14)', () => {
  let ctx: Phase2PublicationRedisEvidenceContext;
  let warmHitScenario: Phase2RedisScenario;
  let coldMissScenario: Phase2RedisScenario;
  let offParityScenario: Phase2RedisScenario;
  let outageScenario: Phase2RedisScenario;
  let recoveryScenario: Phase2RedisScenario;
  let outboxScenario: Phase2RedisScenario;
  let breakerScenario: Phase2RedisScenario;
  let outboxEvidence: Phase2PublicationRedisEvidence['outboxInvalidation'];
  let breakerEvidence: Phase2PublicationRedisEvidence['breakerEvidence'];

  beforeAll(async () => {
    ctx = await createPhase2PublicationRedisEvidenceContext();
  }, 300_000);

  afterAll(async () => {
    await ctx.close();
  }, 60_000);

  test('warm-hit: cold miss loads origin once and N warm hits load origin zero times with Redis GETs', async () => {
    warmHitScenario = await runWarmHitScenario(ctx);
  }, 120_000);

  test('off-parity: serve result sets equal the KNOWN_CACHE_MODE=off reference across cacheable domains', async () => {
    offParityScenario = await runOffParityScenario(ctx);
  }, 120_000);

  test('cold-miss-concurrent: N cold misses released by a start gate merge to one origin load and one write', async () => {
    coldMissScenario = await runColdMissConcurrentScenario(ctx);
  }, 120_000);

  test('outage + breaker + recovery: bounded fallback, degraded readiness, breaker open->half-open->closed, recovery writes again', async () => {
    const result = await runOutageBreakerRecoveryScenario(ctx);
    outageScenario = result.outageScenario;
    breakerScenario = result.breakerScenario;
    recoveryScenario = result.recoveryScenario;
    breakerEvidence = result.breakerEvidence;
  }, 180_000);

  test('outbox-invalidation: mutation -> outbox -> epoch rotation invalidates a warm value with recorded lag', async () => {
    const result = await runOutboxInvalidationScenario(ctx);
    outboxScenario = result.outboxScenario;
    outboxEvidence = result.outboxEvidence;
  }, 120_000);

  test('assembles, schema-validates and writes the machine-readable evidence artifact', async () => {
    const scenarios = [
      warmHitScenario,
      coldMissScenario,
      offParityScenario,
      outageScenario,
      recoveryScenario,
      outboxScenario,
      breakerScenario,
    ];
    assert.equal(scenarios.length, 7, 'all seven T14 scenarios must have produced evidence');
    const versions = await collectVersions(ctx.runtime, ctx.redisVersion);
    const evidence: Phase2PublicationRedisEvidence = {
      format: PHASE2_PUBLICATION_REDIS_EVIDENCE_FORMAT,
      schema: PHASE2_PUBLICATION_REDIS_EVIDENCE_SCHEMA_REF,
      timestamp: new Date().toISOString(),
      gitSha: gitHeadSha(),
      gitDirty: gitWorktreeDirty(),
      fixture: buildFixture(ctx.cacheConfig),
      scenarios,
      counts: aggregateCounts(scenarios.map((scenario) => scenario.counts)),
      latencyDistribution: {
        'warm-hit': warmHitScenario.latencyMs!,
        'cold-miss-concurrent': coldMissScenario.latencyMs!,
        'outage-fallback': outageScenario.latencyMs!,
        recovery: recoveryScenario.latencyMs!,
      },
      payloadBytes: {
        'warm-hit': warmHitScenario.payloadBytes!,
        'cold-miss-concurrent': coldMissScenario.payloadBytes!,
        'outage-fallback': outageScenario.payloadBytes!,
        recovery: recoveryScenario.payloadBytes!,
      },
      versions,
      outboxInvalidation: outboxEvidence,
      breakerEvidence,
      knownLimitations: [
        'Latency numbers are engineering-trial measurements on a shared CI/Windows host; gates favor count assertions (loader/query/Redis command counts, bounded waits). Raw samples are preserved in the artifact; do not treat single-machine p95 as a product SLO.',
        'Outbox invalidation lag is measured from the PATCH response (commit) to the first observed epoch rotation, so it includes the worker poll interval (WORKER_POLL_INTERVAL_MS=5 in the evidence config) and outbox claim latency.',
        'Redis outage is simulated by stopping the redis-server process inside the test-only container; network partitions, TLS, ACL, maxmemory eviction and Cluster failover are not covered (T15 runbook).',
        'Only cacheable domains are evidenced: anonymous Metadata, Directory first page and Snapshot first page. Snapshot continuation pages and non-default limits bypass the cache by design and are not warm-hit evidence.',
        'No production Redis was used; every scenario runs against a dedicated Testcontainers container with a random key prefix and no FLUSHALL/FLUSHDB.',
        'Warm-hit payload size is the HTTP response byte length; encoded envelope bytes are observed separately by cache.entry.size_bytes.<domain>.',
      ],
      pass: {
        warmHit: warmHitScenario.pass,
        coldMissConcurrency: coldMissScenario.pass,
        offParity: offParityScenario.pass,
        outageBoundedFallback: outageScenario.pass,
        recovery: recoveryScenario.pass,
        breaker: breakerEvidence.pass,
        outboxInvalidation: outboxEvidence.pass,
        overall:
          warmHitScenario.pass
          && coldMissScenario.pass
          && offParityScenario.pass
          && outageScenario.pass
          && recoveryScenario.pass
          && breakerEvidence.pass
          && breakerEvidence.domainPathUsesBreaker
          && outboxEvidence.pass,
      },
    };
    assertPhase2PublicationRedisEvidenceShape(evidence);
    const validate = compileArtifactValidator();
    assert.equal(validate(evidence), true, JSON.stringify(validate.errors));

    const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
    const configuredOutput = process.env.KNOWN_PHASE2_PUBLICATION_REDIS_EVIDENCE_OUTPUT?.trim();
    const publishesDefaultArtifact = process.env.npm_lifecycle_event
      === 'evidence:phase2-publication-redis:inner';
    const temporaryRoot = configuredOutput === undefined && !publishesDefaultArtifact
      ? mkdtempSync(resolve(tmpdir(), 'known-phase2-publication-redis-'))
      : undefined;
    const outputPath = configuredOutput
      ?? (temporaryRoot === undefined
        ? defaultPhase2PublicationRedisEvidenceArtifactPath()
        : resolve(temporaryRoot, 'phase2-publication-redis-evidence.json'));
    try {
      writeArtifact(outputPath, serialized);
      console.info(serialized);
      assert.equal(evidence.pass.overall, true, 'every T14 gate must pass');
    } finally {
      if (temporaryRoot !== undefined) rmSync(temporaryRoot, { recursive: true, force: true });
    }
  }, 60_000);
});
