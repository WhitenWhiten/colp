/**
 * P4A-P10 recovery evidence contract (plan §9 P10, §12 low-sensitivity
 * requirements; mirrors the RL07 evidence-contract pattern WITHOUT running
 * the evidence CLI — real PostgreSQL/Redis/R2 scenarios run only via
 * `evidence:phase4a-p10-recovery` / `local:phase4a-r2:run -- p10
 * confirm-real-r2` on a clean retained revision).
 *
 * Pins:
 *  - the fixed evidence bundle schema (readiness scenarios, sealed recovery
 *    order with admission last, PITR facts with `destructiveActionsTaken:
 *    false`, capacity samples, zero skip/mock/secret/residual, forbidden
 *    fields) and the canonical digest (deterministic + tamper-evident);
 *  - the secret marker scan reports position classes only, never echoing the
 *    marker; the serialized bundle carries no URL/credential/Redis-endpoint
 *    classes;
 *  - the fail-closed environment contract: real-R2 mode requires every
 *    `P4A_R2_*` key (`configuration_missing` otherwise), dirty revisions are
 *    rejected, CI is refused;
 *  - the runbook command surface replays against the recovery runbook.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'vitest';
import {
  P10_DEFAULT_EVIDENCE_OUTPUT,
  P10_EVIDENCE_SCHEMA_VERSION,
  P10_EVIDENCE_TASK,
  P10_REQUIRED_REAL_R2_KEYS,
  P10_RUNBOOK_COMMANDS,
  P10_RUNBOOK_PATH,
  assertP10EvidenceShape,
  computeP10CanonicalDigest,
  parseP10EvidenceEnvironment,
  p10SourceDirty,
  scanP10EvidenceForForbiddenValues,
  stableP10FailureCode,
  type P10EvidenceBundle,
} from '../../../scripts/phase4a-p10-recovery-evidence.js';
import { lexicalMigrationHeadFromDisk } from '../../../scripts/lexical-migration-head.mjs';

const RUNBOOK = new URL('../../../docs/runbooks/attachments-recovery-operations.md', import.meta.url);
const REAL_MIGRATION_HEAD = lexicalMigrationHeadFromDisk();

/** Deterministic fixed-schema fixture bundle. */
function p10FixtureBundle(overrides: Record<string, unknown> = {}): P10EvidenceBundle {
  const bundle = {
    schemaVersion: P10_EVIDENCE_SCHEMA_VERSION,
    task: P10_EVIDENCE_TASK,
    verdict: 'pass',
    runId: 'p10-fixture-run-0000-0000-4000-8000-000000000000',
    startedAtIso: '2026-08-10T00:00:00.000Z',
    finishedAtIso: '2026-08-10T00:10:00.000Z',
    binding: {
      sourceRevision: 'a'.repeat(40), sourceTreeHash: 'b'.repeat(40), sourceClean: true,
      migrationHead: REAL_MIGRATION_HEAD, nodeVersion: 'v24.9.0',
      postgresVersion: 'PostgreSQL 16.4 (testcontainers)', redisVersion: 'redis 7-alpine (testcontainers)',
      boundary: { postgres: 'real-testcontainers', redis: 'real-testcontainers', r2: 'local-object-server', chromium: 'not-used' },
    },
    readiness: {
      scenarios: [
        { dependency: 'r2', stopped: true, capabilityStatus: 'not-ready', capabilityReason: 'dependency_unavailable', globalApiIndependent: true },
        { dependency: 'postgres', stopped: true, capabilityStatus: 'not-ready', capabilityReason: 'dependency_unavailable', globalApiIndependent: true },
        { dependency: 'redis', stopped: true, capabilityStatus: 'not-ready', capabilityReason: 'dependency_unavailable', globalApiIndependent: true },
        { dependency: 'origin', stopped: true, capabilityStatus: 'not-ready', capabilityReason: 'delivery_unavailable', globalApiIndependent: true },
        { dependency: 'worker', stopped: true, capabilityStatus: 'degraded', capabilityReason: 'worker_degraded', globalApiIndependent: true },
      ],
      recoveryOrder: { steps: ['secret_control', 'postgres', 'r2_reconcile', 'redis_limiter', 'worker', 'isolated_origin', 'admission'], admissionRestoredLast: true },
    },
    alerts: { sustainedWindowUsed: true, maintenanceSuppressionRecordsUnderlyingFiring: true, backlogGrowthObserved: true },
    drain: { admissionStopped: true, inFlightCompleteDrained: true, resumed: true, apiGracefulCloseDrained: true },
    rotation: { verdict: 'rotation_verified', oldKeptRehearsalVerdict: 'old_credential_still_accepted', oldRejectedAfterAclChange: true },
    pitr: {
      lifecyclePoints: [
        { point: 'intent', verdict: 'missing' }, { point: 'put', verdict: 'match' },
        { point: 'complete', verdict: 'match' }, { point: 'finalize', verdict: 'match' },
        { point: 'cleanup', verdict: 'excluded' },
      ],
      transient429IsUnknown: true, driftIsMismatch: true, cleanupExcluded: true, destructiveActionsTaken: false,
    },
    capacity: {
      samples: [{
        schemaVersion: 1, phase: 'cold_start', objectSizeBytes: 8192, concurrency: 2, apiInstances: 1,
        process: { rssBytes: 100, fdCount: 64, activeHandles: 10 },
        postgresPool: { total: 16, idle: 8, active: 8, waiting: 0 },
        redis: { usedMemoryBytes: 1024, connectedClients: 1 },
        dbQueries: 50, r2Calls: 30, latencyMs: { p50: 5, p95: 20 },
        limitations: ['local rehearsal capacity sample; not a production SLO'],
      }],
      coldWarmSeparated: true, latencyDiagnosticOnly: true, notProductionSlo: true,
    },
    counts: { skips: 0, mocks: 0, secrets: 0, residuals: 0 },
    limitations: ['local rehearsal capacity samples; not a production SLO'],
    canonicalDigest: 'f'.repeat(64),
    ...overrides,
  } as P10EvidenceBundle;
  return { ...bundle, canonicalDigest: computeP10CanonicalDigest(bundle) };
}

test('the fixed evidence schema accepts a well-formed bundle and rejects drift', () => {
  const bundle = p10FixtureBundle();
  assertP10EvidenceShape(bundle);
  assert.throws(() => assertP10EvidenceShape({ ...bundle, schemaVersion: 2 }), /evidence_schema/);
  assert.throws(() => assertP10EvidenceShape({ ...bundle, task: 'phase4a-p99' }), /evidence_schema/);
  assert.throws(() => assertP10EvidenceShape({ ...bundle, verdict: 'fail' }), /evidence_schema/);
  assert.throws(() => assertP10EvidenceShape({ ...bundle, extra: 1 }), /evidence_schema/);
  assert.throws(() => assertP10EvidenceShape({
    ...bundle,
    binding: { ...bundle.binding, sourceClean: false },
  }), /evidence_schema/, 'a dirty recorded revision can never serialize');
  for (const key of ['skips', 'mocks', 'secrets', 'residuals']) {
    assert.throws(() => assertP10EvidenceShape({
      ...bundle,
      counts: { ...bundle.counts, [key]: 1 },
    }), /evidence_schema/, `${key} must stay zero`);
  }
  assert.throws(() => assertP10EvidenceShape({ ...bundle, limitations: [] }), /evidence_schema/);
  assert.throws(() => assertP10EvidenceShape({
    ...bundle,
    binding: { ...bundle.binding, boundary: { ...bundle.binding.boundary, chromium: 'real' } },
  }), /evidence_schema/);
  // A tampered recovery order (admission not last) can never serialize.
  assert.throws(() => assertP10EvidenceShape({
    ...bundle,
    readiness: {
      ...bundle.readiness,
      recoveryOrder: { steps: ['secret_control', 'postgres', 'r2_reconcile', 'redis_limiter', 'worker', 'admission', 'isolated_origin'], admissionRestoredLast: true },
    },
  }), /recovery_order|evidence_schema/, 'admission must stay the last recovery step');
  assert.throws(() => assertP10EvidenceShape({
    ...bundle,
    pitr: { ...bundle.pitr, destructiveActionsTaken: true },
  }), /evidence_schema/, 'reconcile must never take destructive actions');
});

test('forbidden field names and forbidden value classes are rejected anywhere in the bundle', () => {
  const bundle = p10FixtureBundle();
  assert.throws(() => assertP10EvidenceShape({ ...bundle, blobId: '018f6f7a-8f2a-7a3d-a123-123456789001' }), /forbidden_field/);
  assert.throws(() => assertP10EvidenceShape({ ...bundle, secretAccessKey: 'AKIAEXAMPLE00000000' }), /forbidden_field/);
  const serialized = JSON.stringify(bundle);
  assert.ok(!/https?:\/\//.test(serialized), 'no URL may serialize');
  assert.ok(!/redis:\/\//.test(serialized), 'no Redis endpoint may serialize');
  assert.ok(!/r2\.cloudflarestorage\.com/.test(serialized), 'no provider endpoint may serialize');
  for (const forbidden of ['accessKeyId', 'secretAccessKey', 'authorization', 'P4A_R2_']) {
    assert.ok(!serialized.toLowerCase().includes(forbidden), `forbidden class ${forbidden} must not serialize`);
  }
});

test('the canonical digest is deterministic and tamper-evident', () => {
  const first = computeP10CanonicalDigest(p10FixtureBundle());
  const second = computeP10CanonicalDigest(p10FixtureBundle());
  assert.equal(first, second);
  assert.match(first, /^[a-f0-9]{64}$/);
  const tampered = p10FixtureBundle({
    pitr: { ...p10FixtureBundle().pitr, lifecyclePoints: [{ point: 'intent', verdict: 'match' }] },
  });
  assert.notEqual(computeP10CanonicalDigest(tampered), first, 'a changed fact must change the digest');
});

test('a synthetic secret marker in any recorded position is reported as a position class and never echoed', () => {
  const marker = `p10-secret-marker-${randomUUID()}`;
  const leaky = p10FixtureBundle({ limitations: [`leak ${marker}`] });
  assert.throws(() => scanP10EvidenceForForbiddenValues(leaky, [marker]), /artifact_secret_scan_failed/);
  assert.throws(
    () => scanP10EvidenceForForbiddenValues(leaky, [marker]),
    (error: unknown) => !String(error).includes(marker),
    'the scanner must never echo the marker value',
  );
  scanP10EvidenceForForbiddenValues(p10FixtureBundle(), [marker]);
});

test('environment parsing is fail-closed: real-R2 mode requires every credential key; local mode needs nothing', () => {
  const local = parseP10EvidenceEnvironment({});
  assert.equal(local.mode, 'local-object-server');
  assert.throws(() => parseP10EvidenceEnvironment({ P4A_R2_PROBE_PREFIX: 'capability-probes/local-20260810-p10-abcdef/' }),
    /configuration_missing/, 'missing credentials must be an explicit environment failure, never a skip');
  const complete: Record<string, string> = {
    P4A_R2_PROBE_PREFIX: 'capability-probes/local-20260810-p10-abcdef/',
    P4A_R2_ENDPOINT: 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
    P4A_R2_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
    P4A_R2_BUCKET: 'known-evidence',
    P4A_R2_ACCESS_KEY_ID: 'a'.repeat(32),
    P4A_R2_SECRET_ACCESS_KEY: 'b'.repeat(40),
    P4A_R2_READ_ACCESS_KEY_ID: 'c'.repeat(32),
    P4A_R2_READ_SECRET_ACCESS_KEY: 'd'.repeat(40),
  };
  const real = parseP10EvidenceEnvironment(complete);
  assert.equal(real.mode, 'real-cloudflare-r2');
  assert.equal(real.livePrefix, 'capability-probes/local-20260810-p10-abcdef/live/');
  assert.equal(real.probePrefix, 'capability-probes/local-20260810-p10-abcdef/probe/');
  for (const key of P10_REQUIRED_REAL_R2_KEYS) {
    // An empty probe prefix falls back to local mode (honest boundary), so
    // the fail-closed per-key check covers the credential/binding keys.
    if (key === 'P4A_R2_PROBE_PREFIX') continue;
    assert.throws(() => parseP10EvidenceEnvironment({ ...complete, [key]: '' }), /configuration_missing/, key);
  }
});

test('dirty revisions are rejected and stable failure codes classify every fail-closed exit', () => {
  assert.equal(p10SourceDirty(''), false);
  assert.equal(p10SourceDirty(' M src/file.ts\n'), true);
  assert.equal(p10SourceDirty('?? scripts/new.ts'), true);
  assert.equal(stableP10FailureCode(new Error('configuration_missing:P4A_R2_BUCKET')), 'configuration_missing');
  assert.equal(stableP10FailureCode(new Error('source_worktree_not_clean')), 'source_worktree_not_clean');
  assert.equal(stableP10FailureCode(new Error('scenario_failed:order_step_3_not-ready')), 'scenario_failed');
  assert.equal(stableP10FailureCode(new Error('artifact_secret_scan_failed')), 'artifact_secret_scan_failed');
  assert.equal(stableP10FailureCode(new Error('boom')), 'p10_failed');
  assert.equal(stableP10FailureCode('nope'), 'p10_failed');
});

test('the evidence migration head is the REAL production migration head (never a stale constant)', async () => {
  assert.equal(REAL_MIGRATION_HEAD, lexicalMigrationHeadFromDisk(),
    'the fixture head must follow the latest production migration file');
  // The shape validator accepts exactly the <12-digit>_<name> contract.
  assert.match(REAL_MIGRATION_HEAD, /^\d{12}_[a-z0-9_]+$/u);
  assert.throws(() => assertP10EvidenceShape({
    ...p10FixtureBundle(),
    binding: { ...p10FixtureBundle().binding, migrationHead: 'stale-head' },
  }), /evidence_schema/, 'a stale/non-canonical migration head can never serialize');
  assert.throws(() => assertP10EvidenceShape({
    ...p10FixtureBundle(),
    binding: { ...p10FixtureBundle().binding, sourceTreeHash: 'not-a-tree-hash' },
  }), /evidence_schema/, 'a non-canonical source tree hash can never serialize');
});

test('the recovery runbook replays the sealed command surface', async () => {
  const doc = await readFile(RUNBOOK, 'utf8');
  for (const command of P10_RUNBOOK_COMMANDS) {
    assert.match(doc, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'), command);
  }
  assert.ok(P10_DEFAULT_EVIDENCE_OUTPUT.endsWith('phase4a-p10-recovery.json'));
  assert.equal(P10_RUNBOOK_PATH, 'docs/runbooks/attachments-recovery-operations.md');
  assert.equal(P10_EVIDENCE_SCHEMA_VERSION, 1);
  assert.equal(P10_EVIDENCE_TASK, 'phase4a-p10');
});
