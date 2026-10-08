/**
 * In-memory A2 business-account ports for unit tests.
 */
import {
  BusinessAccountMappingError,
  type BusinessAccountMappingRepository,
  type BusinessAccountPorts,
  type BusinessAccountUnitOfWork,
} from '../../src/modules/auth/index.js';
import type {
  Account,
  AccountRepository,
  AuthUserAccountMapping,
  IdentityClock,
  Profile,
  ProfileHandle,
  ProfileHandleRepository,
  ProfileRepository,
} from '../../src/modules/identity/index.js';
import {
  createIdentityMemoryAccountRepository,
  createIdentityMemoryHandleRepository,
  createIdentityMemoryProfileRepository,
  revokeIdentityMemoryPendingInvites,
} from './identity-memory-adapter-shared.js';

export const NOW = new Date('2026-09-05T12:00:00.000Z');

export interface MemoryPendingUnboundInvite {
  emailNormalized: string;
  invitedSubjectId: string | null;
  status: 'pending' | 'revoked' | 'accepted' | 'declined' | 'expired';
  resolvedAt: Date | null;
}

export interface MemoryState {
  mappingsByAuthUser: Map<string, AuthUserAccountMapping>;
  mappingsByAccount: Map<string, AuthUserAccountMapping>;
  accounts: Map<string, Account>;
  accountsByEmail: Map<string, Account>;
  profiles: Map<string, Profile>;
  handlesByAccount: Map<string, ProfileHandle>;
  handlesByHandle: Map<string, ProfileHandle>;
  pendingUnboundInvites: MemoryPendingUnboundInvite[];
}

export interface MemoryKnobs {
  /**
   * Simulates the concurrent-first-login window: the FIRST findByAuthUserId
   * for this auth user returns null (the winner's row is not yet committed
   * and therefore invisible), while insert() still detects the committed
   * winner and throws duplicate_mapping — exactly what a real PostgreSQL
   * unique index does when the winner commits between our read and our insert.
   */
  maskFirstLookupOf?: string;
  /** Simulates a concurrent account insert for the same email: next accounts.insert throws SQLSTATE 23505. */
  injectAccountInsertConflict?: boolean;
}

export function createMemoryState(): MemoryState {
  return {
    mappingsByAuthUser: new Map(),
    mappingsByAccount: new Map(),
    accounts: new Map(),
    accountsByEmail: new Map(),
    profiles: new Map(),
    handlesByAccount: new Map(),
    handlesByHandle: new Map(),
    pendingUnboundInvites: [],
  };
}

export function restoreMemoryState(state: MemoryState, snapshot: MemoryState): void {
  state.mappingsByAuthUser = new Map(snapshot.mappingsByAuthUser);
  state.mappingsByAccount = new Map(snapshot.mappingsByAccount);
  state.accounts = new Map(snapshot.accounts);
  state.accountsByEmail = new Map(snapshot.accountsByEmail);
  state.profiles = new Map(snapshot.profiles);
  state.handlesByAccount = new Map(snapshot.handlesByAccount);
  state.handlesByHandle = new Map(snapshot.handlesByHandle);
  state.pendingUnboundInvites = snapshot.pendingUnboundInvites.map((row) => ({ ...row }));
}

/** Seeds a full business account (account + profile + handle), optionally mapped to an auth user. */
export function seedBusinessAccount(
  state: MemoryState,
  overrides: { readonly id?: string; readonly email?: string | null; readonly status?: Account['status']; readonly handle?: string } = {},
): { readonly account: Account; readonly handle: ProfileHandle } {
  const id = overrides.id ?? `acct-${state.accounts.size + 1}`;
  const account: Account = {
    id,
    subjectId: `subj-${id}`,
    status: overrides.status ?? 'active',
    email: overrides.email ?? null,
    securityEpoch: 0n,
    createdAt: NOW,
    deletedAt: null,
  };
  state.accounts.set(account.id, account);
  if (account.email !== null) state.accountsByEmail.set(account.email, account);
  const profile: Profile = { accountId: account.id, displayName: 'Seeded', avatarUrl: null, about: '', updatedAt: NOW };
  state.profiles.set(account.id, profile);
  const handle: ProfileHandle = {
    handle: overrides.handle ?? `seed-${id}`,
    accountId: account.id,
    createdAt: NOW,
  };
  state.handlesByAccount.set(account.id, handle);
  state.handlesByHandle.set(handle.handle, handle);
  return { account, handle };
}

export function mapAccountRow(account: Account): AuthUserAccountMapping {
  return { authUserId: `ba-${account.id}`, accountId: account.id, createdAt: NOW };
}

export function createMemoryAccountRepository(state: MemoryState, knobs: MemoryKnobs): AccountRepository {
  return createIdentityMemoryAccountRepository(state, knobs);
}

export function createMemoryMappingRepository(state: MemoryState, knobs: MemoryKnobs = {}): BusinessAccountMappingRepository {
  return {
    async findByAuthUserId(authUserId) {
      if (knobs.maskFirstLookupOf === authUserId) {
        knobs.maskFirstLookupOf = undefined;
        return null;
      }
      return state.mappingsByAuthUser.get(authUserId) ?? null;
    },
    async insert(mapping) {
      // Conflicts are detected against the committed state regardless of the
      // read mask (the winner committed between our read and our insert).
      const byUser = state.mappingsByAuthUser.get(mapping.authUserId);
      const byAccount = state.mappingsByAccount.get(mapping.accountId);
      if (byUser || byAccount) {
        throw new BusinessAccountMappingError('duplicate_mapping', 'auth user or business account is already mapped');
      }
      state.mappingsByAuthUser.set(mapping.authUserId, mapping);
      state.mappingsByAccount.set(mapping.accountId, mapping);
    },
  };
}

export function createMemoryProfileRepository(state: MemoryState): ProfileRepository {
  return createIdentityMemoryProfileRepository(state.profiles);
}

export function createMemoryHandleRepository(state: MemoryState): ProfileHandleRepository {
  return createIdentityMemoryHandleRepository({
    handlesByHandle: state.handlesByHandle,
    handlesByAccount: state.handlesByAccount,
  });
}

export function createMemoryClock(): IdentityClock {
  return { now: async () => NOW };
}

export function createMemoryBusinessAccountPorts(state: MemoryState, knobs: MemoryKnobs = {}): BusinessAccountPorts {
  return {
    mappings: createMemoryMappingRepository(state, knobs),
    accounts: createMemoryAccountRepository(state, knobs),
    profiles: createMemoryProfileRepository(state),
    handles: createMemoryHandleRepository(state),
    clock: createMemoryClock(),
    pendingUnboundInvites: {
      revokePendingUnboundInvitesByEmail: (emailNormalized, now) =>
        revokeIdentityMemoryPendingInvites(state.pendingUnboundInvites, emailNormalized, now),
    },
    revokeOAuthRefreshTokensForAccount: async () => 0,
  };
}

/**
 * Single-transaction semantics over the shared memory state: every execute()
 * snapshots the state and restores it when the work throws, so partial writes
 * roll back exactly like the PostgreSQL unit of work (rows committed by a
 * simulated concurrent winner stay in the snapshot and survive the rollback).
 */
export function createMemoryBusinessAccountUnitOfWork(state: MemoryState, knobs: MemoryKnobs = {}): BusinessAccountUnitOfWork {
  return {
    async execute<Result>(work: (ports: BusinessAccountPorts) => Promise<Result>): Promise<Result> {
      const snapshot = structuredClone(state);
      try {
        return await work(createMemoryBusinessAccountPorts(state, knobs));
      } catch (error) {
        restoreMemoryState(state, snapshot);
        throw error;
      }
    },
  };
}
