/**
 * R2 avatar store adapter contract over a CONTROLLED FAULT TRANSPORT.
 *
 * Same transport discipline as the P4A-I06 adapter suite: the S3 client points
 * its `endpoint` at a real local HTTP server driven through the production
 * `@aws-sdk` middleware + `NodeHttpHandler`, so every request is a genuine HTTP
 * exchange with scripted raw responses — not an emulator, not a Map, and not a
 * command mock. Every fault test first asserts the request actually reached the
 * transport, then asserts the adapter's classification: S3 404 (NoSuchKey /
 * NotFound) maps to `null`, any other provider error is rethrown, and a 200
 * read returns the stored content type with the exact scripted bytes.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  createR2AvatarStore,
  type R2AvatarStoreOptions,
} from '../../../src/infrastructure/identity/index.js';
import { AVATAR_MAX_BYTES, type AvatarObjectStore } from '../../../src/modules/identity/index.js';
import {
  startFaultServer,
  s3ErrorBody,
} from '../../support/phase4a-i06-fault-server.js';
import type { FaultScript, FaultServer, RecordedRequest } from '../../support/phase4a-i06-fault-server.js';

const BUCKET = 'known-avatars-production';
const PREFIX = 'avatar/';
const AVATAR_ID = '123e4567-e89b-42d3-a456-426614174000';
const AVATAR_KEY = `${PREFIX}${AVATAR_ID}`;

/** Minimal 1x1 transparent PNG scripted as the 200 body. */
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000182e403790000000049454e44ae426082',
  'hex',
);

function avatarStoreOptions(endpoint: string): R2AvatarStoreOptions {
  return {
    endpoint,
    region: 'auto',
    bucket: BUCKET,
    prefix: PREFIX,
    rwCredential: { accessKeyId: 'write-access-key-marker', secretAccessKey: 'write-secret-access-key-marker' },
    roCredential: { accessKeyId: 'read-access-key-marker', secretAccessKey: 'read-secret-access-key-marker' },
  };
}

async function withFault(script: FaultScript, run: (store: AvatarObjectStore, fault: FaultServer) => Promise<void>): Promise<void> {
  const fault = await startFaultServer(script);
  const store = createR2AvatarStore(avatarStoreOptions(fault.url));
  try {
    await run(store, fault);
  } finally {
    await store.close?.();
    await fault.close();
  }
}

function requestsByMethod(fault: FaultServer, method: string): RecordedRequest[] {
  return fault.requests.filter((request) => request.method === method);
}

/** Proves the exchange really reached the transport and carried the avatar key. */
function assertReachedTransport(fault: FaultServer, minRequests: number): void {
  const gets = requestsByMethod(fault, 'GET');
  assert.ok(gets.length >= minRequests, `the GET must reach the transport (got ${gets.length})`);
  const path = gets[0]?.path ?? '';
  assert.ok(path.includes(AVATAR_KEY), `the request path must carry the avatar key ${AVATAR_KEY} (got ${path})`);
}

describe('R2 avatar store adapter controlled fault transport', () => {
  test('get: 404 NoSuchKey maps to null and the request really reached the transport', async () => {
    await withFault(
      (request) => (request.method === 'GET'
        ? { status: 404, headers: {}, body: s3ErrorBody('NoSuchKey') }
        : { status: 403, headers: {}, body: s3ErrorBody('AccessDenied') }),
      async (store, fault) => {
        const stored = await store.get(AVATAR_ID);
        assert.equal(stored, null, 'a 404 NoSuchKey must be reported as missing, never thrown');
        assertReachedTransport(fault, 1);
      },
    );
  });

  test('get: 404 NotFound maps to null through the error-name branch', async () => {
    await withFault(
      (request) => (request.method === 'GET'
        ? { status: 404, headers: {}, body: s3ErrorBody('NotFound') }
        : { status: 403, headers: {}, body: s3ErrorBody('AccessDenied') }),
      async (store, fault) => {
        const stored = await store.get(AVATAR_ID);
        assert.equal(stored, null, 'a 404 NotFound must be reported as missing, never thrown');
        assertReachedTransport(fault, 1);
      },
    );
  });

  test('get: non-404 provider errors are rethrown, never misclassified as missing', async () => {
    await withFault(
      (request) => (request.method === 'GET'
        ? { status: 500, headers: {}, body: s3ErrorBody('InternalError') }
        : { status: 500, headers: {}, body: s3ErrorBody('InternalError') }),
      async (store, fault) => {
        await assert.rejects(
          store.get(AVATAR_ID),
          (error: unknown) => {
            const candidate = error as { name?: unknown; $metadata?: { httpStatusCode?: number } };
            return candidate.$metadata?.httpStatusCode === 500 && candidate.name === 'InternalError';
          },
          'a 500 InternalError must be rethrown, never mapped to null',
        );
        // The adapter client uses the SDK default retry budget, so a 500 may
        // be attempted more than once; at least one GET must have reached it.
        assertReachedTransport(fault, 1);
      },
    );
  });

  test('get: 200 returns the stored content type and the exact scripted bytes', async () => {
    await withFault(
      (request) => (request.method === 'GET'
        ? {
            status: 200,
            headers: { 'content-type': 'image/png', 'content-length': String(PNG.length) },
            body: PNG,
          }
        : { status: 403, headers: {}, body: s3ErrorBody('AccessDenied') }),
      async (store, fault) => {
        const stored = await store.get(AVATAR_ID);
        assert.ok(stored, 'a 200 read must not be treated as missing');
        assert.equal(stored.contentType, 'image/png');
        assert.ok(stored.body.equals(PNG), 'read bytes must equal the scripted bytes');
        assertReachedTransport(fault, 1);
      },
    );
  });

  test('get: declared Content-Length above AVATAR_MAX_BYTES is missing without waiting on the body', async () => {
    await withFault(
      (request) => (request.method === 'GET'
        ? {
            status: 200,
            headers: {
              'content-type': 'image/png',
              'content-length': String(AVATAR_MAX_BYTES + 1),
            },
            // One tiny chunk flushes headers; holdOpen never ends so a
            // transformToByteArray() / unbounded read would hang this test.
            chunks: [{ data: Buffer.from('x') }],
            holdOpen: true,
          }
        : { status: 403, headers: {}, body: s3ErrorBody('AccessDenied') }),
      async (store, fault) => {
        const stored = await store.get(AVATAR_ID);
        assert.equal(stored, null, 'an oversized declared length must be reported as missing');
        assertReachedTransport(fault, 1);
        const closed = await fault.waitForPrematureClose();
        assert.ok(closed >= 1, 'the unread body stream must be destroyed so the holdOpen socket closes');
      },
    );
  });

  test('get: omitted Content-Length still caps an oversized body and returns null', async () => {
    await withFault(
      (request) => (request.method === 'GET'
        ? {
            status: 200,
            headers: { 'content-type': 'image/png' },
            body: Buffer.alloc(AVATAR_MAX_BYTES + 1, 0x41),
          }
        : { status: 403, headers: {}, body: s3ErrorBody('AccessDenied') }),
      async (store, fault) => {
        const stored = await store.get(AVATAR_ID);
        assert.equal(stored, null, 'an oversized streamed body must be reported as missing');
        assertReachedTransport(fault, 1);
      },
    );
  });

  test('delete: a 200 DeleteObject resolves and the DELETE really reaches the transport', async () => {
    await withFault(
      (request) => (request.method === 'DELETE'
        ? { status: 200, headers: {}, body: '' }
        : { status: 403, headers: {}, body: s3ErrorBody('AccessDenied') }),
      async (store, fault) => {
        await store.delete(AVATAR_ID);
        const deletes = requestsByMethod(fault, 'DELETE');
        assert.ok(deletes.length >= 1, 'the DELETE must reach the transport');
        const path = deletes[0]?.path ?? '';
        assert.ok(path.includes(AVATAR_KEY), `the DELETE path must carry the avatar key ${AVATAR_KEY} (got ${path})`);
      },
    );
  });

  test('delete removes the object: the same key reads as missing afterwards', async () => {
    await withFault(
      (request) => (request.method === 'DELETE'
        ? { status: 200, headers: {}, body: '' }
        : request.method === 'GET'
          ? { status: 404, headers: {}, body: s3ErrorBody('NoSuchKey') }
          : { status: 403, headers: {}, body: s3ErrorBody('AccessDenied') }),
      async (store, fault) => {
        await store.delete(AVATAR_ID);
        const deletes = requestsByMethod(fault, 'DELETE');
        assert.equal(deletes.length, 1, 'exactly one DELETE must have been issued');
        assert.ok(deletes[0]!.path.includes(AVATAR_KEY));
        // After the delete, the same key must read as missing (R2 DeleteObject
        // is idempotent: deleting a non-existent key is also a success, which
        // is the 'delete then get' semantics the upload cleanup relies on).
        const stored = await store.get(AVATAR_ID);
        assert.equal(stored, null, 'a deleted key must be reported missing');
      },
    );
  });
});

for (const failure of ['headers', 'body', 'disconnect', 'shutdown'] as const) test(`get releases provider socket on ${failure}`, async () => {
  let arrived!: () => void;
  const started = new Promise<void>(resolve => { arrived = resolve; });
  await withFault(async () => {
    arrived();
    if (failure === 'headers') await new Promise(resolve => setTimeout(resolve, 250));
    return { status: 200, headers: { 'content-type': 'image/png', 'content-length': '16' },
      chunks: [{ data: PNG.subarray(0, 8) }], holdOpen: true };
  }, async (store, fault) => {
    const controller = new AbortController();
    const reading = store.get(AVATAR_ID, { signal: controller.signal, timeoutMs: 150 });
    const rejected = assert.rejects(reading, error => error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name));
    await started;
    if (failure === 'disconnect') controller.abort();
    if (failure === 'shutdown') await store.close?.();
    await rejected;
    assertReachedTransport(fault, 1);
    assert.ok(await fault.waitForPrematureClose() >= 1);
  });
});
