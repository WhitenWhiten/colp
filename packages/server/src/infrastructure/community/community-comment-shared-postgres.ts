import { sql, type RawBuilder } from 'kysely';
import {
  type CommunityCommentCurationRecord,
  type CommunityCommentKeysetPosition,
  type CommunityCommentLiveAuthor,
  type CommunityCommentRecord,
  type CommunityCommentSettingsRecord,
  type CommunityCommentState,
  type CommunityTargetIdentity,
  type CommunityTargetKind,
} from '../../modules/community/index.js';
import { isValidAvatarUrl } from '../../modules/identity/index.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import { loadCommunityTargetCreatedAt } from './community-target-shared-postgres.js';

/**
 * CS-03 shared PostgreSQL helpers for community_comments: row mapping,
 * single-row loads (optional FOR UPDATE), keyset scans in the two
 * contract-fixed orderings, reply-count aggregation, and the public-author
 * projection. Every list scan is bound to the target's CURRENT generation;
 * rows written against a superseded generation are simply never selected.
 *
 * CS-04 adds the curation overlay join (`curation_hidden` on every record),
 * the author CAS update, the curation/settings row helpers, the curator
 * membership predicate, and the per-target comment-area settings reads.
 */

interface CommentRow {
  readonly comment_id: string;
  readonly target_kind: CommunityTargetKind;
  readonly target_id: string;
  readonly target_collection_id: string | null;
  readonly target_series_id: string | null;
  readonly target_generation: string;
  readonly root_id: string;
  readonly reply_to_id: string | null;
  readonly depth: number;
  readonly author_account_id: string;
  readonly body: string | null;
  readonly state: CommunityCommentState;
  readonly curation_hidden: boolean;
  readonly revision: string;
  readonly created_at: Date;
  readonly updated_at: Date;
}

const COMMENT_SELECT = sql`
  select c.comment_id, c.target_kind, c.target_id, c.target_collection_id, c.target_series_id,
    c.target_generation, c.root_id, c.reply_to_id, c.depth, c.author_account_id,
    c.body, c.state, (
      coalesce(cur.hidden, false)
      or exists (
        select 1 from moderation_actions ma
         where ma.target_kind = 'comment'
           and ma.target_id = c.comment_id
           and ma.state = 'active'
           and ma.action = 'hide_comment'
      )
    ) as curation_hidden,
    c.revision::text, c.created_at, c.updated_at
  from community_comments c
  left join community_comment_curations cur on cur.comment_id = c.comment_id
`;

function toRecord(row: CommentRow): CommunityCommentRecord {
  return Object.freeze<CommunityCommentRecord>({
    id: row.comment_id,
    target: Object.freeze({
      kind: row.target_kind,
      id: row.target_id,
      collectionId: row.target_collection_id,
      seriesId: row.target_series_id,
    }),
    targetGeneration: row.target_generation,
    rootId: row.root_id,
    replyToId: row.reply_to_id,
    depth: row.depth,
    authorAccountId: row.author_account_id,
    body: row.body,
    state: row.state,
    curationHidden: row.curation_hidden,
    revision: BigInt(row.revision),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

/** Point load by primary key; `forUpdate` serializes reply validation and CS-04 writes. */
export async function loadCommunityCommentRecord(
  transaction: DatabaseTransaction,
  commentId: string,
  lock: 'none' | 'forUpdate',
): Promise<CommunityCommentRecord | null> {
  const result = await sql<CommentRow>`
    ${COMMENT_SELECT}
    where c.comment_id = ${commentId}
    ${lock === 'forUpdate' ? sql`for update of c` : sql``}
  `.execute(transaction);
  const row = result.rows[0];
  return row === undefined ? null : toRecord(row);
}

/**
 * CS-05: batch load by primary key for the notification inbox/read paths —
 * rows whose ids are missing simply produce no map entry.
 */
export async function loadCommunityCommentRecords(
  transaction: DatabaseTransaction,
  commentIds: readonly string[],
): Promise<ReadonlyMap<string, CommunityCommentRecord>> {
  const records = new Map<string, CommunityCommentRecord>();
  const unique = [...new Set(commentIds)];
  if (unique.length === 0) return records;
  const result = await sql<CommentRow>`
    ${COMMENT_SELECT}
    where c.comment_id = any(${unique}::text[])
  `.execute(transaction);
  for (const row of result.rows) records.set(row.comment_id, toRecord(row));
  return records;
}

/**
 * CS-04 author CAS update: edit (`state:'visible'` + new body) or soft
 * deletion (`state:'deleted'` + `body:null`). The expected revision fence
 * makes the compare-and-swap atomic; the row is normally already held FOR
 * UPDATE by the command, so a miss means the caller compared a stale
 * projection. Returns the fresh record or null on the revision miss.
 */
export async function updateCommunityCommentRecord(
  transaction: DatabaseTransaction,
  commentId: string,
  expectedRevision: bigint,
  write: { readonly body: string | null; readonly state: 'visible' | 'deleted' },
  updatedAt: Date,
): Promise<CommunityCommentRecord | null> {
  const result = await sql<CommentRow>`
    update community_comments c
    set body = ${write.body},
      state = ${write.state},
      revision = c.revision + 1,
      updated_at = ${updatedAt}
    where c.comment_id = ${commentId}
      and c.revision = ${expectedRevision}
    returning c.comment_id, c.target_kind, c.target_id, c.target_collection_id, c.target_series_id,
      c.target_generation, c.root_id, c.reply_to_id, c.depth, c.author_account_id,
      c.body, c.state,
      (select coalesce(cur.hidden, false) from community_comment_curations cur
        where cur.comment_id = c.comment_id) as curation_hidden,
      c.revision::text, c.created_at, c.updated_at
  `.execute(transaction);
  const row = result.rows[0];
  return row === undefined ? null : toRecord(row);
}

/**
 * Exact keyset boundary timestamp for `after`. The opaque cursor only
 * carries `pos.t` at millisecond precision (RFC3339 `toISOString`) while
 * `created_at` is a microsecond `timestamptz`: comparing against the
 * truncated value would re-emit the boundary row on ASC scans (its stored
 * micros exceed the truncated millis) and could skip unconsumed rows on
 * DESC scans. `after.id` — the signed `pos.i` — re-reads the boundary
 * row's exact stored `created_at`; the carried position is the fallback
 * should that row ever vanish.
 */
function keysetBoundaryStamp(after: CommunityCommentKeysetPosition): RawBuilder<unknown> {
  return sql`coalesce(
    (select b.created_at from community_comments b where b.comment_id = ${after.id}),
    ${after.createdAt})`;
}

/**
 * Root rows of one target generation in `createdAt DESC, id ASC` keyset
 * order. `after` continues strictly past the last emitted row.
 */
export async function scanCommunityCommentRoots(
  transaction: DatabaseTransaction,
  identity: CommunityTargetIdentity,
  generation: string,
  after: CommunityCommentKeysetPosition | null,
  limit: number,
): Promise<readonly CommunityCommentRecord[]> {
  const result = await sql<CommentRow>`
    ${COMMENT_SELECT}
    where c.target_kind = ${identity.kind}
      and c.target_id = ${identity.id}
      and c.target_generation = ${generation}
      and c.depth = 0
      ${after === null ? sql`` : sql`
        and (c.created_at < ${keysetBoundaryStamp(after)}
          or (c.created_at = ${keysetBoundaryStamp(after)} and c.comment_id > ${after.id}))`}
    order by c.created_at desc, c.comment_id asc
    limit ${limit}
  `.execute(transaction);
  return result.rows.map(toRecord);
}

/**
 * All descendants of one root in `createdAt ASC, id ASC` keyset order —
 * the flattened replies page. Depth > 0 keeps the root itself out.
 */
export async function scanCommunityCommentDescendants(
  transaction: DatabaseTransaction,
  rootId: string,
  after: CommunityCommentKeysetPosition | null,
  limit: number,
): Promise<readonly CommunityCommentRecord[]> {
  const result = await sql<CommentRow>`
    ${COMMENT_SELECT}
    where c.root_id = ${rootId}
      and c.depth > 0
      ${after === null ? sql`` : sql`
        and (c.created_at > ${keysetBoundaryStamp(after)}
          or (c.created_at = ${keysetBoundaryStamp(after)} and c.comment_id > ${after.id}))`}
    order by c.created_at asc, c.comment_id asc
    limit ${limit}
  `.execute(transaction);
  return result.rows.map(toRecord);
}

/**
 * Per root id: visible descendants count (depth > 0) — the root replyCount.
 * Curator-hidden replies are not visible and do not count.
 */
export async function countCommunityVisibleThreadReplies(
  transaction: DatabaseTransaction,
  rootIds: readonly string[],
): Promise<ReadonlyMap<string, number>> {
  const counts = new Map<string, number>();
  const unique = [...new Set(rootIds)];
  if (unique.length === 0) return counts;
  const result = await sql<{ root_id: string; n: string }>`
    select c.root_id, count(*)::text as n
    from community_comments c
    left join community_comment_curations cur on cur.comment_id = c.comment_id
    where c.root_id = any(${unique}::text[])
      and c.depth > 0
      and c.state = 'visible'
      and coalesce(cur.hidden, false) = false
    group by c.root_id
  `.execute(transaction);
  for (const row of result.rows) counts.set(row.root_id, Number(row.n));
  return counts;
}

/**
 * Per comment id: visible direct children — a reply's own replyCount.
 * Curator-hidden children are not visible and do not count.
 */
export async function countCommunityVisibleDirectReplies(
  transaction: DatabaseTransaction,
  commentIds: readonly string[],
): Promise<ReadonlyMap<string, number>> {
  const counts = new Map<string, number>();
  const unique = [...new Set(commentIds)];
  if (unique.length === 0) return counts;
  const result = await sql<{ reply_to_id: string; n: string }>`
    select c.reply_to_id, count(*)::text as n
    from community_comments c
    left join community_comment_curations cur on cur.comment_id = c.comment_id
    where c.reply_to_id = any(${unique}::text[])
      and c.state = 'visible'
      and coalesce(cur.hidden, false) = false
    group by c.reply_to_id
  `.execute(transaction);
  for (const row of result.rows) counts.set(row.reply_to_id, Number(row.n));
  return counts;
}

interface AuthorRow {
  readonly account_id: string;
  readonly handle: string | null;
  readonly display_name: string | null;
  readonly avatar_url: string | null;
}

/**
 * Live public-author facts for the given author account ids. Only active,
 * non-deleted accounts with a profile row appear; every missing id maps to
 * the former-member tombstone at the application layer. The handle is the
 * account's canonical (lowest) handle; avatar URLs are re-sanitized through
 * the shared safe-avatar predicate so a stored violation degrades to null.
 */
export async function loadCommunityCommentAuthors(
  transaction: DatabaseTransaction,
  accountIds: readonly string[],
): Promise<ReadonlyMap<string, CommunityCommentLiveAuthor>> {
  const authors = new Map<string, CommunityCommentLiveAuthor>();
  const unique = [...new Set(accountIds)];
  if (unique.length === 0) return authors;
  const result = await sql<AuthorRow>`
    select distinct on (a.id) a.id as account_id,
      lower(h.handle) as handle,
      p.display_name,
      p.avatar_url
    from accounts a
    join profiles p on p.account_id = a.id
    left join profile_handles h on h.account_id = a.id
    where a.id = any(${unique}::text[])
      and a.status = 'active'
      and a.deleted_at is null
    order by a.id, lower(h.handle) asc nulls last
  `.execute(transaction);
  for (const row of result.rows) {
    authors.set(row.account_id, Object.freeze<CommunityCommentLiveAuthor>({
      handle: row.handle,
      displayName: typeof row.display_name === 'string' ? row.display_name : '',
      avatarUrl: typeof row.avatar_url === 'string' && isValidAvatarUrl(row.avatar_url)
        ? row.avatar_url
        : null,
    }));
  }
  return authors;
}

/* ------------------------------------------------------------------ */
/* CS-04: curation overlay, comment-area settings, curator authority.    */
/* ------------------------------------------------------------------ */

interface CurationRow {
  readonly comment_id: string;
  readonly hidden: boolean;
  readonly reason: string;
  readonly revision: string;
  readonly updated_by_account_id: string;
  readonly updated_at: Date;
}

function toCurationRecord(row: CurationRow): CommunityCommentCurationRecord {
  return Object.freeze<CommunityCommentCurationRecord>({
    commentId: row.comment_id,
    hidden: row.hidden,
    reason: row.reason,
    revision: BigInt(row.revision),
    updatedByAccountId: row.updated_by_account_id,
    updatedAt: row.updated_at,
  });
}

/** Point load of the curation overlay for one comment; `forUpdate` serializes CAS writes. */
export async function loadCommunityCommentCuration(
  transaction: DatabaseTransaction,
  commentId: string,
  lock: 'none' | 'forUpdate',
): Promise<CommunityCommentCurationRecord | null> {
  const result = await sql<CurationRow>`
    select comment_id, hidden, reason, revision::text, updated_by_account_id, updated_at
    from community_comment_curations
    where comment_id = ${commentId}
    ${lock === 'forUpdate' ? sql`for update` : sql``}
  `.execute(transaction);
  const row = result.rows[0];
  return row === undefined ? null : toCurationRecord(row);
}

/**
 * Insert-or-update the singleton curation row. The caller computes the new
 * revision (existing + 1, or 2 for the first write — the virtual default is
 * '1'); the parent comment row is held FOR UPDATE by the command so
 * concurrent curators serialize.
 */
export async function upsertCommunityCommentCuration(
  transaction: DatabaseTransaction,
  record: CommunityCommentCurationRecord,
): Promise<CommunityCommentCurationRecord> {
  const result = await sql<CurationRow>`
    insert into community_comment_curations
      (comment_id, hidden, reason, revision, updated_by_account_id, updated_at)
    values (${record.commentId}, ${record.hidden}, ${record.reason}, ${record.revision},
      ${record.updatedByAccountId}, ${record.updatedAt})
    on conflict (comment_id) do update
      set hidden = excluded.hidden,
        reason = excluded.reason,
        revision = excluded.revision,
        updated_by_account_id = excluded.updated_by_account_id,
        updated_at = excluded.updated_at
    returning comment_id, hidden, reason, revision::text, updated_by_account_id, updated_at
  `.execute(transaction);
  return toCurationRecord(result.rows[0]!);
}

interface SettingsRow {
  readonly target_kind: CommunityTargetKind;
  readonly target_id: string;
  readonly target_collection_id: string | null;
  readonly target_series_id: string | null;
  readonly locked: boolean;
  readonly reason: string | null;
  readonly revision: string;
  readonly updated_by_account_id: string;
  readonly updated_at: Date;
}

function toSettingsRecord(row: SettingsRow): CommunityCommentSettingsRecord {
  return Object.freeze<CommunityCommentSettingsRecord>({
    target: Object.freeze({
      kind: row.target_kind,
      id: row.target_id,
      collectionId: row.target_collection_id,
      seriesId: row.target_series_id,
    }),
    locked: row.locked,
    reason: row.reason,
    revision: BigInt(row.revision),
    updatedByAccountId: row.updated_by_account_id,
    updatedAt: row.updated_at,
  });
}

/** Point load of the per-target comment-area settings row (generation-independent). */
export async function loadCommunityCommentSettings(
  transaction: DatabaseTransaction,
  identity: CommunityTargetIdentity,
  lock: 'none' | 'forUpdate',
): Promise<CommunityCommentSettingsRecord | null> {
  const result = await sql<SettingsRow>`
    select target_kind, target_id, target_collection_id, target_series_id,
      locked, reason, revision::text, updated_by_account_id, updated_at
    from community_comment_settings
    where target_kind = ${identity.kind}
      and target_id = ${identity.id}
    ${lock === 'forUpdate' ? sql`for update` : sql``}
  `.execute(transaction);
  const row = result.rows[0];
  const official = await officialCommentAreaLocked(transaction, identity);
  if (row === undefined) {
    if (!official) return null;
    const createdAt = await loadCommunityTargetCreatedAt(transaction, identity);
    return Object.freeze<CommunityCommentSettingsRecord>({
      target: identity,
      locked: true,
      reason: null,
      revision: 1n,
      updatedByAccountId: '',
      updatedAt: createdAt ?? new Date(0),
    });
  }
  const record = toSettingsRecord(row);
  return official && !record.locked ? Object.freeze({ ...record, locked: true }) : record;
}

/** Whether the target's comment area currently rejects new writes. */
export async function communityCommentAreaLocked(
  transaction: DatabaseTransaction,
  identity: CommunityTargetIdentity,
): Promise<boolean> {
  const settings = await loadCommunityCommentSettings(transaction, identity, 'none');
  return settings?.locked === true;
}

async function officialCommentAreaLocked(
  transaction: DatabaseTransaction,
  identity: CommunityTargetIdentity,
): Promise<boolean> {
  const result = await sql<{ locked: boolean }>`
    select exists (
      select 1 from moderation_actions ma
       where ma.target_kind = ${identity.kind}
         and ma.target_id = ${identity.id}
         and ma.state = 'active'
         and ma.action = 'lock_comments'
    ) as locked
  `.execute(transaction);
  return result.rows[0]?.locked === true;
}

/** Insert-or-update the singleton settings row; the target row lock serializes writers. */
export async function upsertCommunityCommentSettings(
  transaction: DatabaseTransaction,
  record: CommunityCommentSettingsRecord,
): Promise<CommunityCommentSettingsRecord> {
  const result = await sql<SettingsRow>`
    insert into community_comment_settings
      (target_kind, target_id, target_collection_id, target_series_id,
        locked, reason, revision, updated_by_account_id, updated_at)
    values (${record.target.kind}, ${record.target.id}, ${record.target.collectionId},
      ${record.target.seriesId}, ${record.locked}, ${record.reason}, ${record.revision},
      ${record.updatedByAccountId}, ${record.updatedAt})
    on conflict (target_kind, target_id) do update
      set target_collection_id = excluded.target_collection_id,
        target_series_id = excluded.target_series_id,
        locked = excluded.locked,
        reason = excluded.reason,
        revision = excluded.revision,
        updated_by_account_id = excluded.updated_by_account_id,
        updated_at = excluded.updated_at
    returning target_kind, target_id, target_collection_id, target_series_id,
      locked, reason, revision::text, updated_by_account_id, updated_at
  `.execute(transaction);
  return toSettingsRecord(result.rows[0]!);
}

// The target-authority helpers used by CS-04 (the curator predicate and the
// stable target created_at stamp) live in community-target-shared-postgres.js.
