import { isDeepStrictEqual } from 'node:util';
import { describe, expect, it, vi } from 'vitest';

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

function deferredPlan(handle: DurableStagingHandle): SessionBootstrapPrepared<Audit, Outbox, TestTransaction> {
  return {
    status: 'deferred',
    apply: async () => {
      handle.applyCount += 1;
      return { opId: 'operation-1', sequence: 1, status: 'deferred', code: 'dependency_pending', warnings: [] };
    },
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

describe(`SYNC-0007 constrained Session bootstrap ${evidence}`, () => {
  it(`applies the canonical create and uses only server-generated Collection and Root identities ${evidence}`, async () => {
    const handle = new DurableStagingHandle();
    handle.backend.state.sessions.set('session-1', session());
    const original = request();
    const result = await coordinate(handle, original);

    expect(result).toEqual({
      kind: 'executed',
      result: {
        opId: 'operation-1', sequence: 1, status: 'applied', warnings: [],
        revision: 'revision-server-1', cursor: 'cursor-1',
        boundCollection: {
          collectionId: 'collection-server-1', snapshotRequired: false,
          serverCursor: 'cursor-1', serverRevision: 'revision-server-1',
        },
        transform: { source: 'canonical' },
      },
    });
    expect(original.push.operations[0]).not.toHaveProperty('collectionId');
    expect(original.push.operations[0]).not.toHaveProperty('targetId');
    expect(handle.backend.state.collections.get('collection-server-1')?.rootNodeId).toBe('root-server-1');
    expect(handle.backend.state.roots.get('root-server-1')?.collectionId).toBe('collection-server-1');
  });

  it(`binds the Session while preserving every non-binding field and sets both lane states ${evidence}`, async () => {
    const handle = new DurableStagingHandle();
    const initial = session();
    const unrelated = session({ sessionId: 'session-2' });
    handle.backend.state.sessions.set(initial.sessionId, copy(initial));
    handle.backend.state.sessions.set(unrelated.sessionId, copy(unrelated));
    await coordinate(handle);
    const bound = handle.backend.state.sessions.get(initial.sessionId)!;

    expect(bound).toEqual({ ...initial, sessionScope: 'collection', collectionId: 'collection-server-1', purpose: null });
    expect(handle.backend.state.sessions.get(unrelated.sessionId)).toEqual(unrelated);
    expect(handle.backend.state.lanes.get('replica-1\u0000session-1\u0000instance')).toEqual({ nextSequence: 2 });
    expect(handle.backend.state.lanes.get('replica-1\u0000collection-server-1\u0000collection'))
      .toEqual({ nextSequence: 1 });
    expect(handle.backend.state.receiptsByOperation.get('operation-1')?.result).toMatchObject({
      revision: 'revision-server-1', cursor: 'cursor-1',
    });
  });

  it.each([
    ['atomic false', (value: any) => { value.push.atomic = false; }],
    ['multiple Operations', (value: any) => { value.push.operations.push(operation()); }],
    ['non-create Operation', (value: any) => { value.push.operations[0].type = 'update_collection_metadata'; }],
    ['Sequence other than 1', (value: any) => { value.push.operations[0].sequence = 2; }],
    ['client collectionId', (value: any) => { value.push.operations[0].collectionId = 'client-collection'; }],
    ['client targetId', (value: any) => { value.push.operations[0].targetId = 'client-root'; }],
    ['non-null baseRevision', (value: any) => { value.push.operations[0].baseRevision = 'revision-client'; }],
    ['calendar-invalid rejectedAt', (value: any) => { value.rejectedAt = '2026-02-31T04:00:00Z'; }],
    ['unrepresentable rejectedAt', (value: any) => { value.rejectedAt = '2024-06-30T23:59:60Z'; }],
  ])(`rejects %s before entering the UnitOfWork ${evidence}`, async (_label, mutate) => {
    const handle = new DurableStagingHandle();
    const invalid: any = request();
    mutate(invalid);
    await expect(coordinate(handle, invalid)).rejects.toThrow();
    expect(handle.executeCount).toBe(0);
    expect(handle.backend.snapshot()).toEqual(emptyState());
  });

  it(`accepts a representable RFC 3339 rejectedAt with an offset ${evidence}`, async () => {
    const handle = new DurableStagingHandle();
    handle.backend.state.sessions.set('session-1', session());
    await expect(coordinate(handle, request({ rejectedAt: '2026-07-18T12:00:00+08:00' }), rejectedPlan(handle)))
      .resolves.toMatchObject({ result: { status: 'rejected' } });
    expect(handle.backend.state.sessions.get('session-1')).toMatchObject({
      terminatedAt: '2026-07-18T12:00:00+08:00',
    });
  });

  it(`keys a collection lane by Replica and Collection only across Sessions ${evidence}`, () => {
    const fromSessionOne: SessionBootstrapSequenceLane = {
      scope: 'collection', replicaId: 'replica-1', collectionId: 'collection-server-1',
    };
    const fromSessionTwo: SessionBootstrapSequenceLane = {
      scope: 'collection', replicaId: 'replica-1', collectionId: 'collection-server-1',
    };
    const lanes = new Map([[sequenceLaneKey(fromSessionOne), { nextSequence: 7 }]]);
    expect(sequenceLaneKey(fromSessionTwo)).toBe(sequenceLaneKey(fromSessionOne));
    expect(lanes.get(sequenceLaneKey(fromSessionTwo))).toEqual({ nextSequence: 7 });
    expect(fromSessionTwo).not.toHaveProperty('sessionId');
  });

  it.each([
    ['not found', undefined],
    ['terminated', { ...session(), status: 'terminated', terminationReason: 'administrative', terminatedAt: now }],
    ['collection-bound', { ...session(), sessionScope: 'collection', collectionId: 'collection-old', purpose: null }],
    ['wrong purpose', { ...session(), purpose: null }],
  ] as const)(`returns session_unavailable for a %s Session without preparing ${evidence}`, async (_label, stored) => {
    const handle = new DurableStagingHandle();
    if (stored !== undefined) handle.backend.state.sessions.set('session-1', stored as SyncSessionRecord);
    const before = handle.backend.snapshot();
    await expect(coordinate(handle)).resolves.toEqual({ kind: 'session_unavailable' });
    expect(handle.prepareCount).toBe(0);
    expect(handle.backend.snapshot()).toEqual(before);
  });

  it.each(['sync:bootstrap', 'sync:push', 'collections:create'] as const)(
    `returns session_unavailable when %s Scope is absent ${evidence}`,
    async (missing) => {
      const handle = new DurableStagingHandle();
      handle.backend.state.sessions.set('session-1', session({
        authorizationScopes: session().authorizationScopes.filter((scope) => scope !== missing),
      }));
      await expect(coordinate(handle)).resolves.toEqual({ kind: 'session_unavailable' });
      expect(handle.prepareCount).toBe(0);
    },
  );

  it(`exactly replays an applied receipt without invoking prepare or apply again ${evidence}`, async () => {
    const handle = new DurableStagingHandle();
    handle.backend.state.sessions.set('session-1', session());
    const first = await coordinate(handle);
    const replay = await coordinate(handle);
    expect(replay).toEqual({ kind: 'replayed', result: first.kind === 'executed' ? first.result : undefined });
    expect(handle.prepareCount).toBe(1);
    expect(handle.applyCount).toBe(1);
  });

  it.each([
    ['different digest', request({ digest: 'sha-256:different' }), 'sequence_reuse'],
    ['different operation id', (() => { const value: any = request(); value.push.operations[0].opId = 'operation-2'; return value; })(), 'sequence_reuse'],
    ['second create', (() => { const value: any = request(); value.push.operations[0].opId = 'operation-2'; value.digest = 'sha-256:second'; return value; })(), 'sequence_reuse'],
  ] as const)(`rejects %s at the receipt boundary ${evidence}`, async (_label, retry, kind) => {
    const handle = new DurableStagingHandle();
    handle.backend.state.sessions.set('session-1', session());
    await coordinate(handle);
    const auditsBeforeReuse = handle.backend.state.audits.size;
    await expect(coordinate(handle, retry)).resolves.toMatchObject({ kind });
    expect(handle.applyCount).toBe(1);
    expect(handle.backend.state.audits.size).toBe(auditsBeforeReuse);
  });

  it(`rejects a second create on a different Replica lane without mutation ${evidence}`, async () => {
    const handle = new DurableStagingHandle();
    handle.backend.state.sessions.set('session-1', session());
    await coordinate(handle);
    const before = handle.backend.snapshot();
    const retry: any = request({ digest: 'sha-256:second-lane' });
    retry.push.operations[0].opId = 'operation-2';
    retry.push.operations[0].replicaId = 'replica-2';
    await expect(coordinate(handle, retry)).resolves.toEqual({ kind: 'session_unavailable' });
    expect(handle.backend.snapshot()).toEqual(before);
  });

  it(`keeps deferred unbound at instance lane 1 and exact replay is the default ${evidence}`, async () => {
    const handle = new DurableStagingHandle();
    handle.backend.state.sessions.set('session-1', session());
    const first = await coordinate(handle, request(), deferredPlan(handle));
    const replay = await coordinate(handle, request(), appliedPlan(handle));
    expect(first).toMatchObject({ kind: 'executed', result: { status: 'deferred' } });
    expect(replay).toEqual({ kind: 'replayed', result: first.kind === 'executed' ? first.result : undefined });
    expect(handle.backend.state.sessions.get('session-1')).toEqual(session());
    expect(handle.backend.state.lanes.get('replica-1\u0000session-1\u0000instance')).toBeUndefined();
    expect(handle.backend.state.collections.size).toBe(0);
  });

  it.each(['applied', 'rejected'] as const)(
    `explicitly re-evaluates a deferred receipt to %s ${evidence}`,
    async (terminal) => {
      const handle = new DurableStagingHandle();
      handle.backend.state.sessions.set('session-1', session());
      await coordinate(handle, request(), deferredPlan(handle));
      const prepare = vi.fn(async (context) => {
        expect(context.previousDeferredReceipt?.status).toBe('deferred');
        return terminal === 'applied' ? appliedPlan(handle) : rejectedPlan(handle);
      });
      const result = await coordinateSessionBootstrap(handle, request({ reevaluateDeferred: true }), prepare);
      expect(result).toMatchObject({ kind: 'executed', result: { status: terminal } });
      expect(prepare).toHaveBeenCalledOnce();
    },
  );

  it(`preserves the persisted deferred result when re-evaluation remains deferred ${evidence}`, async () => {
    const handle = new DurableStagingHandle();
    handle.backend.state.sessions.set('session-1', session());
    const first = await coordinate(handle, request(), deferredPlan(handle));
    const before = handle.backend.snapshot();
    const apply = vi.fn(async () => ({
      opId: 'operation-1', sequence: 1 as const, status: 'deferred' as const,
      code: 'different_deferred_reason', warnings: [],
    }));
    const prepare = vi.fn(async () => ({ status: 'deferred' as const, apply }));

    await expect(coordinateSessionBootstrap(handle, request({ reevaluateDeferred: true }), prepare)).resolves.toEqual({
      kind: 'replayed', result: first.kind === 'executed' ? first.result : undefined,
    });
    expect(prepare).toHaveBeenCalledOnce();
    expect(apply).not.toHaveBeenCalled();
    expect(handle.backend.snapshot()).toEqual(before);
  });

  it(`a rejected bootstrap consumes no Cursor, consumes instance lane 1, and terminates bootstrap_rejected ${evidence}`, async () => {
    const handle = new DurableStagingHandle();
    handle.backend.state.sessions.set('session-1', session());
    const result = await coordinate(handle, request(), rejectedPlan(handle));
    expect(result).toMatchObject({ kind: 'executed', result: { status: 'rejected', code: 'policy_denied' } });
    expect(handle.backend.state.cursors).toEqual([]);
    expect(handle.backend.state.lanes.get('replica-1\u0000session-1\u0000instance')).toEqual({ nextSequence: 2 });
    expect(handle.backend.state.sessions.get('session-1')).toMatchObject({
      status: 'terminated', terminationReason: 'bootstrap_rejected', terminatedAt: now,
    });
    expect(handle.backend.state.aggregates.size).toBe(0);
  });

  it(`exactly replays a rejected receipt after the Session is terminated ${evidence}`, async () => {
    const handle = new DurableStagingHandle();
    handle.backend.state.sessions.set('session-1', session());
    const first = await coordinate(handle, request(), rejectedPlan(handle));
    await expect(coordinate(handle)).resolves.toEqual({
      kind: 'replayed',
      result: first.kind === 'executed' ? first.result : undefined,
    });
    expect(handle.applyCount).toBe(1);
  });

  it.each([
    'collection', 'root', 'aggregate', 'session', 'operation', 'receipt', 'cursor', 'lane', 'audit', 'outbox',
  ] as const)(`rolls every staging resource back after a %s write failure ${evidence}`, async (point) => {
    const handle = new DurableStagingHandle();
    handle.backend.state.sessions.set('session-1', session());
    const before = handle.backend.snapshot();
    handle.fail = point;
    await expect(coordinate(handle)).rejects.toThrow(`injected ${point} write failure`);
    expect(handle.backend.snapshot()).toEqual(before);
  });

  it.each([
    'collection', 'root', 'aggregate', 'session', 'operation', 'receipt', 'cursor', 'lane', 'audit', 'outbox',
  ] as const)(`detects a silently dropped %s staging write and rolls back ${evidence}`, async (point) => {
    const handle = new DurableStagingHandle();
    handle.backend.state.sessions.set('session-1', session());
    const before = handle.backend.snapshot();
    handle.drop = point;
    await expect(coordinate(handle)).rejects.toThrow(/read-back|not persisted|durable indexes/);
    expect(handle.backend.snapshot()).toEqual(before);
  });

  it(`does not claim success after commit-unknown and an exact retry resolves by replay ${evidence}`, async () => {
    const handle = new DurableStagingHandle();
    handle.backend.state.sessions.set('session-1', session());
    handle.rejectAfterCommit = true;
    await expect(coordinate(handle)).rejects.toThrow('commit outcome unknown');
    await expect(coordinate(handle)).resolves.toMatchObject({ kind: 'replayed', result: { status: 'applied' } });
    expect(handle.applyCount).toBe(1);
  });

  it.each(['zero', 'twice', 'forged'] as const)(
    `rejects a UnitOfWork callback contract violation: %s ${evidence}`,
    async (behavior) => {
      const base = new DurableStagingHandle();
      base.backend.state.sessions.set('session-1', session());
      const malicious: SessionBootstrapUnitOfWork<Audit, Outbox, TestTransaction> = {
        operationIdReservationOwner: 'session-bootstrap',
        execute: async <Value>(lane: SessionBootstrapLane, work: (transaction: TestTransaction) => Promise<Value>) => {
          if (behavior === 'zero') return {} as Value;
          let value!: Value;
          await base.execute(lane, async (transaction) => {
            value = await work(transaction);
            if (behavior === 'twice') await work(transaction);
            return value;
          });
          return behavior === 'forged' ? copy(value) : value;
        },
      };
      await expect(coordinateSessionBootstrap(malicious, request(), async () => appliedPlan(base)))
        .rejects.toThrow(/exactly once|callback result by identity/);
    },
  );

  it.each(['unit-of-work', 'prepare', 'apply', 'session-load', 'receipt-load', 'cursor', 'cursor-load'] as const)(
    `rejects a synchronous %s port ${evidence}`,
    async (point) => {
      const base = new DurableStagingHandle();
      base.backend.state.sessions.set('session-1', session());
      if (point === 'unit-of-work') {
        await expect(coordinateSessionBootstrap({
          operationIdReservationOwner: 'session-bootstrap',
          execute: (() => undefined) as never,
        }, request(), async () => appliedPlan(base)))
          .rejects.toThrow('must return a Promise');
        return;
      }
      const unit: SessionBootstrapUnitOfWork<Audit, Outbox, TestTransaction> = {
        operationIdReservationOwner: 'session-bootstrap',
        execute: (lane, work) => base.execute(lane, (transaction) => work({
          ...transaction,
          sessions: point === 'session-load'
            ? { ...transaction.sessions, load: (() => undefined) as never }
            : transaction.sessions,
          receipts: point === 'receipt-load'
            ? { ...transaction.receipts, findByOperationId: (() => undefined) as never }
            : transaction.receipts,
          allocateCursor: point === 'cursor' ? (() => 'cursor-sync') as never : transaction.allocateCursor,
          loadCursor: point === 'cursor-load' ? (() => 'cursor-sync') as never : transaction.loadCursor,
        })),
      };
      const prepare = point === 'prepare'
        ? (() => appliedPlan(base)) as never
        : async () => {
          const plan = appliedPlan(base);
          return point === 'apply' ? { ...plan, apply: (() => aggregate(base.identity)) as never } : plan;
        };
      await expect(coordinateSessionBootstrap(unit, request(), prepare)).rejects.toThrow('must return a Promise');
    },
  );

  it.each(['operation', 'lane'] as const)(
    `rejects an adapter receipt lookup for the wrong %s key without a reuse false positive ${evidence}`,
    async (index) => {
      const base = new DurableStagingHandle();
      base.backend.state.sessions.set('session-1', session());
      await coordinate(base);
      const unit: SessionBootstrapUnitOfWork<Audit, Outbox, TestTransaction> = {
        operationIdReservationOwner: 'session-bootstrap',
        execute: (lane, work) => base.execute(lane, (transaction) => work({
          ...transaction,
          receipts: {
            ...transaction.receipts,
            findByOperationId: index === 'operation'
              ? async () => {
                  const stored = base.backend.state.receiptsByOperation.get('operation-1')!;
                  return {
                    ...stored,
                    operationId: 'wrong-operation',
                    result: { ...stored.result, opId: 'wrong-operation' },
                  };
                }
              : transaction.receipts.findByOperationId,
            findByLane: index === 'lane'
              ? async () => ({ ...base.backend.state.receiptsByLane.values().next().value!, replicaId: 'wrong-replica' })
              : transaction.receipts.findByLane,
          },
        })),
      };
      await expect(coordinateSessionBootstrap(unit, request(), async () => appliedPlan(base)))
        .rejects.toThrow(/index returned a receipt for another/);
    },
  );

  it(`shares durable staging across independent handles without claiming Map cross-process durability ${evidence}`, async () => {
    const backend = new SharedStagingBackend();
    backend.state.sessions.set('session-1', session());
    const first = new DurableStagingHandle(backend);
    const second = new DurableStagingHandle(backend);
    await coordinate(first);
    await expect(coordinate(second)).resolves.toMatchObject({ kind: 'replayed' });
    expect(second.applyCount).toBe(0);
  });

  it(`serializes same-lane handles and executes the create exactly once ${evidence}`, async () => {
    const backend = new SharedStagingBackend();
    backend.state.sessions.set('session-1', session());
    const first = new DurableStagingHandle(backend);
    const second = new DurableStagingHandle(backend);
    const results = await Promise.all([coordinate(first), coordinate(second)]);
    expect(results.map((value) => value.kind).sort()).toEqual(['executed', 'replayed']);
    expect(first.applyCount + second.applyCount).toBe(1);
  });

  it(`detaches and freezes returned, callback, and persisted data against mutation ${evidence}`, async () => {
    const handle = new DurableStagingHandle();
    handle.backend.state.sessions.set('session-1', session());
    const candidate = request();
    let captured: unknown;
    const result = await coordinateSessionBootstrap(handle, candidate, async (context) => {
      captured = context;
      return appliedPlan(handle);
    });
    if (result.kind !== 'executed' && result.kind !== 'replayed') throw new Error('Expected execution.');
    candidate.push.operations[0].payload.collection.title = 'caller mutation';
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(captured)).toBe(true);
    expect(() => ((result.result as { status: string }).status = 'rejected')).toThrow(TypeError);
    expect(handle.backend.state.operations.get('operation-1')?.payload).toMatchObject({
      collection: { title: 'Interface Systems' },
    });
    await expect(coordinate(handle)).resolves.toEqual({ kind: 'replayed', result: result.result });
  });

});
