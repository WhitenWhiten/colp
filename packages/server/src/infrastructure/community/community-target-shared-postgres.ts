import { sql } from 'kysely';
import {
  COMMUNITY_STATIC_GENERATION,
  type CommunityTargetIdentity,
  type CommunityTargetQuery,
  type ResolvedCommunityTarget,
} from '../../modules/community/index.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import {
  accountRestrictInteractionExistsSql,
  accountRestrictPublicationExistsSql,
  bookmarkDiscoveryExistsSql,
  bookmarkHidePublicExistsSql,
  collectionHidePublicExistsSql,
} from '../governance/collection-control-sql.js';
import { buildPublicationTargetAncestorRestrictionSql } from '../publication/target-access-facts.js';

/** Direct community resolve: hide_public conceals the same way as non-public. */
export const COMMUNITY_COLLECTION_HIDE_SQL = sql.raw(`not ${collectionHidePublicExistsSql('c.id')}`);
export const COMMUNITY_BOOKMARK_HIDE_SQL = sql.raw(`not ${bookmarkHidePublicExistsSql('n.id', 'c.id')}`);
export const COMMUNITY_OWNER_PUBLICATION_SQL = sql.raw(
  `not ${accountRestrictPublicationExistsSql('oa.id')}`,
);
export const COMMUNITY_SERIES_HIDE_SQL = sql.raw(`not exists (
  select 1 from moderation_actions ma
   where ma.target_kind = 'digest_series'
     and ma.target_id = s.id
     and ma.state = 'active'
     and ma.action = 'hide_public'
)`);
function editionModerationAbsentSql(
  editionIdSql: string,
  seriesIdSql: string,
  actionsSql: string,
): string {
  return `not exists (
  select 1 from moderation_actions ma
   where ma.target_kind = 'digest_edition'
     and ma.target_id = ${editionIdSql}
     and ma.parent_id = ${seriesIdSql}
     and ma.state = 'active'
     and ma.action in (${actionsSql})
)`;
}

/** Direct resolve: hide_public conceals the edition the same way as non-public. */
export const COMMUNITY_EDITION_HIDE_SQL = sql.raw(
  editionModerationAbsentSql('e.id', 's.id', `'hide_public'`),
);

/**
 * Discovery (hot-ranking candidates, discovery re-reads, public report
 * listing). Delist and hide_public both drop the edition. Callers that
 * tombstone hide_public keep that row with an explicit hide exists OR.
 */
export function communityEditionDiscoverySql(editionIdSql = 'e.id', seriesIdSql = 's.id'): string {
  return editionModerationAbsentSql(editionIdSql, seriesIdSql, `'delist', 'hide_public'`);
}

export const COMMUNITY_EDITION_DISCOVERY_SQL = sql.raw(communityEditionDiscoverySql());
export const COMMUNITY_SOURCE_COLLECTION_HIDE_SQL = sql.raw(
  `not ${collectionHidePublicExistsSql('sc.id')}`,
);

/** Ranking is a discovery surface: delist and hide_public both drop the row. */
export const COMMUNITY_COLLECTION_DISCOVERY_SQL = sql.raw(`not exists (
  select 1 from moderation_actions ma
   where ma.target_kind = 'collection'
     and ma.target_id = c.id
     and ma.state = 'active'
     and ma.action in ('delist', 'hide_public')
)`);
export const COMMUNITY_BOOKMARK_DISCOVERY_SQL = sql.raw(
  `not ${bookmarkDiscoveryExistsSql('n.id', 'c.id')}`,
);
export const COMMUNITY_SERIES_DISCOVERY_SQL = sql.raw(`not exists (
  select 1 from moderation_actions ma
   where ma.target_kind = 'digest_series'
     and ma.target_id = s.id
     and ma.state = 'active'
     and ma.action in ('delist', 'hide_public')
)`);

/**
 * Shared eligible-target resolution for CS-01. Every branch re-proves the
 * full eligibility predicate (live + strictly public + parent consistency +
 * bookmark generation row present + live digest-edition source), so a
 * concealed target returns zero rows — no distinction between "missing"
 * and "not public" leaks. The bookmark branch additionally applies the
 * publication target-access ancestor restriction: a private, protected,
 * deleted, dangling, or cyclic ancestor folder conceals the bookmark even
 * while the bookmark itself stays `inherit` inside a public collection.
 * Every branch also inner-joins `accounts` on the target's resolved owner
 * subject (series owner for digest targets), so a disabled or deleted
 * owner account conceals the target — the same gate the reports/social
 * read paths apply; the digest_edition branch keeps its separate
 * source-owner check through COMMUNITY_EDITION_SOURCE_VISIBLE_SQL.
 *
 * `lock` adds FOR UPDATE on the target's own authority row (the collection,
 * node, series, or edition row — not the joined parents). Vote
 * reconciliation serializes on that lock; a read-only FOR UPDATE row lock
 * never moves canonical resource/content revisions.
 */
export type CommunityTargetSurface = 'direct' | 'discovery';

export async function resolveCommunityTargetRow(
  transaction: DatabaseTransaction,
  query: CommunityTargetQuery,
  lock: 'none' | 'forUpdate',
  surface: CommunityTargetSurface = 'direct',
): Promise<ResolvedCommunityTarget | null> {
  const row = await selectTargetRow(transaction, query, lock === 'forUpdate', surface);
  if (!row) return null;
  return toResolvedCommunityTargetRow(row);
}

/**
 * The live-source predicate shared by digest_edition target resolution and
 * the CS-02 ranking candidate query — the SQL twin of the report
 * projection's `isVisibleReportSource` plus the live-root re-proof the
 * publication feed applies: the source collection is live, strictly
 * public, published (published_at + publication_slug both set), rooted
 * (root_node_id present, flagged root, and the root node row itself
 * exists and is not deleted), and owned by an active account. Both
 * queries must join `collections sc` on the edition's
 * source_collection_id and `accounts sa` on `sa.subject_id =
 * sc.owner_subject_id`; the inner join itself drops editions whose source
 * owner row is missing.
 */
export const COMMUNITY_EDITION_SOURCE_VISIBLE_SQL = sql`
  sc.deleted_at is null
  and sc.visibility = 'public'
  and sc.published_at is not null
  and sc.publication_slug is not null
  and sc.root_node_id is not null
  and sc.root_node_is_root
  and exists (
    select 1 from nodes source_root
    where source_root.collection_id = sc.id
      and source_root.id = sc.root_node_id
      and source_root.is_root
      and source_root.deleted_at is null
  )
  and sa.status = 'active'
  and sa.deleted_at is null
  and ${COMMUNITY_SOURCE_COLLECTION_HIDE_SQL}
`;

export interface TargetRow {
  readonly kind: string;
  readonly id: string;
  readonly collection_id: string | null;
  readonly series_id: string | null;
  readonly generation: string;
  readonly owner_subject_id: string;
  readonly title: string;
  readonly href: string;
}

async function selectTargetRow(
  transaction: DatabaseTransaction,
  query: CommunityTargetQuery,
  lock: boolean,
  surface: CommunityTargetSurface,
): Promise<TargetRow | undefined> {
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
  switch (query.kind) {
    case 'collection': {
      const result = await sql<TargetRow>`
        select 'collection' as kind, c.id, null::text as collection_id, null::text as series_id,
          ${COMMUNITY_STATIC_GENERATION}::text as generation,
          c.owner_subject_id, c.title, '/c/' || c.publication_slug as href
        from collections c
        join accounts oa on oa.subject_id = c.owner_subject_id
        where c.id = ${query.id}
          and c.deleted_at is null
          and c.visibility = 'public'
          and c.publication_slug is not null
          and c.published_at is not null
          and oa.status = 'active'
          and oa.deleted_at is null
          and ${collectionControl}
          and ${COMMUNITY_OWNER_PUBLICATION_SQL}
        ${lock ? sql`for update of c` : sql``}
      `.execute(transaction);
      return result.rows[0];
    }
    case 'bookmark': {
      const result = await sql<TargetRow>`
        select 'bookmark' as kind, n.id, n.collection_id, null::text as series_id,
          g.generation, c.owner_subject_id, n.title,
          '/r/' || n.id || '?slug=' || c.publication_slug as href
        from nodes n
        join collections c on c.id = n.collection_id
        join community_bookmark_generations g
          on g.collection_id = n.collection_id and g.node_id = n.id
        join accounts oa on oa.subject_id = c.owner_subject_id
        where n.collection_id = ${query.collectionId}
          and n.id = ${query.id}
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
        ${lock ? sql`for update of n` : sql``}
      `.execute(transaction);
      return result.rows[0];
    }
    case 'digest_series': {
      const result = await sql<TargetRow>`
        select 'digest_series' as kind, s.id, null::text as collection_id, null::text as series_id,
          ${COMMUNITY_STATIC_GENERATION}::text as generation,
          s.owner_subject_id, s.title, '/reports/' || s.slug as href
        from digest_series s
        join accounts oa on oa.subject_id = s.owner_subject_id
        where s.id = ${query.id}
          and s.deleted_at is null
          and s.state = 'active'
          and s.visibility = 'public'
          and s.slug is not null
          and oa.status = 'active'
          and oa.deleted_at is null
          and ${seriesControl}
          and ${COMMUNITY_OWNER_PUBLICATION_SQL}
        ${lock ? sql`for update of s` : sql``}
      `.execute(transaction);
      return result.rows[0];
    }
    case 'digest_edition': {
      // COMMUNITY_EDITION_SOURCE_VISIBLE_SQL re-proves the source
      // collection's live public state — a privatized, withdrawn, unrooted,
      // deleted, or owner-deactivated source conceals the already-published
      // edition. (`e.state = 'published'` already implies a non-null
      // published_at via digest_editions_published_state_check.)
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
        where e.id = ${query.id}
          and e.series_id = ${query.seriesId}
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
        ${lock ? sql`for update of e` : sql``}
      `.execute(transaction);
      return result.rows[0];
    }
  }
}

export function toResolvedCommunityTargetRow(row: TargetRow): ResolvedCommunityTarget {
  const target = buildTarget(row);
  return Object.freeze<ResolvedCommunityTarget>({
    target,
    ownerSubjectId: row.owner_subject_id,
    title: row.title,
    href: row.href,
  });
}

function buildTarget(row: TargetRow): ResolvedCommunityTarget['target'] {
  switch (row.kind) {
    case 'bookmark':
      return {
        kind: 'bookmark',
        id: row.id,
        collectionId: row.collection_id!,
        seriesId: null,
        generation: row.generation,
      };
    case 'digest_edition':
      return {
        kind: 'digest_edition',
        id: row.id,
        collectionId: null,
        seriesId: row.series_id!,
        generation: COMMUNITY_STATIC_GENERATION,
      };
    case 'digest_series':
      return {
        kind: 'digest_series',
        id: row.id,
        collectionId: null,
        seriesId: null,
        generation: COMMUNITY_STATIC_GENERATION,
      };
    default:
      return {
        kind: 'collection',
        id: row.id,
        collectionId: null,
        seriesId: null,
        generation: COMMUNITY_STATIC_GENERATION,
      };
  }
}

/** Vote counts + the viewer's own vote against the CURRENT generation. */
export async function readCommunityVoteCounts(
  transaction: DatabaseTransaction,
  identity: CommunityTargetIdentity,
  generation: string,
  viewerAccountId: string | null,
): Promise<{ readonly up: number; readonly down: number; readonly myVote: -1 | 0 | 1 | null }> {
  const counts = await sql<{ value: number; n: string }>`
    select value, count(*)::text as n
    from community_votes
    where target_kind = ${identity.kind}
      and target_id = ${identity.id}
      and target_generation = ${generation}
    group by value
  `.execute(transaction);
  let up = 0;
  let down = 0;
  for (const row of counts.rows) {
    if (row.value === 1) up = Number(row.n);
    else if (row.value === -1) down = Number(row.n);
  }
  let myVote: -1 | 0 | 1 | null = null;
  if (viewerAccountId !== null) {
    const own = await sql<{ value: number }>`
      select value from community_votes
      where account_id = ${viewerAccountId}
        and target_kind = ${identity.kind}
        and target_id = ${identity.id}
        and target_generation = ${generation}
    `.execute(transaction);
    myVote = own.rows[0] === undefined ? 0 : (own.rows[0].value === 1 ? 1 : -1);
  }
  return Object.freeze({ up, down, myVote });
}

/**
 * CS-04: stable creation stamp of a target's authority row — the
 * `updatedAt` of the virtual (never-written) comment settings
 * representation and a stable fallback timestamp for audit projections.
 */
export async function loadCommunityTargetCreatedAt(
  transaction: DatabaseTransaction,
  identity: CommunityTargetIdentity,
): Promise<Date | null> {
  switch (identity.kind) {
    case 'collection': {
      const result = await sql<{ created_at: Date }>`
        select created_at from collections where id = ${identity.id}
      `.execute(transaction);
      return result.rows[0]?.created_at ?? null;
    }
    case 'bookmark': {
      const result = await sql<{ created_at: Date }>`
        select created_at from nodes where id = ${identity.id}
      `.execute(transaction);
      return result.rows[0]?.created_at ?? null;
    }
    case 'digest_series': {
      const result = await sql<{ created_at: Date }>`
        select created_at from digest_series where id = ${identity.id}
      `.execute(transaction);
      return result.rows[0]?.created_at ?? null;
    }
    case 'digest_edition': {
      const result = await sql<{ created_at: Date }>`
        select created_at from digest_editions where id = ${identity.id}
      `.execute(transaction);
      return result.rows[0]?.created_at ?? null;
    }
  }
}

/**
 * The CS-04 curator predicate: the target owner OR an active owner/editor
 * member of the governing collection/series. Bookmark and digest_edition
 * targets delegate to their parent collection/series identity.
 */
export async function communityTargetCurator(
  transaction: DatabaseTransaction,
  identity: CommunityTargetIdentity,
  subjectId: string,
): Promise<boolean> {
  switch (identity.kind) {
    case 'collection':
      return collectionCurator(transaction, identity.id, subjectId);
    case 'bookmark':
      return identity.collectionId === null
        ? false
        : collectionCurator(transaction, identity.collectionId, subjectId);
    case 'digest_series':
      return seriesCurator(transaction, identity.id, subjectId);
    case 'digest_edition':
      return identity.seriesId === null
        ? false
        : seriesCurator(transaction, identity.seriesId, subjectId);
  }
}

async function collectionCurator(
  transaction: DatabaseTransaction,
  collectionId: string,
  subjectId: string,
): Promise<boolean> {
  const result = await sql<{ ok: boolean }>`
    select exists(
      select 1 from collections c
      where c.id = ${collectionId}
        and c.owner_subject_id = ${subjectId}
    ) or exists(
      select 1 from collection_members m
      where m.collection_id = ${collectionId}
        and m.subject_id = ${subjectId}
        and m.role in ('owner', 'editor')
    ) as ok
  `.execute(transaction);
  return result.rows[0]?.ok === true;
}

/**
 * Vote and new-comment writes lock the actor. Official restrict_interaction
 * conceals the account the same way as inactive/deleted — no distinct error.
 */
export async function lockActiveCommunityAccount(
  transaction: DatabaseTransaction,
  accountId: string,
): Promise<{ readonly subjectId: string } | null> {
  const result = await sql<{ subject_id: string }>`
    select account.subject_id
    from accounts account
    where account.id = ${accountId}
      and account.status = 'active'
      and account.deleted_at is null
      and not ${sql.raw(accountRestrictInteractionExistsSql('account.id'))}
    for share of account
  `.execute(transaction);
  const row = result.rows[0];
  return row === undefined ? null : Object.freeze({ subjectId: row.subject_id });
}

async function seriesCurator(
  transaction: DatabaseTransaction,
  seriesId: string,
  subjectId: string,
): Promise<boolean> {
  const result = await sql<{ ok: boolean }>`
    select exists(
      select 1 from digest_series s
      where s.id = ${seriesId}
        and s.owner_subject_id = ${subjectId}
    ) or exists(
      select 1 from digest_members m
      where m.series_id = ${seriesId}
        and m.subject_id = ${subjectId}
        and m.role in ('owner', 'editor')
        and m.revoked_at is null
    ) as ok
  `.execute(transaction);
  return result.rows[0]?.ok === true;
}
