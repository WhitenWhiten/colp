import assert from 'node:assert/strict';
import { brotliCompressSync, deflateRawSync, deflateSync, gzipSync } from 'node:zlib';
import { test } from 'vitest';
import { boundedContentEncodingLayers } from '../../../src/infrastructure/collections/content-encoding-budget.js';
import { decodeReadableReplicaBody, ReadableReplicaBodyEncodingError,
  ReadableReplicaBodyTooLargeError } from '../../../src/infrastructure/collections/readable-replica-decode.js';
import { fetchFaviconImage, inflateFaviconEncoding } from '../../../src/infrastructure/collections/favicon-fetch.js';

const text = '<html><title>中文 and ASCII</title></html>';
const body = Buffer.from(text);
const maxBytes = 4096;

test('supported single encodings and their charset decode remain lossless', () => {
  for (const [coding, bytes] of [
    ['gzip', gzipSync(body)], ['x-gzip', gzipSync(body)], ['deflate', deflateSync(body)],
    ['deflate', deflateRawSync(body)], ['br', brotliCompressSync(body)], ['identity', body],
  ] as const) {
    assert.equal(decodeReadableReplicaBody({ bytes, contentType: 'text/html; charset=utf-8',
      contentEncoding: coding, maxBytes }), text);
    assert.deepEqual(inflateFaviconEncoding(bytes, coding, maxBytes), body);
  }
});

test('two applied encodings are undone in reverse order', () => {
  const bytes = brotliCompressSync(gzipSync(body));
  assert.equal(decodeReadableReplicaBody({ bytes, contentType: 'text/html',
    contentEncoding: 'gzip, br', maxBytes }), text);
  assert.deepEqual(inflateFaviconEncoding(bytes, 'gzip, br', maxBytes), body);
});

test('entire coding chain is admitted before any decompression', () => {
  for (const coding of ['gzip,gzip,gzip', 'identity,'.repeat(40), 'gzip,unsupported']) {
    assert.throws(() => boundedContentEncodingLayers(coding));
    assert.throws(() => decodeReadableReplicaBody({ bytes: Buffer.from('not compressed'),
      contentType: 'text/html', contentEncoding: coding, maxBytes }), ReadableReplicaBodyEncodingError);
    assert.throws(() => inflateFaviconEncoding(Buffer.from('not compressed'), coding, maxBytes),
      /not supported or exceeds the decoding budget/u);
  }
  assert.deepEqual(boundedContentEncodingLayers(' Identity, GZIP, , Br '), ['gzip', 'br']);
  assert.deepEqual(boundedContentEncodingLayers(null), []);
});

test('each readable decoding layer still enforces its byte budget', () => {
  assert.throws(() => decodeReadableReplicaBody({ bytes: gzipSync(Buffer.alloc(8192)),
    contentType: 'text/html', contentEncoding: 'gzip', maxBytes }), ReadableReplicaBodyTooLargeError);
});

test('link-preview HTTP decode cannot spend the larger raster budget', async () => {
  const compressed = gzipSync(Buffer.alloc(1024));
  assert.ok(compressed.length < 256);
  await assert.rejects(fetchFaviconImage({
    url: 'https://preview.test/image.png', timeoutMs: 1000, maxBytes: 256,
    maxDecompressedBytes: 4096, maxRedirects: 0,
    resolve: async () => ['8.8.8.8'],
    connect: async () => new Response(compressed, { headers: { 'content-encoding': 'gzip' } }),
  }), /favicon decompressed body exceeds the size limit/u);
});

test('unencoded body charset and unknown-label fallback are preserved', () => {
  assert.equal(decodeReadableReplicaBody({ bytes: Buffer.from([0x63, 0x61, 0x66, 0xe9]),
    contentType: 'text/html; charset=windows-1252', contentEncoding: null, maxBytes }), 'café');
  assert.equal(decodeReadableReplicaBody({ bytes: body, contentType: 'text/html; charset=not-a-charset',
    contentEncoding: null, maxBytes }), text);
});
