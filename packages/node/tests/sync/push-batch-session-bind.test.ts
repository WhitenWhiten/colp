import { describe, expect, it, vi } from 'vitest';

import type { Operation, OperationResult } from '../../src/types/index.js';
import {
  coordinatePushTransaction,
} from '../../src/sync/unsafe.js';
import * as compositionApi from '../../src/sync/composition.js';
import {
  SYNC_HOST_COMPOSITION_NOTES,
  SyncSessionGateDeniedError,
  assertSyncPushBatchBoundToSession,
  bindSyncPushBatchId,
  coordinateSessionBoundPush,
  createSyncSession,
  requireVerifiedSyncSession,
  type ActiveSyncSessionRecord,
  type CreateSyncSessionInput,
  type PushPreparedOperation,
  type PushTransactionRequest,
  type StoredOperationReceipt,
  type SyncOperationClaim,
  type SyncOperationReuseAudit,
  type SyncSessionBinding,
  type SyncSessionRecord,
  type SyncSessionStore,
  type SyncSessionStoreCreateResult,
  type SyncSessionTermination,
  type SyncTransaction,
  type SyncUnitOfWork,
  type VerifySyncSessionContextInput,
} from '../../src/sync/index.js';

/**
 * Evidence for Push batchId ↔ Session binding on the session-bound Push path.
 * Bare coordinatePushTransaction remains free-form; only session-bound enforces.
 */
const evidence = '[evidence:sync.push-batch-session-bind]';
const createdAt = '2026-07-18T02:00:00Z';

// ---------------------------------------------------------------------------
// Session store fixture (mirrors composition-contract / session.test.ts)
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

function pushRequest(batchId: string): PushTransactionRequest {
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

async function openVerifiedSession(
  overrides: Partial<CreateSyncSessionInput> = {},
): Promise<{
  readonly store: DurableMemorySessionStore;
  readonly input: CreateSyncSessionInput;
  readonly session: Awaited<ReturnType<typeof requireVerifiedSyncSession>>;
}> {
  const store = new DurableMemorySessionStore();
  const input = collectionInput(overrides);
  await createSyncSession(store, input);
  const session = await requireVerifiedSyncSession(store, verification(input));
  store.loadCalls.length = 0;
  return { store, input, session };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe(`Push batchId ↔ Session binding (session-bound path) ${evidence}`, () => {
  describe('composition surface', () => {
    it(`exposes composition helpers and migration notes ${evidence}`, () => {
      expect(typeof compositionApi.assertSyncPushBatchBoundToSession).toBe('function');
      expect(typeof compositionApi.bindSyncPushBatchId).toBe('function');

      expect(SYNC_HOST_COMPOSITION_NOTES.migration).toMatch(
        /coordinateSessionBoundPush|batchId|sessionId|unsafe/i,
      );
    });
  });

  describe('bindSyncPushBatchId factory', () => {
    it(`mints a versioned binding instead of a sessionId prefix ${evidence}`, () => {
      const sessionId = 'session-1';
      const minted = bindSyncPushBatchId(sessionId, 'opaque-local');
      expect(minted).toBe('b1.9.session-1.opaque-local');

      expect(() => assertSyncPushBatchBoundToSession(minted, { sessionId })).not.toThrow();
      // A raw sessionId prefix is not unique once opaqueId may contain dots.
      expect(minted.startsWith(`${sessionId}.`)).toBe(false);
    });

    it(`rejects empty sessionId or opaqueLocalId ${evidence}`, () => {
      expect(() => bindSyncPushBatchId('', 'x')).toThrow(TypeError);
      expect(() => bindSyncPushBatchId('session-1', '')).toThrow(TypeError);
    });
  });

  describe('assertSyncPushBatchBoundToSession accepted forms', () => {
    const sessionId = 'session-1';
    const session = { sessionId };

    it(`rejects raw sessionId equality and a sessionId prefix ${evidence}`, () => {
      expect(() => assertSyncPushBatchBoundToSession(sessionId, session)).toThrow(
        SyncSessionGateDeniedError,
      );
      expect(() => assertSyncPushBatchBoundToSession(`${sessionId}.opaque-1`, session)).toThrow(
        SyncSessionGateDeniedError,
      );
      expect(() => assertSyncPushBatchBoundToSession(`${sessionId}.a.b`, session)).toThrow(
        SyncSessionGateDeniedError,
      );
      expect(() => assertSyncPushBatchBoundToSession(`${sessionId}.a:b/c`, session)).toThrow(
        SyncSessionGateDeniedError,
      );
    });

    it(`rejects the retired colon/slash separators and the empty dot suffix ${evidence}`, () => {
      // `:` and `/` are not legal opaqueId characters. An empty suffix is not a binding.
      for (const rejected of [
        `${sessionId}.`,
        `${sessionId}:opaque-1`,
        `${sessionId}/opaque-1`,
        `${sessionId}:`,
        `${sessionId}/`,
      ]) {
        expect(() => assertSyncPushBatchBoundToSession(rejected, session)).toThrow(
          SyncSessionGateDeniedError,
        );
      }
      try {
        assertSyncPushBatchBoundToSession(`${sessionId}.`, session);
        expect.fail('expected request_binding_mismatch for an empty dot suffix');
      } catch (error) {
        expect(error).toBeInstanceOf(SyncSessionGateDeniedError);
        expect(error).toMatchObject({
          denial: {
            state: 'request_binding_mismatch',
            detail: expect.stringMatching(/not unique/i) as string,
          },
        });
      }
      try {
        assertSyncPushBatchBoundToSession(`${sessionId}:opaque-1`, session);
        expect.fail('expected request_binding_mismatch for the retired colon separator');
      } catch (error) {
        expect(error).toBeInstanceOf(SyncSessionGateDeniedError);
        expect(error).toMatchObject({
          denial: {
            state: 'request_binding_mismatch',
            detail: expect.stringMatching(/binding version/i) as string,
          },
        });
      }
    });

    it(`rejects unrelated batchId and prefix lookalikes ${evidence}`, () => {
      try {
        assertSyncPushBatchBoundToSession('batch-unbound', session);
        expect.fail('expected request_binding_mismatch');
      } catch (error) {
        expect(error).toBeInstanceOf(SyncSessionGateDeniedError);
        expect(error).toMatchObject({
          name: 'SyncSessionGateDeniedError',
          denial: {
            state: 'request_binding_mismatch',
            detail: expect.stringMatching(/batchId/i) as string,
          },
        });
      }
      // session-10 must not bind to session-1 (no separator).
      expect(() => assertSyncPushBatchBoundToSession('session-10', session)).toThrow(
        SyncSessionGateDeniedError,
      );
      expect(() => assertSyncPushBatchBoundToSession('session-1x', session)).toThrow(
        SyncSessionGateDeniedError,
      );
      expect(() => assertSyncPushBatchBoundToSession('other-session.opaque', session)).toThrow(
        SyncSessionGateDeniedError,
      );
    });

    it(`rejects empty batchId with TypeError ${evidence}`, () => {
      expect(() => assertSyncPushBatchBoundToSession('', session)).toThrow(TypeError);
    });
  });

  describe('coordinateSessionBoundPush enforces binding', () => {
    it(`rejects raw sessionId equality without invoking Push ${evidence}`, async () => {
      const { store, input, session } = await openVerifiedSession();
      const unitOfWork = new TrackingPushUnitOfWork();
      const preflight = vi.fn(async () => appliedPlan(1));

      await expect(coordinateSessionBoundPush(
        { pushOwnershipVerifier: () => true, kind: 'verified', session },
        unitOfWork,
        pushRequest(input.sessionId),
        preflight,
      )).rejects.toMatchObject({
        denial: { state: 'request_binding_mismatch' },
      });

      expect(preflight).not.toHaveBeenCalled();
      expect(unitOfWork.executeCount).toBe(0);
      expect(store.loadCalls).toEqual([]);
    });

    it(`accepts the versioned factory form ${evidence}`, async () => {
      const { input, session } = await openVerifiedSession();
      const unitOfWork = new TrackingPushUnitOfWork();
      const batchId = bindSyncPushBatchId(input.sessionId, 'push-1');

      const outcome = await coordinateSessionBoundPush(
        { pushOwnershipVerifier: () => true, kind: 'verified', session },
        unitOfWork,
        pushRequest(batchId),
        async () => appliedPlan(1),
      );

      expect(unitOfWork.executeCount).toBeGreaterThan(0);
      expect(outcome.result.batchId).toBe(batchId);
      expect(outcome.result.batchId).not.toBe(`${input.sessionId}.push-1`);
      expect(unitOfWork.backend.state.operations.map((item) => item.opId)).toEqual(['operation-1']);
    });

    it(`rejects retired sessionId:opaque and sessionId/opaque without invoking UoW ${evidence}`, async () => {
      const { input, session } = await openVerifiedSession();
      for (const batchId of [`${input.sessionId}:opaque-colon`, `${input.sessionId}/opaque-slash`]) {
        const unitOfWork = new TrackingPushUnitOfWork();
        const preflight = vi.fn(async () => appliedPlan(1));

        await expect(coordinateSessionBoundPush(
          { pushOwnershipVerifier: () => true, kind: 'verified', session },
          unitOfWork,
          pushRequest(batchId),
          preflight,
        )).rejects.toMatchObject({
          name: 'SyncSessionGateDeniedError',
          denial: { state: 'request_binding_mismatch' },
        });

        expect(preflight).not.toHaveBeenCalled();
        expect(unitOfWork.executeCount).toBe(0);
      }
    });

    it(`rejects unrelated batchId without invoking UoW or preflight ${evidence}`, async () => {
      const { session } = await openVerifiedSession();
      const unitOfWork = new TrackingPushUnitOfWork();
      const preflight = vi.fn(async () => appliedPlan(1));

      await expect(coordinateSessionBoundPush(
        { pushOwnershipVerifier: () => true, kind: 'verified', session },
        unitOfWork,
        pushRequest('batch-unrelated'),
        preflight,
      )).rejects.toMatchObject({
        name: 'SyncSessionGateDeniedError',
        denial: { state: 'request_binding_mismatch' },
      });

      expect(preflight).not.toHaveBeenCalled();
      expect(unitOfWork.executeCount).toBe(0);
      expect(unitOfWork.backend.state.operations).toEqual([]);
      expect(unitOfWork.backend.state.receipts).toEqual([]);
      expect(unitOfWork.backend.state.operationClaims.size).toBe(0);
    });

    it(`rejects prefix lookalike batchId without invoking UoW ${evidence}`, async () => {
      const { session } = await openVerifiedSession();
      const unitOfWork = new TrackingPushUnitOfWork();
      const preflight = vi.fn(async () => appliedPlan(1));

      await expect(coordinateSessionBoundPush(
        { pushOwnershipVerifier: () => true, kind: 'verified', session },
        unitOfWork,
        pushRequest('session-10'),
        preflight,
      )).rejects.toMatchObject({
        denial: { state: 'request_binding_mismatch' },
      });

      expect(preflight).not.toHaveBeenCalled();
      expect(unitOfWork.executeCount).toBe(0);
    });

    it(`binds after Session verify and scope check (verify-kind gate) ${evidence}`, async () => {
      const store = new DurableMemorySessionStore();
      const input = collectionInput();
      await createSyncSession(store, input);
      store.loadCalls.length = 0;

      const unitOfWork = new TrackingPushUnitOfWork();
      const preflight = vi.fn(async () => appliedPlan(1));

      // Unbound batch fails closed after durable Session verify succeeds.
      await expect(coordinateSessionBoundPush(
        { pushOwnershipVerifier: () => true, kind: 'verify', store, input: verification(input) },
        unitOfWork,
        pushRequest('free-form-batch'),
        preflight,
      )).rejects.toMatchObject({
        denial: { state: 'request_binding_mismatch' },
      });

      expect(store.loadCalls).toEqual(['session-1']);
      expect(preflight).not.toHaveBeenCalled();
      expect(unitOfWork.executeCount).toBe(0);
    });
  });

  describe('bare coordinatePushTransaction remains free-form', () => {
    it(`accepts unbound batchId without Session binding ${evidence}`, async () => {
      const unitOfWork = new TrackingPushUnitOfWork();
      const preflight = vi.fn(async () => appliedPlan(1));
      const freeFormBatchId = 'batch-free-form-not-session-bound';

      const result = await coordinatePushTransaction(
        unitOfWork,
        pushRequest(freeFormBatchId),
        preflight,
      );

      expect(preflight).toHaveBeenCalled();
      expect(unitOfWork.executeCount).toBeGreaterThan(0);
      expect(result.batchId).toBe(freeFormBatchId);
      expect(result.results.map((item) => item.opId)).toEqual(['operation-1']);
      // Contrast: the same free-form id is rejected on the session-bound path.
      expect(() => assertSyncPushBatchBoundToSession(
        freeFormBatchId,
        { sessionId: 'session-1' },
      )).toThrow(SyncSessionGateDeniedError);
    });

    it(`documents that binding is session-bound only ${evidence}`, () => {
      expect(SYNC_HOST_COMPOSITION_NOTES.migration).toMatch(/sync\/unsafe/i);
      expect(SYNC_HOST_COMPOSITION_NOTES.productionPath).toMatch(/createSyncHost/i);
    });
  });
});
