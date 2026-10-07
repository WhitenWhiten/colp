/**
 * P4A-P11 evidence artifact contract (plan §9 P11, §12): pins the FAIL-CLOSED
 * schema of `evidence:phase4a-owner-private` WITHOUT running the evidence
 * command (the real boundaries run only via the evidence CLI on a clean
 * retained revision):
 *  - the fixed bundle shape rejects drift (forbidden fields, wrong verdict,
 *    unexecuted controls, leak facts, non-zero counts, unreached boundary);
 *  - the canonical digest is computed over the SAME protocol-facts selection
 *    the INDEPENDENT validator recomputes (runner/validator separation);
 *  - the secret marker scan reports position classes only (raw AND base64
 *    positions) and never echoes the marker;
 *  - dirty revisions are rejected by the source-binding contract.
 */
import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  P11_AUTHORIZATION_NEGATIVE_SCENARIOS,
  P11_EVIDENCE_SCHEMA_VERSION,
  P11_KEY_PREFIX_MARKER,
  P11_LIFECYCLE_STEPS,
  P11_TASK,
  assertP11EvidenceShape,
  computeP11CanonicalDigest,
  p11ProtocolFacts,
  p11SourceDirty,
  p11FailureDetail,
  scanP11EvidenceForForbiddenValues,
  stableP11FailureCode,
  type P11EvidenceBundle,
} from '../../../scripts/phase4a-owner-private-evidence.js';
import { p11FixtureBundle, p11FixtureConfigFacts, p11SealedBundle } from '../../support/phase4a-p11-evidence-fixture.js';

// The validator is plain Node ESM; vitest can import it directly. It must
// stay a SEPARATE artifact (no shared implementation with the runner).
const validator = await import('../../../scripts/phase4a-owner-private-validate-evidence.mjs');

test('the fixed schema accepts the pass fixture and rejects every drift', () => {
  const bundle = p11SealedBundle();
  assertP11EvidenceShape(bundle);

  // verdict/accepted drift.
  assert.throws(() => assertP11EvidenceShape(p11SealedBundle({ verdict: 'pending' })), /evidence_schema:verdict/u);
  assert.throws(() => assertP11EvidenceShape(p11SealedBundle({ accepted: false })), /evidence_schema:accepted/u);
  // task drift.
  assert.throws(() => assertP11EvidenceShape(p11SealedBundle({ task: 'phase4a-other' })), /evidence_schema:task/u);
  // schema version drift.
  assert.throws(() => assertP11EvidenceShape(p11SealedBundle({ schemaVersion: 3 })), /evidence_schema:schema_version/u);
  // canonical digest shape.
  assert.throws(() => assertP11EvidenceShape({ ...p11FixtureBundle(), canonicalDigest: 'not-hex' }), /evidence_schema:canonical_digest/u);
  // forbidden top-level field.
  const extra = { ...p11FixtureBundle(), extraField: true };
  assert.throws(() => assertP11EvidenceShape(extra), /forbidden_field_extraField/u);
});

test('the schema binds reviewed source, boundary, redacted prefixes and digests', () => {
  // Source binding facts.
  assert.throws(() => assertP11EvidenceShape(p11SealedBundle({
    binding: { ...p11FixtureBundle().binding, sourceClean: false },
  })), /evidence_schema:binding.source_dirty/u);
  assert.throws(() => assertP11EvidenceShape(p11SealedBundle({
    binding: { ...p11FixtureBundle().binding, sourceRevision: 'zz' },
  })), /evidence_schema:binding.source_revision/u);
  assert.throws(() => assertP11EvidenceShape(p11SealedBundle({
    binding: { ...p11FixtureBundle().binding, migrationHead: 'wrong-head' },
  })), /evidence_schema:binding.migration_head/u);
  // Real boundary requirements.
  assert.throws(() => assertP11EvidenceShape(p11SealedBundle({
    binding: { ...p11FixtureBundle().binding, boundary: { postgres: 'fake', redis: 'real-testcontainers', r2: 'real-cloudflare-r2', chromium: 'real-chromium' } },
  })), /evidence_schema:boundary_requires_real_pg_redis/u);
  assert.throws(() => assertP11EvidenceShape(p11SealedBundle({
    binding: { ...p11FixtureBundle().binding, boundary: { postgres: 'real-testcontainers', redis: 'real-testcontainers', r2: 'real-cloudflare-r2', chromium: 'not-used' } },
  })), /evidence_schema:boundary_chromium/u);
  // The run prefixes must be redacted in the artifact.
  const leakedConfig = {
    ...p11FixtureConfigFacts(),
    r2: { livePrefix: 'capability-probes/local-20260812-p11-deadbeef/live/', probePrefix: P11_KEY_PREFIX_MARKER },
  };
  assert.throws(() => assertP11EvidenceShape(p11SealedBundle({
    binding: { ...p11FixtureBundle().binding, configFacts: leakedConfig },
  })), /evidence_schema:config_prefix_not_redacted/u);
  // Binding digests must be 64-hex.
  assert.throws(() => assertP11EvidenceShape(p11SealedBundle({
    binding: { ...p11FixtureBundle().binding, openapiDigest: 'short' },
  })), /evidence_schema:binding.openapi_digest/u);
});

test('the lifecycle and authorization-negative catalogs are fixed', () => {
  const fixture = p11SealedBundle();
  // Every fixed lifecycle step must be present.
  for (const step of P11_LIFECYCLE_STEPS) {
    assert.ok(fixture.lifecycle.steps.some((entry) => entry.step === step), `missing lifecycle step ${step}`);
  }
  // Every fixed authorization negative must be present.
  for (const scenario of P11_AUTHORIZATION_NEGATIVE_SCENARIOS) {
    assert.ok(fixture.lifecycle.authorizationNegatives.some((entry) => entry.scenario === scenario),
      `missing authorization negative ${scenario}`);
  }
  // Removing one negative fails the schema.
  const truncated = p11SealedBundle({
    lifecycle: {
      ...p11FixtureBundle().lifecycle,
      authorizationNegatives: p11FixtureBundle().lifecycle.authorizationNegatives.slice(0, 6),
    },
  });
  assert.throws(() => assertP11EvidenceShape(truncated), /evidence_schema:authorization_negatives/u);
  // A leak fact (bodyBytes > 0) fails the schema.
  const leaking = p11SealedBundle({
    lifecycle: {
      ...p11FixtureBundle().lifecycle,
      authorizationNegatives: p11FixtureBundle().lifecycle.authorizationNegatives.map((entry) => ({
        ...entry, bodyBytes: 1,
      })),
    },
  });
  assert.throws(() => assertP11EvidenceShape(leaking), /evidence_schema:authorization_negative_leak/u);
});

test('the I16 regression facts must be executed 24/24 with a sealed receipts digest', () => {
  const bundle = p11SealedBundle();
  assert.equal(bundle.i16Regression.controls, 24);
  assert.equal(bundle.i16Regression.executedControls, 24);
  assert.equal(bundle.i16Regression.executed, true);
  // An unexecuted regression fails the schema.
  assert.throws(() => assertP11EvidenceShape(p11SealedBundle({
    i16Regression: { ...p11FixtureBundle().i16Regression, executed: false },
  })), /evidence_schema:i16_regression_not_executed/u);
  // A failed post-run check fails the schema.
  assert.throws(() => assertP11EvidenceShape(p11SealedBundle({
    i16Regression: {
      ...p11FixtureBundle().i16Regression,
      postRunChecks: { ...p11FixtureBundle().i16Regression.postRunChecks, processesClosed: false },
    },
  })), /evidence_schema:i16_regression_processesClosed/u);
});

test('counts and residual facts must be zero/true on a sealed artifact', () => {
  assert.throws(() => assertP11EvidenceShape(p11SealedBundle({
    counts: { skips: 1, mocks: 0, secrets: 0, residuals: 0 },
  })), /evidence_schema:counts_skips_nonzero/u);
  assert.throws(() => assertP11EvidenceShape(p11SealedBundle({
    residual: { r2ExactKeysAbsent: true, redisPrefixClean: true, processesClosed: false },
  })), /evidence_schema:residual_processesClosed/u);
  assert.throws(() => assertP11EvidenceShape(p11SealedBundle({
    multiInstance: { ...p11FixtureBundle().multiInstance, recoveryRestoresQuota: false },
  })), /evidence_schema:multi_instance_recoveryRestoresQuota/u);
});

test('the canonical digest binds the SAME protocol facts the independent validator recomputes', () => {
  const fixture = p11FixtureBundle();
  const runnerFacts = p11ProtocolFacts(fixture as P11EvidenceBundle);
  // The validator's independent canonicalize must serialize the SAME facts
  // to the SAME bytes (sorted keys on both sides).
  const validatorFacts = validator.protocolFacts(fixture);
  assert.equal(validator.canonicalize(runnerFacts), validator.canonicalize(validatorFacts),
    'runner and validator protocol-facts selections must be byte-identical');
  assert.equal(computeP11CanonicalDigest(fixture), validator.computeDigest(fixture),
    'runner digest must equal the independent validator digest');
  // The digest must be sensitive to every sealed fact family.
  const base = computeP11CanonicalDigest(fixture);
  assert.notEqual(computeP11CanonicalDigest({ ...fixture, runId: 'other-run' }), base);
  assert.notEqual(computeP11CanonicalDigest(p11FixtureBundle({
    multiInstance: { ...p11FixtureBundle().multiInstance, issueQuotaShared: false },
  })), base);
  assert.notEqual(computeP11CanonicalDigest(p11FixtureBundle({
    i16Regression: { ...p11FixtureBundle().i16Regression, receiptsDigest: 'd'.repeat(64) },
  })), base);
});

test('the secret marker scan reports position classes only, in raw AND base64 forms', () => {
  const marker = 'p11-secret-marker-abcdef0123456789';
  const bundle = p11SealedBundle();
  // Clean artifact passes the scan.
  scanP11EvidenceForForbiddenValues(bundle, [marker]);
  // Raw leak fails.
  const rawLeak = { ...bundle, limitations: [...bundle.limitations, marker] };
  assert.throws(() => scanP11EvidenceForForbiddenValues(rawLeak, [marker]), /artifact_secret_scan_failed/u);
  // Base64-encoded leak fails too (the base64 position class).
  const base64Leak = { ...bundle, limitations: [...bundle.limitations, Buffer.from(marker, 'utf8').toString('base64')] };
  assert.throws(() => scanP11EvidenceForForbiddenValues(base64Leak, [marker]), /artifact_secret_scan_failed/u);
  // The marker value is never echoed by the failure (position class only).
  try {
    scanP11EvidenceForForbiddenValues(rawLeak, [marker]);
    assert.fail('scan must throw');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert.ok(!message.includes(marker), 'the marker value must never be echoed');
  }
  // The scan rejects sensitive FIELD NAMES anywhere in the artifact.
  const fieldLeak = {
    ...bundle,
    limitations: [...bundle.limitations],
    lifecycle: { ...bundle.lifecycle, steps: [...bundle.lifecycle.steps, { step: 'x', outcome: 'y', statusClass: '2xx', facts: 'z', objectKey: 'secret' }] },
  };
  assert.throws(() => assertP11EvidenceShape(fieldLeak), /forbidden_evidence_field:objectKey/u);
});

test('dirty source revisions are rejected and stable codes stay byte-identical', () => {
  assert.equal(p11SourceDirty(''), false);
  assert.equal(p11SourceDirty(' M docs/evidence/phase4a-owner-private.json\n'), true);
  assert.equal(stableP11FailureCode(new Error('source_worktree_not_clean')), 'source_worktree_not_clean');
  assert.equal(stableP11FailureCode(new Error('probe_issue_failed:429')), 'probe_issue_failed');
  assert.equal(stableP11FailureCode(new Error('artifact_secret_scan_failed')), 'artifact_secret_scan_failed');
  assert.equal(stableP11FailureCode(new Error('i16_regression_requires_real_r2')), 'i16_regression_requires_real_r2');
  assert.equal(stableP11FailureCode(new Error('unexpected failure')), 'p11_failed');
  const proxied = new Error('fetch failed', { cause: Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }) });
  assert.equal(stableP11FailureCode(proxied), 'p11_failed');
  assert.equal(p11FailureDetail(proxied), 'fetch failed cause=ECONNREFUSED');
  // The schema constants stay pinned.
  assert.equal(P11_EVIDENCE_SCHEMA_VERSION, 2);
  assert.equal(P11_TASK, 'phase4a-owner-private');
  assert.equal(P11_KEY_PREFIX_MARKER, '<run-random>');
});
