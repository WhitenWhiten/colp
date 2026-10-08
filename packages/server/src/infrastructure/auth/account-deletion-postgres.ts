import type { Kysely } from 'kysely';
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
        await deleteTrustDeviceVerificationsForAuthUser(transaction, authUserId);
        await accounts.markDeleted(accountId, new Date());
        // Includes password/provider credentials, browser sessions, MFA and OAuth rows.
        await transaction.deleteFrom('auth_users').where('id', '=', authUserId).execute();
      });
    },
  };
}
