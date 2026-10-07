import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  REQUIRED_CAPABILITIES,
  assertCompleteFaviconEvidence,
  stableFaviconFailureCode,
} from '../../../scripts/evidence/phase4a-favicon-r2-live-check.js';
import {
  parseProbeConfiguration,
} from '../../../scripts/evidence/phase4a-i01-capability-probe.js';

/**
 * The favicon real-R2 live check has TWO distinct surfaces:
 *
 *  1. pure functions (configuration parsing, capability accounting, stable
 *     failure codes) — tested here with SYNTHETIC values only, so the
 *     ordinary unit suite never needs the real-R2 credentials and never
 *     touches the network;
 *  2. the live provider run itself — executed ONLY through the isolated
 *     runner (`npm run local:phase4a-r2:run -- favicon confirm-real-r2`),
 *     which requires the explicit confirmation word and injects credentials
 *     from the gitignored local env file plus a dedicated fresh prefix. The
 *     ordinary `npm test` suite must stay green without that file present.
 */

const syntheticConfiguration = {
  P4A_PROBE_TARGET: 'cloudflare-r2-direct-object-api',
  P4A_R2_ENDPOINT: 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
  P4A_R2_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
  P4A_R2_BUCKET: 'known-quarantine-production',
  P4A_R2_PROBE_PREFIX: 'capability-probes/local-favicon-check/',
  P4A_R2_ACCESS_KEY_ID: 'write-access-key-marker',
  P4A_R2_SECRET_ACCESS_KEY: 'write-secret-access-key-marker',
  P4A_R2_READ_ACCESS_KEY_ID: 'read-access-key-marker',
  P4A_R2_READ_SECRET_ACCESS_KEY: 'read-secret-access-key-marker',
};

describe('favicon real-R2 live check: configuration (synthetic, no network)', () => {
  test('parses the shared P4A real-R2 configuration contract', () => {
    const parsed = parseProbeConfiguration(syntheticConfiguration);
    assert.equal(parsed.target, 'cloudflare-r2-direct-object-api');
    assert.equal(parsed.bucket, 'known-quarantine-production');
    assert.equal(parsed.endpoint.hostname, '0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com');
    assert.equal(parsed.prefix, 'capability-probes/local-favicon-check/');
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

  test('rejects prefixes outside the dedicated capability-probes namespace', () => {
    assert.throws(
      () => parseProbeConfiguration({ ...syntheticConfiguration, P4A_R2_PROBE_PREFIX: 'favicon/' }),
      /dedicated_probe_prefix_required/,
    );
  });
});

describe('favicon real-R2 live check: capability accounting', () => {
  test('the required capability set is complete and unique', () => {
    assert.deepEqual(
      new Set(REQUIRED_CAPABILITIES),
      new Set([
        'favicon_object_put',
        'favicon_object_read_back',
        'favicon_object_absent_null',
        'favicon_object_delete',
      ]),
    );
    assert.equal(new Set(REQUIRED_CAPABILITIES).size, REQUIRED_CAPABILITIES.length);
  });

  test('assertCompleteFaviconEvidence accepts exactly the full passing set', () => {
    assert.doesNotThrow(() => assertCompleteFaviconEvidence(
      REQUIRED_CAPABILITIES.map((capability) => ({ capability, verdict: 'pass' as const })),
    ));
  });

  test('assertCompleteFaviconEvidence rejects missing or failed capabilities', () => {
    const full = REQUIRED_CAPABILITIES.map((capability) => ({ capability, verdict: 'pass' as const }));
    assert.throws(
      () => assertCompleteFaviconEvidence(full.slice(0, full.length - 1)),
      /capability_missing:favicon_object_delete/,
    );
    assert.throws(
      () => assertCompleteFaviconEvidence(full.map((entry) => (
        entry.capability === 'favicon_object_put' ? { ...entry, verdict: 'fail' as const } : entry
      ))),
      /capability_failed:favicon_object_put/,
    );
    assert.throws(
      () => assertCompleteFaviconEvidence([...full, full[0]!]),
      /capability_evidence_not_unique/,
    );
  });
});

describe('favicon real-R2 live check: stable failure codes', () => {
  test('maps known favicon failure messages to stable codes', () => {
    assert.equal(stableFaviconFailureCode(new Error('favicon_object_body_mismatch')), 'favicon_object_body_mismatch');
    assert.equal(stableFaviconFailureCode(new Error('favicon_object_delete_not_absent')), 'favicon_object_delete_not_absent');
    assert.equal(stableFaviconFailureCode(new Error('r2_cleanup_unconfirmed_reconcile_required')), 'r2_cleanup_unconfirmed_reconcile_required');
    assert.equal(stableFaviconFailureCode(new Error('configuration_missing:P4A_R2_BUCKET')), 'configuration_missing');
  });

  test('collapses unknown failures to favicon_probe_failed without leaking details', () => {
    assert.equal(stableFaviconFailureCode(new Error('ECONNREFUSED 1.2.3.4')), 'favicon_probe_failed');
    assert.equal(stableFaviconFailureCode(new Error('https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com')), 'favicon_probe_failed');
    assert.equal(stableFaviconFailureCode('not an error'), 'favicon_probe_failed');
    assert.equal(stableFaviconFailureCode(undefined), 'favicon_probe_failed');
  });
});