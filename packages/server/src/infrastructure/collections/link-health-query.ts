import { sql, type Kysely } from 'kysely';
import type {
  LinkHealthBookmarkUrlFact,
  LinkHealthErrorClass,
  LinkHealthMembership,
  LinkHealthReadInput,
  LinkHealthReadPort,
  LinkHealthRow,
  LinkHealthScope,
} from '../../modules/collections/index.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import type { DatabaseSchema } from '../database/runtime.js';

const nodeIdKey = sql<string>`n.id COLLATE "C"`;
const duplicateRelationIdExpr = sql<string | null>`(
  SELECT r.id FROM relations AS r
  WHERE r.collection_id = n.collection_id
    AND r.from_node_id = n.id
    AND r.type = 'duplicate_of'
    AND r.visibility = 'private'
    AND r.deleted_at IS NULL
  ORDER BY r.created_at ASC, r.id COLLATE "C" ASC
  LIMIT 1
)`;
const duplicateRelationRevisionExpr = sql<string | null>`(
  SELECT r.resource_revision FROM relations AS r
  WHERE r.collection_id = n.collection_id
    AND r.from_node_id = n.id
    AND r.type = 'duplicate_of'
    AND r.visibility = 'private'
    AND r.deleted_at IS NULL
  ORDER BY r.created_at ASC, r.id COLLATE "C" ASC
  LIMIT 1
)`;

export function createPostgresLinkHealthReadPort(
  transaction: DatabaseTransaction | Kysely<DatabaseSchema>,
): LinkHealthReadPort {
  return {
    async listOwnedBookmarkUrlFacts(input) {
      const scope = input.scope ?? 'owned';
      const actor = input.ownerSubjectId;
      let query = transaction.selectFrom('nodes as n')
        .innerJoin('collections as c', 'c.id', 'n.collection_id')
        .select(['n.id as node_id', 'n.collection_id', 'n.url', 'n.created_at'])
        .where('c.deleted_at', 'is', null)
        .where('n.deleted_at', 'is', null)
        .where('n.kind', '=', 'bookmark')
        .where('n.url', 'is not', null)
        .where(sql<boolean>`n.url <> ''`)
        .where(scopePredicate(actor, scope));
      if (input.collectionId) query = query.where('n.collection_id', '=', input.collectionId);
      const rows = await query.execute();
      return rows.flatMap((row): LinkHealthBookmarkUrlFact[] => {
        if (row.url === null) return [];
        return [{
          nodeId: row.node_id, collectionId: row.collection_id, url: row.url, createdAt: row.created_at,
        }];
      });
    },
    async listLinkHealth(input: LinkHealthReadInput) {
      if (input.nodeIds && input.nodeIds.length === 0) return [];
      const scope = input.scope ?? 'owned';
      const actor = input.ownerSubjectId;
      let query = transaction.selectFrom('collection_link_health as h')
        .innerJoin('nodes as n', 'n.id', 'h.node_id')
        .innerJoin('collections as c', 'c.id', 'h.collection_id')
        .select([
          'n.id as node_id', 'n.collection_id', 'c.title as collection_title', 'n.title', 'n.url',
          'n.resource_revision', 'n.created_at', 'h.status', 'h.http_status', 'h.final_url', 'h.checked_at',
          'h.error_class',
          duplicateRelationIdExpr.as('duplicate_relation_id'),
          duplicateRelationRevisionExpr.as('duplicate_relation_revision'),
          membershipExpr(actor, scope).as('membership'),
        ])
        .where('c.deleted_at', 'is', null)
        .where('n.deleted_at', 'is', null)
        .where('n.kind', '=', 'bookmark')
        .where('n.url', 'is not', null)
        .where(sql<boolean>`n.url <> ''`)
        .whereRef('n.collection_id', '=', 'h.collection_id')
        .where(scopePredicate(actor, scope));
      if (input.status) query = query.where('h.status', '=', input.status);
      if (input.collectionId) query = query.where('n.collection_id', '=', input.collectionId);
      if (input.nodeIds) query = query.where('n.id', 'in', [...input.nodeIds]);
      if (input.after) {
        if (input.after.checkedAt === null) {
          query = query.where(sql<boolean>`(
            (h.checked_at IS NULL AND ${nodeIdKey} > ${input.after.nodeId}::text COLLATE "C")
            OR h.checked_at IS NOT NULL
          )`);
        } else {
          query = query.where(sql<boolean>`(
            h.checked_at IS NOT NULL AND (
              h.checked_at > ${input.after.checkedAt}
              OR (h.checked_at = ${input.after.checkedAt} AND ${nodeIdKey} > ${input.after.nodeId}::text COLLATE "C")
            )
          )`);
        }
      }
      const rows = await query
        .orderBy(sql`h.checked_at ASC NULLS FIRST`)
        .orderBy(nodeIdKey, 'asc')
        .limit(input.limit + 1)
        .execute();
      return rows.flatMap((row): LinkHealthRow[] => {
        if (row.url === null) return [];
        const membership = asMembership(row.membership);
        if (membership === null) return [];
        return [{
          nodeId: row.node_id,
          collectionId: row.collection_id,
          collectionTitle: row.collection_title,
          title: row.title ?? '',
          url: row.url,
          resourceRevision: row.resource_revision,
          createdAt: row.created_at,
          status: row.status,
          httpStatus: row.http_status,
          finalUrl: row.final_url,
          checkedAt: row.checked_at,
          membership,
          errorClass: asErrorClass(row.error_class),
          duplicateRelationId: row.duplicate_relation_id,
          duplicateRelationRevision: row.duplicate_relation_revision,
        }];
      });
    },
  };
}

/** Predicates match `shared-collections-query.ts`: editor/viewer, live collection, not owner. */
function sharedMemberExists(actor: string) {
  return sql<boolean>`EXISTS (
    SELECT 1
    FROM collection_members AS m
    WHERE m.collection_id = c.id
      AND m.subject_id = ${actor}
      AND m.role IN ('editor', 'viewer')
  )`;
}

function scopePredicate(actor: string, scope: LinkHealthScope) {
  if (scope === 'owned') return sql<boolean>`c.owner_subject_id = ${actor}`;
  if (scope === 'shared') {
    return sql<boolean>`c.owner_subject_id <> ${actor} AND ${sharedMemberExists(actor)}`;
  }
  return sql<boolean>`(
    c.owner_subject_id = ${actor}
    OR (c.owner_subject_id <> ${actor} AND ${sharedMemberExists(actor)})
  )`;
}

function membershipExpr(actor: string, scope: LinkHealthScope) {
  if (scope === 'owned') return sql<LinkHealthMembership>`'owner'`;
  if (scope === 'shared') {
    return sql<LinkHealthMembership>`(
      SELECT m.role FROM collection_members AS m
      WHERE m.collection_id = c.id
        AND m.subject_id = ${actor}
        AND m.role IN ('editor', 'viewer')
      LIMIT 1
    )`;
  }
  return sql<LinkHealthMembership>`CASE
    WHEN c.owner_subject_id = ${actor} THEN 'owner'
    ELSE (
      SELECT m.role FROM collection_members AS m
      WHERE m.collection_id = c.id
        AND m.subject_id = ${actor}
        AND m.role IN ('editor', 'viewer')
      LIMIT 1
    )
  END`;
}

function asMembership(value: unknown): LinkHealthMembership | null {
  return value === 'owner' || value === 'editor' || value === 'viewer' ? value : null;
}

function asErrorClass(value: unknown): LinkHealthErrorClass | null {
  return value === 'invalid_url' || value === 'timeout' || value === 'denied'
    || value === 'dns' || value === 'http' ? value : null;
}
