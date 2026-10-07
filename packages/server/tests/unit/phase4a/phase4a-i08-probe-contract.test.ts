/**
 * P4A-I08 real-target probe contract (R2 + PostgreSQL path, no network in
 * unit scope). Verifies the probe fails closed without `P4A_R2_*` or a
 * database URL, refuses dirty source trees / unpinned revisions, pins stable
 * failure codes, and produces sanitized evidence (no URL/key/credential).
 */
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  REQUIRED_CAPABILITIES,
  buildI08Evidence,
  runPhase4aI08UploadIntentProbe,
  stableProbeFailureCode,
  type I08CapabilityEvidence,
} from '../../../scripts/evidence/phase4a-i08-probe.js';

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

describe('P4A-I08 real-target probe contract', () => {
  test('without the real R2 environment the probe fails closed with configuration_missing', async () => {
    await assert.rejects(
      runPhase4aI08UploadIntentProbe({}),
      /configuration_missing/,
    );
  });

  test('without a database URL the probe fails closed with configuration_missing:DATABASE_URL', async () => {
    await assert.rejects(
      runPhase4aI08UploadIntentProbe(R2_ENVIRONMENT),
      /configuration_missing:DATABASE_URL/,
    );
  });

  test('without a pinned source revision the probe refuses to run', async () => {
    await assert.rejects(
      runPhase4aI08UploadIntentProbe({ ...R2_ENVIRONMENT, DATABASE_URL: 'postgres://known:known@localhost:5432/known_test' }, {
        command: async () => ({ stdout: 'not-a-revision\n', stderr: '' }),
      }),
      /source_revision_unavailable/,
    );
  });

  test('a dirty source tree refuses the evidence run', async () => {
    await assert.rejects(
      runPhase4aI08UploadIntentProbe({ ...R2_ENVIRONMENT, DATABASE_URL: 'postgres://known:known@localhost:5432/known_test' }, {
        command: async (file: string, args: string[]) => {
          if (args.includes('rev-parse')) return { stdout: 'a'.repeat(40), stderr: '' };
          if (args.includes('status')) return { stdout: ' M scripts/evidence/phase4a-i08-probe.ts\n', stderr: '' };
          throw new Error('unexpected_command');
        },
      }),
      /source_worktree_not_clean/,
    );
  });

  test('the capability catalog is complete and every verdict must pass', () => {
    const evidence: I08CapabilityEvidence[] = REQUIRED_CAPABILITIES.map((capability) => ({ capability, verdict: 'pass' }));
    assert.doesNotThrow(() => buildI08Evidence({
      capabilities: evidence,
      scenarios: [],
      negativeControls: [],
      forbiddenValues: [],
    }));
    assert.ok(REQUIRED_CAPABILITIES.includes('ledger_before_grant'));
    assert.ok(REQUIRED_CAPABILITIES.includes('external_put_single_success'));
    assert.ok(REQUIRED_CAPABILITIES.includes('same_binding_recover_same_identity'));
    assert.ok(REQUIRED_CAPABILITIES.includes('cleanup_exact_absent'));
    assert.ok(REQUIRED_CAPABILITIES.includes('csprng_collision_fresh_candidate'));
    assert.throws(
      () => buildI08Evidence({
        capabilities: evidence.filter(({ capability }) => capability !== 'ledger_before_grant'),
        scenarios: [],
        negativeControls: [],
        forbiddenValues: [],
      }),
      /capability_missing:ledger_before_grant/,
    );
  });

  test('sanitized evidence never exposes secrets, keys, or URLs', () => {
    const evidence = buildI08Evidence({
      capabilities: REQUIRED_CAPABILITIES.map((capability) => ({ capability, verdict: 'pass' })),
      scenarios: [{ scenario: 'ledger_before_grant_and_put', putStatus: 200 }],
      negativeControls: [],
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
  });

  test('stable probe failure codes are non-sensitive and stable', () => {
    assert.equal(stableProbeFailureCode(new Error('configuration_missing:P4A_R2_ENDPOINT')), 'configuration_missing');
    assert.equal(stableProbeFailureCode(new Error('ledger_not_before_put')), 'ledger_not_before_put');
    assert.equal(stableProbeFailureCode(new Error('external_put_failed')), 'external_put_failed');
    assert.equal(stableProbeFailureCode(new Error(
      'fetch failed for https://secret.r2.cloudflarestorage.com/key?X-Amz-Signature=deadbeef',
    )), 'probe_failed');
    assert.equal(stableProbeFailureCode('not-an-error'), 'probe_failed');
  });
});
