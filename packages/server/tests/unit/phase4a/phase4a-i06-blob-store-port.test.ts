/**
 * P4A-I06 pure port/contract suite.
 *
 * Pins the `BlobStorePort` contract without any emulator/map/command mock:
 * handle validation, grant shape (exact key, If-None-Match *, no
 * multipart/copy/overwrite params, TTL bounds), quoted-ETag + metadata
 * canonicalization, the stable error-classification matrix, the compile-level
 * "no AWS SDK types across the boundary" guard, DELETE never claiming If-Match,
 * and absence being HEAD-not-found — never a DELETE 2xx.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, test } from 'vitest';
import {
  BlobStoreError,
  BlobStorePortError,
  BlobStoreReadOverflowError,
  canonicalizeEtag,
  canonicalizeMetadata,
  classifyBlobStoreFailure,
  createR2GenerationStore,
} from '../../../src/infrastructure/object-storage/index.js';
import type { BlobStorePort, GenerationHandle } from '../../../src/infrastructure/object-storage/index.js';
import { startFaultServer } from '../../support/phase4a-i06-fault-server.js';

const ENDPOINT = 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com';
const BUCKET = 'known-quarantine-production';
const LIVE_PREFIX = 'capability-probes/deployment-01/live/';
const PROBE_PREFIX = 'capability-probes/deployment-01/probe/';

function options(overrides: Partial<import('../../../src/infrastructure/object-storage/index.js').R2GenerationStoreOptions> = {}) {
  return {
    endpoint: ENDPOINT,
    region: 'auto',
    bucket: BUCKET,
    livePrefix: LIVE_PREFIX,
    probePrefix: PROBE_PREFIX,
    rwCredential: { accessKeyId: 'write-access-key-marker', secretAccessKey: 'write-secret-access-key-marker' },
    roCredential: { accessKeyId: 'read-access-key-marker', secretAccessKey: 'read-secret-access-key-marker' },
    grantTtlSeconds: 60,
    singlePutMaxBytes: 5 * 1024 * 1024,
    clock: () => new Date('2026-08-08T00:00:00.000Z'),
    ...overrides,
  };
}

function handle(key = `${LIVE_PREFIX}018f6f7a-8f2a-7a3d-a123-123456789abc`): GenerationHandle {
  return { generationId: 'generation-0001', key };
}

describe('P4A-I06 BlobStorePort contract', () => {
  test('rejects malformed generation handles and keys outside the configured namespaces', async () => {
    const store = createR2GenerationStore(options());
    try {
      await assert.rejects(
        store.headExact({ generationId: '', key: `${LIVE_PREFIX}abc` }),
        (error: unknown) => error instanceof BlobStorePortError && error.code === 'invalid_generation_handle',
      );
      await assert.rejects(
        store.headExact({ generationId: 'g', key: '' }),
        (error: unknown) => error instanceof BlobStorePortError && error.code === 'invalid_generation_handle',
      );
      await assert.rejects(
        store.headExact({ generationId: 'g', key: 'attachments/live/other-key' }),
        (error: unknown) => error instanceof BlobStorePortError && error.code === 'key_outside_configured_namespace',
      );
      await assert.rejects(
        store.issueCreateOnlyGrant(handle(), { ttlSeconds: 0, contentLength: 1 }),
        (error: unknown) => error instanceof BlobStorePortError && error.code === 'grant_ttl_out_of_range',
      );
    } finally {
      await store.close();
    }
  });

  test('a closed store fails closed with store_closed and close is idempotent', async () => {
    const store = createR2GenerationStore(options());
    await store.close();
    await store.close();
    await assert.rejects(
      store.headExact(handle()),
      (error: unknown) => error instanceof BlobStorePortError && error.code === 'store_closed',
    );
  });

  test('issueCreateOnlyGrant emits an exact-key single-PUT URL with If-None-Match and no multipart/copy/overwrite params', async () => {
    const store = createR2GenerationStore(options());
    try {
      const grant = await store.issueCreateOnlyGrant(handle(), {
        ttlSeconds: 60,
        contentType: 'application/octet-stream',
        contentLength: 1024,
        metadata: { probe: 'phase4a-i06', nonce: 'opaque-nonce-marker' },
      });
      assert.equal(grant.method, 'PUT');
      assert.equal(grant.ifNoneMatch, '*');
      assert.equal(grant.contentLength, 1024);
      assert.equal(grant.ttlSeconds, 60);
      assert.equal(Date.parse(grant.expiresAtIso) - Date.parse(grant.signedAtIso), 60_000);
      const url = new URL(grant.url);
      assert.equal(url.pathname, `/${BUCKET}/${LIVE_PREFIX}018f6f7a-8f2a-7a3d-a123-123456789abc`);
      assert.equal(url.searchParams.get('x-id'), 'PutObject');
      assert.equal(url.searchParams.get('X-Amz-Expires'), '60');
      const signedHeaders = (url.searchParams.get('X-Amz-SignedHeaders') ?? '').split(';');
      assert.ok(signedHeaders.includes('if-none-match'), 'create-only header must be signed');
      assert.ok(signedHeaders.includes('content-length'), 'byte count must be signed');
      assert.ok(signedHeaders.includes('x-amz-meta-probe'));
      assert.ok(signedHeaders.includes('x-amz-meta-nonce'));
      assert.equal(url.searchParams.has('uploads'), false);
      assert.equal(url.searchParams.has('uploadId'), false);
      assert.equal(url.searchParams.has('partNumber'), false);
      assert.equal(url.searchParams.has('x-amz-copy-source'), false);
      assert.equal(url.searchParams.has('x-amz-metadata-directive'), false);
      assert.deepEqual(grant.metadataHeaders, {
        'x-amz-meta-probe': 'phase4a-i06',
        'x-amz-meta-nonce': 'opaque-nonce-marker',
      });
      assert.equal(grant.keyFingerprint.length, 64);
      assert.equal(grant.keyFingerprint.includes(handle().key), false);
    } finally {
      await store.close();
    }
  });

  test('TTL and content-length budgets fail closed with stable port errors', async () => {
    const store = createR2GenerationStore(options({ grantTtlSeconds: 60, singlePutMaxBytes: 100 }));
    try {
      for (const ttlSeconds of [0, -1, 61, 301, 1.5]) {
        await assert.rejects(
          store.issueCreateOnlyGrant(handle(), { ttlSeconds, contentLength: 10 }),
          (error: unknown) => error instanceof BlobStorePortError && error.code === 'grant_ttl_out_of_range',
          `ttl ${ttlSeconds}`,
        );
      }
      await assert.rejects(
        store.issueCreateOnlyGrant(handle(), { ttlSeconds: 60, contentLength: 101 }),
        (error: unknown) => error instanceof BlobStorePortError && error.code === 'grant_content_length_exceeds_ceiling',
      );
      await assert.rejects(
        store.issueCreateOnlyGrant(handle(), { ttlSeconds: 60, contentLength: -1 }),
        (error: unknown) => error instanceof BlobStorePortError && error.code === 'grant_content_length_invalid',
      );
      await assert.rejects(
        store.readBounded(handle(), { expectedEtag: '"e"', byteCeiling: -1, signal: AbortSignal.timeout(1000) }),
        (error: unknown) => error instanceof BlobStorePortError && error.code === 'read_byte_ceiling_invalid',
      );
      await assert.rejects(
        store.readBounded(handle(), { expectedEtag: '', byteCeiling: 10, signal: AbortSignal.timeout(1000) }),
        (error: unknown) => error instanceof BlobStorePortError && error.code === 'expected_etag_required',
      );
    } finally {
      await store.close();
    }
  });

  test('quoted ETag and metadata canonicalization are deterministic', () => {
    assert.equal(canonicalizeEtag('abc123'), '"abc123"');
    assert.equal(canonicalizeEtag('"abc123"'), '"abc123"');
    assert.equal(canonicalizeEtag('W/"abc123"'), 'W/"abc123"');
    assert.throws(() => canonicalizeEtag('   '), (error: unknown) => error instanceof BlobStorePortError && error.code === 'etag_empty');
    assert.deepEqual(canonicalizeMetadata({ 'X-Amz-Meta-Probe': 'x', NONCE: 'y', 'x-amz-meta-ROUND': '0' }), {
      probe: 'x',
      nonce: 'y',
      round: '0',
    });
  });

  test('stable error-classification matrix prefers HTTP status, name, and metadata code', () => {
    const statusSamples: Array<[number, string]> = [
      [412, 'precondition'],
      [404, 'not_found'],
      [401, 'denied'],
      [403, 'denied'],
      [408, 'retryable'],
      [429, 'retryable'],
      [500, 'retryable'],
      [502, 'retryable'],
      [503, 'retryable'],
      [504, 'retryable'],
      [300, 'unknown'],
      [400, 'unknown'],
      [200, 'unknown'],
    ];
    for (const [status, expected] of statusSamples) {
      assert.equal(classifyBlobStoreFailure({ $metadata: { httpStatusCode: status } }).class, expected, `status ${status}`);
    }
    const nameSamples: Array<[unknown, string]> = [
      [{ name: 'PreconditionFailed' }, 'precondition'],
      [{ name: 'NotFound' }, 'not_found'],
      [{ name: 'NoSuchKey' }, 'not_found'],
      [{ name: 'AccessDenied' }, 'denied'],
      [{ name: 'SignatureDoesNotMatch' }, 'denied'],
      [{ name: 'InvalidAccessKeyId' }, 'denied'],
      [{ name: 'ServiceUnavailable' }, 'retryable'],
      [{ name: 'SlowDown' }, 'retryable'],
      [{ name: 'TimeoutError', code: 'ETIMEDOUT' }, 'retryable'],
      [{ name: 'Error', errno: 'ECONNRESET' }, 'retryable'],
      [{ name: 'Error', code: 'ECONNRESET' }, 'retryable'],
      [{ code: 'ERR_STREAM_PREMATURE_CLOSE' }, 'retryable'],
      [{ name: 'Error', errno: 'EPIPE' }, 'retryable'],
      [{ name: 'AbortError' }, 'aborted'],
      [{ name: 'RequestAbortedException' }, 'aborted'],
      [{ code: 'RequestAborted' }, 'aborted'],
      [{ name: 'UnknownError' }, 'unknown'],
      ['not-an-error-object', 'unknown'], // unknown non-error input
    ];
    for (const [sample, expected] of nameSamples) {
      assert.equal(classifyBlobStoreFailure(sample).class, expected);
    }
    // English SDK message text is never matched (plan §5.6).
    assert.equal(classifyBlobStoreFailure(new Error('The request signature we calculated does not match')).class, 'unknown');
  });

  test('no AWS SDK type crosses the object-storage boundary (source + type-level guards)', async () => {
    const portSource = await readFile(resolve('src/infrastructure/object-storage/blob-store-port.ts'), 'utf8');
    const facadeSource = await readFile(resolve('src/infrastructure/object-storage/index.ts'), 'utf8');
    assert.equal(portSource.includes('@aws-sdk'), false, 'blob-store-port.ts must not mention the AWS SDK');
    assert.equal(facadeSource.includes('@aws-sdk'), false, 'index.ts must not re-export AWS SDK types');
    // Type-level guard: if the facade ever re-exports an SDK symbol, the
    // @ts-expect-error below becomes an unused directive and typecheck fails.
    // @ts-expect-error — the public facade must never export AWS SDK types
    const leaked: typeof import('../../../src/infrastructure/object-storage/index.js').S3Client = undefined as never;
    void leaked;
  });

  test('DELETE never claims If-Match, and absence is HEAD-not-found, never a DELETE 2xx', async () => {
    const fault = await startFaultServer((request, index) => {
      if (request.method === 'DELETE') return { status: 204, headers: {}, body: '' };
      if (request.method === 'HEAD') return { status: 404, headers: {}, body: '' };
      return { status: 403, headers: {}, body: 'unexpected' };
    });
    try {
      const store = createR2GenerationStore(options({ endpoint: fault.url }));
      const target = handle();
      try {
        const deleted = await store.deleteExact(target);
        assert.equal(deleted.outcome, 'deleted');
        const deleteRequest = fault.requests.find((request) => request.method === 'DELETE');
        assert.ok(deleteRequest, 'DELETE must have reached the transport');
        assert.equal(deleteRequest.path.includes(`/${BUCKET}/${target.key}`), true);
        assert.equal('if-match' in deleteRequest.headers, false, 'DELETE must never send If-Match');
        assert.equal('if-none-match' in deleteRequest.headers, false);

        const absent = await store.confirmAbsent(target);
        assert.equal(absent.absent, true, 'absence must come from exact-key HEAD not_found');
        const headRequest = fault.requests.find((request) => request.method === 'HEAD');
        assert.ok(headRequest, 'absence confirmation must issue an exact-key HEAD');
        assert.equal(headRequest.path.includes(`/${BUCKET}/${target.key}`), true);

        const duplicate = await store.deleteExact(target);
        assert.equal(duplicate.outcome, 'deleted');
      } finally {
        await store.close();
      }
    } finally {
      await fault.close();
    }
  });

  test('a malformed provider response maps to contract_drift, not to a missing/precondition class', async () => {
    const fault = await startFaultServer(() => ({
      status: 200,
      headers: { 'content-length': '12' }, // no etag -> malformed 2xx
      body: '',
    }));
    try {
      const store = createR2GenerationStore(options({ endpoint: fault.url }));
      try {
        await assert.rejects(
          store.headExact(handle()),
          (error: unknown) => error instanceof BlobStoreError && error.class === 'contract_drift'
            && error.code === 'head_response_malformed',
        );
        assert.ok(fault.requests.length >= 1, 'the malformed HEAD must have reached the transport');
      } finally {
        await store.close();
      }
    } finally {
      await fault.close();
    }
  });

  test('readBounded requires a bound ETag and maps a precondition to the precondition class', async () => {
    const fault = await startFaultServer((request) => {
      if (request.method === 'GET') {
        if (request.headers['if-match'] === '"wrong-etag"') {
          return { status: 412, headers: {}, body: '<Error><Code>PreconditionFailed</Code></Error>' };
        }
        return {
          status: 200,
          headers: { 'content-length': '4', etag: '"real-etag"', 'x-amz-meta-probe': 'phase4a-i06' },
          body: 'data',
        };
      }
      return { status: 403, headers: {}, body: 'unexpected' };
    });
    try {
      const store = createR2GenerationStore(options({ endpoint: fault.url }));
      try {
        await assert.rejects(
          store.readBounded(handle(), { expectedEtag: '"wrong-etag"', byteCeiling: 100, signal: AbortSignal.timeout(5000) }),
          (error: unknown) => error instanceof BlobStoreError && error.class === 'precondition' && error.code === 'etag_mismatch',
        );
        assert.ok(fault.requests.some((request) => request.method === 'GET' && request.headers['if-match'] === '"wrong-etag"'),
          'the conditional GET with the wrong ETag must reach the transport');
      } finally {
        await store.close();
      }
    } finally {
      await fault.close();
    }
  });

  test('probeCapability uses a non-destructive exact-key HEAD and classifies provider failures', async () => {
    const fault = await startFaultServer((request) => {
      if (request.method === 'HEAD') return { status: 404, headers: {}, body: '' };
      return { status: 403, headers: {}, body: 'unexpected' };
    });
    try {
      const store = createR2GenerationStore(options({ endpoint: fault.url }));
      try {
        const outcome = await store.probeCapability();
        assert.equal(outcome.ok, true);
        assert.equal(outcome.detail, 'probe_key_absent');
        const headRequest = fault.requests[0];
        assert.ok(headRequest);
        assert.equal(headRequest.method, 'HEAD');
        assert.equal(headRequest.path.includes(`/${BUCKET}/${PROBE_PREFIX}startup-capability`), true);
      } finally {
        await store.close();
      }
    } finally {
      await fault.close();
    }
  });

  test('BlobStoreReadOverflowError is a distinct size-bound signal, never a provider class', () => {
    const overflow = new BlobStoreReadOverflowError(42);
    assert.equal(overflow.code, 'read_exceeds_ceiling');
    assert.equal(overflow.byteCeiling, 42);
    assert.equal(overflow instanceof BlobStoreError, false);
    assert.equal(overflow instanceof Error, true);
  });
});
