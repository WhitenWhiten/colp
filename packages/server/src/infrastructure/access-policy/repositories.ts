import type {
  AccessPolicyFactsPort,
  AccessPolicyPorts,
  AccessPolicyWritePort,
} from '../../modules/access-policy/index.js';
import type { Kysely } from 'kysely';
import { readCollectionHeader } from '../collections/collection-header-read.js';
import type { DatabaseSchema } from '../database/runtime.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import { mapCollectionFacts } from './mappers.js';

/**
 * Read-only facts loader bound to the caller's transaction.
 * Collection locator/header columns come from the collections-owned leaf;
 * this adapter only reads the actor's `collection_members` row.
 * Never writes collections/nodes or membership/policy tables.
 */
export function createPostgresAccessPolicyFactsPort(
  transaction: DatabaseTransaction | Kysely<DatabaseSchema>,
): AccessPolicyFactsPort {
  return {
    async loadCollectionFacts(input) {
      const header = await readCollectionHeader(transaction, input.collectionId);
      if (!header) return null;

      const membership = await transaction
        .selectFrom('collection_members')
        .select('role')
        .where('collection_id', '=', input.collectionId)
        .where('subject_id', '=', input.actorSubjectId)
        .executeTakeFirst();

      return mapCollectionFacts({
        id: header.id,
        owner_subject_id: header.ownerSubjectId,
        visibility: header.visibility,
        policy_revision: header.policyRevision,
        deleted_at: header.deletedAt,
        membership_role: membership?.role ?? null,
      });
    },
  };
}

/**
 * Membership/policy writes only — never mutates collections or nodes tables.
 * Bound to the caller's transaction (e.g. CreateOwnedCollection bootstrap).
 */
export function createPostgresAccessPolicyWritePort(
  transaction: DatabaseTransaction,
): AccessPolicyWritePort {
  return {
    async insertMembership(input) {
      await transaction
        .insertInto('collection_members')
        .values({
          collection_id: input.collectionId,
          subject_id: input.subjectId,
          role: input.role,
          granted_at: input.grantedAt,
        })
        .execute();
    },

    async deleteMembership(input) {
      const result = await transaction
        .deleteFrom('collection_members')
        .where('collection_id', '=', input.collectionId)
        .where('subject_id', '=', input.subjectId)
        .executeTakeFirst();
      return Number(result.numDeletedRows) > 0;
    },

    async upsertCollectionPolicy(input) {
      const policyJson = input.policyJson ?? {};
      await transaction
        .insertInto('collection_policies')
        .values({
          collection_id: input.collectionId,
          policy_json: policyJson as Record<string, unknown>,
          updated_at: input.updatedAt,
        })
        .onConflict((oc) =>
          oc.column('collection_id').doUpdateSet({
            policy_json: policyJson as Record<string, unknown>,
            updated_at: input.updatedAt,
          }))
        .execute();
    },
  };
}

/** Builds access-policy ports bound to one database transaction. */
export function createPostgresAccessPolicyPorts(
  transaction: DatabaseTransaction,
): AccessPolicyPorts {
  return {
    facts: createPostgresAccessPolicyFactsPort(transaction),
    writes: createPostgresAccessPolicyWritePort(transaction),
  };
}
