import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, test } from 'vitest';
import {
  REQUIRED_CAPABILITIES,
  assertAnonymousAccessDenied,
  assertCompleteEvidence,
  assertControlPlane,
  assertDistinctGenerationKeys,
  assertExactObjectIdentity,
  assertBoundCleanupCandidate,
  buildControlPlaneAttestorArgs,
  buildControlPlaneTargetBinding,
  buildConditionalCreateInput,
  buildConditionalHeadInput,
  buildConditionalReadInput,
  buildOpaqueProbeKey,
  buildRetiredGenerationDeleteInput,
  classifyProviderFailure,
  controlPlaneCommandEnvironment,
  fixedProbeCommandScripts,
  parseProbeConfiguration,
  sanitizeEvidence,
  stableProbeFailureCode,
} from '../../../scripts/evidence/phase4a-i01-capability-probe.js';

const FIXTURE_ROOT = resolve('tests/fixtures/phase4a');

const completeConfiguration = {
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

describe('P4A-I01 Cloudflare R2 immutable generation-key evidence', () => {
  test('pins direct R2, immutable physical generations and private-only exposure', async () => {
    const matrix = JSON.parse(await readFile(
      resolve(FIXTURE_ROOT, 'i01-capability-matrix.json'), 'utf8',
    )) as {
      schemaVersion: number;
      decision: Record<string, string>;
      requiredCapabilities: string[];
      safety: Record<string, unknown>;
      retention: Record<string, unknown>;
      recovery: Record<string, number>;
    };

    assert.equal(matrix.schemaVersion, 4);
    assert.equal(matrix.decision.productionProvider, 'cloudflare-r2-private-bucket');
    assert.equal(matrix.decision.accessMode, 'direct-object-api');
    assert.equal(matrix.decision.uploadedEvidence, 'authenticated-explicit-complete-authoritative-r2-head');
    assert.equal(matrix.decision.objectIdentity, 'logical-blob-with-immutable-physical-generation-key');
    assert.equal(matrix.decision.exposureMode, 'owner-private-unscanned');
    assert.equal(matrix.decision.malwareScanning, 'deferred-publication-and-sharing-gate');
    assert.deepEqual(new Set(matrix.requiredCapabilities), new Set(REQUIRED_CAPABILITIES));
    assert.deepEqual(matrix.safety, {
      logicalBlobIdentity: 'stable-database-blob-id',
      physicalGenerationIdentity: 'cryptographically-random-opaque-never-reused-exact-object-key',
      observedVersionCandidate: 'etag-size-required-metadata',
      runtimeWrites: 'conditional-if-none-match-star-only',
      providerPreventsUnconditionalOverwrite: false,
      replacement: 'new-generation-key-and-database-cas-never-same-key-overwrite',
      generationReuse: 'permanent-database-tombstone-rejects-reissue',
      identityMismatch: 'fail-closed-reconcile-no-active-generation-change',
      cleanup: 'database-fenced-retired-generation-exact-key-delete-confirm-absent',
      etagMeaning: 'provider-validator-not-content-digest',
      publicAccess: 'disabled-no-custom-domain-no-r2-dev',
      encryption: 'cloudflare-managed-at-rest-and-tls-in-transit',
      unscannedExposure: 'owner-only-forced-download-nosniff-isolated-origin-no-publication-no-sync',
    });
    assert.deepEqual(matrix.recovery, { rpoMinutes: 5, rtoMinutes: 60 });
    assert.deepEqual(matrix.retention, {
      issuedHours: 24,
      uploadedPrivateDays: 7,
      retiredGenerationTombstone: 'permanent',
      probeObjectsHours: 24,
    });
  });

  test('requires a real direct endpoint and distinct bucket-scoped read credentials', () => {
    const parsed = parseProbeConfiguration(completeConfiguration);
    assert.equal(parsed.target, 'cloudflare-r2-direct-object-api');
    assert.equal(parsed.endpoint.hostname, '0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com');
    for (const missing of Object.keys(completeConfiguration)) {
      assert.throws(
        () => parseProbeConfiguration(Object.fromEntries(
          Object.entries(completeConfiguration).filter(([name]) => name !== missing),
        )),
        /configuration_missing/,
      );
    }
    assert.throws(
      () => parseProbeConfiguration({ ...completeConfiguration, P4A_R2_ENDPOINT: 'http://example.invalid' }),
      /direct_r2_endpoint_required/,
    );
    assert.throws(
      () => parseProbeConfiguration({
        ...completeConfiguration,
        P4A_R2_READ_ACCESS_KEY_ID: completeConfiguration.P4A_R2_ACCESS_KEY_ID,
      }),
      /read_credential_must_be_distinct/,
    );
    assert.throws(
      () => parseProbeConfiguration({ ...completeConfiguration, P4A_R2_PROBE_PREFIX: 'quarantine/v1/' }),
      /dedicated_probe_prefix_required/,
    );
  });

  test('rejects non-direct targets, malformed endpoints, buckets, prefixes, and credentials', () => {
    assert.throws(
      () => parseProbeConfiguration({ ...completeConfiguration, P4A_PROBE_TARGET: 's3-compatible' }),
      /unsupported_probe_target/,
    );
    assert.throws(
      () => parseProbeConfiguration({ ...completeConfiguration, P4A_R2_ACCOUNT_ID: 'not-a-hex-account' }),
      /invalid_r2_account_id/,
    );
    for (const endpoint of [
      `https://wrong-account.r2.cloudflarestorage.com`,
      `https://${completeConfiguration.P4A_R2_ACCOUNT_ID}.r2.cloudflarestorage.com/path`,
      `https://user:pass@${completeConfiguration.P4A_R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      `https://${completeConfiguration.P4A_R2_ACCOUNT_ID}.r2.cloudflarestorage.com?x=1`,
      'not-a-url',
    ]) {
      assert.throws(
        () => parseProbeConfiguration({ ...completeConfiguration, P4A_R2_ENDPOINT: endpoint }),
        /direct_r2_endpoint_required/,
      );
    }
    for (const bucket of ['UPPER', 'ab', 'a_b', 'a.b.', 'a-']) {
      assert.throws(
        () => parseProbeConfiguration({ ...completeConfiguration, P4A_R2_BUCKET: bucket }),
        /invalid_r2_bucket/,
      );
    }
    for (const prefix of ['quarantine/v1/', 'capability-probes', 'capability-probes/']) {
      assert.throws(
        () => parseProbeConfiguration({ ...completeConfiguration, P4A_R2_PROBE_PREFIX: prefix }),
        /dedicated_probe_prefix_required/,
      );
    }
    assert.throws(
      () => parseProbeConfiguration({ ...completeConfiguration, P4A_R2_ACCESS_KEY_ID: 'short' }),
      /invalid_r2_credential/,
    );
    assert.throws(
      () => parseProbeConfiguration({
        ...completeConfiguration,
        P4A_R2_READ_SECRET_ACCESS_KEY: completeConfiguration.P4A_R2_SECRET_ACCESS_KEY,
      }),
      /read_credential_must_be_distinct/,
    );
    for (const name of ['P4A_R2_ENDPOINT', 'P4A_R2_BUCKET', 'P4A_R2_ACCESS_KEY_ID']) {
      assert.throws(
        () => parseProbeConfiguration({ ...completeConfiguration, [name]: '   ' }),
        /configuration_missing/,
      );
    }
  });

  test('accepts only independent live Cloudflare control-plane facts', () => {
    const safe = {
      schemaVersion: 3,
      nonce: '018f6f7a-8f2a-7a3d-a123-123456789abc',
      sourceRevision: '0123456789abcdef0123456789abcdef01234567',
      targetBinding: 'sha256:' + 'b'.repeat(64),
      verdictSource: 'cloudflare-control-api-live-query',
      provider: 'cloudflare-r2',
      accessMode: 'direct-object-api',
      bucketPrivate: true,
      customDomainEnabled: false,
      r2DevEnabled: false,
      managedEncryptionAtRest: 'cloudflare-provider-invariant',
      tlsRequired: true,
      writeCredentialScope: 'bucket-object-read-write',
      readCredentialScope: 'bucket-object-read-only',
      conditionalCreateContractRequired: true,
      providerPreventsUnconditionalOverwrite: false,
      retention: { probeObjectsMaximumAgeSeconds: 86400, quarantineAutomaticDeletion: false },
    };
    assert.doesNotThrow(() => assertControlPlane(safe, safe.nonce, safe.sourceRevision, safe.targetBinding));
    assert.throws(() => assertControlPlane(
      { ...safe, customDomainEnabled: true }, safe.nonce, safe.sourceRevision, safe.targetBinding,
    ), /r2_public_access_enabled/);
    assert.throws(() => assertControlPlane(
      { ...safe, providerPreventsUnconditionalOverwrite: true }, safe.nonce, safe.sourceRevision, safe.targetBinding,
    ), /r2_overwrite_limit_misstated/);
    assert.throws(() => assertControlPlane(
      { ...safe, readCredentialScope: 'bucket-object-read-write' }, safe.nonce, safe.sourceRevision, safe.targetBinding,
    ), /r2_credential_scope_not_narrow/);
    assert.throws(() => assertControlPlane(
      { ...safe, nonce: 'wrong' }, safe.nonce, safe.sourceRevision, safe.targetBinding,
    ), /r2_control_attestation_binding_mismatch/);
    assert.throws(() => assertControlPlane(
      { ...safe, verdictSource: 'static-config' }, safe.nonce, safe.sourceRevision, safe.targetBinding,
    ), /r2_control_attestation_not_independent/);
    assert.throws(() => assertControlPlane(
      { ...safe, targetBinding: 'sha256:' + 'c'.repeat(64) }, safe.nonce, safe.sourceRevision, safe.targetBinding,
    ), /r2_control_attestation_binding_mismatch/);
    assert.throws(() => assertControlPlane(
      { ...safe, schemaVersion: 4 }, safe.nonce, safe.sourceRevision, safe.targetBinding,
    ), /r2_control_attestation_binding_mismatch/);
    for (const retention of [
      { probeObjectsMaximumAgeSeconds: 0, quarantineAutomaticDeletion: false },
      { probeObjectsMaximumAgeSeconds: 86401, quarantineAutomaticDeletion: false },
      { probeObjectsMaximumAgeSeconds: 86400, quarantineAutomaticDeletion: true },
      { probeObjectsMaximumAgeSeconds: 1.5, quarantineAutomaticDeletion: false },
    ]) {
      assert.throws(() => assertControlPlane(
        { ...safe, retention }, safe.nonce, safe.sourceRevision, safe.targetBinding,
      ), /r2_retention_policy_mismatch/);
    }
    assert.throws(() => assertControlPlane(
      { ...safe, retention: { probeObjectsMaximumAgeSeconds: '86400', quarantineAutomaticDeletion: false } },
      safe.nonce, safe.sourceRevision, safe.targetBinding,
    ), /r2_retention_policy_mismatch/);
  });

  test('binds the control-plane query to the selected data-plane target without forwarding credentials', () => {
    const configuration = parseProbeConfiguration(completeConfiguration);
    const args = buildControlPlaneAttestorArgs(configuration, 'nonce-marker', 'source-revision-marker');
    assert.deepEqual(args, [
      '--nonce', 'nonce-marker', '--source-revision', 'source-revision-marker',
      '--account-id', completeConfiguration.P4A_R2_ACCOUNT_ID,
      '--bucket', completeConfiguration.P4A_R2_BUCKET,
      '--endpoint', completeConfiguration.P4A_R2_ENDPOINT,
    ]);
    assert.doesNotMatch(args.join(' '), /write-secret|read-secret|access-key-marker/u);
    assert.match(buildControlPlaneTargetBinding(configuration), /^sha256:[a-f0-9]{64}$/u);
    assert.deepEqual(controlPlaneCommandEnvironment({
      PATH: '/usr/bin',
      P4A_CLOUDFLARE_CONTROL_API_TOKEN: 'control-token-marker',
      P4A_R2_ACCESS_KEY_ID: 'write-access-marker',
      P4A_R2_SECRET_ACCESS_KEY: 'write-secret-marker',
      P4A_R2_READ_ACCESS_KEY_ID: 'read-access-marker',
      P4A_R2_READ_SECRET_ACCESS_KEY: 'read-secret-marker',
    }), { PATH: '/usr/bin', P4A_CLOUDFLARE_CONTROL_API_TOKEN: 'control-token-marker' });
  });

  test('binds attestation to the reviewed repository script', () => {
    const scripts = fixedProbeCommandScripts();
    assert.match(scripts.controlPlane.replaceAll('\\', '/'), /\/scripts\/phase4a-r2-control-attestor\.mjs$/u);
    const parsed = parseProbeConfiguration({
      ...completeConfiguration,
      P4A_CONTROL_PLANE_COMMAND_JSON: '["fake-attestor"]',
    });
    assert.equal('controlPlaneCommand' in parsed, false);
  });

  test('uses exact object identity evidence and refuses mismatch deletion', () => {
    const candidate = {
      key: 'capability-probes/deployment-01/018f6f7a-8f2a-7a3d-a123-123456789abc',
      size: 18,
      etag: 'opaque-provider-validator',
      metadata: { probe: 'phase4a-i01', nonce: 'opaque-nonce-marker' },
    };
    assert.doesNotThrow(() => assertExactObjectIdentity(candidate, { ...candidate }));
    assert.throws(
      () => assertExactObjectIdentity(candidate, { ...candidate, etag: 'changed' }),
      /object_identity_mismatch_reconcile_required/,
    );
    assert.throws(
      () => assertExactObjectIdentity(candidate, { ...candidate, metadata: {} }),
      /object_identity_mismatch_reconcile_required/,
    );
    assert.throws(
      () => assertExactObjectIdentity({ ...candidate, etag: '' }, candidate),
      /object_identity_evidence_missing/,
    );
    assert.throws(
      () => assertBoundCleanupCandidate(undefined, candidate),
      /object_identity_unbound_reconcile_required/,
    );
    assert.doesNotThrow(() => assertBoundCleanupCandidate(candidate, { ...candidate }));
  });

  test('uses conditional create/read and exact retired-generation delete', () => {
    const body = Buffer.from('probe');
    const identity = {
      key: 'capability-probes/deployment-01/018f6f7a-8f2a-7a3d-a123-123456789abc',
      etag: '"provider-validator"',
    };
    assert.deepEqual(buildConditionalCreateInput(
      'known-quarantine-production',
      'capability-probes/deployment-01/018f6f7a-8f2a-7a3d-a123-123456789abc',
      body,
      { probe: 'phase4a-i01' },
    ), {
      Bucket: 'known-quarantine-production',
      Key: 'capability-probes/deployment-01/018f6f7a-8f2a-7a3d-a123-123456789abc',
      Body: body,
      Metadata: { probe: 'phase4a-i01' },
      IfNoneMatch: '*',
    });
    assert.deepEqual(buildConditionalHeadInput('known-quarantine-production', identity), {
      Bucket: 'known-quarantine-production', Key: identity.key, IfMatch: identity.etag,
    });
    assert.deepEqual(buildConditionalReadInput('known-quarantine-production', identity), {
      Bucket: 'known-quarantine-production', Key: identity.key, IfMatch: identity.etag,
    });
    assert.deepEqual(buildRetiredGenerationDeleteInput('known-quarantine-production', identity.key), {
      Bucket: 'known-quarantine-production', Key: identity.key,
    });
    assert.doesNotThrow(() => assertDistinctGenerationKeys(identity.key, `${identity.key}-next`));
    assert.throws(() => assertDistinctGenerationKeys(identity.key, identity.key), /generation_key_reuse_detected/);
    assert.throws(() => assertDistinctGenerationKeys('', identity.key), /generation_key_reuse_detected/);
    assert.throws(() => assertDistinctGenerationKeys(identity.key, ''), /generation_key_reuse_detected/);
  });

  test('requires dedicated probe prefixes and valid random opaque key sources', () => {
    for (const prefix of ['quarantine/v1/', 'capability-probes', 'capability-probes/']) {
      assert.throws(() => buildOpaqueProbeKey(prefix), /dedicated_probe_prefix_required/);
    }
    assert.throws(
      () => buildOpaqueProbeKey('capability-probes/deployment-01/', () => 'not-a-uuid'),
      /invalid_opaque_key_source/,
    );
    const generated = buildOpaqueProbeKey('capability-probes/deployment-01/');
    assert.match(generated, /^capability-probes\/deployment-01\/[a-f0-9-]{36}$/u);
    assert.doesNotMatch(generated, /account|collection|node|attachment|filename/i);
  });

  test('requires direct conditional and permission-negative verdicts', () => {
    const evidence = REQUIRED_CAPABILITIES.map((capability) => ({ capability, verdict: 'pass' as const }));
    assert.doesNotThrow(() => assertCompleteEvidence(evidence));
    assert.throws(
      () => assertCompleteEvidence(evidence.filter(({ capability }) => capability !== 'concurrent_create_single_winner')),
      /capability_missing:concurrent_create_single_winner/,
    );
    assert.throws(
      () => assertCompleteEvidence(evidence.map((entry) => (
        entry.capability === 'read_credential_write_denied' ? { ...entry, verdict: 'fail' as const } : entry
      ))),
      /capability_failed:read_credential_write_denied/,
    );
    assert.throws(
      () => assertCompleteEvidence([...evidence, evidence[0]!]),
      /capability_evidence_not_unique/,
    );
  });

  test('maps direct provider failures to stable closed classes', async () => {
    const controls = JSON.parse(await readFile(
      resolve(FIXTURE_ROOT, 'i01-fault-controls.json'), 'utf8',
    )) as { providerErrorSamples: Record<string, string[]> };
    for (const [expected, samples] of Object.entries(controls.providerErrorSamples)) {
      for (const sample of samples) assert.equal(classifyProviderFailure(sample), expected);
    }
    assert.equal(classifyProviderFailure({ $metadata: { httpStatusCode: 412 } }), 'precondition');
    assert.equal(classifyProviderFailure({ $metadata: { httpStatusCode: 403 } }), 'denied');
    assert.equal(classifyProviderFailure({ $metadata: { httpStatusCode: 404 } }), 'not_found');
    assert.equal(classifyProviderFailure({ $metadata: { httpStatusCode: 429 } }), 'retryable');
    assert.equal(classifyProviderFailure({ $metadata: { httpStatusCode: 500 } }), 'retryable');
    assert.equal(classifyProviderFailure({ $metadata: { httpStatusCode: 503 } }), 'retryable');
    assert.equal(classifyProviderFailure({ $metadata: { httpStatusCode: 200 } }), 'unknown');
    assert.equal(classifyProviderFailure(new Error('PreconditionFailed')), 'precondition');
    assert.equal(classifyProviderFailure(new Error('SignatureDoesNotMatch')), 'denied');
    assert.equal(classifyProviderFailure(new Error('ServiceUnavailable')), 'retryable');
  });

  test('accepts only observed R2 anonymous denial responses', () => {
    for (const status of [400, 401, 403, 404]) {
      assert.doesNotThrow(() => assertAnonymousAccessDenied(status));
    }
    for (const status of [0, 200, 204, 301, 500, 503]) {
      assert.throws(() => assertAnonymousAccessDenied(status), /r2_anonymous_access_not_denied/);
    }
  });

  test('maps raw SDK and transport failures to one non-sensitive stable code', () => {
    assert.equal(stableProbeFailureCode(new Error('configuration_missing:P4A_R2_BUCKET')), 'configuration_missing');
    assert.equal(stableProbeFailureCode(new Error('r2_cleanup_unconfirmed_reconcile_required')),
      'r2_cleanup_unconfirmed_reconcile_required');
    assert.equal(stableProbeFailureCode(new Error(
      'fetch failed for https://secret.r2.cloudflarestorage.com/key?signature=secret',
    )), 'probe_failed');
    assert.equal(stableProbeFailureCode(new Error('The request signature we calculated does not match')),
      'probe_failed');
    assert.equal(stableProbeFailureCode('not-an-error'), 'probe_failed');
  });

  test('uses cryptographically random opaque keys and rejects all sensitive evidence', () => {
    const first = buildOpaqueProbeKey('capability-probes/deployment-01/', () => '018f6f7a-8f2a-7a3d-a123-123456789abc');
    const second = buildOpaqueProbeKey('capability-probes/deployment-01/', () => '018f6f7a-8f2a-7a3d-a123-123456789abd');
    assert.notEqual(first, second);
    assert.doesNotMatch(first, /account|collection|node|attachment|filename/i);

    const safe = sanitizeEvidence({
      schemaVersion: 4,
      target: 'cloudflare-r2-direct-object-api',
      providerMode: 'cloudflare-r2-immutable-generation-keys',
      exposureMode: 'owner-private-unscanned',
      capabilities: [{ capability: 'direct_endpoint_tls', verdict: 'pass' }],
    });
    assert.equal(safe.target, 'cloudflare-r2-direct-object-api');
    for (const forbidden of [
      'accountId', 'bucket', 'endpoint', 'accessKeyId', 'secretAccessKey', 'authorization',
      'credential', 'signature', 'signedUrl', 'objectKey', 'key', 'etag', 'body', 'rawError',
    ]) {
      assert.throws(() => sanitizeEvidence({ ...safe, [forbidden]: 'secret-marker' }), /sensitive_evidence_field/);
    }
    assert.throws(
      () => sanitizeEvidence({ ...safe, note: 'https://private.example/key?signature=secret' }),
      /sensitive_evidence_value/,
    );
    assert.throws(
      () => sanitizeEvidence({ ...safe, note: 'secret-hidden-in-note' }, ['secret-hidden-in-note']),
      /sensitive_evidence_value/,
    );
    for (const note of [
      'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
      'capability-probes/deployment-01/018f6f7a-8f2a-7a3d-a123-123456789abc',
      'authorization: Bearer abc.def-ghi',
      '?signature=deadbeef',
    ]) {
      assert.throws(() => sanitizeEvidence({ ...safe, note }), /sensitive_evidence_value/);
    }
    assert.throws(
      () => sanitizeEvidence({ capabilities: [{ capability: 'exact_key_head', verdict: 'pass', key: 'capability-probes/x' }] }),
      /sensitive_evidence_field/,
    );
    assert.throws(
      () => sanitizeEvidence({ ...safe, note: 'opaque-etag-marker' }, ['opaque-etag-marker']),
      /sensitive_evidence_value/,
    );
  });
});
