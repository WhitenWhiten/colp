/**
 * Task A2: business account mapping for Better Auth users.
 *
 * Resolution contract: look up `auth_user_account_map` by `auth_user_id`
 * (unique), then load `accounts` and `profiles`/`profile_handles`. Errors are
 * classified into stable codes so the transport layer (A4) and the browser
 * session authority (A3) can map them to non-enumerable auth failures:
 *
 * - mapping_missing      no mapping row for the auth user;
 * - account_not_found    mapping row points at a missing account (corruption);
 * - account_disabled     account.status = 'disabled';
 * - account_deleted      account.status = 'deleted' or deleted_at set;
 * - duplicate_mapping    insert conflict: auth user or business account is
 *                        already mapped (concurrent first login / conflicting
 *                        adoption);
 * - handle_collision     requested profile handle is taken by another account;
 * - email_conflict       the verified email is already held by another account
 *                        (concurrent create race, never a silent merge).
 *
 * The mapping surface NEVER consults `account_identities` or
 * `legacy_oidc_identity_archive`: those rows are a legacy extension chain that
 * must not become a runtime login shortcut (G1 ADR §11; plan §4.3.5).
 */
import {
  type Account,
  type AccountRepository,
  type AuthUserAccountMapping,
  type IdentityClock,
  type MappedBusinessAccount,
  type ProfileHandleRepository,
  type ProfileRepository,
} from '../../identity/index.js';

export type BusinessAccountMappingErrorCode =
  | 'mapping_missing'
  | 'account_not_found'
  | 'account_disabled'
  | 'account_deleted'
  | 'duplicate_mapping'
  | 'handle_collision'
  | 'email_conflict';

export class BusinessAccountMappingError extends Error {
  readonly code: BusinessAccountMappingErrorCode;

  constructor(code: BusinessAccountMappingErrorCode, message: string) {
    super(message);
    this.name = 'BusinessAccountMappingError';
    this.code = code;
  }
}

/** Read/write surface for the bidirectional auth_user_account_map row. */
export interface BusinessAccountMappingRepository {
  findByAuthUserId(authUserId: string): Promise<AuthUserAccountMapping | null>;
  /**
   * Inserts the mapping. A unique violation (auth_user_id primary key or
   * account_id unique) surfaces as BusinessAccountMappingError with code
   * 'duplicate_mapping' — the calling transaction is aborted by PostgreSQL,
   * so callers must re-read in a fresh transaction.
   */
  insert(mapping: AuthUserAccountMapping): Promise<void>;
}

/**
 * System purge of pending unbound collaboration invites after a product
 * email leaves a mailbox (P9 change-email). Bound invites stay subject-bound.
 */
export interface PendingUnboundInvitePurgePort {
  revokePendingUnboundInvitesByEmail(emailNormalized: string, now: Date): Promise<number>;
}

/**
 * Transaction-bound business account ports: the mapping repository plus the
 * existing product identity repositories (accounts/profiles/handles/clock)
 * bound to the same database transaction.
 */
export interface BusinessAccountPorts {
  readonly mappings: BusinessAccountMappingRepository;
  readonly accounts: AccountRepository;
  readonly profiles: ProfileRepository;
  readonly handles: ProfileHandleRepository;
  readonly clock: IdentityClock;
  readonly pendingUnboundInvites: PendingUnboundInvitePurgePort;
  /** Revoke Better Auth OAuth refresh families with an email security bump. */
  readonly revokeOAuthRefreshTokensForAccount: (accountId: string) => Promise<number>;
}

/**
 * Module-owned unit of work for business account establishment. The
 * infrastructure implementation opens one PostgreSQL transaction per
 * execute() and retries serialization/deadlock/lock-timeout/unavailable
 * failures in a fresh transaction.
 */
export interface BusinessAccountUnitOfWork {
  execute<Result>(work: (ports: BusinessAccountPorts) => Promise<Result>): Promise<Result>;
}

/**
 * Resolve a Better Auth user to its business account, profile and handle.
 * Classifies missing mapping, missing account row and disabled/deleted
 * accounts as stable BusinessAccountMappingError codes.
 */
export async function resolveBusinessAccountForAuthUser(
  ports: BusinessAccountPorts,
  authUserId: string,
): Promise<MappedBusinessAccount> {
  const mapping = await ports.mappings.findByAuthUserId(authUserId);
  if (!mapping) {
    throw new BusinessAccountMappingError(
      'mapping_missing',
      'no business account mapping exists for this Better Auth user',
    );
  }
  return resolveMappedBusinessAccount(ports, mapping);
}

/**
 * Load the account/profile/handle behind an existing mapping row and apply
 * the status classification. profile/handle are returned as null when the
 * business account is missing its lifecycle rows (corruption); A2-created
 * accounts always have both.
 */
export async function resolveMappedBusinessAccount(
  ports: BusinessAccountPorts,
  mapping: AuthUserAccountMapping,
): Promise<MappedBusinessAccount> {
  const account = await ports.accounts.findById(mapping.accountId);
  if (!account) {
    throw new BusinessAccountMappingError(
      'account_not_found',
      'business account for the mapping is missing',
    );
  }
  assertAccountUsable(account);
  const profile = await ports.profiles.findByAccountId(account.id);
  const handle = await ports.handles.findByAccountId(account.id);
  return { mapping, account, profile, handle };
}

export function assertAccountUsable(account: Account): void {
  if (account.status === 'disabled') {
    throw new BusinessAccountMappingError('account_disabled', 'business account is disabled');
  }
  if (account.status === 'deleted' || account.deletedAt !== null) {
    throw new BusinessAccountMappingError('account_deleted', 'business account is deleted');
  }
}
