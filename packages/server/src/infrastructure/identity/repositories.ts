/**
 * LEGACY STATUS — partial quarantine (Task F1).
 *
 * This file backs the CURRENT product identity repositories and stays in the
 * runtime composition; only the OIDC login transaction repository
 * (`createPostgresOidcLoginTransactionRepository` and its row mapper) is
 * legacy OIDC/Logto code, deprecated by the Better Auth migration
 * (docs/development/known-backend/better-auth/better-auth-migration-development-plan.md
 * §12 Task F1; G1 ADR §11). Source retention is NOT runtime enablement.
 * Ownership: Better Auth migration lane F — new code reaches the legacy OIDC
 * surface only through `src/infrastructure/auth/legacy-oidc-boundary.ts`.
 * Keep behavior unchanged.
 */
import { sql, type Kysely } from 'kysely';
import { createPostgresCollaborationStorePort } from '../access-policy/collaboration-store.js';
import { createPostgresProductCommandReceiptPort } from '../database/product-command-receipt.js';
import {
  IdentityError,
  createSessionRotationSecrets,
  generateSessionTokenRaw,
  type AccountIdentityRepository,
  type AccountRepository,
  type IdentityClock,
  type IdentityPorts,
  type VerifiedAccountEmailPort,
  type OidcLoginTransactionRepository,
  type OidcTransactionSecretsPort,
  type PendingUnboundInvitePurgePort,
  type ProfileHandleRepository,
  type ProfileRepository,
  type SessionRepository,
  type SessionRotationSecretsPort,
} from '../../modules/identity/index.js';
import { databaseNow } from '../database/time.js';
import type { DatabaseSchema } from '../database/runtime.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
type ReportSourceInvalidationOutboxPort = {
  append(transaction: DatabaseTransaction, input: {
    readonly domainEventId: string; readonly collectionId: string; readonly sourceEventType: string;
    readonly sourceEventVersion: number; readonly contentRevision: string; readonly policyRevision: string; readonly commitOrdinal: bigint;
  }): Promise<void>;
  appendSeries?(transaction: DatabaseTransaction, input: {
    readonly domainEventId: string; readonly seriesId: string; readonly slug: string;
    readonly revision: string; readonly commitOrdinal: bigint;
  }): Promise<void>;
};
import {
  mapAccount,
  mapAccountIdentity,
  mapOidcLoginTransaction,
  mapProfile,
  mapProfileHandle,
  mapSession,
} from './mappers.js';

export function createPostgresAccountRepository(
  transaction: DatabaseTransaction,
  options: { readonly reportSourceInvalidation?: ReportSourceInvalidationOutboxPort } = {},
): AccountRepository {
  return {
    async findById(id) {
      const row = await transaction.selectFrom('accounts').selectAll()
        .where('id', '=', id).executeTakeFirst();
      return row ? mapAccount(row) : null;
    },
    async findBySubjectId(subjectId) {
      const row = await transaction.selectFrom('accounts').selectAll()
        .where('subject_id', '=', subjectId).executeTakeFirst();
      return row ? mapAccount(row) : null;
    },
    async findByEmail(email) {
      const row = await transaction.selectFrom('accounts').selectAll()
        .where('email', '=', email).executeTakeFirst();
      return row ? mapAccount(row) : null;
    },
    async insert(account) {
      await transaction.insertInto('accounts').values({
        id: account.id,
        subject_id: account.subjectId,
        status: account.status,
        email: account.email,
        security_epoch: account.securityEpoch,
        created_at: account.createdAt,
        deleted_at: account.deletedAt,
      }).execute();
    },
    async bumpSecurityEpoch(accountId) {
      const row = await transaction.updateTable('accounts')
        .set({
          security_epoch: sql<bigint>`security_epoch + 1`,
          security_epoch_bumped_at: sql<Date>`current_timestamp`,
        })
        .where('id', '=', accountId)
        .returning('security_epoch')
        .executeTakeFirst();
      if (!row) throw new Error('account was not found for security epoch bump');
      return typeof row.security_epoch === 'bigint'
        ? row.security_epoch
        : BigInt(row.security_epoch);
    },
    async updateEmail(accountId, email) {
      const result = await transaction.updateTable('accounts')
        .set({ email })
        .where('id', '=', accountId)
        .executeTakeFirst();
      if (Number(result.numUpdatedRows) !== 1) {
        throw new Error('account was not found for email update');
      }
    },
    async markDeleted(accountId, deletedAt) {
      const account = await transaction.selectFrom('accounts').select('subject_id').where('id', '=', accountId).executeTakeFirst();
      if (!account) throw new Error('account was not found for delete');
      const result = await transaction.updateTable('accounts')
        .set({
          status: 'deleted',
          deleted_at: deletedAt,
          email: null,
        })
        .where('id', '=', accountId)
        .executeTakeFirst();
      if (Number(result.numUpdatedRows) !== 1) {
        throw new Error('account was not found for delete');
      }
      if (options.reportSourceInvalidation) {
        const collections = await transaction.selectFrom('collections').select(['id', 'content_revision', 'policy_revision', 'commit_ordinal']).where('owner_subject_id', '=', account.subject_id).execute();
        for (const collection of collections) await options.reportSourceInvalidation.append(transaction, {
          domainEventId: `identity:account-deleted:${accountId}:${collection.id}`,
          collectionId: collection.id,
          sourceEventType: 'identity.account.lifecycle',
          sourceEventVersion: 1,
          contentRevision: collection.content_revision,
          policyRevision: collection.policy_revision,
          commitOrdinal: BigInt(collection.commit_ordinal),
        });
        // Collection invalidation covers source-fenced issues.  A series may
        // have no remaining edition/source row (or may only contain detached
        // issues), so independently purge every historical public report slug
        // owned by the account while the old owner identity is still visible
        // in this transaction.  This event is intentionally best-effort only
        // when the optional appendSeries seam is absent (N-1 composition).
        if (options.reportSourceInvalidation.appendSeries) {
          const series = await transaction.selectFrom('digest_series')
            .select(['id', 'slug', 'resource_revision', 'commit_ordinal'])
            .where('owner_subject_id', '=', account.subject_id)
            .where('slug', 'is not', null)
            .execute();
          for (const report of series) {
            if (report.slug === null) continue;
            await options.reportSourceInvalidation.appendSeries(transaction, {
              domainEventId: `identity:account-deleted-series:${accountId}:${report.id}`,
              seriesId: report.id,
              slug: report.slug,
              revision: report.resource_revision,
              commitOrdinal: BigInt(report.commit_ordinal),
            });
          }
        }
      }
    },
  };
}

/**
 * Exact match on lower(accounts.email) after the caller has already normalized.
 * Requires active, not-deleted, and Better Auth mailbox proof (emailVerified).
 * Unverified occupancy and misses both return null.
 */
export function createPostgresVerifiedAccountEmailPort(
  transaction: DatabaseTransaction,
): VerifiedAccountEmailPort {
  return {
    async findVerifiedActiveAccountByEmail(email) {
      const row = await transaction
        .selectFrom('accounts')
        .innerJoin('auth_user_account_map', 'auth_user_account_map.account_id', 'accounts.id')
        .innerJoin('auth_users', 'auth_users.id', 'auth_user_account_map.auth_user_id')
        .selectAll('accounts')
        .where(sql<string>`lower(accounts.email)`, '=', email)
        .where('accounts.status', '=', 'active')
        .where('accounts.deleted_at', 'is', null)
        .where('auth_users.emailVerified', '=', true)
        .executeTakeFirst();
      if (!row) return null;
      return { id: row.id, subjectId: row.subject_id, email: row.email ?? email };
    },
  };
}

export function createPostgresAccountIdentityRepository(
  transaction: Kysely<DatabaseSchema>,
): AccountIdentityRepository {
  return {
    async findByIssuerSubject(issuer, subject) {
      const row = await transaction.selectFrom('account_identities').selectAll()
        .where('issuer', '=', issuer)
        .where('subject', '=', subject)
        .executeTakeFirst();
      return row ? mapAccountIdentity(row) : null;
    },
    async findByAccountId(accountId) {
      const row = await transaction.selectFrom('account_identities').selectAll()
        .where('account_id', '=', accountId)
        .executeTakeFirst();
      return row ? mapAccountIdentity(row) : null;
    },
    async insert(identity) {
      await transaction.insertInto('account_identities').values({
        id: identity.id,
        account_id: identity.accountId,
        issuer: identity.issuer,
        subject: identity.subject,
        created_at: identity.createdAt,
      }).execute();
    },
    async insertIfAbsent(identity) {
      const inserted = await transaction.insertInto('account_identities').values({
        id: identity.id,
        account_id: identity.accountId,
        issuer: identity.issuer,
        subject: identity.subject,
        created_at: identity.createdAt,
      }).onConflict((oc) => oc.columns(['issuer', 'subject']).doNothing())
        .returningAll()
        .executeTakeFirst();
      if (inserted) return mapAccountIdentity(inserted);
      const existing = await transaction.selectFrom('account_identities').selectAll()
        .where('issuer', '=', identity.issuer)
        .where('subject', '=', identity.subject)
        .executeTakeFirst();
      if (!existing) {
        throw new Error('account identity conflict without visible winner');
      }
      return mapAccountIdentity(existing);
    },
  };
}

export function createPostgresProfileRepository(
  transaction: DatabaseTransaction,
): ProfileRepository {
  return {
    async findByAccountId(accountId) {
      const row = await transaction.selectFrom('profiles').selectAll()
        .where('account_id', '=', accountId).executeTakeFirst();
      return row ? mapProfile(row) : null;
    },
    async insert(profile) {
      await transaction.insertInto('profiles').values({
        account_id: profile.accountId,
        display_name: profile.displayName,
        avatar_url: profile.avatarUrl,
        about: profile.about,
        updated_at: profile.updatedAt,
      }).execute();
    },
    async update(profile) {
      // Upload ownership is established by storage preparation. The database
      // reference trigger rejects foreign/unverified objects; historical
      // governance attribution must never be promoted by a profile patch.
      const result = await transaction.updateTable('profiles').set({
        display_name: profile.displayName,
        avatar_url: profile.avatarUrl,
        about: profile.about,
        updated_at: profile.updatedAt,
      }).where('account_id', '=', profile.accountId).executeTakeFirst().catch((error: unknown) => {
        if (typeof error === 'object' && error !== null && 'constraint' in error
          && error.constraint === 'avatar_upload_ownership') {
          throw new IdentityError('invalid_identity_input', 'Avatar must be an uploaded object owned by this account.');
        }
        throw error;
      });
      if (Number(result.numUpdatedRows) !== 1) {
        throw new Error('profile was not found for update');
      }
    },
  };
}

export function createPostgresProfileHandleRepository(
  transaction: DatabaseTransaction,
): ProfileHandleRepository {
  return {
    async findByHandle(handle) {
      const row = await transaction.selectFrom('profile_handles').selectAll()
        .where('handle', '=', handle).executeTakeFirst();
      return row ? mapProfileHandle(row) : null;
    },
    async findByAccountId(accountId) {
      const row = await transaction.selectFrom('profile_handles').selectAll()
        .where('account_id', '=', accountId).executeTakeFirst();
      return row ? mapProfileHandle(row) : null;
    },
    async insert(handle) {
      await transaction.insertInto('profile_handles').values({
        handle: handle.handle,
        account_id: handle.accountId,
        created_at: handle.createdAt,
      }).execute();
    },
    async tryInsert(handle) {
      const inserted = await transaction.insertInto('profile_handles').values({
        handle: handle.handle,
        account_id: handle.accountId,
        created_at: handle.createdAt,
      }).onConflict((oc) => oc.doNothing())
        .returning('handle')
        .executeTakeFirst();
      return inserted !== undefined;
    },
    async deleteByAccountId(accountId) {
      const result = await transaction.deleteFrom('profile_handles')
        .where('account_id', '=', accountId).executeTakeFirst();
      return Number(result.numDeletedRows) > 0;
    },
    async deleteByHandle(handle) {
      const result = await transaction.deleteFrom('profile_handles')
        .where('handle', '=', handle).executeTakeFirst();
      return Number(result.numDeletedRows) > 0;
    },
  };
}

export function createPostgresSessionRepository(
  transaction: DatabaseTransaction,
): SessionRepository {
  return {
    async findById(id) {
      const row = await transaction.selectFrom('sessions').selectAll()
        .where('id', '=', id).executeTakeFirst();
      return row ? mapSession(row) : null;
    },
    async findByTokenHash(tokenHash) {
      const row = await transaction.selectFrom('sessions').selectAll()
        .where('token_hash', '=', tokenHash).executeTakeFirst();
      return row ? mapSession(row) : null;
    },
    async findLiveSuccessorByRotatedFrom(predecessorSessionId) {
      const row = await transaction.selectFrom('sessions').selectAll()
        .where('rotated_from_session_id', '=', predecessorSessionId)
        .where('revoked_at', 'is', null)
        .executeTakeFirst();
      return row ? mapSession(row) : null;
    },
    async insert(session) {
      await transaction.insertInto('sessions').values({
        id: session.id,
        account_id: session.accountId,
        idle_expires_at: session.idleExpiresAt,
        absolute_expires_at: session.absoluteExpiresAt,
        csrf_token_hash: session.csrfTokenHash,
        token_hash: session.tokenHash,
        security_epoch: session.securityEpoch,
        rotated_from_session_id: session.rotatedFromSessionId,
        last_seen_at: session.lastSeenAt,
        revoked_at: session.revokedAt,
        created_at: session.createdAt,
      }).execute();
    },
    async revoke(sessionId, revokedAt) {
      const result = await transaction.updateTable('sessions')
        .set({ revoked_at: revokedAt })
        .where('id', '=', sessionId)
        .where('revoked_at', 'is', null)
        .executeTakeFirst();
      return Number(result.numUpdatedRows) === 1;
    },
    async touch(sessionId, lastSeenAt, idleExpiresAt) {
      const result = await transaction.updateTable('sessions')
        .set({
          last_seen_at: lastSeenAt,
          idle_expires_at: idleExpiresAt,
        })
        .where('id', '=', sessionId)
        .where('revoked_at', 'is', null)
        .executeTakeFirst();
      return Number(result.numUpdatedRows) === 1;
    },
    async revokeAllForAccount(accountId, revokedAt) {
      const result = await transaction.updateTable('sessions')
        .set({ revoked_at: revokedAt })
        .where('account_id', '=', accountId)
        .where('revoked_at', 'is', null)
        .executeTakeFirst();
      return Number(result.numUpdatedRows);
    },
  };
}

/**
 * @deprecated Legacy OIDC login transaction repository (Task F1 quarantine);
 *   superseded by the Better Auth auth tables (Task B1).
 */
export function createPostgresOidcLoginTransactionRepository(
  transaction: DatabaseTransaction,
): OidcLoginTransactionRepository {
  return {
    async insert(oidcTransaction) {
      await transaction.insertInto('oidc_login_transactions').values({
        state_hash: oidcTransaction.stateHash,
        nonce_hash: oidcTransaction.nonceHash,
        pkce_verifier_ciphertext: oidcTransaction.pkceVerifierCiphertext,
        encryption_key_id: oidcTransaction.encryptionKeyId,
        encryption_key_version: oidcTransaction.encryptionKeyVersion,
        return_to: oidcTransaction.returnTo,
        created_at: oidcTransaction.createdAt,
        expires_at: oidcTransaction.expiresAt,
        consumed_at: oidcTransaction.consumedAt,
        code_challenge_method: oidcTransaction.codeChallengeMethod,
      }).execute();
    },
    async consume(_browserState, now, stateDigest) {
      // CAS: only one concurrent consumer succeeds (state_hash lookup).
      const row = await transaction.updateTable('oidc_login_transactions')
        .set({ consumed_at: now })
        .where('state_hash', '=', stateDigest)
        .where('consumed_at', 'is', null)
        .where('expires_at', '>', now)
        .returningAll()
        .executeTakeFirst();
      return row ? mapOidcLoginTransaction(row) : null;
    },
    async findByState(_browserState, stateDigest) {
      const row = await transaction.selectFrom('oidc_login_transactions').selectAll()
        .where('state_hash', '=', stateDigest)
        .executeTakeFirst();
      return row ? mapOidcLoginTransaction(row) : null;
    },
    async deleteByState(_browserState, stateDigest) {
      const result = await transaction.deleteFrom('oidc_login_transactions')
        .where('state_hash', '=', stateDigest)
        .executeTakeFirst();
      return Number(result.numDeletedRows) > 0;
    },
  };
}

export function createPostgresIdentityClock(
  transaction: DatabaseTransaction,
): IdentityClock {
  return {
    now: () => databaseNow(transaction),
  };
}

/** Builds a full IdentityPorts set bound to one database transaction. */
export function createPostgresIdentityPorts(
  transaction: DatabaseTransaction,
  oidcTransactionSecrets: OidcTransactionSecretsPort,
  sessionRotationSecrets: SessionRotationSecretsPort = DEFAULT_SESSION_ROTATION_SECRETS,
  options: { readonly reportSourceInvalidation?: ReportSourceInvalidationOutboxPort } = {},
): IdentityPorts {
  const store = createPostgresCollaborationStorePort(transaction);
  const pendingUnboundInvites: PendingUnboundInvitePurgePort = {
    async revokePendingUnboundInvitesByEmail(emailNormalized, now) {
      return store.revokePendingUnboundInvitesByEmail(emailNormalized, now);
    },
  };
  return {
    accounts: createPostgresAccountRepository(transaction, options),
    accountIdentities: createPostgresAccountIdentityRepository(transaction),
    profiles: createPostgresProfileRepository(transaction),
    handles: createPostgresProfileHandleRepository(transaction),
    sessions: createPostgresSessionRepository(transaction),
    oidcLoginTransactions: createPostgresOidcLoginTransactionRepository(transaction),
    oidcTransactionSecrets,
    sessionRotationSecrets,
    clock: createPostgresIdentityClock(transaction),
    receipts: createPostgresProductCommandReceiptPort(transaction),
    pendingUnboundInvites,
  };
}

const DEFAULT_SESSION_ROTATION_SECRETS = createSessionRotationSecrets(generateSessionTokenRaw());
