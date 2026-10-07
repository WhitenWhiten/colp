import { fenceOutboxLease } from '../outbox/lease-fence.js';
import { OutboxDeliveryError, type OutboxHandlerContext } from '../outbox/router.js';
import { writeStreamedCommunitySnapshot } from './community-ranking-stream-postgres.js';
import { CompiledQuery, sql, type Kysely } from 'kysely';
import {
  COMMUNITY_STATIC_GENERATION,
  type CommunityRankedEntry,
  type CommunityRankingQueryPorts,
  type CommunityRankingRefreshPorts,
  type CommunityRankingSnapshot,
  type CommunityRankCandidate,
  type CommunityRankedWriteEntry,
  type CommunityTarget,
} from '../../modules/community/index.js';
import { databaseNow } from '../database/time.js';
import type { DatabaseSchema } from '../database/runtime.js';
import {
  createUnitOfWork,
  type DatabaseTransaction,
} from '../database/unit-of-work.js';
import {
  COMMUNITY_BOOKMARK_DISCOVERY_SQL,
  COMMUNITY_COLLECTION_DISCOVERY_SQL,
  COMMUNITY_EDITION_DISCOVERY_SQL,
  COMMUNITY_EDITION_SOURCE_VISIBLE_SQL,
  COMMUNITY_OWNER_PUBLICATION_SQL,
  COMMUNITY_SERIES_DISCOVERY_SQL,
  resolveCommunityTargetRow,
} from './community-target-shared-postgres.js';
import { resolveCommunityTargetRows } from './community-target-batch-postgres.js';
import { buildPublicationTargetAncestorRestrictionSql } from '../publication/target-access-facts.js';

/**
 * CS-02 PostgreSQL ports for community hot ranking.
 *
 * - The query unit of work pages durable `hot-v1` snapshots and re-proves
 *   each candidate's current visibility through the shared resolve row
 *   (same eligibility predicate as CS-01).
 * - The refresh unit of work rebuilds a whole snapshot from the retained
 *   `community_votes`/`community_vote_targets` authority and prunes expired
 *   snapshots — the projection never reads historical outbox payloads.
 */

export interface PostgresCommunityRankingQueryUnitOfWork {
  execute<Result>(
    work: (ports: CommunityRankingQueryPorts) => Promise<Result>,
    options?: { readonly signal?: AbortSignal },
  ): Promise<Result>;
}

export function createPostgresCommunityRankingQueryUnitOfWork(
  db: Kysely<DatabaseSchema>,
  cancelBackend?: (backendPid: number) => Promise<boolean>,
): PostgresCommunityRankingQueryUnitOfWork {
  return Object.freeze<PostgresCommunityRankingQueryUnitOfWork>({
    execute<Result>(
      work: (ports: CommunityRankingQueryPorts) => Promise<Result>,
      execution: { readonly signal?: AbortSignal } = {},
    ): Promise<Result> {
      return createUnitOfWork(db, { isolationLevel: 'read committed', signal: execution.signal,
        cancelBackend })
        .execute(({ transaction }) => work(createQueryPorts(transaction)));
    },
  });
}

export interface CommunityRankingAttemptExecution {
  readonly signal: AbortSignal;
  readonly attempt: NonNullable<OutboxHandlerContext['attempt']>;
}

export interface PostgresCommunityRankingRefreshUnitOfWork {
  /** Worker execution always requires a durable outbox attempt. */
  executeAttempt<Result>(
    work: (ports: CommunityRankingRefreshPorts) => Promise<Result>,
    execution: CommunityRankingAttemptExecution,
  ): Promise<Result>;
  /** Explicit operator/seed rebuild, independent of outbox delivery. */
  execute<Result>(
    work: (ports: CommunityRankingRefreshPorts) => Promise<Result>,
    options?: { readonly signal?: AbortSignal },
  ): Promise<Result>;
}

export function createPostgresCommunityRankingRefreshUnitOfWork(
  db: Kysely<DatabaseSchema>,
  cancelBackend?: (backendPid: number) => Promise<boolean>,
): PostgresCommunityRankingRefreshUnitOfWork {
  return Object.freeze<PostgresCommunityRankingRefreshUnitOfWork>({
    executeAttempt<Result>(
      work: (ports: CommunityRankingRefreshPorts) => Promise<Result>,
      execution: CommunityRankingAttemptExecution,
    ): Promise<Result> {
      return createUnitOfWork(db, { isolationLevel: 'read committed', signal: execution.signal,
        cancelBackend }).execute(async ({ transaction }) => {
          const result = await work(createRefreshPorts(transaction));
          const owned = await fenceOutboxLease(
            (statement, parameters) => transaction.executeQuery<{ owned?: boolean }>(CompiledQuery.raw(statement, parameters)),
            execution.attempt, execution.signal);
          if (!owned) throw new OutboxDeliveryError('retryable', 'community rank refresh attempt lease was lost');
          return result;
        });
    },
    execute<Result>(
      work: (ports: CommunityRankingRefreshPorts) => Promise<Result>,
      execution: { readonly signal?: AbortSignal } = {},
    ): Promise<Result> {
      return createUnitOfWork(db, { isolationLevel: 'read committed', signal: execution.signal,
        cancelBackend })
        .execute(({ transaction }) => work(createRefreshPorts(transaction)));
    },
  });
}

/**
 * Rows per `community_rank_entries` INSERT statement. PostgreSQL rejects a
 * single statement carrying more than 65_535 bind parameters and each
 * entry binds 15 columns, so an unchunked multi-row insert fails once a
 * snapshot grows past ~4.3k targets — every refresh after that would
 * abort and leave the served snapshot stale. 1_000 rows keeps each
 * statement far below the cap.
 */
const RANK_ENTRY_INSERT_BATCH = 1_000;

interface SnapshotRow {
  readonly snapshot_id: string;
  readonly score_version: string;
  readonly item_count: number;
  readonly created_at: Date;
}

function toSnapshot(row: SnapshotRow): CommunityRankingSnapshot {
  return Object.freeze<CommunityRankingSnapshot>({
    snapshotId: row.snapshot_id,
    scoreVersion: row.score_version,
    createdAt: row.created_at,
    itemCount: row.item_count,
  });
}

const SNAPSHOT_SELECT = sql`
  select snapshot_id::text, score_version, item_count, created_at
  from community_rank_snapshots
`;

interface EntryRow {
  readonly position: number;
  readonly target_kind: 'collection' | 'bookmark' | 'digest_series' | 'digest_edition';
  readonly target_id: string;
  readonly target_collection_id: string | null;
  readonly target_series_id: string | null;
  readonly target_generation: string;
  readonly title: string;
  readonly href: string;
  readonly tags: unknown;
  readonly language: string | null;
  readonly up: number;
  readonly down: number;
  readonly first_vote_at: Date | null;
  readonly hot: number;
}

function entryTarget(row: EntryRow): CommunityTarget {
  switch (row.target_kind) {
    case 'bookmark':
      return {
        kind: 'bookmark', id: row.target_id,
        collectionId: row.target_collection_id!, seriesId: null,
        generation: row.target_generation,
      };
    case 'digest_edition':
      return {
        kind: 'digest_edition', id: row.target_id,
        collectionId: null, seriesId: row.target_series_id!,
        generation: COMMUNITY_STATIC_GENERATION,
      };
    case 'digest_series':
      return {
        kind: 'digest_series', id: row.target_id,
        collectionId: null, seriesId: null,
        generation: COMMUNITY_STATIC_GENERATION,
      };
    default:
      return {
        kind: 'collection', id: row.target_id,
        collectionId: null, seriesId: null,
        generation: COMMUNITY_STATIC_GENERATION,
      };
  }
}

function normalizeTags(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return Object.freeze([]);
  const tags: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const normalized = item.trim().normalize('NFC');
    if (normalized.length < 1 || normalized.length > 64) continue;
    if (!tags.includes(normalized)) tags.push(normalized);
  }
  return Object.freeze(tags);
}

function toEntry(row: EntryRow): CommunityRankedEntry {
  return Object.freeze<CommunityRankedEntry>({
    position: row.position,
    target: entryTarget(row),
    title: row.title,
    href: row.href,
    tags: normalizeTags(row.tags),
    language: row.language,
    up: row.up,
    down: row.down,
    firstVoteAt: row.first_vote_at,
    hot: row.hot,
  });
}

function createQueryPorts(transaction: DatabaseTransaction): CommunityRankingQueryPorts {
  return Object.freeze<CommunityRankingQueryPorts>({
    rankings: {
      async latestSnapshot() {
        const result = await sql<SnapshotRow>`
          ${SNAPSHOT_SELECT} order by snapshot_id desc limit 1
        `.execute(transaction);
        const row = result.rows[0];
        return row === undefined ? null : toSnapshot(row);
      },
      async findSnapshot(snapshotId) {
        const result = await sql<SnapshotRow>`
          ${SNAPSHOT_SELECT} where snapshot_id = ${BigInt(snapshotId)} limit 1
        `.execute(transaction);
        const row = result.rows[0];
        return row === undefined ? null : toSnapshot(row);
      },
      async scanEntries(snapshotId, afterPosition, limit) {
        const result = await sql<EntryRow>`
          select position, target_kind, target_id, target_collection_id, target_series_id,
            target_generation, title, href, tags, language, up, down, first_vote_at, hot
          from community_rank_entries
          where snapshot_id = ${BigInt(snapshotId)}
            and position > ${afterPosition}
          order by position asc
          limit ${limit}
        `.execute(transaction);
        return result.rows.map(toEntry);
      },
    },
    targets: {
      resolve: (query) => resolveCommunityTargetRow(transaction, query, 'none', 'discovery'),
      // The ranking scan re-proves a whole page of candidates at once. Without
      // this the application falls back to one `resolve` statement per
      // candidate — up to MAX_SCAN_ENTRIES round trips inside the page's
      // transaction. The surface MUST stay `discovery`: `direct` would resolve
      // delisted targets that the scan's own eligibility predicate excludes.
      resolveMany: (queries) => resolveCommunityTargetRows(transaction, queries, 'discovery'),
    },
    clock: {
      now: () => databaseNow(transaction),
    },
  });
}

/**
 * Eligible candidates: the same per-kind eligibility predicate the shared
 * CS-01 resolve query applies (live + strictly public + parent consistency
 * + active owner account + bookmark generation row + ancestor-restriction
 * concealment; digest_edition additionally re-proves the source collection
 * through COMMUNITY_EDITION_SOURCE_VISIBLE_SQL), plus the non-null
 * projection guards the entry contract needs — `title`/`href` must be
 * non-null, so collections/series/editions require their slug and
 * bookmarks require a title. Joined to current-generation vote counts and
 * the first-accepted-vote instant. Tags/language follow the
 * publication-directory convention (payload_json extensions first, root
 * fallback); digests carry neither.
 *
 * Scaling boundary — the bookmark branch embeds
 * `buildPublicationTargetAncestorRestrictionSql('n')`: a correlated
 * `exists(with recursive …)` ancestor walk evaluated PER ROW (~0.05ms per
 * bookmark measured). That is the fastest formulation tested at current
 * volume, but at million-scale bookmark counts the per-row walk approaches
 * the refresh cadence. The redesign path is a temporary-table BFS —
 * materialize the restricted-ancestor set once per rebuild inside the
 * refresh transaction (measured ~79ms floor, amortizing with depth) and
 * anti-join candidates against it — NOT a single-statement recursive CTE
 * over the whole candidate set, which measured strictly worse.
 */
const ELIGIBLE_CANDIDATES_SQL = sql<CandidateRow>`
  with eligible as (
    select 'collection'::text as target_kind, c.id as target_id,
      null::text as target_collection_id, null::text as target_series_id,
      ${COMMUNITY_STATIC_GENERATION}::text as target_generation,
      c.title, '/c/' || c.publication_slug as href,
      coalesce(
        case when jsonb_typeof(c.payload_json->'extensions'->'tags') = 'array'
          then c.payload_json->'extensions'->'tags' end,
        case when jsonb_typeof(c.payload_json->'tags') = 'array'
          then c.payload_json->'tags' end,
        '[]'::jsonb) as tags,
      coalesce(
        nullif(c.payload_json->'extensions'->>'language', ''),
        nullif(c.payload_json->>'language', '')) as language
    from collections c
    join accounts oa on oa.subject_id = c.owner_subject_id
    where c.deleted_at is null
      and c.visibility = 'public'
      and c.publication_slug is not null
      and c.published_at is not null
      and oa.status = 'active'
      and oa.deleted_at is null
      and ${COMMUNITY_COLLECTION_DISCOVERY_SQL}
      and ${COMMUNITY_OWNER_PUBLICATION_SQL}
    union all
    select 'bookmark'::text, n.id, n.collection_id, null::text,
      g.generation,
      n.title, '/r/' || n.id || '?slug=' || c.publication_slug,
      coalesce(
        case when jsonb_typeof(n.payload_json->'extensions'->'tags') = 'array'
          then n.payload_json->'extensions'->'tags' end,
        case when jsonb_typeof(n.payload_json->'tags') = 'array'
          then n.payload_json->'tags' end,
        '[]'::jsonb),
      coalesce(
        nullif(n.payload_json->'extensions'->>'language', ''),
        nullif(n.payload_json->>'language', ''))
    from nodes n
    join collections c on c.id = n.collection_id
    join community_bookmark_generations g
      on g.collection_id = n.collection_id and g.node_id = n.id
    join accounts oa on oa.subject_id = c.owner_subject_id
    where n.kind = 'bookmark'
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
      and ${COMMUNITY_COLLECTION_DISCOVERY_SQL}
      and ${COMMUNITY_BOOKMARK_DISCOVERY_SQL}
      and ${COMMUNITY_OWNER_PUBLICATION_SQL}
    union all
    select 'digest_series'::text, s.id, null::text, null::text,
      ${COMMUNITY_STATIC_GENERATION}::text,
      s.title, '/reports/' || s.slug, '[]'::jsonb, null::text
    from digest_series s
    join accounts oa on oa.subject_id = s.owner_subject_id
    where s.deleted_at is null
      and s.state = 'active'
      and s.visibility = 'public'
      and s.slug is not null
      and oa.status = 'active'
      and oa.deleted_at is null
      and ${COMMUNITY_SERIES_DISCOVERY_SQL}
      and ${COMMUNITY_OWNER_PUBLICATION_SQL}
    union all
    select 'digest_edition'::text, e.id, null::text, e.series_id,
      ${COMMUNITY_STATIC_GENERATION}::text,
      e.title_snapshot, '/reports/' || s.slug || '/issues/' || e.id,
      '[]'::jsonb, null::text
    from digest_editions e
    join digest_series s on s.id = e.series_id
    join collections sc on sc.id = e.source_collection_id
    join accounts sa on sa.subject_id = sc.owner_subject_id
    join accounts oa on oa.subject_id = s.owner_subject_id
    where e.state = 'published'
      and s.deleted_at is null
      and s.state = 'active'
      and s.visibility = 'public'
      and s.slug is not null
      and oa.status = 'active'
      and oa.deleted_at is null
      and ${COMMUNITY_EDITION_SOURCE_VISIBLE_SQL}
      and ${COMMUNITY_SERIES_DISCOVERY_SQL}
      and ${COMMUNITY_EDITION_DISCOVERY_SQL}
      and ${COMMUNITY_OWNER_PUBLICATION_SQL}
  )
  select e.target_kind, e.target_id, e.target_collection_id, e.target_series_id,
    e.target_generation, e.title, e.href, e.tags, e.language,
    coalesce(v.up, 0)::integer as up,
    coalesce(v.down, 0)::integer as down,
    fvt.first_vote_at
  from eligible e
  left join lateral (
    select count(*) filter (where value = 1) as up,
      count(*) filter (where value = -1) as down
    from community_votes v
    where v.target_kind = e.target_kind
      and v.target_id = e.target_id
      and v.target_generation = e.target_generation
  ) v on true
  left join community_vote_targets fvt
    on fvt.target_kind = e.target_kind
    and fvt.target_id = e.target_id
    and fvt.target_generation = e.target_generation
`;

interface CandidateRow {
  readonly target_kind: 'collection' | 'bookmark' | 'digest_series' | 'digest_edition';
  readonly target_id: string;
  readonly target_collection_id: string | null;
  readonly target_series_id: string | null;
  readonly target_generation: string;
  readonly title: string;
  readonly href: string;
  readonly tags: unknown;
  readonly language: string | null;
  readonly up: number;
  readonly down: number;
  readonly first_vote_at: Date | null;
}

function canonicalLanguageOrNull(value: string | null): string | null {
  if (value === null) return null;
  try {
    return Intl.getCanonicalLocales(value)[0] ?? null;
  } catch {
    return null;
  }
}

function candidateTarget(row: CandidateRow): CommunityTarget {
  return entryTarget(row as EntryRow);
}

function toCandidate(row: CandidateRow): CommunityRankCandidate {
  return Object.freeze<CommunityRankCandidate>({
    target: candidateTarget(row),
    title: row.title,
    href: row.href,
    tags: normalizeTags(row.tags),
    language: canonicalLanguageOrNull(row.language),
    up: row.up,
    down: row.down,
    firstVoteAt: row.first_vote_at,
  });
}

function createRefreshPorts(transaction: DatabaseTransaction): CommunityRankingRefreshPorts {
  return Object.freeze<CommunityRankingRefreshPorts>({
    sources: {
      async listCandidates() {
        const result = await ELIGIBLE_CANDIDATES_SQL.execute(transaction);
        return (result.rows as CandidateRow[]).map(toCandidate);
      },
    },
    snapshots: {
      writeFromCandidates: input => writeStreamedCommunitySnapshot(transaction, ELIGIBLE_CANDIDATES_SQL, toCandidate, input),
      async writeSnapshot(input) {
        const inserted = await sql<{ snapshot_id: string }>`
          insert into community_rank_snapshots (score_version, item_count, created_at)
          values (${input.scoreVersion}, ${input.entries.length}, ${input.createdAt})
          returning snapshot_id::text
        `.execute(transaction);
        const snapshotId = inserted.rows[0]?.snapshot_id;
        if (typeof snapshotId !== 'string' || snapshotId.length < 1) {
          throw new TypeError('community rank snapshot insert returned no id');
        }
        const id = BigInt(snapshotId);
        for (let offset = 0; offset < input.entries.length; offset += RANK_ENTRY_INSERT_BATCH) {
          await transaction
            .insertInto('community_rank_entries')
            .values(input.entries.slice(offset, offset + RANK_ENTRY_INSERT_BATCH).map((entry) => ({
              snapshot_id: id,
              position: entry.position,
              target_kind: entry.target.kind,
              target_id: entry.target.id,
              target_collection_id: entry.target.collectionId,
              target_series_id: entry.target.seriesId,
              target_generation: entry.target.generation,
              title: entry.title,
              href: entry.href,
              tags: sql`${JSON.stringify([...entry.tags])}::jsonb`,
              language: entry.language,
              up: entry.up,
              down: entry.down,
              first_vote_at: entry.firstVoteAt,
              hot: entry.hot,
            })))
            .execute();
        }
        return snapshotId;
      },
      async pruneSnapshots(input) {
        let removed = 0;
        for (;;) {
          const result = await sql<{ snapshot_id: string }>`
            delete from community_rank_snapshots where snapshot_id in (
              select snapshot_id from community_rank_snapshots
              where created_at < ${input.createdBefore}
                and snapshot_id < (select max(snapshot_id) from community_rank_snapshots)
              order by snapshot_id limit 32
            ) returning snapshot_id::text
          `.execute(transaction);
          removed += result.rows.length;
          if (result.rows.length < 32) return removed;
        }
      },
    },
    clock: {
      now: () => databaseNow(transaction),
    },
  });
}
