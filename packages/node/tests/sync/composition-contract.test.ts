import { describe, expect, it, vi } from 'vitest';

import type { Operation, OperationResult } from '../../src/types/index.js';
import * as compositionApi from '../../src/sync/composition.js';
import * as legacyApi from '../../src/sync/legacy.js';
import * as sessionApi from '../../src/sync/session.js';
import {
  SYNC_HOST_COMPOSITION_NOTES,
  SyncSessionGateDeniedError,
  asReplicaAuthenticatedCommand,
  assertSyncPushBatchBoundToSession,
  assertVerifiedSyncSession,
  bindSyncPushBatchId,
  coordinateReplicaLifecycle,
  coordinateSessionBoundPull,
  coordinateSessionBoundPush,
  coordinateSessionBoundReplicaLifecycle,
  collectionSequenceScopeKey,
  coordinateSessionBoundSequence,
  sequenceScopeMatchesCollection,
  createReplicaAuthProofFromVerifiedSession,
  createSyncSession,
  isReplicaAuthProof,
  requireVerifiedSyncSession,
  type ActiveSyncSessionRecord,
  type CreateSyncSessionInput,
  type DurableReplicaCheckpoint,
  type PushPreparedOperation,
  type PushTransactionRequest,
  type ReplicaLifecycleCommand,
  type ReplicaLifecycleKey,
  type ReplicaLifecycleTransaction,
  type ReplicaLifecycleUnitOfWork,
  type SequenceCoordinatorTransaction,
  type SequenceCoordinatorUnitOfWork,
  type SequenceLaneKey,
  type SequenceOperationRequest,
  type StoredOperationReceipt,
  type SyncOperationClaim,
  type SyncOperationReuseAudit,
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
  type SyncTransaction,
  type SyncUnitOfWork,
  type VerifySyncSessionContextInput,
} from '../../src/sync/index.js';
import {
  canPurgeTombstone,
  createSequenceState,
  decideSequence,
  haveMatchingTypedUpdateFields,
  transitionReplicaLifecycle,
} from '../../src/sync/legacy.js';
import * as syncApi from '../../src/sync/index.js';
import { createUnverifiedReplicaAuthProofForTests } from '../../src/testing/index.js';

const evidence = '[evidence:sync.composition]';
const createdAt = '2026-07-18T02:00:00Z';
const now = '2026-07-18T01:00:00Z';
const future = '2026-07-18T02:00:00Z';

// ---------------------------------------------------------------------------
// Session store fixture (mirrors session.test.ts durable memory adapter)
// ---------------------------------------------------------------------------

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
    authorizationScopes: ['collections:create', 'sync:bootstrap', 'sync:pull', 'sync:push'],
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

// ---------------------------------------------------------------------------
// Minimal Push UnitOfWork (enough for one applied delete_node)
// ---------------------------------------------------------------------------

interface Conflict {
  readonly id: string;
}
interface Audit {
  readonly id: string;
  readonly result: { readonly status: string };
}
interface Outbox {
  readonly id: string;
  readonly cursor: string;
}

interface PushState {
  operations: Operation[];
  receipts: StoredOperationReceipt<OperationResult>[];
  conflicts: Conflict[];
  cursors: string[];
  audits: Audit[];
  outbox: Outbox[];
  operationClaims: Map<string, SyncOperationClaim>;
  reuseAudits: Map<string, SyncOperationReuseAudit>;
}

function emptyPushState(): PushState {
  return {
    operations: [],
    receipts: [],
    conflicts: [],
    cursors: [],
    audits: [],
    outbox: [],
    operationClaims: new Map(),
    reuseAudits: new Map(),
  };
}

function clonePushState(state: PushState): PushState {
  return {
    operations: structuredClone(state.operations),
    receipts: structuredClone(state.receipts),
    conflicts: structuredClone(state.conflicts),
    cursors: structuredClone(state.cursors),
    audits: structuredClone(state.audits),
    outbox: structuredClone(state.outbox),
    operationClaims: new Map(
      [...state.operationClaims].map(([key, value]) => [key, structuredClone(value)]),
    ),
    reuseAudits: new Map(
      [...state.reuseAudits].map(([key, value]) => [key, structuredClone(value)]),
    ),
  };
}

type TestPushTransaction = SyncTransaction<Operation, OperationResult, Conflict, Audit, Outbox>;

class TrackingPushUnitOfWork implements SyncUnitOfWork<
  Operation,
  OperationResult,
  Conflict,
  Audit,
  Outbox,
  TestPushTransaction
> {
  readonly operationIdReservationOwner = 'push' as const;
  executeCount = 0;
  readonly backend = { state: emptyPushState() };

  async execute<Value>(work: (transaction: TestPushTransaction) => Promise<Value>): Promise<Value> {
    this.executeCount += 1;
    const draft = clonePushState(this.backend.state);
    const result = await work(this.transaction(draft));
    this.backend.state = draft;
    return result;
  }

  private transaction(draft: PushState): TestPushTransaction {
    return {
      idReservations: { reserveAll: async () => ({ state: 'reserved' as const }) },
      operationClaims: {
        load: async (id: string) => {
          const claim = draft.operationClaims.get(id);
          return claim === undefined ? undefined : structuredClone(claim);
        },
        save: async (claim: SyncOperationClaim) => {
          draft.operationClaims.set(claim.operationId, structuredClone(claim));
        },
      },
      reuseAudits: {
        append: async (audit: SyncOperationReuseAudit) => {
          const key = `reuse-${draft.reuseAudits.size + 1}`;
          draft.reuseAudits.set(key, structuredClone(audit));
          return key;
        },
        load: async (key: string) => {
          const audit = draft.reuseAudits.get(key);
          return audit === undefined ? undefined : structuredClone(audit);
        },
      },
      receipts: {
        findByOperationId: async (operationId) => structuredClone(
          draft.receipts.find((receipt) => receipt.operationId === operationId),
        ),
        findBySequence: async (replicaId, sequenceScope, sequence) => structuredClone(
          draft.receipts.find((receipt) => (
            receipt.replicaId === replicaId
            && receipt.sequenceScope === sequenceScope
            && receipt.sequence === sequence
          )),
        ),
        save: async (receipt) => {
          draft.receipts.push(structuredClone(receipt));
        },
      },
      appendOperation: async (operation) => {
        draft.operations.push(structuredClone(operation));
      },
      saveConflict: async (conflict) => {
        draft.conflicts.push(structuredClone(conflict));
      },
      allocateCursor: async () => {
        const cursor = `cursor-${draft.cursors.length + 1}`;
        draft.cursors.push(cursor);
        return cursor;
      },
      appendAudit: async (audit) => {
        draft.audits.push(structuredClone(audit));
      },
      appendOutbox: async (message) => {
        draft.outbox.push(structuredClone(message));
      },
    };
  }
}

function deleteNodeOperation(index = 1): Operation {
  return {
    opId: `operation-${index}`,
    replicaId: 'replica-1',
    sequence: index,
    type: 'delete_node',
    occurredAt: '2026-07-18T00:00:00Z',
    collectionId: 'collection-1',
    targetId: `node-${index}`,
    baseRevision: `revision-${index}`,
    payload: {},
  };
}

function pushRequest(batchId = 'session-1.batch-1'): PushTransactionRequest {
  return {
    batchId,
    atomic: true,
    serverCursor: 'cursor-0',
    operations: [{
      operation: deleteNodeOperation(1),
      sequenceScope: 'collection-1',
      digest: 'digest-1',
    }],
  };
}

function appliedPlan(
  index = 1,
): PushPreparedOperation<TestPushTransaction, Conflict, Audit, Outbox> {
  return {
    status: 'applied',
    apply: async () => ({
      opId: `operation-${index}`,
      sequence: index,
      status: 'applied' as const,
      warnings: [],
      revision: `revision-applied-${index}`,
    }),
    audit: async (context) => ({
      id: `audit-${index}`,
      result: { status: context.result.status },
    }),
    outbox: async (context) => ({
      id: `outbox-${index}`,
      cursor: context.cursor!,
    }),
  };
}

// ---------------------------------------------------------------------------
// Pull stores
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Minimal Sequence UnitOfWork (gate-failure path must never call execute)
// ---------------------------------------------------------------------------

type SequenceResult = { readonly status: 'applied' };

class TrackingSequenceUnitOfWork implements SequenceCoordinatorUnitOfWork<SequenceResult> {
  readonly operationIdReservationOwner = 'sequence' as const;
  executeCount = 0;

  async execute<Value>(
    _lane: SequenceLaneKey,
    work: (transaction: SequenceCoordinatorTransaction<SequenceResult>) => Promise<Value>,
  ): Promise<Value> {
    this.executeCount += 1;
    // Intentionally incomplete transaction: Session-gate fail-closed tests must
    // never reach execute. Happy-path Sequence coverage lives in sequence.test.ts.
    return work({} as SequenceCoordinatorTransaction<SequenceResult>);
  }
}

function sequenceRequest(): SequenceOperationRequest {
  return {
    operationId: 'operation-1',
    replicaId: 'replica-1',
    sequenceScope: 'collection-1',
    sequence: 1,
    digest: 'digest-1',
  };
}

// ---------------------------------------------------------------------------
// Replica lifecycle fixture
// ---------------------------------------------------------------------------

const replicaKey = Object.freeze({
  replicaId: 'replica-1',
  collectionId: 'collection-1',
}) satisfies ReplicaLifecycleKey;

class MemoryReplicaLifecycle implements ReplicaLifecycleUnitOfWork {
  executeCount = 0;
  readonly replicas = new Map<string, DurableReplicaCheckpoint>();

  execute<Value>(
    _replicaId: string,
    work: (transaction: ReplicaLifecycleTransaction) => Promise<Value>,
  ): Promise<Value> {
    this.executeCount += 1;
    return work({
      readAuthoritativeTime: async () => now,
      loadReplica: async (id) => {
        const stored = this.replicas.get(id);
        return stored === undefined ? undefined : structuredClone(stored);
      },
      saveReplica: async (value) => {
        this.replicas.set(value.replicaId, structuredClone(value));
      },
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
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe(`Sync composition & export layering ${evidence}`, () => {
  describe('export identity and legacy compatibility', () => {
    it(`re-exports composition helpers from the Sync public entry with stable identities ${evidence}`, () => {
      // Session gate primitives live in session.ts; composition re-exports them.
      expect(syncApi.requireVerifiedSyncSession).toBe(sessionApi.requireVerifiedSyncSession);
      expect(syncApi.assertVerifiedSyncSession).toBe(sessionApi.assertVerifiedSyncSession);
      expect(syncApi.SyncSessionGateDeniedError).toBe(sessionApi.SyncSessionGateDeniedError);
      expect(compositionApi.requireVerifiedSyncSession).toBe(sessionApi.requireVerifiedSyncSession);
      expect(compositionApi.assertVerifiedSyncSession).toBe(sessionApi.assertVerifiedSyncSession);
      expect(compositionApi.SyncSessionGateDeniedError).toBe(sessionApi.SyncSessionGateDeniedError);

      // Session-bound coordinators and notes are composition-owned.
      expect(syncApi.coordinateSessionBoundPush).toBe(compositionApi.coordinateSessionBoundPush);
      expect(syncApi.coordinateSessionBoundPull).toBe(compositionApi.coordinateSessionBoundPull);
      expect(syncApi.coordinateSessionBoundReplicaLifecycle).toBe(
        compositionApi.coordinateSessionBoundReplicaLifecycle,
      );
      expect(syncApi.coordinateSessionBoundSequence).toBe(compositionApi.coordinateSessionBoundSequence);
      expect(syncApi.collectionSequenceScopeKey).toBe(compositionApi.collectionSequenceScopeKey);
      expect(syncApi.sequenceScopeMatchesCollection).toBe(compositionApi.sequenceScopeMatchesCollection);
      expect(syncApi.assertSyncPushBatchBoundToSession).toBe(
        compositionApi.assertSyncPushBatchBoundToSession,
      );
      expect(syncApi.bindSyncPushBatchId).toBe(compositionApi.bindSyncPushBatchId);
      expect(syncApi.SYNC_HOST_COMPOSITION_NOTES).toBe(compositionApi.SYNC_HOST_COMPOSITION_NOTES);
      expect(typeof syncApi.createSyncHost).toBe('function');
    });

    it(`keeps the pure reducers internal and off the public Sync entry ${evidence}`, () => {
      expect(typeof decideSequence).toBe('function');
      expect(typeof createSequenceState).toBe('function');
      expect(typeof canPurgeTombstone).toBe('function');
      expect(typeof haveMatchingTypedUpdateFields).toBe('function');
      expect(typeof transitionReplicaLifecycle).toBe('function');

      const state = createSequenceState(1);
      expect(decideSequence(state, 1, 'digest-a')).toEqual({ kind: 'accept' });
      expect(canPurgeTombstone({
        retentionElapsed: true,
        activeReplicaAcks: [{ acknowledgedDeletion: true, queuedOperationsReconciled: true }],
        purgeBoundaryReady: true,
        deletionWatermarkReady: true,
      })).toBe(true);
      expect(haveMatchingTypedUpdateFields({ a: 1 }, { a: 2 })).toBe(true);

      // They are internal modelling helpers, not part of the public Sync entry.
      for (const name of Object.keys(legacyApi)) {
        expect(Object.hasOwn(syncApi, name), name).toBe(false);
      }
    });

    it(`documents exclusive opId ownership and omits a dual-owner sequenced-push facade ${evidence}`, () => {
      expect(SYNC_HOST_COMPOSITION_NOTES.exclusiveOpIdOwner).toMatch(/exactly one/i);
      expect(SYNC_HOST_COMPOSITION_NOTES.exclusiveOpIdOwner).toMatch(/createSyncHost/i);
      expect(SYNC_HOST_COMPOSITION_NOTES.sessionFirst).toMatch(/verifySyncSessionContext|requireVerifiedSyncSession/i);
      expect(SYNC_HOST_COMPOSITION_NOTES.migration).toMatch(/sync\/unsafe/i);

      // SYNC-V-009: no dual-owner sequenced-push facade (docs-only composition contract).
      expect('coordinateSequencedPush' in syncApi).toBe(false);
      expect('coordinateSessionBoundSequencedPush' in syncApi).toBe(false);
      expect(Object.keys(syncApi).filter((name) => /sequencedPush/i.test(name))).toEqual([]);
    });
  });

  describe('session-bound Push fail-closed gate', () => {
    it(`does not invoke the Push unit of work when Session verification fails ${evidence}`, async () => {
      const store = new DurableMemorySessionStore();
      const input = collectionInput();
      await createSyncSession(store, input);
      store.loadCalls.length = 0;

      const unitOfWork = new TrackingPushUnitOfWork();
      const preflight = vi.fn(async () => appliedPlan(1));

      // Binding mismatch is a durable verify failure (not an input TypeError).
      await expect(coordinateSessionBoundPush(
        { pushOwnershipVerifier: () => true,
          kind: 'verify',
          store,
          input: verification(input, {
            binding: { ...binding(input), principal: { type: 'user', id: 'mallory' } },
          }),
        },
        unitOfWork,
        pushRequest(),
        preflight,
      )).rejects.toMatchObject({
        name: 'SyncSessionGateDeniedError',
        denial: { state: 'context_mismatch' },
      });

      expect(store.loadCalls).toEqual(['session-1']);
      expect(unitOfWork.executeCount).toBe(0);
      expect(preflight).not.toHaveBeenCalled();
      expect(unitOfWork.backend.state.operations).toEqual([]);
    });

    it(`does not invoke Push when the Session is missing ${evidence}`, async () => {
      const store = new DurableMemorySessionStore();
      const input = collectionInput();
      const unitOfWork = new TrackingPushUnitOfWork();
      const preflight = vi.fn(async () => appliedPlan(1));

      await expect(coordinateSessionBoundPush(
        { pushOwnershipVerifier: () => true, kind: 'verify', store, input: verification(input) },
        unitOfWork,
        pushRequest(),
        preflight,
      )).rejects.toMatchObject({
        name: 'SyncSessionGateDeniedError',
        denial: { state: 'not_found' },
      });

      expect(store.loadCalls).toEqual(['session-1']);
      expect(unitOfWork.executeCount).toBe(0);
      expect(preflight).not.toHaveBeenCalled();
      expect(unitOfWork.backend.state.operations).toEqual([]);
      expect(unitOfWork.backend.state.receipts).toEqual([]);
    });

    it(`propagates session-store load failures and does not invoke Push ${evidence}`, async () => {
      const storeFailure = new Error('DB connection failed');
      const store: SyncSessionStore = {
        async create() {
          throw new Error('create must not run');
        },
        async load() {
          throw storeFailure;
        },
        async terminate() {
          throw new Error('terminate must not run');
        },
      };
      const unitOfWork = new TrackingPushUnitOfWork();
      const preflight = vi.fn(async () => appliedPlan(1));

      await expect(coordinateSessionBoundPush(
        { pushOwnershipVerifier: () => true, kind: 'verify', store, input: verification(collectionInput()) },
        unitOfWork,
        pushRequest(),
        preflight,
      )).rejects.toBe(storeFailure);

      expect(unitOfWork.executeCount).toBe(0);
      expect(preflight).not.toHaveBeenCalled();
      expect(unitOfWork.backend.state.operations).toEqual([]);
    });

    it(`propagates a Session store load failure before Push work ${evidence}`, async () => {
      const store = new DurableMemorySessionStore();
      const sentinel = new Error('session-store-unavailable');
      vi.spyOn(store, 'load').mockRejectedValue(sentinel);
      const input = collectionInput();
      const unitOfWork = new TrackingPushUnitOfWork();
      const preflight = vi.fn(async () => appliedPlan(1));

      await expect(coordinateSessionBoundPush(
        { pushOwnershipVerifier: () => true, kind: 'verify', store, input: verification(input) },
        unitOfWork,
        pushRequest(),
        preflight,
      )).rejects.toBe(sentinel);

      expect(unitOfWork.executeCount).toBe(0);
      expect(preflight).not.toHaveBeenCalled();
    });

    it(`invokes Push after successful Session verification ${evidence}`, async () => {
      const store = new DurableMemorySessionStore();
      const input = collectionInput();
      await createSyncSession(store, input);
      store.loadCalls.length = 0;

      const unitOfWork = new TrackingPushUnitOfWork();
      const batchId = bindSyncPushBatchId(input.sessionId, 'batch-1');
      const outcome = await coordinateSessionBoundPush(
        { pushOwnershipVerifier: () => true, kind: 'verify', store, input: verification(input) },
        unitOfWork,
        pushRequest(batchId),
        async () => appliedPlan(1),
      );

      expect(store.loadCalls).toEqual(['session-1']);
      expect(unitOfWork.executeCount).toBeGreaterThan(0);
      expect(outcome.session.sessionId).toBe('session-1');
      expect(outcome.session.status).toBe('active');
      expect(outcome.result.batchId).toBe(batchId);
      expect(outcome.result.results.map((item) => item.opId)).toEqual(['operation-1']);
      expect(unitOfWork.backend.state.operations.map((item) => item.opId)).toEqual(['operation-1']);
    });

    it(`rejects Push when the verified Session lacks sync:push ${evidence}`, async () => {
      const store = new DurableMemorySessionStore();
      const input = collectionInput({ authorizationScopes: ['sync:pull'] });
      await createSyncSession(store, input);
      const verified = await requireVerifiedSyncSession(store, verification(input));
      const unitOfWork = new TrackingPushUnitOfWork();
      const preflight = vi.fn(async () => appliedPlan(1));

      await expect(coordinateSessionBoundPush(
        { pushOwnershipVerifier: () => true, kind: 'verified', session: verified },
        unitOfWork,
        pushRequest(),
        preflight,
      )).rejects.toMatchObject({
        denial: { state: 'scope_missing', requiredScope: 'sync:push' },
      });
      expect(unitOfWork.executeCount).toBe(0);
      expect(preflight).not.toHaveBeenCalled();
    });

    it(`rejects unbound batchId before invoking Push ${evidence}`, async () => {
      const store = new DurableMemorySessionStore();
      const input = collectionInput();
      await createSyncSession(store, input);
      const unitOfWork = new TrackingPushUnitOfWork();
      const preflight = vi.fn(async () => appliedPlan(1));

      await expect(coordinateSessionBoundPush(
        { pushOwnershipVerifier: () => true, kind: 'verify', store, input: verification(input) },
        unitOfWork,
        pushRequest('batch-unbound'),
        preflight,
      )).rejects.toMatchObject({
        name: 'SyncSessionGateDeniedError',
        denial: { state: 'request_binding_mismatch' },
      });

      expect(unitOfWork.executeCount).toBe(0);
      expect(preflight).not.toHaveBeenCalled();
      expect(() => assertSyncPushBatchBoundToSession(
        'batch-unbound',
        { sessionId: input.sessionId },
      )).toThrow(SyncSessionGateDeniedError);
      expect(() => assertSyncPushBatchBoundToSession(
        bindSyncPushBatchId(input.sessionId, 'ok'),
        { sessionId: input.sessionId },
      )).not.toThrow();
      expect(() => assertSyncPushBatchBoundToSession(
        input.sessionId,
        { sessionId: input.sessionId },
      )).toThrow(SyncSessionGateDeniedError);
      expect(() => assertSyncPushBatchBoundToSession(
        `${input.sessionId}.opaque`,
        { sessionId: input.sessionId },
      )).toThrow(SyncSessionGateDeniedError);
      expect(() => assertSyncPushBatchBoundToSession(
        `${input.sessionId}/opaque`,
        { sessionId: input.sessionId },
      )).toThrow(SyncSessionGateDeniedError);
    });
  });

  describe('session-bound Sequence fail-closed gate', () => {
    it(`does not invoke the Sequence unit of work when Session verification fails ${evidence}`, async () => {
      const store = new DurableMemorySessionStore();
      const input = collectionInput();
      await createSyncSession(store, input);
      store.loadCalls.length = 0;

      const unitOfWork = new TrackingSequenceUnitOfWork();
      const evaluate = vi.fn(async () => ({
        status: 'applied' as const,
        result: { status: 'applied' as const },
      }));

      await expect(coordinateSessionBoundSequence(
        {
          kind: 'verify',
          store,
          input: verification(input, {
            binding: { ...binding(input), principal: { type: 'user', id: 'mallory' } },
          }),
        },
        unitOfWork,
        sequenceRequest(),
        evaluate,
      )).rejects.toMatchObject({
        name: 'SyncSessionGateDeniedError',
        denial: { state: 'context_mismatch' },
      });

      expect(store.loadCalls).toEqual(['session-1']);
      expect(unitOfWork.executeCount).toBe(0);
      expect(evaluate).not.toHaveBeenCalled();
    });

    it('rejects a Sequence lane outside the verified Collection before entering storage', async () => {
      const store = new DurableMemorySessionStore();
      const input = collectionInput();
      await createSyncSession(store, input);
      const verified = await requireVerifiedSyncSession(store, verification(input));
      const unitOfWork = new TrackingSequenceUnitOfWork();
      const evaluate = vi.fn(async () => ({ status: 'applied' as const, result: { status: 'applied' as const } }));
      await expect(coordinateSessionBoundSequence({ kind: 'verified', session: verified }, unitOfWork,
        { ...sequenceRequest(), sequenceScope: 'another-collection' }, evaluate))
        .rejects.toMatchObject({ denial: { state: 'request_binding_mismatch' } });
      expect(unitOfWork.executeCount).toBe(0);
      expect(evaluate).not.toHaveBeenCalled();
    });

    it('requires durable Sequence Replica ownership before entering storage', async () => {
      const store = new DurableMemorySessionStore();
      const input = collectionInput();
      await createSyncSession(store, input);
      const verified = await requireVerifiedSyncSession(store, verification(input));
      const unitOfWork = new TrackingSequenceUnitOfWork();
      const evaluate = vi.fn(async () => ({ status: 'applied' as const, result: { status: 'applied' as const } }));

      await expect(coordinateSessionBoundSequence({ kind: 'verified', session: verified }, unitOfWork,
        sequenceRequest(), evaluate)).rejects.toMatchObject({ denial: { state: 'request_binding_mismatch' } });
      await expect(coordinateSessionBoundSequence({
        kind: 'verified', session: verified, sequenceOwnershipVerifier: () => false,
      }, unitOfWork, sequenceRequest(), evaluate)).rejects.toMatchObject({ denial: { state: 'request_binding_mismatch' } });
      expect(unitOfWork.executeCount).toBe(0);
      expect(evaluate).not.toHaveBeenCalled();
    });

    it('accepts the Collection persistence scope key for the verified Session', async () => {
      const store = new DurableMemorySessionStore();
      const input = collectionInput();
      await createSyncSession(store, input);
      const verified = await requireVerifiedSyncSession(store, verification(input));
      const unitOfWork = new TrackingSequenceUnitOfWork();
      const evaluate = vi.fn(async () => ({ status: 'applied' as const, result: { status: 'applied' as const } }));
      const persistenceKey = collectionSequenceScopeKey(verified.collectionId!);
      expect(sequenceScopeMatchesCollection(persistenceKey, verified.collectionId!)).toBe(true);
      await expect(coordinateSessionBoundSequence({ kind: 'verified', session: verified, sequenceOwnershipVerifier: () => true }, unitOfWork,
        { ...sequenceRequest(), sequenceScope: persistenceKey }, evaluate)).rejects.toThrow();
      expect(unitOfWork.executeCount).toBe(1);
    });

    it('rejects a persistence scope key for a different Collection before entering storage', async () => {
      const store = new DurableMemorySessionStore();
      const input = collectionInput();
      await createSyncSession(store, input);
      const verified = await requireVerifiedSyncSession(store, verification(input));
      const unitOfWork = new TrackingSequenceUnitOfWork();
      const evaluate = vi.fn(async () => ({ status: 'applied' as const, result: { status: 'applied' as const } }));
      await expect(coordinateSessionBoundSequence({ kind: 'verified', session: verified }, unitOfWork,
        { ...sequenceRequest(), sequenceScope: collectionSequenceScopeKey('other-collection') }, evaluate))
        .rejects.toMatchObject({ denial: { state: 'request_binding_mismatch' } });
      expect(unitOfWork.executeCount).toBe(0);
      expect(evaluate).not.toHaveBeenCalled();
    });

    it(`does not invoke Sequence when the verified Session lacks sync:push ${evidence}`, async () => {
      const store = new DurableMemorySessionStore();
      const input = collectionInput({ authorizationScopes: ['sync:pull'] });
      await createSyncSession(store, input);
      const verified = await requireVerifiedSyncSession(store, verification(input));
      const unitOfWork = new TrackingSequenceUnitOfWork();
      const evaluate = vi.fn(async () => ({
        status: 'applied' as const,
        result: { status: 'applied' as const },
      }));

      await expect(coordinateSessionBoundSequence(
        { kind: 'verified', session: verified },
        unitOfWork,
        sequenceRequest(),
        evaluate,
      )).rejects.toMatchObject({
        denial: { state: 'scope_missing', requiredScope: 'sync:push' },
      });
      expect(unitOfWork.executeCount).toBe(0);
      expect(evaluate).not.toHaveBeenCalled();
    });
  });

  describe('session-bound Pull principal / binding gate', () => {
    it(`fails closed on principal mismatch without reading pull stores ${evidence}`, async () => {
      const store = new DurableMemorySessionStore();
      const input = collectionInput();
      await createSyncSession(store, input);
      const verified = await requireVerifiedSyncSession(store, verification(input));

      const cursorStore = new TrackingPullCursorStore(pullCursorRecord());
      const eventStore = new TrackingPullEventStore({
        entries: [],
        hasMore: false,
        collectionRevision: 'revision-1',
        recommendedPullAfterSeconds: 30,
      });

      await expect(coordinateSessionBoundPull(
        { kind: 'verified', session: verified },
        pullRequest({ principal: { type: 'user', id: 'mallory' } }),
        cursorStore,
        eventStore,
      )).rejects.toMatchObject({
        name: 'SyncSessionGateDeniedError',
        denial: {
          state: 'request_binding_mismatch',
          detail: expect.stringMatching(/principal/i) as string,
        },
      });

      expect(cursorStore.resolveCalls).toBe(0);
      expect(eventStore.reads).toEqual([]);
    });

    it(`fails closed when Session verify fails before Pull stores run ${evidence}`, async () => {
      const store = new DurableMemorySessionStore();
      const input = collectionInput();
      // Session never created → not_found
      const cursorStore = new TrackingPullCursorStore(pullCursorRecord());
      const eventStore = new TrackingPullEventStore({
        entries: [],
        hasMore: false,
        collectionRevision: 'revision-1',
        recommendedPullAfterSeconds: 30,
      });

      await expect(coordinateSessionBoundPull(
        { kind: 'verify', store, input: verification(input) },
        pullRequest(),
        cursorStore,
        eventStore,
      )).rejects.toMatchObject({ denial: { state: 'not_found' } });

      expect(store.loadCalls).toEqual(['session-1']);
      expect(cursorStore.resolveCalls).toBe(0);
      expect(eventStore.reads).toEqual([]);
    });

    it(`fails closed when the verified Session lacks sync:pull without reading stores ${evidence}`, async () => {
      const store = new DurableMemorySessionStore();
      const input = collectionInput({ authorizationScopes: ['sync:push'] });
      await createSyncSession(store, input);
      const verified = await requireVerifiedSyncSession(store, verification(input));

      const cursorStore = new TrackingPullCursorStore(pullCursorRecord());
      const eventStore = new TrackingPullEventStore({
        entries: [],
        hasMore: false,
        collectionRevision: 'revision-1',
        recommendedPullAfterSeconds: 30,
      });

      await expect(coordinateSessionBoundPull(
        { kind: 'verified', session: verified },
        pullRequest(),
        cursorStore,
        eventStore,
      )).rejects.toMatchObject({
        denial: { state: 'scope_missing', requiredScope: 'sync:pull' },
      });
      expect(cursorStore.resolveCalls).toBe(0);
      expect(eventStore.reads).toEqual([]);
    });

    it(`pulls after verified Session when principal and collection bind ${evidence}`, async () => {
      const store = new DurableMemorySessionStore();
      const input = collectionInput();
      await createSyncSession(store, input);
      const verified = await requireVerifiedSyncSession(store, verification(input));

      const cursorStore = new TrackingPullCursorStore(pullCursorRecord());
      const eventStore = new TrackingPullEventStore({
        entries: [],
        hasMore: false,
        collectionRevision: 'revision-7',
        recommendedPullAfterSeconds: 15,
      });

      const outcome = await coordinateSessionBoundPull(
        { kind: 'verified', session: verified },
        pullRequest(),
        cursorStore,
        eventStore,
      );

      expect(outcome.session.sessionId).toBe('session-1');
      expect(outcome.result).toMatchObject({ ok: true, status: 200 });
      expect(cursorStore.resolveCalls).toBe(1);
      expect(eventStore.reads).toHaveLength(1);
    });
  });

  describe('Replica auth proof factory (SYNC-V-006 misuse resistance)', () => {
    it(`mints a branded proof from a verified Session and cannot forge via plain object ${evidence}`, async () => {
      const store = new DurableMemorySessionStore();
      const input = collectionInput();
      await createSyncSession(store, input);
      const verified = await requireVerifiedSyncSession(store, verification(input));

      const proof = createReplicaAuthProofFromVerifiedSession(verified);
      expect(proof.authenticated).toBe(true);
      expect(proof.source).toBe('verified-session');
      expect(isReplicaAuthProof(proof)).toBe(true);

      // Runtime brand is a package-private Symbol — plain shapes and guessed keys fail.
      expect(isReplicaAuthProof({ authenticated: true })).toBe(false);
      expect(isReplicaAuthProof({
        authenticated: true,
        source: 'verified-session',
      })).toBe(false);
      expect(isReplicaAuthProof({
        authenticated: true,
        source: 'verified-session',
        [Symbol('ReplicaAuthProof')]: true,
      })).toBe(false);

      expect(() => asReplicaAuthenticatedCommand(
        {
          type: 'register',
          collectionId: 'collection-1',
          leaseId: 'lease-1',
          generation: 'generation-1',
          leaseExpiresAt: future,
          succeeded: true,
        },
        { authenticated: true } as never,
      )).toThrow(/package-minted ReplicaAuthProof/i);

      expect(() => asReplicaAuthenticatedCommand(
        {
          type: 'register',
          collectionId: 'collection-1',
          leaseId: 'lease-1',
          generation: 'generation-1',
          leaseExpiresAt: future,
          succeeded: true,
        },
        {
          authenticated: true,
          source: 'verified-session',
          [Symbol('ReplicaAuthProof')]: true,
        } as never,
      )).toThrow(/package-minted ReplicaAuthProof/i);

      const command = asReplicaAuthenticatedCommand(
        {
          type: 'register',
          collectionId: 'collection-1',
          leaseId: 'lease-1',
          generation: 'generation-1',
          leaseExpiresAt: future,
          succeeded: true,
        },
        proof,
      );
      expect(command.authenticated).toBe(true);
      expect(command.type).toBe('register');
    });

    it(`registers through the session-bound lifecycle coordinator ${evidence}`, async () => {
      const store = new DurableMemorySessionStore();
      const input = collectionInput();
      await createSyncSession(store, input);
      const handle = new MemoryReplicaLifecycle();

      const outcome = await coordinateSessionBoundReplicaLifecycle(
        {
          kind: 'verify',
          store,
          input: verification(input),
        },
        handle,
        replicaKey,
        {
          type: 'register',
          collectionId: 'collection-1',
          leaseId: 'lease-1',
          generation: 'generation-1',
          leaseExpiresAt: future,
          succeeded: true,
        },
        () => true,
      );

      expect(outcome.session.sessionId).toBe(input.sessionId);
      expect(outcome.result.state).toBe('committed');
      expect(handle.executeCount).toBe(1);
      if (outcome.result.state === 'committed') {
        expect(outcome.result.checkpoint.lifecycle).toBe('active');
        expect(outcome.result.checkpoint.leaseId).toBe('lease-1');
      }
    });

    it(`rejects a lifecycle key outside the verified Session Collection before opening a transaction ${evidence}`, async () => {
      const store = new DurableMemorySessionStore();
      const input = collectionInput();
      await createSyncSession(store, input);
      const verified = await requireVerifiedSyncSession(store, verification(input));
      const handle = new MemoryReplicaLifecycle();

      const operation = coordinateSessionBoundReplicaLifecycle(
        { kind: 'verified', session: verified },
        handle,
        { ...replicaKey, collectionId: 'collection-2' },
        {
          type: 'register',
          collectionId: 'collection-2',
          leaseId: 'lease-1',
          generation: 'generation-1',
          leaseExpiresAt: future,
          succeeded: true,
        },
        () => true,
      );

      await expect(operation).rejects.toBeInstanceOf(SyncSessionGateDeniedError);
      await expect(operation).rejects.toMatchObject({
        denial: { state: 'request_binding_mismatch' },
      });
      expect(handle.executeCount).toBe(0);
      expect(handle.replicas.size).toBe(0);
    });

    it(`rejects a self-asserted authentication field on the session-bound API ${evidence}`, async () => {
      const store = new DurableMemorySessionStore();
      const input = collectionInput();
      await createSyncSession(store, input);
      const verified = await requireVerifiedSyncSession(store, verification(input));
      const handle = new MemoryReplicaLifecycle();

      await expect(coordinateSessionBoundReplicaLifecycle(
        { kind: 'verified', session: verified },
        handle,
        replicaKey,
        {
          type: 'register',
          collectionId: 'collection-1',
          leaseId: 'lease-1',
          generation: 'generation-1',
          leaseExpiresAt: future,
          succeeded: true,
          authenticated: true,
        } as never,
        () => true,
      )).rejects.toThrow(/must not supply authenticated/i);
      expect(handle.executeCount).toBe(0);
    });

    it(`still denies unauthorized lifecycle commands (authenticated: false) ${evidence}`, async () => {
      const handle = new MemoryReplicaLifecycle();
      // Seed an active replica so renew is the denied path (not replica_not_found).
      handle.replicas.set('replica-1', {
        replicaId: 'replica-1',
        collectionId: 'collection-1',
        leaseId: 'lease-old',
        generation: 'generation-old',
        lastSeenAt: now,
        leaseExpiresAt: future,
        acknowledgedCursor: null,
        acknowledgedCommitOrdinal: null,
        lifecycle: 'active',
      });
      const checkpointBefore = structuredClone(handle.replicas.get('replica-1'));

      const denied: ReplicaLifecycleCommand = {
        type: 'renew',
        leaseExpiresAt: '2026-07-18T03:00:00Z',
        authenticated: false,
        succeeded: true,
      };

      await expect(coordinateReplicaLifecycle(handle, replicaKey, denied)).resolves.toMatchObject({
        state: 'denied',
        code: 'unauthorized',
      });

      // Auth is checked inside the UnitOfWork callback; prove durable state is unchanged.
      expect(handle.executeCount).toBe(1);
      expect(handle.replicas.get('replica-1')).toEqual(checkpointBefore);
    });

    it(`test-only proof factory (testing surface) still produces a package-branded proof ${evidence}`, () => {
      const proof = createUnverifiedReplicaAuthProofForTests();
      expect(isReplicaAuthProof(proof)).toBe(true);
      expect(proof.source).toBe('unverified-test');
      // Distinct from a forgeable plain object with the same public fields.
      expect(isReplicaAuthProof({
        authenticated: true,
        source: 'unverified-test',
      })).toBe(false);
    });

    it(`assertVerifiedSyncSession rejects non-active verification results ${evidence}`, () => {
      expect(() => assertVerifiedSyncSession({ state: 'not_found' })).toThrow(SyncSessionGateDeniedError);
      expect(() => assertVerifiedSyncSession({ state: 'context_mismatch' })).toThrow(
        SyncSessionGateDeniedError,
      );

      let denial: unknown;
      try {
        assertVerifiedSyncSession({ state: 'not_found' });
      } catch (error) {
        denial = error;
      }
      expect(denial).toBeInstanceOf(SyncSessionGateDeniedError);
      expect((denial as SyncSessionGateDeniedError).denial).toEqual({ state: 'not_found' });
    });
  });
});
