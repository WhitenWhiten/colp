import { sql, type Kysely } from 'kysely';
import type { DatabaseSchema } from '../database/runtime.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import {
  composeAccountDecision,
  composeCollectionDecision,
  parseGovernanceTarget,
  type AccountControlDecision,
  type CollectionControlDecision,
  type GovernanceTarget,
  type ModerationActionRecord,
  type ModerationActionState,
  type ModerationActionType,
  type ModerationPageRead,
} from '../../modules/governance/index.js';

type Executor = Kysely<DatabaseSchema> | DatabaseTransaction;

/**
 * Canonical object UUID shape accepted by PostgreSQL's uuid casts. Public
 * object route patterns only require 36 characters of [a-f0-9-], so ids that
 * pass the route but are not well-formed UUIDs must be rejected here before
 * any `::uuid` cast runs.
 */
const UUID_OBJECT_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

interface ActionRow {
  id: string;
  case_id: string;
  target_json: unknown;
  target_fingerprint: string;
  action: string;
  reason: string;
  actor_account_id: string;
  state: string;
  revision: string;
  created_at: Date;
  revoked_at: Date | null;
  revoke_reason: string | null;
  revoked_by_account_id: string | null;
  owner_account_id: string | null;
}

export function createPostgresModerationActionMethods(executor: Executor): {
  insertAction(record: ModerationActionRecord): Promise<void>;
  getAction(actionId: string): Promise<ModerationActionRecord | null>;
  updateAction(record: ModerationActionRecord, expectedRevision: string): Promise<boolean>;
  listActionsForTarget(targetFingerprint: string): Promise<readonly ModerationActionRecord[]>;
  listActionsAffectingOwner(
    ownerAccountId: string,
    read: ModerationPageRead,
  ): Promise<readonly ModerationActionRecord[]>;
  actionOwnerAccountId(target: GovernanceTarget): Promise<string | null>;
  collectionControl(collectionId: string): Promise<CollectionControlDecision>;
  collectionControls(
    collectionIds: readonly string[],
  ): Promise<ReadonlyMap<string, CollectionControlDecision>>;
  collectionPublicationSlug(collectionId: string): Promise<string | null>;
  bookmarkFaviconObjectId(collectionId: string, nodeId: string): Promise<string | null>;
  isFaviconHiddenPublic(objectId: string): Promise<boolean>;
  digestSeriesSlug(seriesId: string): Promise<string | null>;
  digestSeriesControls(
    seriesIds: readonly string[],
  ): Promise<ReadonlyMap<string, CollectionControlDecision>>;
  digestEditionControls(
    editionIds: readonly string[],
  ): Promise<ReadonlyMap<string, CollectionControlDecision>>;
  accountControl(accountId: string): Promise<AccountControlDecision>;
  accountControls(
    accountIds: readonly string[],
  ): Promise<ReadonlyMap<string, AccountControlDecision>>;
  accountPublicLocator(accountId: string): Promise<{
    readonly handle: string | null;
    readonly avatarObjectId: string | null;
  }>;
  isAvatarPublicationRestricted(objectId: string): Promise<boolean>;
} {
  return {
    async insertAction(record) {
      await sql`
        INSERT INTO moderation_actions (
          id, case_id, target_kind, target_id, parent_id, target_json, target_fingerprint,
          action, reason, actor_account_id, state, revision, created_at, revoked_at,
          revoke_reason, revoked_by_account_id, owner_account_id
        ) VALUES (
          ${record.id},
          ${record.caseId},
          ${record.target.kind},
          ${record.target.id},
          ${parentId(record.target)},
          ${JSON.stringify(record.target)}::jsonb,
          ${record.targetFingerprint},
          ${record.action},
          ${record.reason},
          ${record.actorAccountId},
          ${record.state},
          ${record.revision},
          ${new Date(record.createdAt)},
          ${record.revokedAt ? new Date(record.revokedAt) : null},
          ${record.revokeReason},
          ${record.revokedByAccountId},
          ${record.ownerAccountId}
        )
      `.execute(executor);
    },
    async getAction(actionId) {
      const result = await sql<ActionRow>`
        SELECT * FROM moderation_actions WHERE id = ${actionId} LIMIT 1
      `.execute(executor);
      const row = result.rows[0];
      return row ? mapAction(row) : null;
    },
    async updateAction(record, expectedRevision) {
      const result = await sql`
        UPDATE moderation_actions
           SET state = ${record.state},
               revision = ${record.revision},
               revoked_at = ${record.revokedAt ? new Date(record.revokedAt) : null},
               revoke_reason = ${record.revokeReason},
               revoked_by_account_id = ${record.revokedByAccountId}
         WHERE id = ${record.id} AND revision = ${expectedRevision}
      `.execute(executor);
      return Number(result.numAffectedRows ?? 0) === 1;
    },
    async listActionsForTarget(targetFingerprint) {
      const result = await sql<ActionRow>`
        SELECT * FROM moderation_actions
         WHERE target_fingerprint = ${targetFingerprint}
         ORDER BY created_at DESC, id DESC
      `.execute(executor);
      return Object.freeze(result.rows.map(mapAction));
    },
    async listActionsAffectingOwner(ownerAccountId, read) {
      // Affected-owner rights bind to the action's owner snapshot
      // (owner_account_id), so the live parent row never has to survive for
      // the self-service list to work; account targets resolve directly.
      const result = await sql<ActionRow>`
        SELECT * FROM (
          SELECT a.*
            FROM moderation_actions a
           WHERE a.target_kind <> 'account'
             AND a.owner_account_id = ${ownerAccountId}
             AND (
               ${read.after?.createdAt ?? null}::timestamptz IS NULL
               OR (a.created_at, a.id) < (${read.after?.createdAt ?? null}::timestamptz, ${read.after?.id ?? ''})
             )
          UNION ALL
          SELECT a.*
            FROM moderation_actions a
           WHERE a.target_kind = 'account'
             AND a.target_id = ${ownerAccountId}
             AND (
               ${read.after?.createdAt ?? null}::timestamptz IS NULL
               OR (a.created_at, a.id) < (${read.after?.createdAt ?? null}::timestamptz, ${read.after?.id ?? ''})
             )
        ) q
         ORDER BY created_at DESC, id DESC
         LIMIT ${read.limit}
      `.execute(executor);
      return Object.freeze(result.rows.map(mapAction));
    },
    async actionOwnerAccountId(target) {
      if (target.kind === 'account') return target.id;
      if (target.kind === 'bookmark') return ownerAccountIdOfCollection(executor, target.collectionId);
      if (target.kind === 'digest_edition') return ownerAccountIdOfSeries(executor, target.seriesId);
      if (target.kind === 'collection') return ownerAccountIdOfCollection(executor, target.id);
      if (target.kind === 'digest_series') return ownerAccountIdOfSeries(executor, target.id);
      if (target.kind === 'comment') return ownerAccountIdOfComment(executor, target.id);
      return null;
    },
    async collectionControl(collectionId) {
      const map = await loadControls(executor, [collectionId]);
      return map.get(collectionId) ?? Object.freeze({ hidePublic: false, delisted: false });
    },
    async collectionControls(collectionIds) {
      return loadControls(executor, collectionIds);
    },
    async collectionPublicationSlug(collectionId) {
      const result = await sql<{ publication_slug: string | null }>`
        SELECT publication_slug FROM collections WHERE id = ${collectionId} LIMIT 1
      `.execute(executor);
      return result.rows[0]?.publication_slug ?? null;
    },
    async bookmarkFaviconObjectId(collectionId, nodeId) {
      const result = await sql<{ object_id: string }>`
        SELECT object_id::text AS object_id
          FROM bookmark_icons
         WHERE node_id = ${nodeId} AND collection_id = ${collectionId}
         LIMIT 1
      `.execute(executor);
      return result.rows[0]?.object_id ?? null;
    },
    async isFaviconHiddenPublic(objectId) {
      // Route patterns accept any 36-char [a-f0-9-] id; only well-formed UUIDs
      // may reach the uuid casts below, otherwise a malformed id would turn
      // the origin check into a SQL cast error (500) instead of a 404.
      if (!UUID_OBJECT_PATTERN.test(objectId)) return false;
      // Current AND historical favicon attribution: the bookmark_icons branch
      // covers the live icon, while bookmark_icon_objects keeps tracing every
      // object ever bound to a bookmark/Collection. After a favicon is
      // replaced (or its row deleted) the old object may still be served from
      // the object store, so hide_public must keep blocking it.
      const result = await sql<{ hidden: boolean }>`
        SELECT EXISTS (
          SELECT 1
            FROM bookmark_icons i
           WHERE i.object_id = ${objectId}::uuid
             AND (
               EXISTS (
                 SELECT 1 FROM moderation_actions ma
                  WHERE ma.target_kind = 'bookmark'
                    AND ma.target_id = i.node_id
                    AND ma.parent_id = i.collection_id
                    AND ma.state = 'active'
                    AND ma.action = 'hide_public'
               )
               OR EXISTS (
                 SELECT 1 FROM moderation_actions ma
                  WHERE ma.target_kind = 'collection'
                    AND ma.target_id = i.collection_id
                    AND ma.state = 'active'
                    AND ma.action = 'hide_public'
               )
             )
          UNION
          SELECT 1
            FROM bookmark_icon_objects io
           WHERE io.object_id = ${objectId}::uuid
             AND (
               EXISTS (
                 SELECT 1 FROM moderation_actions ma
                  WHERE ma.target_kind = 'bookmark'
                    AND ma.target_id = io.node_id
                    AND ma.parent_id = io.collection_id
                    AND ma.state = 'active'
                    AND ma.action = 'hide_public'
               )
               OR EXISTS (
                 SELECT 1 FROM moderation_actions ma
                  WHERE ma.target_kind = 'collection'
                    AND ma.target_id = io.collection_id
                    AND ma.state = 'active'
                    AND ma.action = 'hide_public'
               )
             )
        ) AS hidden
      `.execute(executor);
      return result.rows[0]?.hidden === true;
    },
    async digestSeriesSlug(seriesId) {
      const result = await sql<{ slug: string | null }>`
        SELECT slug FROM digest_series WHERE id = ${seriesId} LIMIT 1
      `.execute(executor);
      return result.rows[0]?.slug ?? null;
    },
    async digestSeriesControls(seriesIds) {
      return loadTypedControls(executor, 'digest_series', seriesIds);
    },
    async digestEditionControls(editionIds) {
      return loadTypedControls(executor, 'digest_edition', editionIds);
    },
    async accountControl(accountId) {
      const map = await loadAccountControls(executor, [accountId]);
      return map.get(accountId) ?? Object.freeze({ restrictInteraction: false, restrictPublication: false });
    },
    async accountControls(accountIds) {
      return loadAccountControls(executor, accountIds);
    },
    async accountPublicLocator(accountId) {
      const result = await sql<{ handle: string | null; avatar_url: string | null }>`
        SELECT h.handle, p.avatar_url
          FROM accounts a
          LEFT JOIN profile_handles h ON h.account_id = a.id
          LEFT JOIN profiles p ON p.account_id = a.id
         WHERE a.id = ${accountId}
         LIMIT 1
      `.execute(executor);
      const row = result.rows[0];
      return Object.freeze({
        handle: row?.handle ?? null,
        avatarObjectId: avatarObjectIdFromUrl(row?.avatar_url ?? null),
      });
    },
    async isAvatarPublicationRestricted(objectId) {
      // Only well-formed UUIDs may reach the uuid casts below: a malformed id
      // that passes the route pattern must 404 through the object store, not
      // fail the origin check with a SQL cast error.
      if (!UUID_OBJECT_PATTERN.test(objectId)) return false;
      // Current AND historical avatar attribution: the profiles.avatar_url
      // branch covers the live avatar, while avatar_objects keeps tracing
      // every object ever assigned to a profile. After the avatar URL is
      // replaced or cleared the old object may still be served from the
      // object store, so restrict_publication must keep blocking it.
      const result = await sql<{ hidden: boolean }>`
        SELECT EXISTS (
          SELECT 1
            FROM profiles p
            JOIN moderation_actions ma
              ON ma.target_kind = 'account'
             AND ma.target_id = p.account_id
             AND ma.state = 'active'
             AND ma.action = 'restrict_publication'
           WHERE p.avatar_url IS NOT NULL
             AND lower(p.avatar_url) LIKE '%/api/v1/avatar/' || lower(${objectId})
          UNION
          SELECT 1
            FROM avatar_objects ao
            JOIN moderation_actions ma
              ON ma.target_kind = 'account'
             AND ma.target_id = ao.account_id
             AND ma.state = 'active'
             AND ma.action = 'restrict_publication'
           WHERE ao.object_id = ${objectId}::uuid
        ) AS hidden
      `.execute(executor);
      return result.rows[0]?.hidden === true;
    },
  };
}

async function loadControls(
  executor: Executor,
  collectionIds: readonly string[],
): Promise<ReadonlyMap<string, CollectionControlDecision>> {
  return loadTypedControls(executor, 'collection', collectionIds);
}

async function loadTypedControls(
  executor: Executor,
  targetKind: 'collection' | 'digest_series' | 'digest_edition',
  ids: readonly string[],
): Promise<ReadonlyMap<string, CollectionControlDecision>> {
  const out = new Map<string, CollectionControlDecision>();
  for (const id of ids) out.set(id, Object.freeze({ hidePublic: false, delisted: false }));
  if (ids.length === 0) return out;
  const result = await sql<{ target_id: string; action: string }>`
    SELECT target_id, action
      FROM moderation_actions
     WHERE target_kind = ${targetKind}
       AND state = 'active'
       AND action IN ('delist', 'hide_public')
       AND target_id IN (${sql.join(ids.map((id) => sql`${id}`))})
  `.execute(executor);
  const grouped = new Map<string, { action: string; state: string }[]>();
  for (const row of result.rows) {
    const list = grouped.get(row.target_id) ?? [];
    list.push({ action: row.action, state: 'active' });
    grouped.set(row.target_id, list);
  }
  for (const [id, actions] of grouped) out.set(id, composeCollectionDecision(actions));
  return out;
}

async function loadAccountControls(
  executor: Executor,
  accountIds: readonly string[],
): Promise<ReadonlyMap<string, AccountControlDecision>> {
  const out = new Map<string, AccountControlDecision>();
  for (const id of accountIds) {
    out.set(id, Object.freeze({ restrictInteraction: false, restrictPublication: false }));
  }
  if (accountIds.length === 0) return out;
  const result = await sql<{ target_id: string; action: string }>`
    SELECT target_id, action
      FROM moderation_actions
     WHERE target_kind = 'account'
       AND state = 'active'
       AND action IN ('restrict_interaction', 'restrict_publication')
       AND target_id IN (${sql.join(accountIds.map((id) => sql`${id}`))})
  `.execute(executor);
  const grouped = new Map<string, { action: string; state: string }[]>();
  for (const row of result.rows) {
    const list = grouped.get(row.target_id) ?? [];
    list.push({ action: row.action, state: 'active' });
    grouped.set(row.target_id, list);
  }
  for (const [id, actions] of grouped) out.set(id, composeAccountDecision(actions));
  return out;
}

function avatarObjectIdFromUrl(value: string | null): string | null {
  if (value === null || value.length < 1) return null;
  try {
    const parsed = new URL(value);
    const match = /^\/api\/v1\/avatar\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/iu
      .exec(parsed.pathname);
    return match?.[1]?.toLowerCase() ?? null;
  } catch {
    return null;
  }
}

function mapAction(row: ActionRow): ModerationActionRecord {
  return Object.freeze({
    id: row.id,
    caseId: row.case_id,
    target: parseGovernanceTarget(row.target_json),
    targetFingerprint: row.target_fingerprint,
    action: row.action as ModerationActionType,
    reason: row.reason,
    actorAccountId: row.actor_account_id,
    state: row.state as ModerationActionState,
    revision: row.revision,
    createdAt: row.created_at.toISOString(),
    revokedAt: row.revoked_at ? row.revoked_at.toISOString() : null,
    revokeReason: row.revoke_reason,
    revokedByAccountId: row.revoked_by_account_id,
    ownerAccountId: row.owner_account_id,
  });
}

async function ownerAccountIdOfComment(executor: Executor, commentId: string): Promise<string | null> {
  const result = await sql<{
    target_kind: string;
    target_id: string;
    target_collection_id: string | null;
    target_series_id: string | null;
  }>`
    SELECT target_kind, target_id, target_collection_id, target_series_id
      FROM community_comments
     WHERE comment_id = ${commentId}
     LIMIT 1
  `.execute(executor);
  const row = result.rows[0];
  if (!row) return null;
  if (row.target_kind === 'collection') return ownerAccountIdOfCollection(executor, row.target_id);
  if (row.target_kind === 'bookmark') {
    return row.target_collection_id === null
      ? null
      : ownerAccountIdOfCollection(executor, row.target_collection_id);
  }
  if (row.target_kind === 'digest_series') return ownerAccountIdOfSeries(executor, row.target_id);
  if (row.target_kind === 'digest_edition') {
    return row.target_series_id === null
      ? null
      : ownerAccountIdOfSeries(executor, row.target_series_id);
  }
  return null;
}

async function ownerAccountIdOfCollection(executor: Executor, collectionId: string): Promise<string | null> {
  const result = await sql<{ account_id: string }>`
    SELECT a.id AS account_id
      FROM collections c
      JOIN accounts a ON a.subject_id = c.owner_subject_id
     WHERE c.id = ${collectionId}
     LIMIT 1
  `.execute(executor);
  return result.rows[0]?.account_id ?? null;
}

async function ownerAccountIdOfSeries(executor: Executor, seriesId: string): Promise<string | null> {
  const result = await sql<{ account_id: string }>`
    SELECT a.id AS account_id
      FROM digest_series s
      JOIN accounts a ON a.subject_id = s.owner_subject_id
     WHERE s.id = ${seriesId}
     LIMIT 1
  `.execute(executor);
  return result.rows[0]?.account_id ?? null;
}

function parentId(target: GovernanceTarget): string | null {
  if (target.kind === 'bookmark') return target.collectionId;
  if (target.kind === 'digest_edition') return target.seriesId;
  return null;
}
