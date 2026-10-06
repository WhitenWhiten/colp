import { legacyPullOperation } from '../support/legacy-pull-fixtures.js';
/**
 * U-3 Sync Core-used (Tier A) semantic gap cases.
 *
 * Seeded from source review + aggregate `coverage/sync/` at commit `41ad711`
 * (Tier A estimate ~lines 91 / branches 87). Acceptance must refresh uncovered
 * branches from `npm run test:coverage:sync-core` → `coverage/sync-core/` and
 * update `reports/audit/sync-core-coverage-triage.md`.
 *
 * Each case asserts durable pre/post state, port call counts, rollback restore,
 * or idempotent same durable result — not mocks that only return expected values.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  asReplicaAuthenticatedCommand,
  claimSyncOperations,
  coordinateReplicaLifecycle,
  createReplicaAuthProofFromVerifiedSession,
  createSyncSession,
  requireVerifiedSyncSession,
  verifySyncSessionContext,
  type ActiveSyncSessionRecord,
  type CreateSyncSessionInput,
  type DurableReplicaCheckpoint,
  type ReplicaLifecycleKey,
  type ReplicaLifecycleTransaction,
  type ReplicaLifecycleUnitOfWork,
  type SequenceCoordinatorTransaction,
  type SequenceCoordinatorUnitOfWork,
  type SequenceLaneKey,
  type SequenceLaneState,
  type SequenceOperationRequest,
  type SequenceReceiptWriteCondition,
  type StoredOperationReceipt,
  type SyncOperationClaim,
  type SyncOperationReuseAudit,
  type SyncOperationReuseTransaction,
  type SyncPullCommittedEvent,
  type SyncPullCursorRecord,
  type SyncPullCursorStore,
  type SyncPullEventPage,
  type SyncPullEventReadRequest,
  type SyncPullEventStore,
  type SyncPullRequestContext,
  type SyncSessionRecord,
  type SyncSessionStore,
  type SyncSessionStoreCreateResult,
  type SyncSessionTermination,
  type TerminalOperationStatus,
  type VerifySyncSessionContextInput,
} from '../../src/sync/index.js';
import {
  coordinateSequenceOperation,
  coordinateSyncPull,
} from '../../src/sync/unsafe.js';

const evidence = '[review:sync.core-used-u3-gaps]';
const createdAt = '2026-07-18T02:00:00Z';
const later = '2026-07-18T02:30:00Z';
const now = '2026-07-18T01:00:00Z';
const future = '2026-07-18T03:00:00Z';

function copy<Value>(value: Value): Value {
  return structuredClone(value);
}

// --- Session ----------------------------------------------------------------

type DurableSessionState = Map<string, SyncSessionRecord>;

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

function verification(
  input: CreateSyncSessionInput,
  overrides: Partial<VerifySyncSessionContextInput> = {},
): VerifySyncSessionContextInput {
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
    authorization: overrides.authorization ?? {
      credentialActive: true,
      authorizationScopes: [...input.authorizationScopes],
    },
    terminatedAt: overrides.terminatedAt ?? createdAt,
  };
}

describe(`U-3 Session durable credential / read-back ${evidence}`, () => {
  it(`create durable read-back survives an independent store handle ${evidence}`, async () => {
    const writer = new DurableMemorySessionStore();
    const input = collectionInput();
    const created = await createSyncSession(writer, input);
    const reader = writer.restart();

    await expect(reader.load(input.sessionId)).resolves.toEqual(created);
    await expect(verifySyncSessionContext(reader, verification(input))).resolves.toEqual({
      state: 'active',
      session: created,
    });
  });

  it(`rejects create when durable read-back diverges from the create result ${evidence}`, async () => {
    const honest = new Map<string, SyncSessionRecord>();
    let loadCount = 0;
    const hostile: SyncSessionStore = {
      create: async (session) => {
        const stored = copy(session);
        honest.set(session.sessionId, stored);
        return { state: 'created', session: stored };
      },
      load: async (sessionId) => {
        loadCount += 1;
        const stored = honest.get(sessionId);
        if (stored === undefined) return undefined;
        if (loadCount === 1 && stored.status === 'active') {
          return {
            ...copy(stored),
            credential: { kind: 'token', id: 'token-forged' },
          };
        }
        return copy(stored);
      },
      terminate: async () => undefined,
    };

    await expect(createSyncSession(hostile, collectionInput())).rejects.toThrow(
      /durable read-back verification/i,
    );
    expect(honest.get('session-1')).toMatchObject({
      credential: { kind: 'token', id: 'token-1' },
      status: 'active',
    });
  });

  it(`scope_reduced terminates durably and stays terminated after restart + restored grants ${evidence}`, async () => {
    const store = new DurableMemorySessionStore();
    const input = collectionInput();
    await createSyncSession(store, input);

    const first = await verifySyncSessionContext(store, verification(input, {
      authorization: { credentialActive: true, authorizationScopes: ['sync:pull'] },
      terminatedAt: later,
    }));
    expect(first).toMatchObject({
      state: 'terminated',
      session: { terminationReason: 'scope_reduced', terminatedAt: later },
    });

    const restarted = store.restart();
    const restored = await verifySyncSessionContext(restarted, verification(input, {
      authorization: {
        credentialActive: true,
        authorizationScopes: [...input.authorizationScopes],
      },
      terminatedAt: later,
    }));
    expect(restored).toEqual(first);
    await expect(restarted.load(input.sessionId)).resolves.toEqual(
      first.state === 'terminated' ? first.session : undefined,
    );
  });
});

// --- Sequence ---------------------------------------------------------------

type SequenceResult = Readonly<Record<string, unknown>> & {
  readonly status: TerminalOperationStatus | 'deferred';
};

interface SequenceDurableState {
  readonly lanes: Map<string, SequenceLaneState>;
  readonly receipts: Map<string, StoredOperationReceipt<SequenceResult>>;
  readonly operationClaims: Map<string, SyncOperationClaim>;
  readonly reuseAudits: Map<string, SyncOperationReuseAudit>;
}

function laneIdentity(lane: SequenceLaneKey): string {
  return JSON.stringify([lane.replicaId, lane.sequenceScope]);
}

function receiptIdentity(lane: SequenceLaneKey, sequence: number): string {
  return JSON.stringify([lane.replicaId, lane.sequenceScope, sequence]);
}

function cloneSequenceState(state: SequenceDurableState): SequenceDurableState {
  return {
    lanes: new Map([...state.lanes].map(([key, value]) => [key, structuredClone(value)])),
    receipts: new Map([...state.receipts].map(([key, value]) => [key, structuredClone(value)])),
    operationClaims: new Map(
      [...state.operationClaims].map(([key, value]) => [key, structuredClone(value)]),
    ),
    reuseAudits: new Map(
      [...state.reuseAudits].map(([key, value]) => [key, structuredClone(value)]),
    ),
  };
}

class SequenceBackend {
  state: SequenceDurableState = {
    lanes: new Map(),
    receipts: new Map(),
    operationClaims: new Map(),
    reuseAudits: new Map(),
  };
}

class DurableSequenceHandle implements SequenceCoordinatorUnitOfWork<SequenceResult> {
  readonly operationIdReservationOwner = 'sequence' as const;

  constructor(readonly backend = new SequenceBackend()) {}

  execute<Value>(
    _lane: SequenceLaneKey,
    work: (transaction: SequenceCoordinatorTransaction<SequenceResult>) => Promise<Value>,
  ): Promise<Value> {
    return (async () => {
      const draft = cloneSequenceState(this.backend.state);
      const result = await work(this.transaction(draft));
      this.backend.state = draft;
      return result;
    })();
  }

  private transaction(
    draft: SequenceDurableState,
  ): SequenceCoordinatorTransaction<SequenceResult> {
    return {
      idReservations: { reserveAll: async () => ({ state: 'reserved' }) },
      operationClaims: {
        load: async (id) => structuredClone(draft.operationClaims.get(id)),
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
        save: async (receipt, _condition: SequenceReceiptWriteCondition) => {
          draft.receipts.set(
            receiptIdentity(receipt, receipt.sequence),
            structuredClone(receipt),
          );
        },
      },
    };
  }
}

function sequenceRequest(
  overrides: Partial<SequenceOperationRequest> = {},
): SequenceOperationRequest {
  return {
    operationId: 'operation-1',
    replicaId: 'replica-1',
    sequenceScope: 'collection-1',
    sequence: 1,
    digest: 'sha-256:operation-1',
    ...overrides,
  };
}

describe(`U-3 Sequence ownership / safe-integer ${evidence}`, () => {
  it(`rejects terminal advance at Number.MAX_SAFE_INTEGER without mutating durable state ${evidence}`, async () => {
    const backend = new SequenceBackend();
    const max = Number.MAX_SAFE_INTEGER;
    const lane = sequenceRequest({ sequence: max });
    backend.state.lanes.set(laneIdentity(lane), { nextSequence: max });

    const adapter = new DurableSequenceHandle(backend);
    const before = cloneSequenceState(backend.state);
    const evaluator = vi.fn(async () => ({
      status: 'applied' as const,
      result: {
        status: 'applied' as const,
        revision: 'r-max',
        cursor: 'c-max',
        warnings: [] as string[],
      },
    }));

    await expect(
      coordinateSequenceOperation<SequenceResult>(
        adapter,
        sequenceRequest({
          operationId: 'operation-max',
          sequence: max,
          digest: 'sha-256:max',
        }),
        evaluator,
      ),
    ).rejects.toThrow(/safe integer Sequence range/i);

    expect(evaluator).toHaveBeenCalledTimes(1);
    expect(cloneSequenceState(backend.state)).toEqual(before);
  });

  it(`exact Sequence replay returns the same durable receipt without re-evaluating ${evidence}`, async () => {
    const adapter = new DurableSequenceHandle();
    const evaluator = vi.fn(async () => ({
      status: 'applied' as const,
      result: {
        status: 'applied' as const,
        revision: 'revision-2',
        cursor: 'cursor-11',
        warnings: [] as string[],
      },
    }));

    const first = await coordinateSequenceOperation<SequenceResult>(adapter, sequenceRequest(), evaluator);
    const replay = await coordinateSequenceOperation<SequenceResult>(adapter, sequenceRequest(), evaluator);

    expect(first.kind).toBe('executed');
    expect(replay).toEqual({
      kind: 'replayed',
      receipt: first.kind === 'executed' ? first.receipt : undefined,
    });
    expect(evaluator).toHaveBeenCalledTimes(1);
    expect(adapter.backend.state.lanes.get(laneIdentity(sequenceRequest()))).toEqual({
      nextSequence: 2,
    });
  });
});

// --- Pull -------------------------------------------------------------------

class SharedPullBackend {
  readonly cursors = new Map<string, SyncPullCursorRecord>();
  readonly pages = new Map<string, SyncPullEventPage>();
}

class DurableCursorHandle implements SyncPullCursorStore {
  constructor(readonly backend: SharedPullBackend) {}

  async resolveCursor(cursor: string): Promise<SyncPullCursorRecord | null> {
    const record = this.backend.cursors.get(cursor);
    return record === undefined ? null : copy(record);
  }
}

class DurableEventHandle implements SyncPullEventStore {
  constructor(readonly backend: SharedPullBackend) {}

  async readCommittedAfter(request: SyncPullEventReadRequest): Promise<SyncPullEventPage> {
    const page = this.backend.pages.get(request.afterCommitOrdinal);
    if (page === undefined) {
      return {
        entries: [],
        hasMore: false,
        collectionRevision: 'revision-1',
        recommendedPullAfterSeconds: 30,
      };
    }
    return copy(page);
  }
}

function pullRequest(
  overrides: Partial<SyncPullRequestContext> = {},
): SyncPullRequestContext {
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

function pullCursor(
  cursor: string,
  commitOrdinal: string,
  overrides: Partial<SyncPullCursorRecord> = {},
): SyncPullCursorRecord {
  return {
    cursor,
    sessionId: 'session-1',
    principal: { type: 'user', id: 'alice' },
    collectionId: 'collection-1',
    protocolVersion: '0.1',
    commitOrdinal,
    state: 'active',
    ...overrides,
  };
}

describe(`U-3 Pull cursor order / receiver binding ${evidence}`, () => {
  it(`rejects a committed event whose Cursor record is bound to another principal ${evidence}`, async () => {
    const backend = new SharedPullBackend();
    backend.cursors.set('cursor-start', pullCursor('cursor-start', '100'));
    backend.cursors.set(
      'cursor-next',
      pullCursor('cursor-next', '101', {
        principal: { type: 'user', id: 'other' },
      }),
    );
    const entries: SyncPullCommittedEvent[] = [
      {
        commitOrdinal: '101',
        event: {
          cursor: 'cursor-next',
          kind: 'operation',
          operation: legacyPullOperation('op-1', 'replica-other'),
        },
      },
    ];
    backend.pages.set('100', {
      entries,
      hasMore: false,
      collectionRevision: 'revision-7',
      recommendedPullAfterSeconds: 30,
    });

    await expect(
      coordinateSyncPull(
        pullRequest(),
        new DurableCursorHandle(backend),
        new DurableEventHandle(backend),
      ),
    ).rejects.toThrow(/does not match its durable Cursor record/i);
  });

  it(`rejects non-increasing commit ordinals and leaves cursor store untouched ${evidence}`, async () => {
    const backend = new SharedPullBackend();
    backend.cursors.set('cursor-start', pullCursor('cursor-start', '100'));
    backend.cursors.set('cursor-a', pullCursor('cursor-a', '101'));
    backend.cursors.set('cursor-b', pullCursor('cursor-b', '101'));
    backend.pages.set('100', {
      entries: [
        {
          commitOrdinal: '101',
          event: {
            cursor: 'cursor-a',
            kind: 'operation',
            operation: legacyPullOperation('op-a', 'r-a'),
          },
        },
        {
          commitOrdinal: '101',
          event: {
            cursor: 'cursor-b',
            kind: 'operation',
            operation: legacyPullOperation('op-b', 'r-b'),
          },
        },
      ],
      hasMore: false,
      collectionRevision: 'revision-7',
      recommendedPullAfterSeconds: 30,
    });
    const before = new Map(backend.cursors);

    await expect(
      coordinateSyncPull(
        pullRequest(),
        new DurableCursorHandle(backend),
        new DurableEventHandle(backend),
      ),
    ).rejects.toThrow(/strictly increasing/i);
    expect(backend.cursors).toEqual(before);
  });
});

// --- Replica VerifiedSyncSession proof --------------------------------------

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
  executeCount = 0;
  authoritativeTime = now;

  constructor(initial?: DurableReplicaCheckpoint) {
    if (initial !== undefined) this.replicas.set(initial.replicaId, copy(initial));
  }

  async execute<Value>(
    replicaId: string,
    work: (transaction: ReplicaLifecycleTransaction) => Promise<Value>,
  ): Promise<Value> {
    this.executeCount += 1;
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

describe(`U-3 Replica VerifiedSyncSession auth proof (not bare authenticated:true) ${evidence}`, () => {
  it(`renews via package-minted VerifiedSyncSession proof and persists the extended lease ${evidence}`, async () => {
    const sessionStore = new DurableMemorySessionStore();
    const input = collectionInput();
    await createSyncSession(sessionStore, input);
    const verified = await requireVerifiedSyncSession(sessionStore, verification(input));
    const proof = createReplicaAuthProofFromVerifiedSession(verified);

    const handle = new MemoryReplicaLifecycle(replicaCheckpoint());
    const before = copy(handle.replicas.get('replica-1')!);
    const extended = '2026-07-18T04:00:00Z';
    const key: ReplicaLifecycleKey = {
      replicaId: 'replica-1',
      collectionId: 'collection-1',
    };

    const command = asReplicaAuthenticatedCommand(
      {
        type: 'renew',
        leaseExpiresAt: extended,
        succeeded: true,
      },
      proof,
    );
    expect(proof.source).toBe('verified-session');
    expect(command.authenticated).toBe(true);

    const result = await coordinateReplicaLifecycle(handle, key, command);

    expect(result).toMatchObject({
      state: 'committed',
      checkpoint: {
        leaseExpiresAt: extended,
        lastSeenAt: now,
        lifecycle: 'active',
      },
    });
    expect(handle.executeCount).toBe(1);
    expect(handle.replicas.get('replica-1')).toMatchObject({ leaseExpiresAt: extended });
    expect(handle.replicas.get('replica-1')?.leaseId).toBe(before.leaseId);
  });
});

// --- Operation reuse --------------------------------------------------------

describe(`U-3 Operation reuse claim batch invariants ${evidence}`, () => {
  it(`rejects duplicate Operation IDs in one claim batch before any reserve ${evidence}`, async () => {
    const reserveAll = vi.fn(async () => ({ state: 'reserved' as const }));
    const save = vi.fn(async () => undefined);
    const transaction: SyncOperationReuseTransaction = {
      idReservations: { reserveAll },
      operationClaims: {
        load: async () => undefined,
        save,
      },
      reuseAudits: {
        append: async () => 'audit-1',
        load: async () => undefined,
      },
    };
    const claim: SyncOperationClaim = {
      operationId: 'operation-1',
      digest: 'sha-256:a',
      replicaId: 'replica-1',
      sequenceScope: 'collection-1',
      sequence: 1,
    };

    await expect(
      claimSyncOperations(transaction, [claim, { ...claim, digest: 'sha-256:b' }]),
    ).rejects.toThrow(/duplicate Operation ID/i);
    expect(reserveAll).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it(`fails closed when claim save read-back diverges ${evidence}`, async () => {
    const claims = new Map<string, SyncOperationClaim>();
    const transaction: SyncOperationReuseTransaction = {
      idReservations: {
        reserveAll: async () => ({ state: 'reserved' }),
      },
      operationClaims: {
        load: async (id) => structuredClone(claims.get(id)),
        save: async (claim) => {
          claims.set(claim.operationId, {
            ...structuredClone(claim),
            digest: 'sha-256:mutated',
          });
        },
      },
      reuseAudits: {
        append: async () => 'audit-1',
        load: async () => undefined,
      },
    };
    const claim: SyncOperationClaim = {
      operationId: 'operation-1',
      digest: 'sha-256:a',
      replicaId: 'replica-1',
      sequenceScope: 'collection-1',
      sequence: 1,
    };

    await expect(claimSyncOperations(transaction, [claim])).rejects.toThrow(
      /transaction-local read-back verification/i,
    );
    expect(claims.get('operation-1')?.digest).toBe('sha-256:mutated');
  });
});
