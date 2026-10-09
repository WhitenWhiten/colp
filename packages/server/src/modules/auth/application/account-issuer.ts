/**
 * Server-owned `auth_accounts.issuer`.
 *
 * Better Auth 1.7.0–1.7.2 keyed account identity by `(issuer, accountId)`
 * and wrote `issuer` itself; migration 202609230100 made the column
 * `NOT NULL` with a unique `(issuer, accountId)` index and backfilled it.
 * Better Auth 1.7.3+ (#11153) reverted that: the SDK no longer declares,
 * writes or reads `issuer` and identifies accounts by `(providerId,
 * accountId)` again. The upstream guidance is to relax the column; this
 * product keeps it as a repo-owned identity attribute (legacy OIDC archive
 * and audit evidence join on it) and assigns the value server-side on every
 * account insert through a Better Auth database hook.
 *
 * The mapping is BYTE-IDENTICAL to the 202609230100 backfill so rows written
 * under 1.7.1 and rows written here are indistinguishable:
 *   - credential → `local:credential`
 *   - siwe       → `local:siwe`
 *   - google     → `https://accounts.google.com` (1.7.1 `accountIssuer`)
 *   - other      → `local:oauth:` + encodeURIComponent(providerId)
 *
 * Because the value is a pure function of `providerId`, `(issuer, accountId)`
 * uniqueness is equivalent to the SDK's `(providerId, accountId)` identity:
 * the same external subject at two providers stays two rows, and one
 * provider cannot alias another. The value is never accepted from request
 * input (`input: false`) and incoming `issuer` fields are overwritten.
 */

export const LOCAL_CREDENTIAL_ACCOUNT_ISSUER = 'local:credential';
export const LOCAL_SIWE_ACCOUNT_ISSUER = 'local:siwe';
export const GOOGLE_ACCOUNT_ISSUER = 'https://accounts.google.com';
const LOCAL_OAUTH_ACCOUNT_ISSUER_PREFIX = 'local:oauth:';

/** Provider ids that carried a real issuer in Better Auth 1.7.1 AND in the backfill. */
const PROVIDER_ISSUERS: Readonly<Record<string, string>> = Object.freeze({
  credential: LOCAL_CREDENTIAL_ACCOUNT_ISSUER,
  siwe: LOCAL_SIWE_ACCOUNT_ISSUER,
  google: GOOGLE_ACCOUNT_ISSUER,
});

export class AccountIssuerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccountIssuerError';
  }
}

/**
 * Resolve the server-owned issuer for a Better Auth `providerId`. Throws on a
 * missing/blank provider id so a malformed account write fails closed before
 * reaching the database (never a NULL or empty issuer).
 */
export function resolveAccountIssuer(providerId: unknown): string {
  if (typeof providerId !== 'string' || providerId.trim().length === 0
      || providerId !== providerId.trim()) {
    throw new AccountIssuerError('account issuer requires a non-empty providerId');
  }
  const known = Object.hasOwn(PROVIDER_ISSUERS, providerId) ? PROVIDER_ISSUERS[providerId] : undefined;
  if (known !== undefined) return known;
  return `${LOCAL_OAUTH_ACCOUNT_ISSUER_PREFIX}${encodeURIComponent(providerId)}`;
}

/**
 * Database-hook payload transform for account inserts: always (re)assign
 * `issuer` from `providerId`, discarding whatever the caller supplied.
 * Returns a fresh object; the input is not mutated.
 */
export function withServerAccountIssuer<T extends Record<string, unknown>>(
  account: T,
): T & { readonly issuer: string } {
  return { ...account, issuer: resolveAccountIssuer(account.providerId) };
}

/**
 * Database-hook payload transform for account updates. The row invariant is
 * `issuer === resolveAccountIssuer(providerId)`:
 * - an update that carries `providerId` (Better Auth's `linkOAuthAccount`
 *   rewrites it together with tokens/scope on an existing row) gets `issuer`
 *   re-derived from THAT providerId, so the pair can never diverge;
 * - an update that carries only `issuer` has it neutralised: the value is
 *   derived, never editable, so a payload cannot move a row to another issuer.
 * Token/scope/expiry fields pass through untouched.
 *
 * Better Auth merges a `before` hook result over the original payload
 * (`{ ...data, ...result.data }`), so deleting the key would not remove it;
 * the key is set to `undefined`, which the adapter factory skips for a field
 * without `defaultValue`/`onUpdate`.
 */
export function withoutAccountIssuerUpdate<T extends Record<string, unknown>>(
  update: T,
): T | (T & { readonly issuer: string | undefined }) {
  if (Object.hasOwn(update, 'providerId') && update.providerId !== undefined) {
    return { ...update, issuer: resolveAccountIssuer(update.providerId) };
  }
  if (!Object.hasOwn(update, 'issuer')) return update;
  return { ...update, issuer: undefined };
}
