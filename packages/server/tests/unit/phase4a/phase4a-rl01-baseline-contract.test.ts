/**
 * P4A-RL01 evidence runner composition contracts (plan §8 RL01 evidence
 * scope). These tests pin the FAIL-CLOSED contract of
 * `evidence:phase4a-attachment-admission-baseline` WITHOUT running the
 * probe:
 *
 *  - the multi-instance fact: two independent process-local limiter instances
 *    (the ONLY limiter that exists before RL04) double a principal's budget,
 *    so multi-instance local limiting cannot form a global quota — the exact
 *    fact the evidence run re-proves through the production admission port
 *    over real PostgreSQL;
 *  - the denied-path ordering contract: a limiter denial short-circuits
 *    BEFORE the database unit of work and the ledger read (zero expensive
 *    work), which the evidence run records as `deniedPath` with real counts;
 *  - the fixed artifact schema (`assertRl01EvidenceShape`) rejects drift
 *    (missing/unknown fields, non-fixed route/kind values, non-zero
 *    use-case-level DB/R2 counts, forbidden field names) and the runtime
 *    secret scan rejects any runtime identifier in the serialized bundle;
 *  - the runtime environment parses through the REAL production loader and
 *    the evidence CLI maps every failure to a stable machine code.
 *
 * The real PostgreSQL/limiter composition is exercised only by
 * `npm run evidence:phase4a-attachment-admission-baseline` (wrapped by
 * `scripts/with-postgres.mjs`); these tests import the production module
 * limiter/use case and the REAL script constants, never a mock repository.
 */
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import {
  DELIVERY_RATE_LIMIT_MAX_PER_WINDOW,
  DELIVERY_RATE_LIMIT_MAX_TRACKED_PRINCIPALS,
  DELIVERY_RATE_LIMIT_WINDOW_SECONDS,
  authorizeOwnerDownload,
  createDeliveryRateLimiter,
  createHmacOwnerDeliveryCapabilitySigner,
} from '../../../src/modules/attachments/index.js';
import { makeP03Config } from '../../support/phase4a-p03-test-helpers.js';
import {
  PRODUCT_ORIGIN,
  RL01_DEFAULT_EVIDENCE_OUTPUT,
  RL01_DELIVERY_ORIGIN,
  RL01_EVIDENCE_SCHEMA_VERSION,
  RL01_LIMITER_MECHANISM,
  RL01_ROUTES,
  RL01_SCENARIO_KINDS,
  RL01_TASK,
  assertRl01EvidenceShape,
  latencyBucketFor,
  rl01EvidenceRuntimeEnvironment,
  rl01FailureDetail,
  scanRl01EvidenceForForbiddenValues,
  stableRl01FailureCode,
  type Rl01EvidenceBundle,
} from '../../../scripts/phase4a-attachment-admission-baseline.js';

const DATABASE_URL = 'postgresql://known:known@127.0.0.1:5432/known';

// ---------------------------------------------------------------------------
// Fail-closed CLI contract
// ---------------------------------------------------------------------------

test('the evidence runtime environment parses through the real production loader', () => {
  const env = rl01EvidenceRuntimeEnvironment(DATABASE_URL);
  assert.equal(env.PRODUCT_ORIGIN, PRODUCT_ORIGIN);
  assert.ok(env.DATABASE_URL.startsWith('postgresql://'));
  const config = loadConfig(env);
  assert.equal(config.attachments?.enabled, true, 'the baseline runs the attachments capability');
  assert.equal(config.attachments.isolatedDeliveryOrigin, RL01_DELIVERY_ORIGIN);
  assert.equal(config.attachments.deliveryCapabilityTtlSeconds, 60);
  assert.ok(config.attachments.r2.rwSecretRef.startsWith('known/'), 'secret fields stay opaque references');
  assert.ok(config.attachments.r2.roSecretRef.startsWith('known/'));
  assert.ok(config.attachments.deliveryCapabilitySecretRef.startsWith('known/'));
  // i05 contract: the delivery audience is an exact https origin on a
  // registrable domain DIFFERENT from the application origin.
  const appHost = new URL(PRODUCT_ORIGIN).hostname;
  const deliveryHost = new URL(RL01_DELIVERY_ORIGIN).hostname;
  assert.notEqual(appHost, deliveryHost);
  const appRegistrable = appHost.split('.').slice(-2).join('.');
  const deliveryRegistrable = deliveryHost.split('.').slice(-2).join('.');
  assert.notEqual(appRegistrable, deliveryRegistrable, 'delivery origin must not be same-site with the app');
});

test('a missing database URL fails closed with configuration_missing', () => {
  assert.throws(() => rl01EvidenceRuntimeEnvironment(''), /configuration_missing/);
  assert.throws(() => rl01EvidenceRuntimeEnvironment('   '), /configuration_missing/);
});

test('stable failure codes classify every fail-closed exit', () => {
  assert.equal(stableRl01FailureCode(new Error('configuration_missing:DATABASE_URL')), 'configuration_missing');
  assert.equal(stableRl01FailureCode(new Error('source_revision_unavailable')), 'source_revision_unavailable');
  assert.equal(stableRl01FailureCode(new Error('source_worktree_not_clean')), 'source_worktree_not_clean');
  assert.equal(stableRl01FailureCode(new Error('scenario_failed:download_limiter_denied_http')), 'scenario_failed');
  assert.equal(stableRl01FailureCode(new Error('denied_path_zero_work_failed:download')), 'denied_path_zero_work_failed');
  assert.equal(stableRl01FailureCode(new Error('multi_instance_amplification_failed:twoInstances')), 'multi_instance_amplification_failed');
  assert.equal(stableRl01FailureCode(new Error('artifact_secret_scan_failed')), 'artifact_secret_scan_failed');
  assert.equal(stableRl01FailureCode(new Error('evidence_schema:scenarios[0].route')), 'evidence_schema');
  assert.equal(stableRl01FailureCode(new Error('boom')), 'rl01_failed');
  assert.equal(stableRl01FailureCode('nope'), 'rl01_failed');
  assert.equal(rl01FailureDetail(new Error('configuration_missing:DATABASE_URL')), 'DATABASE_URL');
  assert.equal(rl01FailureDetail(new Error('scenario_failed')), undefined);
});

test('fixed latency buckets follow the sealed boundaries (diagnostic annotation only)', () => {
  assert.equal(latencyBucketFor(0), 'under_10ms');
  assert.equal(latencyBucketFor(9.99), 'under_10ms');
  assert.equal(latencyBucketFor(10), 'under_100ms');
  assert.equal(latencyBucketFor(99.99), 'under_100ms');
  assert.equal(latencyBucketFor(100), 'under_1s');
  assert.equal(latencyBucketFor(999.99), 'under_1s');
  assert.equal(latencyBucketFor(1_000), 'under_10s');
  assert.equal(latencyBucketFor(9_999.99), 'under_10s');
  assert.equal(latencyBucketFor(10_000), 'over_10s');
});

// ---------------------------------------------------------------------------
// Multi-instance fact (production limiter module; the evidence run re-proves
// it through the production admission port over real PostgreSQL)
// ---------------------------------------------------------------------------

test('two independent process-local limiter instances double a principal budget', () => {
  // Production policy pin: the evidence run asserts the amplification FACT
  // against these constants, so a policy change must revisit both.
  assert.equal(DELIVERY_RATE_LIMIT_WINDOW_SECONDS, 60);
  assert.equal(DELIVERY_RATE_LIMIT_MAX_PER_WINDOW, 30);
  assert.equal(DELIVERY_RATE_LIMIT_MAX_TRACKED_PRINCIPALS, 4_096);

  const policy = { windowSeconds: 60, maxPerWindow: 3, maxTrackedPrincipals: 16 };
  const now = () => new Date('2026-08-08T00:00:00.000Z');
  const principal = 'principal-quota';

  // Single instance: exactly `budget` allowed, the next attempt denied.
  const single = createDeliveryRateLimiter(policy);
  const singleAllowed = [1, 2, 3, 4].filter(() => single.check(principal, now()).allowed).length;
  assert.equal(singleAllowed, 3);
  assert.equal(single.check(principal, now()).allowed, false, 'budget exhausted');

  // Two instances with INDEPENDENT local state: each admits `budget`, so the
  // same principal is allowed 2×budget across the pair — local limiters
  // cannot form a global quota.
  const first = createDeliveryRateLimiter(policy);
  const second = createDeliveryRateLimiter(policy);
  const firstAllowed = [1, 2, 3].filter(() => first.check(principal, now()).allowed).length;
  const secondResults = [1, 2, 3, 4].map(() => second.check(principal, now()));
  const secondAllowed = secondResults.filter((result) => result.allowed).length;
  assert.equal(secondResults[3]!.allowed, false);
  assert.equal(firstAllowed, 3);
  assert.equal(secondAllowed, 3);
  assert.equal(firstAllowed + secondAllowed, 2 * policy.maxPerWindow);
  assert.equal((firstAllowed + secondAllowed) / policy.maxPerWindow, 2);
  assert.notEqual(first.trackedCount() + second.trackedCount(), 1,
    'the two instances must hold separate per-principal buckets');
});

// ---------------------------------------------------------------------------
// Denied-path ordering contract (zero expensive work before the limiter)
// ---------------------------------------------------------------------------

test('a limiter denial short-circuits before the database unit of work and ledger read', async () => {
  const config = makeP03Config({
    isolatedDeliveryOrigin: RL01_DELIVERY_ORIGIN,
    deliveryCapabilitySecretRef: 'known/rl01/delivery/hmac',
  });
  const signer = createHmacOwnerDeliveryCapabilitySigner({
    secret: Buffer.from('rl01-contract-delivery-hmac-secret-0123456789', 'utf8'),
    audienceOrigin: RL01_DELIVERY_ORIGIN,
  });
  const limiter = createDeliveryRateLimiter({ windowSeconds: 60, maxPerWindow: 1, maxTrackedPrincipals: 4 });
  let uowCalls = 0;
  let ledgerCalls = 0;
  const uow = {
    execute: async (work: (context: { transaction: unknown }) => Promise<unknown>) => {
      uowCalls += 1;
      return work({ transaction: {} });
    },
  };
  const ledger = {
    findBlobForDelivery: async () => {
      ledgerCalls += 1;
      return { outcome: 'not_found' as const };
    },
  };
  const deps = {
    ledger: ledger as never,
    accessPolicyFor: (() => ({})) as never,
    uow: uow as never,
    capabilitySigner: signer,
    rateLimiter: limiter,
    config,
    now: () => new Date('2026-08-08T00:00:00.000Z'),
  };
  const actor = { principalId: 'principal-denied', subjectId: 'subject-denied', kind: 'account' as const };

  // First attempt: the limiter allows (token 1/1); the admission then reads
  // the ledger and conceals the absent blob as 404.
  const first = await authorizeOwnerDownload(deps as never, { actor, blobId: 'blob-absent-a' });
  assert.equal(first.outcome, 'denied');
  assert.equal(uowCalls, 1, 'an allowed admission reaches the database unit of work');
  assert.equal(ledgerCalls, 1);

  // Second attempt in the same window: the limiter DENIES before any
  // database work — zero queries, zero ledger reads (and the admission use
  // case structurally has no object-store port, so zero R2 calls).
  const second = await authorizeOwnerDownload(deps as never, { actor, blobId: 'blob-absent-b' });
  assert.equal(second.outcome, 'rate_limited');
  assert.equal(uowCalls, 1, 'limiter denial must happen before the database unit of work');
  assert.equal(ledgerCalls, 1, 'limiter denial must happen before the ledger read');
});

// ---------------------------------------------------------------------------
// Artifact schema + secret-scan contract
// ---------------------------------------------------------------------------

function validBundle(overrides: Partial<Rl01EvidenceBundle> = {}): Rl01EvidenceBundle {
  return {
    schemaVersion: RL01_EVIDENCE_SCHEMA_VERSION,
    task: RL01_TASK,
    verdict: 'pass',
    runId: '00000000-0000-4000-8000-000000000000',
    binding: {
      sourceRevision: 'a'.repeat(40),
      sourceTreeHash: 'b'.repeat(40),
      sourceClean: true,
      migrationHead: '202608080500_phase4a_p02_attachment_metadata',
      nodeVersion: 'v24.9.0',
      npmVersion: '11.7.0',
      postgresVersion: 'PostgreSQL 16.4',
      dependencyVersions: { pg: '8.22.0', fastify: '5.10.0', kysely: '0.29.4' },
      limiter: {
        mechanism: RL01_LIMITER_MECHANISM,
        windowSeconds: 60,
        maxPerWindow: 30,
        maxTrackedPrincipals: 4_096,
      },
      boundary: {
        postgres: 'real',
        r2: 'port-decorator-counting',
        redis: 'not-used',
        chromium: 'not-used',
        attachmentCache: 'absent',
      },
      setup: { fixtureStartupExcluded: true, instrumentationStartedAfterSetup: true },
    },
    scenarios: [{
      scenario: 'issue_normal',
      route: 'issue',
      kind: 'normal',
      cold: true,
      requests: [{ status: 201, statusClass: '2xx', durationMs: 12.5 }],
      db: {
        queries: 6,
        rows: 9,
        queryErrors: 0,
        lockWaitMaxConcurrent: 0,
        lockWaitSampleCount: 2,
        lockWaitSamplesWithWaits: 0,
        latencyBuckets: {
          under_10ms: 2, under_100ms: 4, under_1s: 0, under_10s: 0, over_10s: 0,
        },
        pool: { peakTotal: 6, peakActive: 5, peakIdle: 3, peakWaiting: 1 },
      },
      r2: { headExact: 0, readBounded: 0, deleteExact: 0, confirmAbsent: 0, total: 0 },
    }],
    multiInstance: {
      budgetPerInstance: 30,
      singleInstance: { instances: 1, allowed: 30, denied: 1, dbQueries: 120, r2Calls: 0 },
      twoInstances: {
        instances: 2,
        instance1Allowed: 30,
        instance2Allowed: 30,
        totalAllowed: 60,
        denied: 1,
        dbQueries: 240,
        r2Calls: 0,
      },
      amplificationFactor: 2,
      globalQuotaEnforced: false,
      mechanism: RL01_LIMITER_MECHANISM,
    },
    deniedPath: {
      useCaseLevel: { rateLimitedRequests: 1, dbQueries: 0, r2Calls: 0, zeroExpensiveWork: true },
      httpLevel: { status: 429, statusClass: '4xx', dbQueries: 3, r2Calls: 0 },
    },
    metricsSurface: {
      operations: ['issue', 'complete', 'status', 'finalize', 'download', 'verify', 'cleanup', 'deliver', 'query'],
      states: ['ok', 'failed', 'retryable', 'denied', 'unknown'],
      errorClasses: ['none', 'provider_retryable', 'provider_denied', 'provider_not_found', 'unknown_outcome', 'contract_corruption', 'lease_lost', 'database', 'internal'],
      sizeBuckets: ['zero', 'under_1mib', 'under_16mib', 'under_64mib', 'over_64mib'],
      latencyBuckets: ['under_10ms', 'under_100ms', 'under_1s', 'under_10s', 'over_10s'],
      rateLimitDecisions: ['none', 'allowed', 'denied', 'unavailable', 'fallback'],
      gaugeNames: ['verification_backlog', 'cleanup_backlog', 'quarantine_count', 'dead_letter_count', 'pool_total', 'pool_idle', 'pool_active', 'pool_waiting', 'pool_max_waiting'],
      counterSpace: 12,
      recordedCounters: [{
        labels: {
          operation: 'issue', state: 'ok', errorClass: 'none',
          sizeBucket: 'under_1mib', latencyBucket: 'under_1s', rateLimitDecision: 'none',
        },
        count: 1,
      }],
    },
    limitations: ['shared-host latencies are diagnostic only; no Attachment cache exists'],
    finishedAtIso: '2026-08-08T00:00:00.000Z',
    ...overrides,
  };
}

test('the fixed evidence schema accepts a well-formed bundle and rejects drift', () => {
  const bundle = validBundle();
  assertRl01EvidenceShape(bundle);
  assert.throws(() => assertRl01EvidenceShape({ ...bundle, schemaVersion: 2 }), /evidence_schema/);
  assert.throws(() => assertRl01EvidenceShape({ ...bundle, task: 'phase4a-rl99' }), /evidence_schema/);
  assert.throws(() => assertRl01EvidenceShape({ ...bundle, verdict: 'fail' }), /evidence_schema/);
  assert.throws(() => assertRl01EvidenceShape({ ...bundle, extra: 1 }), /evidence_schema/);
  assert.throws(() => assertRl01EvidenceShape({
    ...bundle,
    scenarios: [{ ...bundle.scenarios[0]!, route: 'replacement' }],
  }), /evidence_schema/);
  assert.throws(() => assertRl01EvidenceShape({
    ...bundle,
    scenarios: [{ ...bundle.scenarios[0]!, kind: 'shadow' }],
  }), /evidence_schema/);
  assert.throws(() => assertRl01EvidenceShape({
    ...bundle,
    scenarios: [{ ...bundle.scenarios[0]!, requests: [{ status: 200, statusClass: '2xx', durationMs: 1, blobId: 'x' }] }],
  }), /forbidden_evidence_field/);
  assert.throws(() => assertRl01EvidenceShape({
    ...bundle,
    scenarios: [{ ...bundle.scenarios[0]!, r2: { ...bundle.scenarios[0]!.r2, total: 1 } }],
  }), /evidence_schema/, 'r2 total must equal the sum of the four call counters');
  // The denied-path zero-work contract is part of the shape: a use-case-level
  // denial with any DB/R2 work cannot serialize as a valid artifact.
  assert.throws(() => assertRl01EvidenceShape({
    ...bundle,
    deniedPath: {
      ...bundle.deniedPath,
      useCaseLevel: { ...bundle.deniedPath.useCaseLevel, dbQueries: 2 },
    },
  }), /zero_expensive_work/);
  assert.throws(() => assertRl01EvidenceShape({
    ...bundle,
    deniedPath: {
      ...bundle.deniedPath,
      useCaseLevel: { ...bundle.deniedPath.useCaseLevel, zeroExpensiveWork: false },
    },
  }), /zero_expensive_work/);
  // The multi-instance amplification fact is part of the shape: a run that
  // did not observe 2×budget across two instances cannot serialize.
  assert.throws(() => assertRl01EvidenceShape({
    ...bundle,
    multiInstance: {
      ...bundle.multiInstance,
      twoInstances: { ...bundle.multiInstance.twoInstances, totalAllowed: 30 },
    },
  }), /evidence_schema/);
  assert.throws(() => assertRl01EvidenceShape({
    ...bundle,
    multiInstance: { ...bundle.multiInstance, amplificationFactor: 1 },
  }), /evidence_schema/);
  // Fixed route/kind sets are sealed in the schema contract.
  assert.deepEqual(RL01_ROUTES, ['issue', 'complete', 'status', 'finalize', 'download', 'verify']);
  assert.deepEqual(RL01_SCENARIO_KINDS, ['normal', 'denied', 'concurrent', 'quota', 'convergence']);
  assert.equal(RL01_EVIDENCE_SCHEMA_VERSION, 1);
  assert.ok(RL01_DEFAULT_EVIDENCE_OUTPUT.endsWith('.json'));
});

test('the runtime secret scan rejects any runtime identifier in the serialized bundle', () => {
  const marker = `rl01-forbidden-marker-${Date.now()}`;
  const bundle = validBundle();
  scanRl01EvidenceForForbiddenValues(bundle, [marker]);
  assert.throws(() => scanRl01EvidenceForForbiddenValues(
    { ...bundle, limitations: [...bundle.limitations, `observed ${marker}`] },
    [marker],
  ), /artifact_secret_scan_failed/);
  assert.throws(() => scanRl01EvidenceForForbiddenValues(
    { ...bundle, runId: marker },
    [marker],
  ), /artifact_secret_scan_failed/);
  // A marker shaped like a collection/principal/blob identity is rejected
  // from the scenario records too.
  assert.throws(() => scanRl01EvidenceForForbiddenValues(
    { ...bundle, scenarios: [{ ...bundle.scenarios[0]!, scenario: `issue_${marker}` }] },
    [marker],
  ), /artifact_secret_scan_failed/);
});
