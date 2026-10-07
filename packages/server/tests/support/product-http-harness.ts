import assert from 'node:assert/strict';
import { createMemoryOidcLoginTransactionRepository } from './memory-oidc.js';
import {
  createTestOidcTransactionSecrets,
  type Account,
  type AccountIdentity,
  type IdentityPorts,
  type IdentityUnitOfWork,
  type OidcLoginTransaction,
  type Profile,
  type ProfileHandle,
  type Session,
} from '../../src/modules/identity/index.js';
import type {
  ProductCommandBinding,
  ProductCommandClaim,
  ProductCommandReceiptPort,
  ProductCommandResult,
} from '../../src/modules/commands/index.js';

export interface IdentityMemoryState {
  accounts: Map<string, Account>;
  profiles: Map<string, Profile>;
  handles: Map<string, ProfileHandle>;
  identities: Map<string, AccountIdentity>;
  identitiesByAccount: Map<string, string>;
  sessions: Map<string, Session>;
  sessionsByTokenHash: Map<string, string>;
  oidc: Map<string, OidcLoginTransaction>;
  now: Date;
}

export function createIdentityMemoryState(now: Date): IdentityMemoryState {
  return {
    accounts: new Map(),
    profiles: new Map(),
    handles: new Map(),
    identities: new Map(),
    identitiesByAccount: new Map(),
    sessions: new Map(),
    sessionsByTokenHash: new Map(),
    oidc: new Map(),
    now: new Date(now),
  };
}

export function createIdentityMemoryPorts(
  state: IdentityMemoryState,
  receipts: MemoryProductCommandReceipts = new Map(),
): IdentityPorts {
  const key = (issuer: string, subject: string) => `${issuer}\0${subject}`;
  return {
    clock: { now: async () => new Date(state.now) },
    accounts: {
      async findById(id) { return state.accounts.get(id) ?? null; },
      async findBySubjectId(subjectId) {
        for (const account of state.accounts.values()) if (account.subjectId === subjectId) return account;
        return null;
      },
      async insert(account) {
        if (state.accounts.has(account.id)) throw new Error('duplicate account');
        state.accounts.set(account.id, account);
      },
      async findByEmail(email) {
        for (const account of state.accounts.values()) if (account.email === email) return account;
        return null;
      },
      async bumpSecurityEpoch(accountId) {
        const account = state.accounts.get(accountId);
        if (!account) throw new Error('missing account');
        const next = { ...account, securityEpoch: account.securityEpoch + 1n };
        state.accounts.set(accountId, next);
        return next.securityEpoch;
      },
      async updateEmail(accountId, email) {
        const account = state.accounts.get(accountId);
        if (!account) throw new Error('missing account');
        state.accounts.set(accountId, { ...account, email });
      },
      async markDeleted(accountId, deletedAt) {
        const account = state.accounts.get(accountId);
        if (!account) throw new Error('missing account');
        state.accounts.set(accountId, { ...account, status: 'deleted', deletedAt, email: null });
      },
    },
    accountIdentities: {
      async findByIssuerSubject(issuer, subject) { return state.identities.get(key(issuer, subject)) ?? null; },
      async findByAccountId(accountId) {
        const id = state.identitiesByAccount.get(accountId);
        if (!id) return null;
        for (const identity of state.identities.values()) if (identity.id === id) return identity;
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
    profiles: {
      async findByAccountId(accountId) { return state.profiles.get(accountId) ?? null; },
      async insert(profile) { state.profiles.set(profile.accountId, profile); },
      async update(profile) { state.profiles.set(profile.accountId, profile); },
    },
    handles: {
      async findByHandle(handle) { return state.handles.get(handle) ?? null; },
      async findByAccountId(accountId) {
        for (const handle of state.handles.values()) if (handle.accountId === accountId) return handle;
        return null;
      },
      async insert(handle) {
        if (state.handles.has(handle.handle)) throw new Error('handle taken');
        state.handles.set(handle.handle, handle);
      },
      async tryInsert(handle) {
        if (state.handles.has(handle.handle)) return false;
        for (const row of state.handles.values()) if (row.accountId === handle.accountId) return false;
        state.handles.set(handle.handle, handle);
        return true;
      },
      async deleteByAccountId(accountId) {
        for (const [handle, row] of state.handles) {
          if (row.accountId === accountId) {
            state.handles.delete(handle);
            return true;
          }
        }
        return false;
      },
      async deleteByHandle(handle) { return state.handles.delete(handle); },
    },
    sessions: {
      async findById(id) { return state.sessions.get(id) ?? null; },
      async findByTokenHash(tokenHash) {
        const id = state.sessionsByTokenHash.get(tokenHash);
        return id ? state.sessions.get(id) ?? null : null;
      },
      async findLiveSuccessorByRotatedFrom(predecessorSessionId) {
        for (const session of state.sessions.values()) {
          if (session.rotatedFromSessionId === predecessorSessionId && session.revokedAt === null) return session;
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
    receipts: createMemoryProductCommandReceiptPort(receipts),
  };
}

export function createIdentityMemoryUnitOfWork(state: IdentityMemoryState): IdentityUnitOfWork {
  return {
    async execute(work) {
      const transaction = cloneIdentityState(state);
      const result = await work(createIdentityMemoryPorts(transaction));
      commitIdentityState(state, transaction);
      return result;
    },
  };
}

function cloneIdentityState(state: IdentityMemoryState): IdentityMemoryState {
  return {
    accounts: new Map(state.accounts),
    profiles: new Map(state.profiles),
    handles: new Map(state.handles),
    identities: new Map(state.identities),
    identitiesByAccount: new Map(state.identitiesByAccount),
    sessions: new Map(state.sessions),
    sessionsByTokenHash: new Map(state.sessionsByTokenHash),
    oidc: new Map(state.oidc),
    now: new Date(state.now),
  };
}

function commitIdentityState(target: IdentityMemoryState, source: IdentityMemoryState): void {
  replaceMap(target.accounts, source.accounts);
  replaceMap(target.profiles, source.profiles);
  replaceMap(target.handles, source.handles);
  replaceMap(target.identities, source.identities);
  replaceMap(target.identitiesByAccount, source.identitiesByAccount);
  replaceMap(target.sessions, source.sessions);
  replaceMap(target.sessionsByTokenHash, source.sessionsByTokenHash);
  replaceMap(target.oidc, source.oidc);
  target.now = new Date(source.now);
}

function replaceMap<Key, Value>(target: Map<Key, Value>, source: Map<Key, Value>): void {
  target.clear();
  for (const [key, value] of source) target.set(key, value);
}

export async function executeMemoryTransaction<State extends object, Result>(
  state: State,
  work: (transaction: State) => Promise<Result>,
): Promise<Result> {
  const transaction = structuredClone(state);
  const result = await work(transaction);
  Object.assign(state, transaction);
  return result;
}

export interface MemoryProductCommandReceiptRow {
  fingerprint: string;
  status: 'in_progress' | 'completed';
  result?: ProductCommandResult;
  resultDigest?: string | null;
  expired?: boolean;
}

export type MemoryProductCommandReceipts = Map<string, MemoryProductCommandReceiptRow>;

export function productCommandReceiptKey(binding: ProductCommandBinding): string {
  return `${binding.principalId}\0${binding.commandScope}\0${binding.commandId}`;
}

export function createMemoryProductCommandReceiptPort(
  receipts: MemoryProductCommandReceipts,
): ProductCommandReceiptPort {
  return {
    async claim(binding, fingerprint): Promise<ProductCommandClaim> {
      const key = productCommandReceiptKey(binding);
      const existing = receipts.get(key);
      if (!existing) {
        receipts.set(key, { fingerprint, status: 'in_progress' });
        return { kind: 'claimed' };
      }
      if (existing.fingerprint !== fingerprint) return { kind: 'reused' };
      if (existing.expired) {
        return { kind: 'expired', resultDigest: existing.resultDigest ?? null };
      }
      if (existing.status === 'in_progress') {
        return { kind: 'in_progress', retryAfterSeconds: 1 };
      }
      assert.ok(existing.result, 'completed receipt must retain result');
      return { kind: 'replay', result: cloneProductCommandResult(existing.result) };
    },
    async complete(binding, fingerprint, result): Promise<void> {
      const existing = receipts.get(productCommandReceiptKey(binding));
      if (!existing || existing.fingerprint !== fingerprint || existing.status !== 'in_progress') {
        throw new Error('product command receipt was not claim owner');
      }
      existing.status = 'completed';
      existing.result = cloneProductCommandResult(result);
      existing.resultDigest = 'test-result-digest';
    },
    async purgeExpired() {
      return 0;
    },
    async deletePrincipalReceipts(principalId) {
      let deleted = 0;
      for (const [key] of receipts) {
        if (key.startsWith(`${principalId}\0`)) {
          receipts.delete(key);
          deleted += 1;
        }
      }
      return deleted;
    },
  };
}

function cloneProductCommandResult(result: ProductCommandResult): ProductCommandResult {
  return {
    status: result.status,
    body: result.body.slice(),
    stableHeaders: { ...result.stableHeaders },
    mediaType: result.mediaType,
    contractVersion: result.contractVersion,
    targetIdentity: result.targetIdentity,
  };
}

/**
 * Task E1: `issueTestSession` is now the Better Auth test-session seam (plan
 * §11 E1). The implementation lives in `better-auth-test-factory.ts`; the
 * external contract stays `{cookie, csrfToken, accountId, subjectId}` so
 * callers keep their shape while sessions are minted as REAL Better Auth
 * sessions and validated by the REAL A3 BrowserSessionAuthority (unit tests:
 * in-memory factory; integration: real PostgreSQL + real betterAuth).
 */
export { issueTestSession, type AuthenticatedTestClient } from './better-auth-test-factory.js';
export type {
  BetterAuthTestFactory,
  IssueTestSessionInput,
  InMemoryBetterAuthTestFactory,
  PostgresBetterAuthTestFactory,
} from './better-auth-test-factory.js';

export function authenticatedMutationHeaders(input: {
  readonly client: Pick<AuthenticatedTestClient, 'cookie' | 'csrfToken'>;
  readonly origin: string;
  readonly contentType: string;
  readonly extra?: Readonly<Record<string, string>>;
}): Record<string, string> {
  return {
    cookie: input.client.cookie,
    origin: input.origin,
    'x-csrf-token': input.client.csrfToken,
    'content-type': input.contentType,
    ...input.extra,
  };
}

export function assertProductErrorEnvelope(
  response: { statusCode: number; headers: Record<string, string | string[] | undefined>; json(): unknown },
  expectedStatus: number,
  expectedCode: string,
): Record<string, unknown> {
  assert.equal(response.statusCode, expectedStatus);
  assert.match(String(response.headers['content-type'] ?? ''), /application\/json/i);
  assert.equal(response.headers['cache-control'], 'private, no-store');
  assert.equal(typeof response.headers['x-request-id'], 'string');
  const envelope = response.json() as { error: Record<string, unknown> };
  assert.deepEqual(Object.keys(envelope), ['error']);
  assert.equal(envelope.error.code, expectedCode);
  assert.equal(typeof envelope.error.message, 'string');
  assert.ok((envelope.error.message as string).length > 0);
  assert.equal(envelope.error.requestId, response.headers['x-request-id']);
  return envelope.error;
}
