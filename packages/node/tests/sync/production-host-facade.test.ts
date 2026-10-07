/**
 * Production `./sync` host façade (SYNC-Q-019).
 *
 * Ordinary `@collection-protocol/node/sync` cannot import bare coordinators.
 * `createSyncHost` requires a branded Session and exclusive sequence XOR push.
 */
import { describe, expect, it } from 'vitest';

import * as publicSyncApi from '../../src/sync/index.js';
import * as unsafeApi from '../../src/sync/unsafe.js';
import { DurableContractHandle, request, type TestTransaction, type Conflict, type Audit, type Outbox } from './push-transaction-harness.js';
import {
  SyncSessionGateDeniedError,
  applySyncTypedUpdatePatch,
  createTypedUpdateMergePushPreflight,
  bindSyncPushBatchId,
  createSyncHost,
  createSyncSession,
  isVerifiedSyncSession,
  requireVerifiedSyncSession,
  type ActiveSyncSessionRecord,
  type CreateSyncSessionInput,
  type PushTransactionRequest,
  type SequenceOperationRequest,
  type SyncSessionBinding,
  type SyncSessionRecord,
  type SyncSessionStore,
  type SyncSessionStoreCreateResult,
  type SyncSessionTermination,
  type VerifySyncSessionContextInput,
} from '../../src/sync/index.js';

// This is a package-composition quality gate (SYNC-Q-019), not a protocol
// requirement in the 0.1 bundled conformance-evidence registry.
const evidence = '[SYNC-Q-019]';
const createdAt = '2026-07-18T02:00:00Z';

type DurableSessionState = Map<string, SyncSessionRecord>;

function copy<Value>(value: Value): Value {
  return structuredClone(value);
}

class DurableMemorySessionStore implements SyncSessionStore {
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
    const session = this.state.get(sessionId);
    return session === undefined ? undefined : copy(session);
  }

  public async terminate(termination: SyncSessionTermination): Promise<SyncSessionRecord | undefined> {
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

async function mintVerified(overrides: Partial<CreateSyncSessionInput> = {}) {
  const store = new DurableMemorySessionStore();
  const input = collectionInput(overrides);
  await createSyncSession(store, input);
  const session = await requireVerifiedSyncSession(store, verification(input));
  expect(isVerifiedSyncSession(session)).toBe(true);
  return session;
}

describe('typed patch projection through the production host [C01]', () => {
  it.each([true, false].flatMap(atomic => [undefined, null, 'remote'].map(description => ({ atomic, description }))))(
    'preserves optional fields across two updates: $atomic / $description', async ({ atomic, description }) => {
      const session = await mintVerified();
      const host = createSyncHost({ owner: 'push', session, pushOwnershipVerifier: () => true });
      const adapter = new DurableContractHandle();
      const initial = { title: 'old', serverOnly: 'preserved', ...(description === undefined ? {} : { description }) };
      const current = () => adapter.backend.state.business.length === 0
        ? initial : JSON.parse(adapter.backend.state.business.at(-1)!) as Record<string, unknown>;
      const input = { ...request(atomic, 2), batchId: bindSyncPushBatchId(session.sessionId, 'typed-patch') };
      input.operations.forEach((item, index) => Object.assign(item.operation, {
        type: 'update_node_content', targetId: 'node-1',
        payload: index === 0
          ? { base: { title: 'old', description: 'before' }, value: { title: 'first', description: 'before' } }
          : { base: { title: 'first' }, value: { title: 'second' } },
      }));
      const preflight = createTypedUpdateMergePushPreflight<TestTransaction, Conflict, Audit, Outbox>({
        loadCurrent: async () => current(),
        planMerged: async ({ merged, operation, current: projection }) => ({
          status: 'applied',
          apply: async tx => {
            await tx.putBusiness(JSON.stringify(applySyncTypedUpdatePatch(projection, merged)));
            return { opId: operation.opId, sequence: operation.sequence, status: 'applied', revision: 'r1', warnings: [] };
          },
          audit: async () => ({ id: operation.opId, result: { status: 'applied' } }),
          outbox: async ({ cursor }) => {
            if (cursor === undefined) throw new Error('Applied update requires a cursor');
            return { id: operation.opId, cursor };
          },
        }),
        planConflict: async () => { throw new Error('Unexpected conflict'); },
        planOther: async () => { throw new Error('Unexpected operation'); },
      });
      await host.push(adapter, input, preflight);
      expect(current()).toEqual({ ...initial, title: 'second' });
      expect(Object.hasOwn(current(), 'description')).toBe(description !== undefined);
      expect(adapter.backend.state.receipts).toHaveLength(2);
    },
  );
});

const unusedUnitOfWork = {
  operationIdReservationOwner: 'sequence' as const,
  execute: async () => {
    throw new Error('unit of work must not run');
  },
};

const unusedPushUnitOfWork = {
  operationIdReservationOwner: 'push' as const,
  execute: async () => {
    throw new Error('unit of work must not run');
  },
};

function sequenceRequest(): SequenceOperationRequest {
  return {
    operationId: 'operation-1',
    replicaId: 'replica-1',
    sequenceScope: 'collection-1',
    sequence: 1,
    digest: 'sha-256:digest-1',
  };
}

function pushRequest(batchId: string): PushTransactionRequest {
  return {
    batchId,
    atomic: true,
    serverCursor: 'cursor-1',
    operations: [],
  } as unknown as PushTransactionRequest;
}

describe(`production Sync host façade ${evidence}`, () => {
  it(`keeps bare coordinators off ./sync and only on ./sync/unsafe ${evidence}`, () => {
    expect('coordinateSequenceOperation' in publicSyncApi).toBe(false);
    expect('coordinatePushTransaction' in publicSyncApi).toBe(false);
    expect('coordinateSyncPull' in publicSyncApi).toBe(false);
    expect(typeof publicSyncApi.createSyncHost).toBe('function');
    expect(typeof unsafeApi.coordinateSequenceOperation).toBe('function');
    expect(typeof unsafeApi.coordinatePushTransaction).toBe('function');
    expect(typeof unsafeApi.coordinateSyncPull).toBe('function');
  });

  it(`rejects missing Session, unknown owner, and dual-owner bags at runtime ${evidence}`, async () => {
    const session = await mintVerified();
    expect(() => createSyncHost({ owner: 'sequence' } as never)).toThrow(SyncSessionGateDeniedError);
    expect(() => createSyncHost({ owner: 'both', session } as never)).toThrow(TypeError);
    expect(() => createSyncHost({ owners: ['sequence', 'push'], session } as never)).toThrow(TypeError);
    expect(() => createSyncHost(null as never)).toThrow(TypeError);
  });

  it(`rejects a forged VerifiedSyncSession brand with no silent fallback ${evidence}`, async () => {
    const session = await mintVerified();
    const forged = {
      ...Object.fromEntries(Object.entries(session)),
      status: 'active' as const,
    };
    expect(isVerifiedSyncSession(forged)).toBe(false);
    expect(() => createSyncHost({ owner: 'sequence', session: forged as typeof session }))
      .toThrow(SyncSessionGateDeniedError);
  });

  it(`returns a sequence host that cannot dispatch Push ${evidence}`, async () => {
    const session = await mintVerified();
    const host = createSyncHost({ owner: 'sequence', session });
    expect(host.owner).toBe('sequence');
    expect('push' in host).toBe(false);
    expect(typeof host.sequence).toBe('function');
    expect(typeof host.pull).toBe('function');
  });

  it(`returns a push host that cannot dispatch Sequence ${evidence}`, async () => {
    const session = await mintVerified();
    const host = createSyncHost({ owner: 'push', session, pushOwnershipVerifier: () => true });
    expect(host.owner).toBe('push');
    expect('sequence' in host).toBe(false);
    expect(typeof host.push).toBe('function');
  });

  it(`fail-closes Sequence writes when the Session lacks sync:push ${evidence}`, async () => {
    const session = await mintVerified({ authorizationScopes: ['sync:pull'] });
    const host = createSyncHost({ owner: 'sequence', session });
    await expect(host.sequence(unusedUnitOfWork, sequenceRequest(), async () => {
      throw new Error('evaluator must not run');
    })).rejects.toMatchObject({
      name: 'SyncSessionGateDeniedError',
      denial: { state: 'scope_missing', requiredScope: 'sync:push' },
    });
  });

  it(`fail-closes Push writes when batchId is not bound to the Session ${evidence}`, async () => {
    const session = await mintVerified();
    const host = createSyncHost({ owner: 'push', session, pushOwnershipVerifier: () => true });
    await expect(host.push(
      unusedPushUnitOfWork,
      pushRequest('unrelated-batch'),
      async () => {
        throw new Error('preflight must not run');
      },
    )).rejects.toBeInstanceOf(SyncSessionGateDeniedError);
    const bound = bindSyncPushBatchId(session.sessionId, 'local-1');
    expect(bound.startsWith('b1.')).toBe(true);
    expect(bound.startsWith(`${session.sessionId}.`)).toBe(false);
  });
});
