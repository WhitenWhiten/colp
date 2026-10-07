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
 * Bind or reuse the single account_identities row for an extension credential.
 *
 * Lookup order matches the historical bootstrap helper:
 * 1. (issuer, subject) — mismatching account_id is invalid_token
 * 2. account_id — reuse the stored issuer/subject (migrated OIDC bindings)
 * 3. insert; on conflict retry the same two lookups; still conflicting → invalid_token
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
  } catch {
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
