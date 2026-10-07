import { sql } from 'kysely';
import type {
  CollaborationInviteRecord,
  CollaborationMembershipRecord,
  CollaborationStorePort,
  CollaboratorGrantRole,
} from '../../modules/access-policy/index.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';

export function createPostgresCollaborationStorePort(
  transaction: DatabaseTransaction,
): CollaborationStorePort {
  return {
    async expireOverdueInvites(collectionId, now) {
      const expired = await transaction
        .updateTable('collection_invites')
        .set({ status: 'expired', resolved_at: now })
        .where('collection_id', '=', collectionId)
        .where('status', '=', 'pending')
        .where('expires_at', '<=', now)
        .returning('id')
        .execute();
      await suppressUnsentInviteDeliveries(transaction, expired.map((row) => row.id), now);
      return expired.length;
    },

    async countMembersAndPending(collectionId) {
      const members = await transaction
        .selectFrom('collection_members')
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .where('collection_id', '=', collectionId)
        .executeTakeFirst();
      const pending = await transaction
        .selectFrom('collection_invites')
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .where('collection_id', '=', collectionId)
        .where('status', '=', 'pending')
        .executeTakeFirst();
      return Number(members?.n ?? 0) + Number(pending?.n ?? 0);
    },

    async countPendingInvites(collectionId) {
      const pending = await transaction
        .selectFrom('collection_invites')
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .where('collection_id', '=', collectionId)
        .where('status', '=', 'pending')
        .executeTakeFirst();
      return Number(pending?.n ?? 0);
    },

    async countPendingInvitesForInvitee(input) {
      const pending = await transaction
        .selectFrom('collection_invites')
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .where('status', '=', 'pending')
        .where((eb) => {
          const emailMatch = eb('email_normalized', '=', input.emailNormalized);
          if (input.invitedSubjectId === null) return emailMatch;
          return eb.or([
            emailMatch,
            eb('invited_subject_id', '=', input.invitedSubjectId),
          ]);
        })
        .executeTakeFirst();
      return Number(pending?.n ?? 0);
    },

    async findMembership(collectionId, subjectId) {
      const row = await transaction
        .selectFrom('collection_members')
        .selectAll()
        .where('collection_id', '=', collectionId)
        .where('subject_id', '=', subjectId)
        .executeTakeFirst();
      return row ? mapMembership(row) : null;
    },

    async findPendingByEmail(collectionId, emailNormalized) {
      const row = await transaction
        .selectFrom('collection_invites')
        .selectAll()
        .where('collection_id', '=', collectionId)
        .where('email_normalized', '=', emailNormalized)
        .where('status', '=', 'pending')
        .executeTakeFirst();
      return row ? mapInvite(row) : null;
    },

    async findInviteById(inviteId) {
      const row = await transaction
        .selectFrom('collection_invites')
        .selectAll()
        .where('id', '=', inviteId)
        .executeTakeFirst();
      return row ? mapInvite(row) : null;
    },

    async revokePendingUnboundInvitesByEmail(emailNormalized, now) {
      const revoked = await transaction
        .updateTable('collection_invites')
        .set({ status: 'revoked', resolved_at: now })
        .where('email_normalized', '=', emailNormalized)
        .where('invited_subject_id', 'is', null)
        .where('status', '=', 'pending')
        .returning('id')
        .execute();
      await suppressUnsentInviteDeliveries(transaction, revoked.map((row) => row.id), now);
      return revoked.length;
    },

    async insertInvite(row) {
      await transaction
        .insertInto('collection_invites')
        .values({
          id: row.id,
          collection_id: row.collectionId,
          role: row.role,
          email_normalized: row.emailNormalized,
          invited_subject_id: row.invitedSubjectId,
          invited_by_subject_id: row.invitedBySubjectId,
          status: row.status,
          expires_at: row.expiresAt,
          created_at: row.createdAt,
          resolved_at: row.resolvedAt,
          accepted_subject_id: row.acceptedSubjectId,
          collection_title_snapshot: row.collectionTitleSnapshot,
        })
        .execute();
    },

    async updateInvite(inviteId, patch) {
      const current = await transaction
        .selectFrom('collection_invites')
        .selectAll()
        .where('id', '=', inviteId)
        .executeTakeFirst();
      if (!current) return false;
      await transaction
        .updateTable('collection_invites')
        .set({
          role: patch.role ?? current.role,
          email_normalized: patch.emailNormalized ?? current.email_normalized,
          invited_subject_id: patch.invitedSubjectId === undefined
            ? current.invited_subject_id
            : patch.invitedSubjectId,
          invited_by_subject_id: patch.invitedBySubjectId ?? current.invited_by_subject_id,
          status: patch.status ?? current.status,
          expires_at: patch.expiresAt ?? current.expires_at,
          resolved_at: patch.resolvedAt === undefined ? current.resolved_at : patch.resolvedAt,
          accepted_subject_id: patch.acceptedSubjectId === undefined
            ? current.accepted_subject_id
            : patch.acceptedSubjectId,
          collection_title_snapshot: patch.collectionTitleSnapshot
            ?? current.collection_title_snapshot,
        })
        .where('id', '=', inviteId)
        .execute();
      return true;
    },

    async insertMembership(row) {
      // P-10: omit collection_updated_at so the trigger/default copies collections.updated_at.
      await transaction
        .insertInto('collection_members')
        .values({
          collection_id: row.collectionId,
          subject_id: row.subjectId,
          role: row.role,
          granted_at: row.grantedAt,
        })
        .execute();
    },

    async updateMembershipRole(collectionId, subjectId, role: CollaboratorGrantRole) {
      const result = await transaction
        .updateTable('collection_members')
        .set({ role })
        .where('collection_id', '=', collectionId)
        .where('subject_id', '=', subjectId)
        .executeTakeFirst();
      return Number(result.numUpdatedRows) > 0;
    },

    async deleteMembership(collectionId, subjectId) {
      const result = await transaction
        .deleteFrom('collection_members')
        .where('collection_id', '=', collectionId)
        .where('subject_id', '=', subjectId)
        .executeTakeFirst();
      return Number(result.numDeletedRows) > 0;
    },
  };
}

export async function suppressUnsentInviteDeliveries(
  transaction: DatabaseTransaction,
  inviteIds: readonly string[],
  now: Date,
): Promise<number> {
  if (inviteIds.length === 0) return 0;
  const result = await transaction
    .updateTable('collection_invite_deliveries')
    .set({
      state: 'suppressed',
      state_revision: sql`state_revision + 1`,
      suppressed_at: now,
      leased_until: null,
      last_error_category: null,
      updated_at: now,
    })
    .where('invite_id', 'in', [...inviteIds])
    .where('state', 'in', ['pending', 'retryable'])
    .executeTakeFirst();
  return Number(result.numUpdatedRows);
}

function mapMembership(row: {
  collection_id: string;
  subject_id: string;
  role: 'owner' | 'editor' | 'viewer';
  granted_at: Date;
}): CollaborationMembershipRecord {
  return {
    collectionId: row.collection_id,
    subjectId: row.subject_id,
    role: row.role,
    grantedAt: row.granted_at,
  };
}

function mapInvite(row: {
  id: string;
  collection_id: string;
  role: 'editor' | 'viewer';
  email_normalized: string;
  invited_subject_id: string | null;
  invited_by_subject_id: string;
  status: 'pending' | 'accepted' | 'declined' | 'revoked' | 'expired';
  expires_at: Date;
  created_at: Date;
  resolved_at: Date | null;
  accepted_subject_id: string | null;
  collection_title_snapshot: string;
}): CollaborationInviteRecord {
  return {
    id: row.id,
    collectionId: row.collection_id,
    role: row.role,
    emailNormalized: row.email_normalized,
    invitedSubjectId: row.invited_subject_id,
    invitedBySubjectId: row.invited_by_subject_id,
    status: row.status,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    acceptedSubjectId: row.accepted_subject_id,
    collectionTitleSnapshot: row.collection_title_snapshot,
  };
}
