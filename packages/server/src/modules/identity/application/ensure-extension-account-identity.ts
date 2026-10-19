import { generateOpaqueId } from '../domain/index.js';
import {
  ExtensionAuthError,
  type ExtensionIdentityBinding,
} from '../extension-auth.js';
import type { AccountIdentityRepository } from './ports.js';

export interface EnsureExtensionAccountIdentityInput {
  readonly accountId: string;
  readonly subjectId: string;
  readonly issuer: string;
}

export interface EnsureExtensionAccountIdentityOptions {
  readonly now?: () => Date;
  readonly generateId?: () => string;
}

/**
 * Constraints whose violation proves a concurrent binding race on the row we
 * wanted to insert. They are recognized structurally (error kind / SQLSTATE +
 * constraint name), never by parsing driver messages.
 *
 * - `account_identities_issuer_subject_unique`: someone bound the same
 *   (issuer, subject) pair first.
 * - `account_identities_account_id_unique`: someone bound this account first.
 * - `account_identities_issuer_subject_account_unique`: the composite form of
 *   the same binding. It is logically implied by the pair constraint, but
 *   PostgreSQL reports whichever violated index it checks first, so a real
 *   race can surface under this name.
 *
 * The primary key is deliberately absent: an id collision is a caller/id
 * generation fault, not a concurrent binding to recover from.
 */
const RECOVERABLE_IDENTITY_CONSTRAINTS: ReadonlySet<string> = new Set([
  'account_identities_issuer_subject_unique',
  'account_identities_account_id_unique',
  'account_identities_issuer_subject_account_unique',
]);

/**
 * A PostgreSQL unique violation (SQLSTATE 23505) or the infrastructure
 * DatabaseOperationError equivalent (`kind: 'unique_violation'`) on one of the
 * binding constraints above. Works with both raw `pg` errors (extension
 * binding port) and unit-of-work-wrapped errors.
 */
function isRecoverableIdentityRace(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const record = error as { readonly code?: unknown; readonly kind?: unknown; readonly constraint?: unknown };
  const uniqueViolation = record.kind === 'unique_violation'
    || (typeof record.code === 'string' && record.code === '23505');
  if (!uniqueViolation) return false;
  return typeof record.constraint === 'string'
    && RECOVERABLE_IDENTITY_CONSTRAINTS.has(record.constraint);
}

/**
 * Bind or reuse the single account_identities row for an extension credential.
 *
 * Lookup order matches the historical bootstrap helper:
 * 1. (issuer, subject) — mismatching account_id is invalid_token
 * 2. account_id — reuse the stored issuer/subject (migrated OIDC bindings)
 * 3. insert; only a recognized concurrent-binding race retries the same two
 *    lookups. An unresolved true conflict is invalid_token.
 *
 * Any other insert failure (connection loss, timeout, unexpected constraint)
 * propagates unchanged, so a database outage is never reported to the client
 * as an invalid credential.
 */
export async function ensureExtensionAccountIdentity(
  identities: AccountIdentityRepository,
  input: EnsureExtensionAccountIdentityInput,
  options: EnsureExtensionAccountIdentityOptions = {},
): Promise<ExtensionIdentityBinding> {
  const byPair = await identities.findByIssuerSubject(input.issuer, input.subjectId);
  if (byPair) {
    if (byPair.accountId !== input.accountId) throw new ExtensionAuthError('invalid_token');
    return { issuer: byPair.issuer, subject: byPair.subject };
  }
  const byAccount = await identities.findByAccountId(input.accountId);
  if (byAccount) return { issuer: byAccount.issuer, subject: byAccount.subject };
  try {
    await identities.insert({
      id: options.generateId?.() ?? generateOpaqueId(),
      accountId: input.accountId,
      issuer: input.issuer,
      subject: input.subjectId,
      createdAt: options.now?.() ?? new Date(),
    });
  } catch (error: unknown) {
    if (!isRecoverableIdentityRace(error)) throw error;
    const retryAccount = await identities.findByAccountId(input.accountId);
    if (retryAccount) return { issuer: retryAccount.issuer, subject: retryAccount.subject };
    const retryPair = await identities.findByIssuerSubject(input.issuer, input.subjectId);
    if (retryPair && retryPair.accountId === input.accountId) {
      return { issuer: retryPair.issuer, subject: retryPair.subject };
    }
    throw new ExtensionAuthError('invalid_token');
  }
  return { issuer: input.issuer, subject: input.subjectId };
}
