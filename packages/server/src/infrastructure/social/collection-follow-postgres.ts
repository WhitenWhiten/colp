import { sql } from 'kysely';
import {
  CollectionFollowAuthorityError,
  COLLECTION_OWNER_FOLLOW_MESSAGE,
  SOCIAL_IDENTITY_MAX_LENGTH,
  type CollectionFollowBinding,
  type CollectionFollowRecord,
  type CollectionFollowRepository,
  type SavedCollectionFollow,
} from '../../modules/social/index.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';

const OPAQUE_ID = /^[A-Za-z0-9._~-]{1,128}$/u;

interface CollectionFollowRow {
  collection_id: string;
  follower_profile_id: string;
  followed_at: Date;
}

export function createPostgresCollectionFollowRepository(
  transaction: DatabaseTransaction,
): CollectionFollowRepository {
  return Object.freeze({
    async save(binding: CollectionFollowBinding): Promise<SavedCollectionFollow | null> {
      assertBinding(binding);
      const follower = await sql<{ account_id: string; subject_id: string }>`
        SELECT profile.account_id, account.subject_id
          FROM profiles profile
          JOIN accounts account ON account.id=profile.account_id
         WHERE profile.account_id=${binding.followerProfileId}
           AND account.status='active' AND account.deleted_at IS NULL
         FOR SHARE OF profile,account
      `.execute(transaction);
      const collection = await sql<{ id: string; owner_subject_id: string }>`
        SELECT collection.id, collection.owner_subject_id
          FROM collections collection
         WHERE collection.id=${binding.collectionId}
           AND collection.deleted_at IS NULL
           AND collection.visibility IN ('public','unlisted')
         FOR SHARE OF collection
      `.execute(transaction);
      if (follower.rows.length !== 1 || collection.rows.length !== 1) return null;
      if (follower.rows[0]!.subject_id === collection.rows[0]!.owner_subject_id) {
        throw new CollectionFollowAuthorityError('owner_follow', COLLECTION_OWNER_FOLLOW_MESSAGE);
      }

      const inserted = await transaction.insertInto('collection_follows').values({
        collection_id: binding.collectionId,
        follower_profile_id: binding.followerProfileId,
      }).onConflict((conflict) => conflict.columns([
        'collection_id', 'follower_profile_id',
      ]).doNothing()).returningAll().executeTakeFirst();
      if (inserted) {
        return Object.freeze({ follow: mapFollow(inserted), inserted: true });
      }

      const existing = await transaction.selectFrom('collection_follows').selectAll()
        .where('collection_id', '=', binding.collectionId)
        .where('follower_profile_id', '=', binding.followerProfileId)
        .executeTakeFirst();
      if (!existing) {
        throw new CollectionFollowAuthorityError(
          'invalid_collection_follow_record',
          'Collection Follow uniqueness conflict completed without durable authority.',
        );
      }
      return Object.freeze({ follow: mapFollow(existing), inserted: false });
    },

    async remove(binding: CollectionFollowBinding): Promise<boolean> {
      assertBinding(binding);
      const result = await transaction.deleteFrom('collection_follows')
        .where('collection_id', '=', binding.collectionId)
        .where('follower_profile_id', '=', binding.followerProfileId)
        .returning('collection_id')
        .executeTakeFirst();
      return result !== undefined;
    },

    async countFollowers(collectionId: string): Promise<number> {
      if (!OPAQUE_ID.test(collectionId)) {
        throw new CollectionFollowAuthorityError(
          'invalid_collection_follow_identity',
          'Collection Follow requires a stable Collection identity.',
        );
      }
      const result = await sql<{ count: string }>`
        SELECT count(*)::text AS count
          FROM collection_follows
         WHERE collection_id=${collectionId}
      `.execute(transaction);
      return Number(result.rows[0]?.count ?? 0);
    },
  });
}

function assertBinding(binding: CollectionFollowBinding): void {
  if (!binding || typeof binding !== 'object'
      || !isProfileIdentity(binding.followerProfileId)
      || !OPAQUE_ID.test(binding.collectionId)) {
    throw new CollectionFollowAuthorityError(
      'invalid_collection_follow_identity',
      'Collection Follow requires stable follower and Collection identities.',
    );
  }
}

function isProfileIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
    && value.length <= SOCIAL_IDENTITY_MAX_LENGTH && value.trim() === value;
}

function mapFollow(row: CollectionFollowRow): CollectionFollowRecord {
  if (!OPAQUE_ID.test(row.collection_id)
      || !isProfileIdentity(row.follower_profile_id)
      || !(row.followed_at instanceof Date)
      || !Number.isFinite(row.followed_at.getTime())) {
    throw new CollectionFollowAuthorityError(
      'invalid_collection_follow_record',
      'PostgreSQL returned invalid Collection Follow authority facts.',
    );
  }
  return Object.freeze({
    collectionId: row.collection_id,
    followerProfileId: row.follower_profile_id,
    followedAt: row.followed_at,
  });
}
