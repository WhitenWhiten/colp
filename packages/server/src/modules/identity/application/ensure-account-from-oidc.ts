/**
 * LEGACY OIDC account establishment — DEPRECATED SOURCE (Task F1 quarantine).
 * Retained for audit and the legacy migration window; source retention is NOT
 * runtime enablement. Superseded by Better Auth
 * (docs/development/known-backend/better-auth/better-auth-migration-development-plan.md
 * §12 Task F1; G1 ADR §11). Ownership: Better Auth migration lane F — new
 * code reaches this surface only through
 * `src/infrastructure/auth/legacy-oidc-boundary.ts`. Keep behavior unchanged.
 *
 * @deprecated Legacy OIDC account establishment flow.
 */
import {
  IdentityError,
  assertNonEmpty,
  assertValidHandle,
  generateOpaqueId,
  resolveTrustedOidcClaims,
  type OidcClaimSyncMetrics,
  type OidcEmailTrustPolicy,
} from '../domain/index.js';
import type { Account, AccountIdentity, AccountWithProfile, Profile, ProfileHandle } from '../domain/types.js';
import type { IdentityPorts } from './ports.js';
import { ensureAccountHandle } from './handle.js';

/**
 * @deprecated Legacy OIDC account-establishment input (Task F1 quarantine).
 */
export interface EnsureAccountFromOidcInput {
  readonly issuer: string;
  readonly subject: string;
  /**
   * Raw email claim from the ID token. Only stored/synced when emailVerified
   * is true (see resolveTrustedOidcClaims).
   */
  readonly email?: string | null;
  /**
   * OIDC email_verified claim. Missing/false means the email must not be trusted.
   * Callers that already filtered claims may pass true explicitly.
   */
  readonly emailVerified?: boolean | null;
  readonly displayName?: string;
  readonly handle?: string;
  /**
   * When present (including null), treated as a provider avatar claim and
   * synchronized. Omit when the claim is absent so local avatar is preserved.
   */
  readonly avatarUrl?: string | null;
  /** Caller-supplied stable subject; generated when omitted. */
  readonly subjectId?: string;
  readonly accountId?: string;
  readonly identityId?: string;
  /** Optional tenant/provider policy override (tests and future multi-tenant). */
  readonly emailTrustPolicy?: OidcEmailTrustPolicy;
  /**
   * Optional sanitized counter sink for discarded provider pictures
   * (FIX-M-003); defaults to a no-op.
   */
  readonly metrics?: OidcClaimSyncMetrics;
}

/**
 * Find or create Account + Profile + OIDC binding for (issuer, subject).
 * Must run inside a single transaction (caller-owned or IdentityUnitOfWork).
 *
 * On repeated verified login for the same identity, mutable trusted claims
 * (email, displayName, avatar) are synchronized with explicit precedence:
 * - Identity key remains issuer+subject (never merged by email).
 * - Email is written only when policy-approved (verified).
 * - Non-empty OIDC displayName overwrites local displayName.
 * - Present avatar claim overwrites local avatarUrl; absent leaves local.
 *   A present but invalid picture is discarded to null (FIX-M-003) and
 *   counted on identity.oidc.avatar_url_rejected instead of failing login.
 * - Handle is local-only and is never overwritten on re-login.
 *
 * Concurrent first-login races are handled with insertIfAbsent on the OIDC
 * binding so the PostgreSQL transaction is not aborted on unique conflicts.
 *
 * @deprecated Legacy OIDC account establishment (Task F1 quarantine);
 *   superseded by the Better Auth business-account mapping (Task A2).
 */
export async function ensureAccountFromOidcIdentity(
  ports: IdentityPorts,
  input: EnsureAccountFromOidcInput,
): Promise<AccountWithProfile> {
  const issuer = assertNonEmpty(input.issuer, 'issuer');
  const subject = assertNonEmpty(input.subject, 'subject');
  const handle = input.handle === undefined
    ? undefined
    : assertValidHandle(input.handle).toLowerCase();

  const trusted = resolveTrustedOidcClaims({
    email: input.email,
    emailVerified: input.emailVerified,
    displayName: input.displayName,
    ...(Object.prototype.hasOwnProperty.call(input, 'avatarUrl')
      ? { avatarUrl: input.avatarUrl ?? null }
      : {}),
    emailTrustPolicy: input.emailTrustPolicy,
    metrics: input.metrics,
  });

  const existing = await ports.accountIdentities.findByIssuerSubject(issuer, subject);
  if (existing) {
    return synchronizeExistingAccount(ports, existing, trusted);
  }

  return createAccountFromOidc(ports, {
    issuer,
    subject,
    handle,
    trusted,
    subjectId: input.subjectId,
    accountId: input.accountId,
    identityId: input.identityId,
  });
}

async function createAccountFromOidc(
  ports: IdentityPorts,
  input: {
    readonly issuer: string;
    readonly subject: string;
    readonly handle: string | undefined;
    readonly trusted: ReturnType<typeof resolveTrustedOidcClaims>;
    readonly subjectId?: string;
    readonly accountId?: string;
    readonly identityId?: string;
  },
): Promise<AccountWithProfile> {
  const { issuer, subject, handle, trusted } = input;
  const email = trusted.emailTrusted ? trusted.trustedEmail : null;
  if (email !== null) {
    // Holder-aware availability gate (T-OIDC-005): compare the email holder
    // with the (issuer, subject) binding owner instead of converting any
    // concurrent binding into identity_conflict. Only a binding that belongs
    // to the email holder is the benign concurrent first-login race; every
    // other collision stays terminal email_conflict (fail closed).
    await assertEmailAvailableForCreate(ports, email, issuer, subject);
  }

  const now = await ports.clock.now();
  const accountId = input.accountId ?? generateOpaqueId();
  const subjectId = input.subjectId ?? generateOpaqueId();
  const identityId = input.identityId ?? generateOpaqueId();

  const account: Account = {
    id: accountId,
    subjectId,
    status: 'active',
    email,
    securityEpoch: 0n,
    createdAt: now,
    deletedAt: null,
  };
  const profile: Profile = {
    accountId,
    displayName: trusted.trustedDisplayName ?? '',
    avatarUrl: trusted.trustedAvatarUrl !== undefined ? trusted.trustedAvatarUrl : null,
    about: '',
    updatedAt: now,
  };
  const identity: AccountIdentity = {
    id: identityId,
    accountId,
    issuer,
    subject,
    createdAt: now,
  };

  await ports.accounts.insert(account);
  await ports.profiles.insert(profile);

  const bound = await ports.accountIdentities.insertIfAbsent(identity);
  if (bound.accountId !== accountId) {
    // Concurrent creator won (issuer, subject). Throw so the Unit of Work
    // rolls back provisional account/profile rows; caller retries ensure and
    // loads the winner.
    throw new IdentityError(
      'identity_conflict',
      'OIDC identity was claimed concurrently; retry ensure in a fresh transaction',
    );
  }

  const claimedHandle: ProfileHandle = await ensureAccountHandle(ports, accountId, handle);

  return {
    account,
    profile,
    handle: claimedHandle,
    identity: bound,
  };
}

async function synchronizeExistingAccount(
  ports: IdentityPorts,
  identity: AccountIdentity,
  trusted: ReturnType<typeof resolveTrustedOidcClaims>,
): Promise<AccountWithProfile> {
  const accountId = identity.accountId;
  const account = await ports.accounts.findById(accountId);
  if (!account) {
    throw new IdentityError('account_not_found', 'account for OIDC identity is missing');
  }
  if (account.status === 'disabled') {
    throw new IdentityError('account_disabled', 'account is disabled');
  }
  if (account.status === 'deleted' || account.deletedAt !== null) {
    throw new IdentityError('account_deleted', 'account is deleted');
  }

  const profile = await ports.profiles.findByAccountId(accountId);
  if (!profile) {
    throw new IdentityError('account_not_found', 'profile for account is missing');
  }

  const now = await ports.clock.now();
  let nextAccount = account;
  let nextProfile = profile;

  // Email: only policy-approved verified claims update product email.
  // Unverified claims never clear or overwrite an existing trusted email.
  if (trusted.emailTrusted && trusted.trustedEmail !== null) {
    if (account.email !== trusted.trustedEmail) {
      await assertEmailAvailable(ports, trusted.trustedEmail, accountId);
      // Capture the old mailbox before updateEmail. Pending unbound invites
      // for that address must die here so a later occupant cannot accept them
      // (same P9 contract as Better Auth change-email). Bound invites stay.
      const previousMailbox = mailboxForInvitePurge(account.email);
      await ports.accounts.updateEmail(accountId, trusted.trustedEmail);
      nextAccount = { ...account, email: trusted.trustedEmail };
      if (previousMailbox !== null && ports.pendingUnboundInvites) {
        await ports.pendingUnboundInvites.revokePendingUnboundInvitesByEmail(previousMailbox, now);
      }
    }
  }

  const nextDisplayName = trusted.trustedDisplayName !== null
    ? trusted.trustedDisplayName
    : profile.displayName;
  const nextAvatarUrl = trusted.trustedAvatarUrl !== undefined
    ? trusted.trustedAvatarUrl
    : profile.avatarUrl;

  if (
    nextDisplayName !== profile.displayName
    || nextAvatarUrl !== profile.avatarUrl
  ) {
    nextProfile = {
      accountId,
      displayName: nextDisplayName,
      avatarUrl: nextAvatarUrl,
      about: profile.about,
      updatedAt: now,
    };
    await ports.profiles.update(nextProfile);
  }

  const handleRow = await ensureAccountHandle(ports, accountId);
  return {
    account: nextAccount,
    profile: nextProfile,
    handle: handleRow,
    identity,
  };
}

/**
 * Email-availability gate for the create path (T-OIDC-005). Preserves the
 * holder so a concurrently committed (issuer, subject) binding can be compared
 * with the email holder:
 * - no holder → available, caller proceeds to create;
 * - holder exists and the binding now belongs to the holder → the competing
 *   callback committed this very identity between our earlier lookup and this
 *   check; surface the standard retryable identity_conflict so the caller's
 *   single fresh-transaction retry converges on the winner;
 * - any other holder → terminal email_conflict (never treat a foreign
 *   collision as a benign identity race).
 */
async function assertEmailAvailableForCreate(
  ports: IdentityPorts,
  email: string,
  issuer: string,
  subject: string,
): Promise<void> {
  const holder = await ports.accounts.findByEmail(email);
  if (!holder) return;
  const nowBound = await ports.accountIdentities.findByIssuerSubject(issuer, subject);
  if (nowBound !== null && nowBound.accountId === holder.id) {
    throw new IdentityError(
      'identity_conflict',
      'OIDC identity was claimed concurrently; retry ensure in a fresh transaction',
    );
  }
  throw new IdentityError(
    'email_conflict',
    'email is already associated with another account',
  );
}

/**
 * Ensures no other account already holds this email (existing-account email
 * sync path). Own accountId is excluded so re-applying the same email is a
 * no-op. Unlike the create path, the sync path never converts to
 * identity_conflict — the binding already belongs to this account.
 */
async function assertEmailAvailable(
  ports: IdentityPorts,
  email: string,
  accountId: string | null,
): Promise<void> {
  const holder = await ports.accounts.findByEmail(email);
  if (holder && holder.id !== accountId) {
    throw new IdentityError(
      'email_conflict',
      'email is already associated with another account',
    );
  }
}

/** Invite rows store `email_normalized` as lower(trim). Null/blank skip purge. */
function mailboxForInvitePurge(email: string | null): string | null {
  if (email === null) return null;
  const normalized = email.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}
