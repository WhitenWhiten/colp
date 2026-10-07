import assert from 'node:assert/strict';
import { test } from 'vitest';
import { FetchPublicationCachePurgeProvider, PublicationCachePurgeProviderError,
  type PublicationCachePurgeRequest } from '../../../src/infrastructure/outbox/publication-cache-purge.js';

function request(signal: AbortSignal): PublicationCachePurgeRequest {
  return { eventId: 'event', idempotencyKey: 'key', collectionId: 'collection', publicationSlug: 'slug',
    visibility: 'public', contentRevision: '1', policyRevision: '1', sourceEventType: null,
    sourceEventVersion: null, urls: [], surrogateKeys: [], signal };
}

for (const status of [200, 400, 408, 425, 429, 500]) {
  test(`purge releases HTTP ${status} stream without aborting its caller`, async () => {
    const parent = new AbortController();
    let cancelled = 0;
    let outgoing: AbortSignal | null | undefined;
    const provider = new FetchPublicationCachePurgeProvider({ endpoint: 'https://purge.test/',
      fetch: async (_url, init) => {
        outgoing = init?.signal;
        return new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled += 1; } }), { status });
      } });
    const result = provider.purge(request(parent.signal));
    if (status === 200) await result;
    else await assert.rejects(result, (error: unknown) => error instanceof PublicationCachePurgeProviderError
      && error.statusCode === status
      && error.failureKind === (status === 400 ? 'permanent' : 'retryable'));
    assert.equal(cancelled, 1);
    assert.equal(outgoing?.aborted, true);
    assert.equal(parent.signal.aborted, false);
  });
}

test('purge accepts 204 without a response body', async () => {
  const parent = new AbortController();
  const provider = new FetchPublicationCachePurgeProvider({ endpoint: 'https://purge.test/',
    fetch: async () => new Response(null, { status: 204 }) });
  await provider.purge(request(parent.signal));
  assert.equal(parent.signal.aborted, false);
});

test('cleanup does not await an uncooperative cancellation acknowledgement', async () => {
  let cancelled = false;
  const provider = new FetchPublicationCachePurgeProvider({ endpoint: 'https://purge.test/',
    fetch: async () => new Response(new ReadableStream<Uint8Array>({
      cancel() { cancelled = true; return new Promise<void>(() => {}); },
    })) });
  await provider.purge(request(new AbortController().signal));
  assert.equal(cancelled, true);
}, 1000);

test('an already aborted caller does not start an outbound fetch', async () => {
  let calls = 0;
  const parent = new AbortController();
  parent.abort();
  const provider = new FetchPublicationCachePurgeProvider({ endpoint: 'https://purge.test/',
    fetch: async () => { calls += 1; return new Response(null, { status: 204 }); } });
  await assert.rejects(provider.purge(request(parent.signal)), PublicationCachePurgeProviderError);
  assert.equal(calls, 0);
});

test('caller cancellation propagates to the owned fetch signal', async () => {
  const parent = new AbortController();
  const provider = new FetchPublicationCachePurgeProvider({ endpoint: 'https://purge.test/',
    fetch: async (_url, init) => {
      parent.abort();
      assert.equal(init?.signal?.aborted, true);
      throw new DOMException('Aborted', 'AbortError');
    } });
  await assert.rejects(provider.purge(request(parent.signal)),
    (error: unknown) => error instanceof PublicationCachePurgeProviderError && error.failureKind === 'retryable');
});
