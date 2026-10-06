import { isDeepStrictEqual } from 'node:util';
import { describe, expect, it, vi } from 'vitest';

import {
  coordinateSessionBootstrap as coordinateBootstrapFromSyncEntry,
} from '../../src/sync/index.js';
import {
  coordinateSequenceOperation as coordinateSequenceFromSyncEntry,
} from '../../src/sync/unsafe.js';
import {
  coordinateSequenceOperation,
} from '../../src/sync/unsafe.js';
import type { Collection, Node, Operation, SyncInstanceCreatePush } from '../../src/types/index.js';
import type { ActiveSyncSessionRecord, SyncSessionRecord } from '../../src/sync/session.js';
import {
  coordinateSessionBootstrap,
  type SequenceCoordinatorTransaction,
  type SequenceCoordinatorUnitOfWork,
  type SequenceEvaluation,
  type SequenceLaneKey,
  type SequenceLaneState,
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
} from '../../src/sync/index.js';

const evidence = '[evidence:sync.sequence-scope]';
const now = '2026-07-18T04:00:00Z';

type Result = Readonly<Record<string, unknown>> & { readonly status: 'applied' | 'deferred' | 'rejected' };

interface SequenceState {
  readonly lanes: Map<string, SequenceLaneState>;
  readonly receipts: Map<string, StoredOperationReceipt<Result>>;
  readonly operationClaims: Map<string, any>;
  readonly reuseAudits: Map<string, any>;
}

function laneKey(lane: SequenceLaneKey): string {
  return JSON.stringify([lane.replicaId, lane.sequenceScope]);
}

function receiptKey(lane: SequenceLaneKey, sequence: number): string {
  return JSON.stringify([lane.replicaId, lane.sequenceScope, sequence]);
}

function copy<Value>(value: Value): Value {
  return structuredClone(value);
}

function cloneSequenceState(state: SequenceState): SequenceState {
  return {
    lanes: new Map([...state.lanes].map(([key, value]) => [key, copy(value)])),
    receipts: new Map([...state.receipts].map(([key, value]) => [key, copy(value)])),
    operationClaims: new Map([...state.operationClaims].map(([key, value]) => [key, copy(value)])),
    reuseAudits: new Map([...state.reuseAudits].map(([key, value]) => [key, copy(value)])),
  };
}

class SequenceBackend {
  state: SequenceState = { lanes: new Map(), receipts: new Map(), operationClaims: new Map(), reuseAudits: new Map() };
  readonly tails = new Map<string, Promise<void>>();
}

class SequenceHandle implements SequenceCoordinatorUnitOfWork<Result> {
  readonly operationIdReservationOwner = 'sequence' as const;
  receiptLoads = 0;
  receiptSaves = 0;
  laneLoads = 0;
  laneSaves = 0;
  executeMode: 'normal' | 'zero' | 'twice' | 'forged' | 'non-promise' = 'normal';
  failBeforeCommit = false;
  commitUnknown = false;
  forceConditionConflict?: 'absent' | 'replace_deferred';
  receiptLoadOverride?: StoredOperationReceipt<Result>;
  laneLoadOverride?: SequenceLaneState;

  constructor(readonly backend = new SequenceBackend()) {}

  execute<Value>(
    lane: SequenceLaneKey,
    work: (transaction: SequenceCoordinatorTransaction<Result>) => Promise<Value>,
  ): Promise<Value> {
    if (this.executeMode === 'non-promise') return undefined as never;
    if (this.executeMode === 'zero') return Promise.resolve({} as Value);
    const key = laneKey(lane);
    const previous = this.backend.tails.get(key) ?? Promise.resolve();
    const run = async (): Promise<Value> => {
      const draft = cloneSequenceState(this.backend.state);
      const transaction = this.transaction(draft);
      const result = await work(transaction);
      if (this.executeMode === 'twice') await work(transaction);
      if (this.failBeforeCommit) throw new Error('injected rollback');
      this.backend.state = draft;
      if (this.commitUnknown) {
        this.commitUnknown = false;
        throw new Error('commit outcome unknown');
      }
      return this.executeMode === 'forged' ? copy(result) : result;
    };
    const outcome = previous.then(run, run);
    this.backend.tails.set(key, outcome.then(() => undefined, () => undefined));
    return outcome;
  }

  private transaction(draft: SequenceState): SequenceCoordinatorTransaction<Result> {
    return {
      idReservations: { reserveAll: async () => ({ state: 'reserved' }) },
      operationClaims: {
        load: async (id: string) => copy(draft.operationClaims.get(id)),
        save: async (claim: any) => { draft.operationClaims.set(claim.operationId, copy(claim)); },
      },
      reuseAudits: {
        append: async (audit: any) => { const key = `reuse-${draft.reuseAudits.size + 1}`; draft.reuseAudits.set(key, copy(audit)); return key; },
        load: async (key: string) => copy(draft.reuseAudits.get(key)),
      },
      loadLaneState: async (lane) => {
        this.laneLoads += 1;
        return copy(this.laneLoadOverride ?? draft.lanes.get(laneKey(lane)));
      },
      saveLaneState: async (lane, state) => {
        this.laneSaves += 1;
        draft.lanes.set(laneKey(lane), copy(state));
      },
      receipts: {
        load: async (lane, sequence) => {
          this.receiptLoads += 1;
          return copy(this.receiptLoadOverride ?? draft.receipts.get(receiptKey(lane, sequence)));
        },
        save: async (receipt, condition) => {
          this.receiptSaves += 1;
          this.assertCondition(draft, receipt, condition);
          draft.receipts.set(receiptKey(receipt, receipt.sequence), copy(receipt));
        },
      },
    };
  }

  private assertCondition(
    draft: SequenceState,
    receipt: StoredOperationReceipt<Result>,
    condition: SequenceReceiptWriteCondition,
  ): void {
    if (this.forceConditionConflict === condition.kind) throw new Error(`injected ${condition.kind} conflict`);
    const current = draft.receipts.get(receiptKey(receipt, receipt.sequence));
    if (condition.kind === 'absent') {
      if (current !== undefined) throw new Error('receipt already exists');
      return;
    }
    if (current?.status !== 'deferred' || current.digest !== condition.digest) {
      throw new Error('deferred replacement precondition failed');
    }
  }
}

function request(overrides: Partial<SequenceOperationRequest> = {}): SequenceOperationRequest {
  return {
    operationId: 'operation-1', replicaId: 'replica-1', sequenceScope: 'collection-1',
    sequence: 1, digest: 'sha-256:operation-1', ...overrides,
  };
}

function applied(tag = 'one'): SequenceEvaluation<Result> {
  return { status: 'applied', result: { status: 'applied', tag, nested: [tag] } };
}

async function coordinate(
  handle: SequenceHandle,
  candidate = request(),
  evaluation: SequenceEvaluation<Result> = applied(),
) {
  return coordinateSequenceOperation(handle, candidate, async () => evaluation);
}

function metrics(handle: SequenceHandle) {
  return {
    receiptLoads: handle.receiptLoads, receiptSaves: handle.receiptSaves,
    laneLoads: handle.laneLoads, laneSaves: handle.laneSaves,
  };
}

describe(`SYNC-0011 exact durable Sequence scope ${evidence}`, () => {
  it(`stores one receipt for the same Replica, scope, and Sequence tuple ${evidence}`, async () => {
    const handle = new SequenceHandle();
    await coordinate(handle);
    await coordinate(handle);
    expect(handle.backend.state.receipts.size).toBe(1);
    expect([...handle.backend.state.receipts.keys()]).toEqual([receiptKey(request(), 1)]);
  });

  it(`exact replay performs no evaluation or durable writes ${evidence}`, async () => {
    const handle = new SequenceHandle();
    const evaluator = vi.fn(async () => applied());
    const first = await coordinateSequenceOperation(handle, request(), evaluator);
    const before = metrics(handle);
    const replay = await coordinateSequenceOperation(handle, request(), evaluator);
    expect(replay).toEqual({ kind: 'replayed', receipt: first.kind === 'executed' ? first.receipt : undefined });
    expect(evaluator).toHaveBeenCalledOnce();
    expect(metrics(handle)).toEqual({ ...before, receiptLoads: before.receiptLoads + 1, laneLoads: before.laneLoads + 1 });
  });

  it(`returns Sequence reuse for a different digest on the same exact tuple ${evidence}`, async () => {
    const handle = new SequenceHandle();
    await coordinate(handle);
    const evaluator = vi.fn(async () => applied('forbidden'));
    await expect(coordinateSequenceOperation(handle, request({ digest: 'sha-256:other' }), evaluator))
      .resolves.toMatchObject({ kind: 'sequence_reuse' });
    expect(evaluator).not.toHaveBeenCalled();
    expect(handle.backend.state.receipts.size).toBe(1);
  });

  it.each(['replica-2', 'Replica-1', '01'])(
    `keeps Replica %s independent at the same scope and Sequence ${evidence}`,
    async (replicaId) => {
      const handle = new SequenceHandle();
      await coordinate(handle);
      const other = request({ operationId: `operation-${replicaId}`, replicaId, digest: `sha-256:${replicaId}` });
      await expect(coordinate(handle, other, applied(replicaId))).resolves.toMatchObject({ kind: 'executed' });
      expect(handle.backend.state.receipts.size).toBe(2);
    },
  );

  it.each(['collection-2', 'Collection-1', '01'])(
    `keeps Collection scope %s independent for the same Replica and Sequence ${evidence}`,
    async (sequenceScope) => {
      const handle = new SequenceHandle();
      await coordinate(handle);
      const other = request({ operationId: `operation-${sequenceScope}`, sequenceScope, digest: `sha-256:${sequenceScope}` });
      await expect(coordinate(handle, other, applied(sequenceScope))).resolves.toMatchObject({ kind: 'executed' });
      expect(handle.backend.state.lanes.size).toBe(2);
    },
  );

  it.each(['session-2', 'Session-1', '0001'])(
    `keeps unbound Instance Session scope %s independent for the same Replica and Sequence ${evidence}`,
    async (sequenceScope) => {
      const handle = new SequenceHandle();
      await coordinate(handle, request({ sequenceScope: 'session-1' }));
      const other = request({ operationId: `operation-${sequenceScope}`, sequenceScope, digest: `sha-256:${sequenceScope}` });
      await expect(coordinate(handle, other, applied(sequenceScope))).resolves.toMatchObject({ kind: 'executed' });
      expect(handle.backend.state.receipts.size).toBe(2);
    },
  );

  it(`continues a Collection lane across reconnecting normal Sessions without a Session key ${evidence}`, async () => {
    const handle = new SequenceHandle();
    await coordinate(handle, request({ operationId: 'from-session-a', digest: 'sha-256:a' }));
    const fromSessionB = request({ operationId: 'from-session-b', sequence: 2, digest: 'sha-256:b' });
    await expect(coordinate(handle, fromSessionB, applied('session-b'))).resolves.toMatchObject({
      kind: 'executed', receipt: { sequenceScope: 'collection-1', sequence: 2 },
    });
    expect(handle.backend.state.lanes).toEqual(new Map([[laneKey(request()), { nextSequence: 3 }]]));
  });

  it(`a deferred Instance lane does not block an unrelated Collection lane ${evidence}`, async () => {
    const handle = new SequenceHandle();
    await coordinate(handle, request({ sequenceScope: 'session-1' }), {
      status: 'deferred', result: { status: 'deferred', code: 'pending' },
    });
    await expect(coordinate(handle, request({
      operationId: 'collection-operation', sequenceScope: 'collection-1', digest: 'sha-256:collection',
    }))).resolves.toMatchObject({ kind: 'executed', receipt: { sequence: 1 } });
  });

  it(`a receipt in one lane never replays a request from another lane ${evidence}`, async () => {
    const handle = new SequenceHandle();
    await coordinate(handle);
    const evaluator = vi.fn(async () => applied('other'));
    const result = await coordinateSequenceOperation(handle, request({ operationId: 'operation-other', sequenceScope: 'collection-2', digest: 'sha-256:other' }), evaluator);
    expect(result).toMatchObject({ kind: 'executed', receipt: { sequenceScope: 'collection-2' } });
    expect(evaluator).toHaveBeenCalledOnce();
  });

  it.each(['01', '1', 'A', 'a', 'scope.tail', 'scope-tail'])(
    `preserves opaque scope value %j exactly without coercion or normalization ${evidence}`,
    async (sequenceScope) => {
      const handle = new SequenceHandle();
      const candidate = request({ sequenceScope, operationId: `operation.${sequenceScope}`, digest: `digest:${sequenceScope}` });
      const result = await coordinate(handle, candidate);
      expect(result).toMatchObject({ receipt: { sequenceScope } });
      expect(handle.backend.state.receipts.has(receiptKey(candidate, 1))).toBe(true);
    },
  );

  it(`does not lexically compare adjacent or prefix Collection identifiers ${evidence}`, async () => {
    const handle = new SequenceHandle();
    const scopes = ['collection-2', 'collection-10', 'collection-2/child'];
    for (const [index, scope] of scopes.entries()) {
      await coordinate(handle, request({ operationId: `operation-${index}`, sequenceScope: scope, digest: `digest-${index}` }));
    }
    expect([...handle.backend.state.lanes.keys()]).toEqual(scopes.map((scope) => laneKey(request({ sequenceScope: scope }))));
  });

  it.each([
    ['Replica', { replicaId: 'replica-other' }],
    ['scope', { sequenceScope: 'collection-other' }],
    ['Sequence', { sequence: 2 }],
  ] as const)(`rejects an adapter receipt returned for another %s key ${evidence}`, async (_label, mismatch) => {
    const handle = new SequenceHandle();
    handle.receiptLoadOverride = {
      operationId: 'operation-1', replicaId: 'replica-1', sequenceScope: 'collection-1', sequence: 1,
      digest: 'sha-256:operation-1', status: 'applied', result: { status: 'applied' }, ...mismatch,
    };
    await expect(coordinate(handle)).rejects.toThrow(/different lane|mismatched sequence/);
  });

  it(`fails closed when an adapter borrows consumed lane state from another scope ${evidence}`, async () => {
    const handle = new SequenceHandle();
    handle.laneLoadOverride = { nextSequence: 2 };
    await expect(coordinate(handle)).rejects.toThrow('missing a consumed Sequence receipt');
    expect(handle.backend.state.receipts.size).toBe(0);
  });

  it(`rolls back when the absent conditional receipt write loses a race ${evidence}`, async () => {
    const handle = new SequenceHandle();
    handle.forceConditionConflict = 'absent';
    await expect(coordinate(handle)).rejects.toThrow('injected absent conflict');
    expect(handle.backend.state).toEqual({ lanes: new Map(), receipts: new Map(), operationClaims: new Map(), reuseAudits: new Map() });
  });

  it(`rolls back when deferred replacement no longer satisfies its digest condition ${evidence}`, async () => {
    const handle = new SequenceHandle();
    await coordinate(handle, request(), { status: 'deferred', result: { status: 'deferred', code: 'wait' } });
    const before = cloneSequenceState(handle.backend.state);
    handle.forceConditionConflict = 'replace_deferred';
    await expect(coordinate(handle, request({ reevaluateDeferred: true }), applied())).rejects.toThrow('replace_deferred conflict');
    expect(handle.backend.state).toEqual(before);
  });

  it(`rolls back receipt and lane writes together after a transaction failure ${evidence}`, async () => {
    const handle = new SequenceHandle();
    handle.failBeforeCommit = true;
    await expect(coordinate(handle)).rejects.toThrow('injected rollback');
    expect(handle.backend.state).toEqual({ lanes: new Map(), receipts: new Map(), operationClaims: new Map(), reuseAudits: new Map() });
  });

  it(`reports commit-unknown and an exact retry resolves from the committed scoped receipt ${evidence}`, async () => {
    const handle = new SequenceHandle();
    handle.commitUnknown = true;
    const evaluator = vi.fn(async () => applied());
    await expect(coordinateSequenceOperation(handle, request(), evaluator)).rejects.toThrow('commit outcome unknown');
    await expect(coordinateSequenceOperation(handle, request(), evaluator)).resolves.toMatchObject({ kind: 'replayed' });
    expect(evaluator).toHaveBeenCalledOnce();
  });

  it.each(['zero', 'twice'] as const)(
    `rejects a UnitOfWork that invokes the scoped callback %s times ${evidence}`,
    async (mode) => {
      const handle = new SequenceHandle();
      handle.executeMode = mode;
      await expect(coordinate(handle)).rejects.toThrow('exactly once');
      expect(handle.backend.state).toEqual({ lanes: new Map(), receipts: new Map(), operationClaims: new Map(), reuseAudits: new Map() });
    },
  );

  it(`rejects a UnitOfWork that returns a non-Promise ${evidence}`, async () => {
    const handle = new SequenceHandle();
    handle.executeMode = 'non-promise';
    await expect(coordinate(handle)).rejects.toThrow('must return a Promise');
  });

  it.each(['accessor', 'symbol', 'unknown'] as const)(
    `rejects request %s members before entering the durable lane ${evidence}`,
    async (shape) => {
      const handle = new SequenceHandle();
      const candidate = request() as SequenceOperationRequest & Record<PropertyKey, unknown>;
      if (shape === 'accessor') Object.defineProperty(candidate, 'digest', { enumerable: true, get: () => 'sha-256:x' });
      if (shape === 'symbol') candidate[Symbol('scope')] = 'collection-other';
      if (shape === 'unknown') candidate.sessionId = 'must-not-be-part-of-a-collection-lane';
      await expect(coordinate(handle, candidate)).rejects.toThrow(/data properties|unknown member/);
      expect(handle.laneLoads).toBe(0);
    },
  );

  it(`detaches opaque keys and returned receipt data from caller and adapter mutation ${evidence}`, async () => {
    const handle = new SequenceHandle();
    const candidate = request();
    const result = await coordinate(handle, candidate, applied('original'));
    (candidate as { sequenceScope: string }).sequenceScope = 'caller-mutated';
    expect(result).toMatchObject({ receipt: { sequenceScope: 'collection-1', result: { nested: ['original'] } } });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.kind === 'executed' ? result.receipt : undefined)).toBe(true);
  });

  it(`exports the Sequence coordinator from the explicit unsafe Sync entry ${evidence}`, () => {
    expect(coordinateSequenceFromSyncEntry).toBe(coordinateSequenceOperation);
  });
});

type Audit = { readonly id: string };
type Outbox = { readonly id: string };

interface BootstrapState {
  sessions: Map<string, SyncSessionRecord>;
  lanes: Map<string, { nextSequence: number }>;
  aggregates: Map<string, SessionBootstrapCollectionAggregate>;
  operations: Map<string, Operation>;
  receiptsByOperation: Map<string, StoredSessionBootstrapReceipt>;
  receiptsByLane: Map<string, StoredSessionBootstrapReceipt>;
  cursors: string[];
  audits: Map<string, Audit>;
  outbox: Map<string, Outbox>;
  operationClaims: Map<string, any>;
  reuseAudits: Map<string, any>;
}

function bootstrapLaneKey(lane: SessionBootstrapLane): string {
  return JSON.stringify([lane.replicaId, lane.sessionId, 1]);
}

function bootstrapSequenceLaneKey(lane: SessionBootstrapSequenceLane): string {
  return lane.scope === 'instance'
    ? JSON.stringify([lane.replicaId, lane.sessionId, 'instance'])
    : JSON.stringify([lane.replicaId, lane.collectionId, 'collection']);
}

function emptyBootstrapState(): BootstrapState {
  return {
    sessions: new Map(), lanes: new Map(), aggregates: new Map(), operations: new Map(),
    receiptsByOperation: new Map(), receiptsByLane: new Map(), cursors: [], audits: new Map(), outbox: new Map(), operationClaims: new Map(), reuseAudits: new Map(),
  };
}

class BootstrapHandle implements SessionBootstrapUnitOfWork<Audit, Outbox> {
  readonly operationIdReservationOwner = 'session-bootstrap' as const;
  state = emptyBootstrapState();
  prepareCount = 0;
  applyCount = 0;
  failBeforeCommit = false;
  identity: SessionBootstrapIdentity = {
    collectionId: 'collection-generated', rootNodeId: 'root-generated', revision: 'revision-generated',
  };

  async execute<Value>(
    _lane: SessionBootstrapLane,
    work: (transaction: SessionBootstrapTransaction<Audit, Outbox>) => Promise<Value>,
  ): Promise<Value> {
    const draft = copy(this.state);
    const result = await work(this.transaction(draft));
    if (this.failBeforeCommit) throw new Error('injected bootstrap rollback');
    this.state = draft;
    return result;
  }

  private transaction(draft: BootstrapState): SessionBootstrapTransaction<Audit, Outbox> {
    const artifacts = <Artifact>(target: Map<string, Artifact>) => ({
      append: async (artifact: Artifact) => {
        const key = `artifact-${target.size + 1}`;
        target.set(key, copy(artifact));
        return key;
      },
      load: async (key: string) => copy(target.get(key)),
    });
    return {
      operationClaims: { load: async (id: string) => copy(draft.operationClaims.get(id)), save: async (claim: any) => { draft.operationClaims.set(claim.operationId, copy(claim)); } },
      reuseAudits: { append: async (audit: any) => { const key = `reuse-${draft.reuseAudits.size + 1}`; draft.reuseAudits.set(key, copy(audit)); return key; }, load: async (key: string) => copy(draft.reuseAudits.get(key)) },
      idReservations: { reserveAll: async () => ({ state: 'reserved' }) },
      receipts: {
        findByOperationId: async (id) => copy(draft.receiptsByOperation.get(id)),
        findByLane: async (lane) => copy(draft.receiptsByLane.get(bootstrapLaneKey(lane))),
        save: async (receipt, condition) => {
          const key = bootstrapLaneKey(receipt);
          const current = draft.receiptsByLane.get(key);
          if (condition.kind === 'absent' && current !== undefined) throw new Error('receipt exists');
          if (condition.kind === 'replace_deferred'
            && (current?.status !== 'deferred' || current.digest !== condition.digest)) {
            throw new Error('deferred precondition failed');
          }
          draft.receiptsByOperation.set(receipt.operationId, copy(receipt));
          draft.receiptsByLane.set(key, copy(receipt));
        },
      },
      sessions: {
        load: async (id) => copy(draft.sessions.get(id)),
        save: async (value, expected) => {
          if (expected.status !== 'active' || expected.sessionScope !== 'instance'
            || expected.collectionId !== null || !isDeepStrictEqual(draft.sessions.get(value.sessionId), expected)) {
            throw new Error('bootstrap Session write condition failed');
          }
          draft.sessions.set(value.sessionId, copy(value));
        },
      },
      lanes: {
        load: async (lane) => copy(draft.lanes.get(bootstrapSequenceLaneKey(lane))),
        save: async (lane, state) => { draft.lanes.set(bootstrapSequenceLaneKey(lane), copy(state)); },
      },
      collections: {
        load: async (id) => copy(draft.aggregates.get(id)),
        save: async (value) => { draft.aggregates.set(value.collection.id, copy(value)); },
      },
      operations: {
        load: async (id) => copy(draft.operations.get(id)),
        append: async (value) => { draft.operations.set(value.opId, copy(value)); },
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
    };
  }
}

function activeSession(sessionId = 'session-unbound'): ActiveSyncSessionRecord {
  return {
    sessionId, principal: { type: 'user', id: 'alice' }, credential: { kind: 'token', id: 'token-1' },
    oauthClientId: 'client-1', origin: 'https://client.example', sessionScope: 'instance', protocolVersion: '0.1',
    collectionId: null, purpose: 'create_collection',
    authorizationScopes: ['collections:create', 'sync:bootstrap', 'sync:push'], status: 'active',
  };
}

function createOperation(
  replicaId = 'replica-1',
  operationId = 'bootstrap-operation',
): SyncInstanceCreatePush['operations'][0] {
  return {
    opId: operationId, replicaId, sequence: 1, type: 'create_collection', occurredAt: now,
    dependencies: [], baseRevision: null,
    payload: {
      collection: {
        kind: 'knowledge_collection', title: 'Scope Test', summary: 'Sequence scope fixture.',
        visibility: 'private',
        publication: { feedMode: 'release', includeNodeContent: 'summary', includeRelations: true }, extensions: {},
      },
      root: { title: 'Scope Test', folderRole: 'root', extensions: {} },
    },
    source: { adapterProfile: 'test-fixture', nativeEvent: 'bootstrap' },
  };
}

function bootstrapRequest(
  sessionId = 'session-unbound',
  replicaId = 'replica-1',
  operationId = 'bootstrap-operation',
): SessionBootstrapRequest {
  return {
    push: { sessionId, batchId: `batch.${sessionId}`, atomic: true, operations: [createOperation(replicaId, operationId)] },
    digest: `digest:${sessionId}:${replicaId}:${operationId}`, rejectedAt: now,
  };
}

function aggregate(identity: SessionBootstrapIdentity): SessionBootstrapCollectionAggregate {
  const collection: Collection = {
    schemaVersion: '0.1', id: identity.collectionId, kind: 'knowledge_collection', title: 'Scope Test',
    summary: 'Sequence scope fixture.', rootNodeId: identity.rootNodeId, visibility: 'private', createdAt: now,
    updatedAt: now, revision: identity.revision, extensions: {},
  };
  const root: Node = {
    id: identity.rootNodeId, collectionId: identity.collectionId, kind: 'root', parentId: null, position: null,
    folderRole: 'root', title: 'Scope Test', createdAt: now, updatedAt: now, revision: identity.revision,
    constraints: { readOnly: false, reason: null }, extensions: {},
  };
  return { collection, root };
}

function bootstrapPlan(
  handle: BootstrapHandle,
  status: 'applied' | 'deferred' | 'rejected' = 'applied',
  operationId = 'bootstrap-operation',
): SessionBootstrapPrepared<Audit, Outbox, SessionBootstrapTransaction<Audit, Outbox>> {
  if (status === 'deferred') return {
    status,
    apply: async () => {
      handle.applyCount += 1;
      return { opId: operationId, sequence: 1, status, code: 'pending', warnings: [] };
    },
  };
  if (status === 'rejected') return {
    status,
    apply: async () => {
      handle.applyCount += 1;
      return { opId: operationId, sequence: 1, status, code: 'denied', warnings: [] };
    },
    audit: async () => ({ id: 'audit-rejected' }),
  };
  return {
    status, warnings: [],
    apply: async (_transaction, identity) => {
      handle.applyCount += 1;
      return aggregate(identity);
    },
    audit: async () => ({ id: 'audit-applied' }),
    outbox: async () => ({ id: 'outbox-applied' }),
  };
}

async function bootstrap(handle: BootstrapHandle, status: 'applied' | 'deferred' | 'rejected' = 'applied') {
  return coordinateSessionBootstrap(handle, bootstrapRequest(), async () => {
    handle.prepareCount += 1;
    return bootstrapPlan(handle, status);
  });
}

describe(`SYNC-0011 Instance bootstrap Sequence scope transition ${evidence}`, () => {
  it(`uses the unbound sessionId as the Instance scope at Sequence 1 ${evidence}`, async () => {
    const handle = new BootstrapHandle();
    handle.state.sessions.set('session-unbound', activeSession());
    await bootstrap(handle, 'deferred');
    expect(handle.state.receiptsByLane.get(bootstrapLaneKey({ replicaId: 'replica-1', sessionId: 'session-unbound' })))
      .toMatchObject({ sessionId: 'session-unbound', replicaId: 'replica-1', sequence: 1 });
  });

  it(`successful binding consumes the Instance lane and starts the generated Collection lane at 1 ${evidence}`, async () => {
    const handle = new BootstrapHandle();
    handle.state.sessions.set('session-unbound', activeSession());
    await bootstrap(handle);
    expect(handle.state.lanes.get(bootstrapSequenceLaneKey({ scope: 'instance', replicaId: 'replica-1', sessionId: 'session-unbound' })))
      .toEqual({ nextSequence: 2 });
    expect(handle.state.lanes.get(bootstrapSequenceLaneKey({ scope: 'collection', replicaId: 'replica-1', collectionId: 'collection-generated' })))
      .toEqual({ nextSequence: 1 });
  });

  it(`rolls back both bootstrap Sequence lanes when their atomic commit fails ${evidence}`, async () => {
    const handle = new BootstrapHandle();
    handle.state.sessions.set('session-unbound', activeSession());
    handle.failBeforeCommit = true;
    await expect(bootstrap(handle)).rejects.toThrow('injected bootstrap rollback');
    expect(handle.state.lanes).toEqual(new Map());
    expect(handle.state.receiptsByLane).toEqual(new Map());
    expect(handle.state.sessions.get('session-unbound')).toEqual(activeSession());
  });

  it(`rejection consumes the Instance lane and requires a new Session for another create ${evidence}`, async () => {
    const handle = new BootstrapHandle();
    handle.state.sessions.set('session-unbound', activeSession());
    await bootstrap(handle, 'rejected');
    expect(handle.state.sessions.get('session-unbound')).toMatchObject({ status: 'terminated' });
    expect(handle.state.lanes.get(bootstrapSequenceLaneKey({ scope: 'instance', replicaId: 'replica-1', sessionId: 'session-unbound' })))
      .toEqual({ nextSequence: 2 });
    handle.state.sessions.set('session-new', activeSession('session-new'));
    const next = bootstrapRequest('session-new', 'replica-1', 'bootstrap-operation-new');
    await expect(coordinateSessionBootstrap(handle, next, async () => bootstrapPlan(handle, 'applied', 'bootstrap-operation-new')))
      .resolves.toMatchObject({ kind: 'executed' });
  });

  it(`deferred bootstrap remains on the same unconsumed Instance lane ${evidence}`, async () => {
    const handle = new BootstrapHandle();
    handle.state.sessions.set('session-unbound', activeSession());
    const first = await bootstrap(handle, 'deferred');
    const replay = await bootstrap(handle, 'applied');
    expect(replay).toEqual({ kind: 'replayed', result: first.kind === 'executed' ? first.result : undefined });
    expect(handle.state.lanes.has(bootstrapSequenceLaneKey({ scope: 'instance', replicaId: 'replica-1', sessionId: 'session-unbound' })))
      .toBe(false);
    expect(handle.applyCount).toBe(1);
  });

  it(`preserves opaque generated Collection and unbound Session identifiers exactly ${evidence}`, async () => {
    const handle = new BootstrapHandle();
    const sessionId = 'Session.A_01';
    const collectionId = '01.Collection-A_~';
    handle.identity = { collectionId, rootNodeId: 'root.opaque_01', revision: 'revision.opaque~01' };
    handle.state.sessions.set(sessionId, activeSession(sessionId));
    const candidate = bootstrapRequest(sessionId);
    const result = await coordinateSessionBootstrap(handle, candidate, async () => bootstrapPlan(handle));
    expect(result).toMatchObject({ result: { boundCollection: { collectionId } } });
    expect(handle.state.lanes.has(bootstrapSequenceLaneKey({ scope: 'instance', replicaId: 'replica-1', sessionId }))).toBe(true);
    expect(handle.state.lanes.has(bootstrapSequenceLaneKey({ scope: 'collection', replicaId: 'replica-1', collectionId }))).toBe(true);
  });

  it(`keeps separate unbound Session lanes independent in the bootstrap coordinator ${evidence}`, async () => {
    const handle = new BootstrapHandle();
    handle.state.sessions.set('session-a', activeSession('session-a'));
    handle.state.sessions.set('session-b', activeSession('session-b'));
    await coordinateSessionBootstrap(handle, bootstrapRequest('session-a', 'replica-1', 'operation-a'), async () => ({
      status: 'deferred', apply: async () => ({ opId: 'operation-a', sequence: 1, status: 'deferred', code: 'pending', warnings: [] }),
    }));
    await coordinateSessionBootstrap(handle, bootstrapRequest('session-b', 'replica-1', 'operation-b'), async () => ({
      status: 'deferred', apply: async () => ({ opId: 'operation-b', sequence: 1, status: 'deferred', code: 'pending', warnings: [] }),
    }));
    expect(handle.state.receiptsByLane.size).toBe(2);
  });

  it(`rejects a bootstrap receipt adapter mismatch across Session scopes ${evidence}`, async () => {
    const handle = new BootstrapHandle();
    handle.state.sessions.set('session-unbound', activeSession());
    const wrong: StoredSessionBootstrapReceipt = {
      operationId: 'bootstrap-operation', replicaId: 'replica-1', sessionId: 'session-other', sequence: 1,
      digest: bootstrapRequest().digest, status: 'deferred',
      result: { opId: 'bootstrap-operation', sequence: 1, status: 'deferred', code: 'pending', warnings: [] },
    };
    handle.state.receiptsByLane.set(bootstrapLaneKey({ replicaId: 'replica-1', sessionId: 'session-unbound' }), wrong);
    await expect(bootstrap(handle)).rejects.toThrow('another lane');
  });

  it(`exports the bootstrap coordinator from the Sync public API ${evidence}`, () => {
    expect(coordinateBootstrapFromSyncEntry).toBe(coordinateSessionBootstrap);
  });
});
