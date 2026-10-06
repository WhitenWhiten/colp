import { describe, expect, it } from 'vitest';

import * as publicSyncApi from '../../src/sync/index.js';
import {
  SyncSessionAlreadyExistsError,
  SyncSessionGateDeniedError,
  assertVerifiedSyncSession,
  createSyncSession,
  isVerifiedSyncSession,
  requireVerifiedSyncSession,
  terminateSyncSession,
  verifySyncSessionContext,
  type ActiveSyncSessionRecord,
  type CreateSyncSessionInput,
  type SyncSessionBinding,
  type SyncSessionRecord,
  type SyncSessionStore,
  type SyncSessionStoreCreateResult,
  type SyncSessionTermination,
  type VerifySyncSessionContextInput,
} from '../../src/sync/index.js';

const evidence = '[evidence:sync.session]';
const createdAt = '2026-07-18T02:00:00Z';
const later = '2026-07-18T02:30:00Z';

type DurableState = Map<string, SyncSessionRecord>;
type MutableBinding = {
  -readonly [Key in keyof SyncSessionBinding]: SyncSessionBinding[Key]
};

function copy<Value>(value: Value): Value {
  return structuredClone(value);
}

class DurableMemorySessionStore implements SyncSessionStore {
  public constructor(private readonly state: DurableState = new Map()) {}

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

  public restart(): DurableMemorySessionStore {
    return new DurableMemorySessionStore(this.state);
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

describe('SYNC-0001 Sync Session binding', () => {
  it(`exposes the Session API from the Sync public entry with stable identities ${evidence}`, () => {
    expect(publicSyncApi.SyncSessionAlreadyExistsError).toBe(SyncSessionAlreadyExistsError);
    expect(publicSyncApi.createSyncSession).toBe(createSyncSession);
    expect(publicSyncApi.terminateSyncSession).toBe(terminateSyncSession);
    expect(publicSyncApi.verifySyncSessionContext).toBe(verifySyncSessionContext);
  });

  it(`creates and verifies one durable Principal-to-Collection binding ${evidence}`, async () => {
    const store = new DurableMemorySessionStore();
    const input = collectionInput();

    const created = await createSyncSession(store, input);
    const checked = await verifySyncSessionContext(store, verification(input));

    expect(created).toEqual({ ...input, authorizationScopes: ['sync:pull', 'sync:push'], status: 'active' });
    expect(checked).toEqual({ state: 'active', session: created });
    await expect(store.load(input.sessionId)).resolves.toEqual(created);
  });

  it.each([
    ['Principal', (value: MutableBinding) => { value.principal = { type: 'user', id: 'mallory' }; }],
    ['Collection', (value: MutableBinding) => { value.collectionId = 'collection-2'; }],
    ['Token ID', (value: MutableBinding) => { value.credential = { kind: 'token', id: 'token-2' }; }],
    ['credential kind', (value: MutableBinding) => { value.credential = { kind: 'key', id: 'token-1' }; }],
    ['OAuth Client', (value: MutableBinding) => { value.oauthClientId = 'https://other.example/app'; }],
    ['Origin', (value: MutableBinding) => { value.origin = 'https://other.example'; }],
    ['Session scope', (value: MutableBinding) => { value.sessionScope = 'instance'; value.collectionId = null; value.purpose = 'create_collection'; }],
  ] as const)(`returns context_mismatch for a different %s ${evidence}`, async (_label, mutate) => {
    const store = new DurableMemorySessionStore();
    const input = collectionInput();
    const created = await createSyncSession(store, input);
    const different = copy(binding(input)) as MutableBinding;
    mutate(different);

    await expect(verifySyncSessionContext(store, verification(input, {
      binding: different,
    }))).resolves.toEqual({ state: 'context_mismatch' });
    await expect(store.load(input.sessionId)).resolves.toEqual(created);
  });

  it(`treats a negotiated 0.2 binding as a different Session context ${evidence}`, async () => {
    const store = new DurableMemorySessionStore();
    const input = collectionInput();
    const created = await createSyncSession(store, input);
    const different = copy(binding(input)) as MutableBinding;
    different.protocolVersion = '0.2';

    await expect(verifySyncSessionContext(store, verification(input, {
      binding: different,
    }))).resolves.toEqual({ state: 'context_mismatch' });
    await expect(store.load(input.sessionId)).resolves.toEqual(created);
  });

  it(`creates an explicitly negotiated COLP 0.2 Session without changing 0.1 ${evidence}`, async () => {
    const store = new DurableMemorySessionStore();
    const input = collectionInput({ sessionId: 'session-v02', protocolVersion: '0.2' });
    const created = await createSyncSession(store, input);
    expect(created.protocolVersion).toBe('0.2');
    await expect(verifySyncSessionContext(store, verification(input)))
      .resolves.toEqual({ state: 'active', session: created });
  });

  it(`does not let an unbound Instance Session access a Collection ${evidence}`, async () => {
    const store = new DurableMemorySessionStore();
    const instance = collectionInput({
      sessionId: 'instance-session',
      sessionScope: 'instance',
      collectionId: null,
      purpose: 'create_collection',
      authorizationScopes: ['collections:create', 'sync:bootstrap', 'sync:push'],
    });
    const created = await createSyncSession(store, instance);
    const collectionContext = collectionInput({
      sessionId: instance.sessionId,
      collectionId: 'collection-generated',
      authorizationScopes: instance.authorizationScopes,
    });

    await expect(
      verifySyncSessionContext(store, verification(collectionContext)),
    ).resolves.toEqual({ state: 'context_mismatch' });
    await expect(store.load(instance.sessionId)).resolves.toEqual(created);
  });

  it(`rejects invalid Instance and Collection scope shapes and grants specifically ${evidence}`, async () => {
    const store = new DurableMemorySessionStore();

    await expect(createSyncSession(store, collectionInput({
      sessionScope: 'instance',
      collectionId: 'client-chosen',
      purpose: 'create_collection',
    }))).rejects.toThrow('unbound instance-scoped Sync Session');
    await expect(createSyncSession(store, collectionInput({
      collectionId: null,
    }))).rejects.toThrow('must bind one Collection');
    await expect(createSyncSession(store, collectionInput({
      sessionScope: 'instance',
      collectionId: null,
      purpose: 'create_collection',
      authorizationScopes: ['sync:bootstrap', 'sync:push'],
    }))).rejects.toThrow('requires sync:bootstrap, sync:push, and collections:create');
  });

  it(`keeps the first Collection binding fixed on Session ID conflict ${evidence}`, async () => {
    const store = new DurableMemorySessionStore();
    const original = await createSyncSession(store, collectionInput());

    await expect(createSyncSession(store, collectionInput({
      collectionId: 'collection-2',
    }))).rejects.toBeInstanceOf(SyncSessionAlreadyExistsError);
    await expect(store.load('session-1')).resolves.toEqual(original);
  });

  it(`terminates durably when the bound Token or Key is revoked ${evidence}`, async () => {
    const store = new DurableMemorySessionStore();
    const input = collectionInput({ credential: { kind: 'key', id: 'key-7' } });
    await createSyncSession(store, input);

    const result = await verifySyncSessionContext(store, verification(input, {
      authorization: {
        credentialActive: false,
        authorizationScopes: [...input.authorizationScopes],
      },
    }));

    expect(result).toMatchObject({
      state: 'terminated',
      session: {
        sessionId: input.sessionId,
        credential: { kind: 'key', id: 'key-7' },
        status: 'terminated',
        terminationReason: 'credential_revoked',
        terminatedAt: createdAt,
      },
    });
    await expect(store.load(input.sessionId)).resolves.toEqual(
      result.state === 'terminated' ? result.session : undefined,
    );
  });

  it(`terminates when any granted authorization Scope is removed ${evidence}`, async () => {
    const store = new DurableMemorySessionStore();
    const input = collectionInput();
    await createSyncSession(store, input);

    const result = await verifySyncSessionContext(store, verification(input, {
      authorization: { credentialActive: true, authorizationScopes: ['sync:pull'] },
      terminatedAt: later,
    }));

    expect(result).toMatchObject({
      state: 'terminated',
      session: {
        status: 'terminated',
        terminationReason: 'scope_reduced',
        terminatedAt: later,
      },
    });
  });

  it(`makes termination irreversible even after authorization is restored ${evidence}`, async () => {
    const store = new DurableMemorySessionStore();
    const input = collectionInput();
    await createSyncSession(store, input);
    const first = await verifySyncSessionContext(store, verification(input, {
      authorization: { credentialActive: false, authorizationScopes: input.authorizationScopes },
    }));

    const repeated = await terminateSyncSession(store.restart(), {
      sessionId: input.sessionId,
      reason: 'administrative',
      terminatedAt: later,
    });
    const restored = await verifySyncSessionContext(store.restart(), verification(input, {
      authorization: { credentialActive: true, authorizationScopes: input.authorizationScopes },
      terminatedAt: later,
    }));

    expect(first).toMatchObject({ state: 'terminated', session: { terminationReason: 'credential_revoked' } });
    expect(repeated).toEqual(first.state === 'terminated' ? first.session : undefined);
    expect(restored).toEqual(first);
  });

  it(`observes create and termination across independent durable store handles ${evidence}`, async () => {
    const firstProcess = new DurableMemorySessionStore();
    const secondProcess = firstProcess.restart();
    const input = collectionInput();
    const created = await createSyncSession(firstProcess, input);

    await expect(
      verifySyncSessionContext(secondProcess, verification(input)),
    ).resolves.toEqual({ state: 'active', session: created });
    const terminated = await terminateSyncSession(secondProcess, {
      sessionId: input.sessionId,
      reason: 'administrative',
      terminatedAt: later,
    });
    await expect(firstProcess.load(input.sessionId)).resolves.toEqual(terminated);
  });

  it(`rejects a store that changes the binding during authorization termination ${evidence}`, async () => {
    const durable = new DurableMemorySessionStore();
    const input = collectionInput();
    await createSyncSession(durable, input);
    const substituteTerminatedBinding = (session: SyncSessionRecord | undefined) => (
      session?.status === 'terminated'
        ? { ...session, collectionId: 'collection-substituted' } as SyncSessionRecord
        : session
    );
    const changingStore: SyncSessionStore = {
      create: (session) => durable.create(session),
      load: async (sessionId) => substituteTerminatedBinding(await durable.load(sessionId)),
      terminate: async (termination) => {
        const terminated = await durable.terminate(termination);
        return substituteTerminatedBinding(terminated);
      },
    };

    await expect(verifySyncSessionContext(changingStore, verification(input, {
      authorization: { credentialActive: false, authorizationScopes: input.authorizationScopes },
    }))).rejects.toThrow('changed the binding while terminating');
  });

  it(`rejects synchronous store methods at the persistence boundary ${evidence}`, async () => {
    const input = collectionInput();
    const synchronousCreate = {
      create: (session: ActiveSyncSessionRecord) => ({ state: 'created', session }),
      load: async () => undefined,
      terminate: async () => undefined,
    } as unknown as SyncSessionStore;

    await expect(createSyncSession(synchronousCreate, input)).rejects.toThrow(
      'Sync Session store create must return a Promise',
    );

    const synchronousLoad = {
      create: async (session: ActiveSyncSessionRecord) => ({ state: 'created' as const, session }),
      load: () => ({ ...input, status: 'active' as const }),
      terminate: async () => undefined,
    } as unknown as SyncSessionStore;
    await expect(createSyncSession(synchronousLoad, input)).rejects.toThrow(
      'Sync Session store read-back must return a Promise',
    );
  });

  it(`detaches and deep-freezes Session inputs, store values, and results ${evidence}`, async () => {
    const state: DurableState = new Map();
    const store = new DurableMemorySessionStore(state);
    const input = collectionInput();
    const before = copy(input);
    const created = await createSyncSession(store, input);

    const mutableInput = input as unknown as {
      principal: { id: string };
      credential: { id: string };
      authorizationScopes: string[];
    };
    mutableInput.principal.id = 'mutated-principal';
    mutableInput.credential.id = 'mutated-token';
    mutableInput.authorizationScopes.push('server:admin');
    const persisted = state.get(before.sessionId)! as unknown as {
      principal: { id: string };
      credential: { id: string };
    };
    persisted.principal.id = 'store-mutated-principal';
    persisted.credential.id = 'store-mutated-token';

    expect(created).toEqual({ ...before, status: 'active' });
    expect(Object.isFrozen(created)).toBe(true);
    expect(Object.isFrozen(created.principal)).toBe(true);
    expect(Object.isFrozen(created.credential)).toBe(true);
    expect(Object.isFrozen(created.authorizationScopes)).toBe(true);
    expect(Reflect.set(created.principal, 'id', 'result-mutated')).toBe(false);
    expect(created.principal.id).toBe('alice');
  });

  it(`mints VerifiedSyncSession by identity; object spread copies fail closed ${evidence}`, async () => {
    const store = new DurableMemorySessionStore();
    const input = collectionInput();
    await createSyncSession(store, input);

    const checked = await verifySyncSessionContext(store, verification(input));
    expect(checked).toMatchObject({ state: 'active', session: { status: 'active' } });
    if (checked.state !== 'active') {
      throw new Error('expected an active verification result');
    }
    // Durable verify success is not itself the runtime brand.
    expect(isVerifiedSyncSession(checked.session)).toBe(false);
    expect(isVerifiedSyncSession({ ...checked.session, status: 'active' })).toBe(false);

    // A host-reachable object that only matches the public result shape must
    // not be able to mint the package's stronger runtime Session brand.
    expect(() => assertVerifiedSyncSession({
      state: 'active',
      session: checked.session,
    })).toThrow(SyncSessionGateDeniedError);

    const verified = assertVerifiedSyncSession(checked);
    expect(isVerifiedSyncSession(verified)).toBe(true);
    expect(verified.status).toBe('active');
    expect(Object.getOwnPropertySymbols(verified)).toEqual([]);
    await expect(requireVerifiedSyncSession(store, verification(input))).resolves.toMatchObject({
      sessionId: input.sessionId,
      status: 'active',
      principal: input.principal,
      collectionId: input.collectionId,
    });

    const spreadCopy = {
      ...verified,
      principal: { type: 'user' as const, id: 'mallory' },
      collectionId: 'collection-forged',
    };
    expect(spreadCopy.status).toBe('active');
    expect(isVerifiedSyncSession(spreadCopy)).toBe(false);
    expect(isVerifiedSyncSession({ ...verified })).toBe(false);
    expect(isVerifiedSyncSession({ status: 'active' })).toBe(false);
  });
});
