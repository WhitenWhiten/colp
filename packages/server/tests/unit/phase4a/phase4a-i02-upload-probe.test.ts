import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, test } from 'vitest';
import { S3Client } from '@aws-sdk/client-s3';
import {
  RW_CREDENTIAL_BYPASS_BOUNDARY,
  SINGLE_PUT_COMPILE_LIMIT_BYTES,
  SINGLE_PUT_HARD_CEILING_BYTES,
  S3Presigner,
  DEFAULT_GRANT_TTL_SECONDS,
  MAX_GRANT_TTL_SECONDS,
  MIN_GRANT_TTL_SECONDS,
  buildOpaqueProbeKey,
  buildPresignedPutCommand,
  buildRawPutRequest,
  classifyHttpStatus,
  classifyProviderFailure,
  classifyPutResponse,
  classifyTransportError,
  completeExactGeneration,
  computeKeyFingerprint,
  isGrantExpired,
  newGenerationRecord,
  parseProbeConfiguration,
  recoverUploadScenario,
  runConcurrentUploads,
  runDuplicateUploads,
  runUploadScenario,
} from '../../../scripts/evidence/phase4a-i02-upload-probe.js';
import type { GenerationLedgerRecord } from '../../../scripts/evidence/phase4a-i02-generation-ledger.js';
import type {
  CompleteBinding,
  HttpTransport,
  Presigner,
  RawPutRequest,
} from '../../../scripts/evidence/phase4a-i02-upload-probe.js';
import {
  KEY_PREFIX,
  completeConfiguration,
  conditionalTransport,
  depsWith,
  fakeStore,
  grantFromRecord,
  memoryLedger,
  nextScenario,
  opaqueKey,
  scenario,
  storedMetadata,
  uuidFor,
} from '../../support/phase4a-i02-test-helpers.js';

const FIXTURE_ROOT = resolve('tests/fixtures/phase4a');

describe('P4A-I02 create-only direct upload probe', () => {
  test('pins the grant contract fixture and single-PUT hard ceiling', async () => {
    const fixture = JSON.parse(await readFile(resolve(FIXTURE_ROOT, 'i02-grant-contract.json'), 'utf8')) as {
      schemaVersion: number;
      grant: { method: string; singlePutOnly: boolean; ifNoneMatch: string; signedHeaders: string[];
        ttlSeconds: { min: number; max: number; default: number }; urlLifetime: string;
        multipart: boolean; copyOver: boolean; unconditionalPut: boolean };
      hardCeilingBytes: number; compileLimitBytes: number;
      threatBoundary: Record<string, unknown>;
    };
    assert.equal(fixture.schemaVersion, 5);
    assert.equal(SINGLE_PUT_HARD_CEILING_BYTES, fixture.hardCeilingBytes);
    assert.equal(SINGLE_PUT_COMPILE_LIMIT_BYTES, fixture.compileLimitBytes);
    assert.ok(SINGLE_PUT_HARD_CEILING_BYTES < SINGLE_PUT_COMPILE_LIMIT_BYTES);
    assert.equal(DEFAULT_GRANT_TTL_SECONDS, fixture.grant.ttlSeconds.default);
    assert.equal(MIN_GRANT_TTL_SECONDS, fixture.grant.ttlSeconds.min);
    assert.equal(MAX_GRANT_TTL_SECONDS, fixture.grant.ttlSeconds.max);
    assert.equal(fixture.grant.method, 'PUT');
    assert.equal(fixture.grant.singlePutOnly, true);
    assert.equal(fixture.grant.ifNoneMatch, '*');
    assert.deepEqual(fixture.grant.signedHeaders, ['content-length', 'host', 'if-none-match', 'x-amz-meta-*']);
    assert.equal(fixture.grant.urlLifetime, 'current-response-memory-only');
    assert.equal(fixture.grant.multipart, false);
    assert.equal(fixture.grant.copyOver, false);
    assert.equal(fixture.grant.unconditionalPut, false);
    assert.deepEqual(fixture.threatBoundary, RW_CREDENTIAL_BYPASS_BOUNDARY);
  });

  test('requires a real direct R2 configuration and never fabricates a target', () => {
    const parsed = parseProbeConfiguration(completeConfiguration);
    assert.equal(parsed.target, 'cloudflare-r2-direct-object-api');
    assert.equal(parsed.bucket, 'known-quarantine-production');
    assert.equal(parsed.prefix, 'capability-probes/deployment-01/');
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
      () => parseProbeConfiguration({ ...completeConfiguration, P4A_R2_PROBE_PREFIX: 'quarantine/v1/' }),
      /dedicated_probe_prefix_required/,
    );
    assert.throws(
      () => parseProbeConfiguration({ ...completeConfiguration, P4A_R2_ACCESS_KEY_ID: 'short' }),
      /invalid_r2_credential/,
    );
    assert.throws(
      () => parseProbeConfiguration({ ...completeConfiguration, P4A_PROBE_TARGET: 's3-compatible' }),
      /unsupported_probe_target/,
    );
  });

  test('builds cryptographically random opaque keys and stable fingerprints', () => {
    const key = buildOpaqueProbeKey(KEY_PREFIX);
    assert.match(key, /^capability-probes\/deployment-01\/[a-f0-9-]{36}$/u);
    assert.doesNotMatch(key, /account|collection|node|attachment|filename/i);
    const fingerprint = computeKeyFingerprint(key);
    assert.match(fingerprint, /^[a-f0-9]{64}$/u);
    assert.notEqual(fingerprint, computeKeyFingerprint(buildOpaqueProbeKey(KEY_PREFIX)));
    assert.throws(() => buildOpaqueProbeKey('quarantine/v1/'), /dedicated_probe_prefix_required/);
  });

  test('new generation records come only from committed ledger facts', () => {
    const params = scenario();
    const record = newGenerationRecord(params, () => new Date('2026-08-08T00:00:00.000Z'));
    assert.equal(record.schemaVersion, 2);
    assert.equal(record.intentId, params.intentId);
    assert.equal(record.generationId, params.generationId);
    assert.equal(record.blobId, params.blobId);
    assert.equal(record.bucket, params.bucket);
    assert.equal(record.key, params.key);
    assert.equal(record.fingerprint, computeKeyFingerprint(params.key));
    assert.equal(record.createdAtIso, '2026-08-08T00:00:00.000Z');
    assert.equal('committedAtIso' in record, false);
  });

  test('builds an exact-key single-PUT conditional command from ledger facts only', () => {
    const record = {
      schemaVersion: 2 as const, intentId: uuidFor(1), generationId: uuidFor(2), blobId: uuidFor(3),
      bucket: 'known-quarantine-production', key: opaqueKey(), fingerprint: 'a'.repeat(64),
      createdAtIso: '2026-08-08T00:00:00.000Z', committedAtIso: '2026-08-08T00:00:01.000Z',
    };
    const body = Buffer.from('bytes');
    const metadata = { probe: 'phase4a-i02', nonce: 'opaque-nonce-marker' };
    const input = buildPresignedPutCommand(record, body, metadata, 'application/octet-stream');
    assert.equal(input.Bucket, record.bucket);
    assert.equal(input.Key, record.key);
    assert.equal(input.IfNoneMatch, '*');
    assert.deepEqual(input.Metadata, metadata);
    assert.equal(input.ContentType, 'application/octet-stream');
    assert.ok(input.Body instanceof Uint8Array);
    assert.equal('UploadId' in input, false);
    assert.equal('CopySource' in input, false);
    assert.equal('PartNumber' in input, false);
  });

  test('the real S3 presigner emits a short-lived single-PUT URL with create-only signed headers', async () => {
    const client = new S3Client({
      endpoint: 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
      region: 'auto',
      forcePathStyle: true,
      credentials: { accessKeyId: 'AAAAAAAAAAAAAAAAAAAA', secretAccessKey: 'x'.repeat(40) },
      maxAttempts: 1,
      requestChecksumCalculation: 'WHEN_REQUIRED',
    });
    const presigner = new S3Presigner(client);
    const record = {
      schemaVersion: 2 as const, intentId: uuidFor(1), generationId: uuidFor(2), blobId: uuidFor(3),
      bucket: 'known-quarantine-production', key: opaqueKey(), fingerprint: 'a'.repeat(64),
      createdAtIso: '2026-08-08T00:00:00.000Z', committedAtIso: '2026-08-08T00:00:01.000Z',
    };
    const body = Buffer.from('probe-bytes');
    const grant = await presigner.presignPut(record, body, {
      metadata: { probe: 'phase4a-i02', nonce: 'opaque-nonce-marker' },
      contentType: 'application/octet-stream',
      ttlSeconds: 60,
      now: () => new Date('2026-08-08T00:00:00.000Z'),
    });
    assert.equal(grant.method, 'PUT');
    assert.equal(grant.ifNoneMatch, '*');
    assert.equal(grant.bucket, record.bucket);
    assert.equal(grant.key, record.key);
    assert.equal(grant.keyFingerprint, record.fingerprint);
    assert.equal(grant.contentLength, body.byteLength);
    assert.equal(grant.ttlSeconds, 60);
    assert.equal(Date.parse(grant.expiresAtIso) - Date.parse(grant.signedAtIso), 60_000);
    const url = new URL(grant.url);
    assert.equal(url.searchParams.get('x-id'), 'PutObject');
    assert.equal(url.searchParams.get('X-Amz-Expires'), '60');
    const signedHeaders = (url.searchParams.get('X-Amz-SignedHeaders') ?? '').split(';');
    assert.ok(signedHeaders.includes('if-none-match'));
    assert.ok(signedHeaders.includes('content-length'));
    assert.ok(signedHeaders.includes('x-amz-meta-probe'));
    assert.equal(url.searchParams.has('uploads'), false);
    assert.equal(url.searchParams.has('partNumber'), false);
    assert.equal(url.searchParams.has('x-amz-copy-source'), false);
  });

  test('the raw PUT request always carries the exact signed headers and byte count', () => {
    const params = scenario();
    const record = newGenerationRecord(params, () => new Date('2026-08-08T00:00:00.000Z'));
    const grant = grantFromRecord({ ...record, committedAtIso: '2026-08-08T00:00:01.000Z' }, params.body, {
      metadata: params.metadata, contentType: 'application/octet-stream', ttlSeconds: 60,
      now: () => new Date('2026-08-08T00:00:00.000Z'),
    });
    const request = buildRawPutRequest(grant, params.body);
    assert.equal(request.method, 'PUT');
    assert.equal(request.url, grant.url);
    assert.equal(request.contentLength, params.body.byteLength);
    const names = request.headers.map(([name]) => name.toLowerCase());
    assert.ok(names.includes('if-none-match'));
    assert.equal(request.headers.find(([name]) => name.toLowerCase() === 'if-none-match')![1], '*');
    assert.ok(names.includes('content-type'));
    assert.ok(names.includes('x-amz-meta-probe'));
    assert.ok(names.includes('x-amz-meta-nonce'));
    assert.equal(request.headers.filter(([name]) => name.toLowerCase() === 'if-none-match').length, 1);

    const dropped = buildRawPutRequest(grant, params.body, { dropHeaders: ['if-none-match'] });
    assert.equal(dropped.headers.some(([name]) => name.toLowerCase() === 'if-none-match'), false);
    const replaced = buildRawPutRequest(grant, params.body, { replaceHeaders: { 'x-amz-meta-nonce': 'tampered' } });
    assert.ok(replaced.headers.some(([name, value]) => name.toLowerCase() === 'x-amz-meta-nonce' && value === 'tampered'));
    const duplicated = buildRawPutRequest(grant, params.body, { duplicateHeaders: ['if-none-match'] });
    assert.equal(duplicated.headers.filter(([name]) => name.toLowerCase() === 'if-none-match').length, 2);
    assert.throws(
      () => buildRawPutRequest(grant, Buffer.from('a-different-length-body')),
      /grant_content_length_mismatch/,
    );
  });
  test('classifies HTTP statuses, transport failures, and provider errors into stable closed classes', async () => {
    const controls = JSON.parse(await readFile(resolve(FIXTURE_ROOT, 'i02-fault-controls.json'), 'utf8')) as {
      putResponseSamples: Record<string, number[]>;
      providerErrorSamples: Record<string, string[]>;
    };
    for (const [expected, statuses] of Object.entries(controls.putResponseSamples)) {
      for (const status of statuses) assert.equal(classifyHttpStatus(status), expected);
    }
    const probeModule = await import('../../../scripts/evidence/phase4a-i02-upload-probe.js');
    assert.equal(classifyTransportError(new probeModule.PutTransportError('retryable', 'timeout')), 'retryable');
    assert.equal(classifyTransportError(new probeModule.PutTransportError('aborted', 'abort')), 'aborted');
    assert.equal(classifyTransportError(new probeModule.PutTransportError('unknown', 'lost', true)), 'unknown');
    assert.equal(classifyTransportError(Object.assign(new Error('timeout'), { name: 'TimeoutError' })), 'retryable');
    assert.equal(classifyTransportError(Object.assign(new Error('aborted'), { name: 'AbortError' })), 'retryable');
    assert.equal(classifyTransportError(new TypeError('fetch failed')), 'unknown');
    for (const [expected, samples] of Object.entries(controls.providerErrorSamples)) {
      for (const sample of samples) assert.equal(classifyProviderFailure(sample), expected);
    }
    assert.equal(classifyProviderFailure({ $metadata: { httpStatusCode: 412 } }), 'precondition');
    assert.equal(classifyProviderFailure({ $metadata: { httpStatusCode: 404 } }), 'not_found');
    assert.equal(classifyProviderFailure({ $metadata: { httpStatusCode: 403 } }), 'denied');
    assert.equal(classifyProviderFailure({ $metadata: { httpStatusCode: 429 } }), 'retryable');
    assert.equal(classifyProviderFailure({ $metadata: { httpStatusCode: 503 } }), 'retryable');
    assert.equal(classifyProviderFailure({ $metadata: { httpStatusCode: 200 } }), 'unknown');
  });

  test('separates expiry, signer clock skew, network loss, and true precondition failures', () => {
    const params = scenario();
    const record = newGenerationRecord(params, () => new Date('2026-08-08T00:00:00.000Z'));
    const grant = grantFromRecord({ ...record, committedAtIso: '2026-08-08T00:00:01.000Z' }, params.body, {
      metadata: params.metadata, contentType: 'application/octet-stream', ttlSeconds: 60,
      now: () => new Date('2026-08-08T00:00:00.000Z'),
    });
    assert.equal(isGrantExpired(grant, new Date('2026-08-08T00:00:59.999Z')), false);
    assert.equal(isGrantExpired(grant, new Date('2026-08-08T00:01:00.000Z')), true);
    assert.equal(classifyPutResponse({ status: 200, ok: true, headers: {}, bodyText: '' }, grant, new Date('2026-08-08T00:00:30.000Z')), 'ok');
    assert.equal(classifyPutResponse({ status: 412, ok: false, headers: {}, bodyText: '' }, grant, new Date('2026-08-08T00:00:30.000Z')), 'precondition');
    assert.equal(classifyPutResponse({ status: 403, ok: false, headers: {}, bodyText: '' }, grant, new Date('2026-08-08T00:00:30.000Z')), 'denied');
    assert.equal(classifyPutResponse({ status: 403, ok: false, headers: {}, bodyText: '' }, grant, new Date('2026-08-08T00:01:00.000Z')), 'expired');
    assert.equal(classifyPutResponse({ status: 200, ok: true, headers: {}, bodyText: '' }, grant, new Date('2026-08-08T00:01:00.000Z')), 'expired');
    assert.equal(classifyPutResponse({ status: 404, ok: false, headers: {}, bodyText: '' }, grant, new Date('2026-08-08T00:00:30.000Z')), 'not_found');
    assert.equal(classifyPutResponse({ status: 429, ok: false, headers: {}, bodyText: '' }, grant, new Date('2026-08-08T00:00:30.000Z')), 'retryable');
  });

  test('ledger facts are committed before the grant is issued and signing failure recovers on one identity', async () => {
    const order: string[] = [];
    const seenKeys: string[] = [];
    let presignCalls = 0;
    const params = nextScenario();
    const records: GenerationLedgerRecord[] = [];
    const ledger = {
      async commit(record: Omit<GenerationLedgerRecord, 'committedAtIso'>) {
        order.push('ledger.commit');
        const full: GenerationLedgerRecord = { ...record, committedAtIso: '2026-08-08T00:00:00.000Z' };
        records.push(full);
        return full;
      },
      findByGeneration(generationId: string) {
        order.push('ledger.findByGeneration');
        return records.find((record) => record.generationId === generationId);
      },
      list: () => records,
      close: async () => {},
    };
    const failingPresigner: Presigner = {
      async presignPut(record, body, options) {
        order.push('presigner.presignPut');
        presignCalls += 1;
        if (presignCalls === 1) throw new Error('SigningError: network unavailable');
        seenKeys.push(record.key);
        return grantFromRecord(record, body, options);
      },
    };
    const transport = conditionalTransport(false);
    const deps = depsWith({ ledger, presigner: failingPresigner, transport });
    const first = await runUploadScenario(deps, params);
    assert.equal(first.class, 'signing_failure');
    assert.equal(first.putRequestCount, 0);
    assert.equal(transport.requests.length, 0);
    assert.deepEqual(order, ['ledger.commit', 'presigner.presignPut']);
    assert.equal(records.length, 1);

    const recovered = await recoverUploadScenario(depsWith({ ledger, presigner: failingPresigner, transport }), {
      ...params, declaredSize: params.body.byteLength, declaredSha256: undefined,
    });
    assert.equal(recovered.class, 'verified');
    assert.equal(recovered.generationId, params.generationId);
    assert.equal(recovered.keyFingerprint, records[0]!.fingerprint);
    assert.deepEqual(seenKeys, [params.key]);
    assert.equal(records.length, 1);
    assert.deepEqual(order, ['ledger.commit', 'presigner.presignPut', 'ledger.findByGeneration', 'presigner.presignPut', 'ledger.findByGeneration']);
  });

  test('uploads zero and edge byte bodies with a single conditional PUT', async () => {
    for (const body of [Buffer.alloc(0), Buffer.from([0x00]), Buffer.from('x'.repeat(1024))]) {
      const store = fakeStore({
        head: () => ({ class: 'ok', size: body.byteLength, etag: '"edge"', metadata: storedMetadata(), status: 200 }),
        readBounded: () => ({ class: 'ok', bytes: body }),
      });
      const transport = conditionalTransport(false);
      const out = await runUploadScenario(depsWith({ store, transport }), nextScenario({ body }));
      assert.equal(out.class, 'verified', `body length ${body.byteLength}`);
      assert.equal(out.putRequestCount, 1);
      assert.deepEqual(out.putClasses, ['ok']);
      assert.equal(out.completeClass, 'verified');
      assert.equal(out.observedSize, body.byteLength);
      assert.equal(transport.requests.length, 1);
      assert.ok(transport.requests[0]!.headers.some(([name]) => name.toLowerCase() === 'if-none-match'));
    }
  });

  test('rejects bodies above the single-PUT hard ceiling before any grant', async () => {
    const big = Buffer.alloc(SINGLE_PUT_HARD_CEILING_BYTES + 1);
    const transport = conditionalTransport(false);
    await assert.rejects(
      runUploadScenario(depsWith({ transport }), nextScenario({ body: big })),
      /r2_single_put_ceiling_exceeded/,
    );
    assert.equal(transport.requests.length, 0);
  });
  test('duplicate same-URL PUT is rejected and final bytes equal the first writer', async () => {
    const transport = conditionalTransport(false);
    const out = await runDuplicateUploads(depsWith({ transport }), nextScenario());
    assert.deepEqual(out.putClasses, ['ok', 'precondition']);
    assert.equal(out.putRequestCount, 2);
    assert.equal(out.finalAttestation, 'verified');
    assert.equal(out.observedSize, (await import('../../support/phase4a-i02-test-helpers.js')).DEFAULT_BODY.byteLength);
    assert.equal(transport.requests.length, 2);
    for (const request of transport.requests) {
      assert.equal(request.headers.filter(([name]) => name.toLowerCase() === 'if-none-match').length, 1);
    }
  });

  test('concurrent same-URL writers have exactly one winner and one precondition loser', async () => {
    const transport = conditionalTransport(false);
    const out = await runConcurrentUploads(depsWith({ transport }), nextScenario(), 2);
    assert.equal(out.winners, 1);
    assert.equal(out.preconditionLosers, 1);
    assert.equal(out.putRequestCount, 2);
    assert.equal(out.finalAttestation, 'verified');
    assert.equal(out.observedSize, (await import('../../support/phase4a-i02-test-helpers.js')).DEFAULT_BODY.byteLength);
    assert.equal(transport.peakInFlight(), 2, 'both writers must be in flight simultaneously via the barrier');
    for (const request of transport.requests) {
      assert.equal(request.headers.filter(([name]) => name.toLowerCase() === 'if-none-match').length, 1);
    }
  });

  test('no code path captures 412 and then issues an unconditional or second PUT', async () => {
    const requests: RawPutRequest[] = [];
    const transport: HttpTransport = {
      async request(method, request) {
        requests.push(request);
        return { status: 412, ok: false, headers: {}, bodyText: 'precondition' };
      },
    };
    const out = await runUploadScenario(depsWith({ transport }), nextScenario());
    assert.deepEqual(out.putClasses, ['precondition']);
    assert.equal(out.putRequestCount, 1);
    assert.equal(requests.length, 1);
    assert.equal(out.completeClass, 'verified');
    assert.equal(out.class, 'verified');
    assert.equal(requests[0]!.headers.filter(([name]) => name.toLowerCase() === 'if-none-match').length, 1);
  });

  test('declared size, checksum, and metadata mismatches are rejected at explicit complete', async () => {
    const sizeMismatch = await runUploadScenario(depsWith(), nextScenario({ declaredSize: 999 }));
    assert.equal(sizeMismatch.completeClass, 'size_mismatch');
    assert.equal(sizeMismatch.class, 'size_mismatch');

    const checksumMismatch = await runUploadScenario(
      depsWith(), nextScenario({ declaredSha256: '0'.repeat(64) }),
    );
    assert.equal(checksumMismatch.completeClass, 'checksum_mismatch');
    assert.equal(checksumMismatch.class, 'checksum_mismatch');

    const metadataMismatch = await runUploadScenario(
      depsWith(), nextScenario({ metadata: { probe: 'phase4a-i02', nonce: 'tampered-nonce' } }),
    );
    assert.equal(metadataMismatch.completeClass, 'metadata_mismatch');
    assert.equal(metadataMismatch.class, 'metadata_mismatch');
  });

  test('explicit complete binds only opaque intent/generation and resolves the key from the ledger', async () => {
    const params = nextScenario();
    const store = fakeStore();
    const ledger = memoryLedger();
    await ledger.commit(newGenerationRecord(params, () => new Date('2026-08-08T00:00:00.000Z')));
    const binding: CompleteBinding = {
      intentId: params.intentId,
      generationId: params.generationId,
      declaredSize: params.body.byteLength,
      declaredSha256: createHash('sha256').update(params.body).digest('hex'),
      expectedMetadata: params.metadata,
    };
    const verified = await completeExactGeneration({ ledger, store }, binding);
    assert.equal(verified.class, 'verified');
    assert.deepEqual(store.seenKeys, [params.key], 'the key must come from the ledger, never the caller');

    const unknown = await completeExactGeneration({ ledger, store }, { ...binding, generationId: uuidFor(990) });
    assert.equal(unknown.class, 'not_found');
    const wrongIntent = await completeExactGeneration({ ledger, store }, { ...binding, intentId: uuidFor(991) });
    assert.equal(wrongIntent.class, 'not_found');

    await assert.rejects(
      completeExactGeneration({ ledger, store }, { ...binding, key: 'attacker-supplied-key' } as CompleteBinding),
      /complete_key_input_rejected/,
    );
    await assert.rejects(
      completeExactGeneration({ ledger, store }, { ...binding, bucket: 'other-bucket' } as CompleteBinding),
      /complete_key_input_rejected/,
    );
  });

  test('provider success with a lost client response recovers via explicit complete on the same generation', async () => {
    const requests: RawPutRequest[] = [];
    const transport: HttpTransport = {
      async request(method, request) {
        requests.push(request);
        throw new (await import('../../../scripts/evidence/phase4a-i02-upload-probe.js')).PutTransportError('unknown', 'response lost after server commit', true);
      },
    };
    const out = await runUploadScenario(depsWith({ transport }), nextScenario());
    assert.equal(out.class, 'verified');
    assert.equal(out.putRequestCount, 1);
    assert.deepEqual(out.putClasses, ['unknown']);
    assert.equal(out.recovery, 'same_generation_complete');
    assert.equal(out.completeClass, 'verified');
    assert.equal(requests.length, 1);
  });

  test('a transport timeout first recovers via complete/HEAD and only then retries the same conditional URL', async () => {
    let calls = 0;
    const requests: RawPutRequest[] = [];
    const transport: HttpTransport = {
      async request(method, request) {
        requests.push(request);
        calls += 1;
        if (calls === 1) throw new (await import('../../../scripts/evidence/phase4a-i02-upload-probe.js')).PutTransportError('retryable', 'timeout');
        return { status: 200, ok: true, headers: {}, bodyText: '' };
      },
    };
    const params = nextScenario();
    const body = params.body;
    let headCalls = 0;
    const store = fakeStore({
      head: () => {
        headCalls += 1;
        if (headCalls === 1) return { class: 'not_found', status: 404 };
        return { class: 'ok', size: body.byteLength, etag: '"e"', metadata: storedMetadata(), status: 200 };
      },
      readBounded: () => ({ class: 'ok', bytes: body }),
    });
    const out = await runUploadScenario(depsWith({ transport, store }), params);
    assert.equal(out.class, 'verified');
    assert.equal(out.putRequestCount, 2);
    assert.deepEqual(out.putClasses, ['retryable', 'ok']);
    assert.equal(out.recovery, 'same_url_retry_then_complete');
    assert.equal(out.completeClass, 'verified');
    for (const request of requests) {
      assert.equal(request.headers.filter(([name]) => name.toLowerCase() === 'if-none-match').length, 1);
    }
  });
});
