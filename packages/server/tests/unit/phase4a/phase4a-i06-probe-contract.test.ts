/**
 * P4A-I06 real-target probe contract (R2 path, no network in unit scope) plus
 * the bootstrap composition wiring. Verifies the probe fails closed without
 * P4A_R2_*, refuses dirty source trees, pins stable failure codes, produces
 * sanitized evidence, and that `composeAttachmentsObjectStorage` maps the
 * module-owned config onto the adapter through secret references.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  REQUIRED_CAPABILITIES,
  buildI06Evidence,
  buildMultiChunkBody,
  runPhase4aI06GenerationStoreProbe,
  sha256Hex,
  stableProbeFailureCode,
} from '../../../scripts/evidence/phase4a-i06-probe.js';
import type { I06CapabilityEvidence } from '../../../scripts/evidence/phase4a-i06-probe.js';
import { composeAttachmentsObjectStorage } from '../../../src/bootstrap/attachments-object-storage-composition.js';

const R2_ENVIRONMENT = {
  P4A_PROBE_TARGET: 'cloudflare-r2-direct-object-api',
  P4A_R2_ENDPOINT: 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
  P4A_R2_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
  P4A_R2_BUCKET: 'known-quarantine-production',
  P4A_R2_PROBE_PREFIX: 'capability-probes/deployment-01/',
  P4A_R2_ACCESS_KEY_ID: 'write-access-key-marker',
  P4A_R2_SECRET_ACCESS_KEY: 'write-secret-access-key-marker',
  P4A_R2_READ_ACCESS_KEY_ID: 'read-access-key-marker',
  P4A_R2_READ_SECRET_ACCESS_KEY: 'read-secret-access-key-marker',
};

const attachmentsConfig = {
  enabled: true as const,
  r2: {
    endpoint: 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
    region: 'auto',
    bucket: 'known-private-attachments',
    livePrefix: 'attachments/live/',
    probePrefix: 'attachments/probe/',
    rwSecretRef: 'known/r2/rw/primary',
    roSecretRef: 'known/r2/ro/primary',
  },
  grantTtlSeconds: 60,
  singlePutMaxBytes: 5 * 1024 * 1024,
  allowedMedia: ['image/png'],
  verification: { leaseMs: 60_000, timeoutMs: 15_000, retryCount: 2 },
  retention: { intentRetentionHours: 24, storedRetentionDays: 30, retiredRetentionDays: 90 },
  cleanupBatchSize: 100,
  cleanup: { leaseMs: 60_000, retryCount: 2 },
  isolatedDeliveryOrigin: 'https://delivery.known.test',
  deliveryCapabilitySecretRef: 'known/delivery/hmac/primary',
  deliveryCapabilityTtlSeconds: 60,
};

describe('P4A-I06 real-target probe contract', () => {
  test('without the real R2 environment the probe fails closed with configuration_missing', async () => {
    await assert.rejects(
      runPhase4aI06GenerationStoreProbe({}),
      /configuration_missing/,
    );
  });

  test('without a pinned source revision the probe refuses to run', async () => {
    await assert.rejects(
      runPhase4aI06GenerationStoreProbe(R2_ENVIRONMENT, {
        command: async () => ({ stdout: 'not-a-revision\n' }),
      }),
      /source_revision_unavailable/,
    );
  });

  test('a dirty source tree refuses the evidence run', async () => {
    await assert.rejects(
      runPhase4aI06GenerationStoreProbe(R2_ENVIRONMENT, {
        command: async (file: string, args: string[]) => {
          if (args.includes('rev-parse')) return { stdout: 'a'.repeat(40) };
          if (args.includes('status')) return { stdout: ' M scripts/evidence/phase4a-i06-probe.ts\n' };
          throw new Error('unexpected_command');
        },
      }),
      /source_worktree_not_clean/,
    );
  });

  test('the I06 capability catalog is complete and every verdict must pass', () => {
    const evidence: I06CapabilityEvidence[] = REQUIRED_CAPABILITIES.map((capability) => ({ capability, verdict: 'pass' }));
    assert.doesNotThrow(() => buildI06Evidence({
      capabilities: evidence,
      scenarios: [],
      negativeControls: [],
      forbiddenValues: [],
    }));
    assert.ok(REQUIRED_CAPABILITIES.includes('single_put_create_only_grant'));
    assert.ok(REQUIRED_CAPABILITIES.includes('multi_chunk_byte_flow'));
    assert.ok(REQUIRED_CAPABILITIES.includes('absence_confirmed_by_head'));
    assert.ok(REQUIRED_CAPABILITIES.includes('no_delete_precondition_claim'));
    assert.ok(REQUIRED_CAPABILITIES.includes('no_sdk_leak_across_port'));
    assert.ok(REQUIRED_CAPABILITIES.includes('unknown_not_misclassified_missing'));
    assert.ok(REQUIRED_CAPABILITIES.includes('aborted_stream_classified'));
    assert.ok(REQUIRED_CAPABILITIES.includes('contract_drift_classified'));
    assert.ok(REQUIRED_CAPABILITIES.includes('stream_overflow_destroys_body'));
    assert.ok(REQUIRED_CAPABILITIES.includes('client_shutdown_terminable'));
    assert.throws(
      () => buildI06Evidence({
        capabilities: evidence.filter(({ capability }) => capability !== 'multi_chunk_byte_flow'),
        scenarios: [],
        negativeControls: [],
        forbiddenValues: [],
      }),
      /capability_missing:multi_chunk_byte_flow/,
    );
    assert.throws(
      () => buildI06Evidence({
        capabilities: evidence.map((entry) => (
          entry.capability === 'exact_key_delete' ? { ...entry, verdict: 'fail' as const } : entry
        )),
        scenarios: [],
        negativeControls: [],
        forbiddenValues: [],
      }),
      /capability_failed:exact_key_delete/,
    );
  });

  test('evidence builder pins owner-private-unscanned and never exposes secrets or delete-precondition claims', () => {
    const capabilityToken = 'i06-11111111-1111-1111-1111-111111111111';
    const evidence = buildI06Evidence({
      capabilities: REQUIRED_CAPABILITIES.map((capability) => ({ capability, verdict: 'pass' })),
      scenarios: [{ scenario: 'single_put_create_only_grant', ifNoneMatch: '*' }],
      negativeControls: [{ control: 'ro_write_denied', class: 'denied' }],
      forbiddenValues: [
        'known-quarantine-production',
        'capability-probes/deployment-01/018f6f7a-8f2a-7a3d-a123-123456789abc',
        'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
        capabilityToken,
        'write-access-key-marker',
        'write-secret-access-key-marker',
        'read-access-key-marker',
        'read-secret-access-key-marker',
      ],
    });
    assert.equal(evidence.exposureMode, 'owner-private-unscanned');
    assert.equal(evidence.deletePreconditionClaimed, false);
    const json = JSON.stringify(evidence);
    for (const forbidden of ['X-Amz-', 'http://', 'https://', 'capability-probes/', 'write-access-', 'read-access-', capabilityToken]) {
      assert.equal(json.includes(forbidden), false, `evidence leaked ${forbidden}`);
    }
    assert.equal(json.includes('"safe":true'), false);
    assert.equal(json.includes('"clean":true'), false);
  });

  test('stable probe failure codes are non-sensitive and stable', () => {
    assert.equal(stableProbeFailureCode(new Error('configuration_missing:P4A_R2_ENDPOINT')), 'configuration_missing');
    assert.equal(stableProbeFailureCode(new Error('r2_cleanup_unconfirmed_reconcile_required')), 'r2_cleanup_unconfirmed_reconcile_required');
    assert.equal(stableProbeFailureCode(new Error('multi_chunk_read_mismatch')), 'multi_chunk_read_mismatch');
    assert.equal(stableProbeFailureCode(new Error('precondition_not_rejected')), 'precondition_not_rejected');
    assert.equal(stableProbeFailureCode(new Error(
      'fetch failed for https://secret.r2.cloudflarestorage.com/key?X-Amz-Signature=deadbeef',
    )), 'probe_failed');
    assert.equal(stableProbeFailureCode('not-an-error'), 'probe_failed');
  });

  test('the multi-chunk body builder is deterministic and independently verifiable', () => {
    const body = buildMultiChunkBody(64, 3, 'seed');
    assert.equal(body.length, 192);
    const again = buildMultiChunkBody(64, 3, 'seed');
    assert.ok(body.equals(again));
    assert.equal(sha256Hex(body), sha256Hex(again));
    assert.equal(sha256Hex(body).length, 64);
    assert.ok(body.subarray(0, 64).includes(Buffer.from('i06-chunk-seed-0|')));
    assert.ok(body.subarray(64, 128).includes(Buffer.from('i06-chunk-seed-1|')));
    assert.ok(body.subarray(128, 192).includes(Buffer.from('i06-chunk-seed-2|')));
  });

  test('composeAttachmentsObjectStorage maps config to the adapter through secret references', async () => {
    const resolved: string[] = [];
    const store = await composeAttachmentsObjectStorage(attachmentsConfig, async (secretRef) => {
      resolved.push(secretRef);
      if (secretRef === 'known/r2/rw/primary') {
        return { accessKeyId: 'rw-access-key-marker', secretAccessKey: 'rw-secret-access-key-marker' };
      }
      return { accessKeyId: 'ro-access-key-marker', secretAccessKey: 'ro-secret-access-key-marker' };
    });
    assert.deepEqual(resolved.sort(), ['known/r2/ro/primary', 'known/r2/rw/primary']);
    for (const method of ['issueCreateOnlyGrant', 'headExact', 'readBounded', 'deleteExact', 'confirmAbsent', 'probeCapability', 'close']) {
      assert.equal(typeof (store as unknown as Record<string, unknown>)[method], 'function', method);
    }
    await store.close();
  });

  test('composeAttachmentsObjectStorage fails closed when a secret reference cannot be resolved', async () => {
    await assert.rejects(
      composeAttachmentsObjectStorage(attachmentsConfig, async () => {
        throw new Error('secret_unavailable');
      }),
      /secret_unavailable/,
    );
  });
});
