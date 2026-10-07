import { sql } from 'kysely';
import type { CommunityTargetQuery, ResolvedCommunityTarget } from '../../modules/community/index.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import { buildPublicationTargetAncestorRestrictionSql } from '../publication/target-access-facts.js';
import {
  COMMUNITY_BOOKMARK_DISCOVERY_SQL,
  COMMUNITY_BOOKMARK_HIDE_SQL,
  COMMUNITY_COLLECTION_DISCOVERY_SQL,
  COMMUNITY_COLLECTION_HIDE_SQL,
  COMMUNITY_EDITION_DISCOVERY_SQL,
  COMMUNITY_EDITION_HIDE_SQL,
  COMMUNITY_EDITION_SOURCE_VISIBLE_SQL,
  COMMUNITY_OWNER_PUBLICATION_SQL,
  COMMUNITY_SERIES_DISCOVERY_SQL,
  COMMUNITY_SERIES_HIDE_SQL,
  toResolvedCommunityTargetRow,
  type CommunityTargetSurface,
  type TargetRow,
} from './community-target-shared-postgres.js';
import { COMMUNITY_STATIC_GENERATION } from '../../modules/community/index.js';

/**
 * Resolve many targets in one statement per kind.
 *
 * `resolveTargetRow` issues one statement per target, so a ranking page
 * that re-proves the visibility of up to `MAX_SCAN_ENTRIES` candidates cost one
 * round trip each, all inside the same transaction. The predicate and the
 * projected columns are identical to the single-row path — only `id = $1`
 * becomes `id = any($1)`, and the composite keys pair up in the caller.
 *
 * The result is positionally aligned with `queries`: `null` where the target is
 * concealed, deleted, privatized or otherwise not resolvable.
 */
export async function resolveCommunityTargetRows(
  transaction: DatabaseTransaction,
  queries: readonly CommunityTargetQuery[],
  surface: CommunityTargetSurface = 'direct',
): Promise<readonly (ResolvedCommunityTarget | null)[]> {
  if (queries.length === 0) return Object.freeze([]);
  const collectionControl = surface === 'discovery'
    ? COMMUNITY_COLLECTION_DISCOVERY_SQL
    : COMMUNITY_COLLECTION_HIDE_SQL;
  const bookmarkControl = surface === 'discovery'
    ? COMMUNITY_BOOKMARK_DISCOVERY_SQL
    : COMMUNITY_BOOKMARK_HIDE_SQL;
  const seriesControl = surface === 'discovery'
    ? COMMUNITY_SERIES_DISCOVERY_SQL
    : COMMUNITY_SERIES_HIDE_SQL;
  const editionControl = surface === 'discovery'
    ? COMMUNITY_EDITION_DISCOVERY_SQL
    : COMMUNITY_EDITION_HIDE_SQL;

  const collections = queries.filter((query) => query.kind === 'collection').map((query) => query.id);
  const bookmarks = queries.filter((query) => query.kind === 'bookmark');
  const series = queries.filter((query) => query.kind === 'digest_series').map((query) => query.id);
  const editions = queries.filter((query) => query.kind === 'digest_edition');

  const rows: TargetRow[] = [];
  if (collections.length > 0) {
    const result = await sql<TargetRow>`
      select 'collection' as kind, c.id, null::text as collection_id, null::text as series_id,
        ${COMMUNITY_STATIC_GENERATION}::text as generation,
        c.owner_subject_id, c.title, '/c/' || c.publication_slug as href
      from collections c
      join accounts oa on oa.subject_id = c.owner_subject_id
      where c.id = any(${collections}::text[])
        and c.deleted_at is null
        and c.visibility = 'public'
        and c.publication_slug is not null
        and c.published_at is not null
        and oa.status = 'active'
        and oa.deleted_at is null
        and ${collectionControl}
        and ${COMMUNITY_OWNER_PUBLICATION_SQL}
    `.execute(transaction);
    rows.push(...result.rows);
  }
  if (bookmarks.length > 0) {
    const ids = bookmarks.map((query) => query.id);
    const collectionIds = bookmarks.map((query) => query.collectionId ?? '');
    const result = await sql<TargetRow>`
      select 'bookmark' as kind, n.id, n.collection_id, null::text as series_id,
        g.generation, c.owner_subject_id, n.title,
        '/r/' || n.id || '?slug=' || c.publication_slug as href
      from nodes n
      join collections c on c.id = n.collection_id
      join community_bookmark_generations g
        on g.collection_id = n.collection_id and g.node_id = n.id
      join accounts oa on oa.subject_id = c.owner_subject_id
      where n.id = any(${ids}::text[])
        and n.collection_id = any(${collectionIds}::text[])
        and n.kind = 'bookmark'
        and n.deleted_at is null
        and n.visibility = 'inherit'
        and n.title is not null
        and c.deleted_at is null
        and c.visibility = 'public'
        and c.publication_slug is not null
        and c.published_at is not null
        and not ${sql.raw(buildPublicationTargetAncestorRestrictionSql('n'))}
        and oa.status = 'active'
        and oa.deleted_at is null
        and ${collectionControl}
        and ${bookmarkControl}
        and ${COMMUNITY_OWNER_PUBLICATION_SQL}
    `.execute(transaction);
    rows.push(...result.rows);
  }
  if (series.length > 0) {
    const result = await sql<TargetRow>`
      select 'digest_series' as kind, s.id, null::text as collection_id, null::text as series_id,
        ${COMMUNITY_STATIC_GENERATION}::text as generation,
        s.owner_subject_id, s.title, '/reports/' || s.slug as href
      from digest_series s
      join accounts oa on oa.subject_id = s.owner_subject_id
      where s.id = any(${series}::text[])
        and s.deleted_at is null
        and s.state = 'active'
        and s.visibility = 'public'
        and s.slug is not null
        and oa.status = 'active'
        and oa.deleted_at is null
        and ${seriesControl}
        and ${COMMUNITY_OWNER_PUBLICATION_SQL}
    `.execute(transaction);
    rows.push(...result.rows);
  }
  if (editions.length > 0) {
    const ids = editions.map((query) => query.id);
    const seriesIds = editions.map((query) => query.seriesId ?? '');
    const result = await sql<TargetRow>`
      select 'digest_edition' as kind, e.id, null::text as collection_id, e.series_id,
        ${COMMUNITY_STATIC_GENERATION}::text as generation,
        s.owner_subject_id, e.title_snapshot as title,
        '/reports/' || s.slug || '/issues/' || e.id as href
      from digest_editions e
      join digest_series s on s.id = e.series_id
      join collections sc on sc.id = e.source_collection_id
      join accounts sa on sa.subject_id = sc.owner_subject_id
      join accounts oa on oa.subject_id = s.owner_subject_id
      where e.id = any(${ids}::text[])
        and e.series_id = any(${seriesIds}::text[])
        and e.state = 'published'
        and s.deleted_at is null
        and s.state = 'active'
        and s.visibility = 'public'
        and s.slug is not null
        and oa.status = 'active'
        and oa.deleted_at is null
        and ${COMMUNITY_EDITION_SOURCE_VISIBLE_SQL}
        and ${seriesControl}
        and ${editionControl}
        and ${COMMUNITY_OWNER_PUBLICATION_SQL}
    `.execute(transaction);
    rows.push(...result.rows);
  }

  // Pair once by full identity: an unread backlog is not bounded by page size.
  // JSON tuple keys keep separators inside opaque IDs unambiguous.
  const byIdentity = new Map(rows.map((row) => [
    targetKey(row.kind, row.id, row.kind === 'bookmark' ? row.collection_id
      : row.kind === 'digest_edition' ? row.series_id : null), row,
  ]));
  return Object.freeze(queries.map((query) => {
    const row = byIdentity.get(targetKey(query.kind, query.id,
      query.kind === 'bookmark' ? query.collectionId
        : query.kind === 'digest_edition' ? query.seriesId : null));
    return row === undefined ? null : toResolvedCommunityTargetRow(row);
  }));
}

function targetKey(kind: string, id: string, parentId: string | null | undefined): string {
  return JSON.stringify([kind, id, parentId ?? null]);
}
