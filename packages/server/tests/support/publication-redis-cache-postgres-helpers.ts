/**
 * Shared helpers for the T13 PostgreSQL + Redis end-to-end acceptance suite
 * (plan 12-redis-hot-data-cache-plan.md §6.4 T13, §7.1 HTTP/PostgreSQL
 * integration layer, §7.2/§7.3 anti-false-positive/negative rules).
 *
 * Everything here is a test harness, not src: HTTP capture/byte-equality
 * assertions, the production epoch-key reader, and the cold-miss/warm-hit
 * contract helper. Container/runtime lifecycle stays in the suite.
 */
import assert from 'node:assert/strict';
import {
  buildCacheEpochKey,
  type CacheStore,
} from '../../src/infrastructure/cache/index.js';
import {
  type ComposedApi,
  type E2ETestScope,
  signal,
  waitForCacheHealth,
} from './redis-cache-e2e.js';

export interface CapturedResponse {
  readonly statusCode: number;
  readonly bytes: Buffer;
  readonly etag: string | undefined;
  readonly body: unknown;
}

export async function getPublication(
  app: ComposedApi,
  url: string,
  headers: Record<string, string> = { accept: 'application/json' },
): Promise<CapturedResponse> {
  const response = await app.app.inject({ method: 'GET', url, headers });
  return {
    statusCode: response.statusCode,
    bytes: Buffer.from(response.rawPayload),
    etag: typeof response.headers.etag === 'string' ? response.headers.etag : undefined,
    body: response.json(),
  };
}

export function assertEqualBytes(actual: CapturedResponse, expected: CapturedResponse, label: string): void {
  assert.equal(actual.statusCode, expected.statusCode, `${label} status`);
  assert.deepEqual(actual.bytes, expected.bytes, `${label} body bytes`);
  assert.equal(actual.etag, expected.etag, `${label} ETag`);
}

export function metadataUrl(collectionId: string): string {
  return `/colp/v0.1/collections/${encodeURIComponent(collectionId)}`;
}

export function snapshotUrl(collectionId: string): string {
  return `/colp/v0.1/collections/${encodeURIComponent(collectionId)}/snapshot`;
}

export async function readEpoch(
  scope: E2ETestScope,
  collectionId: string,
  store: CacheStore,
): Promise<number> {
  const key = buildCacheEpochKey({
    environment: 'test',
    keyPrefix: scope.keyPrefix,
    domain: { kind: 'publication', locator: 'pubid', collectionId },
  });
  const raw = await store.get(key, signal());
  return raw === null ? 0 : Number.parseInt(raw, 10);
}

export async function readDirectoryEpoch(
  scope: E2ETestScope,
  store: CacheStore,
): Promise<number> {
  const key = buildCacheEpochKey({
    environment: 'test',
    keyPrefix: scope.keyPrefix,
    domain: { kind: 'publication-directory' },
  });
  const raw = await store.get(key, signal());
  return raw === null ? 0 : Number.parseInt(raw, 10);
}

/**
 * Proves the cold-miss/warm-hit contract for one route (plan §7.2 rule 1/2):
 * request 1 -> loader 1 + Redis write; request 2 -> loader 0 + Redis GET
 * evidence + byte/ETag-equivalent body against the reference (off) route.
 */
export async function assertWarmHitContract(
  serve: ComposedApi,
  off: ComposedApi,
  url: string,
  loaderCalls: () => number,
): Promise<{ readonly miss: CapturedResponse; readonly hit: CapturedResponse; readonly reference: CapturedResponse }> {
  await waitForCacheHealth(serve);
  assert.ok(serve.store, 'serve app must own a Redis store');

  serve.counters.reset();
  serve.store.reset();
  const miss = await getPublication(serve, url);
  assert.equal(miss.statusCode, 200, `cold miss must return 200 for ${url}`);
  assert.equal(loaderCalls(), 1, `cold miss must load origin exactly once for ${url}`);
  assert.ok(serve.store.counts.get >= 2, `cold miss must issue Redis GETs (epoch + data) for ${url}`);
  assert.equal(serve.store.counts.set, 1, `cold miss must write the Redis envelope for ${url}`);
  assert.equal(serve.store.counts.setIfAbsent, 1, `cold miss must acquire the distributed lock for ${url}`);

  serve.counters.reset();
  serve.store.reset();
  const hit = await getPublication(serve, url);
  assert.equal(hit.statusCode, 200, `warm hit must return 200 for ${url}`);
  assert.equal(loaderCalls(), 0, `warm hit must not call the origin loader for ${url}`);
  assert.ok(serve.store.counts.get >= 2, `warm hit must still issue Redis GETs (epoch + data) for ${url}`);
  assert.equal(serve.store.counts.set, 0, `warm hit must not write Redis for ${url}`);

  const reference = await getPublication(off, url);
  assert.equal(reference.statusCode, 200, `reference route must return 200 for ${url}`);
  assertEqualBytes(miss, reference, `cold miss vs off reference (${url})`);
  assertEqualBytes(hit, reference, `warm hit vs off reference (${url})`);
  assert.deepEqual(hit.body, miss.body, `warm hit body must equal cold miss body (${url})`);
  return { miss, hit, reference };
}
