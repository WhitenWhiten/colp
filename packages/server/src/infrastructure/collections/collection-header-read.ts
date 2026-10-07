import type { Kysely } from 'kysely';
import type { DatabaseSchema } from '../database/runtime.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';

type CollectionHeaderExecutor = DatabaseTransaction | Kysely<DatabaseSchema>;

/**
 * Read-only locator/header columns from `collections`.
 * Membership, policy JSON, and invites stay in the access-policy adapter.
 * This leaf must not import access-policy (avoids an adapter cycle).
 */
export interface CollectionHeaderRead {
  readonly id: string;
  readonly title: string;
  readonly ownerSubjectId: string;
  readonly visibility: DatabaseSchema['collections']['visibility'];
  readonly policyRevision: string;
  readonly deletedAt: Date | null;
}

/** Projects collection header columns for facts/collaboration adapters. */
export async function readCollectionHeader(
  transaction: CollectionHeaderExecutor,
  collectionId: string,
): Promise<CollectionHeaderRead | null> {
  const row = await transaction
    .selectFrom('collections')
    .select([
      'id',
      'title',
      'owner_subject_id',
      'visibility',
      'policy_revision',
      'deleted_at',
    ])
    .where('id', '=', collectionId)
    .executeTakeFirst();
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    ownerSubjectId: row.owner_subject_id,
    visibility: row.visibility,
    policyRevision: row.policy_revision,
    deletedAt: row.deleted_at,
  };
}
