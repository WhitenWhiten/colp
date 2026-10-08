/**
 * Task A2 PostgreSQL repositories for the Better Auth ↔ business account
 * mapping (infrastructure/auth surface).
 *
 * Reuses the CURRENT product identity repositories for accounts/profiles/
 * profile_handles reads and the profile handle reservation (they are bound to
 * the same DatabaseTransaction the mapping repository uses), so the mapping
 * surface and the product identity surface can never disagree about a row.
 *
 * The mapping repository translates SQLSTATE 23505 into the stable
 * BusinessAccountMappingError('duplicate_mapping') so the application facade
 * can re-resolve concurrent first-login races in a fresh transaction
 * (PostgreSQL aborts the whole transaction on the conflict; the loser's
 * provisional account/profile/handle roll back with it).
 */
import { isPostgresErrorCode } from '../database/errors.js';
import { sql } from 'kysely';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import {
  createPostgresAccountRepository,
  createPostgresIdentityClock,
  createPostgresProfileHandleRepository,
  createPostgresProfileRepository,
} from '../identity/repositories.js';
import { createPostgresCollaborationStorePort } from '../access-policy/collaboration-store.js';
import {
  BusinessAccountMappingError,
  type BusinessAccountMappingRepository,
  type BusinessAccountPorts,
  type PendingUnboundInvitePurgePort,
} from '../../modules/auth/index.js';

export function createPostgresBusinessAccountMappingRepository(
  transaction: DatabaseTransaction,
): BusinessAccountMappingRepository {
  return {
    async findByAuthUserId(authUserId) {
      const row = await transaction.selectFrom('auth_user_account_map').selectAll()
        .where('auth_user_id', '=', authUserId)
        .executeTakeFirst();
      return row
        ? {
            authUserId: row.auth_user_id,
            accountId: row.account_id,
            createdAt: row.created_at,
          }
        : null;
    },
    async insert(mapping) {
      try {
        await transaction.insertInto('auth_user_account_map').values({
          auth_user_id: mapping.authUserId,
          account_id: mapping.accountId,
          created_at: mapping.createdAt,
        }).execute();
      } catch (error) {
        if (isPostgresErrorCode(error, '23505')) {
          throw new BusinessAccountMappingError(
            'duplicate_mapping',
            'auth user or business account is already mapped',
          );
        }
        throw error;
      }
    },
  };
}

/** Builds the full BusinessAccountPorts set bound to one database transaction. */
export function createPostgresBusinessAccountPorts(
  transaction: DatabaseTransaction,
): BusinessAccountPorts {
  const store = createPostgresCollaborationStorePort(transaction);
  const pendingUnboundInvites: PendingUnboundInvitePurgePort = {
    async revokePendingUnboundInvitesByEmail(emailNormalized, now) {
      return store.revokePendingUnboundInvitesByEmail(emailNormalized, now);
    },
  };
  return {
    mappings: createPostgresBusinessAccountMappingRepository(transaction),
    accounts: createPostgresAccountRepository(transaction),
    profiles: createPostgresProfileRepository(transaction),
    handles: createPostgresProfileHandleRepository(transaction),
    clock: createPostgresIdentityClock(transaction),
    pendingUnboundInvites,
    async revokeOAuthRefreshTokensForAccount(accountId) {
      const result = await sql`
        UPDATE "auth_oauth_refresh_token"
        SET "revoked" = clock_timestamp()
        WHERE "userId" IN (
          SELECT auth_user_id
          FROM auth_user_account_map
          WHERE account_id = ${accountId}
        )
          AND "revoked" IS NULL
        RETURNING "id"
      `.execute(transaction);
      return result.rows.length;
    },
  };
}
