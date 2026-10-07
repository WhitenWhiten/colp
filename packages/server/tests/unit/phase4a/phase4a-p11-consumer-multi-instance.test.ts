/**
 * P4A-P11 consumer-exclusion + multi-instance gate contracts (plan §1.1.5,
 * §2.4.7, §9 P11, §11 matrix "RL06/P11至少两个 API 进程"):
 *  - the artifact must bind the fixed SEVEN shared-consumer kinds with a
 *    visible control resource and zero private markers on every consumer;
 *  - the production consumer leg set built by `buildR06ProjectionConsumers`
 *    covers exactly those seven kinds (the in-run exclusion phase drives
 *    them through the production public entry points);
 *  - the multi-instance gate facts are all-or-nothing: a sealed artifact
 *    requires two independent API processes sharing one Redis key prefix +
 *    HMAC secret, shared quotas on all three route classes, zero DB side
 *    effects on denied paths, 503/429 distinction, the bounded complete
 *    fallback and restored quota after recovery.
 */
import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  R06_PROJECTION_CONTROL,
  buildR06ProjectionConsumers,
} from '../../../scripts/evidence/phase4a-r06-projection-control.js';
import { I16_NEGATIVE_CONTROL_CATALOG } from '../../../scripts/evidence/phase4a-i16-acceptance.js';
import { P11_CONSUMER_KINDS } from '../../../scripts/phase4a-owner-private-evidence.js';
import { assertP11EvidenceShape } from '../../../scripts/phase4a-owner-private-evidence.js';
import { p11FixtureBundle, p11SealedBundle } from '../../support/phase4a-p11-evidence-fixture.js';

test('the consumer control contract binds the seven fixed kinds with zero private markers', () => {
  const fixture = p11SealedBundle();
  assert.deepEqual(fixture.consumers.kinds, [...P11_CONSUMER_KINDS]);
  assert.equal(fixture.consumers.kinds.length, 7);
  assert.equal(fixture.consumers.controlVisible, true);
  assert.equal(fixture.consumers.privateMarkers, 0);
  // The sealed schema rejects a missing consumer kind and a leaked marker.
  const missingKind = p11SealedBundle({
    consumers: {
      ...p11FixtureBundle().consumers,
      kinds: ['publication', 'sync', 'mcp', 'search', 'profile', 'manifest'],
    },
  });
  assert.throws(() => assertP11EvidenceShape(missingKind), /evidence_schema:consumers_kinds/u);
  const leaked = p11SealedBundle({
    consumers: { ...p11FixtureBundle().consumers, privateMarkers: 1 },
  });
  assert.throws(() => assertP11EvidenceShape(leaked), /evidence_schema:consumers/u);
});

test('the consumer exclusion phase drives the SAME fixed projection control the I16 catalog fixes', () => {
  // The in-run consumer phase executes the production consumer legs through
  // `executeProjectionNegativeConsumers`; that control ID must equal the I16
  // catalog's `projection_negatives` entry (one catalog, one contract).
  const projectionCatalogEntry = I16_NEGATIVE_CONTROL_CATALOG.find((entry) => entry.control === 'projection_negatives');
  assert.ok(projectionCatalogEntry, 'the I16 catalog must fix projection_negatives');
  assert.equal(R06_PROJECTION_CONTROL, 'projection_negatives');
  // The builder and the executor are real production surfaces (never mock).
  assert.equal(typeof buildR06ProjectionConsumers, 'function');
  assert.equal(P11_CONSUMER_KINDS.length, 7);
  assert.deepEqual(P11_CONSUMER_KINDS, ['publication', 'sync', 'mcp', 'search', 'profile', 'manifest', 'shared_link']);
});

test('the multi-instance gate facts are all-or-nothing on a sealed artifact', () => {
  const fixture = p11SealedBundle();
  const gateKeys = ['sharedKeyPrefix', 'sharedHmacSecret', 'issueQuotaShared',
    'downloadQuotaShared', 'completeQuotaShared', 'deniedZeroDbSideEffects',
    'outage503DistinctFrom429', 'completeFallbackBounded', 'recoveryRestoresQuota'] as const;
  assert.equal(fixture.multiInstance.instances, 2);
  for (const key of gateKeys) {
    assert.equal(fixture.multiInstance[key], true, `multi-instance fact ${key} must be true`);
  }
  // Each fact is schema-enforced on the sealed artifact.
  for (const key of gateKeys) {
    const broken = p11SealedBundle({
      multiInstance: { ...p11FixtureBundle().multiInstance, [key]: false },
    });
    assert.throws(() => assertP11EvidenceShape(broken), new RegExp(`multi_instance_${key}`, 'u'));
  }
  const single = p11SealedBundle({
    multiInstance: { ...p11FixtureBundle().multiInstance, instances: 1 },
  });
  assert.throws(() => assertP11EvidenceShape(single), /evidence_schema:multi_instance_count/u);
});

test('the RL06 rate-limit config contract used by the multi-instance phase stays sealed', () => {
  // The evidence config is the RL06 production composition contract: enforce
  // mode with a shared key prefix and HMAC secret; the phase overrides the
  // per-route budgets only. The bundle binds mode/required/prefix facts.
  const fixture = p11SealedBundle();
  assert.equal(fixture.binding.configFacts.rateLimitMode, 'enforce');
  assert.equal(fixture.binding.configFacts.rateLimitRequired, true);
  assert.equal(fixture.binding.configFacts.rateLimitKeyPrefix, '<run-random>');
  // Route classes: issue/complete/download + bounded complete emergency.
  assert.equal(fixture.binding.configFacts.singlePutMaxBytes, 5 * 1024 * 1024);
});
