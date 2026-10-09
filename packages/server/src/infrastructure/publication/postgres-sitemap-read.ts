import type { DatabaseRuntime } from '../database/index.js';
import { readBackendPid, withPostgresAbort } from '../database/index.js';
import {
  COLLECTIONS_SITEMAP_MAX_URLS,
  isSearchIndexableVisibility,
  SEARCH_INDEXABLE_VISIBILITY,
} from '../http/index.js';
import {
  accountRestrictPublicationExistsSql,
  COLLECTION_DISCOVERY_CONTROL_SQL,
  COLLECTION_OWNER_LIVE_SQL,
} from '../database/collection-control-sql.js';
import { SEED_COLLECTION_EXCLUSION_SQL } from './postgres-search-indexing-exclusion.js';

export interface PublicationSitemapRecord {
  readonly publicationSlug: string;
  readonly updatedAt: string;
  readonly visibility: typeof SEARCH_INDEXABLE_VISIBILITY;
}

export interface PublicationSitemapReadPort {
  listIndexable(signal?: AbortSignal): Promise<readonly PublicationSitemapRecord[]>;
}

interface SitemapRow {
  publication_slug: string;
  updated_at: Date;
  visibility: string;
}

/**
 * Same anonymous-directory public predicates as `buildPublicationDirectoryStatement`
 * (`deleted_at`, `publication_slug`, `published_at`, `visibility = 'public'`),
 * plus the seed-data exclusion (`SEED_COLLECTION_EXCLUSION_SQL`).
 * `visibility` uses `SEARCH_INDEXABLE_VISIBILITY` / `isSearchIndexableVisibility`.
 */
export function buildPublicationSitemapStatement(): {
  readonly text: string;
  readonly values: readonly unknown[];
} {
  return Object.freeze({
    text: `select c.publication_slug, c.updated_at, c.visibility
             from collections c
            where c.deleted_at is null
              and c.publication_slug is not null
              and c.published_at is not null
              and c.visibility = $1
              and ${COLLECTION_OWNER_LIVE_SQL}
              and c.allow_search_indexing
              and ${SEED_COLLECTION_EXCLUSION_SQL}
              and ${COLLECTION_DISCOVERY_CONTROL_SQL}
              and not exists (
                select 1 from accounts owner_account
                 where owner_account.subject_id = c.owner_subject_id
                   and ${accountRestrictPublicationExistsSql('owner_account.id')}
              )
            order by c.updated_at desc, c.id collate "C" asc
            limit $2`,
    values: Object.freeze([SEARCH_INDEXABLE_VISIBILITY, COLLECTIONS_SITEMAP_MAX_URLS]),
  });
}

export function createPostgresPublicationSitemapReadPort(
  runtime: Pick<DatabaseRuntime, 'pool' | 'cancelBackend'>,
): PublicationSitemapReadPort {
  return Object.freeze({
    async listIndexable(signal?: AbortSignal) {
      const statement = buildPublicationSitemapStatement();
      const rows = signal === undefined
        ? (await runtime.pool.query<SitemapRow>(statement.text, [...statement.values])).rows
        : await listWithAbort(runtime, statement, signal);
      return Object.freeze(rows.flatMap((row) => {
        if (!isSearchIndexableVisibility(row.visibility)) return [];
        if (typeof row.publication_slug !== 'string' || row.publication_slug.length === 0) {
          throw new Error('Publication sitemap slug is invalid');
        }
        return [{
          publicationSlug: row.publication_slug,
          updatedAt: row.updated_at.toISOString(),
          visibility: SEARCH_INDEXABLE_VISIBILITY,
        }];
      }));
    },
  });
}

async function listWithAbort(
  runtime: Pick<DatabaseRuntime, 'pool' | 'cancelBackend'>,
  statement: { readonly text: string; readonly values: readonly unknown[] },
  signal: AbortSignal,
): Promise<readonly SitemapRow[]> {
  const client = await runtime.pool.connect();
  try {
    const pid = await readBackendPid(client, signal);
    const cancel = async (): Promise<void> => {
      if (pid !== undefined) await runtime.cancelBackend(pid);
    };
    const result = await withPostgresAbort(
      client.query<SitemapRow>(statement.text, [...statement.values]),
      signal,
      cancel,
    );
    return result.rows;
  } finally {
    client.release();
  }
}
