import type { DatabaseRuntime } from '../database/index.js';
import { readBackendPid, withPostgresAbort } from '../database/index.js';

/**
 * Seed-registered collections are demo fixtures, never search-indexable.
 *
 * `seed_rows` is the seed runner's own registry of every row it injected
 * (or adopted); it is the same authority the runner uses to withdraw rows, so
 * a collection is "seed data" iff it is registered there. Public seed
 * collections stay visible on the site (Explore, /c, profiles) but are kept
 * out of both sitemaps and carry `noindex` on their injected documents, so a
 * showcase deployment never asks search engines to index test data.
 *
 * SQL fragment for statements that alias `collections` as `c`.
 */
export const SEED_COLLECTION_EXCLUSION_SQL =
  "not exists (select 1 from seed_rows sr where sr.table_name = 'collections' and sr.pk->>0 = c.id)";

export interface SearchIndexingExclusionReadPort {
  /** Subset of `collectionIds` that must not be search-indexed. */
  excludedCollectionIds(
    collectionIds: readonly string[],
    signal?: AbortSignal,
  ): Promise<ReadonlySet<string>>;
}

interface ExclusionRow {
  collection_id: string;
}

const STATEMENT = "select distinct sr.pk->>0 as collection_id from seed_rows sr where sr.table_name = 'collections' and sr.pk->>0 = any($1::text[])";

export function createPostgresSearchIndexingExclusionReadPort(
  runtime: Pick<DatabaseRuntime, 'pool' | 'cancelBackend'>,
): SearchIndexingExclusionReadPort {
  return Object.freeze({
    async excludedCollectionIds(collectionIds: readonly string[], signal?: AbortSignal) {
      const ids: string[] = [...new Set(collectionIds.filter((id) => typeof id === 'string' && id.length > 0))];
      if (ids.length === 0) return new Set<string>();
      const rows = signal === undefined
        ? (await runtime.pool.query<ExclusionRow>(STATEMENT, [ids])).rows
        : await queryWithAbort(runtime, ids, signal);
      return new Set(rows.map((row) => row.collection_id));
    },
  });
}

async function queryWithAbort(
  runtime: Pick<DatabaseRuntime, 'pool' | 'cancelBackend'>,
  ids: readonly string[],
  signal: AbortSignal,
): Promise<readonly ExclusionRow[]> {
  const client = await runtime.pool.connect();
  try {
    const pid = await readBackendPid(client, signal);
    const cancel = async (): Promise<void> => {
      if (pid !== undefined) await runtime.cancelBackend(pid);
    };
    const result = await withPostgresAbort(client.query<ExclusionRow>(STATEMENT, [ids]), signal, cancel);
    return result.rows;
  } finally {
    client.release();
  }
}
