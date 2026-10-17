import { createHash, randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, afterAll, expect, test, vi } from 'vitest';
import { createIsolatedPostgresRuntime, describeWithPostgres, type IsolatedPostgresRuntime } from '../../support/postgres-test-runtime.js';
import { up as cacheMigration } from '../../../migrations/202610311400_favicon_provider_cache.js';
import { up as admissionMigration } from '../../../migrations/202610202400_shared_favicons.js';
import { FaviconProviderCache } from '../../../src/infrastructure/collections/favicon-provider-cache.js';
import { createScheduledFaviconFetcher } from '../../../src/infrastructure/collections/favicon-provider-scheduler.js';
import { FaviconFetchDeferred, FaviconProviderThrottled } from '../../../src/modules/collections/index.js';
import { makePng } from '../../support/link-preview-fixtures.js';

const body = makePng(16, 16);
const image = { body, mime: 'image/png' as const, width: 16, height: 16 };
const input = { url: 'https://icons.example.org/example.com', timeoutMs: 1000, maxBytes: 65536, maxDecompressedBytes: 4194304, maxRedirects: 3 };
const ttl = 30 * 86_400_000;
const key = createHash('sha256').update(input.url).digest('hex');

describeWithPostgres('durable favicon provider result cache', () => {
  let isolated: IsolatedPostgresRuntime;
  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('favicon_provider_cache');
    await admissionMigration(isolated.runtime.db);
    await cacheMigration(isolated.runtime.db);
  });
  beforeEach(async () => { await isolated.runtime.pool.query('TRUNCATE favicon_provider_cache, favicon_provider_admission'); });
  afterAll(async () => isolated?.close());

  test('coalesces callers, survives a new cache instance, and keeps providers and URL parameters separate', async () => {
    const fetcher = vi.fn(async () => image);
    const cache = new FaviconProviderCache(isolated.runtime.pool, fetcher, ttl);
    const results = await Promise.all(Array.from({ length: 40 }, () => cache.fetch(input)));
    expect(fetcher).toHaveBeenCalledOnce();
    expect(results.every(result => result.body.equals(body))).toBe(true);
    await new FaviconProviderCache(isolated.runtime.pool, fetcher, ttl).fetch(input);
    expect(fetcher).toHaveBeenCalledOnce();
    await cache.fetch({ ...input, url: input.url + '?s=32' });
    await cache.fetch({ ...input, url: 'https://other.example.org/example.com' });
    expect(fetcher).toHaveBeenCalledTimes(3);
    const expiry = (await isolated.runtime.pool.query('SELECT expires_at FROM favicon_provider_cache WHERE source_key=$1', [key])).rows[0].expires_at;
    expect(expiry.getTime() - Date.now()).toBeGreaterThan(ttl * 0.89);
    expect(expiry.getTime() - Date.now()).toBeLessThanOrEqual(ttl * 1.1);
  });

  test('a second worker cannot fetch a source whose lease is held, then reads the published result', async () => {
    let release!: (value: typeof image) => void;
    const fetcher = vi.fn(() => new Promise<typeof image>(resolve => { release = resolve; }));
    const one = new FaviconProviderCache(isolated.runtime.pool, fetcher, ttl);
    const two = new FaviconProviderCache(isolated.runtime.pool, fetcher, ttl);
    const first = one.fetch(input);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    await expect(two.fetch(input)).rejects.toBeInstanceOf(FaviconFetchDeferred);
    release(image); await first;
    await expect(two.fetch(input)).resolves.toEqual(image);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  test('expiry refetches and a failed refresh releases the lease without exposing invalid cached bytes', async () => {
    const fetcher = vi.fn(async () => image);
    const cache = new FaviconProviderCache(isolated.runtime.pool, fetcher, ttl);
    await cache.fetch(input);
    await isolated.runtime.pool.query("UPDATE favicon_provider_cache SET expires_at=now()-interval '1 second'");
    fetcher.mockRejectedValueOnce(new Error('transport unavailable'));
    await expect(cache.fetch(input)).rejects.toThrow('transport unavailable');
    const row = (await isolated.runtime.pool.query('SELECT * FROM favicon_provider_cache')).rows[0];
    expect(row.lease_owner).toBeNull();
    await cache.fetch(input);
    expect(fetcher).toHaveBeenCalledTimes(3);
    await expect(cache.fetch({ ...input, maxBytes: 1 })).rejects.toThrow(/at most/u);
  });

  test('a stale lease completion cannot overwrite a newer cache version', async () => {
    let release!: (value: typeof image) => void;
    const fetcher = vi.fn(() => new Promise<typeof image>(resolve => { release = resolve; }));
    const cache = new FaviconProviderCache(isolated.runtime.pool, fetcher, ttl);
    const active = cache.fetch(input);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    const newer = makePng(16, 16, 64);
    await isolated.runtime.pool.query(`UPDATE favicon_provider_cache SET lease_owner=$2,
      lease_until=now()+interval '1 minute', body=$3, expires_at=now()+interval '1 day' WHERE source_key=$1`, [key, randomUUID(), newer]);
    release(image); await active;
    const row = (await isolated.runtime.pool.query('SELECT body FROM favicon_provider_cache WHERE source_key=$1', [key])).rows[0];
    expect(row.body.equals(newer)).toBe(true);
  });

  test('cache hits bypass admission while uncached requests obey durable 429 cooldown', async () => {
    const fetcher = vi.fn(async () => image);
    const scheduled = createScheduledFaviconFetcher(isolated.runtime.pool, fetcher);
    const cache = new FaviconProviderCache(isolated.runtime.pool, scheduled, ttl);
    await cache.fetch(input);
    await expect(cache.fetch(input)).resolves.toEqual(image);
    expect(fetcher).toHaveBeenCalledOnce();
    await expect(cache.fetch({ ...input, url: input.url + '?s=32' })).rejects.toBeInstanceOf(FaviconFetchDeferred);
    await isolated.runtime.pool.query("UPDATE favicon_provider_admission SET next_request_at=now()-interval '1 second'");
    fetcher.mockRejectedValueOnce(new FaviconProviderThrottled('120'));
    await expect(cache.fetch({ ...input, url: input.url + '?s=32' })).rejects.toBeInstanceOf(FaviconFetchDeferred);
    await expect(cache.fetch(input)).resolves.toEqual(image);
    const state = (await isolated.runtime.pool.query('SELECT * FROM favicon_provider_admission')).rows[0];
    expect(state.next_request_at.getTime() - Date.now()).toBeGreaterThan(119_000);
  });

  test('expired abandoned rows are collected without deleting active leases or fresh results', async () => {
    const cache = new FaviconProviderCache(isolated.runtime.pool, async () => image, ttl);
    await cache.fetch(input);
    await isolated.runtime.pool.query(`INSERT INTO favicon_provider_cache(source_key,updated_at)
      VALUES ($1,now()-interval '2 days')`, ['a'.repeat(64)]);
    await isolated.runtime.pool.query(`INSERT INTO favicon_provider_cache(source_key,updated_at,lease_owner,lease_until)
      VALUES ($1,now()-interval '2 days',$2,now()+interval '1 minute')`, ['b'.repeat(64), randomUUID()]);
    await cache.collectExpired();
    const rows = (await isolated.runtime.pool.query('SELECT source_key FROM favicon_provider_cache')).rows;
    expect(rows.map(row => row.source_key).sort()).toEqual([key, 'b'.repeat(64)].sort());
  });
});
