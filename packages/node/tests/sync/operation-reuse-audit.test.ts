import { isDeepStrictEqual } from 'node:util';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import {
  SyncOperationReuseError as ReuseErrorFromSyncEntry,
  coordinateSessionBootstrap as bootstrapFromSyncEntry,
} from '../../src/sync/index.js';
import {
  coordinatePushTransaction as pushFromSyncEntry,
  coordinateSequenceOperation as sequenceFromSyncEntry,
} from '../../src/sync/unsafe.js';
import {
  coordinatePushTransaction,
  coordinateSequenceOperation,
} from '../../src/sync/unsafe.js';
import {
  SyncOperationReuseError,
  appendSyncOperationReuseAudit,
  claimSyncOperation,
  coordinateSessionBootstrap,
  immutableSyncOperationClaim,
  syncOperationClaimsMatch,
  type ActiveSyncSessionRecord,
  type PushPreparedOperation,
  type PushTransactionRequest,
  type SequenceCoordinatorTransaction,
  type SequenceCoordinatorUnitOfWork,
  type SequenceLaneKey,
  type SequenceOperationRequest,
  type SequenceReceiptWriteCondition,
  type ServerIdReservation,
  type ServerIdReservationResult,
  type ServerIdReservationStore,
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
  type SyncOperationClaim,
  type SyncOperationReuseAudit,
  type SyncSessionRecord,
  type SyncTransaction,
  type SyncUnitOfWork,
} from '../../src/sync/index.js';
import { getProblemDefinition } from '../../src/server/problems.js';
import type {
  Collection,
  Node,
  Operation,
  OperationResult,
  SyncInstanceCreatePush,
} from '../../src/types/index.js';

const evidence = '[evidence:sync.operation-reuse-audit]';
const now = '2026-07-18T00:00:00Z';

type Status = OperationResult['status'];
type SequenceResult = Readonly<{ status: Status; marker: string }>;
type Conflict = Readonly<{ id: string }>;
type BusinessAudit = Readonly<{ id: string }>;
type Outbox = Readonly<{ id: string }>;

interface State {
  ledger: Map<string, ServerIdReservation['resourceType']>;
  claims: Map<string, SyncOperationClaim>;
  reuseAudits: Map<string, SyncOperationReuseAudit>;
  sequenceReceipts: Map<string, StoredOperationReceipt<SequenceResult>>;
  sequenceLanes: Map<string, { nextSequence: number }>;
  pushById: Map<string, StoredOperationReceipt<OperationResult>>;
  pushBySequence: Map<string, StoredOperationReceipt<OperationResult>>;
  bootstrapById: Map<string, StoredSessionBootstrapReceipt>;
  bootstrapByLane: Map<string, StoredSessionBootstrapReceipt>;
  sessions: Map<string, SyncSessionRecord>;
  bootstrapLanes: Map<string, { nextSequence: number }>;
  collections: Map<string, SessionBootstrapCollectionAggregate>;
  operations: Map<string, Operation>;
  cursors: string[];
  business: string[];
  businessAudits: Map<string, BusinessAudit>;
  outbox: Map<string, Outbox>;
}

function emptyState(): State {
  return {
    ledger: new Map(), claims: new Map(), reuseAudits: new Map(), sequenceReceipts: new Map(),
    sequenceLanes: new Map(), pushById: new Map(), pushBySequence: new Map(), bootstrapById: new Map(),
    bootstrapByLane: new Map(), sessions: new Map(), bootstrapLanes: new Map(), collections: new Map(),
    operations: new Map(), cursors: [], business: [], businessAudits: new Map(), outbox: new Map(),
  };
}

function clone<Value>(value: Value): Value {
  return structuredClone(value) as Value;
}

function tuple(replicaId: string, scope: string, sequence: number): string {
  return JSON.stringify([replicaId, scope, sequence]);
}

function claim(operationId: string, digest: string, replicaId = 'replica-1', sequenceScope = 'collection-1', sequence = 1): SyncOperationClaim {
  return { operationId, digest, replicaId, sequenceScope, sequence };
}

type AuditFault = 'append-reject' | 'load-reject' | 'missing' | 'malformed' | 'append-non-promise' | 'load-non-promise';

class Backend {
  state = emptyState();
  queue: Promise<void> = Promise.resolve();
  reservationCalls: ServerIdReservation[][] = [];
  auditFault?: AuditFault;
  failAfterWork = false;
  commitUnknown = false;
  claimLoadNonPromise = false;
  ledgerOverride?: (items: readonly ServerIdReservation[]) => Promise<ServerIdReservationResult> | ServerIdReservationResult;

  run<Transaction, Value>(factory: (draft: State) => Transaction, work: (transaction: Transaction) => Promise<Value>): Promise<Value> {
    const execute = async (): Promise<Value> => {
      const draft = clone(this.state);
      const result = await work(factory(draft));
      if (this.failAfterWork) throw new Error('rollback after callback');
      this.state = draft;
      if (this.commitUnknown) throw new Error('commit outcome unknown');
      return result;
    };
    const pending = this.queue.then(execute, execute);
    this.queue = pending.then(() => undefined, () => undefined);
    return pending;
  }
}

function reusePorts(backend: Backend, draft: State) {
  return {
    idReservations: {
      reserveAll: ((items: readonly ServerIdReservation[]) => {
        backend.reservationCalls.push(clone([...items]));
        if (backend.ledgerOverride !== undefined) return backend.ledgerOverride(items);
        const duplicate = items.find(({ id }) => draft.ledger.has(id));
        if (duplicate !== undefined) return Promise.resolve({
          state: 'conflict' as const,
          conflict: {
            requested: clone(duplicate),
            existing: { id: duplicate.id, resourceType: draft.ledger.get(duplicate.id)! },
          },
        });
        items.forEach(({ id, resourceType }) => draft.ledger.set(id, resourceType));
        return Promise.resolve({ state: 'reserved' as const });
      }) as ServerIdReservationStore['reserveAll'],
    },
    operationClaims: {
      load: ((id: string) => backend.claimLoadNonPromise
        ? clone(draft.claims.get(id))
        : Promise.resolve(clone(draft.claims.get(id)))) as unknown as (id: string) => Promise<SyncOperationClaim | undefined>,
      save: async (value: SyncOperationClaim) => { draft.claims.set(value.operationId, clone(value)); },
    },
    reuseAudits: {
      append: ((audit: SyncOperationReuseAudit) => {
        if (backend.auditFault === 'append-reject') return Promise.reject(new Error('audit append failed'));
        if (backend.auditFault === 'append-non-promise') return 'not-a-promise';
        const key = `reuse-${draft.reuseAudits.size + 1}`;
        draft.reuseAudits.set(key, clone(audit));
        return Promise.resolve(key);
      }) as unknown as (audit: SyncOperationReuseAudit) => Promise<string>,
      load: ((key: string) => {
        if (backend.auditFault === 'load-reject') return Promise.reject(new Error('audit load failed'));
        if (backend.auditFault === 'load-non-promise') return undefined;
        if (backend.auditFault === 'missing') return Promise.resolve(undefined);
        if (backend.auditFault === 'malformed') return Promise.resolve({ code: 'op_id_reused' });
        return Promise.resolve(clone(draft.reuseAudits.get(key)));
      }) as unknown as (key: string) => Promise<SyncOperationReuseAudit | undefined>,
    },
  };
}

function sequenceKey(lane: SequenceLaneKey, sequence: number): string {
  return tuple(lane.replicaId, lane.sequenceScope, sequence);
}

class SequenceHandle implements SequenceCoordinatorUnitOfWork<SequenceResult> {
  readonly operationIdReservationOwner = 'sequence' as const;
  evaluations = 0;
  constructor(readonly backend: Backend) {}
  execute<Value>(_lane: SequenceLaneKey, work: (transaction: SequenceCoordinatorTransaction<SequenceResult>) => Promise<Value>): Promise<Value> {
    return this.backend.run((draft) => ({
      ...reusePorts(this.backend, draft),
      loadLaneState: async (lane: SequenceLaneKey) => clone(draft.sequenceLanes.get(tuple(lane.replicaId, lane.sequenceScope, 0))),
      saveLaneState: async (lane: SequenceLaneKey, state: { nextSequence: number }) => {
        draft.sequenceLanes.set(tuple(lane.replicaId, lane.sequenceScope, 0), clone(state));
      },
      receipts: {
        load: async (lane: SequenceLaneKey, sequence: number) => clone(draft.sequenceReceipts.get(sequenceKey(lane, sequence))),
        save: async (receipt: StoredOperationReceipt<SequenceResult>, condition: SequenceReceiptWriteCondition) => {
          const key = tuple(receipt.replicaId, receipt.sequenceScope, receipt.sequence);
          const current = draft.sequenceReceipts.get(key);
          if (condition.kind === 'absent' && current !== undefined) throw new Error('occupied receipt');
          if (condition.kind === 'replace_deferred' && (current?.status !== 'deferred' || current.digest !== condition.digest)) {
            throw new Error('bad deferred replacement');
          }
          draft.sequenceReceipts.set(key, clone(receipt));
        },
      },
    }), work);
  }
}

function sequenceRequest(overrides: Partial<SequenceOperationRequest> = {}): SequenceOperationRequest {
  return { operationId: 'op-1', digest: 'digest-A', replicaId: 'replica-1', sequenceScope: 'collection-1', sequence: 1, ...overrides };
}

async function runSequence(handle: SequenceHandle, request = sequenceRequest(), status: Status = 'applied') {
  return coordinateSequenceOperation(handle, request, async () => {
    handle.evaluations += 1;
    return { status, result: { status, marker: `${status}:${request.operationId}` } };
  });
}

function operation(operationId = 'op-1', replicaId = 'replica-1', sequence = 1): Operation {
  return {
    opId: operationId, replicaId, sequence, type: 'delete_node', occurredAt: now,
    collectionId: 'collection-1', targetId: `node-${sequence}`, baseRevision: `revision-${sequence}`, payload: {},
  };
}

function pushRequest(options: { operationId?: string; replicaId?: string; sequenceScope?: string; sequence?: number; digest?: string; atomic?: boolean } = {}): PushTransactionRequest {
  const op = operation(options.operationId, options.replicaId, options.sequence);
  return {
    batchId: `batch-${op.opId}`, atomic: options.atomic ?? false, serverCursor: 'cursor-0',
    operations: [{ operation: op, sequenceScope: options.sequenceScope ?? 'collection-1', digest: options.digest ?? 'digest-A' }],
  };
}

interface PushTx extends SyncTransaction<Operation, OperationResult, Conflict, BusinessAudit, Outbox> {
  putBusiness(value: string): Promise<void>;
}

class PushHandle implements SyncUnitOfWork<Operation, OperationResult, Conflict, BusinessAudit, Outbox, PushTx> {
  readonly operationIdReservationOwner = 'push' as const;
  preflights = 0;
  applies = 0;
  constructor(readonly backend: Backend) {}
  execute<Value>(work: (transaction: PushTx) => Promise<Value>): Promise<Value> {
    return this.backend.run((draft) => ({
      ...reusePorts(this.backend, draft),
      receipts: {
        findByOperationId: async (id: string) => clone(draft.pushById.get(id)),
        findBySequence: async (replicaId: string, scope: string, sequence: number) => clone(draft.pushBySequence.get(tuple(replicaId, scope, sequence))),
        save: async (receipt: StoredOperationReceipt<OperationResult>) => {
          draft.pushById.set(receipt.operationId, clone(receipt));
          draft.pushBySequence.set(tuple(receipt.replicaId, receipt.sequenceScope, receipt.sequence), clone(receipt));
        },
      },
      appendOperation: async (op: Operation) => { draft.operations.set(op.opId, clone(op)); },
      saveConflict: async () => undefined,
      allocateCursor: async () => { const cursor = `cursor-${draft.cursors.length + 1}`; draft.cursors.push(cursor); return cursor; },
      appendAudit: async (audit: BusinessAudit) => { draft.businessAudits.set(audit.id, clone(audit)); },
      appendOutbox: async (message: Outbox) => { draft.outbox.set(message.id, clone(message)); },
      putBusiness: async (value: string) => { draft.business.push(value); },
    }), work);
  }
}

function pushPlan(handle: PushHandle, request: PushTransactionRequest, status: Status): PushPreparedOperation<PushTx, Conflict, BusinessAudit, Outbox> {
  const op = request.operations[0]!.operation;
  const base = { opId: op.opId, sequence: op.sequence, warnings: [] as const };
  const apply = async (tx: PushTx) => {
    handle.applies += 1;
    if (status === 'applied' || status === 'rebased') await tx.putBusiness(`business:${op.opId}`);
    if (status === 'applied') return { ...base, status, revision: `revision-${op.opId}` };
    if (status === 'rebased') return { ...base, status, revision: `revision-${op.opId}`, transform: {} };
    if (status === 'noop') return { ...base, status };
    if (status === 'rejected') return { ...base, status, code: 'denied' };
    if (status === 'deferred') return { ...base, status, code: 'pending' };
    return { result: { ...base, status: 'conflicted' as const, conflictId: `conflict-${op.opId}` }, conflict: { id: `conflict-${op.opId}` } };
  };
  if (status === 'deferred') return { status, apply } as PushPreparedOperation<PushTx, Conflict, BusinessAudit, Outbox>;
  const audit = async () => ({ id: `audit:${op.opId}` });
  if (status === 'noop' || status === 'rejected') return { status, apply, audit } as PushPreparedOperation<PushTx, Conflict, BusinessAudit, Outbox>;
  return { status, apply, audit, outbox: async () => ({ id: `outbox:${op.opId}` }) } as PushPreparedOperation<PushTx, Conflict, BusinessAudit, Outbox>;
}

async function runPush(handle: PushHandle, request = pushRequest(), status: Status = 'applied') {
  return coordinatePushTransaction(handle, request, async () => {
    handle.preflights += 1;
    return pushPlan(handle, request, status);
  });
}

function activeSession(sessionId = 'session-1'): ActiveSyncSessionRecord {
  return {
    sessionId, principal: { type: 'user', id: 'alice' }, credential: { kind: 'token', id: 'token-1' },
    oauthClientId: 'client-1', origin: 'https://client.example', sessionScope: 'instance', protocolVersion: '0.1',
    collectionId: null, purpose: 'create_collection',
    authorizationScopes: ['collections:create', 'sync:bootstrap', 'sync:push'], status: 'active',
  };
}

function bootstrapOperation(operationId = 'bootstrap-1', replicaId = 'replica-1'): SyncInstanceCreatePush['operations'][0] {
  return {
    opId: operationId, replicaId, sequence: 1, type: 'create_collection', occurredAt: now,
    dependencies: [], baseRevision: null,
    payload: {
      collection: {
        kind: 'knowledge_collection', title: 'Reuse audit', summary: 'Bootstrap fixture.', visibility: 'private',
        publication: { feedMode: 'release', includeNodeContent: 'summary', includeRelations: true }, extensions: {},
      },
      root: { title: 'Reuse audit', folderRole: 'root', extensions: {} },
    },
    source: { adapterProfile: 'test-fixture', nativeEvent: 'bootstrap' },
  };
}

function bootstrapRequest(options: { operationId?: string; replicaId?: string; sessionId?: string; digest?: string; reevaluateDeferred?: boolean } = {}): SessionBootstrapRequest {
  const sessionId = options.sessionId ?? 'session-1';
  const op = bootstrapOperation(options.operationId, options.replicaId);
  return {
    push: { sessionId, batchId: `batch-${sessionId}`, atomic: true, operations: [op] },
    digest: options.digest ?? 'digest-A', rejectedAt: now,
    ...(options.reevaluateDeferred === undefined ? {} : { reevaluateDeferred: options.reevaluateDeferred }),
  };
}

function bootstrapLaneKey(lane: SessionBootstrapLane): string {
  return tuple(lane.replicaId, lane.sessionId, 1);
}

function bootstrapSequenceKey(lane: SessionBootstrapSequenceLane): string {
  return lane.scope === 'instance'
    ? JSON.stringify(['instance', lane.replicaId, lane.sessionId])
    : JSON.stringify(['collection', lane.replicaId, lane.collectionId]);
}

function aggregate(identity: SessionBootstrapIdentity): SessionBootstrapCollectionAggregate {
  const collection: Collection = {
    schemaVersion: '0.1', id: identity.collectionId, kind: 'knowledge_collection', title: 'Reuse audit',
    summary: 'Bootstrap fixture.', rootNodeId: identity.rootNodeId, visibility: 'private', createdAt: now,
    updatedAt: now, revision: identity.revision, extensions: {},
  };
  const root: Node = {
    id: identity.rootNodeId, collectionId: identity.collectionId, kind: 'root', parentId: null, position: null,
    folderRole: 'root', title: 'Reuse audit', createdAt: now, updatedAt: now, revision: identity.revision,
    constraints: { readOnly: false, reason: null }, extensions: {},
  };
  return { collection, root };
}

class BootstrapHandle implements SessionBootstrapUnitOfWork<BusinessAudit, Outbox> {
  readonly operationIdReservationOwner = 'session-bootstrap' as const;
  prepares = 0;
  applies = 0;
  constructor(readonly backend: Backend) {}
  execute<Value>(_lane: SessionBootstrapLane, work: (transaction: SessionBootstrapTransaction<BusinessAudit, Outbox>) => Promise<Value>): Promise<Value> {
    return this.backend.run((draft) => {
      const artifacts = <Artifact extends { readonly id: string }>(target: Map<string, Artifact>) => ({
        append: async (artifact: Artifact) => { target.set(artifact.id, clone(artifact)); return artifact.id; },
        load: async (key: string) => clone(target.get(key)),
      });
      return {
        ...reusePorts(this.backend, draft),
        receipts: {
          findByOperationId: async (id: string) => clone(draft.bootstrapById.get(id)),
          findByLane: async (lane: SessionBootstrapLane) => clone(draft.bootstrapByLane.get(bootstrapLaneKey(lane))),
          save: async (receipt: StoredSessionBootstrapReceipt) => {
            draft.bootstrapById.set(receipt.operationId, clone(receipt));
            draft.bootstrapByLane.set(tuple(receipt.replicaId, receipt.sessionId, 1), clone(receipt));
          },
        },
        sessions: {
          load: async (id: string) => clone(draft.sessions.get(id)),
          save: async (session: SyncSessionRecord, expected: ActiveSyncSessionRecord) => {
            if (expected.status !== 'active' || expected.sessionScope !== 'instance'
              || expected.collectionId !== null || !isDeepStrictEqual(draft.sessions.get(session.sessionId), expected)) {
              throw new Error('bootstrap Session write condition failed');
            }
            draft.sessions.set(session.sessionId, clone(session));
          },
        },
        lanes: {
          load: async (lane: SessionBootstrapSequenceLane) => clone(draft.bootstrapLanes.get(bootstrapSequenceKey(lane))),
          save: async (lane: SessionBootstrapSequenceLane, state: { nextSequence: number }) => { draft.bootstrapLanes.set(bootstrapSequenceKey(lane), clone(state)); },
        },
        collections: {
          load: async (id: string) => clone(draft.collections.get(id)),
          save: async (value: SessionBootstrapCollectionAggregate) => { draft.collections.set(value.collection.id, clone(value)); },
        },
        operations: {
          load: async (id: string) => clone(draft.operations.get(id)),
          append: async (op: Operation) => { draft.operations.set(op.opId, clone(op)); },
        },
        audits: artifacts(draft.businessAudits), outbox: artifacts(draft.outbox),
        allocateIdentity: async () => ({ collectionId: 'collection-generated', rootNodeId: 'root-generated', revision: 'revision-generated' }),
        allocateCursor: async () => { const cursor = `cursor-${draft.cursors.length + 1}`; draft.cursors.push(cursor); return cursor; },
        loadCursor: async (cursor: string) => draft.cursors.includes(cursor) ? cursor : undefined,
      } as SessionBootstrapTransaction<BusinessAudit, Outbox>;
    }, work);
  }
}

function bootstrapPlan(handle: BootstrapHandle, request: SessionBootstrapRequest, status: 'applied' | 'deferred' | 'rejected'): SessionBootstrapPrepared<BusinessAudit, Outbox, SessionBootstrapTransaction<BusinessAudit, Outbox>> {
  const op = request.push.operations[0]!;
  if (status === 'deferred') return {
    status,
    apply: async () => { handle.applies += 1; return { opId: op.opId, sequence: 1, status, code: 'pending', warnings: [] }; },
  };
  if (status === 'rejected') return {
    status,
    apply: async () => { handle.applies += 1; return { opId: op.opId, sequence: 1, status, code: 'denied', warnings: [] }; },
    audit: async () => ({ id: `audit:${op.opId}` }),
  };
  return {
    status, warnings: [],
    apply: async (_tx, identity) => { handle.applies += 1; return aggregate(identity); },
    audit: async () => ({ id: `audit:${op.opId}` }), outbox: async () => ({ id: `outbox:${op.opId}` }),
  };
}

async function runBootstrap(handle: BootstrapHandle, request = bootstrapRequest(), status: 'applied' | 'deferred' | 'rejected' = 'applied') {
  if (!handle.backend.state.sessions.has(request.push.sessionId)) {
    handle.backend.state.sessions.set(request.push.sessionId, activeSession(request.push.sessionId));
  }
  return coordinateSessionBootstrap(handle, request, async () => {
    handle.prepares += 1;
    return bootstrapPlan(handle, request, status);
  });
}

function onlyAudit(backend: Backend): SyncOperationReuseAudit {
  expect(backend.state.reuseAudits.size).toBe(1);
  return [...backend.state.reuseAudits.values()][0]!;
}

function expectNoDenialWrites(backend: Backend, snapshot: State): void {
  expect(backend.state.ledger).toEqual(snapshot.ledger);
  expect(backend.state.claims).toEqual(snapshot.claims);
  expect(backend.state.sequenceReceipts).toEqual(snapshot.sequenceReceipts);
  expect(backend.state.sequenceLanes).toEqual(snapshot.sequenceLanes);
  expect(backend.state.pushById).toEqual(snapshot.pushById);
  expect(backend.state.pushBySequence).toEqual(snapshot.pushBySequence);
  expect(backend.state.bootstrapById).toEqual(snapshot.bootstrapById);
  expect(backend.state.bootstrapByLane).toEqual(snapshot.bootstrapByLane);
  expect(backend.state.bootstrapLanes).toEqual(snapshot.bootstrapLanes);
  expect(backend.state.collections).toEqual(snapshot.collections);
  expect(backend.state.business).toEqual(snapshot.business);
  expect(backend.state.operations).toEqual(snapshot.operations);
  expect(backend.state.cursors).toEqual(snapshot.cursors);
  expect(backend.state.businessAudits).toEqual(snapshot.businessAudits);
  expect(backend.state.outbox).toEqual(snapshot.outbox);
}

describe(`SYNC-0013 Sequence reuse denial ${evidence}`, () => {
  it.each(['applied', 'rebased', 'noop', 'conflicted', 'rejected', 'deferred'] as const)(
    `replays the complete persisted %s result without evaluation reservation or audit ${evidence}`,
    async (status) => {
      const backend = new Backend();
      const handle = new SequenceHandle(backend);
      const first = await runSequence(handle, sequenceRequest(), status);
      const writes = clone(backend.state);
      backend.reservationCalls = [];
      const replay = await runSequence(handle, sequenceRequest(), status === 'deferred' ? 'applied' : 'rejected');
      expect(replay).toEqual(first.kind === 'executed' ? { kind: 'replayed', receipt: first.receipt } : first);
      expect(handle.evaluations).toBe(1);
      expect(backend.reservationCalls).toEqual([]);
      expect(backend.state).toEqual(writes);
    },
  );

  it.each([
    ['same Operation ID and changed digest', { digest: 'digest-B' }],
    ['different Operation ID and same digest', { operationId: 'op-2' }],
    ['different Operation ID and changed digest', { operationId: 'op-2', digest: 'digest-B' }],
  ] as const)(`classifies occupied tuple with %s as sequence_reuse ${evidence}`, async (_label, overrides) => {
    const backend = new Backend();
    const handle = new SequenceHandle(backend);
    await runSequence(handle);
    const before = clone(backend.state);
    const attempted = sequenceRequest(overrides);
    const denied = await runSequence(handle, attempted);
    expect(denied).toMatchObject({ kind: 'sequence_reuse' });
    // The result names the audit persisted with the denial, as Push's error does.
    expect(denied).toEqual({ kind: 'sequence_reuse', auditKey: expect.any(String), audit: onlyAudit(backend) });
    expect(handle.evaluations).toBe(1);
    expectNoDenialWrites(backend, before);
    expect(onlyAudit(backend)).toEqual({ code: 'sequence_reuse', attempted: claim(attempted.operationId, attempted.digest), stored: claim('op-1', 'digest-A') });
  });

  it.each([
    ['Replica', { replicaId: 'replica-2', sequenceScope: 'collection-1' }],
    ['Collection', { sequenceScope: 'collection-2' }],
    ['Sequence', { sequence: 2 }],
  ] as const)(`classifies one opId reused across another %s with changed digest as op_id_reused ${evidence}`, async (_label, changes) => {
    const backend = new Backend();
    const owner = new SequenceHandle(backend);
    await runSequence(owner);
    const attempted = sequenceRequest({ ...changes, digest: 'digest-B' });
    const denied = new SequenceHandle(backend);
    await expect(runSequence(denied, attempted)).resolves.toMatchObject({ kind: 'op_id_reused' });
    expect(denied.evaluations).toBe(0);
    expect(onlyAudit(backend)).toEqual({ code: 'op_id_reused', attempted: claim('op-1', 'digest-B', attempted.replicaId, attempted.sequenceScope, attempted.sequence), stored: claim('op-1', 'digest-A') });
  });

  it(`gives tuple collision precedence when both tuple and Operation ID indexes collide ${evidence}`, async () => {
    const backend = new Backend();
    const handle = new SequenceHandle(backend);
    await runSequence(handle);
    backend.state.claims.set('op-2', claim('op-2', 'digest-old', 'replica-x', 'scope-x', 9));
    await expect(runSequence(handle, sequenceRequest({ operationId: 'op-2', digest: 'digest-B' }))).resolves.toMatchObject({ kind: 'sequence_reuse' });
    expect(onlyAudit(backend).code).toBe('sequence_reuse');
  });

  it(`does not audit unchanged deferred reevaluation and persists its terminal replacement ${evidence}`, async () => {
    const backend = new Backend();
    const handle = new SequenceHandle(backend);
    await runSequence(handle, sequenceRequest(), 'deferred');
    const result = await runSequence(handle, sequenceRequest({ reevaluateDeferred: true }), 'applied');
    expect(result.kind).toBe('executed');
    expect(backend.state.reuseAudits.size).toBe(0);
    expect(handle.evaluations).toBe(2);
  });

  it(`does not audit unchanged deferred reevaluation that remains deferred ${evidence}`, async () => {
    const backend = new Backend();
    const handle = new SequenceHandle(backend);
    await runSequence(handle, sequenceRequest(), 'deferred');
    await expect(runSequence(handle, sequenceRequest({ reevaluateDeferred: true }), 'deferred')).resolves.toMatchObject({ kind: 'replayed' });
    expect(backend.state.reuseAudits.size).toBe(0);
    expect(backend.state.claims.size).toBe(1);
  });

  it(`classifies changed digest from the permanent claim after receipt and Operation cleanup ${evidence}`, async () => {
    const backend = new Backend();
    await runSequence(new SequenceHandle(backend));
    backend.state.sequenceReceipts.clear();
    backend.state.operations.clear();
    backend.state.sequenceLanes.set(tuple('replica-2', 'collection-2', 0), { nextSequence: 1 });
    await expect(runSequence(new SequenceHandle(backend), sequenceRequest({ replicaId: 'replica-2', sequenceScope: 'collection-2', digest: 'digest-B' })))
      .resolves.toMatchObject({ kind: 'op_id_reused' });
    expect(onlyAudit(backend).stored).toEqual(claim('op-1', 'digest-A'));
  });

  it(`commits one audit for every repeated malicious attempt ${evidence}`, async () => {
    const backend = new Backend();
    const handle = new SequenceHandle(backend);
    await runSequence(handle);
    for (const digest of ['digest-B', 'digest-C', 'digest-D']) {
      await expect(runSequence(handle, sequenceRequest({ digest }))).resolves.toMatchObject({ kind: 'sequence_reuse' });
    }
    expect([...backend.state.reuseAudits.values()].map((audit) => audit.attempted.digest)).toEqual(['digest-B', 'digest-C', 'digest-D']);
  });

  it.each([
    ['case-only Operation ID', { operationId: 'OP-1', digest: 'digest-B' }, 'sequence_reuse'],
    ['case-only Replica', { replicaId: 'Replica-1', digest: 'digest-B' }, 'op_id_reused'],
    ['case-only scope', { sequenceScope: 'Collection-1', digest: 'digest-B' }, 'op_id_reused'],
    ['one-character digest', { digest: 'digest-a' }, 'sequence_reuse'],
  ] as const)(`preserves case-sensitive and digest boundary for %s ${evidence}`, async (_label, changes, code) => {
    const backend = new Backend();
    await runSequence(new SequenceHandle(backend));
    await expect(runSequence(new SequenceHandle(backend), sequenceRequest(changes))).resolves.toMatchObject({ kind: code });
    expect(onlyAudit(backend).attempted.digest).toBe(changes.digest);
  });

  it.each(['append-reject', 'load-reject', 'missing', 'malformed', 'append-non-promise', 'load-non-promise'] as const)(
    `fails closed when reuse audit port has %s ${evidence}`,
    async (fault) => {
      const backend = new Backend();
      const handle = new SequenceHandle(backend);
      await runSequence(handle);
      const before = clone(backend.state);
      backend.auditFault = fault;
      await expect(runSequence(handle, sequenceRequest({ digest: 'digest-B' }))).rejects.toThrow();
      expect(backend.state).toEqual(before);
      expect(handle.evaluations).toBe(1);
    },
  );

  it.each([
    ['transaction rollback', (backend: Backend) => { backend.failAfterWork = true; }],
    ['commit unknown', (backend: Backend) => { backend.commitUnknown = true; }],
  ] as const)(`does not expose a successful denial after %s ${evidence}`, async (_label, inject) => {
    const backend = new Backend();
    const handle = new SequenceHandle(backend);
    await runSequence(handle);
    const before = clone(backend.state);
    inject(backend);
    await expect(runSequence(handle, sequenceRequest({ digest: 'digest-B' }))).rejects.toThrow();
    if (!backend.commitUnknown) expect(backend.state).toEqual(before);
  });

  it.each([
    ['missing claim', undefined],
    ['claim for another Operation ID', claim('op-other', 'digest-A')],
    ['claim with a mismatched tuple', claim('op-1', 'digest-A', 'replica-x', 'scope-x', 7)],
  ] as const)(`fails closed on receipt and permanent-claim mismatch: %s ${evidence}`, async (_label, stored) => {
    const backend = new Backend();
    await runSequence(new SequenceHandle(backend));
    if (stored === undefined) backend.state.claims.clear(); else backend.state.claims.set('op-1', clone(stored));
    await expect(runSequence(new SequenceHandle(backend), sequenceRequest({ digest: 'digest-B' }))).rejects.toThrow();
    expect(backend.state.reuseAudits.size).toBe(0);
  });
});

async function caughtReuse(work: Promise<unknown>): Promise<SyncOperationReuseError> {
  try {
    await work;
  } catch (error) {
    expect(error).toBeInstanceOf(SyncOperationReuseError);
    return error as SyncOperationReuseError;
  }
  throw new Error('expected SyncOperationReuseError');
}

function batchRequest(atomic: boolean, ...items: Array<{ operationId: string; digest: string; replicaId?: string; scope?: string; sequence: number }>): PushTransactionRequest {
  const mapped = items.map((item) => ({
    operation: operation(item.operationId, item.replicaId ?? 'replica-1', item.sequence),
    sequenceScope: item.scope ?? 'collection-1', digest: item.digest,
  }));
  const operations: PushTransactionRequest['operations'] = [mapped[0]!, ...mapped.slice(1)];
  return {
    batchId: `batch-${atomic ? 'atomic' : 'partial'}`, atomic, serverCursor: 'cursor-0',
    operations,
  };
}

describe(`SYNC-0013 Push reuse denial ${evidence}`, () => {
  it.each(['applied', 'rebased', 'noop', 'conflicted', 'rejected', 'deferred'] as const)(
    `returns the complete persisted %s result without preflight apply reservation or audit ${evidence}`,
    async (status) => {
      const backend = new Backend();
      const handle = new PushHandle(backend);
      const first = await runPush(handle, pushRequest(), status);
      const before = clone(backend.state);
      backend.reservationCalls = [];
      const replay = await runPush(handle, { ...pushRequest(), serverCursor: first.serverCursor }, status === 'deferred' ? 'applied' : 'rejected');
      expect(replay).toEqual(first);
      expect(handle.preflights).toBe(1);
      expect(handle.applies).toBe(1);
      expect(backend.reservationCalls).toEqual([]);
      expect(backend.state).toEqual(before);
    },
  );

  it.each([
    ['same Operation ID changed digest', { digest: 'digest-B' }],
    ['different Operation ID changed digest', { operationId: 'op-2', digest: 'digest-B' }],
  ] as const)(`throws typed sequence_reuse for occupied tuple with %s ${evidence}`, async (_label, changes) => {
    const backend = new Backend();
    const handle = new PushHandle(backend);
    await runPush(handle);
    const before = clone(backend.state);
    const error = await caughtReuse(runPush(handle, pushRequest(changes)));
    expect(error).toMatchObject({ status: 409, code: 'sequence_reuse' });
    expect(error.audit).toEqual(onlyAudit(backend));
    expect(handle.preflights).toBe(1);
    expect(handle.applies).toBe(1);
    expectNoDenialWrites(backend, before);
  });

  it.each([
    ['Replica', { replicaId: 'replica-2' }],
    ['Collection', { sequenceScope: 'collection-2' }],
    ['Sequence', { sequence: 2 }],
  ] as const)(`throws typed op_id_reused across another %s with changed digest ${evidence}`, async (_label, changes) => {
    const backend = new Backend();
    await runPush(new PushHandle(backend));
    const denied = new PushHandle(backend);
    const attempted = pushRequest({ ...changes, digest: 'digest-B' });
    const error = await caughtReuse(runPush(denied, attempted));
    expect(error).toMatchObject({ status: 409, code: 'op_id_reused' });
    expect(error.audit.attempted).toEqual(claim('op-1', 'digest-B', attempted.operations[0]!.operation.replicaId, attempted.operations[0]!.sequenceScope, attempted.operations[0]!.operation.sequence));
    expect(denied.preflights).toBe(0);
    expect(denied.applies).toBe(0);
  });

  it(`gives tuple collision precedence when both Push indexes collide ${evidence}`, async () => {
    const backend = new Backend();
    await runPush(new PushHandle(backend));
    backend.state.claims.set('op-2', claim('op-2', 'digest-old', 'replica-x', 'scope-x', 3));
    const error = await caughtReuse(runPush(new PushHandle(backend), pushRequest({ operationId: 'op-2', digest: 'digest-B' })));
    expect(error.code).toBe('sequence_reuse');
    expect(error.audit.code).toBe(error.code);
  });

  it(`does not mislabel a shared ledger collision without an Operation claim ${evidence}`, async () => {
    const backend = new Backend();
    backend.state.ledger.set('op-1', 'collection');
    await expect(runPush(new PushHandle(backend))).rejects.toMatchObject({ name: 'ServerIdAlreadyReservedError' });
    expect(backend.state.reuseAudits.size).toBe(0);
    expect(backend.state.business).toEqual([]);
  });

  it.each(['append-reject', 'missing', 'malformed', 'append-non-promise'] as const)(
    `does not throw a typed denial when Push audit persistence has %s ${evidence}`,
    async (fault) => {
      const backend = new Backend();
      const handle = new PushHandle(backend);
      await runPush(handle);
      const before = clone(backend.state);
      backend.auditFault = fault;
      await expect(runPush(handle, pushRequest({ digest: 'digest-B' }))).rejects.not.toBeInstanceOf(SyncOperationReuseError);
      expect(backend.state).toEqual(before);
    },
  );

  it(`audits a local atomic tuple collision before reservation preflight or business work ${evidence}`, async () => {
    const backend = new Backend();
    const handle = new PushHandle(backend);
    const request = batchRequest(true,
      { operationId: 'op-1', digest: 'digest-A', sequence: 1 },
      { operationId: 'op-2', digest: 'digest-B', sequence: 1 });
    const error = await caughtReuse(runPush(handle, request));
    expect(error.code).toBe('sequence_reuse');
    expect(handle.preflights).toBe(0);
    expect(handle.applies).toBe(0);
    expect(backend.reservationCalls).toEqual([]);
    expect(backend.state.business).toEqual([]);
  });

  it(`audits a local atomic Operation ID collision before reservation preflight or business work ${evidence}`, async () => {
    const backend = new Backend();
    const handle = new PushHandle(backend);
    const request = batchRequest(true,
      { operationId: 'op-1', digest: 'digest-A', sequence: 1 },
      { operationId: 'op-1', digest: 'digest-B', sequence: 2 });
    const error = await caughtReuse(runPush(handle, request));
    expect(error.code).toBe('op_id_reused');
    expect(handle.preflights).toBe(0);
    expect(backend.reservationCalls).toEqual([]);
  });

  it(`performs zero atomic batch reservation preflight and business writes on a later durable collision ${evidence}`, async () => {
    const backend = new Backend();
    await runPush(new PushHandle(backend), pushRequest({ operationId: 'occupied', replicaId: 'replica-x', sequenceScope: 'scope-x', digest: 'digest-old' }));
    backend.reservationCalls = [];
    const handle = new PushHandle(backend);
    const request = batchRequest(true,
      { operationId: 'fresh', digest: 'digest-fresh', sequence: 1 },
      { operationId: 'occupied', digest: 'digest-new', sequence: 2 });
    const error = await caughtReuse(runPush(handle, request));
    expect(error.code).toBe('op_id_reused');
    expect(handle.preflights).toBe(0);
    expect(handle.applies).toBe(0);
    expect(backend.reservationCalls).toEqual([]);
    expect(backend.state.claims.has('fresh')).toBe(false);
  });

  it(`keeps an earlier non-atomic commit while committing the later collision audit ${evidence}`, async () => {
    const backend = new Backend();
    await runPush(new PushHandle(backend), pushRequest({ operationId: 'occupied', replicaId: 'replica-x', sequenceScope: 'scope-x', digest: 'digest-old' }));
    const handle = new PushHandle(backend);
    const request = batchRequest(false,
      { operationId: 'fresh', digest: 'digest-fresh', sequence: 1 },
      { operationId: 'occupied', digest: 'digest-new', sequence: 2 });
    const error = await caughtReuse(runPush(handle, request));
    expect(error.code).toBe('op_id_reused');
    expect(backend.state.claims.has('fresh')).toBe(true);
    expect(backend.state.business).toContain('business:fresh');
    expect(backend.state.reuseAudits.size).toBe(1);
  });

  it(`allows one concurrent owner and audits every denied colliding Push attempt ${evidence}`, async () => {
    const backend = new Backend();
    const attempts = ['digest-A', 'digest-B', 'digest-C', 'digest-D'].map((digest) => runPush(new PushHandle(backend), pushRequest({ digest })));
    const settled = await Promise.allSettled(attempts);
    expect(settled.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter((item) => item.status === 'rejected' && item.reason instanceof SyncOperationReuseError)).toHaveLength(3);
    expect(backend.state.reuseAudits.size).toBe(3);
    expect(backend.state.claims.size).toBe(1);
  });
});

describe(`SYNC-0013 bootstrap reuse denial ${evidence}`, () => {
  it.each(['applied', 'deferred', 'rejected'] as const)(
    `returns the complete persisted %s result without prepare apply reservation or reuse audit ${evidence}`,
    async (status) => {
      const backend = new Backend();
      const handle = new BootstrapHandle(backend);
      const first = await runBootstrap(handle, bootstrapRequest(), status);
      const before = clone(backend.state);
      backend.reservationCalls = [];
      const replay = await runBootstrap(handle, bootstrapRequest(), status === 'deferred' ? 'applied' : 'rejected');
      expect(replay).toEqual({ kind: 'replayed', result: (first as { result: OperationResult }).result });
      expect(handle.prepares).toBe(1);
      expect(handle.applies).toBe(1);
      expect(backend.reservationCalls).toEqual([]);
      expect(backend.state).toEqual(before);
    },
  );

  it.each([
    ['same Operation ID', { digest: 'digest-B' }],
    ['different Operation ID', { operationId: 'bootstrap-2', digest: 'digest-B' }],
  ] as const)(`audits occupied instance tuple with %s as sequence_reuse ${evidence}`, async (_label, changes) => {
    const backend = new Backend();
    const handle = new BootstrapHandle(backend);
    await runBootstrap(handle);
    const before = clone(backend.state);
    const denied = await runBootstrap(handle, bootstrapRequest(changes));
    expect(denied).toEqual({ kind: 'sequence_reuse', auditKey: expect.any(String), audit: onlyAudit(backend) });
    expect(onlyAudit(backend).code).toBe('sequence_reuse');
    expect(handle.prepares).toBe(1);
    expect(handle.applies).toBe(1);
    expectNoDenialWrites(backend, before);
  });

  it.each([
    ['another Instance Session', { sessionId: 'session-2' }],
    ['another Replica', { replicaId: 'replica-2', sessionId: 'session-2' }],
  ] as const)(`audits same bootstrap opId across %s with changed digest as op_id_reused ${evidence}`, async (_label, changes) => {
    const backend = new Backend();
    await runBootstrap(new BootstrapHandle(backend));
    const denied = new BootstrapHandle(backend);
    const result = await runBootstrap(denied, bootstrapRequest({ ...changes, digest: 'digest-B' }));
    expect(result).toMatchObject({ kind: 'op_id_reused' });
    expect(onlyAudit(backend).code).toBe('op_id_reused');
    expect(denied.prepares).toBe(0);
    expect(denied.applies).toBe(0);
  });

  it(`audits normal-to-bootstrap changed-digest reuse as op_id_reused ${evidence}`, async () => {
    const backend = new Backend();
    await runSequence(new SequenceHandle(backend), sequenceRequest({ operationId: 'shared-op' }));
    const result = await runBootstrap(new BootstrapHandle(backend), bootstrapRequest({ operationId: 'shared-op', sessionId: 'session-2', digest: 'digest-B' }));
    expect(result).toMatchObject({ kind: 'op_id_reused' });
    expect(onlyAudit(backend)).toMatchObject({ code: 'op_id_reused', stored: { sequenceScope: 'collection-1' }, attempted: { sequenceScope: 'session-2' } });
  });

  it(`audits bootstrap-to-normal changed-digest reuse as op_id_reused ${evidence}`, async () => {
    const backend = new Backend();
    await runBootstrap(new BootstrapHandle(backend), bootstrapRequest({ operationId: 'shared-op' }));
    const result = await runSequence(new SequenceHandle(backend), sequenceRequest({ operationId: 'shared-op', replicaId: 'replica-2', sequenceScope: 'collection-2', digest: 'digest-B' }));
    expect(result).toMatchObject({ kind: 'op_id_reused' });
    expect(onlyAudit(backend).code).toBe('op_id_reused');
  });

  it(`gives bootstrap tuple collision precedence when both indexes collide ${evidence}`, async () => {
    const backend = new Backend();
    await runBootstrap(new BootstrapHandle(backend));
    backend.state.claims.set('bootstrap-2', claim('bootstrap-2', 'digest-old', 'replica-x', 'session-x', 1));
    const result = await runBootstrap(new BootstrapHandle(backend), bootstrapRequest({ operationId: 'bootstrap-2', digest: 'digest-B' }));
    expect(result).toMatchObject({ kind: 'sequence_reuse' });
    expect(onlyAudit(backend).code).toBe('sequence_reuse');
  });

  it(`does not audit unchanged bootstrap deferred reevaluation ${evidence}`, async () => {
    const backend = new Backend();
    const handle = new BootstrapHandle(backend);
    await runBootstrap(handle, bootstrapRequest(), 'deferred');
    const result = await runBootstrap(handle, bootstrapRequest({ reevaluateDeferred: true }), 'applied');
    expect(result.kind).toBe('executed');
    expect(backend.state.reuseAudits.size).toBe(0);
    expect(handle.prepares).toBe(2);
  });

  it.each(['append-reject', 'malformed', 'load-non-promise'] as const)(
    `does not expose bootstrap denial when audit persistence has %s ${evidence}`,
    async (fault) => {
      const backend = new Backend();
      const handle = new BootstrapHandle(backend);
      await runBootstrap(handle);
      const before = clone(backend.state);
      backend.auditFault = fault;
      await expect(runBootstrap(handle, bootstrapRequest({ digest: 'digest-B' }))).rejects.toThrow();
      expect(backend.state).toEqual(before);
    },
  );

  it(`classifies bootstrap reuse from permanent claim after receipt and Operation cleanup ${evidence}`, async () => {
    const backend = new Backend();
    await runBootstrap(new BootstrapHandle(backend));
    backend.state.bootstrapById.clear();
    backend.state.bootstrapByLane.clear();
    backend.state.operations.clear();
    const result = await runBootstrap(new BootstrapHandle(backend), bootstrapRequest({ sessionId: 'session-2', digest: 'digest-B' }));
    expect(result).toMatchObject({ kind: 'op_id_reused' });
    expect(onlyAudit(backend).stored).toMatchObject({ operationId: 'bootstrap-1', digest: 'digest-A' });
  });

  it(`fails closed when lifetime claim exists without bootstrap receipt at the same digest ${evidence}`, async () => {
    const backend = new Backend();
    await runBootstrap(new BootstrapHandle(backend));
    backend.state.bootstrapById.clear();
    backend.state.bootstrapByLane.clear();
    backend.state.operations.clear();
    backend.state.sessions.set('session-2', activeSession('session-2'));
    const before = clone(backend.state);
    await expect(
      runBootstrap(new BootstrapHandle(backend), bootstrapRequest({ sessionId: 'session-2', digest: 'digest-A' })),
    ).rejects.toThrow(/without its bootstrap receipt/i);
    expect(backend.state.bootstrapById.size).toBe(0);
    expect(backend.state.collections.size).toBe(before.collections.size);
  });

  it(`allows one concurrent bootstrap owner and audits all visible changed-digest denials ${evidence}`, async () => {
    const backend = new Backend();
    const settled = await Promise.allSettled(['digest-A', 'digest-B', 'digest-C'].map((digest) =>
      runBootstrap(new BootstrapHandle(backend), bootstrapRequest({ digest }))));
    expect(settled.filter((item) => item.status === 'fulfilled' && item.value.kind === 'executed')).toHaveLength(1);
    expect(settled.filter((item) => item.status === 'fulfilled' && item.value.kind === 'sequence_reuse')).toHaveLength(2);
    expect(backend.state.reuseAudits.size).toBe(2);
  });
});

describe(`SYNC-0013 strict reuse evidence boundary ${evidence}`, () => {
  it(`rejects a claim accessor without invoking it ${evidence}`, () => {
    const getter = vi.fn(() => 'op-1');
    const candidate = { digest: 'digest-A', replicaId: 'replica-1', sequenceScope: 'collection-1', sequence: 1 } as Record<string, unknown>;
    Object.defineProperty(candidate, 'operationId', { enumerable: true, get: getter });
    expect(() => immutableSyncOperationClaim(candidate as unknown as SyncOperationClaim)).toThrow(/data propert/i);
    expect(getter).not.toHaveBeenCalled();
  });

  it(`rejects symbol-bearing and unknown claim members ${evidence}`, () => {
    expect(() => immutableSyncOperationClaim({ ...claim('op-1', 'digest-A'), [Symbol('secret')]: 'payload' } as SyncOperationClaim)).toThrow();
    expect(() => immutableSyncOperationClaim({ ...claim('op-1', 'digest-A'), payload: { secret: true } } as SyncOperationClaim)).toThrow();
  });

  it(`snapshots freezes and detaches canonical claim data ${evidence}`, () => {
    const source = claim('op-1', 'digest-A') as { operationId: string; digest: string; replicaId: string; sequenceScope: string; sequence: number };
    const snapshot = immutableSyncOperationClaim(source);
    source.digest = 'mutated';
    expect(snapshot).toEqual(claim('op-1', 'digest-A'));
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it(`persists exact strict audit facts with no raw Operation or payload ${evidence}`, async () => {
    const backend = new Backend();
    await runPush(new PushHandle(backend));
    const request = pushRequest({ digest: 'digest-B' });
    const error = await caughtReuse(runPush(new PushHandle(backend), request));
    expect(Reflect.ownKeys(error.audit)).toEqual(['code', 'attempted', 'stored']);
    expect(Reflect.ownKeys(error.audit.attempted)).toEqual(['operationId', 'digest', 'replicaId', 'sequenceScope', 'sequence']);
    expect(JSON.stringify(error.audit)).not.toContain('payload');
    expect(JSON.stringify(error.audit)).not.toContain('delete_node');
  });

  it(`rejects a non-Promise claim load before reservation or evaluation ${evidence}`, async () => {
    const backend = new Backend();
    const handle = new SequenceHandle(backend);
    backend.claimLoadNonPromise = true;
    await expect(runSequence(handle)).rejects.toThrow(/Promise/);
    expect(backend.reservationCalls).toEqual([]);
    expect(handle.evaluations).toBe(0);
  });

  it(`fails closed on a Push cross-index receipt mismatch without auditing guessed facts ${evidence}`, async () => {
    const backend = new Backend();
    await runPush(new PushHandle(backend));
    const wrong = clone(backend.state.pushBySequence.get(tuple('replica-1', 'collection-1', 1))!);
    (wrong as { operationId: string }).operationId = 'op-other';
    backend.state.pushBySequence.set(tuple('replica-1', 'collection-1', 1), wrong);
    backend.state.claims.set('op-other', claim('op-other', 'digest-A'));
    await expect(runPush(new PushHandle(backend))).rejects.toThrow(/same digest|inconsistent/i);
    expect(backend.state.reuseAudits.size).toBe(0);
  });

  it(`keeps claim comparison case-sensitive at every identity and digest boundary ${evidence}`, () => {
    const base = claim('op-1', 'digest-A');
    expect(syncOperationClaimsMatch(base, clone(base))).toBe(true);
    for (const changed of [
      claim('OP-1', 'digest-A'), claim('op-1', 'Digest-A'), claim('op-1', 'digest-A', 'Replica-1'),
      claim('op-1', 'digest-A', 'replica-1', 'Collection-1'), claim('op-1', 'digest-A', 'replica-1', 'collection-1', 2),
    ]) expect(syncOperationClaimsMatch(base, changed)).toBe(false);
  });

  it(`exports coordinators typed denial owner literals and registered Problem mappings ${evidence}`, () => {
    expect(sequenceFromSyncEntry).toBe(coordinateSequenceOperation);
    expect(pushFromSyncEntry).toBe(coordinatePushTransaction);
    expect(bootstrapFromSyncEntry).toBe(coordinateSessionBootstrap);
    expect(ReuseErrorFromSyncEntry).toBe(SyncOperationReuseError);
    expect(getProblemDefinition('sequence_reuse')).toEqual({ status: 409, retryable: false });
    expect(getProblemDefinition('op_id_reused')).toEqual({ status: 409, retryable: false });
    expectTypeOf<SequenceHandle['operationIdReservationOwner']>().toEqualTypeOf<'sequence'>();
    expectTypeOf<PushHandle['operationIdReservationOwner']>().toEqualTypeOf<'push'>();
    expectTypeOf<BootstrapHandle['operationIdReservationOwner']>().toEqualTypeOf<'session-bootstrap'>();
  });

  it(`unit helpers commit and read back a detached denial audit ${evidence}`, async () => {
    const backend = new Backend();
    await backend.run((draft) => reusePorts(backend, draft), async (transaction) => {
      const stored = await claimSyncOperation(transaction, claim('op-1', 'digest-A'));
      expect(stored.kind).toBe('claimed');
      const appended = await appendSyncOperationReuseAudit(transaction.reuseAudits, 'op_id_reused', claim('op-1', 'digest-B', 'replica-2'), stored.claim);
      expect(appended.audit).toEqual({ code: 'op_id_reused', attempted: claim('op-1', 'digest-B', 'replica-2'), stored: claim('op-1', 'digest-A') });
      expect(Object.isFrozen(appended.audit)).toBe(true);
    });
    expect(backend.state.reuseAudits.size).toBe(1);
  });
});
