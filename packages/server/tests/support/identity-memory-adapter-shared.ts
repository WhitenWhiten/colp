import type {
  Account,
  AccountRepository,
  Profile,
  ProfileHandle,
  ProfileHandleRepository,
  ProfileRepository,
} from '../../src/modules/identity/index.js';

export interface IdentityMemoryAccountRepositoryKnobs {
  injectAccountInsertConflict?: boolean;
}

export interface IdentityMemoryAccountRepositoryState {
  readonly accounts: Map<string, Account>;
  readonly accountsByEmail?: Map<string, Account>;
}

export interface IdentityMemoryHandleRepositoryState {
  readonly handlesByHandle: Map<string, ProfileHandle>;
  readonly handlesByAccount?: Map<string, ProfileHandle>;
}

export interface IdentityMemoryPendingInvite {
  emailNormalized: string;
  invitedSubjectId: string | null;
  status: 'pending' | 'revoked' | 'accepted' | 'declined' | 'expired';
  resolvedAt: Date | null;
}

function uniqueViolation(): Error {
  const error = new Error('duplicate key value violates unique constraint');
  (error as Error & { code?: string }).code = '23505';
  return error;
}

function findAccountByEmail(
  state: IdentityMemoryAccountRepositoryState,
  email: string,
): Account | null {
  const indexed = state.accountsByEmail?.get(email);
  if (indexed) return indexed;
  for (const account of state.accounts.values()) {
    if (account.email === email) return account;
  }
  return null;
}

function snapshotAccount(account: Account): Account {
  return {
    ...account,
    createdAt: new Date(account.createdAt),
    deletedAt: account.deletedAt === null ? null : new Date(account.deletedAt),
  };
}

/** Shared AccountRepository semantics for identity and Better Auth unit harnesses. */
export function createIdentityMemoryAccountRepository(
  state: IdentityMemoryAccountRepositoryState,
  knobs: IdentityMemoryAccountRepositoryKnobs = {},
): AccountRepository {
  return {
    async findById(id) {
      const account = state.accounts.get(id);
      return account ? snapshotAccount(account) : null;
    },
    async findBySubjectId(subjectId) {
      for (const account of state.accounts.values()) {
        if (account.subjectId === subjectId) return snapshotAccount(account);
      }
      return null;
    },
    async findByEmail(email) {
      const account = findAccountByEmail(state, email);
      return account ? snapshotAccount(account) : null;
    },
    async insert(account) {
      if (knobs.injectAccountInsertConflict) {
        knobs.injectAccountInsertConflict = false;
        throw uniqueViolation();
      }
      const subjectTaken = [...state.accounts.values()].some(
        (existing) => existing.subjectId === account.subjectId,
      );
      const emailTaken = account.email !== null && findAccountByEmail(state, account.email) !== null;
      if (state.accounts.has(account.id) || subjectTaken || emailTaken) throw uniqueViolation();
      const stored = snapshotAccount(account);
      state.accounts.set(account.id, stored);
      if (stored.email !== null) state.accountsByEmail?.set(stored.email, stored);
    },
    async bumpSecurityEpoch(accountId) {
      const account = state.accounts.get(accountId);
      if (!account) throw new Error('account was not found for security epoch bump');
      const next = snapshotAccount({ ...account, securityEpoch: account.securityEpoch + 1n });
      state.accounts.set(accountId, next);
      if (next.email !== null) state.accountsByEmail?.set(next.email, next);
      return next.securityEpoch;
    },
    async updateEmail(accountId, email) {
      const account = state.accounts.get(accountId);
      if (!account) throw new Error('account was not found for email update');
      const holder = email === null ? null : findAccountByEmail(state, email);
      if (holder !== null && holder.id !== accountId) throw uniqueViolation();
      if (account.email !== null) state.accountsByEmail?.delete(account.email);
      const next = snapshotAccount({ ...account, email });
      state.accounts.set(accountId, next);
      if (email !== null) state.accountsByEmail?.set(email, next);
    },
    async markDeleted(accountId, deletedAt) {
      const account = state.accounts.get(accountId);
      if (!account) throw new Error('account was not found for delete');
      if (account.email !== null) state.accountsByEmail?.delete(account.email);
      state.accounts.set(accountId, snapshotAccount({
        ...account,
        status: 'deleted',
        deletedAt,
        email: null,
      }));
    },
  };
}

export function createIdentityMemoryProfileRepository(
  profiles: Map<string, Profile>,
): ProfileRepository {
  const snapshot = (profile: Profile): Profile => ({
    ...profile,
    updatedAt: new Date(profile.updatedAt),
  });
  return {
    async findByAccountId(accountId) {
      const profile = profiles.get(accountId);
      return profile ? snapshot(profile) : null;
    },
    async insert(profile) {
      if (profiles.has(profile.accountId)) throw uniqueViolation();
      profiles.set(profile.accountId, snapshot(profile));
    },
    async update(profile) {
      if (!profiles.has(profile.accountId)) throw new Error('profile was not found for update');
      profiles.set(profile.accountId, snapshot(profile));
    },
  };
}

function findHandleByAccountId(
  state: IdentityMemoryHandleRepositoryState,
  accountId: string,
): ProfileHandle | null {
  const indexed = state.handlesByAccount?.get(accountId);
  if (indexed) return indexed;
  for (const handle of state.handlesByHandle.values()) {
    if (handle.accountId === accountId) return handle;
  }
  return null;
}

export function createIdentityMemoryHandleRepository(
  state: IdentityMemoryHandleRepositoryState,
): ProfileHandleRepository {
  const snapshot = (handle: ProfileHandle): ProfileHandle => ({
    ...handle,
    createdAt: new Date(handle.createdAt),
  });
  return {
    async findByHandle(handle) {
      const row = state.handlesByHandle.get(handle);
      return row ? snapshot(row) : null;
    },
    async findByAccountId(accountId) {
      const row = findHandleByAccountId(state, accountId);
      return row ? snapshot(row) : null;
    },
    async insert(handle) {
      const reserved = await this.tryInsert(handle);
      if (!reserved) throw uniqueViolation();
    },
    async tryInsert(handle) {
      if (state.handlesByHandle.has(handle.handle)) return false;
      if (findHandleByAccountId(state, handle.accountId)) return false;
      const stored = snapshot(handle);
      state.handlesByHandle.set(handle.handle, stored);
      state.handlesByAccount?.set(handle.accountId, stored);
      return true;
    },
    async deleteByAccountId(accountId) {
      const handle = findHandleByAccountId(state, accountId);
      if (!handle) return false;
      state.handlesByAccount?.delete(accountId);
      state.handlesByHandle.delete(handle.handle);
      return true;
    },
    async deleteByHandle(handle) {
      const row = state.handlesByHandle.get(handle);
      if (!row) return false;
      state.handlesByHandle.delete(handle);
      state.handlesByAccount?.delete(row.accountId);
      return true;
    },
  };
}

export async function revokeIdentityMemoryPendingInvites(
  invites: IdentityMemoryPendingInvite[],
  emailNormalized: string,
  now: Date,
): Promise<number> {
  let count = 0;
  for (const invite of invites) {
    if (
      invite.status === 'pending'
      && invite.invitedSubjectId === null
      && invite.emailNormalized === emailNormalized
    ) {
      invite.status = 'revoked';
      invite.resolvedAt = now;
      count += 1;
    }
  }
  return count;
}
