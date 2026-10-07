/**
 * T14 evidence contract test (plan 12-redis-hot-data-cache-plan.md §6.4 T14,
 * §7.6). Validates the committed artifact JSON schema and the pure evidence
 * contract module WITHOUT running the evidence runner: no vitest integration
 * run, no Redis, no PostgreSQL, no evidence/benchmark command.
 *
 * The committed schema must keep the mandatory T14 fields (scenario, fixture,
 * counts, latency distribution, payload bytes, versions, timestamp, git SHA,
 * known limitations) and the git/version fields must exist, so a produced
 * artifact can always be replayed and audited.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

// Vite interop: the CJS default resolves to the formats plugin function at runtime;
// the cast only fixes the NodeNext type view of the CJS default export.
const applyAjvFormats = addFormats as unknown as (ajv: Ajv2020) => void;
import { describe, test } from 'vitest';
import {
  PHASE2_PUBLICATION_REDIS_EVIDENCE_FORMAT,
  PHASE2_PUBLICATION_REDIS_EVIDENCE_SCHEMA_REF,
  PHASE2_PUBLICATION_REDIS_FIXTURE,
  assertPhase2PublicationRedisEvidenceShape,
  defaultPhase2PublicationRedisEvidenceArtifactPath,
  phase2PublicationRedisEvidenceSchemaPath,
  type Phase2PublicationRedisEvidence,
  type Phase2RedisScenarioDomain,
} from '../../../scripts/evidence/index.js';

const root = resolve(import.meta.dirname, '../../..');
const schemaPath = resolve(root, 'tests/fixtures/phase2-publication/redis-evidence.schema.json');

const MANDATED_TOP_LEVEL_FIELDS = [
  'scenarios',
  'fixture',
  'counts',
  'latencyDistribution',
  'payloadBytes',
  'versions',
  'timestamp',
  'gitSha',
  'knownLimitations',
] as const;

function loadSchema(): object {
  return JSON.parse(readFileSync(schemaPath, 'utf8')) as object;
}

function compileValidator() {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  applyAjvFormats(ajv);
  return ajv.compile(loadSchema());
}

/** Representative T14 artifact shape; mirrors what the runner produces. */
function sampleEvidence(): Phase2PublicationRedisEvidence {
  const cacheConfig = {
    mode: 'serve' as const,
    commandTimeoutMs: 200,
    connectTimeoutMs: 2_000,
    maxRetriesPerRequest: 1,
    maxEntryBytes: 524_288,
    lockTtlMs: 1_500,
    metadataSoftTtlMs: 10_000,
    metadataHardTtlMs: 30_000,
    directorySoftTtlMs: 5_000,
    directoryHardTtlMs: 15_000,
    snapshotSoftTtlMs: 10_000,
    snapshotHardTtlMs: 30_000,
  };
  const redisCommands = { get: 22, set: 1, setIfAbsent: 1, releaseIfOwner: 1, rotateEpoch: 0, health: 0 };
  const counts = { requests: 11, loaderCalls: 1, hits: 10, misses: 1, fallbacks: 0, redisCommands };
  const fixture = {
    concurrency: PHASE2_PUBLICATION_REDIS_FIXTURE.concurrency,
    randomSeed: PHASE2_PUBLICATION_REDIS_FIXTURE.randomSeed,
    childCount: PHASE2_PUBLICATION_REDIS_FIXTURE.childCount,
    warmupIterations: PHASE2_PUBLICATION_REDIS_FIXTURE.warmupIterations,
    sampleIterations: PHASE2_PUBLICATION_REDIS_FIXTURE.sampleIterations,
    domains: [...PHASE2_PUBLICATION_REDIS_FIXTURE.domains],
    redisImage: 'redis:7-alpine',
    postgresImage: 'postgres:16.4-alpine',
    failureInjectionPoint: 'redis-server shutdown (nosave) inside the test-only container',
    cacheConfig,
  };
  const latencyMs = { p50: 1.2, p95: 2.5, max: 4.0, sampleCount: 10 };
  const payloadBytes = { mean: 1200, min: 1198, max: 1202, sampleCount: 10 };
  const scenario = (id: Phase2PublicationRedisEvidence['scenarios'][number]['id'], domain: Phase2RedisScenarioDomain, description: string) => ({
    id,
    domain,
    mode: 'serve',
    description,
    counts,
    coldMissLatencyMs: 15.5,
    latencyMs,
    payloadBytes,
    etagObserved: true,
    pass: true,
  });
  return {
    format: PHASE2_PUBLICATION_REDIS_EVIDENCE_FORMAT,
    schema: PHASE2_PUBLICATION_REDIS_EVIDENCE_SCHEMA_REF,
    timestamp: '2026-08-07T00:00:00.000Z',
    gitSha: '0123456789abcdef0123456789abcdef01234567',
    gitDirty: false,
    fixture,
    scenarios: [
      scenario('warm-hit', 'publication-metadata', 'cold miss then repeated warm hits; loader must stay 0'),
      scenario('cold-miss-concurrent', 'publication-metadata', 'N concurrent cold misses merge to one origin load'),
      {
        id: 'off-parity',
        domain: 'publication-metadata',
        mode: 'serve+off',
        description: 'serve and KNOWN_CACHE_MODE=off produce identical result sets',
        counts,
        resultSetParity: { withOff: true, bytes: true, etag: true, domains: [...PHASE2_PUBLICATION_REDIS_FIXTURE.domains] },
        pass: true,
      },
      scenario('outage-fallback', 'publication-metadata', 'bounded fallback while Redis is down'),
      scenario('recovery', 'publication-metadata', 'readiness returns to healthy and writes resume'),
      scenario('outbox-invalidation', 'publication-metadata', 'epoch rotation invalidates a warm value'),
      {
        id: 'breaker',
        domain: 'publication-metadata',
        mode: 'serve',
        description: 'production Metadata breaker open -> half-open -> closed against real Redis',
        counts,
        pass: true,
      },
    ],
    counts: { requests: 77, loaderCalls: 7, hits: 70, misses: 7, fallbacks: 1, redisCommands },
    latencyDistribution: {
      'warm-hit': latencyMs,
      'cold-miss-concurrent': latencyMs,
      'outage-fallback': { p50: 42, p95: 42, max: 42, sampleCount: 1 },
      recovery: latencyMs,
    },
    payloadBytes: {
      'warm-hit': payloadBytes,
      'cold-miss-concurrent': payloadBytes,
      'outage-fallback': payloadBytes,
      recovery: payloadBytes,
    },
    versions: {
      node: 'v22.14.0',
      os: 'win32 Windows_NT',
      cpu: 'test-cpu',
      postgres: '16.4',
      redis: '7.4.0',
      vitest: '3.2.7',
      tsx: '4.19.3',
      ioredis: '6.0.0',
    },
    outboxInvalidation: {
      lagMs: 18.5,
      epochBefore: 0,
      epochAfter: 2,
      rotations: 2,
      measurement: 'PATCH response (commit) -> first observed epoch rotation, includes worker poll interval',
      workerPollIntervalMs: 5,
      pass: true,
    },
    breakerEvidence: {
      layer: 'domain-read',
      domainPathUsesBreaker: true,
      failureThreshold: 3,
      cooldownMs: 500,
      stateTransitions: ['closed', 'open', 'half_open', 'closed'],
      redisCommandsWhileOpen: 0,
      halfOpenProbeCount: 1,
      pass: true,
    },
    knownLimitations: ['engineering-trial latency'],
    pass: {
      warmHit: true,
      coldMissConcurrency: true,
      offParity: true,
      outageBoundedFallback: true,
      recovery: true,
      breaker: true,
      outboxInvalidation: true,
      overall: true,
    },
  };
}

describe('T14 redis evidence artifact schema contract', () => {
  test('schema file parses and mandates the T14 required fields', () => {
    const schema = loadSchema() as {
      required?: readonly string[];
      properties?: Record<string, unknown>;
    };
    assert.ok(Array.isArray(schema.required));
    for (const field of MANDATED_TOP_LEVEL_FIELDS) {
      assert.ok(schema.required.includes(field), `schema must require ${field}`);
      assert.ok(schema.properties?.[field] !== undefined, `schema must define ${field}`);
    }
    assert.ok(schema.required.includes('format'));
    assert.ok(schema.required.includes('gitDirty'));
    assert.ok(schema.required.includes('pass'));
  });

  test('git SHA and runtime version fields exist with the right shapes', () => {
    const schema = loadSchema() as {
      properties: {
        gitSha?: { pattern?: string };
        timestamp?: { format?: string };
      };
      $defs?: { versions?: { required?: readonly string[] } };
    };
    assert.equal(schema.properties.gitSha?.pattern, '^[0-9a-f]{40}$');
    assert.equal(schema.properties.timestamp?.format, 'date-time');
    for (const versionField of ['node', 'os', 'cpu', 'postgres', 'redis', 'vitest', 'tsx', 'ioredis']) {
      assert.ok(
        schema.$defs?.versions?.required?.includes(versionField),
        `versions must require ${versionField}`,
      );
    }
  });

  test('committed schema validates a representative T14 artifact', () => {
    const validate = compileValidator();
    const evidence = sampleEvidence();
    assert.equal(validate(evidence), true, JSON.stringify(validate.errors));
  });

  test('schema rejects missing mandatory fields (fail closed)', () => {
    const validate = compileValidator();
    for (const field of MANDATED_TOP_LEVEL_FIELDS) {
      const { [field]: _removed, ...evidence } = sampleEvidence();
      assert.equal(validate(evidence), false, `missing ${field} must fail the schema`);
    }

    const wrongFormat = { ...sampleEvidence(), format: 'known.other.v1' };
    assert.equal(validate(wrongFormat), false);

    const badGitSha = { ...sampleEvidence(), gitSha: 'not-a-sha' };
    assert.equal(validate(badGitSha), false);
  });

  test('schema rejects zero concurrency / too few scenarios and unknown latency keys', () => {
    const validate = compileValidator();
    const evidence = sampleEvidence();

    assert.equal(validate({
      ...evidence,
      fixture: { ...evidence.fixture, concurrency: 1 },
    }), false, 'concurrency below schema minimum must fail');

    assert.equal(validate({
      ...evidence,
      scenarios: evidence.scenarios.slice(0, 4),
    }), false, 'fewer than five scenarios must fail');

    assert.equal(validate({
      ...evidence,
      latencyDistribution: { ...evidence.latencyDistribution, 'unknown-key': evidence.latencyDistribution['warm-hit'] },
    }), false, 'unknown latencyDistribution key must fail (additionalProperties false)');
  });
});

describe('T14 evidence contract module', () => {
  test('module constants match the committed schema identity', () => {
    const schema = loadSchema() as {
      properties: { format?: { const?: string }; schema?: { const?: string } };
    };
    assert.equal(PHASE2_PUBLICATION_REDIS_EVIDENCE_FORMAT, schema.properties.format?.const);
    assert.equal(PHASE2_PUBLICATION_REDIS_EVIDENCE_SCHEMA_REF, schema.properties.schema?.const);
    assert.equal(phase2PublicationRedisEvidenceSchemaPath(), schemaPath);
    assert.match(
      defaultPhase2PublicationRedisEvidenceArtifactPath(),
      /docs[\\/]evidence[\\/]phase2-publication-redis-evidence\.json$/u,
    );
  });

  test('fixture locks fixed scale: concurrency, seed, payload child count, warmup/samples', () => {
    assert.ok(PHASE2_PUBLICATION_REDIS_FIXTURE.concurrency >= 2);
    assert.ok(PHASE2_PUBLICATION_REDIS_FIXTURE.concurrency <= 64);
    assert.equal(PHASE2_PUBLICATION_REDIS_FIXTURE.randomSeed, 42);
    assert.equal(PHASE2_PUBLICATION_REDIS_FIXTURE.childCount, 3);
    assert.ok(PHASE2_PUBLICATION_REDIS_FIXTURE.warmupIterations >= 1);
    assert.ok(PHASE2_PUBLICATION_REDIS_FIXTURE.sampleIterations >= 5);
    assert.deepEqual([...PHASE2_PUBLICATION_REDIS_FIXTURE.domains], ['metadata', 'directory', 'snapshot']);
  });

  test('fail-closed shape guard accepts a valid artifact and rejects malformed ones', () => {
    const evidence = sampleEvidence();
    assert.doesNotThrow(() => assertPhase2PublicationRedisEvidenceShape(evidence));

    const { knownLimitations: _omitted, ...missing } = evidence;
    assert.throws(
      () => assertPhase2PublicationRedisEvidenceShape(missing),
      /missing required field: knownLimitations/u,
    );

    assert.throws(
      () => assertPhase2PublicationRedisEvidenceShape({ ...evidence, gitSha: 'short' }),
      /gitSha must be a 40-hex HEAD SHA/u,
    );

    assert.throws(
      () => assertPhase2PublicationRedisEvidenceShape({ ...evidence, format: 'wrong' }),
      /format mismatch/u,
    );

    assert.throws(
      () => assertPhase2PublicationRedisEvidenceShape({ ...evidence, timestamp: 'not-a-date' }),
      /timestamp must be an ISO date-time/u,
    );
  });
});
