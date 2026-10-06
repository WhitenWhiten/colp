/**
 * U-3 Sync Core-used Tier A gap closure (round 2).
 * Complements sync-coordinator-edge-cases.test.ts with high-miss branch arms.
 */

import { describe, expect, it, vi } from 'vitest';

import { ServerIdAlreadyReservedError } from '../../src/shared/server-id-reservations.js';
import {
  assertBoundCollection,
  assertAppliedResult,
  assertCursorlessResult,
  assertResultIdentity,
  boundSession,
  finalizeDeferredResult,
  finalizeRejectedResult,
  immutableIdentity,
  immutablePlan,
  immutableReceipt,
  terminatedSession,
} from '../../src/sync/session-bootstrap-state.js';
import {
  appendSyncOperationReuseAudit,
  asReplicaAuthenticatedCommand,
  assertReplicaCallerAuthenticated,
  claimSyncOperations,
  coordinateReplicaLifecycle,
  createReplicaAuthProofFromVerifiedSession,
  createSyncSession,
  immutableSyncOperationClaim,
  isVerifiedSyncSession,
  mergeSyncTypedUpdate,
  requireVerifiedSyncSession,
  terminateSyncSession,
  validateAuthoritativePullEvent,
  verifySyncSessionContext,
  type ActiveSyncSessionRecord,
  type CreateSyncSessionInput,
  type DurableReplicaCheckpoint,
  type PushTransactionRequest,
  type ReplicaLifecycleKey,
  type ReplicaLifecycleTransaction,
  type ReplicaLifecycleUnitOfWork,
  type SyncOperationClaim,
  type SyncOperationReuseAudit,
  type SyncOperationReuseTransaction,
  type SyncSessionRecord,
  type SyncSessionStore,
  type SyncSessionStoreCreateResult,
  type SyncSessionTermination,
  type SyncTransaction,
  type SyncUnitOfWork,
  type StoredOperationReceipt,
} from '../../src/sync/index.js';
import {
  coordinatePushTransaction,
  coordinateSequenceOperation,
} from '../../src/sync/unsafe.js';
import { exactLifecycleObject } from '../../src/sync/replica-lifecycle-parsing.js';
import type { Operation, OperationResult } from '../../src/types/index.js';

const evidence = '[review:sync.core-used-u3-gaps-b]';
const now = '2026-07-18T01:00:00Z';
const future = '2026-07-18T03:00:00Z';
const createdAt = '2026-07-18T02:00:00Z';

function copy<Value>(value: Value): Value {
  return structuredClone(value);
}

// --- Operation reuse reservation race ---------------------------------------

describe(`U-3 Operation reuse reservation race ${evidence}`, () => {
  it(`returns existing when reserve races and concurrent claim appears ${evidence}`, async () => {
    const claims = new Map<string, SyncOperationClaim>();
    const save = vi.fn(async () => undefined);
    const claim: SyncOperationClaim = {
      operationId: 'operation-1',
      digest: 'sha-256:a',
      replicaId: 'replica-1',
      sequenceScope: 'collection-1',
      sequence: 1,
    };
    const concurrent: SyncOperationClaim = {
      ...claim,
      digest: 'sha-256:concurrent',
    };
    let loads = 0;
    const transaction: SyncOperationReuseTransaction = {
      idReservations: {
        reserveAll: async () => {
          throw new ServerIdAlreadyReservedError({
            requested: { id: 'operation-1', resourceType: 'operation' },
            existing: { id: 'operation-1', resourceType: 'operation' },
          });
        },
      },
      operationClaims: {
        load: async (id) => {
          loads += 1;
          if (loads === 1) return undefined;
          return structuredClone(claims.get(id) ?? concurrent);
        },
        save,
      },
      reuseAudits: {
        append: async () => 'audit-1',
        load: async () => undefined,
      },
    };

    const result = await claimSyncOperations(transaction, [claim]);
    expect(result).toEqual({
      kind: 'existing',
      attempted: claim,
      claim: concurrent,
    });
    expect(save).not.toHaveBeenCalled();
  });

  it(`rejects an empty claim batch before reserve ${evidence}`, async () => {
    const reserveAll = vi.fn(async () => ({ state: 'reserved' as const }));
    const transaction: SyncOperationReuseTransaction = {
      idReservations: { reserveAll },
      operationClaims: {
        load: async () => undefined,
        save: async () => undefined,
      },
      reuseAudits: {
        append: async () => 'audit-1',
        load: async () => undefined,
      },
    };
    await expect(claimSyncOperations(transaction, [])).rejects.toThrow(/non-empty array/i);
    expect(reserveAll).not.toHaveBeenCalled();
  });
});

// --- Session terminate read-back / gate -------------------------------------

class DurableMemorySessionStore implements SyncSessionStore {
  public constructor(private readonly state: Map<string, SyncSessionRecord> = new Map()) {}

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

function verification(input: CreateSyncSessionInput) {
  return {
    sessionId: input.sessionId,
    binding: {
      principal: input.principal,
      credential: input.credential,
      oauthClientId: input.oauthClientId,
      origin: input.origin,
      sessionScope: input.sessionScope,
      protocolVersion: input.protocolVersion,
      collectionId: input.collectionId,
      purpose: input.purpose,
    },
    authorization: {
      credentialActive: true,
      authorizationScopes: [...input.authorizationScopes],
    },
    terminatedAt: createdAt,
  };
}

describe(`U-3 Session terminate durable read-back / gate ${evidence}`, () => {
  it(`fails closed when termination durable read-back mutates reason ${evidence}`, async () => {
    const honest = new Map<string, SyncSessionRecord>();
    let loadAfterTerminate = 0;
    const store: SyncSessionStore = {
      create: async (session) => {
        const stored = copy(session);
        honest.set(session.sessionId, stored);
        return { state: 'created', session: stored };
      },
      load: async (sessionId) => {
        const stored = honest.get(sessionId);
        if (stored === undefined) return undefined;
        if (stored.status === 'terminated') {
          loadAfterTerminate += 1;
          if (loadAfterTerminate === 1) {
            return {
              ...copy(stored),
              terminationReason: 'administrative',
            };
          }
        }
        return copy(stored);
      },
      terminate: async (termination) => {
        const existing = honest.get(termination.sessionId);
        if (existing === undefined || existing.status !== 'active') return undefined;
        const terminated: SyncSessionRecord = {
          ...copy(existing),
          status: 'terminated',
          terminationReason: termination.reason,
          terminatedAt: termination.terminatedAt,
        };
        honest.set(termination.sessionId, terminated);
        return copy(terminated);
      },
    };

    const input = collectionInput();
    await createSyncSession(store, input);
    await expect(
      terminateSyncSession(store, {
        sessionId: input.sessionId,
        reason: 'credential_revoked',
        terminatedAt: createdAt,
      }),
    ).rejects.toThrow(/termination failed durable read-back/i);
    expect(honest.get(input.sessionId)).toMatchObject({
      status: 'terminated',
      terminationReason: 'credential_revoked',
    });
  });

  it(`gates terminated Sessions with SyncSessionGateDeniedError carrying the session ${evidence}`, async () => {
    const store = new DurableMemorySessionStore();
    const input = collectionInput();
    await createSyncSession(store, input);
    await terminateSyncSession(store, {
      sessionId: input.sessionId,
      reason: 'administrative',
      terminatedAt: createdAt,
    });

    await expect(requireVerifiedSyncSession(store, verification(input))).rejects.toMatchObject({
      name: 'SyncSessionGateDeniedError',
      denial: {
        state: 'terminated',
        session: expect.objectContaining({
          sessionId: input.sessionId,
          terminationReason: 'administrative',
        }),
      },
    });
  });

  it(`rejects create conflict when returned Session id mismatches ${evidence}`, async () => {
    const honest = new Map<string, SyncSessionRecord>();
    const store: SyncSessionStore = {
      create: async (session) => {
        const stored = copy(session);
        honest.set(session.sessionId, stored);
        return {
          state: 'conflict',
          session: { ...stored, sessionId: 'other-session' },
        };
      },
      load: async () => undefined,
      terminate: async () => undefined,
    };
    await expect(createSyncSession(store, collectionInput())).rejects.toThrow();
    expect(honest.get('session-1')).toMatchObject({ sessionId: 'session-1', status: 'active' });
  });
});

// --- Replica host-verified auth + checkpoint XOR ----------------------------

function replicaCheckpoint(
  overrides: Partial<DurableReplicaCheckpoint> = {},
): DurableReplicaCheckpoint {
  return {
    replicaId: 'replica-1',
    collectionId: 'collection-1',
    leaseId: 'lease-1',
    generation: 'generation-1',
    lastSeenAt: now,
    leaseExpiresAt: future,
    acknowledgedCursor: null,
    acknowledgedCommitOrdinal: null,
    lifecycle: 'active',
    ...overrides,
  };
}

class MemoryReplicaLifecycle implements ReplicaLifecycleUnitOfWork {
  replicas = new Map<string, DurableReplicaCheckpoint>();
  authoritativeTime = now;

  constructor(initial?: DurableReplicaCheckpoint) {
    if (initial !== undefined) this.replicas.set(initial.replicaId, copy(initial));
  }

  async execute<Value>(
    _replicaId: string,
    work: (transaction: ReplicaLifecycleTransaction) => Promise<Value>,
  ): Promise<Value> {
    const draft = new Map(
      [...this.replicas].map(([id, value]) => [id, structuredClone(value)]),
    );
    const result = await work({
      loadReplica: async (id) => structuredClone(draft.get(id)),
      saveReplica: async (checkpoint) => {
        draft.set(checkpoint.replicaId, structuredClone(checkpoint));
      },
      readAuthoritativeTime: async () => this.authoritativeTime,
      loadRetentionWindow: async () => ({
        collectionId: 'collection-1',
        earliestPull: { cursor: 'wire-z', commitOrdinal: '8' },
        purgedThrough: { cursor: 'wire-a', commitOrdinal: '9' },
        snapshotUrl: 'https://sync.example/snapshots/current',
      }),
      loadAuthoritativeSnapshot: async () => undefined,
      saveSnapshotAck: async () => undefined,
      loadSnapshotAck: async () => undefined,
    });
    this.replicas = draft;
    return result;
  }
}

describe(`U-3 Replica host-verified proof / checkpoint invariants ${evidence}`, () => {
  it(`renews via assertReplicaCallerAuthenticated host-verified proof ${evidence}`, async () => {
    const proof = assertReplicaCallerAuthenticated({
      authenticated: true,
      source: 'host-verified',
    });
    expect(proof.source).toBe('host-verified');
    const handle = new MemoryReplicaLifecycle(replicaCheckpoint());
    const extended = '2026-07-18T04:00:00Z';
    const key: ReplicaLifecycleKey = {
      replicaId: 'replica-1',
      collectionId: 'collection-1',
    };
    const result = await coordinateReplicaLifecycle(
      handle,
      key,
      asReplicaAuthenticatedCommand(
        { type: 'renew', leaseExpiresAt: extended, succeeded: true },
        proof,
      ),
    );
    expect(result).toMatchObject({
      state: 'committed',
      checkpoint: { leaseExpiresAt: extended, lifecycle: 'active' },
    });
    expect(handle.replicas.get('replica-1')?.leaseExpiresAt).toBe(extended);
  });

  it(`rejects host-verified assertion when authenticated is not true ${evidence}`, () => {
    expect(() =>
      assertReplicaCallerAuthenticated({
        authenticated: false as unknown as true,
        source: 'host-verified',
      }),
    ).toThrow(/authenticated: true and source host-verified/i);
  });

  it(`rejects non-minted terminated verification results (brand fail-closed; not bare authenticated) ${evidence}`, async () => {
    const store = new DurableMemorySessionStore();
    const input = collectionInput();
    await createSyncSession(store, input);
    await terminateSyncSession(store, {
      sessionId: input.sessionId,
      reason: 'administrative',
      terminatedAt: createdAt,
    });
    const verified = await verifySyncSessionContext(store, verification(input));
    expect(verified.state).toBe('terminated');
    // Terminated verification is not a package-minted VerifiedSyncSession; the
    // status!=='active' arm after isVerifiedSyncSession is unreachable because
    // the brand guard already requires status==='active'.
    expect(() =>
      createReplicaAuthProofFromVerifiedSession(verified as never),
    ).toThrow(/package-minted VerifiedSyncSession/i);
  });

  it(`rejects checkpoint with cursor XOR ordinal and leaves durable map unchanged ${evidence}`, async () => {
    const handle = new MemoryReplicaLifecycle(
      replicaCheckpoint({
        acknowledgedCursor: 'cursor-a',
        acknowledgedCommitOrdinal: null,
      }),
    );
    const before = copy(handle.replicas.get('replica-1')!);
    const proof = assertReplicaCallerAuthenticated({
      authenticated: true,
      source: 'host-verified',
    });
    await expect(
      coordinateReplicaLifecycle(
        handle,
        { replicaId: 'replica-1', collectionId: 'collection-1' },
        asReplicaAuthenticatedCommand(
          { type: 'renew', leaseExpiresAt: '2026-07-18T05:00:00Z', succeeded: true },
          proof,
        ),
      ),
    ).rejects.toThrow(/present together/i);
    expect(handle.replicas.get('replica-1')).toEqual(before);
  });

  it(`rejects register when leaseExpiresAt is not after authoritative time ${evidence}`, async () => {
    const handle = new MemoryReplicaLifecycle();
    const proof = assertReplicaCallerAuthenticated({
      authenticated: true,
      source: 'host-verified',
    });
    await expect(
      coordinateReplicaLifecycle(
        handle,
        { replicaId: 'replica-1', collectionId: 'collection-1' },
        asReplicaAuthenticatedCommand(
          {
            type: 'register',
            collectionId: 'collection-1',
            leaseId: 'lease-1',
            generation: 'generation-1',
            leaseExpiresAt: now,
            succeeded: true,
          },
          proof,
        ),
      ),
    ).resolves.toEqual({ state: 'denied', code: 'invalid_lease_expiry' });
    expect(handle.replicas.size).toBe(0);
  });
});

// --- Bootstrap-state validators (Tier A production deps) --------------------

describe(`U-3 Bootstrap-state prepare fail-closed validators ${evidence}`, () => {
  const identity = {
    collectionId: 'collection-server-1',
    rootNodeId: 'root-server-1',
    revision: 'revision-server-1',
  };

  it(`rejects non-distinct allocated bootstrap identities ${evidence}`, () => {
    expect(() =>
      immutableIdentity({
        collectionId: 'same',
        rootNodeId: 'same',
        revision: 'revision-1',
      }),
    ).toThrow(/must be distinct/i);
  });

  it(`rejects applied result missing boundCollection ${evidence}`, () => {
    expect(() =>
      assertAppliedResult({
        opId: 'op-1',
        sequence: 1,
        status: 'applied',
        revision: 'revision-1',
        cursor: 'cursor-1',
        warnings: [],
      } as never),
    ).toThrow(/requires boundCollection/i);
  });

  it(`rejects boundCollection that diverges from committed identity ${evidence}`, () => {
    expect(() =>
      assertBoundCollection(
        {
          collectionId: 'wrong',
          snapshotRequired: false,
          serverCursor: 'cursor-1',
          serverRevision: identity.revision,
        },
        identity,
        'cursor-1',
      ),
    ).toThrow(/differs from committed server identity/i);
  });

  it(`rejects deferred result that carries cursor or boundCollection ${evidence}`, () => {
    expect(() =>
      assertCursorlessResult(
        {
          opId: 'op-1',
          sequence: 1,
          status: 'deferred',
          code: 'pending',
          warnings: [],
          cursor: 'cursor-leak',
        } as never,
        'deferred',
      ),
    ).toThrow(/cursorless and unbound/i);
  });

  it(`rejects result identity mismatch against Operation ${evidence}`, () => {
    expect(() =>
      assertResultIdentity(
        {
          opId: 'other',
          sequence: 1,
          status: 'applied',
          warnings: [],
          revision: 'r1',
          cursor: 'c1',
          boundCollection: {
            collectionId: identity.collectionId,
            snapshotRequired: false,
            serverCursor: 'c1',
            serverRevision: identity.revision,
          },
        } as never,
        { opId: 'op-1', sequence: 1 } as never,
        'applied',
      ),
    ).toThrow(/does not match its Operation/i);
  });
});

// --- Typed-update merge conflict arms ---------------------------------------

describe(`U-3 Typed-update merge conflict / alias ${evidence}`, () => {
  it(`reports tags conflict for non-array tags instead of silent merge ${evidence}`, () => {
    const result = mergeSyncTypedUpdate({
      base: { tags: ['a'] },
      current: { tags: ['a'] },
      incoming: { tags: 'not-an-array' as never },
    });
    expect(result).toMatchObject({
      status: 'conflict',
      conflicts: [expect.objectContaining({ field: 'tags' })],
    });
  });

  it(`rejects symbol keys on merge inputs ${evidence}`, () => {
    const incoming = { title: 'x' } as Record<string | symbol, unknown>;
    incoming[Symbol('leak')] = 'nope';
    expect(() =>
      mergeSyncTypedUpdate({
        base: { title: 'a' },
        current: { title: 'a' },
        incoming: incoming as never,
      }),
    ).toThrow(/symbol keys/i);
  });
});

// --- Atomic Push local reuse / claim-without-receipt ------------------------

type Conflict = Readonly<{ id: string }>;
type BusinessAudit = Readonly<{ id: string }>;
type Outbox = Readonly<{ id: string }>;

interface PushState {
  claims: Map<string, SyncOperationClaim>;
  reuseAudits: Map<string, SyncOperationReuseAudit>;
  pushById: Map<string, StoredOperationReceipt<OperationResult>>;
  pushBySequence: Map<string, StoredOperationReceipt<OperationResult>>;
  business: string[];
  ledger: Set<string>;
}

function emptyPushState(): PushState {
  return {
    claims: new Map(),
    reuseAudits: new Map(),
    pushById: new Map(),
    pushBySequence: new Map(),
    business: [],
    ledger: new Set(),
  };
}

interface PushTx extends SyncTransaction<Operation, OperationResult, Conflict, BusinessAudit, Outbox> {
  putBusiness(value: string): Promise<void>;
}

class MinimalPushHandle implements SyncUnitOfWork<
  Operation,
  OperationResult,
  Conflict,
  BusinessAudit,
  Outbox,
  PushTx
> {
  readonly operationIdReservationOwner = 'push' as const;
  preflights = 0;
  applies = 0;
  constructor(readonly state: PushState = emptyPushState()) {}

  execute<Value>(work: (transaction: PushTx) => Promise<Value>): Promise<Value> {
    const draft: PushState = {
      claims: new Map([...this.state.claims].map(([k, v]) => [k, structuredClone(v)])),
      reuseAudits: new Map(
        [...this.state.reuseAudits].map(([k, v]) => [k, structuredClone(v)]),
      ),
      pushById: new Map([...this.state.pushById].map(([k, v]) => [k, structuredClone(v)])),
      pushBySequence: new Map(
        [...this.state.pushBySequence].map(([k, v]) => [k, structuredClone(v)]),
      ),
      business: [...this.state.business],
      ledger: new Set(this.state.ledger),
    };
    return (async () => {
      const result = await work({
        idReservations: {
          reserveAll: async (reservations) => {
            for (const reservation of reservations) {
              if (draft.ledger.has(reservation.id)) {
                throw new ServerIdAlreadyReservedError({
                  requested: reservation,
                  existing: { id: reservation.id, resourceType: 'operation' },
                });
              }
              draft.ledger.add(reservation.id);
            }
            return { state: 'reserved' as const };
          },
        },
        operationClaims: {
          load: async (id) => structuredClone(draft.claims.get(id)),
          save: async (claim) => {
            draft.claims.set(claim.operationId, structuredClone(claim));
          },
        },
        reuseAudits: {
          append: async (audit) => {
            const key = `audit-${draft.reuseAudits.size + 1}`;
            draft.reuseAudits.set(key, structuredClone(audit));
            return key;
          },
          load: async (key) => structuredClone(draft.reuseAudits.get(key)),
        },
        receipts: {
          findByOperationId: async (id) => structuredClone(draft.pushById.get(id)),
          findBySequence: async (replicaId, scope, sequence) =>
            structuredClone(draft.pushBySequence.get(JSON.stringify([replicaId, scope, sequence]))),
          save: async (receipt) => {
            draft.pushById.set(receipt.operationId, structuredClone(receipt));
            draft.pushBySequence.set(
              JSON.stringify([receipt.replicaId, receipt.sequenceScope, receipt.sequence]),
              structuredClone(receipt),
            );
          },
        },
        appendOperation: async () => undefined,
        saveConflict: async () => undefined,
        allocateCursor: async () => `cursor-${draft.business.length + 1}`,
        appendAudit: async () => undefined,
        appendOutbox: async () => undefined,
        putBusiness: async (value) => {
          draft.business.push(value);
        },
      });
      this.state.claims = draft.claims;
      this.state.reuseAudits = draft.reuseAudits;
      this.state.pushById = draft.pushById;
      this.state.pushBySequence = draft.pushBySequence;
      this.state.business = draft.business;
      this.state.ledger = draft.ledger;
      return result;
    })();
  }
}

function pushOp(operationId: string, sequence: number): Operation {
  return {
    opId: operationId,
    replicaId: 'replica-1',
    sequence,
    type: 'delete_node',
    occurredAt: now,
    collectionId: 'collection-1',
    targetId: `node-${sequence}`,
    baseRevision: `revision-${sequence}`,
    payload: {},
  };
}

type AtomicRequestOperation = {
  readonly operation: Operation;
  readonly digest: string;
  readonly sequenceScope?: string;
};

function atomicRequest(
  operations: readonly [AtomicRequestOperation, ...AtomicRequestOperation[]],
): PushTransactionRequest {
  const mapOperation = (item: AtomicRequestOperation) => ({
    operation: item.operation,
    sequenceScope: item.sequenceScope ?? 'collection-1',
    digest: item.digest,
  });
  const [first, ...rest] = operations;
  return {
    batchId: 'batch-1',
    atomic: true,
    serverCursor: 'cursor-0',
    operations: [mapOperation(first), ...rest.map(mapOperation)],
  };
}

describe(`U-3 Atomic Push local reuse / claim-without-receipt ${evidence}`, () => {
  it(`rejects duplicate exact Operation in one atomic batch before preflight ${evidence}`, async () => {
    const handle = new MinimalPushHandle();
    const op = pushOp('op-1', 1);
    const preflight = vi.fn(async () => {
      throw new Error('preflight must not run');
    });
    await expect(
      coordinatePushTransaction(
        handle,
        atomicRequest([
          { operation: op, digest: 'digest-A' },
          { operation: structuredClone(op), digest: 'digest-A' },
        ]),
        preflight,
      ),
    ).rejects.toThrow(/same Operation more than once/i);
    expect(preflight).not.toHaveBeenCalled();
    expect(handle.state.claims.size).toBe(0);
    expect(handle.state.business).toEqual([]);
  });

  it(`denies same sequence tuple with same digest but different opId via sequence_reuse ${evidence}`, async () => {
    const handle = new MinimalPushHandle();
    const before = emptyPushState();
    await expect(
      coordinatePushTransaction(
        handle,
        atomicRequest([
          { operation: pushOp('op-1', 1), digest: 'digest-A' },
          { operation: pushOp('op-2', 1), digest: 'digest-A' },
        ]),
        async () => {
          throw new Error('preflight must not run');
        },
      ),
    ).rejects.toMatchObject({
      name: 'SyncOperationReuseError',
      audit: expect.objectContaining({ code: 'sequence_reuse' }),
    });
    expect(handle.state.business).toEqual(before.business);
    expect(handle.state.claims.size).toBe(0);
    expect(handle.state.reuseAudits.size).toBe(1);
  });

  it(`rejects same opId+digest with inconsistent Sequence identity ${evidence}`, async () => {
    const handle = new MinimalPushHandle();
    await expect(
      coordinatePushTransaction(
        handle,
        atomicRequest([
          { operation: pushOp('op-1', 1), digest: 'digest-A' },
          { operation: pushOp('op-1', 2), digest: 'digest-A' },
        ]),
        async () => {
          throw new Error('preflight must not run');
        },
      ),
    ).rejects.toThrow(/inconsistent Sequence identity/i);
    expect(handle.state.claims.size).toBe(0);
    expect(handle.state.reuseAudits.size).toBe(0);
  });

  it(`fails closed when lifetime claim exists without indexed Push receipt ${evidence}`, async () => {
    const handle = new MinimalPushHandle();
    handle.state.claims.set('op-1', {
      operationId: 'op-1',
      digest: 'digest-A',
      replicaId: 'replica-1',
      sequenceScope: 'collection-1',
      sequence: 1,
    });
    const beforeClaims = copy([...handle.state.claims.entries()]);
    await expect(
      coordinatePushTransaction(
        handle,
        atomicRequest([{ operation: pushOp('op-1', 1), digest: 'digest-A' }]),
        async () => {
          throw new Error('preflight must not run for claim-without-receipt');
        },
      ),
    ).rejects.toThrow(/without a complete indexed Push receipt/i);
    await expect(
      coordinatePushTransaction(
        handle,
        atomicRequest([{ operation: pushOp('op-1', 1), digest: 'digest-A' }]),
        async () => {
          throw new Error('preflight must not run for claim-without-receipt');
        },
      ),
    ).rejects.toMatchObject({
      name: 'SyncOperationReceiptUnavailableError',
      code: 'receipt_unavailable',
      claim: { operationId: 'op-1', digest: 'digest-A', sequence: 1 },
    });
    expect([...handle.state.claims.entries()]).toEqual(beforeClaims);
    expect(handle.state.business).toEqual([]);
  });

  it(`audits op_id_reused when claim exists with different digest and no receipt ${evidence}`, async () => {
    const handle = new MinimalPushHandle();
    handle.state.claims.set('op-1', {
      operationId: 'op-1',
      digest: 'digest-STORED',
      replicaId: 'replica-1',
      sequenceScope: 'collection-1',
      sequence: 1,
    });
    await expect(
      coordinatePushTransaction(
        handle,
        atomicRequest([{ operation: pushOp('op-1', 1), digest: 'digest-ATTEMPTED' }]),
        async () => {
          throw new Error('preflight must not run');
        },
      ),
    ).rejects.toMatchObject({
      name: 'SyncOperationReuseError',
      audit: expect.objectContaining({ code: 'op_id_reused' }),
    });
    expect(handle.state.business).toEqual([]);
    expect(handle.state.reuseAudits.size).toBe(1);
  });

  it(`rejects inconsistent Push receipt indexes fail-closed ${evidence}`, async () => {
    const handle = new MinimalPushHandle();
    const op = pushOp('op-1', 1);
    const receipt: StoredOperationReceipt<OperationResult> = {
      operationId: 'op-1',
      replicaId: 'replica-1',
      sequenceScope: 'collection-1',
      sequence: 1,
      digest: 'digest-A',
      status: 'applied',
      result: {
        opId: 'op-1',
        sequence: 1,
        status: 'applied',
        revision: 'revision-1',
        cursor: 'cursor-1',
        warnings: [],
      },
    };
    handle.state.pushBySequence.set(
      JSON.stringify(['replica-1', 'collection-1', 1]),
      receipt,
    );
    handle.state.claims.set('op-1', {
      operationId: 'op-1',
      digest: 'digest-A',
      replicaId: 'replica-1',
      sequenceScope: 'collection-1',
      sequence: 1,
    });
    await expect(
      coordinatePushTransaction(
        handle,
        atomicRequest([{ operation: op, digest: 'digest-A' }]),
        async () => {
          throw new Error('preflight must not run');
        },
      ),
    ).rejects.toThrow(/indexes are inconsistent/i);
    expect(handle.state.business).toEqual([]);
  });

  it(`rejects a null Push transaction object ${evidence}`, async () => {
    const handle: SyncUnitOfWork<
      Operation,
      OperationResult,
      Conflict,
      BusinessAudit,
      Outbox,
      PushTx
    > & { readonly operationIdReservationOwner: 'push' } = {
      operationIdReservationOwner: 'push',
      execute: async (work) => work(null as never),
    };
    await expect(
      coordinatePushTransaction(
        handle,
        atomicRequest([{ operation: pushOp('op-1', 1), digest: 'digest-A' }]),
        async () => {
          throw new Error('preflight must not run');
        },
      ),
    ).rejects.toThrow(/transaction object/i);
  });
});

// --- Sequence claim-without-receipt / gap blocker / race --------------------

type SequenceResult = Readonly<Record<string, unknown>> & {
  readonly status: 'applied' | 'deferred' | 'rejected' | 'noop' | 'rebased' | 'conflicted';
};

interface SequenceDurableState {
  readonly lanes: Map<string, { nextSequence: number }>;
  readonly receipts: Map<string, StoredOperationReceipt<SequenceResult>>;
  readonly operationClaims: Map<string, SyncOperationClaim>;
  readonly reuseAudits: Map<string, SyncOperationReuseAudit>;
}

function laneIdentity(lane: { replicaId: string; sequenceScope: string }): string {
  return JSON.stringify([lane.replicaId, lane.sequenceScope]);
}

function receiptIdentity(
  lane: { replicaId: string; sequenceScope: string },
  sequence: number,
): string {
  return JSON.stringify([lane.replicaId, lane.sequenceScope, sequence]);
}

class SequenceBackend {
  state: SequenceDurableState = {
    lanes: new Map(),
    receipts: new Map(),
    operationClaims: new Map(),
    reuseAudits: new Map(),
  };
}

class DurableSequenceHandle {
  readonly operationIdReservationOwner = 'sequence' as const;
  claimLoadMode: 'normal' | 'race-existing' = 'normal';

  constructor(readonly backend = new SequenceBackend()) {}

  execute<Value>(
    _lane: { replicaId: string; sequenceScope: string },
    work: (transaction: {
      idReservations: { reserveAll: (items: readonly { id: string; resourceType: 'operation' }[]) => Promise<{ state: 'reserved' }> };
      operationClaims: {
        load: (id: string) => Promise<SyncOperationClaim | undefined>;
        save: (claim: SyncOperationClaim) => Promise<void>;
      };
      reuseAudits: {
        append: (audit: SyncOperationReuseAudit) => Promise<string>;
        load: (key: string) => Promise<SyncOperationReuseAudit | undefined>;
      };
      loadLaneState: (lane: { replicaId: string; sequenceScope: string }) => Promise<{ nextSequence: number } | undefined>;
      saveLaneState: (lane: { replicaId: string; sequenceScope: string }, state: { nextSequence: number }) => Promise<void>;
      receipts: {
        load: (lane: { replicaId: string; sequenceScope: string }, sequence: number) => Promise<StoredOperationReceipt<SequenceResult> | undefined>;
        save: (receipt: StoredOperationReceipt<SequenceResult>, condition: unknown) => Promise<void>;
      };
    }) => Promise<Value>,
  ): Promise<Value> {
    const draft: SequenceDurableState = {
      lanes: new Map([...this.backend.state.lanes].map(([k, v]) => [k, structuredClone(v)])),
      receipts: new Map([...this.backend.state.receipts].map(([k, v]) => [k, structuredClone(v)])),
      operationClaims: new Map(
        [...this.backend.state.operationClaims].map(([k, v]) => [k, structuredClone(v)]),
      ),
      reuseAudits: new Map(
        [...this.backend.state.reuseAudits].map(([k, v]) => [k, structuredClone(v)]),
      ),
    };
    let claimLoads = 0;
    return (async () => {
      const result = await work({
        idReservations: { reserveAll: async () => ({ state: 'reserved' }) },
        operationClaims: {
          load: async (id) => {
            claimLoads += 1;
            if (this.claimLoadMode === 'race-existing' && claimLoads === 1) {
              return undefined;
            }
            return structuredClone(draft.operationClaims.get(id));
          },
          save: async (claim) => {
            draft.operationClaims.set(claim.operationId, structuredClone(claim));
          },
        },
        reuseAudits: {
          append: async (audit) => {
            const key = `reuse-${draft.reuseAudits.size + 1}`;
            draft.reuseAudits.set(key, structuredClone(audit));
            return key;
          },
          load: async (key) => structuredClone(draft.reuseAudits.get(key)),
        },
        loadLaneState: async (lane) => {
          const state = draft.lanes.get(laneIdentity(lane));
          return state === undefined ? undefined : structuredClone(state);
        },
        saveLaneState: async (lane, state) => {
          draft.lanes.set(laneIdentity(lane), structuredClone(state));
        },
        receipts: {
          load: async (lane, sequence) => {
            const receipt = draft.receipts.get(receiptIdentity(lane, sequence));
            return receipt === undefined ? undefined : structuredClone(receipt);
          },
          save: async (receipt) => {
            draft.receipts.set(
              receiptIdentity(receipt, receipt.sequence),
              structuredClone(receipt),
            );
          },
        },
      });
      this.backend.state = draft;
      return result;
    })();
  }
}

describe(`U-3 Sequence claim-without-receipt / blocker / race ${evidence}`, () => {
  it(`throws when lifetime claim exists without Sequence receipt (same digest) ${evidence}`, async () => {
    const backend = new SequenceBackend();
    const lane = { replicaId: 'replica-1', sequenceScope: 'collection-1' };
    backend.state.lanes.set(laneIdentity(lane), { nextSequence: 1 });
    backend.state.operationClaims.set('operation-1', {
      operationId: 'operation-1',
      digest: 'sha-256:a',
      replicaId: 'replica-1',
      sequenceScope: 'collection-1',
      sequence: 1,
    });
    const handle = new DurableSequenceHandle(backend);
    const before = structuredClone({
      claims: [...backend.state.operationClaims.entries()],
      receipts: [...backend.state.receipts.entries()],
      lanes: [...backend.state.lanes.entries()],
    });
    await expect(
      coordinateSequenceOperation(
        handle as never,
        {
          operationId: 'operation-1',
          replicaId: 'replica-1',
          sequenceScope: 'collection-1',
          sequence: 1,
          digest: 'sha-256:a',
        },
        async () => ({ status: 'applied' as const, result: { status: 'applied' as const } }),
      ),
    ).rejects.toThrow(/without its Sequence receipt/i);
    expect([...backend.state.operationClaims.entries()]).toEqual(before.claims);
    expect([...backend.state.receipts.entries()]).toEqual(before.receipts);
    expect([...backend.state.lanes.entries()]).toEqual(before.lanes);
  });

  it(`returns sequence_blocked when expected Sequence holds a deferred receipt ${evidence}`, async () => {
    const backend = new SequenceBackend();
    const lane = { replicaId: 'replica-1', sequenceScope: 'collection-1' };
    backend.state.lanes.set(laneIdentity(lane), { nextSequence: 1 });
    backend.state.receipts.set(receiptIdentity(lane, 1), {
      operationId: 'blocker-1',
      replicaId: 'replica-1',
      sequenceScope: 'collection-1',
      sequence: 1,
      digest: 'sha-256:blocker',
      status: 'deferred',
      result: { status: 'deferred' },
    });
    const handle = new DurableSequenceHandle(backend);
    const result = await coordinateSequenceOperation(
      handle as never,
      {
        operationId: 'operation-2',
        replicaId: 'replica-1',
        sequenceScope: 'collection-1',
        sequence: 2,
        digest: 'sha-256:b',
      },
      async () => ({ status: 'applied' as const, result: { status: 'applied' as const } }),
    );
    expect(result).toEqual({ kind: 'sequence_blocked', expectedSequence: 1 });
  });

  it(`throws when expected Sequence holds a terminal receipt instead of deferred ${evidence}`, async () => {
    const backend = new SequenceBackend();
    const lane = { replicaId: 'replica-1', sequenceScope: 'collection-1' };
    backend.state.lanes.set(laneIdentity(lane), { nextSequence: 1 });
    backend.state.receipts.set(receiptIdentity(lane, 1), {
      operationId: 'blocker-1',
      replicaId: 'replica-1',
      sequenceScope: 'collection-1',
      sequence: 1,
      digest: 'sha-256:blocker',
      status: 'applied',
      result: { status: 'applied' },
    });
    const handle = new DurableSequenceHandle(backend);
    await expect(
      coordinateSequenceOperation(
        handle as never,
        {
          operationId: 'operation-2',
          replicaId: 'replica-1',
          sequenceScope: 'collection-1',
          sequence: 2,
          digest: 'sha-256:b',
        },
        async () => ({ status: 'applied' as const, result: { status: 'applied' as const } }),
      ),
    ).rejects.toThrow(/terminal receipt at the expected Sequence/i);
  });

  it(`classifies concurrent claim race with changed digest as op_id_reused ${evidence}`, async () => {
    const backend = new SequenceBackend();
    const lane = { replicaId: 'replica-1', sequenceScope: 'collection-1' };
    backend.state.lanes.set(laneIdentity(lane), { nextSequence: 1 });
    backend.state.operationClaims.set('operation-1', {
      operationId: 'operation-1',
      digest: 'sha-256:stored',
      replicaId: 'replica-1',
      sequenceScope: 'collection-1',
      sequence: 1,
    });
    const handle = new DurableSequenceHandle(backend);
    handle.claimLoadMode = 'race-existing';
    const result = await coordinateSequenceOperation(
      handle as never,
      {
        operationId: 'operation-1',
        replicaId: 'replica-1',
        sequenceScope: 'collection-1',
        sequence: 1,
        digest: 'sha-256:attempted',
      },
      async () => ({ status: 'applied' as const, result: { status: 'applied' as const } }),
    );
    expect(result).toMatchObject({ kind: 'op_id_reused' });
    expect(backend.state.reuseAudits.size).toBe(1);
    expect(backend.state.receipts.size).toBe(0);
  });
});

// --- Audit append read-back diverge ----------------------------------------

describe(`U-3 Operation reuse audit read-back ${evidence}`, () => {
  it(`fails closed when append read-back mutates digest ${evidence}`, async () => {
    const audits = new Map<string, SyncOperationReuseAudit>();
    await expect(
      appendSyncOperationReuseAudit(
        {
          append: async (audit) => {
            audits.set('audit-1', {
              ...structuredClone(audit),
              attempted: { ...audit.attempted, digest: 'sha-256:mutated' },
            });
            return 'audit-1';
          },
          load: async (key) => structuredClone(audits.get(key)),
        },
        'op_id_reused',
        {
          operationId: 'operation-1',
          digest: 'sha-256:a',
          replicaId: 'replica-1',
          sequenceScope: 'collection-1',
          sequence: 1,
        },
        {
          operationId: 'operation-1',
          digest: 'sha-256:b',
          replicaId: 'replica-1',
          sequenceScope: 'collection-1',
          sequence: 1,
        },
      ),
    ).rejects.toThrow(/reuse audit failed transaction-local read-back/i);
  });
});

// --- Extra bootstrap-state arms --------------------------------------------

describe(`U-3 Bootstrap-state plan / receipt / session helpers ${evidence}`, () => {
  it(`rejects immutablePlan with invalid status ${evidence}`, () => {
    expect(() =>
      immutablePlan({ status: 'conflicted', apply: async () => undefined } as never),
    ).toThrow(/invalid status/i);
  });

  it(`rejects immutableReceipt with invalid status ${evidence}`, () => {
    expect(() =>
      immutableReceipt({
        operationId: 'op-1',
        replicaId: 'replica-1',
        sessionId: 'session-1',
        sequence: 1,
        digest: 'digest-A',
        status: 'conflicted',
        result: { opId: 'op-1', sequence: 1, status: 'conflicted', conflictId: 'c1', warnings: [] },
      } as never),
    ).toThrow(/invalid status/i);
  });

  it(`builds bound and terminated Session snapshots without mutating input ${evidence}`, () => {
    const session: ActiveSyncSessionRecord = {
      sessionId: 'session-1',
      principal: { type: 'user', id: 'alice' },
      credential: { kind: 'token', id: 'token-1' },
      oauthClientId: 'https://client.example/app',
      origin: 'https://client.example',
      sessionScope: 'instance',
      protocolVersion: '0.1',
      collectionId: null,
      purpose: 'create_collection',
      authorizationScopes: ['sync:bootstrap'],
      status: 'active',
    };
    const bound = boundSession(session, 'collection-server-1');
    const terminated = terminatedSession(session, createdAt);
    expect(bound).toMatchObject({
      sessionScope: 'collection',
      collectionId: 'collection-server-1',
      purpose: null,
    });
    expect(terminated).toMatchObject({
      status: 'terminated',
      terminationReason: 'bootstrap_rejected',
      terminatedAt: createdAt,
    });
    expect(session.sessionScope).toBe('instance');
    expect(session.status).toBe('active');
  });

  it(`rejects hostile boundCollection / cursorless / receipt shapes ${evidence}`, () => {
    const identity = {
      collectionId: 'collection-server-1',
      rootNodeId: 'root-server-1',
      revision: 'revision-server-1',
    };
    expect(() => assertBoundCollection([] as never, identity, 'c')).toThrow(/plain object/i);
    expect(() => assertBoundCollection(new Date() as never, identity, 'c')).toThrow(/plain object/i);
    const withSymbol = {
      collectionId: identity.collectionId,
      snapshotRequired: false,
      serverCursor: 'cursor-1',
      serverRevision: identity.revision,
      [Symbol('x')]: 1,
    };
    expect(() => assertBoundCollection(withSymbol as never, identity, 'cursor-1')).toThrow(
      /unknown member|symbol/i,
    );
    expect(() =>
      assertCursorlessResult(
        {
          opId: 'op-1',
          sequence: 1,
          status: 'deferred',
          code: '',
          warnings: [],
        } as never,
        'deferred',
      ),
    ).toThrow(/non-empty/i);
    expect(() =>
      immutableReceipt({
        operationId: 'op-1',
        replicaId: 'replica-1',
        sessionId: 'session-1',
        sequence: 1,
        digest: 'digest-A',
        status: 'deferred',
        result: {
          opId: 'OTHER',
          sequence: 1,
          status: 'deferred',
          code: 'pending',
          warnings: [],
        },
      } as never),
    ).toThrow(/inconsistent/i);
  });
});

// --- Session create validation / verify fail-closed -------------------------

describe(`U-3 Session create validation / verify fail-closed ${evidence}`, () => {
  it.each([
    ['empty sessionId', { sessionId: '' }, /non-empty|session id/i],
    ['bad principal type', { principal: { type: 'bot', id: 'x' } }, /principal|invalid type/i],
    ['bad credential kind', { credential: { kind: 'cookie', id: 'x' } }, /credential/i],
    ['invalid scope', { authorizationScopes: ['sync:nope'] }, /scope/i],
    ['duplicate scope', { authorizationScopes: ['sync:pull', 'sync:pull'] }, /duplicate/i],
    ['bad protocol', { protocolVersion: '0.3' }, /protocolVersion|0\.1|0\.2/i],
    ['bad sessionScope', { sessionScope: 'workspace' }, /collection or instance|sessionScope/i],
  ] as const)(`rejects %s before durable write ${evidence}`, async (_label, override, pattern) => {
    const store = new DurableMemorySessionStore();
    await expect(createSyncSession(store, collectionInput(override as never))).rejects.toThrow(
      pattern,
    );
    await expect(store.load('session-1')).resolves.toBeUndefined();
  });

  it(`returns false from isVerifiedSyncSession for non-branded values ${evidence}`, () => {
    expect(isVerifiedSyncSession(null)).toBe(false);
    expect(isVerifiedSyncSession(1)).toBe(false);
    expect(isVerifiedSyncSession({ status: 'active' })).toBe(false);
  });

  it(`fails closed when authorization loss terminate returns undefined ${evidence}`, async () => {
    const honest = new Map<string, SyncSessionRecord>();
    const store: SyncSessionStore = {
      create: async (session) => {
        const stored = copy(session);
        honest.set(session.sessionId, stored);
        return { state: 'created', session: stored };
      },
      load: async (sessionId) => {
        const stored = honest.get(sessionId);
        return stored === undefined ? undefined : copy(stored);
      },
      terminate: async () => undefined,
    };
    const input = collectionInput();
    await createSyncSession(store, input);
    await expect(
      verifySyncSessionContext(store, {
        ...verification(input),
        authorization: {
          credentialActive: false,
          authorizationScopes: [...input.authorizationScopes],
        },
      }),
    ).rejects.toThrow(/Authorization loss did not durably terminate/i);
    expect(honest.get(input.sessionId)?.status).toBe('active');
  });
});

// --- Operation claim validators / Pull 0.1 / replica parsing ----------------

describe(`U-3 Claim validators / Pull 0.1 / lifecycle parsing ${evidence}`, () => {
  it(`rejects malformed SyncOperationClaim shapes ${evidence}`, () => {
    expect(() => immutableSyncOperationClaim(null as never)).toThrow(/object/i);
    expect(() =>
      immutableSyncOperationClaim({
        operationId: 'o',
        digest: 'd',
        replicaId: 'r',
        sequenceScope: 's',
        sequence: 0,
      }),
    ).toThrow(/positive safe integer|safe integer/i);
  });

  it(`rejects invalid reuse audit code before append ${evidence}`, async () => {
    await expect(
      appendSyncOperationReuseAudit(
        {
          append: async () => 'audit-1',
          load: async () => undefined,
        },
        'not_a_code' as never,
        {
          operationId: 'operation-1',
          digest: 'sha-256:a',
          replicaId: 'replica-1',
          sequenceScope: 'collection-1',
          sequence: 1,
        },
        {
          operationId: 'operation-1',
          digest: 'sha-256:b',
          replicaId: 'replica-1',
          sequenceScope: 'collection-1',
          sequence: 1,
        },
      ),
    ).rejects.toThrow(/invalid code|reuse code/i);
  });

  it(`rejects COLP 0.1 Pull conflict without Conflict and invalid kinds ${evidence}`, () => {
    expect(() =>
      validateAuthoritativePullEvent({ cursor: 'c', kind: 'conflict' } as never, '0.1'),
    ).toThrow(/Conflict/i);
    expect(() =>
      validateAuthoritativePullEvent({ cursor: 'c', kind: 'noop' } as never, '0.1'),
    ).toThrow(/invalid|0\.1/i);
  });

  it(`rejects non-plain lifecycle objects ${evidence}`, () => {
    expect(() => exactLifecycleObject(null, new Set(['id']), 'Replica')).toThrow(/plain object/i);
    expect(() => exactLifecycleObject([], new Set(['id']), 'Replica')).toThrow(/plain object/i);
    expect(() => exactLifecycleObject(new Date(), new Set(['id']), 'Replica')).toThrow(
      /plain object/i,
    );
  });
});

// --- Sequence adapter-poison + same-digest race -----------------------------

describe(`U-3 Sequence adapter-poison receipts ${evidence}`, () => {
  it(`rejects deferred receipt below nextSequence ${evidence}`, async () => {
    const backend = new SequenceBackend();
    const lane = { replicaId: 'replica-1', sequenceScope: 'collection-1' };
    backend.state.lanes.set(laneIdentity(lane), { nextSequence: 5 });
    backend.state.receipts.set(receiptIdentity(lane, 3), {
      operationId: 'old-deferred',
      replicaId: 'replica-1',
      sequenceScope: 'collection-1',
      sequence: 3,
      digest: 'sha-256:old',
      status: 'deferred',
      result: { status: 'deferred' },
    });
    backend.state.operationClaims.set('old-deferred', {
      operationId: 'old-deferred',
      digest: 'sha-256:old',
      replicaId: 'replica-1',
      sequenceScope: 'collection-1',
      sequence: 3,
    });
    await expect(
      coordinateSequenceOperation(
        new DurableSequenceHandle(backend) as never,
        {
          operationId: 'old-deferred',
          replicaId: 'replica-1',
          sequenceScope: 'collection-1',
          sequence: 3,
          digest: 'sha-256:old',
        },
        async () => ({ status: 'applied' as const, result: { status: 'applied' as const } }),
      ),
    ).rejects.toThrow(/deferred receipt below/i);
  });

  it(`rejects unconsumed terminal receipt at nextSequence ${evidence}`, async () => {
    const backend = new SequenceBackend();
    const lane = { replicaId: 'replica-1', sequenceScope: 'collection-1' };
    backend.state.lanes.set(laneIdentity(lane), { nextSequence: 1 });
    backend.state.receipts.set(receiptIdentity(lane, 1), {
      operationId: 'operation-1',
      replicaId: 'replica-1',
      sequenceScope: 'collection-1',
      sequence: 1,
      digest: 'sha-256:a',
      status: 'applied',
      result: { status: 'applied' },
    });
    backend.state.operationClaims.set('operation-1', {
      operationId: 'operation-1',
      digest: 'sha-256:a',
      replicaId: 'replica-1',
      sequenceScope: 'collection-1',
      sequence: 1,
    });
    await expect(
      coordinateSequenceOperation(
        new DurableSequenceHandle(backend) as never,
        {
          operationId: 'operation-1',
          replicaId: 'replica-1',
          sequenceScope: 'collection-1',
          sequence: 1,
          digest: 'sha-256:a',
        },
        async () => ({ status: 'applied' as const, result: { status: 'applied' as const } }),
      ),
    ).rejects.toThrow(/unconsumed terminal/i);
  });

  it(`throws on same-digest claim race without Sequence receipt ${evidence}`, async () => {
    const backend = new SequenceBackend();
    const lane = { replicaId: 'replica-1', sequenceScope: 'collection-1' };
    backend.state.lanes.set(laneIdentity(lane), { nextSequence: 1 });
    backend.state.operationClaims.set('operation-1', {
      operationId: 'operation-1',
      digest: 'sha-256:same',
      replicaId: 'replica-1',
      sequenceScope: 'collection-1',
      sequence: 1,
    });
    const handle = new DurableSequenceHandle(backend);
    handle.claimLoadMode = 'race-existing';
    await expect(
      coordinateSequenceOperation(
        handle as never,
        {
          operationId: 'operation-1',
          replicaId: 'replica-1',
          sequenceScope: 'collection-1',
          sequence: 1,
          digest: 'sha-256:same',
        },
        async () => ({ status: 'applied' as const, result: { status: 'applied' as const } }),
      ),
    ).rejects.toThrow(/without its Sequence receipt/i);
    expect(backend.state.receipts.size).toBe(0);
  });

  it(`rejects deferred receipt beyond the expected Sequence ${evidence}`, async () => {
    const backend = new SequenceBackend();
    const lane = { replicaId: 'replica-1', sequenceScope: 'collection-1' };
    backend.state.lanes.set(laneIdentity(lane), { nextSequence: 1 });
    backend.state.receipts.set(receiptIdentity(lane, 3), {
      operationId: 'future-deferred',
      replicaId: 'replica-1',
      sequenceScope: 'collection-1',
      sequence: 3,
      digest: 'sha-256:future',
      status: 'deferred',
      result: { status: 'deferred' },
    });
    backend.state.operationClaims.set('future-deferred', {
      operationId: 'future-deferred',
      digest: 'sha-256:future',
      replicaId: 'replica-1',
      sequenceScope: 'collection-1',
      sequence: 3,
    });
    await expect(
      coordinateSequenceOperation(
        new DurableSequenceHandle(backend) as never,
        {
          operationId: 'future-deferred',
          replicaId: 'replica-1',
          sequenceScope: 'collection-1',
          sequence: 3,
          digest: 'sha-256:future',
        },
        async () => ({ status: 'applied' as const, result: { status: 'applied' as const } }),
      ),
    ).rejects.toThrow(/beyond the expected Sequence/i);
  });
});

// --- Typed-update accessor / nested array freeze ----------------------------

describe(`U-3 Typed-update accessor / nested array ${evidence}`, () => {
  it(`rejects accessor properties on merge inputs ${evidence}`, () => {
    const incoming: Record<string, unknown> = {};
    Object.defineProperty(incoming, 'title', {
      enumerable: true,
      configurable: true,
      get: () => 'x',
    });
    expect(() =>
      mergeSyncTypedUpdate({
        base: { title: 'a' },
        current: { title: 'a' },
        incoming: incoming as never,
      }),
    ).toThrow(/enumerable data properties/i);
  });

  it(`freezes nested array values on clean merge ${evidence}`, () => {
    const result = mergeSyncTypedUpdate({
      base: { items: [1, 2] },
      current: { items: [1, 2] },
      incoming: { items: [1, 2, 3] },
    });
    expect(result).toMatchObject({ status: 'merged', value: { items: [1, 2, 3] } });
    if (result.status !== 'merged') throw new Error('expected merged');
    expect(Object.isFrozen(result.value.items)).toBe(true);
  });
});

// --- Final mop: session terminate shape / push conflict / bootstrap finalize -

describe(`U-3 Final mop for lines 95 ${evidence}`, () => {
  it(`rejects terminate that returns a non-terminated Session ${evidence}`, async () => {
    const honest = new Map<string, SyncSessionRecord>();
    const store: SyncSessionStore = {
      create: async (session) => {
        const stored = copy(session);
        honest.set(session.sessionId, stored);
        return { state: 'created', session: stored };
      },
      load: async (sessionId) => {
        const stored = honest.get(sessionId);
        return stored === undefined ? undefined : copy(stored);
      },
      terminate: async (termination) => {
        const existing = honest.get(termination.sessionId);
        return existing === undefined ? undefined : copy(existing);
      },
    };
    const input = collectionInput();
    await createSyncSession(store, input);
    await expect(
      terminateSyncSession(store, {
        sessionId: input.sessionId,
        reason: 'administrative',
        terminatedAt: createdAt,
      }),
    ).rejects.toThrow(/did not return the terminated Session/i);
    expect(honest.get(input.sessionId)?.status).toBe('active');
  });

  it(`rejects terminate when durable reload is missing ${evidence}`, async () => {
    const honest = new Map<string, SyncSessionRecord>();
    let terminateDone = false;
    const store: SyncSessionStore = {
      create: async (session) => {
        const stored = copy(session);
        honest.set(session.sessionId, stored);
        return { state: 'created', session: stored };
      },
      load: async (sessionId) => {
        if (terminateDone) return undefined;
        const stored = honest.get(sessionId);
        return stored === undefined ? undefined : copy(stored);
      },
      terminate: async (termination) => {
        const existing = honest.get(termination.sessionId);
        if (existing === undefined || existing.status !== 'active') return undefined;
        const terminated: SyncSessionRecord = {
          ...copy(existing),
          status: 'terminated',
          terminationReason: termination.reason,
          terminatedAt: termination.terminatedAt,
        };
        honest.set(termination.sessionId, terminated);
        terminateDone = true;
        return copy(terminated);
      },
    };
    const input = collectionInput();
    await createSyncSession(store, input);
    await expect(
      terminateSyncSession(store, {
        sessionId: input.sessionId,
        reason: 'administrative',
        terminatedAt: createdAt,
      }),
    ).rejects.toThrow(/could not be reloaded/i);
  });

  it(`rejects conflicted Push when conflictId diverges from Conflict.id ${evidence}`, async () => {
    const handle = new MinimalPushHandle();
    await expect(
      coordinatePushTransaction(
        handle,
        atomicRequest([{ operation: pushOp('op-1', 1), digest: 'digest-A' }]),
        async () => ({
          status: 'conflicted' as const,
          apply: async () => ({
            result: {
              opId: 'op-1',
              sequence: 1,
              status: 'conflicted' as const,
              conflictId: 'conflict-A',
              warnings: [],
            },
            conflict: { id: 'conflict-B' },
          }),
          audit: async () => ({ id: 'audit-1' }),
          outbox: async () => ({ id: 'outbox-1' }),
        }),
      ),
    ).rejects.toThrow(/conflictId does not match/i);
    expect(handle.state.business).toEqual([]);
    expect(handle.state.claims.size).toBe(0);
  });

  it(`finalizes deferred/rejected bootstrap results and rejects identity drift ${evidence}`, () => {
    const operation = {
      opId: 'operation-1',
      replicaId: 'replica-1',
      sequence: 1,
      type: 'create_collection',
    } as never;
    expect(
      finalizeDeferredResult(
        {
          opId: 'operation-1',
          sequence: 1,
          status: 'deferred',
          code: 'pending',
          warnings: [],
        },
        operation,
      ),
    ).toMatchObject({ status: 'deferred', code: 'pending' });
    expect(
      finalizeRejectedResult(
        {
          opId: 'operation-1',
          sequence: 1,
          status: 'rejected',
          code: 'denied',
          warnings: [],
        },
        operation,
      ),
    ).toMatchObject({ status: 'rejected', code: 'denied' });
    expect(() =>
      finalizeDeferredResult(
        {
          opId: 'other',
          sequence: 1,
          status: 'deferred',
          code: 'pending',
          warnings: [],
        },
        operation,
      ),
    ).toThrow(/does not match its Operation/i);
  });

  it(`rejects create when store returns a divergent binding ${evidence}`, async () => {
    const honest = new Map<string, SyncSessionRecord>();
    const store: SyncSessionStore = {
      create: async (session) => {
        const stored = { ...copy(session), origin: 'https://forged.example' };
        honest.set(session.sessionId, copy(session));
        return { state: 'created', session: stored };
      },
      load: async () => undefined,
      terminate: async () => undefined,
    };
    await expect(createSyncSession(store, collectionInput())).rejects.toThrow(
      /different binding from the create request/i,
    );
  });

  it(`rejects create when durable reload is missing ${evidence}`, async () => {
    const store: SyncSessionStore = {
      create: async (session) => ({ state: 'created', session: copy(session) }),
      load: async () => undefined,
      terminate: async () => undefined,
    };
    await expect(createSyncSession(store, collectionInput())).rejects.toThrow(
      /could not be reloaded/i,
    );
  });

  it(`rejects boundCollection accessors and schema-invalid applied identity ${evidence}`, () => {
    const identity = {
      collectionId: 'collection-server-1',
      rootNodeId: 'root-server-1',
      revision: 'revision-server-1',
    };
    const withAccessor: Record<string, unknown> = {
      collectionId: identity.collectionId,
      snapshotRequired: false,
      serverCursor: 'cursor-1',
      serverRevision: identity.revision,
    };
    Object.defineProperty(withAccessor, 'snapshotRequired', {
      enumerable: true,
      configurable: true,
      get: () => false,
    });
    expect(() => assertBoundCollection(withAccessor as never, identity, 'cursor-1')).toThrow(
      /enumerable data properties/i,
    );
    expect(() =>
      assertResultIdentity(
        {
          opId: 'op-1',
          sequence: 1,
          status: 'applied',
          warnings: [],
          // Schema-invalid applied OperationResult: missing revision/cursor/boundCollection.
        } as never,
        { opId: 'op-1', sequence: 1 } as never,
        'applied',
      ),
    ).toThrow(/canonical|valid|required/i);
  });
});
