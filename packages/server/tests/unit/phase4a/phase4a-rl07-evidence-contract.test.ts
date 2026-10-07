/**
 * P4A-RL07 evidence / validator / runbook contracts (plan §8 RL07, §11
 * matrix: clean retained revision + independent validator; §12 fixed
 * evidence requirements; §13 rollout/alert/rollback commands).
 *
 * Pins the FAIL-CLOSED contract of `evidence:phase4a-redis-rate-limit` and
 * its INDEPENDENT validator WITHOUT running the evidence command (real
 * Redis/PostgreSQL scenarios run only via the evidence CLI on a clean
 * retained revision): the fixed artifact schema rejects drift, the secret
 * marker scan reports position classes only (never echoing markers), the
 * validator is a SEPARATE artifact that recomputes the canonical digest and
 * verifies binding/gate/outage facts and runbook replay at schema level,
 * dirty revisions are rejected, and the runbook carries the plan §13 command
 * surface with prohibitions and no secret samples.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'vitest';
import {
  RL07_DEFAULT_EVIDENCE_OUTPUT,
  RL07_EVIDENCE_SCHEMA_VERSION,
  RL07_KEY_PREFIX_MARKER,
  RL07_MIGRATION_HEAD,
  lexicalMigrationHeadFromDisk,
  RL07_RUNBOOK_COMMANDS,
  RL07_RUNBOOK_PATH,
  RL07_SCENARIO_KINDS,
  RL07_SCENARIO_NAMES,
  RL07_TASK,
  assertRl07EvidenceShape,
  computeRl07CanonicalDigest,
  computeRl07ConfigDigest,
  computeRl07RedisAlgorithmDigest,
  rl07FailureDetail,
  rl07SourceDirty,
  scanRl07EvidenceForForbiddenValues,
  stableRl07FailureCode,
  type Rl07EvidenceBundle,
} from '../../../scripts/phase4a-redis-rate-limit-evidence.js';

// The validator is plain Node ESM; vitest can import it directly. It must
// stay a SEPARATE artifact (no shared implementation with the runner).
const validator = await import('../../../scripts/phase4a-redis-rate-limit-validate-evidence.mjs');

const RUNBOOK = new URL('../../../docs/runbooks/attachments-redis-rate-limit-operations.md', import.meta.url);

// ---------------------------------------------------------------------------
// Fixture bundle (deterministic; every fact satisfies the fixed schema)
// ---------------------------------------------------------------------------

const FIXTURE_RUN_ID = 'rl07-fixture-run-0000-0000-4000-8000-000000000000';
const FIXTURE_STATUSES = {
  quota: [201, 201, 201, 201, 201, 201, 429],
  downloadDenied: [200, 200, 429, 429],
  completeDenied: [200, 200, 200, 200, 429, 429],
  outage: [503, 503, 503, 503, 200, 200, 200, 200, 429, 429],
  recovery: [201, 201, 429],
};

function fixtureConfigFacts() {
  return {
    mode: 'enforce',
    required: true,
    keyPrefix: RL07_KEY_PREFIX_MARKER,
    commandTimeoutMs: 750,
    connectTimeoutMs: 3000,
    maxRetriesPerRequest: 1,
    routes: {
      issue: { rateMax: 6, rateWindowMs: 60000 },
      complete: { rateMax: 4, rateWindowMs: 60000 },
      download: { rateMax: 2, rateWindowMs: 60000 },
    },
    completeEmergency: { rateMax: 2, rateWindowMs: 60000 },
    redisConfigured: true,
    keySecretConfigured: true,
  };
}

function fixtureAlgorithmFacts() {
  return {
    luaScriptName: 'rate_limit_fixed_window_v1',
    luaScriptVersion: 1,
    keySchemaVersion: 1,
    windowSource: 'redis-server-time',
    decisionShape: ['allowed', 'count', 'remaining', 'retryAfterSeconds', 'windowStartEpochMs'],
  };
}

/** Deterministic fixed-schema evidence bundle (the RL07 fixture). */
function rl07FixtureBundle(overrides: Record<string, unknown> = {}): Rl07EvidenceBundle {
  const configFacts = fixtureConfigFacts();
  const algorithmFacts = fixtureAlgorithmFacts();
  const binding = {
    sourceRevision: 'a'.repeat(40), sourceTreeHash: 'b'.repeat(40), sourceClean: true,
    migrationHead: RL07_MIGRATION_HEAD, nodeVersion: 'v24.9.0', npmVersion: '11.7.0',
    postgresVersion: 'PostgreSQL 16.4', redisVersion: '7.2.8',
    dependencyVersions: { pg: '8.22.0', fastify: '5.10.0', kysely: '0.29.4', ioredis: '6.0.0', testcontainers: '12.0.4' },
    configDigest: computeRl07ConfigDigest(configFacts), configFacts,
    redisAlgorithmDigest: computeRl07RedisAlgorithmDigest(algorithmFacts), redisAlgorithmFacts: algorithmFacts,
    boundary: { postgres: 'real', redis: 'real-testcontainers', r2: 'local-object-server-counting', chromium: 'not-used', attachmentCache: 'absent' },
  };
  const profile = {
    mode: 'enforce', required: true, apiInstances: 2,
    multiReplicaGate: { attachmentsEnabled: true, production: true, multiReplica: true, mode: 'enforce', required: true, violation: null },
  };
  const quota = {
    route: 'issue', budgetPerWindow: 6, windowMs: 60000, instances: 2, allowedTotal: 6, deniedTotal: 1,
    perInstance: { a: { served: 4, allowed: 3, evalshaCalls: 4 }, b: { served: 3, allowed: 3, evalshaCalls: 3 } },
    dbRowsCreated: 6, r2Calls: 0, deniedPath: { dbRowsCreated: 0, r2Calls: 0 },
    counterKeyCount: 1, counterValue: 7, canonicalKeys: true,
  };
  const sideEffects = {
    issueDenied: { attempts: 3, statuses: [429, 429, 429], dbRowsCreated: 0, r2Calls: 0 },
    downloadDenied: { attempts: 2, statuses: [429, 429], useCaseCalls: 0, r2Calls: 0 },
    completeDenied: { attempts: 2, statuses: [429, 429], outboxEvents: 0, r2Calls: 0 },
  };
  const outage = {
    stopped: true, restarted: true,
    issue: { attempts: 2, statuses: [503, 503], problemCode: 'rate_limit_unavailable', retryAfterPresent: false, dbRowsCreated: 0, r2Calls: 0 },
    download: { attempts: 2, statuses: [503, 503], useCaseCalls: 0, r2Calls: 0 },
    complete: { emergencyBudgetPerInstance: 2, attempts: 6, statuses: [200, 200, 200, 200, 429, 429], outboxEvents: 1, r2Calls: 4, fallbackLogEntries: 4, deniedLogEntries: 2, failureClass: 'unavailable', readiness: 'degraded' },
    recovery: { healthBarrierProbed: true, quotaRestored: true, allowed: 2, denied: 1, dbRowsCreated: 2, r2Calls: 0 },
  };
  const scenarioSteps = [
    { scenario: 'quota_shared_multi_instance', route: 'issue', kind: 'quota', statuses: FIXTURE_STATUSES.quota, dbRowsCreated: 6, outboxEvents: 0, r2Calls: 0, useCaseCalls: 0 },
    { scenario: 'download_denied_zero_work', route: 'download', kind: 'denied', statuses: FIXTURE_STATUSES.downloadDenied, dbRowsCreated: 0, outboxEvents: 0, r2Calls: 0, useCaseCalls: 2 },
    { scenario: 'complete_denied_zero_work', route: 'complete', kind: 'denied', statuses: FIXTURE_STATUSES.completeDenied, dbRowsCreated: 0, outboxEvents: 1, r2Calls: 4, useCaseCalls: 0 },
    { scenario: 'outage_fail_closed', route: 'mixed', kind: 'outage', statuses: FIXTURE_STATUSES.outage, dbRowsCreated: 0, outboxEvents: 1, r2Calls: 4, useCaseCalls: 0 },
    { scenario: 'recovery_restores_quota', route: 'issue', kind: 'recovery', statuses: FIXTURE_STATUSES.recovery, dbRowsCreated: 2, outboxEvents: 0, r2Calls: 0, useCaseCalls: 0 },
  ];
  const bundle = {
    schemaVersion: RL07_EVIDENCE_SCHEMA_VERSION, task: RL07_TASK, verdict: 'pass', runId: FIXTURE_RUN_ID,
    startedAtIso: '2026-08-10T00:00:00.000Z', finishedAtIso: '2026-08-10T00:05:00.000Z',
    binding, profile, quota, sideEffects, outage,
    counts: { scenarios: scenarioSteps.length, skips: 0, mocks: 0, fallbacks: outage.complete.fallbackLogEntries, secrets: 0, residuals: 0 },
    scenarioSteps,
    runbook: { path: RL07_RUNBOOK_PATH, commands: [...RL07_RUNBOOK_COMMANDS] },
    limitations: ['shared-host latencies are diagnostic annotations only; the gates are counts and resource ranges'],
    canonicalDigest: 'f'.repeat(64),
    ...overrides,
  } as Rl07EvidenceBundle;
  return { ...bundle, canonicalDigest: computeRl07CanonicalDigest(bundle) };
}

// ---------------------------------------------------------------------------
// Fixed schema contract (runner-side)
// ---------------------------------------------------------------------------

test('the fixed evidence schema accepts a well-formed bundle and rejects drift', () => {
  const bundle = rl07FixtureBundle();
  assertRl07EvidenceShape(bundle);
  assert.throws(() => assertRl07EvidenceShape({ ...bundle, schemaVersion: 2 }), /evidence_schema/);
  assert.throws(() => assertRl07EvidenceShape({ ...bundle, task: 'phase4a-rl99' }), /evidence_schema/);
  assert.throws(() => assertRl07EvidenceShape({ ...bundle, verdict: 'fail' }), /evidence_schema/);
  assert.throws(() => assertRl07EvidenceShape({ ...bundle, extra: 1 }), /evidence_schema/);
  // A dirty recorded revision can never serialize as a valid artifact.
  assert.throws(() => assertRl07EvidenceShape({
    ...bundle,
    binding: { ...bundle.binding, sourceClean: false },
  }), /evidence_schema/);
  // A non-zero skip/mock/secret/residual count is contract corruption.
  for (const key of ['skips', 'mocks', 'secrets', 'residuals']) {
    assert.throws(() => assertRl07EvidenceShape({
      ...bundle,
      counts: { ...bundle.counts, [key]: 1 },
    }), /evidence_schema/, `${key} must stay zero`);
  }
  // Scenario names/routes/kinds are sealed in the contract.
  assert.deepEqual(RL07_SCENARIO_NAMES, [
    'quota_shared_multi_instance', 'download_denied_zero_work', 'complete_denied_zero_work',
    'outage_fail_closed', 'recovery_restores_quota',
  ]);
  assert.deepEqual(RL07_SCENARIO_KINDS, ['quota', 'denied', 'outage', 'recovery']);
  assert.throws(() => assertRl07EvidenceShape({
    ...bundle,
    scenarioSteps: [{ ...bundle.scenarioSteps[0]!, scenario: 'quota_tampered' }],
  }), /evidence_schema/);
  assert.throws(() => assertRl07EvidenceShape({
    ...bundle,
    scenarioSteps: [{ ...bundle.scenarioSteps[0]!, kind: 'shadow' }],
  }), /evidence_schema/);
  // Runbook command drift fails closed.
  assert.throws(() => assertRl07EvidenceShape({
    ...bundle,
    runbook: { ...bundle.runbook, commands: bundle.runbook.commands.slice(1) },
  }), /evidence_schema/);
  assert.throws(() => assertRl07EvidenceShape({
    ...bundle,
    runbook: { path: 'docs/runbooks/other.md', commands: bundle.runbook.commands },
  }), /evidence_schema/);
  // The key prefix must stay the fixed redacted marker (no run identifier).
  assert.throws(() => assertRl07EvidenceShape({
    ...bundle,
    binding: {
      ...bundle.binding,
      configFacts: { ...bundle.binding.configFacts, keyPrefix: 'rl07-3f2a9b' },
      configDigest: computeRl07ConfigDigest({ ...bundle.binding.configFacts, keyPrefix: 'rl07-3f2a9b' }),
    },
  }), /evidence_schema/);
  assert.equal(RL07_EVIDENCE_SCHEMA_VERSION, 1);
  assert.ok(RL07_DEFAULT_EVIDENCE_OUTPUT.endsWith('phase4a-redis-rate-limit.json'));
  assert.equal(RL07_KEY_PREFIX_MARKER, '<run-random>');
});

test('the schema enforces the quota, outage and recovery facts (fail-closed totals)', () => {
  const bundle = rl07FixtureBundle();
  // Quota precision: allowedTotal must equal the budget and the per-instance
  // allocation must sum to it; the shared counter must equal allowed+denied.
  assert.throws(() => assertRl07EvidenceShape({
    ...bundle,
    quota: { ...bundle.quota, allowedTotal: 5 },
  }), /evidence_schema/);
  assert.throws(() => assertRl07EvidenceShape({
    ...bundle,
    quota: { ...bundle.quota, perInstance: { ...bundle.quota.perInstance, a: { ...bundle.quota.perInstance.a, allowed: 2 } } },
  }), /evidence_schema/);
  assert.throws(() => assertRl07EvidenceShape({
    ...bundle,
    quota: { ...bundle.quota, dbRowsCreated: 5 },
  }), /evidence_schema/, 'allowed issues must equal the ledger rows created');
  assert.throws(() => assertRl07EvidenceShape({
    ...bundle,
    quota: { ...bundle.quota, deniedPath: { dbRowsCreated: 1, r2Calls: 0 } },
  }), /evidence_schema/);
  assert.throws(() => assertRl07EvidenceShape({
    ...bundle,
    quota: { ...bundle.quota, r2Calls: 1 },
  }), /evidence_schema/, 'issue does zero R2 work');
  // Side effects: denied bursts stay at zero DB/R2/use-case work.
  assert.throws(() => assertRl07EvidenceShape({
    ...bundle,
    sideEffects: { ...bundle.sideEffects, downloadDenied: { ...bundle.sideEffects.downloadDenied, useCaseCalls: 1 } },
  }), /evidence_schema/);
  assert.throws(() => assertRl07EvidenceShape({
    ...bundle,
    sideEffects: { ...bundle.sideEffects, completeDenied: { ...bundle.sideEffects.completeDenied, outboxEvents: 1 } },
  }), /evidence_schema/);
  // Outage: fail-closed 503s carry the fixed problem class and zero facts.
  assert.throws(() => assertRl07EvidenceShape({
    ...bundle,
    outage: { ...bundle.outage, issue: { ...bundle.outage.issue, retryAfterPresent: true } },
  }), /evidence_schema/, 'a 503 must never fabricate a Retry-After');
  assert.throws(() => assertRl07EvidenceShape({
    ...bundle,
    outage: { ...bundle.outage, issue: { ...bundle.outage.issue, problemCode: 'rate_limited' } },
  }), /evidence_schema/, 'an outage is an infrastructure failure, never a quota fact');
  // The emergency fallback is BOUNDED: exactly 2 per instance, then a real
  // local quota fact; outbox/R2 deltas match the allowed fallbacks.
  assert.throws(() => assertRl07EvidenceShape({
    ...bundle,
    outage: { ...bundle.outage, complete: { ...bundle.outage.complete, fallbackLogEntries: 6 } },
  }), /evidence_schema/, 'an unbounded fallback cannot serialize');
  assert.throws(() => assertRl07EvidenceShape({
    ...bundle,
    outage: { ...bundle.outage, complete: { ...bundle.outage.complete, outboxEvents: 2 } },
  }), /evidence_schema/, 'exactly one verification job on the first fallback');
  assert.throws(() => assertRl07EvidenceShape({
    ...bundle,
    outage: { ...bundle.outage, complete: { ...bundle.outage.complete, r2Calls: 2 } },
  }), /evidence_schema/, 'r2 delta must equal the allowed fallbacks');
  // Recovery restored the quota with exact counts.
  assert.throws(() => assertRl07EvidenceShape({
    ...bundle,
    outage: { ...bundle.outage, recovery: { ...bundle.outage.recovery, quotaRestored: false } },
  }), /evidence_schema/);
  assert.throws(() => assertRl07EvidenceShape({
    ...bundle,
    outage: { ...bundle.outage, recovery: { ...bundle.outage.recovery, denied: 0 } },
  }), /evidence_schema/);
  // The multi-replica profile gate facts are sealed: enforce + required + 2.
  assert.throws(() => assertRl07EvidenceShape({
    ...bundle,
    profile: { ...bundle.profile, mode: 'shadow' },
  }), /evidence_schema/);
  assert.throws(() => assertRl07EvidenceShape({
    ...bundle,
    profile: { ...bundle.profile, apiInstances: 1 },
  }), /evidence_schema/);
  // Scenario-step statuses must match the observed bursts.
  assert.throws(() => assertRl07EvidenceShape({
    ...bundle,
    scenarioSteps: [{ ...bundle.scenarioSteps[0]!, statuses: [201, 201] }],
  }), /evidence_schema/);
});

test('forbidden field names are rejected anywhere in the bundle', () => {
  const bundle = rl07FixtureBundle();
  assert.throws(() => assertRl07EvidenceShape({
    ...bundle,
    runbook: { path: bundle.runbook.path, commands: bundle.runbook.commands, blobId: 'fixture-blob' },
  }), /forbidden_evidence_field/);
  assert.throws(() => assertRl07EvidenceShape({
    ...bundle,
    scenarioSteps: [{ ...bundle.scenarioSteps[0]!, secret: 'x' }],
  }), /forbidden_evidence_field/);
});

// ---------------------------------------------------------------------------
// Config digest / algorithm digest / canonical digest
// ---------------------------------------------------------------------------

test('config and Redis algorithm digests are deterministic and tamper-evident', () => {
  const first = computeRl07ConfigDigest(fixtureConfigFacts());
  const second = computeRl07ConfigDigest(fixtureConfigFacts());
  assert.equal(first, second);
  assert.match(first, /^[a-f0-9]{64}$/);
  const tampered = computeRl07ConfigDigest({ ...fixtureConfigFacts(), commandTimeoutMs: 5000 });
  assert.notEqual(first, tampered, 'a config change must change the digest');
  const algo = computeRl07RedisAlgorithmDigest(fixtureAlgorithmFacts());
  assert.match(algo, /^[a-f0-9]{64}$/);
  assert.notEqual(
    algo,
    computeRl07RedisAlgorithmDigest({ ...fixtureAlgorithmFacts(), luaScriptVersion: 2 }),
    'an algorithm change must change the digest',
  );
});

test('the independent validator recomputes the canonical digest and rejects tampering', () => {
  const bundle = rl07FixtureBundle();
  assert.equal(validator.computeDigest(bundle), bundle.canonicalDigest);
  assert.match(bundle.canonicalDigest, /^[a-f0-9]{64}$/);
  const tampered = { ...bundle, canonicalDigest: 'e'.repeat(64) };
  const result = validator.validateEvidenceBundle(tampered);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => /digest/i.test(error)));
  // A changed protocol fact is caught through the digest.
  const changed = {
    ...bundle,
    outage: { ...bundle.outage, recovery: { ...bundle.outage.recovery, allowed: 1 } },
  };
  const changedResult = validator.validateEvidenceBundle(changed);
  assert.equal(changedResult.ok, false);
  assert.ok(changedResult.errors.some((error) => /digest/i.test(error)));
});

// ---------------------------------------------------------------------------
// Secret marker scan (position classes only, never the marker value)
// ---------------------------------------------------------------------------

test('a synthetic marker in URL-query/metadata/body/provider-error/log positions is reported as a position class and never echoed', () => {
  const marker = `rl07-secret-marker-${randomUUID()}`;
  const positions = [
    `https://example.test/x?token=${marker}`,
    `x-amz-meta-note=${marker}`,
    Buffer.from(`body-${marker}`).toString('base64'),
    `provider error ${marker}`,
    `log context ${marker}`,
  ];
  for (const [index, leak] of positions.entries()) {
    const bundle = rl07FixtureBundle({ limitations: [leak] });
    assert.throws(
      () => scanRl07EvidenceForForbiddenValues(bundle, [marker]),
      /artifact_secret_scan_failed/,
      `position ${index} must fail the scan`,
    );
    // The scanner reports the position class; the marker value never appears
    // in the failure message.
    assert.throws(
      () => scanRl07EvidenceForForbiddenValues(bundle, [marker]),
      (error: unknown) => !String(error).includes(marker),
      `position ${index} must not echo the marker`,
    );
  }
  // The validator's independent scan reports the class without echoing either.
  const leaked = rl07FixtureBundle({ limitations: [marker] });
  const validatorResult = validator.validateEvidenceBundle(leaked, { forbiddenValues: [marker] });
  assert.equal(validatorResult.ok, false);
  assert.ok(validatorResult.errors.some((error) => /secret|sensitive/i.test(error)));
  assert.ok(validatorResult.errors.every((error) => !error.includes(marker)), 'the validator never echoes the marker');
  // A marker that was never serialized passes both scans.
  const clean = rl07FixtureBundle();
  scanRl07EvidenceForForbiddenValues(clean, [marker]);
  assert.equal(validator.validateEvidenceBundle(clean, { forbiddenValues: [marker] }).ok, true);
});

test('the serialized bundle carries no URL/credential/Redis-endpoint value classes', () => {
  const serialized = JSON.stringify(rl07FixtureBundle());
  assert.ok(!/https?:\/\//.test(serialized), 'no URL may serialize');
  assert.ok(!/redis:\/\//.test(serialized), 'no Redis endpoint may serialize');
  assert.ok(!/r2\.cloudflarestorage\.com/.test(serialized), 'no provider endpoint may serialize');
  for (const forbidden of ['accessKeyId', 'secretAccessKey', 'bearer ', 'authorization', 'password=']) {
    assert.ok(!serialized.toLowerCase().includes(forbidden), `forbidden class ${forbidden} must not serialize`);
  }
});

// ---------------------------------------------------------------------------
// Dirty revision rejection
// ---------------------------------------------------------------------------

test('dirty revisions are rejected at the runner check, the schema and the validator', () => {
  assert.equal(rl07SourceDirty(''), false);
  assert.equal(rl07SourceDirty(' M src/file.ts\n'), true);
  assert.equal(rl07SourceDirty('?? scripts/new.ts'), true);
  const bundle = rl07FixtureBundle();
  const dirty = validator.validateEvidenceBundle({ ...bundle, binding: { ...bundle.binding, sourceClean: false } });
  assert.equal(dirty.ok, false);
  assert.ok(dirty.errors.some((error) => /source/i.test(error)));
  const wrongRevision = validator.validateEvidenceBundle(bundle, { expectedRevision: 'c'.repeat(40) });
  assert.equal(wrongRevision.ok, false);
  assert.ok(wrongRevision.errors.some((error) => /revision/i.test(error)));
  const wrongHead = validator.validateEvidenceBundle({
    ...bundle,
    binding: { ...bundle.binding, migrationHead: 'not-a-migration' },
  });
  assert.equal(wrongHead.ok, false);
  assert.ok(wrongHead.errors.some((error) => /migration/i.test(error)));
});

// ---------------------------------------------------------------------------
// Versions, multi-replica gate, outage/recovery facts (validator)
// ---------------------------------------------------------------------------

test('the validator requires environment versions and binding facts', () => {
  const bundle = rl07FixtureBundle();
  const noRedis = validator.validateEvidenceBundle({
    ...bundle,
    binding: { ...bundle.binding, redisVersion: '' },
  });
  assert.equal(noRedis.ok, false);
  assert.ok(noRedis.errors.some((error) => /version/i.test(error)));
  const noNode = validator.validateEvidenceBundle({
    ...bundle,
    binding: { ...bundle.binding, nodeVersion: '' },
  });
  assert.equal(noNode.ok, false);
  assert.ok(noNode.errors.some((error) => /version/i.test(error)));
  // The config digest must match the recorded sanitized config facts.
  const digestDrift = validator.validateEvidenceBundle({
    ...bundle,
    binding: {
      ...bundle.binding,
      configFacts: { ...bundle.binding.configFacts, commandTimeoutMs: 100 },
      configDigest: computeRl07ConfigDigest({ ...bundle.binding.configFacts, commandTimeoutMs: 100 }),
    },
  });
  assert.equal(digestDrift.ok, true, 'a consistent digest recomputes');
  const digestTampered = validator.validateEvidenceBundle({
    ...bundle,
    binding: { ...bundle.binding, configFacts: { ...bundle.binding.configFacts, commandTimeoutMs: 100 } },
  });
  assert.equal(digestTampered.ok, false);
  assert.ok(digestTampered.errors.some((error) => /config/i.test(error)));
});

test('the validator enforces the multi-replica production gate facts', () => {
  const bundle = rl07FixtureBundle();
  const shadow = validator.validateEvidenceBundle({
    ...bundle,
    profile: { ...bundle.profile, mode: 'shadow' },
  });
  assert.equal(shadow.ok, false);
  assert.ok(shadow.errors.some((error) => /gate|profile/i.test(error)));
  const single = validator.validateEvidenceBundle({
    ...bundle,
    profile: { ...bundle.profile, apiInstances: 1 },
  });
  assert.equal(single.ok, false);
  assert.ok(single.errors.some((error) => /gate|profile/i.test(error)));
  const optional = validator.validateEvidenceBundle({
    ...bundle,
    profile: { ...bundle.profile, required: false },
  });
  assert.equal(optional.ok, false);
  assert.ok(optional.errors.some((error) => /gate|profile/i.test(error)));
});

test('the validator enforces the outage and recovery facts', () => {
  const bundle = rl07FixtureBundle();
  const noOutage = validator.validateEvidenceBundle({ ...bundle, outage: undefined });
  assert.equal(noOutage.ok, false);
  const notStopped = validator.validateEvidenceBundle({
    ...bundle,
    outage: { ...bundle.outage, stopped: false },
  });
  assert.equal(notStopped.ok, false);
  assert.ok(notStopped.errors.some((error) => /outage/i.test(error)));
  const unbounded = validator.validateEvidenceBundle({
    ...bundle,
    outage: { ...bundle.outage, complete: { ...bundle.outage.complete, fallbackLogEntries: 6 } },
  });
  assert.equal(unbounded.ok, false);
  assert.ok(unbounded.errors.some((error) => /fallback|outage/i.test(error)));
  const notRestored = validator.validateEvidenceBundle({
    ...bundle,
    outage: { ...bundle.outage, recovery: { ...bundle.outage.recovery, quotaRestored: false } },
  });
  assert.equal(notRestored.ok, false);
  assert.ok(notRestored.errors.some((error) => /recovery/i.test(error)));
});

test('a valid fixture bundle passes the independent validator with the full check list', () => {
  const result = validator.validateEvidenceBundle(rl07FixtureBundle());
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.ok(result.checks.length >= 6, 'schema/binding/gate/quota/outage/digest/secret checks all ran');
});

// ---------------------------------------------------------------------------
// Runner / validator separation
// ---------------------------------------------------------------------------

test('the validator is a separate artifact: the runner only spawns it, never imports it', async () => {
  const runnerSource = await readFile(new URL('../../../scripts/phase4a-redis-rate-limit-evidence.ts', import.meta.url), 'utf8');
  const validatorSource = await readFile(new URL('../../../scripts/phase4a-redis-rate-limit-validate-evidence.mjs', import.meta.url), 'utf8');
  // The runner references the validator ONLY as a subprocess path.
  assert.match(runnerSource, /phase4a-redis-rate-limit-validate-evidence\.mjs/u);
  assert.doesNotMatch(runnerSource, /from\s+['"]\.\/phase4a-redis-rate-limit-validate-evidence/u);
  assert.doesNotMatch(runnerSource, /import\(['"]\.\/phase4a-redis-rate-limit-validate-evidence/u);
  // The validator is plain Node ESM with zero relative/workspace imports
  // (it recomputes every digest with its own implementation).
  assert.match(validatorSource, /^import\s/mu);
  assert.doesNotMatch(validatorSource, /from\s+['"]\.\.?\//u);
  assert.doesNotMatch(validatorSource, /require\(/u);
  // Shared fixed constants are duplicated, and the test pins the agreement.
  assert.equal(validator.RL07_MIGRATION_HEAD, RL07_MIGRATION_HEAD);
  assert.equal(RL07_MIGRATION_HEAD, lexicalMigrationHeadFromDisk());
  assert.equal(validator.RL07_EVIDENCE_SCHEMA_VERSION, RL07_EVIDENCE_SCHEMA_VERSION);
  assert.equal(validator.RL07_TASK, RL07_TASK);
  assert.equal(validator.RL07_RUNBOOK_PATH, RL07_RUNBOOK_PATH);
  assert.deepEqual(validator.RL07_RUNBOOK_COMMANDS, RL07_RUNBOOK_COMMANDS);
});

// ---------------------------------------------------------------------------
// Runbook command replay contract (plan §13)
// ---------------------------------------------------------------------------

test('the runbook carries the plan §13 command surface and the rollback semantics', async () => {
  const doc = await readFile(RUNBOOK, 'utf8');
  for (const command of RL07_RUNBOOK_COMMANDS) {
    assert.match(doc, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'), command);
  }
  for (const token of ['灰度', 'shadow', 'enforce', '回滚', '重启', 'WAF', '缩', '残留', 'TTL',
    'ATTACHMENTS_RATE_LIMIT_MODE=off', 'complete', 'emergency', 'HMAC', 'drain', '低基数', '待补']) {
    assert.match(doc, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'iu'), token);
  }
  // Multi-instance off is a documented short-term incident pattern with an
  // explicit high-priority alert, never a long-running state (plan §13.3).
  assert.match(doc, /多实例[^。\n]{0,80}(告警|WAF|缩)/iu);
  assert.doesNotMatch(doc, /(?:长期|长时间|long[- ]running)[^。\n]{0,40}(?:运行|跑)/iu);
});

test('the runbook forbids destructive Redis commands and real secret samples, and the replay checker catches a missing command', async () => {
  const doc = await readFile(RUNBOOK, 'utf8');
  for (const forbidden of ['FLUSHDB', 'FLUSHALL', 'KEYS *', 'SCAN 0']) {
    assert.doesNotMatch(doc, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'iu'), forbidden);
  }
  assert.doesNotMatch(doc, /redis:\/\/[^<\s]+:[^<\s]+@/iu);
  assert.doesNotMatch(doc, /Bearer\s+[A-Za-z0-9._-]{12,}/iu);
  assert.doesNotMatch(doc, /password\s*=\s*[A-Za-z0-9]{8,}/iu);
  // The schema-level replay checker reports the missing command token.
  const missing = validator.checkRunbookCommands(doc.replaceAll('ATTACHMENTS_RATE_LIMIT_MODE=off', 'ATTACHMENTS_RATE_LIMIT_MODE=disabled'));
  assert.ok(missing && missing.length === 1 && missing[0] === 'ATTACHMENTS_RATE_LIMIT_MODE=off');
  assert.equal(validator.checkRunbookCommands(doc), null);
  // The evidence doc contract points at the runbook and the validator command.
  const evidenceDoc = await readFile(new URL('../../../docs/evidence/phase4a-redis-rate-limit.md', import.meta.url), 'utf8');
  assert.match(evidenceDoc, /evidence:phase4a-redis-rate-limit/u);
  assert.match(evidenceDoc, /evidence:phase4a-redis-rate-limit:validate/u);
  assert.match(evidenceDoc, /attachments-redis-rate-limit-operations\.md/u);
});

// ---------------------------------------------------------------------------
// Fail-closed CLI contract (runner)
// ---------------------------------------------------------------------------

test('stable failure codes classify every fail-closed exit', () => {
  assert.equal(stableRl07FailureCode(new Error('configuration_missing:DATABASE_URL')), 'configuration_missing');
  assert.equal(stableRl07FailureCode(new Error('source_revision_unavailable')), 'source_revision_unavailable');
  assert.equal(stableRl07FailureCode(new Error('source_worktree_not_clean')), 'source_worktree_not_clean');
  assert.equal(stableRl07FailureCode(new Error('scenario_failed:quota_alternation')), 'scenario_failed');
  assert.equal(stableRl07FailureCode(new Error('artifact_secret_scan_failed')), 'artifact_secret_scan_failed');
  assert.equal(stableRl07FailureCode(new Error('evidence_schema:quota.allowedTotal')), 'evidence_schema');
  assert.equal(stableRl07FailureCode(new Error('evidence_validation_failed:binding_source_dirty')), 'evidence_validation_failed');
  assert.equal(stableRl07FailureCode(new Error('boom')), 'rl07_failed');
  assert.equal(stableRl07FailureCode('nope'), 'rl07_failed');
  assert.equal(rl07FailureDetail(new Error('configuration_missing:DATABASE_URL')), 'DATABASE_URL');
  assert.equal(rl07FailureDetail(new Error('scenario_failed')), undefined);
});
