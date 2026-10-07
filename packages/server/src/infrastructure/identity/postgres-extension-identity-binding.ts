import type { Kysely } from 'kysely';
import {
  ensureExtensionAccountIdentity,
  type ExtensionIdentityBindingPort,
  type ExtensionOwnerSubjectPort,
} from '../../modules/identity/index.js';
import type { DatabaseSchema } from '../database/runtime.js';
import { createPostgresAccountIdentityRepository } from './repositories.js';

export function createPostgresExtensionIdentityBindingPort(
  db: Kysely<DatabaseSchema>,
): ExtensionIdentityBindingPort {
  const identities = createPostgresAccountIdentityRepository(db);
  return Object.freeze({
    ensure: (input: Parameters<ExtensionIdentityBindingPort['ensure']>[0]) =>
      ensureExtensionAccountIdentity(identities, input),
  });
}

/** Same identity->account resolution the sync session layer applies (P3-07). */
export function createPostgresExtensionOwnerSubjectPort(
  db: Kysely<DatabaseSchema>,
): ExtensionOwnerSubjectPort {
  return Object.freeze({
    async resolveOwnerSubject(identity: { readonly issuer: string; readonly subject: string }) {
      const row = await db.selectFrom('account_identities as identity')
        .innerJoin('accounts as account', 'account.id', 'identity.account_id')
        .select(['account.subject_id', 'account.status'])
        .where('identity.issuer', '=', identity.issuer)
        .where('identity.subject', '=', identity.subject)
        .executeTakeFirst();
      return row !== undefined && row.status === 'active' ? row.subject_id : null;
    },
  });
}

export function createPostgresExtensionOwnerAccountPort(
  db: Kysely<DatabaseSchema>,
): {
  resolveActiveAccount(identity: { readonly issuer: string; readonly subject: string }): Promise<{
    readonly accountId: string; readonly subjectId: string;
  } | null>;
} {
  return Object.freeze({
    async resolveActiveAccount(identity: { readonly issuer: string; readonly subject: string }) {
      const row = await db.selectFrom('account_identities as identity')
        .innerJoin('accounts as account', 'account.id', 'identity.account_id')
        .select(['account.id', 'account.subject_id', 'account.status'])
        .where('identity.issuer', '=', identity.issuer)
        .where('identity.subject', '=', identity.subject)
        .executeTakeFirst();
      return row !== undefined && row.status === 'active'
        ? { accountId: row.id, subjectId: row.subject_id } : null;
    },
  });
}
