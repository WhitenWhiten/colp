import {
  BARE_HANDLE_ATTEMPTS,
  IdentityError,
  assertClaimableHandle,
  assertValidHandle,
  generateAutomaticHandle,
} from '../domain/index.js';
import type { ProfileHandle } from '../domain/types.js';
import type { IdentityPorts } from './ports.js';

/**
 * Structural subset of IdentityPorts sufficient for handle reservation: the
 * account lookup (when a specific handle is claimed), the handle store and
 * the identity clock. Consumers that do not own the full identity port set
 * (e.g. the A2 business-account facade) can reserve handles through the same
 * application logic without faking the rest of the ports.
 */
export type HandleReservationPorts = Pick<IdentityPorts, 'accounts' | 'handles' | 'clock'>;

export interface ClaimHandleInput {
  readonly accountId: string;
  readonly handle: string;
}

const AUTOMATIC_HANDLE_ATTEMPTS = 8;

/**
 * Return the existing handle or reserve a fresh, non-provider-derived one.
 *
 * The generated value is a readable `adjective-noun` pair rather than an
 * opaque token: it stays short enough for the identity rows that render it,
 * and it reads as a starting point the holder can replace instead of a
 * system-owned key. Entropy still comes from a CSPRNG and never from the
 * provider, the email address or the display name.
 */
export async function ensureAccountHandle(
  ports: HandleReservationPorts,
  accountId: string,
  requestedHandle?: string,
): Promise<ProfileHandle> {
  const existing = await ports.handles.findByAccountId(accountId);
  if (existing) return existing;
  if (requestedHandle !== undefined) {
    return claimHandle(ports, { accountId, handle: requestedHandle });
  }
  const now = await ports.clock.now();
  for (let attempt = 0; attempt < AUTOMATIC_HANDLE_ATTEMPTS; attempt += 1) {
    const row: ProfileHandle = {
      handle: generateAutomaticHandle({ withSuffix: attempt >= BARE_HANDLE_ATTEMPTS }),
      accountId,
      createdAt: now,
    };
    if (await ports.handles.tryInsert(row)) return row;
    const concurrentWinner = await ports.handles.findByAccountId(accountId);
    if (concurrentWinner) return concurrentWinner;
  }
  throw new IdentityError('handle_taken', 'unable to reserve an automatic handle');
}

/**
 * Claims a global handle for an account (one handle per account).
 * If the account already holds a different handle, the previous handle is released first.
 */
export async function claimHandle(
  ports: HandleReservationPorts,
  input: ClaimHandleInput,
): Promise<ProfileHandle> {
  const handle = assertValidHandle(input.handle).toLowerCase();
  const account = await ports.accounts.findById(input.accountId);
  if (!account) {
    throw new IdentityError('account_not_found', 'account was not found');
  }

  const existingForHandle = await ports.handles.findByHandle(handle);
  if (existingForHandle && existingForHandle.accountId !== input.accountId) {
    throw new IdentityError('handle_taken', 'handle is already taken');
  }
  if (existingForHandle && existingForHandle.accountId === input.accountId) {
    return existingForHandle;
  }

  // Only a handle actually changing hands has to satisfy the current claim
  // policy; re-submitting the one already held short-circuits above, so an
  // account minted under the older, longer scheme can still save its profile.
  assertClaimableHandle(handle);

  const current = await ports.handles.findByAccountId(input.accountId);
  if (current) {
    await ports.handles.deleteByAccountId(input.accountId);
  }

  const now = await ports.clock.now();
  const row: ProfileHandle = {
    handle,
    accountId: input.accountId,
    createdAt: now,
  };
  const reserved = await ports.handles.tryInsert(row);
  if (!reserved) {
    throw new IdentityError('handle_taken', 'handle is already taken');
  }
  return row;
}

export async function releaseHandle(
  ports: IdentityPorts,
  accountId: string,
): Promise<{ readonly released: boolean }> {
  const account = await ports.accounts.findById(accountId);
  const identity = await ports.accountIdentities.findByAccountId(accountId);
  if (account?.status === 'active' && account.deletedAt === null && identity) {
    throw new IdentityError('invalid_handle', 'active OIDC accounts must retain a handle');
  }
  const released = await ports.handles.deleteByAccountId(accountId);
  return { released };
}

/** Claim or release depending on whether handle is provided. */
export async function claimOrReleaseHandle(
  ports: IdentityPorts,
  input: { readonly accountId: string; readonly handle: string | null },
): Promise<ProfileHandle | null> {
  if (input.handle === null) {
    await releaseHandle(ports, input.accountId);
    return null;
  }
  return claimHandle(ports, { accountId: input.accountId, handle: input.handle });
}
