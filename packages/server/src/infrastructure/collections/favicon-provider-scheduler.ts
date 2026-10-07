import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import {
  FaviconFetchDeferred,
  FaviconProviderThrottled,
  faviconRetryAfterMs,
  type FaviconFetcher,
} from '../../modules/collections/index.js';

/** Database-wide admission, shared by warming, batch and individual refreshes. */
export function createScheduledFaviconFetcher(pool: Pool, fetcher: FaviconFetcher, intervalMs = 10_000): FaviconFetcher {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1000) throw new RangeError('invalid favicon provider interval');
  return async (input) => {
    const provider = new URL(input.url).origin;
    const owner = randomUUID();
    await pool.query('INSERT INTO favicon_provider_admission(provider) VALUES ($1) ON CONFLICT DO NOTHING', [provider]);
    const admitted = await pool.query(`
      UPDATE favicon_provider_admission SET lease_owner=$2,
        lease_until=clock_timestamp() + $3 * interval '1 millisecond',
        next_request_at=clock_timestamp() + $4 * interval '1 millisecond'
      WHERE provider=$1 AND next_request_at <= clock_timestamp()
        AND (lease_until IS NULL OR lease_until <= clock_timestamp()) RETURNING provider
    `, [provider, owner, input.timeoutMs + 5000, intervalMs]);
    if (admitted.rowCount === 0) {
      const state = await pool.query<{ retry_at: Date }>(`
        SELECT greatest(next_request_at, coalesce(lease_until, next_request_at)) AS retry_at
        FROM favicon_provider_admission WHERE provider=$1
      `, [provider]);
      throw new FaviconFetchDeferred(state.rows[0]!.retry_at);
    }
    let throttled = false;
    try {
      return await fetcher(input);
    } catch (error) {
      if (!(error instanceof FaviconProviderThrottled)) throw error;
      throttled = true;
      const delay = faviconRetryAfterMs(error.retryAfter, Date.now());
      const state = await pool.query<{ retry_at: Date }>(`
        UPDATE favicon_provider_admission SET throttles=least(throttles+1, 16),
          next_request_at=greatest(next_request_at, clock_timestamp() +
            greatest($3::double precision, $4::double precision,
              least(3600000, 60000 * power(2, least(throttles, 6)))) * interval '1 millisecond'),
          lease_owner=NULL, lease_until=NULL
        WHERE provider=$1 AND lease_owner=$2 RETURNING next_request_at AS retry_at
      `, [provider, owner, delay ?? 0, intervalMs]);
      throw new FaviconFetchDeferred(state.rows[0]?.retry_at ?? new Date(Date.now() + Math.max(delay ?? 0, 60_000)));
    } finally {
      if (!throttled) await pool.query(`
        UPDATE favicon_provider_admission SET lease_owner=NULL, lease_until=NULL, throttles=0,
          next_request_at=greatest(next_request_at, clock_timestamp() + $3 * interval '1 millisecond')
        WHERE provider=$1 AND lease_owner=$2
      `, [provider, owner, intervalMs]);
    }
  };
}
