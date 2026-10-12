/**
 * LP-03: the favicon image transport honours a caller User-Agent and the
 * caller's abort signal (a stopping link preview worker cancels in-flight
 * image fetches instead of waiting for each timeout).
 */
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { fetchFaviconImage } from '../../../src/infrastructure/collections/favicon-fetch.js';
import { FAVICON_FETCH_USER_AGENT, FaviconFetchError } from '../../../src/modules/collections/index.js';
import { makePng } from '../../support/link-preview-fixtures.js';

const base = {
  url: 'https://cdn.example.test/card.png',
  timeoutMs: 5_000,
  maxBytes: 2_097_152,
  maxDecompressedBytes: 41_943_040,
  maxRedirects: 3,
  resolve: async () => ['93.184.216.34'],
};

function userAgentOf(init: RequestInit): string | undefined {
  return (init.headers as Record<string, string>)['user-agent'];
}

test('the User-Agent defaults to the favicon token and can be overridden', async () => {
  const seen: Array<string | undefined> = [];
  const connect = async (_target: unknown, init: RequestInit) => {
    seen.push(userAgentOf(init));
    return new Response(new Uint8Array(makePng(400, 210)), { status: 200 });
  };
  await fetchFaviconImage({ ...base, connect });
  const image = await fetchFaviconImage({ ...base, connect, userAgent: 'Known-LinkPreview/1' });
  assert.deepEqual(seen, [FAVICON_FETCH_USER_AGENT, 'Known-LinkPreview/1']);
  assert.deepEqual([image.width, image.height], [400, 210]);
});

test('aborting the caller signal cancels the fetch', async () => {
  const controller = new AbortController();
  const pending = fetchFaviconImage({
    ...base,
    signal: controller.signal,
    connect: (_target, init) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }),
  });
  controller.abort(new Error('worker stopping'));
  await assert.rejects(pending, (error: unknown) => error instanceof FaviconFetchError && error.reason === 'fetch_failed');
});


test('preview callers reject ICO magic before parsing it, regardless of the declared MIME', async () => {
  // Only the ICO signature is present: decoding would fail with a different error.
  const ico = Buffer.from([0, 0, 1, 0, 0, 0]);
  await assert.rejects(fetchFaviconImage({ ...base, allowIco: false,
    connect: async () => new Response(ico, { headers: { 'content-type': 'image/png' } }),
  }), (error: unknown) => error instanceof FaviconFetchError
    && error.reason === 'invalid_image' && error.message === 'ICO images are not allowed for this caller');
});
