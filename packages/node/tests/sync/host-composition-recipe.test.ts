import { describe, expect, it, vi } from 'vitest';

import type { Operation, OperationResult } from '../../src/types/index.js';
import * as recipeModule from '../../src/sync/host-composition-recipe.js';
import {
  SYNC_HOST_COMPOSITION_NOTES,
  SYNC_HOST_COMPOSITION_RECIPE,
  SYNC_HOST_RECOMMENDED_WRITE_PATHS,
  SyncSessionGateDeniedError,
  bindSyncPushBatchId,
  coordinateSessionBoundPush,
  createSyncSession,
  createTypedUpdateMergePushPreflight,
  isSyncTypedUpdateOperation,
  isSyncTypedUpdateOperationType,
  mergeSyncTypedUpdate,
  type ActiveSyncSessionRecord,
  type CreateSyncSessionInput,
  type PushPreparedOperation,
  type PushTransactionOperation,
  type PushTransactionRequest,
  type StoredOperationReceipt,
  type SyncSessionBinding,
  type SyncSessionRecord,
  type SyncSessionStore,
  type SyncSessionStoreCreateResult,
  type SyncSessionTermination,
  type SyncTransaction,
  type SyncUnitOfWork,
  type TypedUpdateMergeConflictPlanContext,
  type TypedUpdateMergeMergedPlanContext,
  type VerifySyncSessionContextInput,
} from '../../src/sync/index.js';
import * as syncApi from '../../src/sync/index.js';

/**
 * Evidence for the official host composition recipe:
 * Session-first order, exclusive opId ownership, and typed-update merge
 * glued into Push preflight via `createTypedUpdateMergePushPreflight`.
 */
const evidence = '[evidence:sync.host-composition-recipe]';

const timestamp = '2026-07-18T00:00:00Z';

// ---------------------------------------------------------------------------
// Fixtures: typed update / delete ops and preflight plan builders
// ---------------------------------------------------------------------------

type DataObject = Readonly<Record<string, unknown>>;

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

type TestTransaction = SyncTransaction<Operation, OperationResult, Conflict, Audit, Outbox>;
type TestPlan = PushPreparedOperation<TestTransaction, Conflict, Audit, Outbox>;

function typedUpdateItem(options: {
  readonly opId?: string;
  readonly sequence?: number;
  readonly digest?: string;
  readonly base: DataObject;
  readonly value: DataObject;
}): PushTransactionOperation {
  const opId = options.opId ?? 'operation-typed-1';
  const sequence = options.sequence ?? 1;
  return {
    sequenceScope: 'collection-1',
    digest: options.digest ?? `digest-${opId}`,
    operation: {
      opId,
      replicaId: 'replica-1',
      sequence,
      type: 'update_node_content',
      occurredAt: timestamp,
      collectionId: 'collection-1',
      targetId: 'node-1',
      baseRevision: 'revision-1',
      payload: {
        base: options.base,
        value: options.value,
      },
    },
  };
}

function deleteNodeItem(options: {
  readonly opId?: string;
  readonly sequence?: number;
  readonly digest?: string;
} = {}): PushTransactionOperation {
  const opId = options.opId ?? 'operation-delete-1';
  const sequence = options.sequence ?? 1;
  return {
    sequenceScope: 'collection-1',
    digest: options.digest ?? `digest-${opId}`,
    operation: {
      opId,
      replicaId: 'replica-1',
      sequence,
      type: 'delete_node',
      occurredAt: timestamp,
      collectionId: 'collection-1',
      targetId: 'node-1',
      baseRevision: 'revision-1',
      payload: {},
    },
  };
}

function appliedPlan(operation: Operation, status: 'applied' | 'rebased' = 'applied'): TestPlan {
  if (status === 'rebased') {
    return {
      status: 'rebased',
      apply: async () => ({
        opId: operation.opId,
        sequence: operation.sequence,
        status: 'rebased' as const,
        warnings: [],
        revision: `revision-applied-${operation.opId}`,
      }),
      audit: async (context) => ({
        id: `audit-${operation.opId}`,
        result: { status: context.result.status },
      }),
      outbox: async (context) => ({
        id: `outbox-${operation.opId}`,
        cursor: context.cursor!,
      }),
    };
  }
  return {
    status: 'applied',
    apply: async () => ({
      opId: operation.opId,
      sequence: operation.sequence,
      status: 'applied' as const,
      warnings: [],
      revision: `revision-applied-${operation.opId}`,
    }),
    audit: async (context) => ({
      id: `audit-${operation.opId}`,
      result: { status: context.result.status },
    }),
    outbox: async (context) => ({
      id: `outbox-${operation.opId}`,
      cursor: context.cursor!,
    }),
  };
}

function conflictedPlan(
  operation: Operation,
  conflictId: string,
): TestPlan {
  return {
    status: 'conflicted',
    apply: async () => ({
      result: {
        opId: operation.opId,
        sequence: operation.sequence,
        status: 'conflicted' as const,
        warnings: [],
        conflictId,
      },
      conflict: { id: conflictId },
    }),
    audit: async (context) => ({
      id: `audit-${operation.opId}`,
      result: { status: context.result.status },
    }),
    outbox: async (context) => ({
      id: `outbox-${operation.opId}`,
      cursor: context.cursor!,
    }),
  };
}

/**
 * Host handlers for the recipe preflight. Captures merge / conflict / other
 * contexts so tests assert production merge results without reimplementing
 * three-way field logic or Tag OR-set.
 *
 * `current` is the server projection passed to `loadCurrent` (single object or
 * per-target Map). Must match the same `current` used when building the merge
 * oracle — an empty default would invent a different three-way triangle.
 */
function trackingHandlers(options: {
  readonly current?: ReadonlyMap<string, DataObject> | DataObject;
  readonly onMerged?: (context: TypedUpdateMergeMergedPlanContext) => void;
  readonly onConflict?: (context: TypedUpdateMergeConflictPlanContext) => void;
  readonly onOther?: (item: PushTransactionOperation, index: number) => void;
}) {
  const mergedContexts: TypedUpdateMergeMergedPlanContext[] = [];
  const conflictContexts: TypedUpdateMergeConflictPlanContext[] = [];
  const otherCalls: Array<{ readonly item: PushTransactionOperation; readonly index: number }> = [];

  const loadCurrent = async (
    operation: { readonly targetId: string },
  ): Promise<DataObject> => {
    const projectionSource = options.current;
    if (projectionSource === undefined) {
      throw new Error('trackingHandlers requires options.current (server projection)');
    }
    if (projectionSource instanceof Map || Object.prototype.toString.call(projectionSource) === '[object Map]') {
      const map = projectionSource as ReadonlyMap<string, DataObject>;
      const projection = map.get(operation.targetId);
      if (projection === undefined) {
        throw new Error(`missing current projection for ${operation.targetId}`);
      }
      return projection;
    }
    return projectionSource as DataObject;
  };

  const handlers = {
    loadCurrent: vi.fn(async (operation, item, index) => {
      void item;
      void index;
      return loadCurrent(operation);
    }),
    planMerged: vi.fn(async (context: TypedUpdateMergeMergedPlanContext) => {
      mergedContexts.push(context);
      options.onMerged?.(context);
      return appliedPlan(context.operation);
    }),
    planConflict: vi.fn(async (context: TypedUpdateMergeConflictPlanContext) => {
      conflictContexts.push(context);
      options.onConflict?.(context);
      return conflictedPlan(context.operation, `conflict-${context.operation.opId}`);
    }),
    planOther: vi.fn(async (item: PushTransactionOperation, index: number) => {
      otherCalls.push({ item, index });
      options.onOther?.(item, index);
      return appliedPlan(item.operation);
    }),
  };

  return { handlers, mergedContexts, conflictContexts, otherCalls };
}

// ---------------------------------------------------------------------------
// Minimal Push UnitOfWork + Session store (session-bound gate path)
// ---------------------------------------------------------------------------

interface PushState {
  operations: Operation[];
  receipts: StoredOperationReceipt<OperationResult>[];
  conflicts: Conflict[];
  cursors: string[];
  audits: Audit[];
  outbox: Outbox[];
  operationClaims: Map<string, unknown>;
  reuseAudits: Map<string, unknown>;
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

class TrackingPushUnitOfWork implements SyncUnitOfWork<
  Operation,
  OperationResult,
  Conflict,
  Audit,
  Outbox,
  TestTransaction
> {
  readonly operationIdReservationOwner = 'push' as const;
  executeCount = 0;
  readonly backend = { state: emptyPushState() };

  async execute<Value>(work: (transaction: TestTransaction) => Promise<Value>): Promise<Value> {
    this.executeCount += 1;
    const draft = clonePushState(this.backend.state);
    const result = await work(this.transaction(draft));
    this.backend.state = draft;
    return result;
  }

  private transaction(draft: PushState): TestTransaction {
    return {
      idReservations: { reserveAll: async () => ({ state: 'reserved' as const }) },
      operationClaims: {
        load: async (id: string) => {
          const claim = draft.operationClaims.get(id);
          return claim === undefined ? undefined : structuredClone(claim) as never;
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
        load: async (key: string) => {
          const audit = draft.reuseAudits.get(key);
          return audit === undefined ? undefined : structuredClone(audit) as never;
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
    terminatedAt: '2026-07-18T02:00:00Z',
    ...overrides,
  };
}

function pushRequestFrom(
  ...items: readonly [PushTransactionOperation, ...PushTransactionOperation[]]
): PushTransactionRequest {
  return {
    // session-bound Push requires the versioned binding for session-1.
    batchId: bindSyncPushBatchId('session-1', 'batch-recipe-1'),
    atomic: true,
    serverCursor: 'cursor-0',
    operations: items,
  };
}

function tagSet(tags: unknown): Set<string> {
  expect(Array.isArray(tags), `${evidence} tags must be an array`).toBe(true);
  const values = tags as readonly unknown[];
  expect(values.every((item) => typeof item === 'string')).toBe(true);
  return new Set(values as readonly string[]);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe(`Sync host composition recipe ${evidence}`, () => {
  describe('export surface and exclusive ownership', () => {
    it(`re-exports the recipe API from the Sync public entry with stable identities ${evidence}`, () => {
      expect(syncApi.createTypedUpdateMergePushPreflight).toBe(
        recipeModule.createTypedUpdateMergePushPreflight,
      );
      expect(syncApi.SYNC_HOST_COMPOSITION_RECIPE).toBe(recipeModule.SYNC_HOST_COMPOSITION_RECIPE);
      expect(syncApi.SYNC_HOST_RECOMMENDED_WRITE_PATHS).toBe(
        recipeModule.SYNC_HOST_RECOMMENDED_WRITE_PATHS,
      );
      expect(syncApi.isSyncTypedUpdateOperation).toBe(recipeModule.isSyncTypedUpdateOperation);
      expect(syncApi.isSyncTypedUpdateOperationType).toBe(
        recipeModule.isSyncTypedUpdateOperationType,
      );

      expect(typeof createTypedUpdateMergePushPreflight).toBe('function');
      expect(typeof isSyncTypedUpdateOperation).toBe('function');
      expect(typeof isSyncTypedUpdateOperationType).toBe('function');
      expect(SYNC_HOST_COMPOSITION_RECIPE).toBeTypeOf('object');
      expect(SYNC_HOST_RECOMMENDED_WRITE_PATHS).toBeTypeOf('object');
    });

    it(`documents Session-first order, exclusive write owner, and merge-in-preflight ${evidence}`, () => {
      expect(SYNC_HOST_COMPOSITION_RECIPE.sessionFirst).toMatch(
        /verifySyncSessionContext|requireVerifiedSyncSession|coordinateSessionBound/i,
      );
      expect(SYNC_HOST_COMPOSITION_RECIPE.exclusiveWriteOwner).toMatch(/exactly one/i);
      expect(SYNC_HOST_COMPOSITION_RECIPE.exclusiveWriteOwner).toMatch(
        /coordinateSequenceOperation|coordinatePushTransaction/i,
      );
      expect(SYNC_HOST_COMPOSITION_RECIPE.typedUpdateMergeInPreflight).toMatch(
        /mergeSyncTypedUpdate/i,
      );
      expect(SYNC_HOST_COMPOSITION_RECIPE.typedUpdateMergeInPreflight).toMatch(
        /createTypedUpdateMergePushPreflight/i,
      );
      expect(SYNC_HOST_COMPOSITION_RECIPE.pullAfterSession).toMatch(
        /coordinateSessionBoundPull|coordinateSyncPull/i,
      );
      expect(SYNC_HOST_COMPOSITION_RECIPE.recommendedSessionBoundPullPath).toMatch(
        /rejectPrivateOrLocalSnapshotUrl|assertSnapshotUrlSafe/i,
      );
      expect(SYNC_HOST_COMPOSITION_RECIPE.snapshotUrlHostPolicy).toMatch(
        /fetch|SSRF|allowlist/i,
      );
    });

    it(`documents bare vs production path obligations in the recipe notes ${evidence}`, () => {
      // Keep recipe strings honest about composition-free bare APIs.
      expect(SYNC_HOST_COMPOSITION_RECIPE.bareCoordinatorsRemainCompositionFree).toMatch(
        /composition-free|bare/i,
      );
      expect(SYNC_HOST_COMPOSITION_RECIPE.recommendedSessionBoundPushPath).toMatch(
        /coordinateSessionBoundPush/i,
      );
      expect(SYNC_HOST_COMPOSITION_RECIPE.recommendedSessionBoundPushPath).toMatch(
        /createTypedUpdateMergePushPreflight/i,
      );
      expect(SYNC_HOST_COMPOSITION_RECIPE.recommendedSessionBoundPullPath).toMatch(
        /coordinateSessionBoundPull/i,
      );

      // Complements the thinner composition notes; both remain Session-first.
      expect(SYNC_HOST_COMPOSITION_NOTES.sessionFirst).toMatch(
        /verifySyncSessionContext|requireVerifiedSyncSession/i,
      );
      expect(SYNC_HOST_COMPOSITION_NOTES.exclusiveOpIdOwner).toMatch(/exactly one/i);
    });

    it(`does not export a dual-owner sequenced-push facade ${evidence}`, () => {
      // Recipe write-path names are documentation only — two exclusive owners.
      expect([...SYNC_HOST_RECOMMENDED_WRITE_PATHS.exclusiveOwners].sort()).toEqual(
        ['push', 'sequence'].sort(),
      );
      expect(SYNC_HOST_RECOMMENDED_WRITE_PATHS.sessionBoundPush).toBe(
        'coordinateSessionBoundPush',
      );
      expect(SYNC_HOST_RECOMMENDED_WRITE_PATHS.sessionBoundSequence).toBe(
        'coordinateSessionBoundSequence',
      );
      expect(SYNC_HOST_COMPOSITION_RECIPE.exclusiveWriteOwner).toMatch(
        /no dual-owner sequenced-push/i,
      );
      expect(SYNC_HOST_COMPOSITION_RECIPE.recommendedSessionBoundSequencePath).toMatch(
        /do not also call Push/i,
      );

      // SYNC-V-009: no dual-owner sequenced-push helper on the Sync surface.
      expect('coordinateSequencedPush' in syncApi).toBe(false);
      expect('coordinateSessionBoundSequencedPush' in syncApi).toBe(false);
      expect('createSequencedPush' in syncApi).toBe(false);
      expect(Object.keys(syncApi).filter((name) => /sequencedPush/i.test(name))).toEqual([]);
      expect(Object.keys(recipeModule).filter((name) => /sequencedPush/i.test(name))).toEqual([]);
    });

    it(`classifies typed update operation types for the preflight branch ${evidence}`, () => {
      for (const type of [
        'update_collection_metadata',
        'update_node_content',
        'update_annotation',
        'update_attachment',
        'update_relation',
      ] as const) {
        expect(isSyncTypedUpdateOperationType(type)).toBe(true);
      }
      expect(isSyncTypedUpdateOperationType('delete_node')).toBe(false);
      expect(isSyncTypedUpdateOperationType('create_node')).toBe(false);
      expect(isSyncTypedUpdateOperationType('move_node')).toBe(false);

      const typed = typedUpdateItem({
        base: { title: 'A' },
        value: { title: 'B' },
      }).operation;
      const other = deleteNodeItem().operation;
      expect(isSyncTypedUpdateOperation(typed)).toBe(true);
      expect(isSyncTypedUpdateOperation(other)).toBe(false);
    });
  });

  describe('createTypedUpdateMergePushPreflight', () => {
    it(`1. concurrent divergent field surfaces conflict — not a silent overwrite ${evidence}`, async () => {
      const base = { title: 'A' };
      const current = { title: 'B' };
      const incoming = { title: 'C' };
      const item = typedUpdateItem({ base, value: incoming });

      // Production merge oracle: three-way diverge must conflict.
      const oracle = mergeSyncTypedUpdate({ base, current, incoming });
      expect(oracle.status).toBe('conflict');

      const { handlers, conflictContexts, mergedContexts } = trackingHandlers({ current });
      const preflight = createTypedUpdateMergePushPreflight(handlers);
      const plan = await preflight(item, 0);

      expect(handlers.loadCurrent).toHaveBeenCalledTimes(1);
      expect(handlers.planConflict).toHaveBeenCalledTimes(1);
      expect(handlers.planMerged).not.toHaveBeenCalled();
      expect(mergedContexts).toEqual([]);
      expect(plan.status).toBe('conflicted');

      expect(conflictContexts).toHaveLength(1);
      const context = conflictContexts[0]!;
      // Preflight must feed the host-loaded current into merge (not an empty default).
      expect(context.current).toEqual(current);
      expect(context.base).toEqual(base);
      expect(context.incoming).toEqual(incoming);
      expect(context.mergeResult.status).toBe('conflict');
      expect(context.conflicts.some((entry) => entry.field === 'title')).toBe(true);
      // Same conflict surface as production merge — not a local reimplementation.
      expect(context.mergeResult).toEqual(oracle);
      // Fail closed: conflict plan context has no merged domain patch (no silent winner).
      expect('merged' in context).toBe(false);
      expect(context).not.toMatchObject({ merged: { title: 'A' } });
      expect(context).not.toMatchObject({ merged: { title: 'B' } });
      expect(context).not.toMatchObject({ merged: { title: 'C' } });
    });

    it(`2. clean merge (server unchanged) passes incoming field values into planMerged ${evidence}`, async () => {
      const base = { title: 'Old title', tags: ['old'] };
      const current = { title: 'Old title', tags: ['old'] };
      const incoming = { title: 'New title', tags: ['new'] };
      const item = typedUpdateItem({ base, value: incoming });

      const oracle = mergeSyncTypedUpdate({ base, current, incoming });
      expect(oracle.status).toBe('merged');
      if (oracle.status !== 'merged') throw new Error('expected merged oracle');

      const { handlers, mergedContexts, conflictContexts } = trackingHandlers({ current });
      const preflight = createTypedUpdateMergePushPreflight(handlers);
      const plan = await preflight(item, 0);

      expect(handlers.planMerged).toHaveBeenCalledTimes(1);
      expect(handlers.planConflict).not.toHaveBeenCalled();
      expect(conflictContexts).toEqual([]);
      expect(plan.status).toBe('applied');

      const context = mergedContexts[0]!;
      // Preflight must wire host current + payload base/value into merge.
      expect(context.current).toEqual(current);
      expect(context.base).toEqual(base);
      expect(context.incoming).toEqual(incoming);
      // Host apply receives the production merge domain patch, not raw incoming identity.
      expect(context.merged).toEqual(oracle.value);
      expect(context.mergeResult).toEqual(oracle);
      expect(context.merged.title).toBe(incoming.title);
      expect(context.merged.title).not.toBe(base.title);
      expect(tagSet(context.merged.tags)).toEqual(new Set(['new']));
      // Always-current would keep the base title; prove incoming wins when server is unchanged.
      expect(context.merged).not.toEqual(current);
      expect(context.merged).not.toBe(incoming);
    });

    it(`3. Tag OR-set concurrent add is retained in the merged value ${evidence}`, async () => {
      // base [a], current [a,x] (server add x), incoming [a,y] (client add y)
      const base = { tags: ['a'] };
      const current = { tags: ['a', 'x'] };
      const incoming = { tags: ['a', 'y'] };
      const item = typedUpdateItem({ base, value: incoming });

      const oracle = mergeSyncTypedUpdate({ base, current, incoming });
      expect(oracle.status).toBe('merged');
      if (oracle.status !== 'merged') throw new Error('expected merged oracle');

      const { handlers, mergedContexts } = trackingHandlers({ current });
      const preflight = createTypedUpdateMergePushPreflight(handlers);
      await preflight(item, 0);

      const context = mergedContexts[0]!;
      expect(context.current).toEqual(current);
      expect(context.mergeResult).toEqual(oracle);
      expect(context.merged).toEqual(oracle.value);

      // Membership obligation from production OR-set (no local set algebra).
      expect(tagSet(context.merged.tags).has('x')).toBe(true);
      expect(tagSet(context.merged.tags).has('y')).toBe(true);
      expect(tagSet(context.merged.tags).has('a')).toBe(true);
      // Not wholesale replace with incoming (drops x) or leave current (drops y).
      expect(tagSet(context.merged.tags)).not.toEqual(tagSet(incoming.tags));
      expect(tagSet(context.merged.tags)).not.toEqual(tagSet(current.tags));
    });

    it(`4. non-typed-update ops pass through planOther without merge or loadCurrent ${evidence}`, async () => {
      const item = deleteNodeItem({ opId: 'operation-delete-mixed' });
      const { handlers, otherCalls, mergedContexts, conflictContexts } = trackingHandlers({
        current: { title: 'unused' },
      });
      const preflight = createTypedUpdateMergePushPreflight(handlers);

      const plan = await preflight(item, 3);

      expect(handlers.planOther).toHaveBeenCalledTimes(1);
      expect(handlers.planOther).toHaveBeenCalledWith(item, 3);
      expect(handlers.loadCurrent).not.toHaveBeenCalled();
      expect(handlers.planMerged).not.toHaveBeenCalled();
      expect(handlers.planConflict).not.toHaveBeenCalled();
      expect(otherCalls).toEqual([{ item, index: 3 }]);
      expect(mergedContexts).toEqual([]);
      expect(conflictContexts).toEqual([]);
      expect(plan.status).toBe('applied');
      expect(isSyncTypedUpdateOperation(item.operation)).toBe(false);
    });

    it(`4b. mixed batch: typed update merges while sibling delete uses planOther ${evidence}`, async () => {
      const base = { title: 'Stable' };
      const current = { title: 'Stable' };
      const incoming = { title: 'Client title' };
      const typed = typedUpdateItem({
        opId: 'operation-typed-mixed',
        sequence: 1,
        base,
        value: incoming,
      });
      const other = deleteNodeItem({ opId: 'operation-delete-mixed', sequence: 2 });

      const { handlers, mergedContexts, otherCalls, conflictContexts } = trackingHandlers({
        current,
      });
      const preflight = createTypedUpdateMergePushPreflight(handlers);

      const typedPlan = await preflight(typed, 0);
      const otherPlan = await preflight(other, 1);

      expect(typedPlan.status).toBe('applied');
      expect(otherPlan.status).toBe('applied');
      expect(handlers.planMerged).toHaveBeenCalledTimes(1);
      expect(handlers.planOther).toHaveBeenCalledTimes(1);
      expect(handlers.planConflict).not.toHaveBeenCalled();
      expect(conflictContexts).toEqual([]);

      const oracle = mergeSyncTypedUpdate({ base, current, incoming });
      expect(oracle.status).toBe('merged');
      if (oracle.status !== 'merged') throw new Error('expected merged oracle');
      expect(mergedContexts[0]!.merged).toEqual(oracle.value);
      expect(otherCalls[0]!.item.operation.opId).toBe(other.operation.opId);
      expect(otherCalls[0]!.index).toBe(1);
      // loadCurrent only for the typed update branch.
      expect(handlers.loadCurrent).toHaveBeenCalledTimes(1);
    });

    it(`rejects incomplete handler objects fail-closed before preflight runs ${evidence}`, () => {
      expect(() => createTypedUpdateMergePushPreflight({} as never)).toThrow(TypeError);
      expect(() => createTypedUpdateMergePushPreflight({
        loadCurrent: async () => ({}),
        planMerged: async () => appliedPlan(deleteNodeItem().operation),
        planConflict: async () => conflictedPlan(deleteNodeItem().operation, 'c'),
        // planOther missing
      } as never)).toThrow(/planOther/i);
    });
  });

  describe('session-bound Push composition with the recipe preflight', () => {
    it(`7. Session gate failure does not invoke the merge preflight or Push UoW ${evidence}`, async () => {
      const store = new DurableMemorySessionStore();
      const input = collectionInput();
      // Session never created → not_found
      const unitOfWork = new TrackingPushUnitOfWork();

      const { handlers } = trackingHandlers({
        current: { title: 'server' },
      });
      const preflight = createTypedUpdateMergePushPreflight(handlers);
      const wrapped = vi.fn(preflight);

      const item = typedUpdateItem({
        base: { title: 'A' },
        value: { title: 'C' },
      });

      await expect(coordinateSessionBoundPush(
        { kind: 'verify', store, input: verification(input) },
        unitOfWork,
        pushRequestFrom(item),
        wrapped,
      )).rejects.toMatchObject({
        name: 'SyncSessionGateDeniedError',
        denial: { state: 'not_found' },
      });

      expect(store.loadCalls).toEqual(['session-1']);
      expect(unitOfWork.executeCount).toBe(0);
      expect(wrapped).not.toHaveBeenCalled();
      expect(handlers.loadCurrent).not.toHaveBeenCalled();
      expect(handlers.planMerged).not.toHaveBeenCalled();
      expect(handlers.planConflict).not.toHaveBeenCalled();
      expect(handlers.planOther).not.toHaveBeenCalled();
      expect(unitOfWork.backend.state.operations).toEqual([]);
    });

    it(`7b. binding mismatch gate fails closed without calling recipe preflight ${evidence}`, async () => {
      const store = new DurableMemorySessionStore();
      const input = collectionInput();
      await createSyncSession(store, input);
      store.loadCalls.length = 0;

      const unitOfWork = new TrackingPushUnitOfWork();
      const { handlers } = trackingHandlers({ current: { title: 'server' } });
      const preflight = vi.fn(createTypedUpdateMergePushPreflight(handlers));

      await expect(coordinateSessionBoundPush(
        {
          kind: 'verify',
          store,
          input: verification(input, {
            binding: { ...binding(input), principal: { type: 'user', id: 'mallory' } },
          }),
        },
        unitOfWork,
        pushRequestFrom(typedUpdateItem({
          base: { title: 'A' },
          value: { title: 'B' },
        })),
        preflight,
      )).rejects.toMatchObject({
        name: 'SyncSessionGateDeniedError',
        denial: { state: 'context_mismatch' },
      });

      expect(preflight).not.toHaveBeenCalled();
      expect(handlers.loadCurrent).not.toHaveBeenCalled();
      expect(unitOfWork.executeCount).toBe(0);
    });

    it(`invokes the recipe preflight after successful Session verification ${evidence}`, async () => {
      const store = new DurableMemorySessionStore();
      const input = collectionInput();
      await createSyncSession(store, input);
      store.loadCalls.length = 0;

      const base = { title: 'Old' };
      const current = { title: 'Old' };
      const incoming = { title: 'New' };
      const item = typedUpdateItem({ base, value: incoming });
      const oracle = mergeSyncTypedUpdate({ base, current, incoming });
      expect(oracle.status).toBe('merged');
      if (oracle.status !== 'merged') throw new Error('expected merged oracle');

      const { handlers, mergedContexts } = trackingHandlers({ current });
      const unitOfWork = new TrackingPushUnitOfWork();

      const outcome = await coordinateSessionBoundPush(
        { kind: 'verify', store, input: verification(input) },
        unitOfWork,
        pushRequestFrom(item),
        createTypedUpdateMergePushPreflight(handlers),
      );

      expect(store.loadCalls).toEqual(['session-1']);
      expect(unitOfWork.executeCount).toBeGreaterThan(0);
      expect(handlers.loadCurrent).toHaveBeenCalledTimes(1);
      expect(handlers.planMerged).toHaveBeenCalledTimes(1);
      expect(mergedContexts[0]!.merged).toEqual(oracle.value);
      expect(outcome.session.sessionId).toBe(input.sessionId);
      expect(outcome.session.status).toBe('active');
      expect(outcome.result.batchId).toBe(bindSyncPushBatchId('session-1', 'batch-recipe-1'));
      expect(outcome.result.results.map((result) => result.opId)).toEqual([item.operation.opId]);
      expect(outcome.result.results[0]).toMatchObject({ status: 'applied' });
      expect(unitOfWork.backend.state.operations.map((op) => op.opId)).toEqual([
        item.operation.opId,
      ]);
    });

    it(`conflict path through session-bound Push persists a conflict record, not applied overwrite ${evidence}`, async () => {
      const store = new DurableMemorySessionStore();
      const input = collectionInput();
      await createSyncSession(store, input);

      const base = { title: 'A' };
      const current = { title: 'B' };
      const incoming = { title: 'C' };
      const item = typedUpdateItem({
        opId: 'operation-conflict-session',
        base,
        value: incoming,
      });
      const oracle = mergeSyncTypedUpdate({ base, current, incoming });
      expect(oracle.status).toBe('conflict');

      const { handlers, conflictContexts, mergedContexts } = trackingHandlers({ current });
      const unitOfWork = new TrackingPushUnitOfWork();

      const outcome = await coordinateSessionBoundPush(
        { kind: 'verify', store, input: verification(input) },
        unitOfWork,
        pushRequestFrom(item),
        createTypedUpdateMergePushPreflight(handlers),
      );

      expect(handlers.planConflict).toHaveBeenCalledTimes(1);
      expect(handlers.planMerged).not.toHaveBeenCalled();
      expect(mergedContexts).toEqual([]);
      expect(conflictContexts[0]!.mergeResult).toEqual(oracle);
      expect(outcome.result.results[0]).toMatchObject({
        opId: item.operation.opId,
        status: 'conflicted',
      });
      // Conflict path records a conflict; it must not claim applied with a silent title.
      expect(outcome.result.results[0]!.status).not.toBe('applied');
      expect(unitOfWork.backend.state.conflicts.map((entry) => entry.id)).toEqual([
        `conflict-${item.operation.opId}`,
      ]);
    });
  });

  describe('recipe preflight is a PurePushPreflight (no dual owner side effects)', () => {
    it(`returned preflight is a function usable as coordinateSessionBoundPush preflight ${evidence}`, () => {
      const { handlers } = trackingHandlers({ current: {} });
      const preflight = createTypedUpdateMergePushPreflight(handlers);
      expect(typeof preflight).toBe('function');
      // Recipe factory itself does not mint a sequenced-push coordinator.
      expect(preflight).not.toHaveProperty('operationIdReservationOwner');
      expect(typeof SYNC_HOST_COMPOSITION_RECIPE.recommendedSessionBoundSequencePath).toBe(
        'string',
      );
      expect(SyncSessionGateDeniedError).toBeTypeOf('function');
    });
  });
});
