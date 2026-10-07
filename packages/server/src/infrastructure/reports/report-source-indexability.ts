import { sql } from 'kysely';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import { collectionHidePublicExistsSql } from '../governance/collection-control-sql.js';

/** Aggregate every published source independently of the displayed issue page. */
export async function publishedSourcesIndexableBySeriesIds(
  tx: DatabaseTransaction,
  seriesIds: readonly string[],
): Promise<ReadonlyMap<string, boolean>> {
  if (seriesIds.length === 0) return new Map();
  const result = await sql<{ series_id: string; indexable: boolean }>`
    SELECT e.series_id, bool_and(COALESCE(
      c.visibility = 'public' AND c.published_at IS NOT NULL
      AND c.publication_slug IS NOT NULL AND c.root_node_id IS NOT NULL AND c.root_node_is_root
      AND c.allow_search_indexing AND c.deleted_at IS NULL
      AND a.status = 'active' AND a.deleted_at IS NULL
      AND NOT ${sql.raw(collectionHidePublicExistsSql('c.id'))}
      AND NOT EXISTS (SELECT 1 FROM seed_rows sr
        WHERE sr.table_name = 'collections' AND sr.pk->>0 = c.id), false)) AS indexable
    FROM digest_editions e
    LEFT JOIN collections c ON c.id = e.source_collection_id
    LEFT JOIN accounts a ON a.subject_id = c.owner_subject_id
    WHERE e.series_id = ANY(${[...new Set(seriesIds)]}::text[])
      AND e.state = 'published' AND e.published_at IS NOT NULL
    GROUP BY e.series_id
  `.execute(tx);
  return new Map(result.rows.map((row) => [row.series_id, row.indexable]));
}
