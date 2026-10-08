import { sql, type Kysely } from 'kysely';
import type { AccountDeletionStore } from '../../modules/auth/index.js';
import type { DatabaseSchema } from '../database/runtime.js';
import { createUnitOfWork, type UnitOfWorkOptions } from '../database/unit-of-work.js';
import { createPostgresAccountRepository } from '../identity/repositories.js';
import { deleteTrustDeviceVerificationsForAuthUser } from './better-auth-session-authority.js';

/** All auth tables live in this database; FK cascades participate in the tombstone transaction. */
export function createPostgresAccountDeletionStore(
  db: Kysely<DatabaseSchema>,
  options: UnitOfWorkOptions & NonNullable<Parameters<typeof createPostgresAccountRepository>[1]> = {},
): AccountDeletionStore {
  const uow = createUnitOfWork(db, options);
  return {
    async complete(accountId, authUserId) {
      await uow.execute(async ({ transaction }) => {
        const account = await transaction.selectFrom('accounts').selectAll()
          .where('id', '=', accountId).forUpdate().executeTakeFirstOrThrow();
        const mapping = await transaction.selectFrom('auth_user_account_map').select('account_id')
          .where('auth_user_id', '=', authUserId).executeTakeFirst();
        if (!mapping && account.status === 'deleted') return; // Fully committed retry.
        if (mapping?.account_id !== accountId) throw new Error('Account deletion identity mismatch');
        const accounts = createPostgresAccountRepository(transaction, options);
        await accounts.bumpSecurityEpoch(accountId);
        await transaction.updateTable('sessions').set({ revoked_at: new Date() })
          .where('account_id', '=', accountId).where('revoked_at', 'is', null).execute();
        // Manager account deletion is a credential security event. Revoke
        // every parent and child credential managed by this account in the
        // same transaction, while the manager row is locked above. This also
        // closes the issuance/deletion race: issuance takes the same manager
        // row lock before inserting a child.
        const revokedAt = new Date();
        await transaction.updateTable('account_credentials').set({
          state: 'revoked',
          revoked_at: revokedAt,
          revoke_reason: 'manager_account_deleted',
          revision: sql<bigint>`revision + 1`,
        })
          .where('manager_account_id', '=', accountId)
          .where('state', '=', 'active')
          .execute();
        await deleteTrustDeviceVerificationsForAuthUser(transaction, authUserId);
        await accounts.markDeleted(accountId, revokedAt);
        // Includes password/provider credentials, browser sessions, MFA and OAuth rows.
        await transaction.deleteFrom('auth_users').where('id', '=', authUserId).execute();
      });
    },
  };
}
