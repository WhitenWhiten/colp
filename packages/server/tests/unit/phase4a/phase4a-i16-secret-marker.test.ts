/**
 * P4A-I16 contract suite: secret marker scan over the evidence bundle.
 *
 * A single synthetic marker is placed into credential values, the control
 * token, physical keys, body bytes, and body digests. The serialized evidence
 * bundle must never contain the marker or any forbidden field/value class:
 * full keys, URLs, credentials, bodies (base64), filenames, or body digests.
 * Any leak makes `buildI16Evidence` fail closed with
 * `sensitive_evidence_value` / `sensitive_evidence_field`.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, test } from 'vitest';
import {
  I16_FORBIDDEN_SOURCES,
  buildI16Evidence,
  sanitizeI16Evidence,
} from '../../../scripts/evidence/phase4a-i16-acceptance.js';
import {
  I16_TEST_RUN_ID,
  buildI16FixtureEvidence,
  i16BindingFacts,
  i16ExecutionLedger,
  i16NegativeControls,
  i16PostRunChecks,
  i16Scenario,
} from '../../support/phase4a-i16-test-helpers.js';

describe('P4A-I16 secret marker scan', () => {
  test('a serialized evidence bundle never contains injected credential/key/body/digest markers', () => {
    const marker = `secret-${randomUUID()}`;
    const accessKey = `AK-${marker}`;
    const secretKey = `super-secret-${marker}`;
    const controlToken = `control-${marker}`;
    const physicalKey = `attachments/live/${marker}`;
    const bodyBase64 = Buffer.from(`body-${marker}`).toString('base64');
    const bodyDigest = `digest-${marker}`;

    const bundle = buildI16FixtureEvidence({
      forbiddenValues: [accessKey, secretKey, controlToken, physicalKey, bodyBase64, bodyDigest],
    });
    const serialized = JSON.stringify(bundle);
    assert.ok(!serialized.includes(marker), 'no credential/key/body/digest marker may serialize');
    assert.ok(!serialized.includes(accessKey));
    assert.ok(!serialized.includes(secretKey));
    assert.ok(!serialized.includes(controlToken));
    assert.ok(!serialized.includes(physicalKey));
    assert.ok(!serialized.includes(bodyBase64));
    assert.ok(!serialized.includes(bodyDigest));
  });

  test('buildI16Evidence fails closed when a forbidden value enters any field', () => {
    const marker = `secret-${randomUUID()}`;
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

  test('sanitizeI16Evidence rejects forbidden field names and forbidden values', () => {
    const marker = `secret-${randomUUID()}`;
    assert.throws(
      () => sanitizeI16Evidence({ key: marker }, [marker]),
      /sensitive_evidence_field/,
    );
    assert.throws(
      () => sanitizeI16Evidence({ note: marker }, [marker]),
      /sensitive_evidence_value/,
    );
    assert.throws(
      () => sanitizeI16Evidence({ url: `https://${marker}.example.com/x` }),
      /sensitive_evidence_value/,
    );
    assert.doesNotThrow(() => sanitizeI16Evidence({ note: 'protocol facts only' }, [marker]));
  });

  test('the bundle contains no URL/credential/body/filename/digest class values', () => {
    const bundle = buildI16FixtureEvidence();
    const serialized = JSON.stringify(bundle);
    assert.ok(!/https?:\/\//.test(serialized), 'no URL may serialize');
    assert.ok(!/r2\.cloudflarestorage\.com/.test(serialized), 'no provider endpoint may serialize');
    assert.ok(!/capability-probes\//.test(serialized), 'no probe prefix may serialize');
    for (const forbidden of ['accessKeyId', 'secretAccessKey', 'bearer ', 'authorization']) {
      assert.ok(!serialized.toLowerCase().includes(forbidden), `forbidden class ${forbidden} must not serialize`);
    }
  });

  test('forbidden sources are a closed deny list and never appear in the catalog', () => {
    assert.ok(I16_FORBIDDEN_SOURCES.includes('mock'));
    assert.ok(I16_FORBIDDEN_SOURCES.includes('skip'));
    assert.ok(I16_FORBIDDEN_SOURCES.includes('fixture'));
    assert.ok(I16_FORBIDDEN_SOURCES.includes('localhost-fake-r2'));
    assert.ok(I16_FORBIDDEN_SOURCES.includes('in-memory-fallback'));
  });

  test('a bundle with no leaks round-trips with the same canonical digest', () => {
    const bundle = buildI16FixtureEvidence();
    const executor = i16ExecutionLedger();
    const rebuilt = buildI16Evidence({
      binding: i16BindingFacts(),
      scenario: i16Scenario(),
      negativeControls: i16NegativeControls(),
      postRunChecks: i16PostRunChecks(),
      runId: I16_TEST_RUN_ID,
      executionReceipts: executor.toEvidenceReceipts(),
    });
    assert.equal(rebuilt.canonicalDigest, bundle.canonicalDigest);
  });
});
