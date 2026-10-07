import { sql } from 'kysely';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import type { DigestEditionTable } from '../database/reports-tables.js';
import { digestEditionHidePublicExistsSql } from '../governance/collection-control-sql.js';
import { communityEditionDiscoverySql } from '../community/community-target-shared-postgres.js';
import type { DigestEdition, ReportEditionPageAfter } from '../../modules/reports/index.js';

const MAX_REPORT_BATCH_ROWS = 100_001;

export function mapDigestEditionRow(row: DigestEditionTable): DigestEdition {
  return Object.freeze({
    id: row.id,
    seriesId: row.series_id,
    sourceCollectionId: row.source_collection_id,
    issueKey: row.issue_key,
    editionOrdinal: Number(row.edition_ordinal),
    titleSnapshot: row.title_snapshot,
    summarySnapshot: row.summary_snapshot,
    sourceContentRevision: row.source_content_revision,
    sourcePolicyRevision: row.source_policy_revision,
    resourceRevision: row.resource_revision,
    periodStart: row.period_start ? new Date(row.period_start).toISOString() : null,
    periodEnd: row.period_end ? new Date(row.period_end).toISOString() : null,
    state: row.state,
    publishedAt: row.published_at ? new Date(row.published_at).toISOString() : null,
  });
}

function assertEditionPageLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 2_001) {
    throw new RangeError('report edition page limit is out of range');
  }
}

export async function listPublishedEditions(
  tx: DatabaseTransaction,
  seriesId: string,
  limit: number,
  after?: ReportEditionPageAfter,
  discovery = false,
): Promise<readonly DigestEdition[]> {
  assertEditionPageLimit(limit);
  const publishedAt = sql<Date>`date_trunc('milliseconds', digest_editions.published_at)`;
  let query = tx.selectFrom('digest_editions').selectAll()
    .where('series_id', '=', seriesId).where('state', '=', 'published').where('published_at', 'is not', null);
  if (discovery) {
    // Hide stays in the page so the issue list can tombstone it. Delist-only
    // fails the shared discovery predicate and is omitted here.
    query = query.where(sql<boolean>`(
      ${sql.raw(communityEditionDiscoverySql('digest_editions.id', 'digest_editions.series_id'))}
      or ${sql.raw(digestEditionHidePublicExistsSql('digest_editions.id', 'digest_editions.series_id'))}
    )`);
  }
  if (after) {
    const afterPublishedAt = new Date(after.publishedAt);
    query = query.where((eb) => eb.or([
      eb(publishedAt, '<', afterPublishedAt),
      eb.and([eb(publishedAt, '=', afterPublishedAt),
        eb('edition_ordinal', '<', BigInt(after.editionOrdinal))]),
      eb.and([eb(publishedAt, '=', afterPublishedAt),
        eb('edition_ordinal', '=', BigInt(after.editionOrdinal)), eb('id', '>', after.id)]),
    ]));
  }
  const rows = await query.orderBy(publishedAt, 'desc').orderBy('edition_ordinal', 'desc')
    .orderBy('id', 'asc').limit(limit).execute();
  return rows.map(mapDigestEditionRow);
}

export async function listPublishedEditionsBySeries(
  tx: DatabaseTransaction,
  seriesIds: readonly string[],
  limitPerSeries: number,
  discovery = false,
): Promise<ReadonlyMap<string, readonly DigestEdition[]>> {
  const ids = [...new Set(seriesIds)];
  if (ids.length === 0) return new Map();
  assertEditionPageLimit(limitPerSeries);
  const placeholders = sql.join(ids.map((id) => sql`${id}`), sql`, `);
  const discoverySql = discovery
    ? sql`AND ${sql.raw(communityEditionDiscoverySql('e.id', 'e.series_id'))}`
    : sql``;
  const rows = await sql<DigestEditionTable>`
    SELECT id, series_id, source_collection_id, issue_key, edition_ordinal,
           title_snapshot, summary_snapshot, source_content_revision,
           source_policy_revision, resource_revision, period_start, period_end,
           state, published_at, created_at, updated_at, withdrawn_at, detached_at
      FROM (
        SELECT e.*, row_number() OVER (
          PARTITION BY e.series_id
          ORDER BY date_trunc('milliseconds', e.published_at) DESC, e.edition_ordinal DESC, e.id ASC
        ) AS report_row_number
          FROM digest_editions e
         WHERE e.series_id IN (${placeholders}) AND e.state = 'published' AND e.published_at IS NOT NULL
           ${discoverySql}
      ) ranked
     WHERE report_row_number <= ${limitPerSeries}
     ORDER BY series_id ASC, date_trunc('milliseconds', published_at) DESC, edition_ordinal DESC, id ASC
     LIMIT ${MAX_REPORT_BATCH_ROWS}
  `.execute(tx);
  const grouped = new Map<string, DigestEdition[]>();
  for (const row of rows.rows) {
    const values = grouped.get(row.series_id) ?? [];
    values.push(mapDigestEditionRow(row));
    grouped.set(row.series_id, values);
  }
  return grouped;
}

export async function publicProjectionRevision(tx: DatabaseTransaction, seriesId: string): Promise<string> {
  const row = await sql<{ revision: string }>`
    SELECT md5(jsonb_build_object(
      'editions', COALESCE((
        SELECT jsonb_agg(jsonb_build_array(
          e.id, e.resource_revision, date_trunc('milliseconds', e.published_at), e.edition_ordinal,
          c.id, c.visibility, date_trunc('milliseconds', c.published_at), c.publication_slug,
          c.root_node_id, c.root_node_is_root, c.allow_search_indexing,
          c.content_revision, c.policy_revision, date_trunc('milliseconds', c.updated_at), c.deleted_at,
          source_accounts.status, source_accounts.deleted_at,
          EXISTS (SELECT 1 FROM seed_rows sr WHERE sr.table_name = 'collections' AND sr.pk->>0 = c.id)
        ) ORDER BY e.id)
          FROM digest_editions e
          JOIN collections c ON c.id = e.source_collection_id
          LEFT JOIN accounts source_accounts ON source_accounts.subject_id = c.owner_subject_id
         WHERE e.series_id = ${seriesId} AND e.state = 'published' AND e.published_at IS NOT NULL
      ), '[]'::jsonb),
      'controls', COALESCE((
        SELECT jsonb_agg(jsonb_build_array(ma.id, ma.target_kind, ma.target_id, ma.parent_id, ma.action, ma.revision)
          ORDER BY ma.id)
          FROM moderation_actions ma
         WHERE ma.state = 'active' AND ma.action IN ('delist', 'hide_public') AND (
           (ma.target_kind = 'digest_series' AND ma.target_id = ${seriesId})
           OR (ma.target_kind = 'digest_edition' AND ma.parent_id = ${seriesId}
             AND EXISTS (SELECT 1 FROM digest_editions e WHERE e.id = ma.target_id
               AND e.series_id = ${seriesId} AND e.state = 'published'))
           OR (ma.target_kind = 'collection' AND EXISTS (
             SELECT 1 FROM digest_editions e WHERE e.series_id = ${seriesId}
               AND e.state = 'published' AND e.source_collection_id = ma.target_id
           ))
         )
      ), '[]'::jsonb)
    )::text) AS revision
  `.execute(tx);
  return row.rows[0]?.revision ?? 'd41d8cd98f00b204e9800998ecf8427e';
}
