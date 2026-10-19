import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { test } from 'vitest';
import { createR2FaviconStore } from '../../../src/infrastructure/collections/favicon-r2-adapter.js';
import { processFaviconBatchItem } from '../../../src/modules/collections/application/favicon-batch-execution.js';
import { faviconCrc32 } from '../../../src/modules/collections/application/favicon-image-decode.js';
import {
  processFaviconRefreshClaim,
  type FaviconFetcher,
  type FaviconFetchedImage,
} from '../../../src/modules/collections/application/favicon-job-execution.js';
import type { BookmarkFaviconObjectStore } from '../../../src/modules/collections/application/favicon-store.js';
import { s3ErrorBody, startFaultServer } from '../../support/phase4a-i06-fault-server.js';
import { makeBatchHarness, makeClaim, makeItem, makeSingleHarness } from './favicon-execution-fakes.js';

function png(size: number): FaviconFetchedImage {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  const chunk = (name: string, bytes: Buffer) => {
    const value = Buffer.alloc(bytes.length + 12);
    value.writeUInt32BE(bytes.length, 0); value.write(name, 4); bytes.copy(value, 8);
    value.writeUInt32BE(faviconCrc32(value.subarray(4, -4)), value.length - 4);
    return value;
  };
  return { body: Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.alloc(size * (1 + size * 3)))), chunk('IEND', Buffer.alloc(0))]),
  mime: 'image/png', width: size, height: size };
}
const OLD_IMAGE = png(1), NEW_IMAGE = png(2);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function fetchGate() {
  const entered = deferred<void>(), result = deferred<FaviconFetchedImage>();
  return { entered: entered.promise, release: result.resolve,
    fetch: async () => { entered.resolve(); return result.promise; } };
}

/** Exercise the production SDK adapter against HTTP conditional-create semantics. */
async function objectStore() {
  const objects = new Map<string, Buffer>();
  const server = await startFaultServer((request) => {
    const key = new URL(request.path, 'http://storage.test').pathname;
    const body = objects.get(key);
    if (request.method === 'PUT') {
      if (body && request.headers['if-none-match'] === '*') {
        return { status: 412, body: s3ErrorBody('PreconditionFailed') };
      }
      objects.set(key, Buffer.from(request.body));
      return { status: 200, headers: { etag: '"created"' } };
    }
    if (request.method === 'GET' && body) {
      return { status: 200, headers: { 'content-type': 'image/png', 'content-length': String(body.length) }, body };
    }
    return { status: 404, body: s3ErrorBody('NoSuchKey') };
  });
  const store = createR2FaviconStore({ endpoint: server.url, region: 'auto', bucket: 'favicons', prefix: 'icons/',
    rwCredential: { accessKeyId: 'test-writer', secretAccessKey: 'test-secret' },
    roCredential: { accessKeyId: 'test-reader', secretAccessKey: 'test-secret' } });
  return { store, requests: server.requests,
    close: async () => { try { await store.close?.(); } finally { await server.close(); } } };
}

function execution(kind: 'single' | 'batch', store: BookmarkFaviconObjectStore) {
  if (kind === 'single') {
    const { ports, state } = makeSingleHarness();
    return {
      binding: () => state.binding,
      transfer: (owner: string) => { state.job = { ...state.job, status: 'running', leaseOwner: owner }; },
      run: async (leaseOwner: string, fetcher: FaviconFetcher) => (await processFaviconRefreshClaim(
        { ...ports, store, fetcher }, makeClaim({ operation: 'refresh_one', objectId: state.job.objectId, leaseOwner }),
      )).outcome,
    };
  }
  const { ports, state } = makeBatchHarness({ items: [makeItem()] });
  return {
    binding: () => state.binding,
    transfer: (owner: string) => { state.job = { ...state.job, status: 'running', leaseOwner: owner }; },
    run: async (leaseOwner: string, fetcher: FaviconFetcher) => processFaviconBatchItem(
      { ...ports, store, fetcher }, makeClaim({ leaseOwner }), state.items.get('node-1')!,
    ),
  };
}

async function assertBindingBytes(run: ReturnType<typeof execution>, store: BookmarkFaviconObjectStore, image: FaviconFetchedImage) {
  const binding = run.binding();
  assert.ok(binding);
  const stored = await store.get(binding.objectId);
  assert.ok(stored);
  assert.deepEqual(stored.body, image.body);
  assert.equal(binding.byteSize, stored.body.length);
  assert.equal(binding.contentType, stored.contentType);
  assert.deepEqual(binding.digestSha256, createHash('sha256').update(stored.body).digest());
}

test('R2 favicon PUT creates once and rejects replacement of an existing object', async () => {
  const fixture = await objectStore();
  try {
    await fixture.store.put('same-id', OLD_IMAGE.body, OLD_IMAGE.mime);
    await assert.rejects(() => fixture.store.put('same-id', NEW_IMAGE.body, NEW_IMAGE.mime));
    assert.deepEqual((await fixture.store.get('same-id'))?.body, OLD_IMAGE.body);
    const writes = fixture.requests.filter(request => request.method === 'PUT');
    assert.equal(writes.length, 2);
    assert.ok(writes.every(request => request.headers['if-none-match'] === '*'));
  } finally { await fixture.close(); }
});

for (const kind of ['single', 'batch'] as const) {
  test(`${kind}: a late PUT from the old lease cannot replace the new owner's bound bytes`, async () => {
    const fixture = await objectStore(), gate = fetchGate();
    const run = execution(kind, fixture.store);
    const old = run.run('worker-old', gate.fetch);
    try {
      await gate.entered;
      run.transfer('worker-new');
      assert.equal(await run.run('worker-new', async () => NEW_IMAGE), 'succeeded');
      await assertBindingBytes(run, fixture.store, NEW_IMAGE);
      gate.release(OLD_IMAGE);
      assert.equal(await old, kind === 'single' ? 'lease_lost' : 'job_gone');
      await assertBindingBytes(run, fixture.store, NEW_IMAGE);
      assert.equal(fixture.requests.filter(request => request.method === 'PUT').length, 2);
    } finally { gate.release(OLD_IMAGE); await old; await fixture.close(); }
  });

  test(`${kind}: a losing writer retries with the stored winner's bytes and matching metadata`, async () => {
    const fixture = await objectStore(), oldGate = fetchGate(), newGate = fetchGate();
    const run = execution(kind, fixture.store);
    const old = run.run('worker-old', oldGate.fetch);
    let next: Promise<string> | undefined;
    try {
      await oldGate.entered;
      run.transfer('worker-new');
      next = run.run('worker-new', newGate.fetch);
      await newGate.entered;
      // Both workers saw an absent object. The old fetch lands first, after
      // takeover; the new worker must not bind its different, losing body.
      oldGate.release(OLD_IMAGE);
      assert.equal(await old, kind === 'single' ? 'lease_lost' : 'job_gone');
      newGate.release(NEW_IMAGE);
      assert.equal(await next, 'retry_scheduled');
      assert.equal(run.binding(), null);
      run.transfer('worker-retry');
      assert.equal(await run.run('worker-retry', async () => { throw new Error('must reuse stored bytes'); }), 'succeeded');
      await assertBindingBytes(run, fixture.store, OLD_IMAGE);
      assert.equal(fixture.requests.filter(request => request.method === 'PUT').length, 2);
    } finally {
      oldGate.release(OLD_IMAGE); newGate.release(NEW_IMAGE);
      await Promise.all([old, next]); await fixture.close();
    }
  });
}
