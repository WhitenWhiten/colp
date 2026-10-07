/**
 * LP-01: the link preview store is the public-object R2 adapter with its own
 * prefix and the 2 MiB preview ceiling (the favicon store keeps 64 KiB).
 */
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { createR2FaviconStore, createR2LinkPreviewStore } from '../../../src/infrastructure/collections/index.js';
import {
  BOOKMARK_FAVICON_MAX_BYTES,
  LINK_PREVIEW_MAX_IMAGE_BYTES,
} from '../../../src/modules/collections/index.js';
import { startFaultServer, s3ErrorBody } from '../../support/phase4a-i06-fault-server.js';

const OBJECT_ID = '123e4567-e89b-42d3-a456-426614174000';
const credential = { accessKeyId: 'test', secretAccessKey: 'test-secret' };

function options(endpoint: string, prefix: string) {
  return {
    endpoint, region: 'auto', bucket: 'known-public', prefix,
    rwCredential: credential, roCredential: credential,
  };
}

function serveBody(body: Buffer) {
  return startFaultServer((request) => (request.method === 'GET'
    ? { status: 200, headers: { 'content-type': 'image/jpeg', 'content-length': String(body.length) }, body }
    : { status: 403, headers: {}, body: s3ErrorBody('AccessDenied') }));
}

describe('createR2LinkPreviewStore', () => {
  test('reads an object larger than a favicon under the link preview prefix', async () => {
    const body = Buffer.alloc(BOOKMARK_FAVICON_MAX_BYTES * 4, 7);
    const fault = await serveBody(body);
    try {
      const store = createR2LinkPreviewStore(options(fault.url, 'link-previews/'));
      const stored = await store.get(OBJECT_ID);
      assert.ok(stored);
      assert.deepEqual(stored.body, body);
      assert.ok(fault.requests.some((request) => request.path.includes(`link-previews/${OBJECT_ID}`)));
      await store.close?.();
      // The favicon store still refuses the same object.
      const favicon = createR2FaviconStore(options(fault.url, 'favicon/'));
      assert.equal(await favicon.get(OBJECT_ID), null);
      await favicon.close?.();
    } finally {
      await fault.close();
    }
  });

  test('a declared length above the preview ceiling is missing without draining the body', async () => {
    const fault = await startFaultServer((request) => (request.method === 'GET'
      ? {
          status: 200,
          headers: { 'content-type': 'image/jpeg', 'content-length': String(LINK_PREVIEW_MAX_IMAGE_BYTES + 1) },
          chunks: [{ data: Buffer.from('x') }],
          holdOpen: true,
        }
      : { status: 403, headers: {}, body: s3ErrorBody('AccessDenied') }));
    try {
      const store = createR2LinkPreviewStore(options(fault.url, 'link-previews/'));
      assert.equal(await store.get(OBJECT_ID), null);
      await store.close?.();
    } finally {
      await fault.close();
    }
  });

  test('aborting a body read destroys the response before the store returns', async () => {
    const fault = await startFaultServer((request) => (request.method === 'GET'
      ? {
          status: 200,
          headers: { 'content-type': 'image/png', 'content-length': '64' },
          chunks: [{ data: Buffer.from('partial') }],
          holdOpen: true,
        }
      : { status: 403, headers: {}, body: s3ErrorBody('AccessDenied') }));
    try {
      const store = createR2LinkPreviewStore(options(fault.url, 'link-previews/'));
      const controller = new AbortController();
      const pending = store.get(OBJECT_ID, { signal: controller.signal });
      const started = Date.now();
      while (fault.requests.length < 1) {
        if (Date.now() - started > 2_000) throw new Error('R2 GET did not start');
        await new Promise((resolve) => { setTimeout(resolve, 10); });
      }
      controller.abort(new DOMException('client gone', 'AbortError'));
      await assert.rejects(pending, (error: unknown) => error instanceof DOMException && error.name === 'AbortError');
      assert.ok(await fault.waitForPrematureClose(2_000) >= 1);
      await store.close?.();
    } finally {
      await fault.close();
    }
  });
});
