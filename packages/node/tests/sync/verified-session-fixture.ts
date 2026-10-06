/** Mints package-branded VerifiedSyncSessions through the public API. Not a test file. */
import {
  createSyncSession,
  requireVerifiedSyncSession,
  type ActiveSyncSessionRecord,
  type CreateSyncSessionInput,
  type SyncSessionRecord,
  type SyncSessionStore,
  type SyncSessionStoreCreateResult,
  type SyncSessionTermination,
  type VerifiedSyncSession,
} from '../../src/sync/index.js';

export const alice = { type: 'user', id: 'alice' } as const;

class MemorySessionStore implements SyncSessionStore {
  readonly state = new Map<string, SyncSessionRecord>();

  async create(session: ActiveSyncSessionRecord): Promise<SyncSessionStoreCreateResult> {
    const existing = this.state.get(session.sessionId);
    if (existing !== undefined) return { state: 'conflict', session: structuredClone(existing) };
    this.state.set(session.sessionId, structuredClone(session));
    return { state: 'created', session: structuredClone(session) };
  }

  async load(sessionId: string): Promise<SyncSessionRecord | undefined> {
    const session = this.state.get(sessionId);
    return session === undefined ? undefined : structuredClone(session);
  }

  async terminate(_termination: SyncSessionTermination): Promise<SyncSessionRecord | undefined> {
    throw new Error('Session termination is not exercised by this fixture.');
  }
}

/** Collection Session for `alice` on `collection-1`, protocol 0.1, unless overridden. */
export async function verifiedSession(
  sessionId: string,
  overrides: Partial<CreateSyncSessionInput> = {},
): Promise<VerifiedSyncSession> {
  const store = new MemorySessionStore();
  const input: CreateSyncSessionInput = {
    sessionId,
    principal: alice,
    credential: { kind: 'token', id: 'token-1' },
    oauthClientId: 'https://client.example/app',
    origin: 'https://client.example',
    sessionScope: 'collection',
    protocolVersion: '0.1',
    collectionId: 'collection-1',
    purpose: null,
    authorizationScopes: ['sync:pull'],
    ...overrides,
  };
  await createSyncSession(store, input);
  const { sessionId: _id, authorizationScopes, ...binding } = input;
  return requireVerifiedSyncSession(store, {
    sessionId,
    binding,
    authorization: { credentialActive: true, authorizationScopes: [...authorizationScopes] },
    terminatedAt: '2026-07-18T02:00:00Z',
  });
}
