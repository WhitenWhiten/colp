/**
 * P4A-I06 adapter contract with a CONTROLLED FAULT TRANSPORT.
 *
 * The transport is a real local HTTP server driven through the production
 * `@aws-sdk` middleware + `NodeHttpHandler`: the S3 client points its
 * `endpoint` at the server and every request is a genuine HTTP exchange with
 * scripted raw responses. It is not an emulator, not a Map, and not a command
 * mock. Every fault test first asserts the request actually reached the
 * transport, then asserts the stable classification.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  BlobStoreError,
  BlobStoreReadOverflowError,
  boundedBodyStream,
  createR2GenerationStore,
  identityFromObjectResponse,
  normalizeBodyReadFailure,
} from '../../../src/infrastructure/object-storage/index.js';
import type {
  BlobByteStream,
  BlobStorePort,
  GenerationHandle,
} from '../../../src/infrastructure/object-storage/index.js';
import {
  startFaultServer,
  s3ErrorBody,
} from '../../support/phase4a-i06-fault-server.js';
import type { FaultScript, FaultServer, RecordedRequest } from '../../support/phase4a-i06-fault-server.js';

const BUCKET = 'known-quarantine-production';
const LIVE_PREFIX = 'capability-probes/deployment-01/live/';
const KEY = `${LIVE_PREFIX}018f6f7a-8f2a-7a3d-a123-123456789abc`;

function handle(): GenerationHandle {
  return { generationId: 'generation-0001', key: KEY };
}

function storeOptions(endpoint: string) {
  return {
    endpoint,
    region: 'auto',
    bucket: BUCKET,
    livePrefix: LIVE_PREFIX,
    probePrefix: 'capability-probes/deployment-01/probe/',
    rwCredential: { accessKeyId: 'write-access-key-marker', secretAccessKey: 'write-secret-access-key-marker' },
    roCredential: { accessKeyId: 'read-access-key-marker', secretAccessKey: 'read-secret-access-key-marker' },
    grantTtlSeconds: 60,
    singlePutMaxBytes: 5 * 1024 * 1024,
    clock: () => new Date('2026-08-08T00:00:00.000Z'),
  };
}

async function withFault(script: FaultScript, run: (store: BlobStorePort, fault: FaultServer) => Promise<void>): Promise<void> {
  const fault = await startFaultServer(script);
  const store = createR2GenerationStore(storeOptions(fault.url));
  try {
    await run(store, fault);
  } finally {
    await store.close();
    await fault.close();
  }
}

function requestsByMethod(fault: FaultServer, method: string): RecordedRequest[] {
  return fault.requests.filter((request) => request.method === method);
}

async function expectStoreClass(
  operation: Promise<unknown>,
  expectedClass: string,
  expectedCode?: string,
): Promise<void> {
  await assert.rejects(
    operation,
    (error: unknown) => error instanceof BlobStoreError && error.class === expectedClass
      && (expectedCode === undefined || error.code === expectedCode),
  );
}

const HEAD_IDENTITY_HEADERS = (size: number) => ({
  'content-length': String(size),
  etag: 'abc123', // deliberately unquoted to pin quoted-ETag canonicalization
  'x-amz-meta-probe': 'phase4a-i06',
  'x-amz-meta-nonce': 'opaque-nonce-marker',
  'last-modified': 'Sat, 08 Aug 2026 00:00:00 GMT',
});

/** Same identity headers but WITHOUT any `x-amz-meta-*` header. */
const HEAD_IDENTITY_HEADERS_WITHOUT_METADATA = (size: number) => ({
  'content-length': String(size),
  etag: 'abc123',
  'last-modified': 'Sat, 08 Aug 2026 00:00:00 GMT',
});

describe('P4A-I06 R2 adapter controlled fault transport', () => {
  test('headExact: not-found is found:false and every provider failure is stable-classified', async () => {
    await withFault(
      (request) => (request.method === 'HEAD'
        ? { status: 404, headers: {}, body: '' }
        : { status: 403, headers: {}, body: s3ErrorBody('AccessDenied') }),
      async (store, fault) => {
        const outcome = await store.headExact(handle());
        assert.equal(outcome.found, false);
        assert.ok(requestsByMethod(fault, 'HEAD').length === 1, 'the HEAD must reach the transport');
      },
    );

    await withFault(
      (request) => (request.method === 'HEAD'
        ? { status: 403, headers: {}, body: s3ErrorBody('AccessDenied') }
        : { status: 500, headers: {}, body: s3ErrorBody('InternalError') }),
      async (store, fault) => {
        await expectStoreClass(store.headExact(handle()), 'denied', 'access_denied');
        assert.ok(requestsByMethod(fault, 'HEAD').length === 1);
      },
    );

    await withFault(
      (request) => (request.method === 'HEAD'
        ? { status: 429, headers: {}, body: s3ErrorBody('SlowDown') }
        : { status: 500, headers: {}, body: s3ErrorBody('InternalError') }),
      async (store, fault) => {
        await expectStoreClass(store.headExact(handle()), 'retryable');
        assert.ok(requestsByMethod(fault, 'HEAD').length === 1);
      },
    );

    await withFault(
      (request) => (request.method === 'HEAD'
        ? { status: 500, headers: {}, body: s3ErrorBody('InternalError') }
        : { status: 500, headers: {}, body: s3ErrorBody('InternalError') }),
      async (store, fault) => {
        await expectStoreClass(store.headExact(handle()), 'retryable');
        assert.ok(requestsByMethod(fault, 'HEAD').length === 1);
      },
    );

    await withFault(
      (request) => (request.method === 'HEAD'
        ? { status: 400, headers: {}, body: s3ErrorBody('InvalidRequest') }
        : { status: 500, headers: {}, body: s3ErrorBody('InternalError') }),
      async (store, fault) => {
        await expectStoreClass(store.headExact(handle()), 'unknown');
        assert.ok(requestsByMethod(fault, 'HEAD').length === 1);
      },
    );
  });

  test('headExact: 200 identity canonicalizes the quoted ETag and metadata', async () => {
    await withFault(
      (request) => (request.method === 'HEAD'
        ? { status: 200, headers: HEAD_IDENTITY_HEADERS(12), body: '' }
        : { status: 403, headers: {}, body: s3ErrorBody('AccessDenied') }),
      async (store, fault) => {
        const outcome = await store.headExact(handle());
        assert.equal(outcome.found, true);
        if (outcome.found) {
          assert.equal(outcome.identity.size, 12);
          assert.equal(outcome.identity.etag, '"abc123"');
          assert.deepEqual(outcome.identity.metadata, { probe: 'phase4a-i06', nonce: 'opaque-nonce-marker' });
          assert.equal(outcome.identity.lastModifiedIso, '2026-08-08T00:00:00.000Z');
        }
        assert.ok(requestsByMethod(fault, 'HEAD').length === 1);
      },
    );
  });

  test('headExact: provider-omitted metadata is the locked-SDK empty object, never malformed', async () => {
    // The locked contract (@aws-sdk/client-s3 3.1095.0) declares
    // HeadObjectOutput.Metadata optional, and its deserializer materializes
    // Metadata: {} whenever the provider omits every x-amz-meta-* header.
    // HEAD must normalize that empty shape exactly like GET, not declare the
    // response malformed.
    await withFault(
      (request) => (request.method === 'HEAD'
        ? { status: 200, headers: HEAD_IDENTITY_HEADERS_WITHOUT_METADATA(12), body: '' }
        : { status: 403, headers: {}, body: s3ErrorBody('AccessDenied') }),
      async (store, fault) => {
        const outcome = await store.headExact(handle());
        assert.equal(outcome.found, true);
        if (outcome.found) {
          assert.equal(outcome.identity.size, 12);
          assert.equal(outcome.identity.etag, '"abc123"');
          assert.deepEqual(outcome.identity.metadata, {});
          assert.equal(outcome.identity.lastModifiedIso, '2026-08-08T00:00:00.000Z');
        }
        assert.ok(requestsByMethod(fault, 'HEAD').length === 1);
      },
    );
  });

  test('headExact: a conditional HEAD ETag mismatch is the precondition class', async () => {
    await withFault(
      (request) => (request.method === 'HEAD' && request.headers['if-match'] === '"abc123"'
        ? { status: 412, headers: {}, body: s3ErrorBody('PreconditionFailed') }
        : { status: 403, headers: {}, body: s3ErrorBody('AccessDenied') }),
      async (store, fault) => {
        await expectStoreClass(store.headExact(handle(), { expectedEtag: '"abc123"' }), 'precondition', 'etag_mismatch');
        const head = requestsByMethod(fault, 'HEAD')[0];
        assert.ok(head, 'the conditional HEAD must reach the transport');
        assert.equal(head.headers['if-match'], '"abc123"');
      },
    );
  });

  test('headExact: malformed 2xx maps to contract_drift, not to missing/precondition', async () => {
    await withFault(
      (request) => (request.method === 'HEAD'
        ? { status: 200, headers: { 'content-length': '12' }, body: '' }
        : { status: 403, headers: {}, body: s3ErrorBody('AccessDenied') }),
      async (store, fault) => {
        await expectStoreClass(store.headExact(handle()), 'contract_drift', 'head_response_malformed');
        assert.ok(requestsByMethod(fault, 'HEAD').length === 1, 'the malformed HEAD must reach the transport');
      },
    );
  });

  test('readBounded: ETag mismatch before read is precondition; missing is found:false', async () => {
    await withFault(
      (request) => (request.method === 'GET'
        ? { status: 412, headers: {}, body: s3ErrorBody('PreconditionFailed') }
        : { status: 403, headers: {}, body: s3ErrorBody('AccessDenied') }),
      async (store, fault) => {
        await expectStoreClass(
          store.readBounded(handle(), { expectedEtag: '"abc123"', byteCeiling: 100, signal: AbortSignal.timeout(5000) }),
          'precondition',
          'etag_mismatch',
        );
        const get = requestsByMethod(fault, 'GET')[0];
        assert.ok(get, 'the conditional GET must reach the transport');
        assert.equal(get.headers['if-match'], '"abc123"');
      },
    );

    await withFault(
      (request) => (request.method === 'GET'
        ? { status: 404, headers: {}, body: '' }
        : { status: 403, headers: {}, body: s3ErrorBody('AccessDenied') }),
      async (store, fault) => {
        const outcome = await store.readBounded(handle(), { expectedEtag: '"abc123"', byteCeiling: 100, signal: AbortSignal.timeout(5000) });
        assert.equal(outcome.found, false);
        assert.ok(requestsByMethod(fault, 'GET').length === 1);
      },
    );
  });

  test('readBounded: client abort mid-stream is aborted and destroys the upstream body', async () => {
    await withFault(
      (request) => (request.method === 'GET'
        ? {
            status: 200,
            headers: HEAD_IDENTITY_HEADERS(1024),
            chunks: [
              { data: Buffer.alloc(512, 1), delayMs: 20 },
              { data: Buffer.alloc(512, 2), delayMs: 200 },
            ],
          }
        : { status: 403, headers: {}, body: s3ErrorBody('AccessDenied') }),
      async (store, fault) => {
        const controller = new AbortController();
        const read = await store.readBounded(handle(), { expectedEtag: '"abc123"', byteCeiling: 1024, signal: controller.signal });
        assert.equal(read.found, true);
        assert.ok(read.found);
        const iterator = read.stream[Symbol.asyncIterator]();
        const first = await iterator.next();
        assert.equal(first.done, false);
        controller.abort();
        await assert.rejects(
          iterator.next(),
          (error: unknown) => error instanceof BlobStoreError && error.class === 'aborted' && error.code === 'read_aborted',
        );
        assert.ok(requestsByMethod(fault, 'GET').length === 1, 'the GET must reach the transport');
        const closed = await fault.waitForPrematureClose();
        assert.ok(closed >= 1, 'the upstream body must be destroyed on abort');
      },
    );
  });

  test('readBounded: mid-body connection interruption is retryable, never missing', async () => {
    await withFault(
      (request) => (request.method === 'GET'
        ? {
            status: 200,
            headers: HEAD_IDENTITY_HEADERS(1024),
            body: Buffer.alloc(1024, 7),
            destroyAfterBytes: 256,
          }
        : { status: 403, headers: {}, body: s3ErrorBody('AccessDenied') }),
      async (store, fault) => {
        const read = await store.readBounded(handle(), { expectedEtag: '"abc123"', byteCeiling: 2048, signal: AbortSignal.timeout(10_000) });
        assert.equal(read.found, true);
        assert.ok(read.found);
        await assert.rejects(
          (async () => {
            const chunks: Uint8Array[] = [];
            for await (const chunk of read.stream) chunks.push(chunk);
            return chunks;
          })(),
          (error: unknown) => error instanceof BlobStoreError && error.class === 'retryable',
        );
        assert.ok(requestsByMethod(fault, 'GET').length === 1, 'the interrupted GET must reach the transport');
      },
    );
  });

  test('readBounded: byte-ceiling overflow is a distinct size-bound signal that destroys the producer', async () => {
    // A compliant HTTP/1.1 provider can never stream more bytes than its
    // declared Content-Length (see the oversized-object test below), so the
    // in-stream ceiling enforcement is proven directly on the production
    // generator with a synthetic body that over-delivers: it must yield up to
    // the ceiling, then throw the distinct overflow signal and destroy the
    // upstream body.
    const controller = new AbortController();
    const destroyCalls: string[] = [];
    const overDelivering = {
      async *[Symbol.asyncIterator]() {
        yield Buffer.alloc(10, 1);
        yield Buffer.alloc(10, 2);
      },
      destroy(): void {
        destroyCalls.push('destroy');
      },
    } as unknown as BlobByteStream & { destroy?: () => void };
    const stream = boundedBodyStream(overDelivering, 10, controller.signal, 10);
    const chunks: Uint8Array[] = [];
    await assert.rejects(
      (async () => {
        for await (const chunk of stream) chunks.push(chunk);
      })(),
      (error: unknown) => error instanceof BlobStoreReadOverflowError && error.byteCeiling === 10,
    );
    assert.equal(chunks.length, 1, 'exactly the first ceiling-sized chunk must be delivered before overflow');
    assert.deepEqual(destroyCalls, ['destroy'], 'the upstream body must be destroyed on overflow');
  });

  test('readBounded: an object larger than the ceiling is rejected before read and destroys the body', async () => {
    await withFault(
      (request) => (request.method === 'GET'
        ? {
            status: 200,
            headers: HEAD_IDENTITY_HEADERS(2048),
            chunks: [{ data: Buffer.alloc(2048, 3), delayMs: 50 }],
            holdOpen: true, // never end the response so client destruction is observable
          }
        : { status: 403, headers: {}, body: s3ErrorBody('AccessDenied') }),
      async (store, fault) => {
        await assert.rejects(
          store.readBounded(handle(), { expectedEtag: '"abc123"', byteCeiling: 10, signal: AbortSignal.timeout(10_000) }),
          (error: unknown) => error instanceof BlobStoreReadOverflowError && error.byteCeiling === 10,
        );
        assert.ok(requestsByMethod(fault, 'GET').length === 1, 'the oversized GET must reach the transport');
        const closed = await fault.waitForPrematureClose();
        assert.ok(closed >= 1, 'the oversized body must be destroyed before read');
      },
    );
  });

  test('readBounded: malformed GET response maps to contract_drift', async () => {
    await withFault(
      (request) => (request.method === 'GET'
        ? { status: 200, headers: { 'content-length': '4' }, body: 'data' }
        : { status: 403, headers: {}, body: s3ErrorBody('AccessDenied') }),
      async (store, fault) => {
        await expectStoreClass(
          store.readBounded(handle(), { expectedEtag: '"abc123"', byteCeiling: 100, signal: AbortSignal.timeout(5000) }),
          'contract_drift',
          'get_response_malformed',
        );
        assert.ok(requestsByMethod(fault, 'GET').length === 1, 'the malformed GET must reach the transport');
      },
    );
  });

  test('readBounded: provider-omitted metadata normalizes to {} on the GET path too', async () => {
    // Same locked-SDK empty-object shape as the HEAD contract test: a GET
    // response without any x-amz-meta-* header deserializes to Metadata: {}.
    await withFault(
      (request) => (request.method === 'GET'
        ? { status: 200, headers: HEAD_IDENTITY_HEADERS_WITHOUT_METADATA(4), body: 'data' }
        : { status: 403, headers: {}, body: s3ErrorBody('AccessDenied') }),
      async (store, fault) => {
        const read = await store.readBounded(handle(), { expectedEtag: '"abc123"', byteCeiling: 100, signal: AbortSignal.timeout(5000) });
        assert.equal(read.found, true);
        assert.ok(read.found);
        assert.equal(read.identity.size, 4);
        assert.deepEqual(read.identity.metadata, {});
        for await (const _chunk of read.stream) {
          // drain the stream so the exchange completes cleanly
        }
        assert.ok(requestsByMethod(fault, 'GET').length === 1);
      },
    );
  });

  test('deleteExact: 2xx deleted, 404 absent, unclassified status is unknown — never missing', async () => {
    await withFault(
      (request) => (request.method === 'DELETE' ? { status: 204, headers: {}, body: '' } : { status: 403, headers: {}, body: '' }),
      async (store, fault) => {
        const outcome = await store.deleteExact(handle());
        assert.equal(outcome.outcome, 'deleted');
        assert.ok(requestsByMethod(fault, 'DELETE').length === 1);
      },
    );

    await withFault(
      (request) => (request.method === 'DELETE' ? { status: 404, headers: {}, body: '' } : { status: 403, headers: {}, body: '' }),
      async (store, fault) => {
        const outcome = await store.deleteExact(handle());
        assert.equal(outcome.outcome, 'absent');
        assert.ok(requestsByMethod(fault, 'DELETE').length === 1);
      },
    );

    await withFault(
      (request) => (request.method === 'DELETE' ? { status: 400, headers: {}, body: s3ErrorBody('InvalidRequest') } : { status: 403, headers: {}, body: '' }),
      async (store, fault) => {
        const outcome = await store.deleteExact(handle());
        assert.equal(outcome.outcome, 'unknown');
        assert.notEqual(outcome.outcome, 'absent', 'true unknown must not be misclassified as missing');
        assert.notEqual(outcome.outcome, 'deleted');
        assert.ok(requestsByMethod(fault, 'DELETE').length === 1);
      },
    );
  });

  test('deleteExact: denied and retryable provider failures are thrown with stable classes', async () => {
    await withFault(
      (request) => (request.method === 'DELETE' ? { status: 403, headers: {}, body: s3ErrorBody('AccessDenied') } : { status: 403, headers: {}, body: '' }),
      async (store, fault) => {
        await expectStoreClass(store.deleteExact(handle()), 'denied', 'access_denied');
        assert.ok(requestsByMethod(fault, 'DELETE').length === 1);
      },
    );

    await withFault(
      (request) => (request.method === 'DELETE' ? { status: 500, headers: {}, body: s3ErrorBody('InternalError') } : { status: 403, headers: {}, body: '' }),
      async (store, fault) => {
        await expectStoreClass(store.deleteExact(handle()), 'retryable');
        assert.ok(requestsByMethod(fault, 'DELETE').length === 1);
      },
    );
  });

  test('deleteExact: a 412 is contract_drift (no delete precondition is ever claimed)', async () => {
    await withFault(
      (request) => (request.method === 'DELETE'
        ? { status: 412, headers: {}, body: s3ErrorBody('PreconditionFailed') }
        : { status: 403, headers: {}, body: '' }),
      async (store, fault) => {
        await expectStoreClass(store.deleteExact(handle()), 'contract_drift', 'delete_precondition_not_expected');
        const deleteRequest = requestsByMethod(fault, 'DELETE')[0];
        assert.ok(deleteRequest, 'the DELETE must reach the transport');
        assert.equal('if-match' in deleteRequest.headers, false, 'DELETE must never send If-Match');
      },
    );
  });

  test('deleteExact: a lost response is retryable or unknown, never absent/deleted', async () => {
    await withFault(
      (request) => (request.method === 'DELETE' ? { status: 204, headers: {}, body: '', dropConnection: true } : { status: 403, headers: {}, body: '' }),
      async (store, fault) => {
        let observed: string | undefined;
        try {
          const outcome = await store.deleteExact(handle());
          observed = `outcome:${outcome.outcome}`;
        } catch (error) {
          if (error instanceof BlobStoreError && error.class === 'retryable') {
            observed = 'error:retryable';
          } else {
            throw error;
          }
        }
        assert.ok(observed === 'outcome:unknown' || observed === 'error:retryable',
          `connection loss must be retryable/unknown, got ${observed}`);
        assert.ok(requestsByMethod(fault, 'DELETE').length === 1, 'the DELETE must reach the transport');
      },
    );
  });

  test('probeCapability: denied and retryable failures are stable-classified', async () => {
    await withFault(
      (request) => (request.method === 'HEAD' ? { status: 403, headers: {}, body: s3ErrorBody('AccessDenied') } : { status: 403, headers: {}, body: '' }),
      async (store, fault) => {
        await expectStoreClass(store.probeCapability(), 'denied', 'access_denied');
        assert.ok(requestsByMethod(fault, 'HEAD').length === 1);
      },
    );
    await withFault(
      (request) => (request.method === 'HEAD' ? { status: 503, headers: {}, body: s3ErrorBody('ServiceUnavailable') } : { status: 403, headers: {}, body: '' }),
      async (store, fault) => {
        await expectStoreClass(store.probeCapability(), 'retryable');
        assert.ok(requestsByMethod(fault, 'HEAD').length === 1);
      },
    );
  });

  test('multi-chunk body upload/read flows through the production port with an independent byte check', async () => {
    const chunkCount = 3;
    const chunks = Array.from({ length: chunkCount }, (_, index) => {
      const marker = Buffer.from(`i06-fault-chunk-${index}|`);
      return Buffer.concat([marker, Buffer.alloc(2048 - marker.length, 0x30 + index)]);
    });
    const expected = Buffer.concat(chunks);
    let uploaded: Buffer | undefined;
    let deleted = false;

    await withFault(
      (request) => {
        if (request.method === 'PUT') {
          uploaded = request.body;
          return { status: 200, headers: { etag: '"fault-etag-1"' }, body: '' };
        }
        if (request.method === 'HEAD') {
          return deleted
            ? { status: 404, headers: {}, body: '' }
            : { status: 200, headers: { ...HEAD_IDENTITY_HEADERS(expected.length), etag: 'fault-etag-1' }, body: '' };
        }
        if (request.method === 'GET') {
          return {
            status: 200,
            headers: { ...HEAD_IDENTITY_HEADERS(expected.length), etag: 'fault-etag-1' },
            chunks: chunks.map((chunk, index) => ({ data: chunk, delayMs: index === 0 ? 10 : 0 })),
          };
        }
        if (request.method === 'DELETE') {
          deleted = true;
          return { status: 204, headers: {}, body: '' };
        }
        return { status: 403, headers: {}, body: '' };
      },
      async (store, fault) => {
        const target = handle();
        const grant = await store.issueCreateOnlyGrant(target, {
          ttlSeconds: 60,
          contentType: 'application/octet-stream',
          contentLength: expected.length,
          metadata: { probe: 'phase4a-i06', nonce: 'opaque-nonce-marker' },
        });
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk);
            controller.close();
          },
        });
        const putResponse = await fetch(grant.url, {
          method: 'PUT',
          headers: {
            'If-None-Match': '*',
            'Content-Type': grant.contentType,
            ...grant.metadataHeaders,
          },
          body: stream as unknown as BodyInit,
          duplex: 'half',
        } as unknown as RequestInit);
        assert.equal(putResponse.status, 200);
        assert.ok(uploaded, 'the independent PUT must reach the transport');
        assert.ok(uploaded!.equals(expected), 'the independent client bytes must be preserved');

        const head = await store.headExact(target);
        assert.equal(head.found, true);
        if (head.found) {
          assert.equal(head.identity.size, expected.length);
          assert.equal(head.identity.etag, '"fault-etag-1"');
          assert.equal(head.identity.metadata.probe, 'phase4a-i06');
        }

        const read = await store.readBounded(target, {
          expectedEtag: '"fault-etag-1"',
          byteCeiling: expected.length,
          signal: AbortSignal.timeout(10_000),
        });
        assert.equal(read.found, true);
        assert.ok(read.found);
        const collected: Uint8Array[] = [];
        for await (const chunk of read.stream) collected.push(chunk);
        assert.ok(Buffer.concat(collected).equals(expected), 'read bytes must equal the independently uploaded bytes');

        const deletedOutcome = await store.deleteExact(target);
        assert.equal(deletedOutcome.outcome, 'deleted');
        const absent = await store.confirmAbsent(target);
        assert.equal(absent.absent, true);

        assert.ok(requestsByMethod(fault, 'PUT').length === 1);
        assert.ok(requestsByMethod(fault, 'GET').length === 1);
        assert.ok(requestsByMethod(fault, 'DELETE').length === 1);
      },
    );
  });

  test('client shutdown is idempotent and terminates resources; later calls fail closed', async () => {
    await withFault(
      () => ({ status: 404, headers: {}, body: '' }),
      async (store, fault) => {
        await store.close();
        await store.close();
        const before = fault.requests.length;
        await assert.rejects(
          store.headExact(handle()),
          (error: unknown) => error instanceof BlobStoreError === false
            && (error as { code?: string }).code === 'store_closed',
        );
        assert.equal(fault.requests.length, before, 'no request may reach the transport after shutdown');
      },
    );
  });

  test('identityFromObjectResponse: omitted/empty metadata normalizes to {} while present non-object metadata stays malformed', () => {
    const target = handle();
    // Omitted (undefined): the locked contract marks Metadata optional, so
    // absent metadata is none, exactly like the GET `?? {}` semantics.
    assert.deepEqual(
      identityFromObjectResponse(
        target,
        { ContentLength: 12, ETag: 'abc123', $metadata: { httpStatusCode: 200 } },
        'head_response_malformed',
      ).metadata,
      {},
    );
    // Empty object: the exact shape the pinned SDK deserializer materializes.
    assert.deepEqual(
      identityFromObjectResponse(
        target,
        { ContentLength: 12, ETag: 'abc123', Metadata: {}, $metadata: { httpStatusCode: 200 } },
        'head_response_malformed',
      ).metadata,
      {},
    );
    // Present metadata keeps its canonical identity (keys lowercased,
    // x-amz-meta- prefix stripped, values verbatim).
    assert.deepEqual(
      identityFromObjectResponse(
        target,
        {
          ContentLength: 12,
          ETag: '"abc123"',
          Metadata: { 'X-Amz-Meta-Probe': 'phase4a-i06', nonce: 'opaque-nonce-marker' },
          $metadata: { httpStatusCode: 200 },
        },
        'head_response_malformed',
      ).metadata,
      { probe: 'phase4a-i06', nonce: 'opaque-nonce-marker' },
    );
    // Present but non-object metadata is STILL malformed: only missing/empty
    // semantics are forgiven, never a wrong-typed field.
    assert.throws(
      () => identityFromObjectResponse(
        target,
        {
          ContentLength: 12,
          ETag: 'abc123',
          Metadata: 'not-an-object' as unknown as Record<string, string>,
          $metadata: { httpStatusCode: 200 },
        },
        'head_response_malformed',
      ),
      (error: unknown) => error instanceof BlobStoreError && error.class === 'contract_drift'
        && error.code === 'head_response_malformed',
    );
    // The GET path code applies the same normalization.
    assert.deepEqual(
      identityFromObjectResponse(
        target,
        { ContentLength: 12, ETag: 'abc123', $metadata: { httpStatusCode: 200 } },
        'get_response_malformed',
      ).metadata,
      {},
    );
  });

  test('body-abort exception names across Node versions normalize to the aborted class', () => {
    assert.equal(normalizeBodyReadFailure({ name: 'AbortError' }).class, 'aborted');
    assert.equal(normalizeBodyReadFailure({ name: 'RequestAbortedException' }).class, 'aborted');
    assert.equal(normalizeBodyReadFailure({ code: 'RequestAborted' }).class, 'aborted');
    assert.equal(normalizeBodyReadFailure({ name: 'Error', errno: 'ECONNRESET' }).class, 'retryable');
    assert.equal(normalizeBodyReadFailure(new Error('generic stream failure')).class, 'unknown');
  });
});
