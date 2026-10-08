import { sql, type ExpressionBuilder } from 'kysely';
import type {
  CollaborationCollectionHeader,
  CollaborationMemberListItem,
  CollaborationPendingInviteListItem,
  CollaborationQueryPort,
  MyCollaborationInviteListItem,
} from '../../modules/access-policy/index.js';
import { readCollectionHeader } from '../collections/collection-header-read.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import type { DatabaseSchema } from '../database/runtime.js';

const memberSubjectKey = sql<string>`members.subject_id COLLATE "C"`;
const inviteIdKey = sql<string>`id COLLATE "C"`;

export function createPostgresCollaborationQueryPort(
  transaction: DatabaseTransaction,
): CollaborationQueryPort {
  return {
    async loadCollection(collectionId) {
      const row = await readCollectionHeader(transaction, collectionId);
      if (!row) return null;
      const header: CollaborationCollectionHeader = {
        id: row.id,
        title: row.title,
        ownerSubjectId: row.ownerSubjectId,
        visibility: row.visibility,
        policyRevision: row.policyRevision,
        deletedAt: row.deletedAt,
      };
      return header;
    },

    async listMembers(input) {
      let query = transaction
        .selectFrom('collection_members as members')
        .innerJoin('accounts', 'accounts.subject_id', 'members.subject_id')
        .leftJoin('profiles', 'profiles.account_id', 'accounts.id')
        .select([
          'members.subject_id',
          'members.role',
          'members.granted_at',
          'profiles.display_name',
          'profiles.avatar_url',
          'accounts.email',
        ])
        .where('members.collection_id', '=', input.collectionId)
        .where('accounts.deleted_at', 'is', null);
      if (input.after) {
        query = query.where('members.granted_at', '>=', input.after.grantedAt).where(sql<boolean>`(
          members.granted_at > ${input.after.grantedAt}
          OR (members.granted_at = ${input.after.grantedAt} AND ${memberSubjectKey} > ${input.after.subjectId}::text COLLATE "C")
        )`);
      }
      const rows = await query
        .orderBy('members.granted_at', 'asc')
        .orderBy(memberSubjectKey, 'asc')
        .limit(input.limit + 1)
        .execute();
      return rows.map((row): CollaborationMemberListItem => ({
        subjectId: row.subject_id,
        role: row.role,
        displayName: row.display_name?.trim() || 'Member',
        email: row.email,
        avatarUrl: row.avatar_url,
        grantedAt: row.granted_at,
      }));
    },

    async listPendingInvites(input) {
      let query = transaction
        .selectFrom('collection_invites')
        .select(['id', 'email_normalized', 'role', 'created_at', 'expires_at'])
        .where('collection_id', '=', input.collectionId)
        .where('status', '=', 'pending')
        .where('expires_at', '>', input.now);
      if (input.after) {
        query = query.where('created_at', '>=', input.after.createdAt).where(sql<boolean>`(
          created_at > ${input.after.createdAt}
          OR (created_at = ${input.after.createdAt} AND ${inviteIdKey} > ${input.after.inviteId}::text COLLATE "C")
        )`);
      }
      const rows = await query
        .orderBy('created_at', 'asc')
        .orderBy(inviteIdKey, 'asc')
        .limit(input.limit + 1)
        .execute();
      return rows.map((row): CollaborationPendingInviteListItem => ({
        inviteId: row.id,
        email: row.email_normalized,
        role: row.role,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
      }));
    },

    async listMyPendingInvites(input) {
      let query = transaction
        .selectFrom('collection_invites')
        .select([
          'id',
          'collection_id',
          'collection_title_snapshot',
          'role',
          'email_normalized',
          'expires_at',
          'created_at',
        ])
        .where('status', '=', 'pending')
        .where('expires_at', '>', input.now)
        .where((eb) => inviteeMatch(eb, input.subjectId, input.email));
      if (input.after) {
        query = query.where('created_at', '>=', input.after.createdAt).where(sql<boolean>`(
          created_at > ${input.after.createdAt}
          OR (created_at = ${input.after.createdAt} AND ${inviteIdKey} > ${input.after.inviteId}::text COLLATE "C")
        )`);
      }
      const rows = await query
        .orderBy('created_at', 'asc')
        .orderBy(inviteIdKey, 'asc')
        .limit(input.limit + 1)
        .execute();
      return rows.map((row): MyCollaborationInviteListItem => ({
        inviteId: row.id,
        collectionId: row.collection_id,
        collectionTitle: row.collection_title_snapshot,
        role: row.role,
        email: row.email_normalized,
        expiresAt: row.expires_at,
        invitedAt: row.created_at,
      }));
    },
  };
}

function inviteeMatch(
  eb: ExpressionBuilder<DatabaseSchema, 'collection_invites'>,
  subjectId: string,
  email: string,
) {
  const normalized = email.trim().toLowerCase();
  return eb.or([
    eb.and([
      eb('invited_subject_id', 'is not', null),
      eb('invited_subject_id', '=', subjectId),
    ]),
    eb.and([
      eb('invited_subject_id', 'is', null),
      eb('email_normalized', '=', normalized),
    ]),
  ]);
}
