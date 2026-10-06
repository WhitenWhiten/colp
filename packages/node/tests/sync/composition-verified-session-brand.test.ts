import { describe, expect, it } from 'vitest';

import {
  SyncSessionGateDeniedError,
  coordinateSessionBoundPull,
  createReplicaAuthProofFromVerifiedSession,
  createSyncSession,
  isVerifiedSyncSession,
  requireVerifiedSyncSession,
  type ActiveSyncSessionRecord,
  type CreateSyncSessionInput,
  type SyncPullCursorRecord,
  type SyncPullCursorStore,
  type SyncPullEventPage,
  type SyncPullEventReadRequest,
  type SyncPullEventStore,
  type SyncPullRequestContext,
  type SyncSessionBinding,
  type SyncSessionRecord,
  type SyncSessionStore,
  type SyncSessionStoreCreateResult,
  type SyncSessionTermination,
  type VerifySyncSessionContextInput,
} from '../../src/sync/index.js';

const evidence = '[evidence:sync.composition]';
const createdAt = '2026-07-18T02:00:00Z';

type DurableSessionState = Map<string, SyncSessionRecord>;

function copy<Value>(value: Value): Value {
  return structuredClone(value);
}

class DurableMemorySessionStore implements SyncSessionStore {
  public readonly loadCalls: string[] = [];

  public constructor(private readonly state: DurableSessionState = new Map()) {}

  public async create(session: ActiveSyncSessionRecord): Promise<SyncSessionStoreCreateResult> {
    await Promise.resolve();
    const existing = this.state.get(session.sessionId);
    if (existing !== undefined) return copy({ state: 'conflict', session: existing });
    const stored = copy(session);
    this.state.set(session.sessionId, stored);
    return copy({ state: 'created', session: stored });
  }

  public async load(sessionId: string): Promise<SyncSessionRecord | undefined> {
    await Promise.resolve();
    this.loadCalls.push(sessionId);
    const session = this.state.get(sessionId);
    return session === undefined ? undefined : copy(session);
  }

  public async terminate(
    termination: SyncSessionTermination,
  ): Promise<SyncSessionRecord | undefined> {
    await Promise.resolve();
    const existing = this.state.get(termination.sessionId);
    if (existing === undefined) return undefined;
    if (existing.status === 'terminated') return copy(existing);
    const terminated: SyncSessionRecord = {
      ...copy(existing),
      status: 'terminated',
      terminationReason: termination.reason,
      terminatedAt: termination.terminatedAt,
    };
    this.state.set(termination.sessionId, terminated);
    return copy(terminated);
  }
}

function collectionInput(
  overrides: Partial<CreateSyncSessionInput> = {},
): CreateSyncSessionInput {
  return {
    sessionId: 'session-1',
    principal: { type: 'user', id: 'alice' },
    credential: { kind: 'token', id: 'token-1' },
    oauthClientId: 'https://client.example/app',
    origin: 'https://client.example',
    sessionScope: 'collection',
    protocolVersion: '0.1',
    collectionId: 'collection-1',
    purpose: null,
    authorizationScopes: ['sync:pull', 'sync:push'],
    ...overrides,
  };
}

function binding(input: CreateSyncSessionInput): SyncSessionBinding {
  return {
    principal: copy(input.principal),
    credential: copy(input.credential),
    oauthClientId: input.oauthClientId,
    origin: input.origin,
    sessionScope: input.sessionScope,
    protocolVersion: input.protocolVersion,
    collectionId: input.collectionId,
    purpose: input.purpose,
  };
}

function verification(
  input: CreateSyncSessionInput,
  overrides: Partial<VerifySyncSessionContextInput> = {},
): VerifySyncSessionContextInput {
  return {
    sessionId: input.sessionId,
    binding: binding(input),
    authorization: {
      credentialActive: true,
      authorizationScopes: [...input.authorizationScopes],
    },
    terminatedAt: createdAt,
    ...overrides,
  };
}

class TrackingPullCursorStore implements SyncPullCursorStore {
  resolveCalls = 0;

  constructor(private readonly record: SyncPullCursorRecord | null) {}

  async resolveCursor(_cursor: string): Promise<SyncPullCursorRecord | null> {
    await Promise.resolve();
    this.resolveCalls += 1;
    return this.record === null ? null : copy(this.record);
  }
}

class TrackingPullEventStore implements SyncPullEventStore {
  readonly reads: SyncPullEventReadRequest[] = [];

  constructor(private readonly page: SyncPullEventPage) {}

  async readCommittedAfter(request: SyncPullEventReadRequest): Promise<SyncPullEventPage> {
    await Promise.resolve();
    this.reads.push(copy(request));
    return copy(this.page);
  }
}

function pullRequest(overrides: Partial<SyncPullRequestContext> = {}): SyncPullRequestContext {
  return {
    sessionId: 'session-1',
    principal: { type: 'user', id: 'alice' },
    collectionId: 'collection-1',
    protocolVersion: '0.1',
    cursor: 'cursor-start',
    limit: 2,
    ...overrides,
  };
}

function pullCursorRecord(): SyncPullCursorRecord {
  return {
    cursor: 'cursor-start',
    sessionId: 'session-1',
    principal: { type: 'user', id: 'alice' },
    collectionId: 'collection-1',
    protocolVersion: '0.1',
    commitOrdinal: '100',
    state: 'active',
  };
}

describe(`VerifiedSyncSession runtime brand (H-06 WeakSet) ${evidence}`, () => {
  it(`VerifiedSyncSession carries a runtime brand; plain active records are rejected ${evidence}`, async () => {
    const store = new DurableMemorySessionStore();
    const input = collectionInput();
    await createSyncSession(store, input);
    const verified = await requireVerifiedSyncSession(store, verification(input));
    expect(isVerifiedSyncSession(verified)).toBe(true);
    // Object.entries drops symbol brands — rebuild a plain active lookalike.
    const plainActive = {
      ...Object.fromEntries(Object.entries(verified)),
      status: 'active' as const,
    } as typeof verified;
    expect(isVerifiedSyncSession(plainActive)).toBe(false);
    expect(isVerifiedSyncSession({ status: 'active', sessionId: input.sessionId })).toBe(false);

    const cursorStore = new TrackingPullCursorStore(pullCursorRecord());
    const eventStore = new TrackingPullEventStore({
      entries: [],
      hasMore: false,
      collectionRevision: 'revision-1',
      recommendedPullAfterSeconds: 30,
    });
    const request = pullRequest({
      sessionId: input.sessionId,
      principal: input.principal,
      collectionId: input.collectionId!,
      protocolVersion: input.protocolVersion,
    });

    // kind: 'verified' with a plain active record (no runtime brand) fail-closes.
    await expect(
      coordinateSessionBoundPull(
        { kind: 'verified', session: plainActive },
        request,
        cursorStore,
        eventStore,
      ),
    ).rejects.toMatchObject({
      name: 'SyncSessionGateDeniedError',
      denial: {
        state: 'request_binding_mismatch',
        detail: expect.stringMatching(/runtime brand|package-minted/i) as string,
      },
    });
    expect(cursorStore.resolveCalls).toBe(0);

    // package-minted verified session still works
    await expect(
      coordinateSessionBoundPull(
        { kind: 'verified', session: verified },
        request,
        cursorStore,
        eventStore,
      ),
    ).resolves.toMatchObject({ session: verified });
  });

  it(`rejects kind: verified after spreading a minted Session with a substituted binding ${evidence}`, async () => {
    const store = new DurableMemorySessionStore();
    const input = collectionInput();
    await createSyncSession(store, input);
    const verified = await requireVerifiedSyncSession(store, verification(input));
    expect(isVerifiedSyncSession(verified)).toBe(true);

    const spreadCopy = {
      ...verified,
      principal: { type: 'user' as const, id: 'mallory' },
      collectionId: 'collection-forged',
    };
    expect(spreadCopy.status).toBe('active');
    expect(isVerifiedSyncSession(spreadCopy)).toBe(false);

    const cursorStore = new TrackingPullCursorStore(pullCursorRecord());
    const eventStore = new TrackingPullEventStore({
      entries: [],
      hasMore: false,
      collectionRevision: 'revision-1',
      recommendedPullAfterSeconds: 30,
    });
    const request = pullRequest({
      sessionId: spreadCopy.sessionId,
      principal: spreadCopy.principal,
      collectionId: spreadCopy.collectionId!,
      protocolVersion: spreadCopy.protocolVersion,
    });

    let denial: unknown;
    try {
      await coordinateSessionBoundPull(
        { kind: 'verified', session: spreadCopy },
        request,
        cursorStore,
        eventStore,
      );
    } catch (error) {
      denial = error;
    }
    expect(denial).toBeInstanceOf(SyncSessionGateDeniedError);
    expect(denial).toMatchObject({
      name: 'SyncSessionGateDeniedError',
      denial: {
        state: 'request_binding_mismatch',
        detail: expect.stringMatching(/runtime brand|package-minted/i) as string,
      },
    });
    expect(cursorStore.resolveCalls).toBe(0);

    await expect(
      coordinateSessionBoundPull(
        { kind: 'verified', session: verified },
        pullRequest({
          sessionId: input.sessionId,
          principal: input.principal,
          collectionId: input.collectionId!,
          protocolVersion: input.protocolVersion,
        }),
        cursorStore,
        eventStore,
      ),
    ).resolves.toMatchObject({ session: verified });
  });

  it(`createReplicaAuthProofFromVerifiedSession rejects plain session objects ${evidence}`, async () => {
    const store = new DurableMemorySessionStore();
    const input = collectionInput();
    await createSyncSession(store, input);
    const verified = await requireVerifiedSyncSession(store, verification(input));
    const forged = {
      ...Object.fromEntries(Object.entries(verified)),
      status: 'active' as const,
    } as typeof verified;
    expect(() => createReplicaAuthProofFromVerifiedSession(forged)).toThrow(
      /package-minted VerifiedSyncSession/i,
    );
    expect(() => createReplicaAuthProofFromVerifiedSession(verified)).not.toThrow();
  });
});
