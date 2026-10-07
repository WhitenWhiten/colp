import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  classifyReplicaRenewalOutcome,
  validateReplicaLifecycleScope,
  validateReplicaLeaseDuration,
} from '../../../src/modules/sync/index.js';

test('P3-06 lifecycle scope requires canonical positive generation and revision fences', () => {
  assert.deepEqual(validateReplicaLifecycleScope({
    accountId: 'account-a', collectionId: 'collection-a', replicaId: 'replica-a',
    expectedLeaseGeneration: '7', expectedLifecycleRevision: '12',
  }), {
    accountId: 'account-a', collectionId: 'collection-a', replicaId: 'replica-a',
    expectedLeaseGeneration: '7', expectedLifecycleRevision: '12',
  });
  for (const value of ['0', '-1', '01', '1.0', '9007199254740992']) {
    assert.throws(() => validateReplicaLifecycleScope({
      accountId: 'account-a', collectionId: 'collection-a', replicaId: 'replica-a',
      expectedLeaseGeneration: value, expectedLifecycleRevision: '0',
    }), /generation/i);
  }
  for (const value of ['-1', '01', '1.0', '9007199254740992']) {
    assert.throws(() => validateReplicaLifecycleScope({
      accountId: 'account-a', collectionId: 'collection-a', replicaId: 'replica-a',
      expectedLeaseGeneration: '1', expectedLifecycleRevision: value,
    }), /revision/i);
  }
});

test('P3-06 lifecycle inputs reject unknown fields and unsafe lease bounds', () => {
  assert.equal(validateReplicaLeaseDuration(1), 1);
  assert.equal(validateReplicaLeaseDuration(2_592_000), 2_592_000);
  for (const value of [0, 2_592_001, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => validateReplicaLeaseDuration(value), /duration/i);
  }
  assert.throws(() => validateReplicaLifecycleScope({
    accountId: 'account-a', collectionId: 'collection-a', replicaId: 'replica-a',
    expectedLeaseGeneration: '1', expectedLifecycleRevision: '0', extra: true,
  } as never), /unknown field/i);
});

test('P3-06 failed Sync outcomes map to stable COLP denial codes without becoming success', () => {
  assert.deepEqual(classifyReplicaRenewalOutcome('unauthorized'), { code: 'unauthorized' });
  assert.deepEqual(classifyReplicaRenewalOutcome('stale'), { code: 'stale_replica' });
  for (const outcome of ['schema_rejected', 'request_failed', 'sequence_gap', 'policy_rejected'] as const) {
    assert.deepEqual(classifyReplicaRenewalOutcome(outcome), { code: 'request_failed' });
  }
  assert.equal(classifyReplicaRenewalOutcome('authorized_success'), null);
});
