import { sql, type Kysely } from 'kysely';
import type { AccountDeletionStore } from '../../modules/auth/index.js';
import type { DatabaseSchema } from '../database/runtime.js';
import { createUnitOfWork, type DatabaseTransaction, type UnitOfWorkOptions } from '../database/unit-of-work.js';
import { createPostgresAccountRepository } from '../identity/repositories.js';
import { deleteTrustDeviceVerificationsForAuthUser } from './better-auth-session-authority.js';

/**
 * Transaction-bound collection policy_revision lock/bump. Structurally
 * compatible with the access-policy `CollectionPolicyRevisionPort`; bootstrap
 * injects the PostgreSQL implementation (`createPostgresCollectionPolicyRevisionPort`
 * from infrastructure/collections, which also appends the publication purge
 * outbox envelope) so this auth surface does not depend on the collections
 * infrastructure. The dependency is required: account deletion must always
 * advance owned collections' policy epochs inside the tombstone transaction.
 */
export interface AccountDeletionCollectionPolicyRevisionPort {
  lockForUpdate(collectionId: string): Promise<unknown | null>;
  bumpPolicyRevision(collectionId: string): Promise<unknown>;
}

export interface AccountDeletionStoreOptions {
  readonly publicationCacheInvalidator?: AccountDeletionPublicationCacheInvalidator;
  /** Builds the policy_revision port bound to the deletion transaction. */
  readonly collectionPolicyRevisions: (
    transaction: DatabaseTransaction,
  ) => AccountDeletionCollectionPolicyRevisionPort;
}

export interface AccountDeletionPublicationCacheInvalidator {
  readonly rotateCollection: (scope: Readonly<{
    readonly collectionId: string;
    readonly publicationSlug: string;
    readonly signal: AbortSignal;
  }>) => Promise<void>;
  readonly rotateDirectory: (signal: AbortSignal) => Promise<void>;
}

/** All auth tables live in this database; FK cascades participate in the tombstone transaction. */
export function createPostgresAccountDeletionStore(
  db: Kysely<DatabaseSchema>,
  options: UnitOfWorkOptions
    & NonNullable<Parameters<typeof createPostgresAccountRepository>[1]>
    & AccountDeletionStoreOptions,
): AccountDeletionStore {
  if (typeof options.collectionPolicyRevisions !== 'function') {
    throw new TypeError('createPostgresAccountDeletionStore requires a collectionPolicyRevisions port factory.');
  }
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
        // Public publication caches key their visibility by the collection
        // policy epoch.  Advance every collection owned by this account while
        // the account row is still active so anonymous snapshot, directory,
        // and metadata cache entries cannot survive account deletion.
        const policyRevisions = options.collectionPolicyRevisions(transaction);
        const ownedCollections = await transaction
          .selectFrom('collections')
          .select(['id', 'publication_slug'])
          .where('owner_subject_id', '=', account.subject_id)
          .where('deleted_at', 'is', null)
          .execute();
        for (const collection of ownedCollections) {
          const locked = await policyRevisions.lockForUpdate(collection.id);
          if (locked !== null) await policyRevisions.bumpPolicyRevision(collection.id);
          // Read the slug again after taking the collection lock. A publish or
          // unpublish racing with account deletion must invalidate the slug
          // that was authoritative at the deletion boundary, not the value
          // observed by the unlocked owner scan above.
          const current = locked === null
            ? undefined
            : await transaction.selectFrom('collections')
              .select(['publication_slug', 'published_at'])
              .where('id', '=', collection.id)
              .executeTakeFirst();
          if (current?.publication_slug !== null && current?.publication_slug !== undefined
            && current.published_at !== null && current.published_at !== undefined
            && options.publicationCacheInvalidator !== undefined) {
            await options.publicationCacheInvalidator.rotateCollection({
              collectionId: collection.id,
              publicationSlug: current.publication_slug,
              signal: new AbortController().signal,
            });
          }
        }
        if (ownedCollections.length > 0 && options.publicationCacheInvalidator !== undefined) {
          await options.publicationCacheInvalidator.rotateDirectory(new AbortController().signal);
        }
        await accounts.markDeleted(accountId, revokedAt);
        // Includes password/provider credentials, browser sessions, MFA and OAuth rows.
        await transaction.deleteFrom('auth_users').where('id', '=', authUserId).execute();
      });
    },
  };
}
