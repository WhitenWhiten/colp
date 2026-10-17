import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import {
  FaviconFetchDeferred,
  KNOWN_FAVICON_DOMAINS,
  decodeFaviconImage,
  knownFaviconHostname,
  resolveFaviconProviderUrl,
  type BookmarkFaviconObjectStore,
  type FaviconFetchOptions,
  type FaviconFetcher,
} from '../../modules/collections/index.js';

interface SharedClaim {
  hostname: string;
  object_id: string | null;
  failures: number;
}
export interface SharedFaviconOptions {
  readonly providerTemplate: string;
  readonly refreshIntervalMs: number;
  readonly retentionSeconds: number;
  readonly fetch: Omit<FaviconFetchOptions, 'url'>;
  readonly fetchCacheExpiry?: (url: string) => Promise<Date | null>;
}

/** Each tick refreshes at most one domain. Leases and dates survive worker restarts. */
export class SharedFaviconCache {
  private seeded = false;
  constructor(
    private readonly pool: Pool,
    private readonly store: BookmarkFaviconObjectStore,
    private readonly fetcher: FaviconFetcher,
    private readonly options: SharedFaviconOptions,
  ) {}

  /** Known sites never fall through to the account provider, even before warming. */
  readonly fetch: FaviconFetcher = async (input) => {
    const hostname = input.targetHostname ? knownFaviconHostname(input.targetHostname) : null;
    if (hostname === null) return this.fetcher(input);
    const result = await this.pool.query<{ object_id: string | null }>(
      'SELECT object_id FROM favicon_shared_domains WHERE hostname=$1', [hostname],
    );
    const id = result.rows[0]?.object_id;
    const stored = id ? await this.store.get(id) : null;
    if (!stored) {
      // User work fills cold known hosts immediately, through the same durable
      // provider cache/admission as other hosts. Keep the shared provider rule.
      const url = resolveFaviconProviderUrl(this.options.providerTemplate, hostname);
      if (!url) throw new Error('invalid shared favicon provider template');
      await this.pool.query(`INSERT INTO favicon_shared_domains(hostname,next_refresh_at)
        VALUES ($1, clock_timestamp() - interval '1 day')
        ON CONFLICT(hostname) DO UPDATE SET
          next_refresh_at=least(favicon_shared_domains.next_refresh_at, EXCLUDED.next_refresh_at),
          object_id=CASE WHEN favicon_shared_domains.object_id=$2 THEN NULL ELSE favicon_shared_domains.object_id END`, [hostname, id ?? null]);
      return this.fetcher({ ...input, url });
    }
    const decoded = decodeFaviconImage(stored.body, input.maxBytes, input.maxDecompressedBytes);
    return { ...decoded, body: stored.body };
  };

  async runOnce(): Promise<boolean> {
    // A sleeping user job still owns the next provider slot; warming must not
    // take it simply because claimDue cannot run until its cooldown expires.
    const active = await this.pool.query(`SELECT 1 FROM favicon_jobs WHERE status IN ('pending','running') LIMIT 1`);
    if (active.rows.length > 0) return false;
    const cooling = await this.pool.query(`SELECT 1 FROM favicon_provider_admission
      WHERE provider=$1 AND greatest(next_request_at,lease_until) > clock_timestamp()`,
    [new URL(this.options.providerTemplate).origin]);
    if (cooling.rows.length > 0) {
      await this.collectOne();
      return false;
    }
    if (!this.seeded) {
      await this.pool.query(`
        INSERT INTO favicon_shared_domains(hostname)
        SELECT unnest($1::text[]) ON CONFLICT DO NOTHING
      `, [KNOWN_FAVICON_DOMAINS]);
      this.seeded = true;
    }
    const owner = randomUUID();
    const result = await this.pool.query<SharedClaim>(`
      WITH candidate AS (
        SELECT hostname FROM favicon_shared_domains
        WHERE next_refresh_at <= clock_timestamp()
          AND (lease_until IS NULL OR lease_until <= clock_timestamp())
          AND hostname=ANY($2::text[])
        ORDER BY next_refresh_at, hostname FOR UPDATE SKIP LOCKED LIMIT 1
      )
      UPDATE favicon_shared_domains d SET lease_owner=$1,
        lease_until=clock_timestamp() + interval '2 minutes'
      FROM candidate c WHERE d.hostname=c.hostname
      RETURNING d.hostname, d.object_id, d.failures
    `, [owner, KNOWN_FAVICON_DOMAINS]);
    const claim = result.rows[0];
    if (!claim) {
      await this.collectOne();
      return false;
    }
    try {
      const url = resolveFaviconProviderUrl(this.options.providerTemplate, claim.hostname);
      if (!url) throw new Error('invalid shared favicon provider template');
      const image = await this.fetcher({ ...this.options.fetch, url });
      const fetchExpiry = await this.options.fetchCacheExpiry?.(url);
      const refreshAt = new Date(Math.max(Date.now() + 1000,
        fetchExpiry?.getTime() ?? Date.now() + this.nextRefreshDelay(claim.hostname)));
      const digest = createHash('sha256').update(image.body).digest('hex');
      const existing = claim.object_id ? await this.pool.query<{ digest: string }>(
        'SELECT digest FROM favicon_shared_objects WHERE object_id=$1', [claim.object_id],
      ) : null;
      let objectId = claim.object_id;
      const oldStored = objectId && existing?.rows[0]?.digest === digest ? await this.store.get(objectId) : null;
      if (!oldStored || createHash('sha256').update(oldStored.body).digest('hex') !== digest) {
        objectId = randomUUID();
        // Ledger before PUT, including uploads orphaned by a crash or a lost lease.
        await this.pool.query(`
          INSERT INTO favicon_shared_objects(object_id, hostname, digest, deletable_at)
          VALUES ($1,$2,$3,clock_timestamp() + $4 * interval '1 second')
        `, [objectId, claim.hostname, digest, this.options.retentionSeconds]);
        await this.store.put(objectId, image.body, image.mime);
      }
      // Extend retention BEFORE publishing the replacement. A crash cannot
      // lose the object before asynchronous GC has a durable record; public
      // object reads still revalidate the current binding.
      if (claim.object_id && claim.object_id !== objectId) {
        await this.pool.query(`UPDATE favicon_shared_objects SET deletable_at=greatest(deletable_at,
          clock_timestamp() + $2 * interval '1 second') WHERE object_id=$1`,
        [claim.object_id, this.options.retentionSeconds]);
      }
      await this.pool.query(`
        UPDATE favicon_shared_domains SET object_id=$3, failures=0, lease_owner=NULL, lease_until=NULL,
          updated_at=clock_timestamp(), next_refresh_at=$4
        WHERE hostname=$1 AND lease_owner=$2 AND lease_until > clock_timestamp()
      `, [claim.hostname, owner, objectId, refreshAt]);
    } catch (error) {
      const deferred = error instanceof FaviconFetchDeferred;
      const retryAt = deferred ? error.retryAt : new Date(Date.now() + Math.min(86_400_000, 60_000 * 2 ** Math.min(claim.failures, 11)));
      await this.pool.query(`
        UPDATE favicon_shared_domains SET lease_owner=NULL, lease_until=NULL,
          next_refresh_at=$3, failures=least(failures+$4, 1000000)
        WHERE hostname=$1 AND lease_owner=$2
      `, [claim.hostname, owner, retryAt, deferred ? 0 : 1]);
      if (!deferred) throw error;
    }
    return true;
  }

  private nextRefreshDelay(hostname: string): number {
    // Stable ±10% jitter; a restart never bunches every domain onto midnight.
    const fraction = createHash('sha256').update(hostname).digest().readUInt32BE(0) / 0xffffffff;
    return Math.round(this.options.refreshIntervalMs * (0.9 + fraction * 0.2));
  }

  private async collectOne(): Promise<void> {
    const result = await this.pool.query<{ object_id: string }>(`
      SELECT o.object_id FROM favicon_shared_objects o
      WHERE o.deletable_at <= clock_timestamp()
        AND NOT EXISTS (SELECT 1 FROM favicon_shared_domains d WHERE d.object_id=o.object_id)
      ORDER BY o.deletable_at LIMIT 1
    `);
    const objectId = result.rows[0]?.object_id;
    if (!objectId) return;
    await this.store.delete(objectId);
    await this.pool.query('DELETE FROM favicon_shared_objects WHERE object_id=$1', [objectId]);
  }
}
