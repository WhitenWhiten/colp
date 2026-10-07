/**
 * Task A2: ensure a Better Auth user has exactly one Know-N business account.
 *
 * Establishment contract (plan §8 Task A2; G1 ADR §11):
 * - a NEW business account is created with a Know-N account.id and a
 *   subject_id bound to the Better Auth user.id (ADR D3; not independently
 *   generated; immutable once written); profile, handle and mapping are
 *   written in ONE PostgreSQL transaction — a failure rolls the whole batch
 *   back, so there is never an auth user without a mapping or a business
 *   account without profile/handle;
 * - an EXISTING account for the same email is adopted (mapping only) ONLY
 *   after a verified email proof (`emailProofVerified`) or an explicit link
 *   command (`explicitLink`); a provider callback's bare email claim never
 *   merges (no email-fallback mapping);
 * - concurrent first logins for the same auth user converge on the winner:
 *   the loser's insert conflict aborts its transaction (rolling back its
 *   provisional account/profile/handle) and the facade re-resolves the
 *   committed winner mapping in a fresh transaction;
 * - an account already mapped to a DIFFERENT auth user stays a stable
 *   duplicate_mapping error (never silently attached);
 * - a later verified proof (or explicit link) on an EXISTING mapping fills
 *   a null `accounts.email` idempotently and never rewrites a different
 *   address unless `allowEmailChange` is set (P9 change-email, not session).
 *   Replacing a different address bumps `security_epoch` in that transaction.
 */
import {
  IdentityError,
  assertNonEmpty,
  ensureAccountHandle,
  generateOpaqueId,
  type Account,
  type AuthUserAccountMapping,
  type MappedBusinessAccount,
  type Profile,
  type ProfileHandle,
} from '../../identity/index.js';
import {
  BusinessAccountMappingError,
  assertAccountUsable,
  resolveMappedBusinessAccount,
  type BusinessAccountPorts,
  type BusinessAccountUnitOfWork,
} from './business-account-mapping.js';

export interface EnsureBusinessAccountInput {
  /** Better Auth user id (auth_users.id). */
  readonly authUserId: string;
  /** The Better Auth user's email claim (auth_users.email); may be null. */
  readonly email: string | null;
  /**
   * Verified email proof (email OTP / email-verification claim). Enables
   * adoption of an existing account holding the same email.
   */
  readonly emailProofVerified: boolean;
  /** Explicit link command issued from an authenticated session (C3). Enables adoption. */
  readonly explicitLink?: boolean;
  /**
   * P9 change-email / afterEmailVerification: allow replacing a different
   * existing `accounts.email`. Session create-after must leave this false so
   * a later login cannot overwrite a product address that P9 already set.
   */
  readonly allowEmailChange?: boolean;
  /** Display name for a freshly created profile (optional). */
  readonly displayName?: string;
  /** Requested profile handle for a freshly created account (optional). */
  readonly handle?: string;
}

export interface BusinessAccountApplicationPorts {
  readonly unitOfWork: BusinessAccountUnitOfWork;
}

/**
 * Ensure the auth user has a business account. Idempotent for repeated
 * requests; see the module contract above for adoption and concurrency rules.
 */
export async function ensureBusinessAccountForVerifiedEmail(
  input: EnsureBusinessAccountInput,
  deps: BusinessAccountApplicationPorts,
): Promise<MappedBusinessAccount> {
  const authUserId = assertNonEmpty(input.authUserId, 'authUserId');
  const resolvedInput: EnsureBusinessAccountInput = { ...input, authUserId };
  try {
    return await deps.unitOfWork.execute(async (ports) => {
      const existing = await ports.mappings.findByAuthUserId(authUserId);
      if (existing) return confirmMappedBusinessAccount(ports, existing, resolvedInput);
      return createBusinessAccount(ports, resolvedInput);
    });
  } catch (error) {
    if (isConcurrentInsertError(error)) {
      // A concurrent request committed the mapping between our read and our
      // insert (same auth user raced) or claimed the account (another auth
      // user adopted it). Re-read in a fresh transaction: same-user races
      // converge on the winner; account-level conflicts keep their stable
      // error classification. The winner may still have a null product email
      // (unproved occupancy) — a verified proof fills it on this retry.
      return deps.unitOfWork.execute(async (ports) => {
        const mapping = await ports.mappings.findByAuthUserId(authUserId);
        if (!mapping) throw error;
        return confirmMappedBusinessAccount(ports, mapping, resolvedInput);
      });
    }
    throw error;
  }
}

function isConcurrentInsertError(error: unknown): boolean {
  return error instanceof BusinessAccountMappingError
    && (error.code === 'duplicate_mapping' || error.code === 'email_conflict');
}

/**
 * Mapping already exists: resolve the account, then optionally fill a null
 * product email (or, with allowEmailChange, replace a different address).
 */
async function confirmMappedBusinessAccount(
  ports: BusinessAccountPorts,
  mapping: AuthUserAccountMapping,
  input: EnsureBusinessAccountInput,
): Promise<MappedBusinessAccount> {
  const resolved = await resolveMappedBusinessAccount(ports, mapping);
  const proof = input.emailProofVerified || input.explicitLink === true;
  const normalized = normalizeBusinessEmail(input.email);
  if (!proof || normalized === null) return resolved;
  return applyVerifiedProductEmail(ports, resolved, normalized, {
    replaceExisting: input.allowEmailChange === true,
  });
}

async function applyVerifiedProductEmail(
  ports: BusinessAccountPorts,
  resolved: MappedBusinessAccount,
  normalized: string,
  options: { readonly replaceExisting: boolean },
): Promise<MappedBusinessAccount> {
  const current = normalizeBusinessEmail(resolved.account.email);
  if (current === normalized) return resolved;
  // Session / occupancy establishment must only fill null. A different
  // existing address is the P9 change-email path (`allowEmailChange`).
  if (current !== null && !options.replaceExisting) return resolved;

  const holder = await ports.accounts.findByEmail(normalized);
  if (holder && holder.id !== resolved.account.id) {
    throw new BusinessAccountMappingError(
      'email_conflict',
      'email is already associated with another account',
    );
  }
  try {
    await ports.accounts.updateEmail(resolved.account.id, normalized);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new BusinessAccountMappingError(
        'email_conflict',
        'email is already associated with another account',
      );
    }
    throw error;
  }
  // P9 / afterEmailVerification: the old mailbox no longer belongs to this
  // account. Pending unbound invites for that address must die here so a
  // later occupant cannot accept them. Bound invites stay subject-bound.
  let securityEpoch = resolved.account.securityEpoch;
  if (current !== null) {
    const now = await ports.clock.now();
    await ports.pendingUnboundInvites.revokePendingUnboundInvitesByEmail(current, now);
    // revokeAll cannot join this transaction; it bumps through the same primitive.
    securityEpoch = await ports.accounts.bumpSecurityEpoch(resolved.account.id);
  }
  return { ...resolved, account: { ...resolved.account, email: normalized, securityEpoch } };
}

function normalizeBusinessEmail(email: string | null | undefined): string | null {
  if (typeof email !== 'string') return null;
  const normalized = email.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

async function createBusinessAccount(
  ports: BusinessAccountPorts,
  input: EnsureBusinessAccountInput,
): Promise<MappedBusinessAccount> {
  const adoptionAllowed = input.emailProofVerified || input.explicitLink === true;
  const email = adoptionAllowed ? normalizeBusinessEmail(input.email) : null;

  if (email !== null) {
    const holder = await ports.accounts.findByEmail(email);
    if (holder) return adoptExistingAccount(ports, holder, input.authUserId);
  }
  return createFreshAccount(ports, input, email);
}

/**
 * Adopt an existing business account for the auth user: writes ONLY the
 * mapping row. The account/profile/handle already exist by definition; the
 * adoption is conditional on a verified email proof or an explicit link
 * command (checked by the caller).
 */
async function adoptExistingAccount(
  ports: BusinessAccountPorts,
  account: Account,
  authUserId: string,
): Promise<MappedBusinessAccount> {
  assertAccountUsable(account);
  const now = await ports.clock.now();
  const mapping: AuthUserAccountMapping = { authUserId, accountId: account.id, createdAt: now };
  await ports.mappings.insert(mapping);
  const profile = await ports.profiles.findByAccountId(account.id);
  const handle = await ports.handles.findByAccountId(account.id);
  return { mapping, account, profile, handle };
}

async function createFreshAccount(
  ports: BusinessAccountPorts,
  input: EnsureBusinessAccountInput,
  email: string | null,
): Promise<MappedBusinessAccount> {
  const now = await ports.clock.now();
  const account: Account = {
    id: generateOpaqueId(),
    subjectId: input.authUserId,
    status: 'active',
    email,
    securityEpoch: 0n,
    createdAt: now,
    deletedAt: null,
  };
  try {
    await ports.accounts.insert(account);
  } catch (error) {
    if (isUniqueViolation(error)) {
      // The verified email, or a leftover unmapped subject_id equal to this
      // BA user.id, was claimed by a concurrent transaction; never merge
      // silently.
      throw new BusinessAccountMappingError(
        'email_conflict',
        'email is already associated with another account',
      );
    }
    throw error;
  }

  const profile: Profile = {
    accountId: account.id,
    displayName: input.displayName ?? '',
    avatarUrl: null,
    about: '',
    updatedAt: now,
  };
  await ports.profiles.insert(profile);

  let handle: ProfileHandle;
  try {
    handle = await ensureAccountHandle(ports, account.id, input.handle);
  } catch (error) {
    if (error instanceof IdentityError && error.code === 'handle_taken') {
      throw new BusinessAccountMappingError('handle_collision', 'profile handle is already taken');
    }
    throw error;
  }

  const mapping: AuthUserAccountMapping = { authUserId: input.authUserId, accountId: account.id, createdAt: now };
  await ports.mappings.insert(mapping);
  return { mapping, account, profile, handle };
}

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  if (code === '23505') return true;
  if ((error as { kind?: unknown }).kind === 'unique_violation') return true;
  const cause = (error as { cause?: unknown }).cause;
  return cause !== undefined && cause !== error && isUniqueViolation(cause);
}
