/**
 * P4A-P11 deterministic evidence fixture (not a vitest test file): builds a
 * fixed-schema, pass-verdict bundle every P11 unit contract suite can use.
 * The digests are computed through the INDEPENDENT validator's recompute
 * helpers (the runner's digest function must agree with the validator's own
 * implementation; the fixture pins that agreement).
 */
import { I16_NEGATIVE_CONTROL_CATALOG } from '../../scripts/evidence/phase4a-i16-acceptance.js';
import {
  P11_KEY_PREFIX_MARKER,
  P11_CONSUMER_KINDS,
  P11_LIFECYCLE_STEPS,
  computeP11CanonicalDigest,
  type P11EvidenceBundle,
} from '../../scripts/phase4a-owner-private-evidence.js';
import {
  recomputeClientDigest,
  recomputeConfigDigest,
  recomputeOpenapiDigest,
  recomputeOriginBuildHash,
  recomputeRedisAlgorithmDigest,
} from '../../scripts/phase4a-owner-private-validate-evidence.mjs';

export function p11FixtureConfigFacts(): P11EvidenceBundle['binding']['configFacts'] {
  return {
    r2: { livePrefix: P11_KEY_PREFIX_MARKER, probePrefix: P11_KEY_PREFIX_MARKER },
    verification: { leaseMs: 120_000, timeoutMs: 30_000, retryCount: 1 },
    grantTtlSeconds: 60,
    singlePutMaxBytes: 5 * 1024 * 1024,
    rateLimitMode: 'enforce',
    rateLimitRequired: true,
    rateLimitKeyPrefix: P11_KEY_PREFIX_MARKER,
  };
}

function fixtureRedisAlgorithmFacts(configFacts: P11EvidenceBundle['binding']['configFacts']) {
  return {
    luaScriptName: 'rate_limit_fixed_window_v1',
    windowSource: 'redis-server-time',
    decisionShape: ['allowed', 'count', 'remaining', 'retryAfterSeconds', 'windowStartEpochMs'],
    routeClasses: ['issue', 'complete', 'download'],
    completeEmergencyBounded: true,
    rateLimitMode: configFacts.rateLimitMode,
    rateLimitRequired: configFacts.rateLimitRequired,
    rateLimitKeyPrefix: configFacts.rateLimitKeyPrefix,
  };
}

/** Deterministic fixed-schema evidence bundle (P11 fixture; pass/accepted). */
export function p11FixtureBundle(overrides: Record<string, unknown> = {}): P11EvidenceBundle {
  const configFacts = p11FixtureConfigFacts();
  const binding: P11EvidenceBundle['binding'] = {
    sourceRevision: 'a'.repeat(40),
    sourceTreeHash: 'b'.repeat(40),
    sourceClean: true,
    migrationHead: '202608120000_phase4a_p11_acceptance',
    nodeVersion: 'v24.9.0',
    npmVersion: '11.7.0',
    postgresVersion: 'PostgreSQL 16.4 (testcontainers)',
    redisVersion: 'redis 7-alpine (testcontainers)',
    chromiumVersion: 'chromium 149.0.7827.55',
    dependencyVersions: {
      '@aws-sdk/client-s3': '3.1095.0',
      playwright: '1.61.1',
      kysely: '0.29.4',
      pg: '8.13.1',
      fastify: '5.2.1',
      ioredis: '6.0.0',
      testcontainers: '12.0.4',
    },
    boundary: {
      postgres: 'real-testcontainers',
      redis: 'real-testcontainers',
      r2: 'real-cloudflare-r2',
      chromium: 'real-chromium',
    },
    configDigest: recomputeConfigDigest(configFacts),
    configFacts,
    redisAlgorithmDigest: recomputeRedisAlgorithmDigest(fixtureRedisAlgorithmFacts(configFacts)),
    r2Attestation: {
      attested: true,
      provider: 'cloudflare-r2-direct-object-api',
      accessMode: 'private',
      verdictSource: 'in-run-control-plane-attestation',
      nonce: '00000000',
    },
    originBuild: { productionBuild: true, buildHash: recomputeOriginBuildHash(), buildCommand: 'npm run build' },
    openapiDigest: recomputeOpenapiDigest(),
    clientDigest: recomputeClientDigest(),
    negativeControlCatalog: I16_NEGATIVE_CONTROL_CATALOG.map((definition) => ({
      control: definition.control,
      verdict: 'pass' as const,
      verificationSource: definition.primarySource,
      executed: true,
    })),
  };
  // Deterministic sub-run id: the fixture's gates.environment
  // i16RegressionRunId must reference the SAME value across every
  // `p11FixtureBundle()` invocation (override spreads stay coherent).
  const subRunId = 'p11-fixture-i16-subrun-000000000000';
  const bundle: P11EvidenceBundle = {
    schemaVersion: 2,
    task: 'phase4a-owner-private',
    verdict: 'pass',
    accepted: true,
    runId: 'p11-fixture-run-0000-0000-4000-8000-000000000000',
    startedAtIso: '2026-08-12T12:00:00.000Z',
    finishedAtIso: '2026-08-12T12:05:00.000Z',
    binding,
    lifecycle: {
      steps: P11_LIFECYCLE_STEPS.map((step) => ({
        step,
        outcome: 'ok',
        statusClass: '2xx',
        facts: 'fixture',
      })),
      authorizationNegatives: [
        { scenario: 'non_owner', statusClass: '4xx', bodyBytes: 0, noRedirect: true, noCapability: true },
        { scenario: 'anonymous', statusClass: '4xx', bodyBytes: 0, noRedirect: true, noCapability: true },
        { scenario: 'revoked', statusClass: '4xx', bodyBytes: 0, noRedirect: true, noCapability: true },
        { scenario: 'cross_collection', statusClass: '4xx', bodyBytes: 0, noRedirect: true, noCapability: true },
        { scenario: 'old_capability', statusClass: '4xx', bodyBytes: 0, noRedirect: true, noCapability: true },
        { scenario: 'expired_capability', statusClass: '4xx', bodyBytes: 0, noRedirect: true, noCapability: true },
        { scenario: 'tampered_capability', statusClass: '4xx', bodyBytes: 0, noRedirect: true, noCapability: true },
      ],
    },
    consumers: { kinds: [...P11_CONSUMER_KINDS], controlVisible: true, privateMarkers: 0 },
    multiInstance: {
      instances: 2,
      sharedKeyPrefix: true,
      sharedHmacSecret: true,
      issueQuotaShared: true,
      downloadQuotaShared: true,
      completeQuotaShared: true,
      deniedZeroDbSideEffects: true,
      outage503DistinctFrom429: true,
      completeFallbackBounded: true,
      recoveryRestoresQuota: true,
    },
    restart: { outcome: 'recovered', bindingPreserved: true },
    commitUnknown: { finalizeReplayIdempotent: true, rereadsDatabase: true },
    providerUnknown: { absentDeleteIdempotent: true, activePreserved: true },
    i16Regression: {
      executed: true,
      subRunId,
      controls: 24,
      executedControls: 24,
      receiptsDigest: 'c'.repeat(64),
      postRunChecks: {
        databaseConverged: true,
        probeKeysAbsent: true,
        activeMarkerPreserved: true,
        processesClosed: true,
        residualPrefixClean: true,
      },
    },
    secretMarker: { placedIn: ['url_query', 'body'], scanClean: true },
    residual: { r2ExactKeysAbsent: true, redisPrefixClean: true, processesClosed: true },
    counts: { skips: 0, mocks: 0, secrets: 0, residuals: 0 },
    gates: {
      supporting: {
        schemaVersion: 2,
        task: 'phase4a-owner-private',
        schemaSealed: true,
        contracts: ['test:phase4a:p11:canonical-contract', 'test:phase4a:p11:unit'],
      },
      process: {
        runId: 'p11-fixture-run-0000-0000-4000-8000-000000000000',
        sourceRevision: 'a'.repeat(40),
        harness: 'phase4a-p11-process',
        pids: { apiA: 41001, apiB: 41002, worker: 41003, delivery: 41004 },
        origins: {
          apiA: 'http://127.0.0.1:41001',
          apiB: 'http://127.0.0.1:41002',
          delivery: 'http://127.0.0.2:41004',
        },
        workerStarted: true,
        injectCount: 0,
        workerDirectCallCount: 0,
        killRestartReceipts: [{ target: 'worker', signal: 'SIGKILL', exitCode: null, restartedPid: 42003 }],
      },
      environment: {
        runId: 'p11-fixture-run-0000-0000-4000-8000-000000000000',
        sourceRevision: 'a'.repeat(40),
        r2: 'real-cloudflare-r2',
        chromium: 'real-chromium',
        postgres: 'real-testcontainers',
        redis: 'real-testcontainers',
        i16RegressionRunId: subRunId,
        mocks: 0,
        skips: 0,
        retries: 0,
        secrets: 0,
        residuals: 0,
      },
    },
    limitations: ['fixture', 'not a real run'],
    canonicalDigest: '',
  };
  return { ...bundle, ...overrides } as P11EvidenceBundle;
}

/** Fixture bundle with the canonical digest sealed (readonly-safe spread). */
export function p11SealedBundle(overrides: Record<string, unknown> = {}): P11EvidenceBundle {
  const bundle = p11FixtureBundle(overrides);
  return { ...bundle, canonicalDigest: computeP11CanonicalDigest(bundle) };
}
