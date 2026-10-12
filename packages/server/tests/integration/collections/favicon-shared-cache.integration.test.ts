import { faviconCrc32 } from '../../../src/modules/collections/application/favicon-image-decode.js';
import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, afterAll, expect, test, vi } from 'vitest';
import { createIsolatedPostgresRuntime, describeWithPostgres, type IsolatedPostgresRuntime } from '../../support/postgres-test-runtime.js';
import { up } from '../../../migrations/202610202400_shared_favicons.js';
import { SharedFaviconCache } from '../../../src/infrastructure/collections/favicon-shared-cache.js';
import { createScheduledFaviconFetcher } from '../../../src/infrastructure/collections/favicon-provider-scheduler.js';
import { FaviconFetchDeferred, FaviconProviderThrottled } from '../../../src/modules/collections/application/favicon-fetch-deferred.js';
import type { FaviconFetchedImage } from '../../../src/modules/collections/application/favicon-job-execution.js';
import { KNOWN_FAVICON_DOMAINS } from '../../../src/modules/collections/application/favicon-known-domains.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const image: FaviconFetchedImage = { body: png, mime: 'image/png', width: 1, height: 1 };
const input = { url: 'https://favicone.com/google.com', timeoutMs: 1000, maxBytes: 65536, maxDecompressedBytes: 4194304, maxRedirects: 3 };

describeWithPostgres('shared favicon cache and provider admission', () => {
  let isolated: IsolatedPostgresRuntime;
  const objects = new Map<string, { contentType: string; body: Buffer }>();
  const store = {
    get: vi.fn(async (id: string) => objects.get(id) ?? null),
    put: vi.fn(async (id: string, body: Buffer, contentType: string) => { objects.set(id, { body, contentType }); }),
    delete: vi.fn(async (id: string) => { objects.delete(id); }),
  };
  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('shared_favicon');
    await up(isolated.runtime.db);
  });
  beforeEach(async () => {
    await isolated.runtime.pool.query('TRUNCATE favicon_shared_objects, favicon_shared_domains, favicon_provider_admission');
    objects.clear(); vi.clearAllMocks();
  });
  afterAll(async () => isolated?.close());

  function cache(fetcher = vi.fn(async () => image)) {
    return new SharedFaviconCache(isolated.runtime.pool, store, fetcher, {
      providerTemplate: 'https://favicone.com/{hostname}', refreshIntervalMs: 2592000000,
      retentionSeconds: 31536000, fetch: input,
    });
  }
  async function makeDue(hostname: string) {
    await isolated.runtime.pool.query(`UPDATE favicon_shared_domains SET next_refresh_at=now()+interval '1 year'`);
    await isolated.runtime.pool.query(`UPDATE favicon_shared_domains SET next_refresh_at=now()-interval '1 second' WHERE hostname=$1`, [hostname]);
  }
  async function openGate() {
    await isolated.runtime.pool.query(`UPDATE favicon_provider_admission SET next_request_at=now()-interval '1 second', lease_until=NULL`);
  }

  test('independent workers admit only one request, and unrelated providers have independent budgets', async () => {
    let release!: (image: FaviconFetchedImage) => void;
    const fetcher = vi.fn(() => new Promise<FaviconFetchedImage>(resolve => { release = resolve; }));
    const one = createScheduledFaviconFetcher(isolated.runtime.pool, fetcher);
    const two = createScheduledFaviconFetcher(isolated.runtime.pool, async () => image);
    const active = one(input);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    await expect(two(input)).rejects.toBeInstanceOf(FaviconFetchDeferred);
    await expect(two({ ...input, url: 'https://another.example/google.com' })).resolves.toEqual(image);
    release(image); await active;
    await expect(two(input)).rejects.toBeInstanceOf(FaviconFetchDeferred);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  test('429 persists Retry-After across workers and doubles cooldown without the header', async () => {
    const limited = createScheduledFaviconFetcher(isolated.runtime.pool, async () => { throw new FaviconProviderThrottled('900'); });
    await expect(limited(input)).rejects.toBeInstanceOf(FaviconFetchDeferred);
    const state = (await isolated.runtime.pool.query('SELECT * FROM favicon_provider_admission')).rows[0];
    expect(state.next_request_at.getTime() - Date.now()).toBeGreaterThan(899000);
    const healthy = vi.fn(async () => image);
    await expect(createScheduledFaviconFetcher(isolated.runtime.pool, healthy)(input)).rejects.toBeInstanceOf(FaviconFetchDeferred);
    expect(healthy).not.toHaveBeenCalled();
    await openGate();
    const noHeader = createScheduledFaviconFetcher(isolated.runtime.pool, async () => { throw new FaviconProviderThrottled(null); });
    await expect(noHeader(input)).rejects.toBeInstanceOf(FaviconFetchDeferred);
    const next = (await isolated.runtime.pool.query('SELECT * FROM favicon_provider_admission')).rows[0];
    expect(next.throttles).toBe(2);
    expect(next.next_request_at.getTime() - Date.now()).toBeGreaterThan(119000);
  });

  test('an expired worker lease can be reclaimed without a stuck queue', async () => {
    await isolated.runtime.pool.query(`INSERT INTO favicon_provider_admission(provider,lease_owner,lease_until)
      VALUES ('https://favicone.com',$1,now()-interval '1 second')`, [randomUUID()]);
    await expect(createScheduledFaviconFetcher(isolated.runtime.pool, async () => image)(input)).resolves.toEqual(image);
  });

  test('seed, immutable publish, cache hits and www alias avoid all provider requests', async () => {
    const fetcher = vi.fn(async () => image);
    const shared = cache(fetcher);
    await shared.runOnce();
    expect((await isolated.runtime.pool.query('SELECT count(*)::int n FROM favicon_shared_domains')).rows[0].n).toBe(KNOWN_FAVICON_DOMAINS.length);
    await makeDue('google.com'); await shared.runOnce();
    fetcher.mockClear();
    const result = await shared.fetch({ ...input, targetHostname: 'www.google.com', url: 'https://user-provider.example/google.com' });
    expect(result.body).toEqual(png);
    expect(fetcher).not.toHaveBeenCalled();
    const count = store.put.mock.calls.length;
    await makeDue('google.com'); await shared.runOnce();
    expect(store.put.mock.calls.length).toBe(count);
  });

  test('cold known hosts defer instead of hitting an account provider, unknown hosts use it', async () => {
    const fetcher = vi.fn(async () => image);
    const shared = cache(fetcher);
    await expect(shared.fetch({ ...input, targetHostname: 'youtube.com' })).rejects.toBeInstanceOf(FaviconFetchDeferred);
    expect(fetcher).not.toHaveBeenCalled();
    await shared.fetch({ ...input, targetHostname: 'unknown.example' });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  test('refresh failure keeps old bytes, delays retry and survives restart', async () => {
    const shared = cache(); await shared.runOnce(); await makeDue('google.com'); await shared.runOnce();
    const before = (await isolated.runtime.pool.query("SELECT * FROM favicon_shared_domains WHERE hostname='google.com'")).rows[0];
    await makeDue('google.com');
    const failed = cache(vi.fn(async () => { throw new Error('provider unavailable'); }));
    await expect(failed.runOnce()).rejects.toThrow('provider unavailable');
    const after = (await isolated.runtime.pool.query("SELECT * FROM favicon_shared_domains WHERE hostname='google.com'")).rows[0];
    expect(after.object_id).toBe(before.object_id);
    expect(after.failures).toBe(1);
    expect(after.next_refresh_at.getTime()).toBeGreaterThan(Date.now());
    expect((await cache().fetch({ ...input, targetHostname: 'google.com' })).body).toEqual(png);
  });

  test('two warmers cannot fetch the same domain concurrently', async () => {
    await isolated.runtime.pool.query("INSERT INTO favicon_shared_domains(hostname) VALUES ('google.com')");
    let release!: (image: FaviconFetchedImage) => void;
    const fetcher = vi.fn(() => new Promise<FaviconFetchedImage>(resolve => { release = resolve; }));
    const active = cache(fetcher).runOnce();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    await isolated.runtime.pool.query("UPDATE favicon_shared_domains SET next_refresh_at=now()+interval '1 year' WHERE hostname<>'google.com'");
    const secondFetcher = vi.fn(async () => image);
    expect(await cache(secondFetcher).runOnce()).toBe(false);
    expect(secondFetcher).not.toHaveBeenCalled();
    release(image); await active;
  });

  test('orphan GC never removes a current shared version', async () => {
    const shared = cache(); await shared.runOnce();
    await isolated.runtime.pool.query("UPDATE favicon_shared_domains SET next_refresh_at=now()+interval '1 year'");
    await isolated.runtime.pool.query("UPDATE favicon_shared_objects SET deletable_at=now()-interval '1 second'");
    await shared.runOnce(); expect(store.delete).not.toHaveBeenCalled();
    const orphan = randomUUID();
    await isolated.runtime.pool.query(`INSERT INTO favicon_shared_objects(object_id,hostname,digest,deletable_at)
      VALUES ($1,$2,'orphan',now()-interval '1 second')`, [orphan, KNOWN_FAVICON_DOMAINS[0]]);
    await shared.runOnce(); expect(store.delete).toHaveBeenCalledWith(orphan);
  });

  test('a stale provider lease cannot release a newer request', async () => {
    let finishOld!: (value: FaviconFetchedImage) => void;
    let finishNew!: (value: FaviconFetchedImage) => void;
    const oldFetch = vi.fn(() => new Promise<FaviconFetchedImage>(resolve => { finishOld = resolve; }));
    const newFetch = vi.fn(() => new Promise<FaviconFetchedImage>(resolve => { finishNew = resolve; }));
    const oldRequest = createScheduledFaviconFetcher(isolated.runtime.pool, oldFetch)(input);
    await vi.waitFor(() => expect(oldFetch).toHaveBeenCalledOnce());
    await openGate();
    const newRequest = createScheduledFaviconFetcher(isolated.runtime.pool, newFetch)(input);
    await vi.waitFor(() => expect(newFetch).toHaveBeenCalledOnce());
    finishOld(image); await oldRequest;
    const state = (await isolated.runtime.pool.query('SELECT lease_owner FROM favicon_provider_admission')).rows[0];
    expect(state.lease_owner).not.toBeNull();
    finishNew(image); await newRequest;
  });

  test('a stale warmer cannot publish after losing its lease; its upload stays in the orphan ledger', async () => {
    let release!: (value: FaviconFetchedImage) => void;
    const fetcher = vi.fn(() => new Promise<FaviconFetchedImage>(resolve => { release = resolve; }));
    const active = cache(fetcher).runOnce();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    await isolated.runtime.pool.query('UPDATE favicon_shared_domains SET lease_owner=NULL WHERE lease_owner IS NOT NULL');
    release(image); await active;
    expect((await isolated.runtime.pool.query('SELECT count(object_id)::int n FROM favicon_shared_domains')).rows[0].n).toBe(0);
    expect((await isolated.runtime.pool.query('SELECT count(*)::int n FROM favicon_shared_objects')).rows[0].n).toBe(1);
  });

  test('missing R2 bytes schedule repair without contacting an account provider', async () => {
    const fetcher = vi.fn(async () => image);
    const shared = cache(fetcher); await shared.runOnce(); await makeDue('google.com'); await shared.runOnce();
    objects.clear(); fetcher.mockClear();
    await expect(shared.fetch({ ...input, targetHostname: 'google.com' })).rejects.toBeInstanceOf(FaviconFetchDeferred);
    expect(fetcher).not.toHaveBeenCalled();
    const row = (await isolated.runtime.pool.query("SELECT next_refresh_at FROM favicon_shared_domains WHERE hostname='google.com'")).rows[0];
    expect(row.next_refresh_at.getTime()).toBeLessThanOrEqual(Date.now());
    await shared.runOnce();
    expect((await shared.fetch({ ...input, targetHostname: 'google.com' })).body).toEqual(png);
  });


  test('changed bytes publish a new immutable version and retain the displaced URL for a full year', async () => {
    const fetcher = vi.fn(async () => image);
    const shared = cache(fetcher); await shared.runOnce(); await makeDue('google.com'); await shared.runOnce();
    const old = (await isolated.runtime.pool.query("SELECT object_id FROM favicon_shared_domains WHERE hostname='google.com'")).rows[0].object_id;
    // Add a valid ancillary PNG text chunk without changing its pixel dimensions.
    const data = Buffer.from('version\0two');
    const chunk = Buffer.alloc(data.length + 12);
    chunk.writeUInt32BE(data.length, 0); chunk.write('tEXt', 4); data.copy(chunk, 8);
    chunk.writeUInt32BE(faviconCrc32(chunk.subarray(4, -4)), chunk.length - 4);
    const changed = Buffer.concat([png.subarray(0, -12), chunk, png.subarray(-12)]);
    fetcher.mockImplementation(async () => ({ ...image, body: changed }));
    await isolated.runtime.pool.query("UPDATE favicon_shared_objects SET deletable_at=now()-interval '1 second' WHERE object_id=$1", [old]);
    await makeDue('google.com'); await shared.runOnce();
    const current = (await isolated.runtime.pool.query("SELECT * FROM favicon_shared_domains WHERE hostname='google.com'")).rows[0];
    expect(current.object_id).not.toBe(old);
    expect((await shared.fetch({ ...input, targetHostname: 'google.com' })).body).toEqual(changed);
    expect(objects.get(old)?.body).toEqual(png);
    const retained = (await isolated.runtime.pool.query('SELECT deletable_at FROM favicon_shared_objects WHERE object_id=$1', [old])).rows[0];
    expect(retained.deletable_at.getTime() - Date.now()).toBeGreaterThan(31535999000);
    expect(current.next_refresh_at.getTime() - Date.now()).toBeGreaterThan(2592000000 * 0.89);
    expect(current.next_refresh_at.getTime() - Date.now()).toBeLessThan(2592000000 * 1.11);
  });

});
