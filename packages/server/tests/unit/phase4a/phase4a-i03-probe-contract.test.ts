import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  REQUIRED_CAPABILITIES,
  assertCompleteEvidence,
  buildI03Evidence,
  runPhase4aI03VerificationProbe,
  selectVerificationReadEtag,
  stableProbeFailureCode,
} from '../../../scripts/evidence/phase4a-i03-probe.js';
import type { I03CapabilityEvidence } from '../../../scripts/evidence/phase4a-i03-probe.js';

describe('P4A-I03 real-target probe contract (R2 path, no network in unit scope)', () => {
  test('without the real R2 environment the probe fails closed with configuration_missing', async () => {
    await assert.rejects(
      runPhase4aI03VerificationProbe({}),
      /configuration_missing/,
    );
  });

  test('without a pinned source revision the probe refuses to run', async () => {
    const environment = {
      P4A_PROBE_TARGET: 'cloudflare-r2-direct-object-api',
      P4A_R2_ENDPOINT: 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
      P4A_R2_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
      P4A_R2_BUCKET: 'known-quarantine-production',
      P4A_R2_PROBE_PREFIX: 'capability-probes/deployment-01/',
      P4A_R2_ACCESS_KEY_ID: 'write-access-key-marker',
      P4A_R2_SECRET_ACCESS_KEY: 'write-secret-access-key-marker',
    };
    await assert.rejects(
      runPhase4aI03VerificationProbe(environment, {
        command: async () => ({ stdout: 'not-a-revision\n' }),
      }),
      /source_revision_unavailable/,
    );
  });

  test('a dirty source tree refuses the evidence run', async () => {
    const environment = {
      P4A_PROBE_TARGET: 'cloudflare-r2-direct-object-api',
      P4A_R2_ENDPOINT: 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
      P4A_R2_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
      P4A_R2_BUCKET: 'known-quarantine-production',
      P4A_R2_PROBE_PREFIX: 'capability-probes/deployment-01/',
      P4A_R2_ACCESS_KEY_ID: 'write-access-key-marker',
      P4A_R2_SECRET_ACCESS_KEY: 'write-secret-access-key-marker',
    };
    await assert.rejects(
      runPhase4aI03VerificationProbe(environment, {
        command: async (file: string, args: string[]) => {
          if (args.includes('rev-parse')) return { stdout: 'a'.repeat(40) };
          if (args.includes('status')) return { stdout: ' M scripts/evidence/phase4a-i03-probe.ts\n' };
          throw new Error('unexpected_command');
        },
      }),
      /source_worktree_not_clean/,
    );
  });

  test('the I03 capability catalog is complete and every verdict must pass', () => {
    const evidence: I03CapabilityEvidence[] = REQUIRED_CAPABILITIES.map((capability) => ({ capability, verdict: 'pass' }));
    assert.doesNotThrow(() => assertCompleteEvidence(evidence));
    assert.throws(
      () => assertCompleteEvidence(evidence.filter(({ capability }) => capability !== 'browser_active_content_never_executes')),
      /capability_missing:browser_active_content_never_executes/,
    );
    assert.throws(
      () => assertCompleteEvidence(evidence.map((entry) => (
        entry.capability === 'non_owner_zero_body' ? { ...entry, verdict: 'fail' as const } : entry
      ))),
      /capability_failed:non_owner_zero_body/,
    );
    assert.throws(() => assertCompleteEvidence([...evidence, evidence[0]!]), /capability_evidence_not_unique/);
    assert.ok(REQUIRED_CAPABILITIES.includes('streamed_byte_count'));
    assert.ok(REQUIRED_CAPABILITIES.includes('ordered_sha256_digest'));
    assert.ok(REQUIRED_CAPABILITIES.includes('fixed_prefix_mime_sniff'));
    assert.ok(REQUIRED_CAPABILITIES.includes('hard_ceiling_aborts_stream'));
    assert.ok(REQUIRED_CAPABILITIES.includes('zero_shared_projection'));
  });

  test('the ETag negative control changes the conditional read validator', () => {
    const observed = '"observed-etag"';
    const corrupted = '"wrong-declared-etag"';
    assert.equal(selectVerificationReadEtag(observed, {}), observed);
    assert.equal(selectVerificationReadEtag(observed, { etag: corrupted }), corrupted);
  });

  test('evidence builder pins owner-private-unscanned and never exposes secrets', () => {
    const capabilityToken = 'i03-11111111-1111-1111-1111-111111111111';
    const evidence = buildI03Evidence({
      capabilities: REQUIRED_CAPABILITIES.map((capability) => ({ capability, verdict: 'pass' })),
      scenarios: [{ scenario: 'verified_pdf', class: 'verified', mediaCategory: 'allowlisted' }],
      negativeControls: [{ control: 'non_owner_zero_body', status: 403, bytes: 0 }],
      forbiddenValues: [
        'known-quarantine-production',
        'capability-probes/deployment-01/018f6f7a-8f2a-7a3d-a123-123456789abc',
        'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
        capabilityToken,
        'write-access-key-marker',
        'write-secret-access-key-marker',
        'a'.repeat(64),
      ],
    });
    assert.equal(evidence.exposureMode, 'owner-private-unscanned');
    const json = JSON.stringify(evidence);
    for (const forbidden of ['X-Amz-', 'http://', 'https://', 'capability-probes/', 'write-access-', capabilityToken, 'a'.repeat(64)]) {
      assert.equal(json.includes(forbidden), false, `evidence leaked ${forbidden}`);
    }
    assert.equal(json.includes('"safe":true'), false);
    assert.equal(json.includes('"clean":true'), false);
    assert.equal(json.includes('"ready":true'), false);
  });

  test('stable probe failure codes are non-sensitive and stable', () => {
    assert.equal(stableProbeFailureCode(new Error('configuration_missing:P4A_R2_ENDPOINT')), 'configuration_missing');
    assert.equal(stableProbeFailureCode(new Error('source_revision_unavailable')), 'probe_failed');
    assert.equal(stableProbeFailureCode(new Error('browser_marker_executed')), 'browser_marker_executed');
    assert.equal(stableProbeFailureCode(new Error('browser_app_cookie_leaked')), 'browser_app_cookie_leaked');
    assert.equal(stableProbeFailureCode(new Error('delivery_issue_not_current_owner')), 'delivery_issue_not_current_owner');
    assert.equal(stableProbeFailureCode(new Error(
      'fetch failed for https://secret.r2.cloudflarestorage.com/key?X-Amz-Signature=deadbeef',
    )), 'probe_failed');
    assert.equal(stableProbeFailureCode('not-an-error'), 'probe_failed');
  });
});

