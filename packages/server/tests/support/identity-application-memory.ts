import { createMemoryOidcLoginTransactionRepository } from './memory-oidc.js';
import {
  createIdentityMemoryAccountRepository,
  createIdentityMemoryHandleRepository,
  createIdentityMemoryProfileRepository,
  revokeIdentityMemoryPendingInvites,
} from './identity-memory-adapter-shared.js';
import {
  createIdentityApplication,
  createTestOidcTransactionSecrets,
  createTestSessionRotationSecrets,
  type Account,
  type AccountIdentity,
  type IdentityPorts,
  type IdentityUnitOfWork,
  type OidcLoginTransaction,
  type Profile,
  type ProfileHandle,
  type Session,
} from '../../src/modules/identity/index.js';

export const IDENTITY_APPLICATION_NOW = new Date('2026-01-01T12:00:00.000Z');

export interface MemoryPendingUnboundInvite {
  emailNormalized: string;
  invitedSubjectId: string | null;
  status: 'pending' | 'revoked';
  resolvedAt: Date | null;
}

export interface IdentityApplicationMemoryState {
  accounts: Map<string, Account>;
  profiles: Map<string, Profile>;
  handles: Map<string, ProfileHandle>;
  identities: Map<string, AccountIdentity>;
  identitiesByAccount: Map<string, string>;
  sessions: Map<string, Session>;
  sessionsByTokenHash: Map<string, string>;
  oidc: Map<string, OidcLoginTransaction>;
  pendingUnboundInvites: MemoryPendingUnboundInvite[];
  now: Date;
}

export function createIdentityApplicationMemoryPorts(
  state: IdentityApplicationMemoryState,
): IdentityPorts {
  const key = (issuer: string, subject: string) => `${issuer}\0${subject}`;
  return {
    clock: { now: async () => new Date(state.now) },
    accounts: createIdentityMemoryAccountRepository(state),
    accountIdentities: {
      async findByIssuerSubject(issuer, subject) {
        return state.identities.get(key(issuer, subject)) ?? null;
      },
      async findByAccountId(accountId) {
        const id = state.identitiesByAccount.get(accountId);
        if (!id) return null;
        for (const identity of state.identities.values()) {
          if (identity.id === id) return identity;
        }
        return null;
      },
      async insert(identity) {
        state.identities.set(key(identity.issuer, identity.subject), identity);
        state.identitiesByAccount.set(identity.accountId, identity.id);
      },
      async insertIfAbsent(identity) {
        const existing = state.identities.get(key(identity.issuer, identity.subject));
        if (existing) return existing;
        state.identities.set(key(identity.issuer, identity.subject), identity);
        state.identitiesByAccount.set(identity.accountId, identity.id);
        return identity;
      },
    },
    profiles: createIdentityMemoryProfileRepository(state.profiles),
    handles: createIdentityMemoryHandleRepository({ handlesByHandle: state.handles }),
    sessions: {
      async findById(id) {
        return state.sessions.get(id) ?? null;
      },
      async findByTokenHash(tokenHash) {
        const id = state.sessionsByTokenHash.get(tokenHash);
        return id ? state.sessions.get(id) ?? null : null;
      },
      async findLiveSuccessorByRotatedFrom(predecessorSessionId) {
        for (const session of state.sessions.values()) {
          if (session.rotatedFromSessionId === predecessorSessionId && session.revokedAt === null) {
            return session;
          }
        }
        return null;
      },
      async insert(session) {
        state.sessions.set(session.id, session);
        state.sessionsByTokenHash.set(session.tokenHash, session.id);
      },
      async revoke(sessionId, revokedAt) {
        const session = state.sessions.get(sessionId);
        if (!session || session.revokedAt) return false;
        state.sessions.set(sessionId, { ...session, revokedAt });
        return true;
      },
      async touch(sessionId, lastSeenAt, idleExpiresAt) {
        const session = state.sessions.get(sessionId);
        if (!session || session.revokedAt) return false;
        state.sessions.set(sessionId, { ...session, lastSeenAt, idleExpiresAt });
        return true;
      },
      async revokeAllForAccount(accountId, revokedAt) {
        let count = 0;
        for (const [id, session] of state.sessions) {
          if (session.accountId === accountId && !session.revokedAt) {
            state.sessions.set(id, { ...session, revokedAt });
            count += 1;
          }
        }
        return count;
      },
    },
    oidcLoginTransactions: createMemoryOidcLoginTransactionRepository(state.oidc),
    oidcTransactionSecrets: createTestOidcTransactionSecrets(),
    sessionRotationSecrets: createTestSessionRotationSecrets(),
    pendingUnboundInvites: {
      revokePendingUnboundInvitesByEmail: (emailNormalized, now) =>
        revokeIdentityMemoryPendingInvites(state.pendingUnboundInvites, emailNormalized, now),
    },
  };
}

export function createIdentityApplicationHarness(now: Date = new Date(IDENTITY_APPLICATION_NOW)) {
  const state: IdentityApplicationMemoryState = {
    accounts: new Map(),
    profiles: new Map(),
    handles: new Map(),
    identities: new Map(),
    identitiesByAccount: new Map(),
    sessions: new Map(),
    sessionsByTokenHash: new Map(),
    oidc: new Map(),
    pendingUnboundInvites: [],
    now: new Date(now),
  };
  const ports = createIdentityApplicationMemoryPorts(state);
  const unitOfWork: IdentityUnitOfWork = {
    execute: async (work) => work(ports),
  };
  const app = createIdentityApplication({ unitOfWork });
  return { state, ports, app };
}
