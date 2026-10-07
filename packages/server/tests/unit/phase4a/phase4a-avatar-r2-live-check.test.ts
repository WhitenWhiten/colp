import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  REQUIRED_CAPABILITIES,
  assertCompleteAvatarEvidence,
  stableAvatarFailureCode,
} from '../../../scripts/evidence/phase4a-avatar-r2-live-check.js';
import {
  parseProbeConfiguration,
} from '../../../scripts/evidence/phase4a-i01-capability-probe.js';

/**
 * The avatar real-R2 live check has TWO distinct surfaces:
 *
 *  1. pure functions (configuration parsing, capability accounting, stable
 *     failure codes) — tested here with SYNTHETIC values only, so the
 *     ordinary unit suite never needs the real-R2 credentials and never
 *     touches the network;
 *  2. the live provider run itself — executed ONLY through the isolated
 *     runner (`npm run local:phase4a-r2:run -- avatar confirm-real-r2`),
 *     which requires the explicit confirmation word and injects credentials
 *     from the gitignored local env file. The ordinary `npm test` suite must
 *     stay green without that file present.
 */

const syntheticConfiguration = {
  P4A_PROBE_TARGET: 'cloudflare-r2-direct-object-api',
  P4A_R2_ENDPOINT: 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
  P4A_R2_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
  P4A_R2_BUCKET: 'known-quarantine-production',
  P4A_R2_PROBE_PREFIX: 'capability-probes/local-avatar-check/',
  P4A_R2_ACCESS_KEY_ID: 'write-access-key-marker',
  P4A_R2_SECRET_ACCESS_KEY: 'write-secret-access-key-marker',
  P4A_R2_READ_ACCESS_KEY_ID: 'read-access-key-marker',
  P4A_R2_READ_SECRET_ACCESS_KEY: 'read-secret-access-key-marker',
};

describe('avatar real-R2 live check: configuration (synthetic, no network)', () => {
  test('parses the shared P4A real-R2 configuration contract', () => {
    const parsed = parseProbeConfiguration(syntheticConfiguration);
    assert.equal(parsed.target, 'cloudflare-r2-direct-object-api');
    assert.equal(parsed.bucket, 'known-quarantine-production');
    assert.equal(parsed.endpoint.hostname, '0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com');
  });

  test('fails closed with configuration_missing when any real-R2 key is absent', () => {
    for (const missing of Object.keys(syntheticConfiguration)) {
      assert.throws(
        () => parseProbeConfiguration(Object.fromEntries(
          Object.entries(syntheticConfiguration).filter(([name]) => name !== missing),
        )),
        /configuration_missing/,
        `missing ${missing} must fail closed`,
      );
    }
  });

  test('rejects endpoints that are not direct R2 S3 API URLs', () => {
    assert.throws(
      () => parseProbeConfiguration({ ...syntheticConfiguration, P4A_R2_ENDPOINT: 'http://example.invalid' }),
      /direct_r2_endpoint_required|s3_api_url_invalid/,
    );
  });
});

describe('avatar real-R2 live check: capability accounting', () => {
  test('the required capability set is complete and unique', () => {
    assert.deepEqual(
      new Set(REQUIRED_CAPABILITIES),
      new Set([
        'avatar_object_put',
        'avatar_object_read_back',
        'avatar_object_absent_null',
        'avatar_object_delete',
      ]),
    );
    assert.equal(new Set(REQUIRED_CAPABILITIES).size, REQUIRED_CAPABILITIES.length);
  });

  test('assertCompleteAvatarEvidence accepts exactly the full passing set', () => {
    assert.doesNotThrow(() => assertCompleteAvatarEvidence(
      REQUIRED_CAPABILITIES.map((capability) => ({ capability, verdict: 'pass' as const })),
    ));
  });

  test('assertCompleteAvatarEvidence rejects missing or failed capabilities', () => {
    const full = REQUIRED_CAPABILITIES.map((capability) => ({ capability, verdict: 'pass' as const }));
    assert.throws(
      () => assertCompleteAvatarEvidence(full.slice(0, full.length - 1)),
      /capability_missing:avatar_object_delete/,
    );
    assert.throws(
      () => assertCompleteAvatarEvidence(full.map((entry) => (
        entry.capability === 'avatar_object_put' ? { ...entry, verdict: 'fail' as const } : entry
      ))),
      /capability_failed:avatar_object_put/,
    );
    assert.throws(
      () => assertCompleteAvatarEvidence([...full, full[0]!]),
      /capability_evidence_not_unique/,
    );
  });
});

describe('avatar real-R2 live check: stable failure codes', () => {
  test('maps known avatar failure messages to stable codes', () => {
    assert.equal(stableAvatarFailureCode(new Error('avatar_object_body_mismatch')), 'avatar_object_body_mismatch');
    assert.equal(stableAvatarFailureCode(new Error('avatar_object_delete_not_absent')), 'avatar_object_delete_not_absent');
    assert.equal(stableAvatarFailureCode(new Error('r2_cleanup_unconfirmed_reconcile_required')), 'r2_cleanup_unconfirmed_reconcile_required');
    assert.equal(stableAvatarFailureCode(new Error('configuration_missing:P4A_R2_BUCKET')), 'configuration_missing');
  });

  test('collapses unknown failures to avatar_probe_failed without leaking details', () => {
    assert.equal(stableAvatarFailureCode(new Error('ECONNREFUSED 1.2.3.4')), 'avatar_probe_failed');
    assert.equal(stableAvatarFailureCode(new Error('https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com')), 'avatar_probe_failed');
    assert.equal(stableAvatarFailureCode('not an error'), 'avatar_probe_failed');
    assert.equal(stableAvatarFailureCode(undefined), 'avatar_probe_failed');
  });
});
