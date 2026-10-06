import { describe, expect, it } from 'vitest';

import {
  SYNC_PULL_MAX_LIMIT,
  createSyncSession,
  type ActiveSyncSessionRecord,
  type CreateSyncSessionInput,
  type SyncPullCursorRecord,
  type SyncPullCursorStore,
  type SyncPullEventPage,
  type SyncPullEventStore,
  type SyncPullRequestContext,
  type SyncSessionRecord,
  type SyncSessionStore,
  type SyncSessionStoreCreateResult,
  type SyncSessionTermination,
} from '../../src/sync/index.js';
import {
  coordinateSyncPull,
} from '../../src/sync/unsafe.js';

const evidence = '[evidence:sync.guards-behavior]';

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

class MemorySessionStore implements SyncSessionStore {
  private readonly state = new Map<string, SyncSessionRecord>();

  public async create(session: ActiveSyncSessionRecord): Promise<SyncSessionStoreCreateResult> {
    await Promise.resolve();
    const existing = this.state.get(session.sessionId);
    if (existing !== undefined) {
      return structuredClone({ state: 'conflict', session: existing });
    }
    const stored = structuredClone(session);
    this.state.set(session.sessionId, stored);
    return structuredClone({ state: 'created', session: stored });
  }

  public async load(sessionId: string): Promise<SyncSessionRecord | undefined> {
    await Promise.resolve();
    const session = this.state.get(sessionId);
    return session === undefined ? undefined : structuredClone(session);
  }

  public async terminate(
    _termination: SyncSessionTermination,
  ): Promise<SyncSessionRecord | undefined> {
    await Promise.resolve();
    return undefined;
  }
}

function pullRequest(): SyncPullRequestContext {
  return {
    sessionId: 'session-1',
    principal: { type: 'user', id: 'alice' },
    collectionId: 'collection-1',
    protocolVersion: '0.1',
    cursor: 'cursor-start',
    limit: 10,
  };
}

function startCursor(): SyncPullCursorRecord {
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

function emptyPage(): SyncPullEventPage {
  return {
    entries: [],
    hasMore: false,
    collectionRevision: 'revision-1',
    recommendedPullAfterSeconds: 30,
  };
}

describe(`shared Sync assert-helper public behavior ${evidence}`, () => {
  it.each([
    [
      'symbol key on create input',
      () => Object.assign(collectionInput(), { [Symbol('hidden')]: true }),
      /unknown member/i,
    ],
    [
      'custom-prototype create input',
      () => Object.assign(Object.create({ injected: true }) as object, collectionInput()),
      /plain or null prototype/i,
    ],
    [
      'class-instance create input',
      () => {
        class SessionShape {
          public constructor(private readonly fields: CreateSyncSessionInput) {}

          public get sessionId() { return this.fields.sessionId; }
        }
        return new SessionShape(collectionInput());
      },
      /plain or null prototype|enumerable data properties|must be an object/i,
    ],
    [
      'symbol key on nested principal',
      () => collectionInput({
        principal: Object.assign({ type: 'user', id: 'alice' }, { [Symbol('hidden')]: true }) as never,
      }),
      /unknown member/i,
    ],
    [
      'custom-prototype nested credential',
      () => collectionInput({
        credential: Object.assign(
          Object.create({ injected: true }) as object,
          { kind: 'token', id: 'token-1' },
        ) as never,
      }),
      /plain or null prototype/i,
    ],
  ] as const)(
    `createSyncSession fail-closes on %s ${evidence}`,
    async (_label, buildInput, pattern) => {
      const store = new MemorySessionStore();
      await expect(createSyncSession(store, buildInput() as CreateSyncSessionInput))
        .rejects.toThrow(pattern);
    },
  );

  it(`accepts null-prototype plain data objects on createSyncSession ${evidence}`, async () => {
    const store = new MemorySessionStore();
    const input = Object.assign(Object.create(null) as object, collectionInput()) as CreateSyncSessionInput;
    const principal = Object.assign(Object.create(null) as object, input.principal);
    const credential = Object.assign(Object.create(null) as object, input.credential);
    const accepted = {
      ...input,
      principal,
      credential,
    } as CreateSyncSessionInput;

    await expect(createSyncSession(store, accepted)).resolves.toMatchObject({
      sessionId: 'session-1',
      status: 'active',
    });
  });

  it(`rejects a non-Promise Session store create on the public createSyncSession path ${evidence}`, async () => {
    const store = {
      create: (session: ActiveSyncSessionRecord) => ({ state: 'created' as const, session }),
      load: async () => undefined,
      terminate: async () => undefined,
    } as unknown as SyncSessionStore;

    await expect(createSyncSession(store, collectionInput())).rejects.toThrow(
      /must return a Promise/i,
    );
  });

  it(`refuses a Pull page larger than the library bound ${evidence}`, async () => {
    // The host clamps to its own maxLimit, but a consumer wiring the coordinator
    // directly could otherwise ask for an arbitrarily large page and make it walk
    // every event through a separate cursor lookup.
    const cursorStore: SyncPullCursorStore = { resolveCursor: async () => startCursor() };
    const eventStore: SyncPullEventStore = { readCommittedAfter: async () => emptyPage() };

    await expect(coordinateSyncPull({ ...pullRequest(), limit: SYNC_PULL_MAX_LIMIT + 1 },
      cursorStore, eventStore)).rejects.toThrow(/no greater than/u);
    await expect(coordinateSyncPull({ ...pullRequest(), limit: SYNC_PULL_MAX_LIMIT },
      cursorStore, eventStore)).resolves.toBeDefined();
    await expect(coordinateSyncPull({ ...pullRequest(), limit: 0 },
      cursorStore, eventStore)).rejects.toThrow(/positive safe integer/u);
  });

  it(`rejects a non-Promise Pull cursor store on the public coordinateSyncPull path ${evidence}`, async () => {
    const cursorStore = {
      resolveCursor: (() => startCursor()) as never,
    } as unknown as SyncPullCursorStore;
    const eventStore: SyncPullEventStore = {
      readCommittedAfter: async () => emptyPage(),
    };

    await expect(coordinateSyncPull(pullRequest(), cursorStore, eventStore)).rejects.toThrow(
      /must return a Promise/i,
    );
  });
});
