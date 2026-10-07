import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  ReplicaFactsValidationError,
  materializeReplicaWireFacts,
  validateReplicaCreateInput,
} from '../../../src/modules/sync/index.js';

const validInput = {
  accountId: 'account-1',
  collectionId: 'collection-1',
  deviceName: 'Alice laptop',
  replicaName: 'Chrome bookmarks',
  kind: 'browser_extension' as const,
  adapter: { profile: 'chromium-bookmarks-v1', version: '1.0.0' },
  capabilities: {
    read: true, write: true, events: true, separator: false, alias: false,
    annotations: 'sidecar' as const, maxBatchOperations: 200,
  },
  binding: {
    browserProfileId: 'profile-hmac-1', mountMode: 'whole-profile' as const,
    browserGeneration: 'installation-1',
  },
  leaseDurationSeconds: 3_600,
};

describe('Replica authoritative fact validation', () => {
  test('accepts the exact public COLP adapter/capability shape without native IDs', () => {
    const result = validateReplicaCreateInput(validInput, { actorAccountId: validInput.accountId });
    assert.deepEqual(result, validInput);
    assert.ok(Object.isFrozen(result));
    assert.ok(Object.isFrozen(result.capabilities));
  });

  test('rejects a trusted actor that does not match the payload account', () => {
    assert.throws(
      () => validateReplicaCreateInput(validInput, { actorAccountId: 'account-other' }),
      ReplicaFactsValidationError,
    );
  });

  test('rejects malformed binding, adapter, capability, duration, and extra fields', () => {
    const invalid: unknown[] = [
      { ...validInput, binding: { ...validInput.binding, mountMode: 'native-root' } },
      { ...validInput, binding: { ...validInput.binding, mountNativeId: '431' } },
      { ...validInput, adapter: { profile: '', version: '1' } },
      { ...validInput, capabilities: { ...validInput.capabilities, read: 'yes' } },
      { ...validInput, capabilities: { ...validInput.capabilities, annotations: 'html' } },
      { ...validInput, capabilities: { ...validInput.capabilities, maxBatchOperations: 0 } },
      { ...validInput, capabilities: { ...validInput.capabilities, secret: true } },
      { ...validInput, leaseDurationSeconds: 0 },
      { ...validInput, nativeBrowserId: 'forbidden' },
    ];
    for (const candidate of invalid) {
      assert.throws(
        () => validateReplicaCreateInput(candidate, { actorAccountId: validInput.accountId }),
        ReplicaFactsValidationError,
      );
    }
  });

  test('materializes a closed dual-read payload from relational authority', () => {
    const payload = materializeReplicaWireFacts({
      replicaId: 'replica-1', deviceId: 'device-1', accountId: 'account-1',
      collectionId: 'collection-1', replicaName: 'Chrome', kind: 'browser_extension',
      leaseId: 'lease-1', leaseGeneration: '1',
      adapter: validInput.adapter, capabilities: validInput.capabilities,
      binding: validInput.binding, checkpoint: {
        acknowledgedCursor: null, acknowledgedCommitOrdinal: null,
      },
      status: 'active',
    });
    assert.equal(payload.replicaId, 'replica-1');
    assert.equal(payload.binding.mountMode, 'whole-profile');
    assert.equal('mountNativeId' in payload.binding, false);
    assert.ok(Object.isFrozen(payload));
  });
});
