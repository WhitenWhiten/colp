/**
 * P4A-V4A-07 canonical acceptance contract (plan §V4A-07): pins that the
 * P11 canonical runner/schema/validator record the evidence hierarchy as
 * supporting / process / environment gates and that the final acceptance
 * (`accepted:true`) is bound to the SAME fresh run — identical runId and
 * sourceRevision across the bundle, the process receipts (the SHARED
 * `assertP11ProcessReceipts` shape from the V4A-06 four-process harness)
 * and the environment receipts (real Cloudflare R2, real Chromium, real
 * PostgreSQL/Redis, in-run I16 regression).
 *
 * Every rejection below is exercised against BOTH layers: the runner-side
 * schema (`assertP11EvidenceShape`, the only writer path) and the
 * INDEPENDENT validator (`validateEvidenceBundle`, separate artifact).
 * Legacy schemaVersion-1 audit records (the historical tracked artifacts)
 * stay replayable WITHOUT the gates contract; only canonical version-2
 * artifacts carry the gates.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'vitest';
import {
  P11_EVIDENCE_SCHEMA_VERSION,
  P11_NON_ACCEPTED_CODE,
  P11_PROCESS_HARNESS,
  P11_SUPPORTING_CONTRACTS,
  assertP11EvidenceShape,
  computeP11CanonicalDigest,
  stableP11FailureCode,
  type P11EvidenceBundle,
} from '../../../scripts/phase4a-owner-private-evidence.js';
import { validateEvidenceBundle } from '../../../scripts/phase4a-owner-private-validate-evidence.mjs';
import { p11FixtureBundle, p11SealedBundle } from '../../support/phase4a-p11-evidence-fixture.js';
import {
  P11_PROCESS_HARNESS_ID,
  assertP11ProcessReceipts,
} from '../../support/phase4a-p11-process-helpers.js';

const backendRoot = resolve(import.meta.dirname, '../../..');

/** Re-seals a mutated bundle so ONLY the mutated fact can fail the checks. */
function sealedWith(overrides: Record<string, unknown>): P11EvidenceBundle {
  const bundle = { ...p11FixtureBundle(overrides), canonicalDigest: '' } as P11EvidenceBundle;
  return { ...bundle, canonicalDigest: computeP11CanonicalDigest(bundle) };
}

/** Asserts the runner-side shape AND the independent validator reject the bundle. */
function assertBothReject(bundle: P11EvidenceBundle, shapePattern: RegExp, validatorPattern: RegExp): void {
  assert.throws(() => assertP11EvidenceShape(bundle), shapePattern, 'runner shape must fail closed');
  const result = validateEvidenceBundle(bundle);
  assert.equal(result.ok, false, `validator must reject: ${result.errors.join(' | ')}`);
  assert.ok(
    result.errors.some((error) => validatorPattern.test(error)),
    `validator must fail closed with ${String(validatorPattern)}: ${result.errors.join(' | ')}`,
  );
}

test('V4A-07 registers the canonical-contract focused gate', () => {
  const packageJson = JSON.parse(readFileSync(resolve(backendRoot, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.match(
    packageJson.scripts['test:phase4a:p11:canonical-contract'] ?? '',
    /phase4a-p11-canonical-contract\.test\.ts/u,
  );});

test('the canonical v2 fixture with all three gates passes the runner shape AND the independent validator', () => {
  const bundle = p11SealedBundle();
  assertP11EvidenceShape(bundle);
  const result = validateEvidenceBundle(bundle);
  assert.equal(result.ok, true, result.errors.join(' | '));
  assert.ok(result.checks.includes('gates:supporting'));
  assert.ok(result.checks.includes('gates:process:pids'));
  assert.ok(result.checks.includes('gates:process:kill_receipts'));
  assert.ok(result.checks.includes('gates:environment:zero-facts'));
  // The final acceptance references the SAME run and source revision across
  // the bundle, the process receipts and the environment receipts.
  assert.equal(bundle.gates.process.runId, bundle.runId);
  assert.equal(bundle.gates.environment.runId, bundle.runId);
  assert.equal(bundle.gates.process.sourceRevision, bundle.binding.sourceRevision);
  assert.equal(bundle.gates.environment.sourceRevision, bundle.binding.sourceRevision);
  assert.equal(bundle.gates.environment.i16RegressionRunId, bundle.i16Regression.subRunId);
});

test('the process gate reuses the SHARED assertP11ProcessReceipts shape (V4A-06 harness)', () => {
  const fixture = p11SealedBundle();
  assertP11ProcessReceipts({
    pids: fixture.gates.process.pids,
    origins: fixture.gates.process.origins,
    workerStarted: fixture.gates.process.workerStarted,
    injectCount: fixture.gates.process.injectCount,
    workerDirectCallCount: fixture.gates.process.workerDirectCallCount,
    killRestartReceipts: fixture.gates.process.killRestartReceipts,
  });
  assert.equal(P11_PROCESS_HARNESS, P11_PROCESS_HARNESS_ID);
  assert.equal(fixture.gates.process.harness, P11_PROCESS_HARNESS_ID);
  assert.ok(P11_SUPPORTING_CONTRACTS.includes('test:phase4a:p11:canonical-contract'));
  assert.ok(P11_SUPPORTING_CONTRACTS.includes('test:phase4a:rl07'));
  assert.ok(P11_SUPPORTING_CONTRACTS.includes('test:phase4a:validator-revision-contract'));
});

test('same-process PIDs (two API processes sharing one OS PID) fail closed', () => {
  const sameProcess = sealedWith({
    gates: {
      ...p11FixtureBundle().gates,
      process: {
        ...p11FixtureBundle().gates.process,
        pids: { apiA: 41001, apiB: 41001, worker: 41003, delivery: 41004 },
      },
    },
  });
  assertBothReject(sameProcess, /mutually distinct OS PIDs/u, /gates:process:pids/u);
});

test('a missing kill/restart receipt fails closed', () => {
  const noKill = sealedWith({
    gates: {
      ...p11FixtureBundle().gates,
      process: {
        ...p11FixtureBundle().gates.process,
        killRestartReceipts: [],
      },
    },
  });
  assertBothReject(noKill, /at least one kill\/restart receipt is required/u, /gates:process:kill_receipts/u);
  // A receipt whose restarted PID equals the killed PID also fails.
  const samePidReceipt = sealedWith({
    gates: {
      ...p11FixtureBundle().gates,
      process: {
        ...p11FixtureBundle().gates.process,
        killRestartReceipts: [{ target: 'worker', signal: 'SIGKILL', exitCode: null, restartedPid: 41003 }],
      },
    },
  });
  assertBothReject(samePidReceipt, /restarted PID must differ/u, /gates:process:kill_receipts/u);
});

test('process and environment receipts from DIFFERENT runs fail closed', () => {
  const differentRun = sealedWith({
    gates: {
      ...p11FixtureBundle().gates,
      process: { ...p11FixtureBundle().gates.process, runId: 'some-other-run' },
    },
  });
  assertBothReject(differentRun, /gates\.process\.run_id/u, /gates:process:run_id/u);
  const differentSource = sealedWith({
    gates: {
      ...p11FixtureBundle().gates,
      environment: { ...p11FixtureBundle().gates.environment, sourceRevision: 'f'.repeat(40) },
    },
  });
  assertBothReject(differentSource, /gates\.environment\.source_revision/u, /gates:environment:source_revision/u);
});

test('a mock/local R2 boundary can never seal (accepted must be false)', () => {
  const mockR2Accepted = sealedWith({
    accepted: true,
    gates: {
      ...p11FixtureBundle().gates,
      environment: { ...p11FixtureBundle().gates.environment, r2: 'local-object-server' },
    },
    binding: {
      ...p11FixtureBundle().binding,
      boundary: { ...p11FixtureBundle().binding.boundary, r2: 'local-object-server' },
    },
  });
  assertBothReject(mockR2Accepted, /evidence_schema:accepted/u, /evidence_schema:accepted/u);
});

test('the locally runnable layer (four processes + local object store) is process-verified and never accepted', () => {
  // The same local-boundary bundle with the I16 regression NOT executed is a
  // valid NON-accepted bundle: the schema accepts it as process-verified and
  // both layers refuse to treat it as accepted.
  const localLayer = sealedWith({
    accepted: false,
    i16Regression: {
      executed: false, subRunId: '', controls: 24, executedControls: 0,
      receiptsDigest: '', postRunChecks: null,
    },
    gates: {
      ...p11FixtureBundle().gates,
      environment: {
        ...p11FixtureBundle().gates.environment,
        r2: 'local-object-server',
        i16RegressionRunId: '',
      },
    },
    binding: {
      ...p11FixtureBundle().binding,
      boundary: { ...p11FixtureBundle().binding.boundary, r2: 'local-object-server' },
    },
  });
  assertP11EvidenceShape(localLayer);
  const result = validateEvidenceBundle(localLayer);
  assert.equal(result.ok, true, result.errors.join(' | '));
  // The runner refuses to WRITE any non-accepted artifact (stable code).
  assert.equal(P11_NON_ACCEPTED_CODE, 'canonical_acceptance_requires_real_environment');
  assert.equal(stableP11FailureCode(new Error(P11_NON_ACCEPTED_CODE)), P11_NON_ACCEPTED_CODE);
});

test('non-real Chromium fails closed', () => {
  // The environment gate alone (the canonical gate layer).
  const noChromium = sealedWith({
    gates: {
      ...p11FixtureBundle().gates,
      environment: { ...p11FixtureBundle().gates.environment, chromium: 'not-used' },
    },
  });
  assertBothReject(noChromium, /gates\.environment\.chromium/u, /gates:environment:chromium/u);
  // The legacy boundary check stays intact (binding.boundary.chromium).
  const boundaryNoChromium = sealedWith({
    binding: {
      ...p11FixtureBundle().binding,
      boundary: { ...p11FixtureBundle().binding.boundary, chromium: 'not-used' },
    },
  });
  assertBothReject(boundaryNoChromium, /boundary_chromium/u, /binding:boundary:chromium/u);
});

test('skip/retry/secret/residual facts fail closed', () => {
  const skipped = sealedWith({
    gates: {
      ...p11FixtureBundle().gates,
      environment: { ...p11FixtureBundle().gates.environment, skips: 1 },
    },
  });
  assertBothReject(skipped, /gates\.environment\.skips_nonzero/u, /gates:environment/u);
  const retried = sealedWith({
    gates: {
      ...p11FixtureBundle().gates,
      environment: { ...p11FixtureBundle().gates.environment, retries: 1 },
    },
  });
  assertBothReject(retried, /gates\.environment\.retries_nonzero/u, /gates:environment/u);
  const secretLeak = sealedWith({
    counts: { skips: 0, mocks: 0, secrets: 1, residuals: 0 },
  });
  assertBothReject(secretLeak, /counts_secrets_nonzero/u, /counts/u);
  const residualLeak = sealedWith({
    residual: { r2ExactKeysAbsent: true, redisPrefixClean: true, processesClosed: false },
  });
  assertBothReject(residualLeak, /residual_processesClosed/u, /residual/u);
});

test('an old RL07 in-process artifact can never become canonical acceptance', () => {
  // The pre-V4A-06 evidence style: no process receipts, local-object-server
  // boundary, chromium not-used — the exact RL07 in-process shape. Even with
  // a canonical claim, both layers reject it (runner: gates missing; the
  // independent validator: gates + boundary r2/chromium fail closed).
  const oldInProcess = sealedWith({
    schemaVersion: 2,
    accepted: true,
    gates: undefined,
    binding: {
      ...p11FixtureBundle().binding,
      boundary: {
        postgres: 'real-testcontainers',
        redis: 'real-testcontainers',
        r2: 'local-object-server-counting',
        chromium: 'not-used',
      },
    },
  });
  assert.throws(() => assertP11EvidenceShape(oldInProcess), /evidence_schema:(?:boundary_r2|gates)/u);
  const result = validateEvidenceBundle(oldInProcess);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => /gates/u.test(error)), 'gates missing must fail the validator');
  assert.ok(result.errors.some((error) => /binding:boundary:r2/u.test(error)
    || /binding:boundary:chromium/u.test(error)), 'the RL07 boundary must fail the validator');
});

test('source/build/OpenAPI/client digest drift fails the independent recompute', () => {
  const openapiDrift = sealedWith({
    binding: { ...p11FixtureBundle().binding, openapiDigest: '0'.repeat(64) },
  });
  // The runner shape only pins the digest shape; the INDEPENDENT validator
  // recomputes every repository-bound digest and fails on drift.
  assertP11EvidenceShape(openapiDrift);
  const openapiResult = validateEvidenceBundle(openapiDrift);
  assert.equal(openapiResult.ok, false);
  assert.ok(openapiResult.errors.some((error) => error.startsWith('binding:openapi_digest')));

  const clientDrift = sealedWith({
    binding: { ...p11FixtureBundle().binding, clientDigest: '1'.repeat(64) },
  });
  const clientResult = validateEvidenceBundle(clientDrift);
  assert.equal(clientResult.ok, false);
  assert.ok(clientResult.errors.some((error) => error.startsWith('binding:client_digest')));

  const buildDrift = sealedWith({
    binding: {
      ...p11FixtureBundle().binding,
      originBuild: { productionBuild: true, buildHash: '2'.repeat(64), buildCommand: 'npm run build' },
    },
  });
  const buildResult = validateEvidenceBundle(buildDrift);
  assert.equal(buildResult.ok, false);
  assert.ok(buildResult.errors.some((error) => error.startsWith('binding:origin_build_hash')));

  const configDrift = sealedWith({
    binding: { ...p11FixtureBundle().binding, configDigest: '3'.repeat(64) },
  });
  const configResult = validateEvidenceBundle(configDrift);
  assert.equal(configResult.ok, false);
  assert.ok(configResult.errors.some((error) => error.startsWith('binding:config_digest')));

  // A dirty recorded source is a source-binding drift (the revision-aware
  // tree binding — `rev^{tree}` vs the recorded tree — is the V4A-03
  // revision-binding contract and stays covered by that suite).
  const dirtySource = sealedWith({
    binding: { ...p11FixtureBundle().binding, sourceClean: false },
  });
  assertBothReject(dirtySource, /binding\.source_dirty/u, /binding:source_clean/u);
});

test('legacy schemaVersion-1 audit records stay replayable WITHOUT the gates (V4A-03 compat)', () => {
  // The historical tracked artifacts (I16/P11, schemaVersion 1) predate the
  // gates contract: they must keep validating through the legacy path so
  // retained-mode replay stays byte-identical (the real P11 artifact's known
  // CRLF digest drift stays the ONLY failure, never a gates failure).
  const legacy = sealedWith({
    schemaVersion: 1,
    gates: undefined,
  });
  const result = validateEvidenceBundle(legacy);
  assert.equal(result.ok, true, result.errors.join(' | '));
  assert.ok(result.checks.includes('evidence_schema:schema_version:legacy'));
  // A canonical v2 artifact is the only path that requires gates.
  const noGates = sealedWith({ schemaVersion: 2, gates: undefined });
  assert.throws(() => assertP11EvidenceShape(noGates), /evidence_schema:gates/u);
  const noGatesResult = validateEvidenceBundle(noGates);
  assert.equal(noGatesResult.ok, false);
  assert.ok(noGatesResult.errors.some((error) => error.startsWith('gates')));
});

test('the fixed schema version and gate constants stay pinned', () => {
  assert.equal(P11_EVIDENCE_SCHEMA_VERSION, 2);
  assert.equal(P11_PROCESS_HARNESS, 'phase4a-p11-process');
  assert.equal(P11_NON_ACCEPTED_CODE, 'canonical_acceptance_requires_real_environment');
});
