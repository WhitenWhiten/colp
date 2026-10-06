import { isDeepStrictEqual } from 'node:util';
import { describe, expect, it } from 'vitest';

import type { Collection, Node, Operation, SyncInstanceCreatePush } from '../../src/types/index.js';
import type { ActiveSyncSessionRecord, SyncSessionRecord } from '../../src/sync/session.js';
import type { SyncOperationClaim, SyncOperationReuseAudit } from '../../src/sync/operation-reuse.js';
import {
  coordinateSessionBootstrap,
  type SessionBootstrapCollectionAggregate,
  type SessionBootstrapIdentity,
  type SessionBootstrapLane,
  type SessionBootstrapPrepared,
  type SessionBootstrapRequest,
  type SessionBootstrapSequenceLane,
  type SessionBootstrapTransaction,
  type SessionBootstrapUnitOfWork,
  type StoredSessionBootstrapReceipt,
} from '../../src/sync/session-bootstrap.js';

const evidence = '[evidence:sync.session-bootstrap]';
const now = '2026-07-18T04:00:00Z';

type Audit = { readonly id: string; readonly kind: string };
type Outbox = { readonly id: string; readonly collectionId: string };
type FailurePoint =
  | 'collection' | 'root' | 'aggregate' | 'session' | 'operation'
  | 'receipt' | 'cursor' | 'lane' | 'audit' | 'outbox';

interface DurableState {
  sessions: Map<string, SyncSessionRecord>;
  lanes: Map<string, { nextSequence: number }>;
  aggregates: Map<string, SessionBootstrapCollectionAggregate>;
  collections: Map<string, Collection>;
  roots: Map<string, Node>;
  operations: Map<string, Operation>;
  receiptsByOperation: Map<string, StoredSessionBootstrapReceipt>;
  receiptsByLane: Map<string, StoredSessionBootstrapReceipt>;
  audits: Map<string, Audit>;
  outbox: Map<string, Outbox>;
  cursors: string[];
  operationClaims: Map<string, SyncOperationClaim>;
  reuseAudits: Map<string, SyncOperationReuseAudit>;
}

interface TestTransaction extends SessionBootstrapTransaction<Audit, Outbox> {
  saveCanonicalCollection(collection: Collection): Promise<void>;
  saveCanonicalRoot(root: Node): Promise<void>;
}

function copy<Value>(value: Value): Value {
  return structuredClone(value);
}

function emptyState(): DurableState {
  return {
    sessions: new Map(), lanes: new Map(), aggregates: new Map(), collections: new Map(),
    roots: new Map(), operations: new Map(), receiptsByOperation: new Map(),
    receiptsByLane: new Map(), audits: new Map(), outbox: new Map(), cursors: [], operationClaims: new Map(), reuseAudits: new Map(),
  };
}

function laneKey(lane: SessionBootstrapLane): string {
  return `${lane.replicaId}\u0000${lane.sessionId}`;
}

function sequenceLaneKey(lane: SessionBootstrapSequenceLane): string {
  return lane.scope === 'instance'
    ? `${lane.replicaId}\u0000${lane.sessionId}\u0000instance`
    : `${lane.replicaId}\u0000${lane.collectionId}\u0000collection`;
}

/** Publish a validated write set, never replace another transaction's whole snapshot. */
function mergeStagedState(before: DurableState, draft: DurableState, current: DurableState): DurableState {
  const merged = copy(current);
  const mapFields = [
    'sessions', 'lanes', 'aggregates', 'collections', 'roots', 'operations',
    'receiptsByOperation', 'receiptsByLane', 'audits', 'outbox', 'operationClaims', 'reuseAudits',
  ] as const;
  for (const field of mapFields) {
    const base: ReadonlyMap<string, unknown> = before[field];
    const changed: ReadonlyMap<string, unknown> = draft[field];
    const live: ReadonlyMap<string, unknown> = current[field];
    const target: Map<string, unknown> = merged[field];
    for (const key of new Set([...base.keys(), ...changed.keys()])) {
      if (base.has(key) === changed.has(key) && isDeepStrictEqual(base.get(key), changed.get(key))) continue;
      if (live.has(key) !== base.has(key) || !isDeepStrictEqual(live.get(key), base.get(key))) {
        throw new Error(`staging write conflict: ${field}/${key}`);
      }
      if (changed.has(key)) target.set(key, copy(changed.get(key)));
      else target.delete(key);
    }
  }
  if (!isDeepStrictEqual(before.cursors, draft.cursors)) {
    if (!isDeepStrictEqual(current.cursors, before.cursors)) throw new Error('staging Cursor allocation conflict');
    merged.cursors = copy(draft.cursors);
  }
  return merged;
}

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

class SharedStagingBackend {
  public state: DurableState = emptyState();
  public readonly tails = new Map<string, Promise<void>>();

  public snapshot(): DurableState {
    return copy(this.state);
  }
}

class DurableStagingHandle implements SessionBootstrapUnitOfWork<Audit, Outbox, TestTransaction> {
  readonly operationIdReservationOwner = 'session-bootstrap' as const;
  public fail?: FailurePoint;
  public drop?: FailurePoint;
  public rejectAfterCommit = false;
  public executeCount = 0;
  public prepareCount = 0;
  public applyCount = 0;
  public identity: SessionBootstrapIdentity = {
    collectionId: 'collection-server-1', rootNodeId: 'root-server-1', revision: 'revision-server-1',
  };

  public constructor(public readonly backend = new SharedStagingBackend()) {}

  public async execute<Value>(
    lane: SessionBootstrapLane,
    work: (transaction: TestTransaction) => Promise<Value>,
  ): Promise<Value> {
    this.executeCount += 1;
    // A Session is shared across Replica lanes; receipts still use laneKey.
    const key = lane.sessionId;
    const previous = this.backend.tails.get(key) ?? Promise.resolve();
    const run = async (): Promise<Value> => {
      const before = copy(this.backend.state);
      const draft = copy(before);
      const result = await work(this.transaction(draft));
      this.backend.state = mergeStagedState(before, draft, this.backend.state);
      if (this.rejectAfterCommit) {
        this.rejectAfterCommit = false;
        throw new Error('commit outcome unknown');
      }
      return result;
    };
    const outcome = previous.then(run, run);
    const tail = outcome.then(() => undefined, () => undefined);
    this.backend.tails.set(key, tail);
    void tail.then(() => {
      if (this.backend.tails.get(key) === tail) this.backend.tails.delete(key);
    });
    return outcome;
  }

  private write(point: FailurePoint, action: () => void): void {
    if (this.fail === point) throw new Error(`injected ${point} write failure`);
    if (this.drop !== point) action();
  }

  private transaction(draft: DurableState): TestTransaction {
    const artifactStore = <Artifact extends object>(
      point: 'audit' | 'outbox',
      target: Map<string, Artifact>,
    ) => ({
      append: async (artifact: Artifact): Promise<string> => {
        const key = `${point}-${target.size + 1}`;
        this.write(point, () => target.set(key, copy(artifact)));
        return key;
      },
      load: async (key: string): Promise<Artifact | undefined> => copy(target.get(key)),
    });
    return {
      idReservations: { reserveAll: async () => ({ state: 'reserved' }) },
      operationClaims: {
        load: async (id: string) => copy(draft.operationClaims.get(id)),
        save: async (claim: SyncOperationClaim) => { draft.operationClaims.set(claim.operationId, copy(claim)); },
      },
      reuseAudits: {
        append: async (audit: SyncOperationReuseAudit) => { const key = `reuse-${draft.reuseAudits.size + 1}`; draft.reuseAudits.set(key, copy(audit)); return key; },
        load: async (key: string) => copy(draft.reuseAudits.get(key)),
      },
      receipts: {
        findByOperationId: async (operationId) => copy(draft.receiptsByOperation.get(operationId)),
        findByLane: async (lane) => copy(draft.receiptsByLane.get(laneKey(lane))),
        save: async (receipt, condition) => {
          const current = draft.receiptsByLane.get(laneKey(receipt));
          if (condition.kind === 'absent' && current !== undefined) throw new Error('receipt exists');
          if (condition.kind === 'replace_deferred'
            && (current?.status !== 'deferred' || current.digest !== condition.digest)) {
            throw new Error('deferred replacement precondition failed');
          }
          this.write('receipt', () => {
            draft.receiptsByOperation.set(receipt.operationId, copy(receipt));
            draft.receiptsByLane.set(laneKey(receipt), copy(receipt));
          });
        },
      },
      sessions: {
        load: async (id) => copy(draft.sessions.get(id)),
        save: async (replacement, expected) => {
          if (expected === undefined || expected.status !== 'active'
            || expected.sessionScope !== 'instance' || expected.collectionId !== null
            || expected.sessionId !== replacement.sessionId
            || !isDeepStrictEqual(expected, draft.sessions.get(replacement.sessionId))
            || !isDeepStrictEqual(expected, this.backend.state.sessions.get(replacement.sessionId))) {
            throw new Error('bootstrap Session write condition failed');
          }
          this.write('session', () => draft.sessions.set(replacement.sessionId, copy(replacement)));
        },
      },
      lanes: {
        load: async (lane) => copy(draft.lanes.get(sequenceLaneKey(lane))),
        save: async (lane, state) => this.write('lane', () => draft.lanes.set(sequenceLaneKey(lane), copy(state))),
      },
      collections: {
        load: async (id) => copy(draft.aggregates.get(id)),
        save: async (aggregate) => this.write('aggregate', () => draft.aggregates.set(aggregate.collection.id, copy(aggregate))),
      },
      operations: {
        load: async (id) => copy(draft.operations.get(id)),
        append: async (operation) => this.write('operation', () => draft.operations.set(operation.opId, copy(operation))),
      },
      audits: artifactStore<Audit>('audit', draft.audits),
      outbox: artifactStore<Outbox>('outbox', draft.outbox),
      allocateIdentity: async () => copy(this.identity),
      allocateCursor: async () => {
        const cursor = `cursor-${draft.cursors.length + 1}`;
        this.write('cursor', () => draft.cursors.push(cursor));
        return cursor;
      },
      loadCursor: async (cursor) => draft.cursors.includes(cursor) ? cursor : undefined,
      saveCanonicalCollection: async (collection) => {
        this.write('collection', () => draft.collections.set(collection.id, copy(collection)));
        if (draft.collections.get(collection.id) === undefined) throw new Error('Collection staging read-back failed');
      },
      saveCanonicalRoot: async (root) => {
        this.write('root', () => draft.roots.set(root.id, copy(root)));
        if (draft.roots.get(root.id) === undefined) throw new Error('Root staging read-back failed');
      },
    };
  }
}

function session(overrides: Partial<ActiveSyncSessionRecord> = {}): ActiveSyncSessionRecord {
  return {
    sessionId: 'session-1', principal: { type: 'user', id: 'alice' },
    credential: { kind: 'token', id: 'token-1' }, oauthClientId: 'client-1',
    origin: 'https://client.example', sessionScope: 'instance', protocolVersion: '0.1',
    collectionId: null, purpose: 'create_collection',
    authorizationScopes: ['collections:create', 'sync:bootstrap', 'sync:push'], status: 'active',
    ...overrides,
  };
}

function operation(): SyncInstanceCreatePush['operations'][0] {
  return {
    opId: 'operation-1', replicaId: 'replica-1', sequence: 1, type: 'create_collection',
    occurredAt: now, dependencies: [], baseRevision: null,
    payload: {
      collection: {
        kind: 'knowledge_collection', title: 'Interface Systems',
        summary: 'A curated path into design engineering.', visibility: 'private',
        publication: { feedMode: 'release', includeNodeContent: 'summary', includeRelations: true },
        extensions: {},
      },
      root: { title: 'Interface Systems', folderRole: 'root', extensions: {} },
    },
    source: { adapterProfile: 'test-fixture', nativeEvent: 'bootstrap' },
  };
}

function request(overrides: Partial<SessionBootstrapRequest> = {}): SessionBootstrapRequest {
  return {
    push: { sessionId: 'session-1', batchId: 'batch-1', atomic: true, operations: [operation()] },
    digest: 'sha-256:canonical-create', rejectedAt: now, ...overrides,
  };
}

function aggregate(identity: SessionBootstrapIdentity): SessionBootstrapCollectionAggregate {
  const collection: Collection = {
    schemaVersion: '0.1', id: identity.collectionId, kind: 'knowledge_collection',
    title: 'Interface Systems', summary: 'A curated path into design engineering.',
    rootNodeId: identity.rootNodeId, visibility: 'private', createdAt: now, updatedAt: now,
    revision: identity.revision, extensions: {},
  };
  const root: Node = {
    id: identity.rootNodeId, collectionId: identity.collectionId, kind: 'root', parentId: null,
    position: null, folderRole: 'root', title: 'Interface Systems', createdAt: now, updatedAt: now,
    revision: identity.revision, constraints: { readOnly: false, reason: null }, extensions: {},
  };
  return { collection, root };
}

function appliedPlan(handle: DurableStagingHandle): SessionBootstrapPrepared<Audit, Outbox, TestTransaction> {
  return {
    status: 'applied', warnings: [], transform: { source: 'canonical' },
    apply: async (transaction, identity) => {
      handle.applyCount += 1;
      const value = aggregate(identity);
      await transaction.saveCanonicalCollection(value.collection);
      await transaction.saveCanonicalRoot(value.root);
      return value;
    },
    audit: async (context) => ({ id: 'audit-applied', kind: context.result.status }),
    outbox: async (context) => ({ id: 'outbox-applied', collectionId: context.session.collectionId! }),
  };
}

function rejectedPlan(handle: DurableStagingHandle): SessionBootstrapPrepared<Audit, Outbox, TestTransaction> {
  return {
    status: 'rejected',
    apply: async () => {
      handle.applyCount += 1;
      return { opId: 'operation-1', sequence: 1, status: 'rejected', code: 'policy_denied', warnings: [] };
    },
    audit: async (context) => ({ id: 'audit-rejected', kind: context.result.status }),
  };
}

async function coordinate(
  handle: DurableStagingHandle,
  candidate = request(),
  plan: SessionBootstrapPrepared<Audit, Outbox, TestTransaction> = appliedPlan(handle),
) {
  return coordinateSessionBootstrap(handle, candidate, async () => {
    handle.prepareCount += 1;
    return plan;
  });
}

describe(`SYNC-0007 constrained Session bootstrap staging boundaries ${evidence}`, () => {
  it(`rejects an aggregate that does not use the allocated Root identity and rolls back ${evidence}`, async () => {
    const handle = new DurableStagingHandle();
    handle.backend.state.sessions.set('session-1', session());
    const wrong = appliedPlan(handle);
    const malicious = {
      ...wrong,
      apply: async (_transaction: TestTransaction, identity: SessionBootstrapIdentity) => {
        const value = aggregate(identity);
        return { ...value, root: { ...value.root, id: 'root-client-forged' } };
      },
    } as SessionBootstrapPrepared<Audit, Outbox, TestTransaction>;
    const before = handle.backend.snapshot();
    await expect(coordinate(handle, request(), malicious)).rejects.toThrow('allocated server identity');
    expect(handle.backend.snapshot()).toEqual(before);
  });

  it(`covers bootstrap request and prepared-result validation boundaries ${evidence}`, async () => {
    const handle = new DurableStagingHandle();
    handle.backend.state.sessions.set('session-1', session());
    await expect(coordinateSessionBootstrap(handle, request(), undefined as never)).rejects.toThrow(/prepare must be a function/i);
    for (const candidate of [
      null,
      [],
      { ...request(), reevaluateDeferred: 'yes' },
      (() => { const value = request() as any; value.push.operations[0].collectionId = 'client-owned'; return value; })(),
    ]) {
      await expect(coordinateSessionBootstrap(handle, candidate as never, async () => appliedPlan(handle))).rejects.toThrow();
    }

    for (const [index, malformed] of [
      { ...appliedPlan(handle), warnings: 'not-an-array' },
      { ...appliedPlan(handle), apply: undefined },
      { ...appliedPlan(handle), audit: undefined },
      { ...rejectedPlan(handle), audit: undefined },
    ].entries()) {
      await expect(coordinateSessionBootstrap(handle, request({ digest: `sha-256:malformed-${index}` }), async () => malformed as never)).rejects.toThrow();
    }
  });

  it.each(['applied', 'rejected'] as const)(
    `serializes different Replica lanes sharing one Session after a %s winner ${evidence}`,
    async (status) => {
      const backend = new SharedStagingBackend();
      backend.state.sessions.set('session-1', session());
      const first = new DurableStagingHandle(backend);
      const second = new DurableStagingHandle(backend);
      second.identity = { collectionId: 'collection-server-2', rootNodeId: 'root-server-2', revision: 'revision-2' };
      const entered = barrier();
      const release = barrier();
      const winner = coordinateSessionBootstrap(first, request(), async () => {
        first.prepareCount += 1;
        entered.release();
        await release.promise;
        return status === 'applied' ? appliedPlan(first) : rejectedPlan(first);
      });
      await entered.promise;
      const retry = request({ digest: 'sha-256:second-replica' });
      const other: SessionBootstrapRequest = {
        ...retry,
        push: {
          ...retry.push,
          operations: [{ ...operation(), opId: 'operation-2', replicaId: 'replica-2' }],
        },
      };
      const loser = coordinate(second, other);
      release.release();
      const outcomes = await Promise.all([winner, loser]);
      expect(outcomes[0]).toMatchObject({ kind: 'executed', result: { status } });
      expect(outcomes[1]).toEqual({ kind: 'session_unavailable' });
      expect(first.prepareCount).toBe(1);
      expect(second.prepareCount).toBe(0);
      expect(second.applyCount).toBe(0);
      expect(backend.state.collections.size).toBe(status === 'applied' ? 1 : 0);
      expect(backend.state.receiptsByOperation.size).toBe(1);
      expect(backend.state.operationClaims.size).toBe(1);
      expect(backend.state.audits.size).toBe(1);
      expect(backend.state.outbox.size).toBe(status === 'applied' ? 1 : 0);
      expect(backend.state.sessions.get('session-1')).toMatchObject(status === 'applied'
        ? { status: 'active', collectionId: first.identity.collectionId }
        : { status: 'terminated', terminationReason: 'bootstrap_rejected' });
    },
  );

  it.each(['applied', 'rejected'] as const)(
    `rolls back a stale %s plan instead of overwriting concurrent termination ${evidence}`,
    async (status) => {
      const handle = new DurableStagingHandle();
      const initial = session();
      handle.backend.state.sessions.set(initial.sessionId, initial);
      const before = handle.backend.snapshot();
      const terminated: SyncSessionRecord = {
        ...initial, status: 'terminated', terminationReason: 'administrative', terminatedAt: now,
      };
      await expect(coordinateSessionBootstrap(handle, request(), async () => {
        // Independent writer commits after the coordinator's initial Session read.
        handle.backend.state.sessions.set(initial.sessionId, copy(terminated));
        return status === 'applied' ? appliedPlan(handle) : rejectedPlan(handle);
      })).rejects.toThrow('Session write condition failed');
      before.sessions.set(initial.sessionId, terminated);
      expect(handle.backend.snapshot()).toEqual(before);
    },
  );

  it(`does not publish stale Session state when termination races after conditional save ${evidence}`, async () => {
    const handle = new DurableStagingHandle();
    const initial = session();
    handle.backend.state.sessions.set(initial.sessionId, initial);
    const before = handle.backend.snapshot();
    const terminated: SyncSessionRecord = {
      ...initial, status: 'terminated', terminationReason: 'administrative', terminatedAt: now,
    };
    const plan = appliedPlan(handle);
    if (plan.status !== 'applied') throw new Error('Expected applied plan');
    await expect(coordinate(handle, request(), {
      ...plan,
      audit: async (context) => {
        handle.backend.state.sessions.set(initial.sessionId, copy(terminated));
        return plan.audit(context);
      },
    })).rejects.toThrow('staging write conflict');
    before.sessions.set(initial.sessionId, terminated);
    expect(handle.backend.snapshot()).toEqual(before);
  });

  it(`fixture merges disjoint transaction writes without losing either commit ${evidence}`, async () => {
    const backend = new SharedStagingBackend();
    const first = new DurableStagingHandle(backend);
    const second = new DurableStagingHandle(backend);
    const bothEntered = barrier();
    let entered = 0;
    const run = (handle: DurableStagingHandle, id: string) => handle.execute(
      { replicaId: id, sessionId: id }, async (transaction) => {
        entered += 1;
        if (entered === 2) bothEntered.release();
        await bothEntered.promise;
        await transaction.lanes.save({ scope: 'instance', replicaId: id, sessionId: id }, { nextSequence: 2 });
        return id;
      },
    );
    await Promise.all([run(first, 'first'), run(second, 'second')]);
    expect(backend.state.lanes.size).toBe(2);
    for (const id of ['first', 'second']) {
      expect(backend.state.lanes.get(sequenceLaneKey({ scope: 'instance', replicaId: id, sessionId: id })))
        .toEqual({ nextSequence: 2 });
    }
  });

});
