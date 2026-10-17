import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import {
  decodeFaviconImage, FaviconFetchDeferred,
  type FaviconFetchOptions, type FaviconFetchedImage, type FaviconFetcher,
} from '../../modules/collections/index.js';

/** Durable validated bytes plus per-process coalescing and database-wide fetch leases. */
export class FaviconProviderCache {
  private readonly inFlight = new Map<string, Promise<FaviconFetchedImage>>();
  private lastCollection = 0;

  constructor(private readonly pool: Pool, private readonly fetcher: FaviconFetcher, private readonly ttlMs: number) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000) throw new RangeError('invalid favicon cache lifetime');
  }

  readonly fetch: FaviconFetcher = async (input) => {
    const key = createHash('sha256').update(input.url).digest('hex');
    let pending = this.inFlight.get(key);
    if (!pending) {
      pending = this.load(key, input);
      this.inFlight.set(key, pending);
    }
    try {
      const image = await pending;
      return { ...decodeFaviconImage(image.body, input.maxBytes, input.maxDecompressedBytes), body: image.body };
    } finally {
      if (this.inFlight.get(key) === pending) this.inFlight.delete(key);
    }
  };

  private async read(key: string, input: FaviconFetchOptions): Promise<FaviconFetchedImage | null> {
    const result = await this.pool.query<{ body: Buffer }>(`
      SELECT body FROM favicon_provider_cache
      WHERE source_key=$1 AND body IS NOT NULL AND expires_at > clock_timestamp()
    `, [key]);
    const body = result.rows[0]?.body;
    return body ? { ...decodeFaviconImage(body, input.maxBytes, input.maxDecompressedBytes), body } : null;
  }

  /** A downstream shared-object projection must not extend an older fetch's lifetime. */
  readonly expiresAt = async (url: string): Promise<Date | null> => {
    const key = createHash('sha256').update(url).digest('hex');
    const result = await this.pool.query<{ expires_at: Date }>(
      'SELECT expires_at FROM favicon_provider_cache WHERE source_key=$1 AND body IS NOT NULL', [key]);
    return result.rows[0]?.expires_at ?? null;
  };

  private async load(key: string, input: FaviconFetchOptions): Promise<FaviconFetchedImage> {
    const cached = await this.read(key, input);
    if (cached) return cached;
    const owner = randomUUID();
    const claimed = await this.pool.query(`
      INSERT INTO favicon_provider_cache(source_key,lease_owner,lease_until)
      VALUES ($1,$2,clock_timestamp() + $3 * interval '1 millisecond')
      ON CONFLICT(source_key) DO UPDATE SET lease_owner=$2, lease_until=EXCLUDED.lease_until
      WHERE (favicon_provider_cache.body IS NULL OR favicon_provider_cache.expires_at <= clock_timestamp())
        AND (favicon_provider_cache.lease_until IS NULL OR favicon_provider_cache.lease_until <= clock_timestamp())
      RETURNING source_key
    `, [key, owner, input.timeoutMs + 5000]);
    if (claimed.rowCount === 0) {
      const ready = await this.read(key, input);
      if (ready) return ready;
      throw new FaviconFetchDeferred(new Date(Date.now() + 1000));
    }
    try {
      const image = await this.fetcher(input);
      decodeFaviconImage(image.body, input.maxBytes, input.maxDecompressedBytes);
      const jitter = 0.9 + Number.parseInt(key.slice(0, 8), 16) / 0xffffffff * 0.2;
      await this.pool.query(`
        UPDATE favicon_provider_cache SET body=$3, expires_at=clock_timestamp() + $4 * interval '1 millisecond',
          updated_at=clock_timestamp(), lease_owner=NULL, lease_until=NULL
        WHERE source_key=$1 AND lease_owner=$2 AND lease_until > clock_timestamp()
      `, [key, owner, image.body, Math.round(this.ttlMs * jitter)]);
      return image;
    } finally {
      await this.pool.query(`UPDATE favicon_provider_cache SET lease_owner=NULL,lease_until=NULL,updated_at=clock_timestamp()
        WHERE source_key=$1 AND lease_owner=$2`, [key, owner]);
    }
  }

  async collectExpired(): Promise<void> {
    if (Date.now() - this.lastCollection < 3_600_000) return;
    this.lastCollection = Date.now();
    await this.pool.query(`DELETE FROM favicon_provider_cache WHERE source_key IN (
      SELECT source_key FROM favicon_provider_cache
      WHERE coalesce(expires_at,updated_at) < clock_timestamp() - interval '1 day'
        AND (lease_until IS NULL OR lease_until <= clock_timestamp())
      ORDER BY coalesce(expires_at,updated_at) FOR UPDATE SKIP LOCKED LIMIT 100
    )`);
  }
}
