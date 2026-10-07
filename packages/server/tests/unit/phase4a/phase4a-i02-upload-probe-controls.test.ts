import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  REQUIRED_CAPABILITIES,
  RW_CREDENTIAL_BYPASS_BOUNDARY,
  assertCompleteEvidence,
  assertRwCredentialBypassBoundary,
  buildTamperedRequest,
  newGenerationRecord,
  runUploadNegativeControl,
  runUploadScenario,
  sanitizeEvidence,
  stableProbeFailureCode,
} from '../../../scripts/evidence/phase4a-i02-upload-probe.js';
import type {
  CapabilityEvidence,
  HttpTransport,
  RawPutRequest,
} from '../../../scripts/evidence/phase4a-i02-upload-probe.js';
import {
  DEFAULT_BODY,
  depsWith,
  fakeStore,
  grantFromRecord,
  mutableClock,
  nextScenario,
  scenario,
} from '../../support/phase4a-i02-test-helpers.js';

describe('P4A-I02 create-only controls: expiry, negative controls, and secret hygiene', () => {
  test('expiry uses a controlled clock and records signing time, response class, and final exact HEAD', async () => {
    const clock = mutableClock();
    const before = await runUploadScenario(depsWith({ clock: clock.now }), nextScenario());
    assert.equal(before.class, 'verified');

    clock.advance(61_000);
    const absentStore = fakeStore({ head: () => ({ class: 'not_found', status: 404 }) });
    const after = await runUploadScenario(
      depsWith({
        clock: clock.now,
        store: absentStore,
        sleep: async (ms: number) => { clock.advance(ms); },
      }),
      nextScenario({ waitUntilExpiredMs: 120_000 }),
    );
    assert.equal(after.class, 'expired');
    assert.equal(after.completeClass, 'not_uploaded');
    assert.deepEqual(after.putClasses, ['expired']);
    assert.equal(after.observedSize, undefined);
    assert.equal(Date.parse(after.expiresAtIso!) - Date.parse(after.signedAtIso!), 60_000);
  });

  test('negative controls for wrong bucket/key/method and signed-header tampering are denied without retry', async () => {
    const controls = ['wrong_key', 'wrong_bucket', 'wrong_method', 'missing_signed_header', 'tampered_signed_header', 'duplicate_signed_header'] as const;
    for (const control of controls) {
      const requests: RawPutRequest[] = [];
      const transport: HttpTransport = {
        async request(method, request) {
          requests.push(request);
          return { status: 403, ok: false, headers: {}, bodyText: 'signature' };
        },
      };
      const out = await runUploadNegativeControl(depsWith({ transport }), nextScenario(), control);
      assert.equal(out.class, 'denied', control);
      assert.equal(out.putRequestCount, 1, control);
      assert.equal(requests.length, 1, control);
    }

    const params = nextScenario();
    const record = newGenerationRecord(params, () => new Date('2026-08-08T00:00:00.000Z'));
    const grant = grantFromRecord({ ...record, committedAtIso: '2026-08-08T00:00:01.000Z' }, params.body, {
      metadata: params.metadata, contentType: 'application/octet-stream', ttlSeconds: 60,
      now: () => new Date('2026-08-08T00:00:00.000Z'),
    });
    assert.equal(buildTamperedRequest(grant, params.body, 'wrong_method').method, 'GET');
    assert.equal(buildTamperedRequest(grant, params.body, 'wrong_key').request.url.includes(record.key), false);
    assert.equal(buildTamperedRequest(grant, params.body, 'wrong_bucket').request.url.includes(record.bucket), false);
    const missing = buildTamperedRequest(grant, params.body, 'missing_signed_header');
    assert.equal(missing.request.headers.some(([name]) => name.toLowerCase() === 'if-none-match'), false);
    const tampered = buildTamperedRequest(grant, params.body, 'tampered_signed_header');
    assert.ok(tampered.request.headers.some(([name, value]) => name.toLowerCase() === 'x-amz-meta-nonce' && value !== 'opaque-nonce-marker'));
    const duplicated = buildTamperedRequest(grant, params.body, 'duplicate_signed_header');
    assert.equal(duplicated.request.headers.filter(([name]) => name.toLowerCase() === 'if-none-match').length, 2);
  });

  test('rejects sensitive material in evidence and maps raw failures to one stable non-sensitive code', () => {
    const safe = sanitizeEvidence({
      schemaVersion: 5,
      task: 'phase4a-i02',
      target: 'cloudflare-r2-direct-object-api',
      providerMode: 'presigned-single-put-create-only',
      exposureMode: 'owner-private-unscanned',
      capabilities: [{ capability: 'single_put_grant_issued', verdict: 'pass' }],
    });
    assert.equal(safe.task, 'phase4a-i02');
    for (const forbidden of [
      'accountId', 'bucket', 'endpoint', 'accessKeyId', 'secretAccessKey', 'authorization',
      'credential', 'signature', 'signedUrl', 'presignedUrl', 'url', 'query', 'objectKey',
      'key', 'etag', 'body', 'rawError', 'digest', 'sha256', 'uploadId', 'copySource',
    ]) {
      assert.throws(() => sanitizeEvidence({ ...safe, [forbidden]: 'secret-marker' }), /sensitive_evidence_field/);
    }
    for (const note of [
      'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com/known-quarantine-production/capability-probes/x',
      'capability-probes/deployment-01/018f6f7a-8f2a-7a3d-a123-123456789abc',
      '?X-Amz-Signature=deadbeef&X-Amz-Credential=marker',
      'authorization: Bearer abc.def-ghi',
      'accessKeyId: write-access-key-marker',
    ]) {
      assert.throws(() => sanitizeEvidence({ ...safe, note }), /sensitive_evidence_value/);
    }
    assert.throws(() => sanitizeEvidence({ ...safe, note: 'opaque-etag-marker' }, ['opaque-etag-marker']), /sensitive_evidence_value/);

    assert.equal(stableProbeFailureCode(new Error('ledger_duplicate_generation')), 'ledger_duplicate_generation');
    assert.equal(stableProbeFailureCode(new Error('r2_single_put_ceiling_exceeded')), 'r2_single_put_ceiling_exceeded');
    assert.equal(stableProbeFailureCode(new Error(
      'fetch failed for https://secret.r2.cloudflarestorage.com/key?X-Amz-Signature=secret',
    )), 'probe_failed');
    assert.equal(stableProbeFailureCode('not-an-error'), 'probe_failed');
  });

  test('requires every create-only capability verdict and exposes the RW-credential bypass boundary', () => {
    const evidence: CapabilityEvidence[] = REQUIRED_CAPABILITIES.map((capability) => ({ capability, verdict: 'pass' }));
    assert.doesNotThrow(() => assertCompleteEvidence(evidence));
    assert.throws(
      () => assertCompleteEvidence(evidence.filter(({ capability }) => capability !== 'concurrent_same_url_single_winner')),
      /capability_missing:concurrent_same_url_single_winner/,
    );
    assert.throws(
      () => assertCompleteEvidence(evidence.map((entry) => (
        entry.capability === 'ledger_before_grant' ? { ...entry, verdict: 'fail' as const } : entry
      ))),
      /capability_failed:ledger_before_grant/,
    );
    assert.throws(() => assertCompleteEvidence([...evidence, evidence[0]!]), /capability_evidence_not_unique/);

    assertRwCredentialBypassBoundary(RW_CREDENTIAL_BYPASS_BOUNDARY);
    assert.throws(
      () => assertRwCredentialBypassBoundary({ ...RW_CREDENTIAL_BYPASS_BOUNDARY, rwCredentialOverwritePossible: false }),
      /rw_credential_bypass_boundary_misstated/,
    );
    assert.throws(
      () => assertRwCredentialBypassBoundary({ ...RW_CREDENTIAL_BYPASS_BOUNDARY, unconditionalPutInPort: true }),
      /rw_credential_bypass_boundary_misstated/,
    );
  });

  test('probe scenarios produce sanitized evidence without URLs, keys, signatures, or full digests', async () => {
    const out = await runUploadScenario(depsWith(), nextScenario());
    const evidence = sanitizeEvidence({
      schemaVersion: 5,
      task: 'phase4a-i02',
      target: 'cloudflare-r2-direct-object-api',
      providerMode: 'presigned-single-put-create-only',
      exposureMode: 'owner-private-unscanned',
      capabilities: REQUIRED_CAPABILITIES.map((capability) => ({ capability, verdict: 'pass' as const })),
      scenarios: [{
        scenario: 'correct_upload', class: out.class, putRequestCount: out.putRequestCount,
        putClasses: out.putClasses, completeClass: out.completeClass, recovery: out.recovery,
      }],
      threatBoundary: RW_CREDENTIAL_BYPASS_BOUNDARY,
    }, [
      'known-quarantine-production',
      'capability-probes/deployment-01/018f6f7a-8f2a-7a3d-a123-123456789abc',
      'https://r2.example/', 'write-access-key-marker', 'write-secret-access-key-marker',
      DEFAULT_BODY.toString('base64'), 'a'.repeat(64),
    ]);
    const json = JSON.stringify(evidence);
    for (const forbidden of ['X-Amz-', 'Signature=', 'Credential=', 'http://', 'https://', 'capability-probes/', 'write-access-']) {
      assert.equal(json.includes(forbidden), false, `evidence leaked ${forbidden}`);
    }
  });

  test('zero-length bodies are valid create-only uploads with a signed zero content-length', async () => {
    const body = Buffer.alloc(0);
    const store = fakeStore({
      head: () => ({ class: 'ok', size: 0, etag: '"empty"', metadata: { probe: 'phase4a-i02', nonce: 'opaque-nonce-marker' }, status: 200 }),
      readBounded: () => ({ class: 'ok', bytes: body }),
    });
    const out = await runUploadScenario(depsWith({ store }), nextScenario({ body }));
    assert.equal(out.class, 'verified');
    assert.equal(out.observedSize, 0);
    assert.deepEqual(out.putClasses, ['ok']);
    assert.equal(out.putRequestCount, 1);
  });

  test('a tampered scenario marker is never echoed back by the probe outcome or evidence', async () => {
    const marker = 'i02-secret-marker-8f3d';
    const params = scenario({ metadata: { probe: 'phase4a-i02', nonce: marker } });
    const store = fakeStore({
      head: () => ({ class: 'ok', size: params.body.byteLength, etag: '"e"', metadata: params.metadata, status: 200 }),
      readBounded: () => ({ class: 'ok', bytes: params.body }),
    });
    const out = await runUploadScenario(depsWith({ store }), params);
    assert.equal(out.class, 'verified');
    const serialized = JSON.stringify(out);
    assert.equal(serialized.includes(marker), false);
  });
});
