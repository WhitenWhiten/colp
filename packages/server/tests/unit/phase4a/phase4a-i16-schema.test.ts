/**
 * P4A-I16 contract suite: fixed evidence schema.
 *
 * Proves the evidence bundle is a CLOSED fixed shape: exact top-level keys,
 * schemaVersion/task/verdict literals, the binding facts (revision/tree/
 * migration head/config digest/origin build/R2 control/catalog), the
 * protocol/state scenario facts, the negative-control records, the post-run
 * checks, and the canonical digest field. Unknown or forbidden fields are
 * rejected (`assertI16EvidenceShape`), and a secret marker/value in any field
 * makes `buildI16Evidence` fail closed with `sensitive_evidence_value` /
 * `sensitive_evidence_field` — the artifact never contains a full
 * key/URL/credential/body/filename/digest.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  I16_EVIDENCE_SCHEMA_VERSION,
  I16_MIGRATION_HEAD,
  I16_TASK,
  assertI16EvidenceShape,
  type I16EvidenceBundle,
} from '../../../scripts/evidence/phase4a-i16-acceptance.js';
import {
  I16_TEST_REVISION,
  I16_TEST_TREE,
  buildI16FixtureEvidence,
  i16NegativeControls,
} from '../../support/phase4a-i16-test-helpers.js';

function validBundle(): I16EvidenceBundle {
  return buildI16FixtureEvidence();
}

describe('P4A-I16 fixed evidence schema', () => {
  test('a valid bundle passes the exact shape guard with fixed literals', () => {
    const bundle = validBundle();
    assertI16EvidenceShape(bundle);
    assert.equal(bundle.schemaVersion, I16_EVIDENCE_SCHEMA_VERSION);
    assert.equal(bundle.task, I16_TASK);
    assert.equal(bundle.verdict, 'pass');
    assert.equal(bundle.binding.migrationHead, I16_MIGRATION_HEAD);
    assert.equal(bundle.binding.sourceClean, true);
    assert.match(bundle.canonicalDigest, /^[a-f0-9]{64}$/);
  });

  test('the binding carries reviewed commit + tree + config + origin facts and never a credential field', () => {
    const bundle = validBundle();
    assert.match(bundle.binding.sourceRevision, /^[a-f0-9]{40,64}$/);
    assert.match(bundle.binding.sourceTreeHash, /^[a-f0-9]{40,64}$/);
    assert.match(bundle.binding.configDigest, /^[a-f0-9]{64}$/);
    assert.equal(bundle.binding.r2Control.provider, 'cloudflare-r2-direct-object-api');
    assert.equal(bundle.binding.r2Control.accessMode, 'private');
    assert.equal(bundle.binding.originBuild.productionBuild, true);
    assert.match(bundle.binding.originBuild.buildHash, /^[a-f0-9]{64}$/);
    for (const entry of bundle.binding.negativeControlCatalog) {
      assert.ok(entry.control.length > 0);
      assert.equal(entry.verdict, 'pass');
      assert.ok(entry.verificationSource.length > 0);
    }
    const serialized = JSON.stringify(bundle);
    for (const forbidden of ['accessKeyId', 'secretAccessKey', 'endpoint', 'bucket', '"key"', '"credential"']) {
      assert.ok(!serialized.includes(forbidden), `bundle must not serialize a ${forbidden} field`);
    }
  });

  test('the scenario contains only protocol/state facts', () => {
    const bundle = validBundle();
    assert.deepEqual(Object.keys(bundle.scenario).sort(), [
      'cleanup', 'complete', 'deliverNonOwner', 'deliverOwner', 'finalize',
      'issue', 'put', 'replacement', 'restart', 'rollback', 'verify',
    ]);
    assert.equal(bundle.scenario.issue.outcome, 'issued');
    assert.equal(bundle.scenario.issue.ledgerBeforeGrant, true);
    assert.equal(bundle.scenario.put.method, 'PUT');
    assert.equal(bundle.scenario.complete.outcome, 'completed');
    assert.equal(bundle.scenario.verify.outcome, 'stored_private');
    assert.equal(bundle.scenario.deliverOwner.forcedDownload, true);
    assert.equal(bundle.scenario.deliverNonOwner.bodyBytes, 0);
    assert.equal(bundle.scenario.replacement.oldGenerationState, 'retired');
    assert.equal(bundle.scenario.replacement.newGenerationState, 'active');
    assert.equal(bundle.scenario.cleanup.activePreserved, true);
    assert.equal(bundle.scenario.restart.outcome, 'recovered');
  });

  test('shape guard rejects an unknown top-level field and a wrong schemaVersion', () => {
    const bundle = validBundle() as unknown as Record<string, unknown>;
    assert.throws(() => assertI16EvidenceShape({ ...bundle, extra: true }), /evidence_schema/);
    assert.throws(() => assertI16EvidenceShape({ ...bundle, schemaVersion: 2 }), /evidence_schema/);
    assert.throws(() => assertI16EvidenceShape({ ...bundle, verdict: 'fail' }), /evidence_schema/);
    assert.throws(() => assertI16EvidenceShape({ ...bundle, task: 'phase4a-i99' }), /evidence_schema/);
  });

  test('shape guard rejects forbidden field names anywhere in the bundle', () => {
    const bundle = validBundle();
    const nested = {
      ...bundle,
      scenario: { ...bundle.scenario, put: { ...bundle.scenario.put, key: 'x' } },
    };
    assert.throws(() => assertI16EvidenceShape(nested as never), /forbidden_evidence_field/);
  });

  test('buildI16Evidence fails closed when a secret marker leaks into any field', () => {
    const marker = 'i16-super-secret-marker-value';
    assert.throws(
      () => buildI16FixtureEvidence({
        negativeControls: i16NegativeControls().map((control, index) => (
          index === 0 ? { ...control, outcome: marker } : control
        )),
        forbiddenValues: [marker],
      }),
      /sensitive_evidence_value/,
    );
  });

  test('negative-control completeness: missing, duplicate, failed, or forbidden-source records are rejected', () => {
    const base = buildI16FixtureEvidence();
    const all = i16NegativeControls();
    assert.throws(
      () => buildI16FixtureEvidence({ negativeControls: all.slice(1) }),
      /negative_control_missing/,
    );
    assert.throws(
      () => buildI16FixtureEvidence({ negativeControls: [all[0]!, all[0]!, ...all.slice(1)] }),
      /negative_control_duplicate/,
    );
    assert.throws(
      () => buildI16FixtureEvidence({
        negativeControls: all.map((control, index) => (index === 0 ? { ...control, verdict: 'fail' as const } : control)),
      }),
      /negative_control_failed/,
    );
    assert.throws(
      () => buildI16FixtureEvidence({
        negativeControls: all.map((control, index) => (
          index === 0 ? { ...control, verificationSource: 'mock' as never } : control
        )),
      }),
      /negative_control_forbidden_source/,
    );
    assert.equal(base.binding.negativeControlCatalog.length, all.length);
    assert.ok(I16_TEST_REVISION.length >= 40);
    assert.ok(I16_TEST_TREE.length >= 40);
  });
});
