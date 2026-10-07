/**
 * P4A-I09 real-target probe contract (R2 + PostgreSQL path, no network in
 * unit scope). Verifies the probe fails closed without `P4A_R2_*` or a
 * database URL, refuses dirty source trees / unpinned revisions, pins stable
 * failure codes, and emits sanitized evidence with a closed capability
 * catalog that never claims clean/safe.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  REQUIRED_CAPABILITIES,
  buildI09Evidence,
  runPhase4aI09UploadVerificationProbe,
  stableProbeFailureCode,
  type I09CapabilityEvidence,
} from '../../../scripts/evidence/phase4a-i09-probe.js';

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

describe('P4A-I09 real-target probe contract', () => {
  test('without the real R2 environment the probe fails closed with configuration_missing', async () => {
    await assert.rejects(
      runPhase4aI09UploadVerificationProbe({}),
      /configuration_missing/,
    );
  });

  test('without a database URL the probe fails closed with configuration_missing:DATABASE_URL', async () => {
    await assert.rejects(
      runPhase4aI09UploadVerificationProbe(R2_ENVIRONMENT),
      /configuration_missing:DATABASE_URL/,
    );
  });

  test('without a pinned source revision the probe refuses to run', async () => {
    await assert.rejects(
      runPhase4aI09UploadVerificationProbe({ ...R2_ENVIRONMENT, DATABASE_URL: 'postgres://known:known@localhost:5432/known_test' }, {
        command: async () => ({ stdout: 'not-a-revision\n', stderr: '' }),
      }),
      /source_revision_unavailable/,
    );
  });

  test('a dirty source tree refuses the evidence run', async () => {
    await assert.rejects(
      runPhase4aI09UploadVerificationProbe({ ...R2_ENVIRONMENT, DATABASE_URL: 'postgres://known:known@localhost:5432/known_test' }, {
        command: async (file: string, args: string[]) => {
          if (args.includes('rev-parse')) return { stdout: 'a'.repeat(40), stderr: '' };
          if (args.includes('status')) return { stdout: ' M scripts/evidence/phase4a-i09-probe.ts\n', stderr: '' };
          throw new Error('unexpected_command');
        },
      }),
      /source_worktree_not_clean/,
    );
  });

  test('the capability catalog is complete, unique, and every verdict must pass', () => {
    const evidence: I09CapabilityEvidence[] = REQUIRED_CAPABILITIES.map((capability) => ({ capability, verdict: 'pass' }));
    assert.doesNotThrow(() => buildI09Evidence({
      capabilities: evidence,
      scenarios: [],
      negativeControls: [],
      forbiddenValues: [],
    }));
    assert.ok(REQUIRED_CAPABILITIES.includes('worker_verified_stored_private'));
    assert.ok(REQUIRED_CAPABILITIES.includes('verified_fields_match_r2_bytes'));
    assert.ok(REQUIRED_CAPABILITIES.includes('lease_steal_cas_fails'));
    assert.ok(REQUIRED_CAPABILITIES.includes('oversize_stream_aborted'));
    assert.ok(REQUIRED_CAPABILITIES.includes('crash_matrix_recovery'));
    assert.throws(
      () => buildI09Evidence({
        capabilities: evidence.filter(({ capability }) => capability !== 'worker_verified_stored_private'),
        scenarios: [],
        negativeControls: [],
        forbiddenValues: [],
      }),
      /capability_missing:worker_verified_stored_private/,
    );
  });

  test('sanitized evidence never exposes secrets, keys, URLs, or clean/safe claims', () => {
    const evidence = buildI09Evidence({
      capabilities: REQUIRED_CAPABILITIES.map((capability) => ({ capability, verdict: 'pass' })),
      scenarios: [{ scenario: 'worker_verified_stored_private', verifiedSize: 16 }],
      negativeControls: [{ control: 'lease_steal', casFails: true }],
      forbiddenValues: [
        'known-quarantine-production',
        'capability-probes/deployment-01/018f6f7a-8f2a-7a3d-a123-123456789abc',
        'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
        'write-access-key-marker',
        'write-secret-access-key-marker',
        'read-access-key-marker',
        'read-secret-access-key-marker',
      ],
    });
    assert.equal(evidence.exposureMode, 'owner-private-unscanned');
    const json = JSON.stringify(evidence);
    for (const forbidden of ['X-Amz-', 'http://', 'https://', 'capability-probes/', 'write-access-', 'read-access-', 'keyFingerprint', 'signedAtIso']) {
      assert.equal(json.includes(forbidden), false, `evidence leaked ${forbidden}`);
    }
    assert.equal(json.includes('"clean"'), false);
    assert.equal(json.includes('"safe"'), false);
    assert.equal(json.includes('scanner'), false);
  });

  test('stable probe failure codes are non-sensitive and stable', () => {
    assert.equal(stableProbeFailureCode(new Error('configuration_missing:P4A_R2_ENDPOINT')), 'configuration_missing');
    assert.equal(stableProbeFailureCode(new Error('verified_fields_mismatch')), 'verified_fields_mismatch');
    assert.equal(stableProbeFailureCode(new Error('r2_cleanup_unconfirmed_reconcile_required')), 'r2_cleanup_unconfirmed_reconcile_required');
    assert.equal(stableProbeFailureCode(new Error(
      'fetch failed for https://secret.r2.cloudflarestorage.com/key?X-Amz-Signature=deadbeef',
    )), 'probe_failed');
    assert.equal(stableProbeFailureCode('not-an-error'), 'probe_failed');
  });
});
