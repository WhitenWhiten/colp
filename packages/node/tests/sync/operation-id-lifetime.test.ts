import { isDeepStrictEqual } from 'node:util';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import {
  coordinatePushTransaction,
  coordinateSequenceOperation,
  type PushPreflightContext,
} from '../../src/sync/unsafe.js';
import {
  coordinateSessionBootstrap,
  reserveServerIds,
  ServerIdAlreadyReservedError,
  SyncOperationReuseError,
  type ActiveSyncSessionRecord,
  type PurePushPreflight,
  type PushPreparedOperation,
  type PushTransactionOperation,
  type PushTransactionRequest,
  type ServerIdReservation,
  type ServerIdReservationResult,
  type ServerIdReservationStore,
  type SequenceCoordinatorTransaction,
  type SequenceCoordinatorUnitOfWork,
  type SequenceLaneKey,
  type SequenceOperationRequest,
  type SequenceReceiptWriteCondition,
  type SessionBootstrapCollectionAggregate,
  type SessionBootstrapIdentity,
  type SessionBootstrapLane,
  type SessionBootstrapPrepared,
  type SessionBootstrapRequest,
  type SessionBootstrapSequenceLane,
  type SessionBootstrapTransaction,
  type SessionBootstrapUnitOfWork,
  type StoredOperationReceipt,
  type StoredSessionBootstrapReceipt,
  type SyncSessionRecord,
  type SyncTransaction,
  type SyncUnitOfWork,
} from '../../src/sync/index.js';
import type {
  Collection,
  Node,
  Operation,
  OperationResult,
  SyncInstanceCreatePush,
} from '../../src/types/index.js';

const evidence = '[evidence:sync.operation-id-lifetime]';
const now = '2026-07-18T00:00:00Z';

type ResourceType = ServerIdReservation['resourceType'];
type Status = OperationResult['status'];
type Conflict = { readonly id: string };
type Audit = { readonly id: string };
type Outbox = { readonly id: string };

interface DurableState {
  ledger: Map<string, ResourceType>;
  business: string[];
  operations: Map<string, Operation>;
  pushReceipts: Map<string, StoredOperationReceipt<OperationResult>>;
  pushReceiptsBySequence: Map<string, StoredOperationReceipt<OperationResult>>;
  sessions: Map<string, SyncSessionRecord>;
  bootstrapLanes: Map<string, { nextSequence: number }>;
  aggregates: Map<string, SessionBootstrapCollectionAggregate>;
  bootstrapReceipts: Map<string, StoredSessionBootstrapReceipt>;
  bootstrapReceiptsByLane: Map<string, StoredSessionBootstrapReceipt>;
  sequenceLanes: Map<string, { nextSequence: number }>;
  sequenceReceipts: Map<string, StoredOperationReceipt<SequenceResult>>;
  cursors: string[];
  audits: Map<string, Audit>;
  outbox: Map<string, Outbox>;
  operationClaims: Map<string, any>;
  reuseAudits: Map<string, any>;
}

function emptyState(): DurableState {
  return {
    ledger: new Map(), business: [], operations: new Map(), pushReceipts: new Map(),
    pushReceiptsBySequence: new Map(), sessions: new Map(), bootstrapLanes: new Map(),
    aggregates: new Map(), bootstrapReceipts: new Map(), bootstrapReceiptsByLane: new Map(),
    sequenceLanes: new Map(), sequenceReceipts: new Map(),
    cursors: [], audits: new Map(), outbox: new Map(), operationClaims: new Map(), reuseAudits: new Map(),
  };
}

function copy<Value>(value: Value): Value {
  return structuredClone(value) as Value;
}

function reusePorts(draft: DurableState) {
  return {
    operationClaims: {
      load: async (id: string) => copy(draft.operationClaims.get(id)),
      save: async (claim: any) => { draft.operationClaims.set(claim.operationId, copy(claim)); },
    },
    reuseAudits: {
      append: async (audit: any) => { const key = `reuse-${draft.reuseAudits.size + 1}`; draft.reuseAudits.set(key, copy(audit)); return key; },
      load: async (key: string) => copy(draft.reuseAudits.get(key)),
    },
  };
}

function pushSequenceKey(receipt: Pick<StoredOperationReceipt<unknown>, 'replicaId' | 'sequenceScope' | 'sequence'>): string {
  return JSON.stringify([receipt.replicaId, receipt.sequenceScope, receipt.sequence]);
}

function bootstrapLaneKey(lane: SessionBootstrapLane): string {
  return JSON.stringify([lane.replicaId, lane.sessionId, 1]);
}

function bootstrapSequenceLaneKey(lane: SessionBootstrapSequenceLane): string {
  return lane.scope === 'instance'
    ? JSON.stringify(['instance', lane.replicaId, lane.sessionId])
    : JSON.stringify(['collection', lane.replicaId, lane.collectionId]);
}

type SequenceResult = Readonly<Record<string, unknown>> & { readonly status: Status };

function sequenceLaneKey(lane: SequenceLaneKey): string {
  return JSON.stringify([lane.replicaId, lane.sequenceScope]);
}

function sequenceReceiptKey(lane: SequenceLaneKey, sequence: number): string {
  return JSON.stringify([lane.replicaId, lane.sequenceScope, sequence]);
}

class SharedStagedDurableBackend {
  state = emptyState();
  queue: Promise<void> = Promise.resolve();
  reservationCalls: ServerIdReservation[][] = [];
  commitUnknownOnce = false;

  run<Transaction, Value>(
    createTransaction: (draft: DurableState) => Transaction,
    work: (transaction: Transaction) => Promise<Value>,
  ): Promise<Value> {
    const execute = async (): Promise<Value> => {
      const draft = copy(this.state);
      const result = await work(createTransaction(draft));
      this.state = draft;
      if (this.commitUnknownOnce) {
        this.commitUnknownOnce = false;
        throw new Error('commit outcome unknown');
      }
      return result;
    };
    const result = this.queue.then(execute, execute);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}

type LedgerOverride = (
  reservations: readonly ServerIdReservation[],
) => Promise<ServerIdReservationResult> | ServerIdReservationResult;

function reservationStore(
  backend: SharedStagedDurableBackend,
  draft: DurableState,
  override?: LedgerOverride,
): ServerIdReservationStore {
  return {
    reserveAll: ((reservations: readonly ServerIdReservation[]) => {
      backend.reservationCalls.push(copy([...reservations]));
      if (override !== undefined) return override(reservations);
      const duplicate = reservations.find(({ id }) => draft.ledger.has(id));
      if (duplicate !== undefined) {
        return Promise.resolve({
          state: 'conflict',
          conflict: {
            requested: copy(duplicate),
            existing: { id: duplicate.id, resourceType: draft.ledger.get(duplicate.id)! },
          },
        });
      }
      reservations.forEach(({ id, resourceType }) => draft.ledger.set(id, resourceType));
      return Promise.resolve({ state: 'reserved' });
    }) as ServerIdReservationStore['reserveAll'],
  };
}

interface PushTestTransaction extends SyncTransaction<Operation, OperationResult, Conflict, Audit, Outbox> {
  putBusiness(value: string): Promise<void>;
}

class PushHandle implements SyncUnitOfWork<Operation, OperationResult, Conflict, Audit, Outbox, PushTestTransaction> {
  readonly operationIdReservationOwner = 'push' as const;
  preflightCount = 0;
  applyCount = 0;
  failApply = false;

  constructor(
    readonly backend: SharedStagedDurableBackend,
    readonly ledgerOverride?: LedgerOverride,
  ) {}

  execute<Value>(work: (transaction: PushTestTransaction) => Promise<Value>): Promise<Value> {
    return this.backend.run((draft) => this.transaction(draft), work);
  }

  private transaction(draft: DurableState): PushTestTransaction {
    return {
      ...reusePorts(draft),
      idReservations: reservationStore(this.backend, draft, this.ledgerOverride),
      receipts: {
        findByOperationId: async (id) => copy(draft.pushReceipts.get(id)),
        findBySequence: async (replicaId, sequenceScope, sequence) => copy(
          draft.pushReceiptsBySequence.get(JSON.stringify([replicaId, sequenceScope, sequence])),
        ),
        save: async (receipt) => {
          draft.pushReceipts.set(receipt.operationId, copy(receipt));
          draft.pushReceiptsBySequence.set(pushSequenceKey(receipt), copy(receipt));
        },
      },
      putBusiness: async (value) => { draft.business.push(value); },
      appendOperation: async (operation) => { draft.operations.set(operation.opId, copy(operation)); },
      saveConflict: async () => undefined,
      allocateCursor: async () => {
        const cursor = `cursor-${draft.cursors.length + 1}`;
        draft.cursors.push(cursor);
        return cursor;
      },
      appendAudit: async (audit) => { draft.audits.set(audit.id, copy(audit)); },
      appendOutbox: async (message) => { draft.outbox.set(message.id, copy(message)); },
    };
  }
}

class SequenceHandle implements SequenceCoordinatorUnitOfWork<SequenceResult> {
  readonly operationIdReservationOwner = 'sequence' as const;
  evaluateCount = 0;

  constructor(
    readonly backend: SharedStagedDurableBackend,
    readonly ledgerOverride?: LedgerOverride,
  ) {}

  execute<Value>(
    _lane: SequenceLaneKey,
    work: (transaction: SequenceCoordinatorTransaction<SequenceResult>) => Promise<Value>,
  ): Promise<Value> {
    return this.backend.run((draft) => this.transaction(draft), work);
  }

  private transaction(draft: DurableState): SequenceCoordinatorTransaction<SequenceResult> {
    return {
      ...reusePorts(draft),
      idReservations: reservationStore(this.backend, draft, this.ledgerOverride),
      loadLaneState: async (lane) => copy(draft.sequenceLanes.get(sequenceLaneKey(lane))),
      saveLaneState: async (lane, state) => { draft.sequenceLanes.set(sequenceLaneKey(lane), copy(state)); },
      receipts: {
        load: async (lane, sequence) => copy(draft.sequenceReceipts.get(sequenceReceiptKey(lane, sequence))),
        save: async (receipt, condition) => {
          const key = sequenceReceiptKey(receipt, receipt.sequence);
          const current = draft.sequenceReceipts.get(key);
          assertSequenceCondition(current, condition);
          draft.sequenceReceipts.set(key, copy(receipt));
        },
      },
    };
  }
}

function assertSequenceCondition(
  current: StoredOperationReceipt<SequenceResult> | undefined,
  condition: SequenceReceiptWriteCondition,
): void {
  if (condition.kind === 'absent') {
    if (current !== undefined) throw new Error('sequence receipt already exists');
    return;
  }
  if (current?.status !== 'deferred' || current.digest !== condition.digest) {
    throw new Error('deferred Sequence receipt precondition failed');
  }
}

function sequenceRequest(overrides: Partial<SequenceOperationRequest> = {}): SequenceOperationRequest {
  return {
    operationId: 'sequence-operation', replicaId: 'replica-1', sequenceScope: 'collection-1',
    sequence: 1, digest: 'digest-sequence-operation', ...overrides,
  };
}

async function sequence(
  handle: SequenceHandle,
  request = sequenceRequest(),
  status: Status = 'applied',
) {
  return coordinateSequenceOperation(handle, request, async () => {
    handle.evaluateCount += 1;
    return { status, result: { status, value: `${status}-${request.operationId}` } as SequenceResult };
  });
}

function operation(
  operationId = 'operation-1',
  replicaId = 'replica-1',
  sequence = 1,
): Operation {
  return {
    opId: operationId,
    replicaId,
    sequence,
    type: 'delete_node',
    occurredAt: now,
    collectionId: 'collection-1',
    targetId: `node-${sequence}`,
    baseRevision: `revision-${sequence}`,
    payload: {},
  };
}

function pushRequest(options: {
  operationId?: string;
  replicaId?: string;
  sequenceScope?: string;
  sequence?: number;
  digest?: string;
  atomic?: boolean;
} = {}): PushTransactionRequest {
  const op = operation(options.operationId, options.replicaId, options.sequence);
  return {
    batchId: `batch-${op.replicaId}-${options.sequenceScope ?? 'collection-1'}-${op.sequence}`,
    atomic: options.atomic ?? false,
    serverCursor: 'cursor-0',
    operations: [{
      operation: op,
      sequenceScope: options.sequenceScope ?? 'collection-1',
      digest: options.digest ?? `digest-${op.opId}`,
    }],
  };
}

function pushPlan(
  handle: PushHandle,
  request: PushTransactionRequest,
  status: Status = 'applied',
): PushPreparedOperation<PushTestTransaction, Conflict, Audit, Outbox> {
  const op = request.operations[0]!.operation;
  const base = { opId: op.opId, sequence: op.sequence, warnings: [] as const };
  const apply = async (transaction: PushTestTransaction) => {
    handle.applyCount += 1;
    if (handle.failApply) throw new Error('injected business failure');
    if (status === 'applied' || status === 'rebased') await transaction.putBusiness(`business-${op.opId}`);
    switch (status) {
      case 'applied': return { ...base, status, revision: `revision-${op.opId}` };
      case 'rebased': return { ...base, status, revision: `revision-${op.opId}`, transform: {} };
      case 'noop': return { ...base, status };
      case 'rejected': return { ...base, status, code: 'policy_denied' };
      case 'deferred': return { ...base, status, code: 'dependency_pending' };
      case 'conflicted': return {
        result: { ...base, status, conflictId: `conflict-${op.opId}` },
        conflict: { id: `conflict-${op.opId}` },
      };
    }
  };
  if (status === 'deferred') return { status, apply } as PushPreparedOperation<PushTestTransaction, Conflict, Audit, Outbox>;
  const audit = async () => ({ id: `audit-${op.opId}` });
  if (status === 'noop' || status === 'rejected') {
    return { status, apply, audit } as PushPreparedOperation<PushTestTransaction, Conflict, Audit, Outbox>;
  }
  return {
    status,
    apply,
    audit,
    outbox: async () => ({ id: `outbox-${op.opId}` }),
  } as PushPreparedOperation<PushTestTransaction, Conflict, Audit, Outbox>;
}

async function push(handle: PushHandle, request = pushRequest(), status: Status = 'applied') {
  return coordinatePushTransaction(handle, request, async () => {
    handle.preflightCount += 1;
    return pushPlan(handle, request, status);
  });
}

class BootstrapHandle implements SessionBootstrapUnitOfWork<Audit, Outbox> {
  readonly operationIdReservationOwner = 'session-bootstrap' as const;
  prepareCount = 0;
  applyCount = 0;
  failApply = false;
  identity: SessionBootstrapIdentity = {
    collectionId: 'collection-generated',
    rootNodeId: 'root-generated',
    revision: 'revision-generated',
  };

  constructor(
    readonly backend: SharedStagedDurableBackend,
    readonly ledgerOverride?: LedgerOverride,
  ) {}

  execute<Value>(
    _lane: SessionBootstrapLane,
    work: (transaction: SessionBootstrapTransaction<Audit, Outbox>) => Promise<Value>,
  ): Promise<Value> {
    return this.backend.run((draft) => this.transaction(draft), work);
  }

  private transaction(draft: DurableState): SessionBootstrapTransaction<Audit, Outbox> {
    const artifacts = <Artifact extends { readonly id: string }>(target: Map<string, Artifact>) => ({
      append: async (artifact: Artifact) => { target.set(artifact.id, copy(artifact)); return artifact.id; },
      load: async (key: string) => copy(target.get(key)),
    });
    return {
      ...reusePorts(draft),
      idReservations: reservationStore(this.backend, draft, this.ledgerOverride),
      receipts: {
        findByOperationId: async (id) => copy(draft.bootstrapReceipts.get(id)),
        findByLane: async (lane) => copy(draft.bootstrapReceiptsByLane.get(bootstrapLaneKey(lane))),
        save: async (receipt, condition) => {
          const current = draft.bootstrapReceiptsByLane.get(bootstrapLaneKey(receipt));
          if (condition.kind === 'absent' && current !== undefined) throw new Error('receipt already exists');
          if (condition.kind === 'replace_deferred'
            && (current?.status !== 'deferred' || current.digest !== condition.digest)) {
            throw new Error('deferred receipt precondition failed');
          }
          draft.bootstrapReceipts.set(receipt.operationId, copy(receipt));
          draft.bootstrapReceiptsByLane.set(bootstrapLaneKey(receipt), copy(receipt));
        },
      },
      sessions: {
        load: async (id) => copy(draft.sessions.get(id)),
        save: async (session, expected) => {
          if (expected.status !== 'active' || expected.sessionScope !== 'instance'
            || expected.collectionId !== null || !isDeepStrictEqual(draft.sessions.get(session.sessionId), expected)) {
            throw new Error('bootstrap Session write condition failed');
          }
          draft.sessions.set(session.sessionId, copy(session));
        },
      },
      lanes: {
        load: async (lane) => copy(draft.bootstrapLanes.get(bootstrapSequenceLaneKey(lane))),
        save: async (lane, state) => { draft.bootstrapLanes.set(bootstrapSequenceLaneKey(lane), copy(state)); },
      },
      collections: {
        load: async (id) => copy(draft.aggregates.get(id)),
        save: async (aggregate) => { draft.aggregates.set(aggregate.collection.id, copy(aggregate)); },
      },
      operations: {
        load: async (id) => copy(draft.operations.get(id)),
        append: async (op) => { draft.operations.set(op.opId, copy(op)); },
      },
      audits: artifacts(draft.audits),
      outbox: artifacts(draft.outbox),
      allocateIdentity: async () => copy(this.identity),
      allocateCursor: async () => {
        const cursor = `cursor-${draft.cursors.length + 1}`;
        draft.cursors.push(cursor);
        return cursor;
      },
      loadCursor: async (cursor) => draft.cursors.includes(cursor) ? cursor : undefined,
    } as SessionBootstrapTransaction<Audit, Outbox>;
  }
}

function activeSession(sessionId = 'session-unbound'): ActiveSyncSessionRecord {
  return {
    sessionId,
    principal: { type: 'user', id: 'alice' },
    credential: { kind: 'token', id: 'token-1' },
    oauthClientId: 'client-1',
    origin: 'https://client.example',
    sessionScope: 'instance',
    protocolVersion: '0.1',
    collectionId: null,
    purpose: 'create_collection',
    authorizationScopes: ['collections:create', 'sync:bootstrap', 'sync:push'],
    status: 'active',
  };
}

function bootstrapOperation(
  operationId = 'bootstrap-operation',
  replicaId = 'replica-1',
): SyncInstanceCreatePush['operations'][0] {
  return {
    opId: operationId,
    replicaId,
    sequence: 1,
    type: 'create_collection',
    occurredAt: now,
    dependencies: [],
    baseRevision: null,
    payload: {
      collection: {
        kind: 'knowledge_collection', title: 'Lifetime Test', summary: 'Operation ID fixture.',
        visibility: 'private',
        publication: { feedMode: 'release', includeNodeContent: 'summary', includeRelations: true },
        extensions: {},
      },
      root: { title: 'Lifetime Test', folderRole: 'root', extensions: {} },
    },
    source: { adapterProfile: 'test-fixture', nativeEvent: 'bootstrap' },
  };
}

function bootstrapRequest(options: {
  operationId?: string;
  replicaId?: string;
  sessionId?: string;
  digest?: string;
  reevaluateDeferred?: boolean;
} = {}): SessionBootstrapRequest {
  const sessionId = options.sessionId ?? 'session-unbound';
  const op = bootstrapOperation(options.operationId, options.replicaId);
  return {
    push: { sessionId, batchId: `batch-${sessionId}`, atomic: true, operations: [op] },
    digest: options.digest ?? `digest-${op.opId}`,
    ...(options.reevaluateDeferred === undefined ? {} : { reevaluateDeferred: options.reevaluateDeferred }),
    rejectedAt: now,
  };
}

function aggregate(identity: SessionBootstrapIdentity): SessionBootstrapCollectionAggregate {
  const collection: Collection = {
    schemaVersion: '0.1', id: identity.collectionId, kind: 'knowledge_collection', title: 'Lifetime Test',
    summary: 'Operation ID fixture.', rootNodeId: identity.rootNodeId, visibility: 'private', createdAt: now,
    updatedAt: now, revision: identity.revision, extensions: {},
  };
  const root: Node = {
    id: identity.rootNodeId, collectionId: identity.collectionId, kind: 'root', parentId: null,
    position: null, folderRole: 'root', title: 'Lifetime Test', createdAt: now, updatedAt: now,
    revision: identity.revision, constraints: { readOnly: false, reason: null }, extensions: {},
  };
  return { collection, root };
}

function bootstrapPlan(
  handle: BootstrapHandle,
  request: SessionBootstrapRequest,
  status: 'applied' | 'deferred' | 'rejected' = 'applied',
): SessionBootstrapPrepared<Audit, Outbox, SessionBootstrapTransaction<Audit, Outbox>> {
  const op = request.push.operations[0]!;
  if (status === 'deferred') return {
    status,
    apply: async () => {
      handle.applyCount += 1;
      if (handle.failApply) throw new Error('injected bootstrap business failure');
      return { opId: op.opId, sequence: 1, status, code: 'pending', warnings: [] };
    },
  };
  if (status === 'rejected') return {
    status,
    apply: async () => {
      handle.applyCount += 1;
      if (handle.failApply) throw new Error('injected bootstrap business failure');
      return { opId: op.opId, sequence: 1, status, code: 'denied', warnings: [] };
    },
    audit: async () => ({ id: `audit-${op.opId}` }),
  };
  return {
    status,
    warnings: [],
    apply: async (_transaction, identity) => {
      handle.applyCount += 1;
      if (handle.failApply) throw new Error('injected bootstrap business failure');
      return aggregate(identity);
    },
    audit: async () => ({ id: `audit-${op.opId}` }),
    outbox: async () => ({ id: `outbox-${op.opId}` }),
  };
}

async function bootstrap(
  handle: BootstrapHandle,
  request = bootstrapRequest(),
  status: 'applied' | 'deferred' | 'rejected' = 'applied',
) {
  if (!handle.backend.state.sessions.has(request.push.sessionId)) {
    handle.backend.state.sessions.set(request.push.sessionId, activeSession(request.push.sessionId));
  }
  return coordinateSessionBootstrap(handle, request, async () => {
    handle.prepareCount += 1;
    return bootstrapPlan(handle, request, status);
  });
}

function expectSingleOperationReservation(backend: SharedStagedDurableBackend, id: string): void {
  expect(backend.reservationCalls).toEqual([[{ resourceType: 'operation', id }]]);
  expect(backend.state.ledger.get(id)).toBe('operation');
}

describe(`SYNC-0012 server-lifetime Operation IDs ${evidence}`, () => {
  it.each(['applied', 'rebased', 'noop', 'conflicted', 'rejected', 'deferred'] as const)(
    `atomically reserves the first normal %s Operation as resourceType operation ${evidence}`,
    async (status) => {
      const backend = new SharedStagedDurableBackend();
      const handle = new PushHandle(backend);
      await push(handle, pushRequest(), status);
      expectSingleOperationReservation(backend, 'operation-1');
    },
  );

  it.each(['applied', 'deferred', 'rejected'] as const)(
    `atomically reserves the first unbound bootstrap %s Operation as resourceType operation ${evidence}`,
    async (status) => {
      const backend = new SharedStagedDurableBackend();
      await bootstrap(new BootstrapHandle(backend), bootstrapRequest(), status);
      expectSingleOperationReservation(backend, 'bootstrap-operation');
    },
  );

  it(`replays every exact normal terminal receipt without reserving or applying again ${evidence}`, async () => {
    for (const status of ['applied', 'rebased', 'noop', 'conflicted', 'rejected'] as const) {
      const backend = new SharedStagedDurableBackend();
      const first = new PushHandle(backend);
      const request = pushRequest();
      const original = await push(first, request, status);
      const restarted = new PushHandle(backend);
      const authoritativeCursor = 'cursor-authoritative-after-restart';
      const replay = await push(restarted, { ...request, serverCursor: authoritativeCursor }, status);
      expect(replay.results).toEqual(original.results);
      expect([original.serverCursor, authoritativeCursor]).toContain(replay.serverCursor);
      expect(backend.reservationCalls).toHaveLength(1);
      expect(restarted.applyCount).toBe(0);
    }
  });

  it(`replays an unchanged deferred receipt without reevaluateDeferred ${evidence}`, async () => {
    // Without the explicit reevaluateDeferred opt-in, a stored deferred Push
    // receipt replays exactly — the preflight never runs again (F012).
    const backend = new SharedStagedDurableBackend();
    const request = pushRequest();
    const first = await push(new PushHandle(backend), request, 'deferred');
    const restarted = new PushHandle(backend);
    const replay = await push(restarted, request, 'deferred');
    expect(replay.results).toEqual(first.results);
    expect(backend.reservationCalls).toHaveLength(1);
    expect(restarted.preflightCount).toBe(0);
    expect(restarted.applyCount).toBe(0);
  });

  it(`re-evaluates a deferred receipt to terminal under reevaluateDeferred ${evidence}`, async () => {
    const backend = new SharedStagedDurableBackend();
    const request = pushRequest();
    await push(new PushHandle(backend), request, 'deferred');
    const reevaluator = new PushHandle(backend);
    const reevaluated = await push(
      reevaluator,
      { ...request, reevaluateDeferred: true },
      'applied',
    );
    expect(reevaluated.results[0]!.status).toBe('applied');
    expect(backend.reservationCalls).toHaveLength(1);
    expect(reevaluator.preflightCount).toBe(1);
    expect(reevaluator.applyCount).toBe(1);
  });

  it(`replays exact applied deferred and rejected bootstrap receipts without reserving again ${evidence}`, async () => {
    for (const status of ['applied', 'deferred', 'rejected'] as const) {
      const backend = new SharedStagedDurableBackend();
      const request = bootstrapRequest();
      const first = await bootstrap(new BootstrapHandle(backend), request, status);
      const restarted = new BootstrapHandle(backend);
      const replay = await bootstrap(restarted, request, status);
      expect(replay).toMatchObject({ kind: 'replayed' });
      expect(replay).toEqual({ kind: 'replayed', result: first.kind === 'executed' ? first.result : undefined });
      expect(backend.reservationCalls).toHaveLength(1);
      expect(restarted.prepareCount).toBe(0);
      expect(restarted.applyCount).toBe(0);
    }
  });

  it(`reserves the first normal Sequence operation and exact replay does not reserve or evaluate again ${evidence}`, async () => {
    const backend = new SharedStagedDurableBackend();
    const request = sequenceRequest();
    await sequence(new SequenceHandle(backend), request, 'applied');
    const restarted = new SequenceHandle(backend);
    const replay = await sequence(restarted, request, 'applied');
    expect(replay).toMatchObject({ kind: 'replayed', receipt: { status: 'applied' } });
    expect(backend.reservationCalls).toHaveLength(1);
    expect(restarted.evaluateCount).toBe(0);
  });

  it(`reuses the first normal deferred reservation during terminal reevaluation ${evidence}`, async () => {
    const backend = new SharedStagedDurableBackend();
    await sequence(new SequenceHandle(backend), sequenceRequest(), 'deferred');
    const reevaluator = new SequenceHandle(backend);
    const result = await sequence(
      reevaluator,
      sequenceRequest({ reevaluateDeferred: true }),
      'applied',
    );
    expect(result).toMatchObject({ kind: 'executed', receipt: { status: 'applied' } });
    expect(backend.reservationCalls).toHaveLength(1);
    expect(reevaluator.evaluateCount).toBe(1);
  });

  it(`reuses the first bootstrap deferred reservation during explicit terminal reevaluation ${evidence}`, async () => {
    const backend = new SharedStagedDurableBackend();
    await bootstrap(new BootstrapHandle(backend), bootstrapRequest(), 'deferred');
    const reevaluator = new BootstrapHandle(backend);
    const request = bootstrapRequest({ reevaluateDeferred: true });
    const result = await bootstrap(reevaluator, request, 'applied');
    expect(result).toMatchObject({ kind: 'executed', result: { status: 'applied' } });
    expect(backend.reservationCalls).toHaveLength(1);
    expect(reevaluator.applyCount).toBe(1);
  });

  it.each([
    ['different Replica', pushRequest({ replicaId: 'replica-a' }), pushRequest({ replicaId: 'replica-b', sequence: 7 })],
    ['different Collection scope', pushRequest({ sequenceScope: 'collection-a' }), pushRequest({ sequenceScope: 'collection-b', sequence: 9 })],
    ['Collection to Instance scope', pushRequest({ sequenceScope: 'collection-a' }), pushRequest({ sequenceScope: 'session-unbound', replicaId: 'replica-b' })],
  ] as const)(`does not newly accept one opId in a %s normal lane ${evidence}`, async (_label, first, second) => {
    const backend = new SharedStagedDurableBackend();
    await push(new PushHandle(backend), first);
    const collision = new PushHandle(backend);
    await expect(push(collision, second)).rejects.toBeInstanceOf(TypeError);
    expect(collision.applyCount).toBe(0);
  });

  it(`does not newly accept a normal opId through an unbound bootstrap path ${evidence}`, async () => {
    const backend = new SharedStagedDurableBackend();
    await push(new PushHandle(backend), pushRequest({ operationId: 'cross-path' }));
    const collision = new BootstrapHandle(backend);
    await expect(bootstrap(collision, bootstrapRequest({
      operationId: 'cross-path', replicaId: 'replica-other', sessionId: 'session-other',
    }))).rejects.toBeInstanceOf(TypeError);
    expect(collision.prepareCount).toBe(0);
    expect(collision.applyCount).toBe(0);
  });

  it(`does not newly accept an unbound bootstrap opId through a normal path ${evidence}`, async () => {
    const backend = new SharedStagedDurableBackend();
    await bootstrap(new BootstrapHandle(backend), bootstrapRequest({ operationId: 'cross-path' }));
    const collision = new PushHandle(backend);
    await expect(push(collision, pushRequest({
      operationId: 'cross-path', replicaId: 'replica-other', sequenceScope: 'collection-other',
    }))).rejects.toBeInstanceOf(TypeError);
    expect(collision.applyCount).toBe(0);
  });

  it(`does not newly accept one opId across two unbound Instance Sessions ${evidence}`, async () => {
    const backend = new SharedStagedDurableBackend();
    await bootstrap(new BootstrapHandle(backend), bootstrapRequest({
      operationId: 'instance-collision', sessionId: 'session-a',
    }));
    const collision = new BootstrapHandle(backend);
    await expect(bootstrap(collision, bootstrapRequest({
      operationId: 'instance-collision', replicaId: 'replica-b', sessionId: 'session-b',
    }))).rejects.toBeInstanceOf(TypeError);
    expect(collision.prepareCount).toBe(0);
    expect(collision.applyCount).toBe(0);
  });

  it(`does not invoke the normal Sequence evaluator when another lane owns the opId ${evidence}`, async () => {
    const backend = new SharedStagedDurableBackend();
    await sequence(new SequenceHandle(backend), sequenceRequest({ operationId: 'lane-collision' }));
    const collision = new SequenceHandle(backend);
    await expect(sequence(collision, sequenceRequest({
      operationId: 'lane-collision', replicaId: 'replica-b', sequenceScope: 'collection-b',
    }))).rejects.toBeInstanceOf(TypeError);
    expect(collision.evaluateCount).toBe(0);
  });

  it(`rejects duplicate opIds inside one atomic batch without any durable or business write ${evidence}`, async () => {
    const backend = new SharedStagedDurableBackend();
    const handle = new PushHandle(backend);
    const base = pushRequest({ atomic: true });
    const candidate: PushTransactionRequest = { ...base, operations: [
      base.operations[0]!,
      { operation: operation('operation-1', 'replica-2', 1), sequenceScope: 'collection-2', digest: 'digest-2' },
    ] };
    await expect(coordinatePushTransaction(handle, candidate, async (item) => {
      handle.preflightCount += 1;
      return pushPlan(handle, { ...candidate, operations: [item] as PushTransactionRequest['operations'] });
    })).rejects.toBeInstanceOf(SyncOperationReuseError);
    expect(backend.state.ledger).toEqual(new Map());
    expect(backend.state.business).toEqual([]);
    expect(backend.state.reuseAudits.size).toBe(1);
    expect(handle.preflightCount).toBe(0);
    expect(handle.applyCount).toBe(0);
  });

  it(`rolls back every new atomic item when one durable opId collides before preflight ${evidence}`, async () => {
    const backend = new SharedStagedDurableBackend();
    backend.state.ledger.set('already-owned', 'node');
    const handle = new PushHandle(backend);
    const base = pushRequest({ atomic: true, operationId: 'new-item' });
    const candidate: PushTransactionRequest = { ...base, operations: [
      base.operations[0]!,
      { operation: operation('already-owned', 'replica-2', 1), sequenceScope: 'collection-2', digest: 'digest-2' },
    ] };
    await expect(coordinatePushTransaction(handle, candidate, async (item) => {
      handle.preflightCount += 1;
      return pushPlan(handle, { ...candidate, operations: [item] as PushTransactionRequest['operations'] });
    })).rejects.toBeInstanceOf(ServerIdAlreadyReservedError);
    expect(backend.state.ledger.has('new-item')).toBe(false);
    expect(backend.state.business).toEqual([]);
    expect(handle.preflightCount).toBe(0);
    expect(handle.applyCount).toBe(0);
  });

  it(`isolates a later non-atomic opId collision without rolling back the earlier operation ${evidence}`, async () => {
    const backend = new SharedStagedDurableBackend();
    const handle = new PushHandle(backend);
    const base = pushRequest({ operationId: 'shared-non-atomic' });
    const candidate: PushTransactionRequest = { ...base, operations: [
      base.operations[0]!,
      {
        operation: operation('shared-non-atomic', 'replica-2', 1),
        sequenceScope: 'collection-2',
        digest: 'digest-second',
      },
    ] };
    await expect(coordinatePushTransaction(handle, candidate, async (item) => {
      handle.preflightCount += 1;
      return pushPlan(handle, { ...candidate, operations: [item] as PushTransactionRequest['operations'] });
    })).rejects.toBeInstanceOf(SyncOperationReuseError);
    expect(backend.state.ledger.get('shared-non-atomic')).toBe('operation');
    expect(backend.state.business).toEqual(['business-shared-non-atomic']);
    expect(handle.preflightCount).toBe(1);
    expect(handle.applyCount).toBe(1);
  });

  it(`rolls back a Push reservation when pure preflight preparation fails ${evidence}`, async () => {
    const backend = new SharedStagedDurableBackend();
    const handle = new PushHandle(backend);
    await expect(coordinatePushTransaction(handle, pushRequest({ operationId: 'preflight-failure' }), async () => {
      throw new Error('preflight preparation failed');
    })).rejects.toThrow('preflight preparation failed');
    expect(backend.state.ledger.has('preflight-failure')).toBe(false);
    expect(backend.state.business).toEqual([]);
    expect(handle.applyCount).toBe(0);
  });

  it(`permits at most one durable owner across concurrent fresh normal handles ${evidence}`, async () => {
    const backend = new SharedStagedDurableBackend();
    const settled = await Promise.allSettled(Array.from({ length: 16 }, (_, index) => push(
      new PushHandle(backend),
      pushRequest({ replicaId: `replica-${index}`, sequenceScope: `collection-${index}` }),
    )));
    expect(settled.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter(({ status }) => status === 'rejected')).toHaveLength(15);
    expect(backend.state.ledger.get('operation-1')).toBe('operation');
    expect(backend.state.business).toHaveLength(1);
  });

  it(`permits at most one durable owner across concurrent normal and bootstrap handles ${evidence}`, async () => {
    const backend = new SharedStagedDurableBackend();
    const settled = await Promise.allSettled([
      push(new PushHandle(backend), pushRequest({ operationId: 'contended' })),
      bootstrap(new BootstrapHandle(backend), bootstrapRequest({
        operationId: 'contended', replicaId: 'replica-2', sessionId: 'session-2',
      })),
    ]);
    expect(settled.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter(({ status }) => status === 'rejected')).toHaveLength(1);
    expect(backend.state.ledger.get('contended')).toBe('operation');
  });

  it.each([
    ['CaseSensitive', 'casesensitive'],
    ['operation-A', 'operation-a'],
    ['ABC_123', 'abc_123'],
    ['UUID.V7', 'uuid.v7'],
  ])(`keeps case-sensitive opIds %s and %s distinct ${evidence}`, async (first, second) => {
    const backend = new SharedStagedDurableBackend();
    await push(new PushHandle(backend), pushRequest({ operationId: first }));
    await push(new PushHandle(backend), pushRequest({ operationId: second, replicaId: 'replica-2' }));
    expect(backend.state.ledger.has(first)).toBe(true);
    expect(backend.state.ledger.has(second)).toBe(true);
  });

  it.each([
    ['normal UUIDv7', '0190f2a6-7c00-7abc-8def-1234567890ab', 'normal'],
    ['normal legacy opaque', 'legacy.Operation_01~opaque', 'normal'],
    ['bootstrap UUIDv7', '0190f2a6-7c00-7abc-8def-1234567890ac', 'bootstrap'],
    ['bootstrap legacy opaque', 'Legacy.Bootstrap_01~opaque', 'bootstrap'],
  ] as const)(`accepts a valid %s opId without server-side UUIDv7 enforcement ${evidence}`, async (_label, id, path) => {
    const backend = new SharedStagedDurableBackend();
    if (path === 'normal') await push(new PushHandle(backend), pushRequest({ operationId: id }));
    else await bootstrap(new BootstrapHandle(backend), bootstrapRequest({ operationId: id }));
    expect(backend.state.ledger.get(id)).toBe('operation');
  });

  it(`releases only an uncommitted normal reservation when the transaction rolls back ${evidence}`, async () => {
    const backend = new SharedStagedDurableBackend();
    const failing = new PushHandle(backend);
    failing.failApply = true;
    await expect(push(failing, pushRequest({ operationId: 'retry-after-rollback' })))
      .rejects.toThrow('injected business failure');
    expect(backend.state.ledger.has('retry-after-rollback')).toBe(false);
    await expect(push(new PushHandle(backend), pushRequest({ operationId: 'retry-after-rollback' })))
      .resolves.toBeDefined();
  });

  it(`releases only an uncommitted bootstrap reservation when the transaction rolls back ${evidence}`, async () => {
    const backend = new SharedStagedDurableBackend();
    const failing = new BootstrapHandle(backend);
    failing.failApply = true;
    await expect(bootstrap(failing, bootstrapRequest({ operationId: 'retry-bootstrap' })))
      .rejects.toThrow('injected bootstrap business failure');
    expect(backend.state.ledger.has('retry-bootstrap')).toBe(false);
    await expect(bootstrap(new BootstrapHandle(backend), bootstrapRequest({ operationId: 'retry-bootstrap' })))
      .resolves.toMatchObject({ kind: 'executed' });
  });

  it(`keeps a committed normal reservation after Operation and receipt cleanup and restart ${evidence}`, async () => {
    const backend = new SharedStagedDurableBackend();
    await push(new PushHandle(backend), pushRequest({ operationId: 'permanent-normal' }));
    backend.state.operations.delete('permanent-normal');
    backend.state.pushReceipts.delete('permanent-normal');
    backend.state.pushReceiptsBySequence.clear();
    const fresh = new PushHandle(backend);
    await expect(push(fresh, pushRequest({ operationId: 'permanent-normal', replicaId: 'replica-2' })))
      .rejects.toBeInstanceOf(TypeError);
    expect(fresh.applyCount).toBe(0);
  });

  it(`keeps a committed bootstrap reservation after Operation and receipt cleanup and restart ${evidence}`, async () => {
    const backend = new SharedStagedDurableBackend();
    await bootstrap(new BootstrapHandle(backend), bootstrapRequest({ operationId: 'permanent-bootstrap' }));
    backend.state.operations.delete('permanent-bootstrap');
    backend.state.bootstrapReceipts.delete('permanent-bootstrap');
    backend.state.bootstrapReceiptsByLane.clear();
    const fresh = new PushHandle(backend);
    await expect(push(fresh, pushRequest({ operationId: 'permanent-bootstrap' })))
      .rejects.toBeInstanceOf(TypeError);
    expect(fresh.applyCount).toBe(0);
  });

  it(`does not report normal success on commit-unknown and reconciles retry through the receipt ${evidence}`, async () => {
    const backend = new SharedStagedDurableBackend();
    backend.commitUnknownOnce = true;
    const request = pushRequest({ operationId: 'unknown-normal' });
    await expect(push(new PushHandle(backend), request)).rejects.toThrow('commit outcome unknown');
    expect(backend.state.pushReceipts.has('unknown-normal')).toBe(true);
    const retry = new PushHandle(backend);
    await expect(push(retry, request)).resolves.toMatchObject({ results: [{ opId: 'unknown-normal' }] });
    expect(retry.applyCount).toBe(0);
    expect(backend.reservationCalls).toHaveLength(1);
  });

  it(`does not report bootstrap success on commit-unknown and reconciles retry through the receipt ${evidence}`, async () => {
    const backend = new SharedStagedDurableBackend();
    backend.commitUnknownOnce = true;
    const request = bootstrapRequest({ operationId: 'unknown-bootstrap' });
    await expect(bootstrap(new BootstrapHandle(backend), request)).rejects.toThrow('commit outcome unknown');
    expect(backend.state.bootstrapReceipts.has('unknown-bootstrap')).toBe(true);
    const retry = new BootstrapHandle(backend);
    await expect(bootstrap(retry, request)).resolves.toMatchObject({ kind: 'replayed' });
    expect(retry.prepareCount).toBe(0);
    expect(backend.reservationCalls).toHaveLength(1);
  });

  it.each(['collection', 'node', 'annotation', 'attachment', 'relation', 'event'] as const)(
    `fails closed on a collision with server-lifetime resource type %s before business writes ${evidence}`,
    async (resourceType) => {
      const backend = new SharedStagedDurableBackend();
      backend.state.ledger.set('cross-resource', resourceType);
      const handle = new PushHandle(backend);
      await expect(push(handle, pushRequest({ operationId: 'cross-resource' }))).rejects.toMatchObject({
        name: 'ServerIdAlreadyReservedError',
        code: 'server_id_already_reserved',
        conflict: {
          requested: { id: 'cross-resource', resourceType: 'operation' },
          existing: { id: 'cross-resource', resourceType },
        },
      });
      expect(handle.preflightCount).toBe(0);
      expect(handle.applyCount).toBe(0);
      expect(backend.state.business).toEqual([]);
      expect(backend.state.operations).toEqual(new Map());
    },
  );

  it.each([
    ['undefined result', () => undefined],
    ['null result', () => null],
    ['unknown state', () => ({ state: 'maybe' })],
    ['reserved result with extra member', () => ({ state: 'reserved', extra: true })],
    ['mismatched requested ID', () => ({ state: 'conflict', conflict: {
      requested: { id: 'other-id', resourceType: 'operation' },
      existing: { id: 'other-id', resourceType: 'node' },
    } })],
    ['mismatched existing ID', (id: string) => ({ state: 'conflict', conflict: {
      requested: { id, resourceType: 'operation' },
      existing: { id: 'other-id', resourceType: 'node' },
    } })],
    ['accessor result', () => Object.defineProperty({}, 'state', { enumerable: true, get: () => 'reserved' })],
    ['symbol result', () => ({ state: 'reserved', [Symbol('hidden')]: true })],
  ] as const)(`rejects a malformed durable ledger %s and rolls back ${evidence}`, async (_label, resultFactory) => {
    const backend = new SharedStagedDurableBackend();
    const request = pushRequest({ operationId: 'malformed-ledger' });
    const handle = new PushHandle(backend, async (reservations) => (
      (resultFactory as (id: string) => unknown)(reservations[0]!.id) as unknown as ServerIdReservationResult
    ));
    await expect(push(handle, request)).rejects.toBeInstanceOf(TypeError);
    expect(handle.applyCount).toBe(0);
    expect(backend.state.ledger).toEqual(new Map());
    expect(backend.state.business).toEqual([]);
  });

  it(`rejects a non-Promise normal reservation port before business writes ${evidence}`, async () => {
    const backend = new SharedStagedDurableBackend();
    const handle = new PushHandle(backend, (() => ({ state: 'reserved' })) as LedgerOverride);
    await expect(push(handle)).rejects.toThrow('native Promise');
    expect(handle.applyCount).toBe(0);
    expect(backend.state).toEqual(emptyState());
  });

  it(`rejects a non-Promise bootstrap reservation port before prepare or business writes ${evidence}`, async () => {
    const backend = new SharedStagedDurableBackend();
    const handle = new BootstrapHandle(backend, (() => ({ state: 'reserved' })) as LedgerOverride);
    await expect(bootstrap(handle)).rejects.toThrow('native Promise');
    expect(handle.prepareCount).toBe(0);
    expect(handle.applyCount).toBe(0);
  });

  it(`snapshots a normal opId before caller mutation and reserves only the original ${evidence}`, async () => {
    const backend = new SharedStagedDurableBackend();
    const handle = new PushHandle(backend);
    const request = pushRequest({ operationId: 'original-id' });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const pending = coordinatePushTransaction(handle, request, async () => {
      await gate;
      return pushPlan(handle, pushRequest({ operationId: 'original-id' }));
    });
    (request.operations[0]!.operation as unknown as { opId: string }).opId = 'caller-mutated';
    release();
    await pending;
    expect(backend.state.ledger.get('original-id')).toBe('operation');
    expect(backend.state.ledger.has('caller-mutated')).toBe(false);
  });

  it(`rejects an opId accessor without invoking it or entering durable work ${evidence}`, async () => {
    const backend = new SharedStagedDurableBackend();
    const handle = new PushHandle(backend);
    const request = pushRequest();
    const getter = vi.fn(() => 'accessor-id');
    Object.defineProperty(request.operations[0]!.operation, 'opId', { enumerable: true, get: getter });
    await expect(push(handle, request)).rejects.toBeInstanceOf(TypeError);
    expect(getter).not.toHaveBeenCalled();
    expect(backend.reservationCalls).toEqual([]);
  });

  it(`rejects a symbol-bearing bootstrap Operation before reservation or prepare ${evidence}`, async () => {
    const backend = new SharedStagedDurableBackend();
    const handle = new BootstrapHandle(backend);
    const request = bootstrapRequest();
    Object.defineProperty(request.push.operations[0]!, Symbol('hidden'), { enumerable: true, value: true });
    await expect(bootstrap(handle, request)).rejects.toBeInstanceOf(TypeError);
    expect(backend.reservationCalls).toEqual([]);
    expect(handle.prepareCount).toBe(0);
  });

  it(`uses the shared reservation helper and typed error exported by the Sync API ${evidence}`, async () => {
    const backend = new SharedStagedDurableBackend();
    backend.state.ledger.set('shared-helper', 'node');
    const draft = copy(backend.state);
    const transaction = { idReservations: reservationStore(backend, draft) };
    await expect(reserveServerIds(transaction, [{ resourceType: 'operation', id: 'shared-helper' }]))
      .rejects.toBeInstanceOf(ServerIdAlreadyReservedError);
  });

  it(`types Push Sequence and bootstrap as alternative operation-id ownership boundaries ${evidence}`, () => {
    expectTypeOf<PushHandle>().not.toMatchTypeOf<SequenceCoordinatorUnitOfWork<SequenceResult>>();
    expectTypeOf<SequenceHandle>().not.toMatchTypeOf<SyncUnitOfWork<Operation, OperationResult, Conflict, Audit, Outbox, PushTestTransaction>>();
    expectTypeOf<BootstrapHandle>().not.toMatchTypeOf<SequenceCoordinatorUnitOfWork<SequenceResult>>();
    expectTypeOf<PurePushPreflight<PushTestTransaction, Conflict, Audit, Outbox>>()
      .parameters.toEqualTypeOf<[PushTransactionOperation, number, (PushPreflightContext | undefined)?]>();
  });
});
