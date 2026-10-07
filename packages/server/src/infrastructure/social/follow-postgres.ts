import { sql } from 'kysely';
import {
  FollowAuthorityError,
  SOCIAL_IDENTITY_MAX_LENGTH,
  type FollowBinding,
  type FollowRecord,
  type FollowRepository,
  type SavedFollow,
} from '../../modules/social/index.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';

interface FollowRow {
  actor_profile_id: string;
  target_profile_id: string;
  followed_at: Date;
  inserted: boolean;
}

export function createPostgresFollowRepository(transaction: DatabaseTransaction): FollowRepository {
  return Object.freeze({
    async save(binding: FollowBinding): Promise<SavedFollow | null> {
      assertBinding(binding);
      const eligible = await sql<{ account_id: string }>`
        SELECT profile.account_id
          FROM profiles profile
          JOIN accounts account ON account.id=profile.account_id
         WHERE profile.account_id IN (${binding.actorProfileId},${binding.targetProfileId})
           AND account.status='active' AND account.deleted_at IS NULL
         ORDER BY profile.account_id
         FOR SHARE OF profile,account
      `.execute(transaction);
      const eligibleIds = new Set(eligible.rows.map((row) => row.account_id));
      if (!eligibleIds.has(binding.actorProfileId) || !eligibleIds.has(binding.targetProfileId)) {
        return null;
      }

      const inserted = await transaction.insertInto('follows').values({
        actor_profile_id: binding.actorProfileId,
        target_profile_id: binding.targetProfileId,
      }).onConflict((conflict) => conflict.columns([
        'actor_profile_id', 'target_profile_id',
      ]).doNothing()).returningAll().executeTakeFirst();
      if (inserted) {
        return Object.freeze({ follow: mapFollow({ ...inserted, inserted: true }), inserted: true });
      }

      // The conflict can commit after the first statement's snapshot. A fresh
      // READ COMMITTED statement observes the durable winner without a no-op update.
      const existing = await transaction.selectFrom('follows').selectAll()
        .where('actor_profile_id', '=', binding.actorProfileId)
        .where('target_profile_id', '=', binding.targetProfileId)
        .executeTakeFirst();
      if (!existing) {
        throw new FollowAuthorityError(
          'invalid_follow_record',
          'Follow uniqueness conflict completed without durable authority.',
        );
      }
      return Object.freeze({ follow: mapFollow({ ...existing, inserted: false }), inserted: false });
    },

    async remove(binding: FollowBinding): Promise<boolean> {
      assertBinding(binding);
      const result = await transaction.deleteFrom('follows')
        .where('actor_profile_id', '=', binding.actorProfileId)
        .where('target_profile_id', '=', binding.targetProfileId)
        .returning('actor_profile_id')
        .executeTakeFirst();
      return result !== undefined;
    },
  });
}

function assertBinding(binding: FollowBinding): void {
  if (!binding || typeof binding !== 'object'
      || !isProfileIdentity(binding.actorProfileId)
      || !isProfileIdentity(binding.targetProfileId)) {
    throw new FollowAuthorityError(
      'invalid_profile_identity',
      'Follow requires stable actor and target Profile identities.',
    );
  }
  if (binding.actorProfileId === binding.targetProfileId) {
    throw new FollowAuthorityError('self_follow', 'A Profile cannot follow itself.');
  }
}

function isProfileIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
    && value.length <= SOCIAL_IDENTITY_MAX_LENGTH && value.trim() === value;
}

function mapFollow(row: FollowRow): FollowRecord {
  if (!isProfileIdentity(row.actor_profile_id)
      || !isProfileIdentity(row.target_profile_id)
      || row.actor_profile_id === row.target_profile_id
      || !(row.followed_at instanceof Date)
      || !Number.isFinite(row.followed_at.getTime())) {
    throw new FollowAuthorityError(
      'invalid_follow_record',
      'PostgreSQL returned invalid Follow authority facts.',
    );
  }
  return Object.freeze({
    actorProfileId: row.actor_profile_id,
    targetProfileId: row.target_profile_id,
    followedAt: row.followed_at,
  });
}
