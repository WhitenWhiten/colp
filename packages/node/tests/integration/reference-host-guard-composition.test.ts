/**
 * Reference host guard-composition suite.
 *
 * Hosts own HTTP middleware composition. This fixture freezes the fail-closed
 * ordering recommended by SECURITY_COMPOSITION + SYNC host notes:
 * transport → rate-limit → session gate → push work.
 *
 * It is intentionally a lightweight call-order harness, not a full HTTP stack.
 *
 * Evidence: [evidence:security.composition-cookbook]
 */
import { describe, expect, it, vi } from 'vitest';

import {
  enforceRateLimit,
  type AtomicRateLimitCharge,
  type AtomicRateLimitPort,
  type AtomicRateLimitResult,
} from '../../src/security/index.js';
import {
  SyncSessionGateDeniedError,
  bindSyncPushBatchId,
  coordinateSessionBoundPush,
  createSyncSession,
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
import type { Operation, OperationResult } from '../../src/types/index.js';

const evidence = '[evidence:security.composition-cookbook]';
const now = '2026-07-18T02:00:00Z';

interface Conflict { readonly id: string }
interface Audit { readonly id: string; readonly result: { readonly status: string } }
interface Outbox { readonly id: string; readonly cursor: string }
type TestTransaction = SyncTransaction<Operation, OperationResult, Conflict, Audit, Outbox>;

function collectionInput(overrides: Partial<CreateSyncSessionInput> = {}): CreateSyncSessionInput {
  return {
    sessionId: 'session-ref-1',
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
    principal: structuredClone(input.principal),
    credential: structuredClone(input.credential),
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
    terminatedAt: now,
    ...overrides,
  };
}

class MemorySessionStore implements SyncSessionStore {
  public readonly order: string[] = [];
  private readonly state = new Map<string, SyncSessionRecord>();

  public async create(session: ActiveSyncSessionRecord): Promise<SyncSessionStoreCreateResult> {
    const existing = this.state.get(session.sessionId);
    if (existing !== undefined) return { state: 'conflict', session: structuredClone(existing) };
    const stored = structuredClone(session);
    this.state.set(session.sessionId, stored);
    return { state: 'created', session: structuredClone(stored) };
  }

  public async load(sessionId: string): Promise<SyncSessionRecord | undefined> {
    this.order.push('session.load');
    const session = this.state.get(sessionId);
    return session === undefined ? undefined : structuredClone(session);
  }

  public async terminate(termination: SyncSessionTermination): Promise<SyncSessionRecord | undefined> {
    const existing = this.state.get(termination.sessionId);
    if (existing === undefined) return undefined;
    if (existing.status === 'terminated') return structuredClone(existing);
    const terminated: SyncSessionRecord = {
      ...structuredClone(existing),
      status: 'terminated',
      terminationReason: termination.reason,
      terminatedAt: termination.terminatedAt,
    };
    this.state.set(termination.sessionId, terminated);
    return structuredClone(terminated);
  }
}

interface PushState {
  operations: Operation[];
  receipts: StoredOperationReceipt<OperationResult>[];
  operationClaims: Map<string, SyncOperationClaim>;
  reuseAudits: Map<string, SyncOperationReuseAudit>;
  cursors: string[];
  conflicts: Conflict[];
  audits: Audit[];
  outbox: Outbox[];
}

class TrackingPushUnitOfWork implements SyncUnitOfWork<
  Operation,
  OperationResult,
  Conflict,
  Audit,
  Outbox,
  TestTransaction
> {
  public readonly operationIdReservationOwner = 'push' as const;
  public executeCount = 0;
  public readonly state: PushState = {
    operations: [],
    receipts: [],
    operationClaims: new Map(),
    reuseAudits: new Map(),
    cursors: [],
    conflicts: [],
    audits: [],
    outbox: [],
  };

  public async execute<Result>(work: (transaction: TestTransaction) => Promise<Result>): Promise<Result> {
    this.executeCount += 1;
    const draft = this.state;
    const transaction = {
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
        findByOperationId: async (operationId: string) => structuredClone(
          draft.receipts.find((receipt) => receipt.operationId === operationId),
        ),
        findBySequence: async (replicaId: string, sequenceScope: string, sequence: number) => structuredClone(
          draft.receipts.find((receipt) => (
            receipt.replicaId === replicaId
            && receipt.sequenceScope === sequenceScope
            && receipt.sequence === sequence
          )),
        ),
        save: async (receipt: StoredOperationReceipt<OperationResult>) => {
          draft.receipts.push(structuredClone(receipt));
        },
      },
      appendOperation: async (operation: Operation) => {
        draft.operations.push(structuredClone(operation));
      },
      saveConflict: async (conflict: Conflict) => {
        draft.conflicts.push(structuredClone(conflict));
      },
      allocateCursor: async () => {
        const cursor = `cursor-${draft.cursors.length + 1}`;
        draft.cursors.push(cursor);
        return cursor;
      },
      appendAudit: async (audit: Audit) => {
        draft.audits.push(structuredClone(audit));
      },
      appendOutbox: async (message: Outbox) => {
        draft.outbox.push(structuredClone(message));
      },
    } as unknown as TestTransaction;
    return work(transaction);
  }
}

function deleteNodeOperation(): Operation {
  return {
    opId: 'operation-1',
    replicaId: 'replica-1',
    sequence: 1,
    type: 'delete_node',
    occurredAt: '2026-07-18T00:00:00Z',
    collectionId: 'collection-1',
    targetId: 'node-1',
    baseRevision: 'revision-1',
    payload: {},
  };
}

function pushRequest(batchId: string): PushTransactionRequest {
  return {
    batchId,
    atomic: true,
    serverCursor: 'cursor-0',
    operations: [{
      operation: deleteNodeOperation(),
      sequenceScope: 'collection-1',
      digest: 'digest-1',
    }],
  };
}

function appliedPlan(): PushPreparedOperation<TestTransaction, Conflict, Audit, Outbox> {
  return {
    status: 'applied',
    apply: async () => ({
      opId: 'operation-1',
      sequence: 1,
      status: 'applied' as const,
      warnings: [],
      revision: 'revision-applied-1',
    }),
    audit: async (context) => ({
      id: 'audit-1',
      result: { status: context.result.status },
    }),
    outbox: async (context) => ({
      id: 'outbox-1',
      cursor: context.cursor!,
    }),
  };
}

function allowingRateLimitPort(order: string[]): AtomicRateLimitPort {
  return {
    async charge(charge: AtomicRateLimitCharge): Promise<AtomicRateLimitResult> {
      order.push('rate-limit.charge');
      return {
        ceilings: charge.ceilings.map((ceiling) => ({
          dimension: ceiling.dimension,
          key: ceiling.key,
          allowed: true,
          remaining: ceiling.limit - 1,
          resetSeconds: 10,
        })),
      };
    },
  };
}

function denyingRateLimitPort(order: string[]): AtomicRateLimitPort {
  return {
    async charge(charge: AtomicRateLimitCharge): Promise<AtomicRateLimitResult> {
      order.push('rate-limit.charge');
      return {
        ceilings: charge.ceilings.map((ceiling, index) => ({
          dimension: ceiling.dimension,
          key: ceiling.key,
          allowed: index !== 0,
          remaining: index === 0 ? 0 : ceiling.limit - 1,
          resetSeconds: 17,
        })),
      };
    },
  };
}

async function hostPush(options: {
  readonly transportOk: boolean;
  readonly rateLimitPort: AtomicRateLimitPort;
  readonly store: SyncSessionStore;
  readonly unitOfWork: TrackingPushUnitOfWork;
  readonly order: string[];
  readonly sessionInput: CreateSyncSessionInput;
}): Promise<void> {
  options.order.push('transport.check');
  if (!options.transportOk) {
    throw new TypeError('HTTPS transport required.');
  }

  const decision = await enforceRateLimit(options.rateLimitPort, {
    bucket: 'publisher:general-write',
    cost: 1,
    credentialId: 'token-1',
    ipAddress: '203.0.113.7',
    instanceId: 'instance-1',
    ceilings: {
      credential: { policy: 'write:credential', limit: 10, windowSeconds: 60 },
      ip: { policy: 'write:ip', limit: 100, windowSeconds: 60 },
      instance: { policy: 'write:instance', limit: 1_000, windowSeconds: 300 },
    },
  });
  if (!decision.allowed) {
    options.order.push('rate-limit.denied');
    const retry = decision.reason === 'limited' ? decision.retryAfterSeconds : 'invalid';
    throw new Error(`rate_limited:${retry}`);
  }
  options.order.push('rate-limit.allowed');

  const batchId = bindSyncPushBatchId(options.sessionInput.sessionId, 'batch-1');
  const preflight = vi.fn(async () => {
    options.order.push('push.preflight');
    return appliedPlan();
  });
  await coordinateSessionBoundPush(
    { pushOwnershipVerifier: () => true, kind: 'verify', store: options.store, input: verification(options.sessionInput) },
    options.unitOfWork,
    pushRequest(batchId),
    preflight,
  );
  options.order.push('push.completed');
}

describe(`reference host guard composition ${evidence}`, () => {
  it('runs transport → rate-limit → session → push in order when all gates pass', async () => {
    const order: string[] = [];
    const store = new MemorySessionStore();
    const input = collectionInput();
    await createSyncSession(store, input);
    store.order.length = 0;

    const unitOfWork = new TrackingPushUnitOfWork();
    await hostPush({
      transportOk: true,
      rateLimitPort: allowingRateLimitPort(order),
      store,
      unitOfWork,
      order,
      sessionInput: input,
    });

    expect(order).toEqual([
      'transport.check',
      'rate-limit.charge',
      'rate-limit.allowed',
      'push.preflight',
      'push.completed',
    ]);
    expect(store.order).toEqual(['session.load']);
    expect(unitOfWork.executeCount).toBeGreaterThan(0);
  });

  it('stops before session and push when rate-limit denies', async () => {
    const order: string[] = [];
    const store = new MemorySessionStore();
    const input = collectionInput();
    await createSyncSession(store, input);
    store.order.length = 0;
    const unitOfWork = new TrackingPushUnitOfWork();

    await expect(hostPush({
      transportOk: true,
      rateLimitPort: denyingRateLimitPort(order),
      store,
      unitOfWork,
      order,
      sessionInput: input,
    })).rejects.toThrow(/rate_limited:17/u);

    expect(order).toEqual([
      'transport.check',
      'rate-limit.charge',
      'rate-limit.denied',
    ]);
    expect(store.order).toEqual([]);
    expect(unitOfWork.executeCount).toBe(0);
  });

  it('stops before rate-limit when transport is not HTTPS-terminated', async () => {
    const order: string[] = [];
    const store = new MemorySessionStore();
    const unitOfWork = new TrackingPushUnitOfWork();

    await expect(hostPush({
      transportOk: false,
      rateLimitPort: allowingRateLimitPort(order),
      store,
      unitOfWork,
      order,
      sessionInput: collectionInput(),
    })).rejects.toThrow(/HTTPS transport required/u);

    expect(order).toEqual(['transport.check']);
    expect(unitOfWork.executeCount).toBe(0);
  });

  it('fails closed on session mismatch after rate-limit allows', async () => {
    const order: string[] = [];
    const store = new MemorySessionStore();
    const input = collectionInput();
    await createSyncSession(store, input);
    store.order.length = 0;
    const unitOfWork = new TrackingPushUnitOfWork();
    const rateLimitPort = allowingRateLimitPort(order);

    order.push('transport.check');
    const decision = await enforceRateLimit(rateLimitPort, {
      bucket: 'publisher:general-write',
      cost: 1,
      credentialId: 'token-1',
      ipAddress: '203.0.113.7',
      instanceId: 'instance-1',
      ceilings: {
        credential: { policy: 'write:credential', limit: 10, windowSeconds: 60 },
        ip: { policy: 'write:ip', limit: 100, windowSeconds: 60 },
        instance: { policy: 'write:instance', limit: 1_000, windowSeconds: 300 },
      },
    });
    expect(decision.allowed).toBe(true);
    order.push('rate-limit.allowed');

    await expect(coordinateSessionBoundPush(
      { pushOwnershipVerifier: () => true,
        kind: 'verify',
        store,
        input: verification(input, {
          binding: { ...binding(input), principal: { type: 'user', id: 'mallory' } },
        }),
      },
      unitOfWork,
      pushRequest(bindSyncPushBatchId(input.sessionId, 'batch-1')),
      async () => {
        order.push('push.preflight');
        return appliedPlan();
      },
    )).rejects.toBeInstanceOf(SyncSessionGateDeniedError);

    expect(order).toEqual([
      'transport.check',
      'rate-limit.charge',
      'rate-limit.allowed',
    ]);
    expect(store.order).toEqual(['session.load']);
    expect(unitOfWork.executeCount).toBe(0);
  });
});
