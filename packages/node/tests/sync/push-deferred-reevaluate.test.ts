/**
 * F012 — Push coordinator deferred re-evaluation parity with Sequence.
 *
 * `coordinatePushTransaction` must accept the same `reevaluateDeferred` opt-in
 * flag `coordinateSequenceOperation` already supports: with the flag set, a
 * persisted deferred receipt with identical identity is re-evaluated through
 * preflight (receiving `previousDeferredReceipt` context) and may converge to
 * a terminal result; without the flag the stored receipt replays exactly.
 */

import { describe, expect, it } from 'vitest';

import {
  AtomicPushNotCommittableError,
  coordinatePushTransaction,
  type PushPreflightContext,
  type PushPreparedOperation,
  type PushTransactionOperation,
  type PushTransactionRequest,
} from '../../src/sync/unsafe.js';
import {
  PushReceiptConditionFailedError,
  createTypedUpdateMergePushPreflight,
  type ServerIdReservation,
  type ServerIdReservationResult,
  type ServerIdResourceType,
  type StoredOperationReceipt,
  type SyncTransaction,
  type SyncUnitOfWork,
} from '../../src/sync/index.js';
import type {
  Operation,
  OperationResult,
} from '../../src/types/index.js';

const evidence = '[evidence:sync.operation-id-lifetime]';
const now = '2026-07-18T00:00:00Z';

interface Conflict { readonly id: string }
interface Audit { readonly id: string }
interface Outbox { readonly id: string }

type Tx = SyncTransaction<Operation, OperationResult, Conflict, Audit, Outbox>;

function copy<Value>(value: Value): Value {
  return value === undefined ? value : structuredClone(value) as Value;
}

function sequenceKey(receipt: Pick<StoredOperationReceipt<unknown>, 'replicaId' | 'sequenceScope' | 'sequence'>): string {
  return JSON.stringify([receipt.replicaId, receipt.sequenceScope, receipt.sequence]);
}

/** Minimal transaction-local durable state for the Push coordinator. */
class MemoryPushBackend {
  readonly ledger = new Map<string, ServerIdResourceType>();
  readonly claims = new Map<string, unknown>();
  readonly reuseAudits = new Map<string, unknown>();
  readonly receipts = new Map<string, StoredOperationReceipt<OperationResult>>();
  readonly receiptsBySequence = new Map<string, StoredOperationReceipt<OperationResult>>();
  readonly operations = new Map<string, Operation>();
  readonly audits = new Map<string, Audit>();
  readonly outbox = new Map<string, Outbox>();
  readonly conflicts = new Map<string, Conflict>();
  readonly cursors: string[] = [];

  run<Value>(work: (transaction: Tx) => Promise<Value>): Promise<Value> {
    const draft = {
      ledger: new Map(this.ledger),
      claims: new Map(this.claims),
      reuseAudits: new Map(this.reuseAudits),
      receipts: new Map(this.receipts),
      receiptsBySequence: new Map(this.receiptsBySequence),
      operations: new Map(this.operations),
      audits: new Map(this.audits),
      outbox: new Map(this.outbox),
      conflicts: new Map(this.conflicts),
      cursors: [...this.cursors],
    };
    const transaction: Tx = {
      idReservations: {
        reserveAll: async (reservations: readonly ServerIdReservation[]) => {
          const duplicate = reservations.find(({ id }) => draft.ledger.has(id));
          if (duplicate !== undefined) {
            return {
              state: 'conflict',
              conflict: {
                requested: copy(duplicate),
                existing: { id: duplicate.id, resourceType: draft.ledger.get(duplicate.id)! },
              },
            } satisfies ServerIdReservationResult;
          }
          for (const { id, resourceType } of reservations) draft.ledger.set(id, resourceType);
          return { state: 'reserved' } satisfies ServerIdReservationResult;
        },
      },
      operationClaims: {
        load: async (id) => copy(draft.claims.get(id)) as never,
        save: async (claim) => { draft.claims.set(claim.operationId, copy(claim)); },
      },
      reuseAudits: {
        append: async (audit) => {
          const key = `reuse-${draft.reuseAudits.size + 1}`;
          draft.reuseAudits.set(key, copy(audit));
          return key;
        },
        load: async (key) => copy(draft.reuseAudits.get(key)) as never,
      },
      receipts: {
        findByOperationId: async (id) => copy(draft.receipts.get(id)),
        findBySequence: async (replicaId, sequenceScope, sequence) =>
          copy(draft.receiptsBySequence.get(sequenceKey({ replicaId, sequenceScope, sequence }))),
        save: async (receipt, condition) => {
          const existing = draft.receiptsBySequence.get(sequenceKey(receipt))
            ?? draft.receipts.get(receipt.operationId);
          const holds = condition.kind === 'absent'
            ? existing === undefined
            : existing?.status === 'deferred' && existing.operationId === condition.operationId
              && existing.digest === condition.digest;
          if (!holds) throw new PushReceiptConditionFailedError(condition);
          draft.receipts.set(receipt.operationId, copy(receipt));
          draft.receiptsBySequence.set(sequenceKey(receipt), copy(receipt));
        },
      },
      appendOperation: async (operation) => { draft.operations.set(operation.opId, copy(operation)); },
      saveConflict: async (conflict) => { draft.conflicts.set(conflict.id, copy(conflict)); },
      allocateCursor: async () => {
        const cursor = `cursor-${draft.cursors.length + 1}`;
        draft.cursors.push(cursor);
        return cursor;
      },
      appendAudit: async (audit) => { draft.audits.set(audit.id, copy(audit)); },
      appendOutbox: async (message) => { draft.outbox.set(message.id, copy(message)); },
    };
    return work(transaction).then((result) => {
      this.ledger.clear(); draft.ledger.forEach((v, k) => this.ledger.set(k, v));
      this.claims.clear(); draft.claims.forEach((v, k) => this.claims.set(k, v));
      this.reuseAudits.clear(); draft.reuseAudits.forEach((v, k) => this.reuseAudits.set(k, v));
      this.receipts.clear(); draft.receipts.forEach((v, k) => this.receipts.set(k, v));
      this.receiptsBySequence.clear(); draft.receiptsBySequence.forEach((v, k) => this.receiptsBySequence.set(k, v));
      this.operations.clear(); draft.operations.forEach((v, k) => this.operations.set(k, v));
      this.audits.clear(); draft.audits.forEach((v, k) => this.audits.set(k, v));
      this.outbox.clear(); draft.outbox.forEach((v, k) => this.outbox.set(k, v));
      this.conflicts.clear(); draft.conflicts.forEach((v, k) => this.conflicts.set(k, v));
      this.cursors.length = 0; this.cursors.push(...draft.cursors);
      return result;
    });
  }
}

class PushHandle implements SyncUnitOfWork<Operation, OperationResult, Conflict, Audit, Outbox, Tx> {
  readonly operationIdReservationOwner = 'push' as const;
  constructor(readonly backend: MemoryPushBackend) {}
  execute<Value>(work: (transaction: Tx) => Promise<Value>): Promise<Value> {
    return this.backend.run(work);
  }
}

function operation(opId = 'operation-1', sequence = 1): Operation {
  return {
    opId,
    replicaId: 'replica-1',
    sequence,
    type: 'delete_node',
    occurredAt: now,
    collectionId: 'collection-1',
    targetId: `node-${sequence}`,
    baseRevision: `revision-${sequence}`,
    payload: {},
  };
}

function request(options: {
  atomic?: boolean;
  reevaluateDeferred?: boolean | undefined;
} = {}): PushTransactionRequest {
  const op = operation();
  return {
    batchId: `batch-${op.replicaId}-collection-1-${op.sequence}`,
    atomic: options.atomic ?? false,
    serverCursor: 'cursor-0',
    ...(options.reevaluateDeferred === undefined
      ? {}
      : { reevaluateDeferred: options.reevaluateDeferred }),
    operations: [{
      operation: op,
      sequenceScope: 'collection-1',
      digest: `digest-${op.opId}`,
    }],
  };
}

type Plan = PushPreparedOperation<Tx, Conflict, Audit, Outbox>;

function planFor(
  item: PushTransactionOperation,
  status: OperationResult['status'],
  counters: { applies: number },
): Plan {
  const op = item.operation;
  const base = { opId: op.opId, sequence: op.sequence, warnings: [] as const };
  const apply = async () => {
    counters.applies += 1;
    switch (status) {
      case 'applied': return { ...base, status, revision: `revision-${op.opId}` };
      case 'deferred': return { ...base, status, code: 'dependency_pending' };
      case 'rejected': return { ...base, status, code: 'policy_denied' };
      default: return { ...base, status };
    }
  };
  if (status === 'deferred') return { status, apply } as Plan;
  const audit = async () => ({ id: `audit-${op.opId}` });
  if (status === 'noop' || status === 'rejected') return { status, apply, audit } as Plan;
  return { status, apply, audit, outbox: async () => ({ id: `outbox-${op.opId}` }) } as Plan;
}

describe(`SYNC deferred re-evaluation parity (F012) ${evidence}`, () => {
  it(`re-evaluates a deferred receipt to terminal when reevaluateDeferred is set ${evidence}`, async () => {
    const backend = new MemoryPushBackend();
    const counters = { applies: 0, preflights: 0 };
    let contexts: (PushPreflightContext | undefined)[] = [];
    const run = (status: OperationResult['status'], flag?: boolean) =>
      coordinatePushTransaction(new PushHandle(backend), request({ reevaluateDeferred: flag }),
        async (item, _index, context) => {
          counters.preflights += 1;
          contexts.push(context);
          return planFor(item, status, counters);
        });

    const first = await run('deferred');
    expect(first.results[0]!.status).toBe('deferred');
    expect(backend.operations.size).toBe(0);
    contexts = [];

    const second = await run('applied', true);
    expect(second.results[0]!.status).toBe('applied');
    expect(second.results[0]!.cursor).toBe('cursor-1');
    expect(counters.applies).toBe(2);
    expect(contexts[0]?.previousDeferredReceipt).toMatchObject({
      operationId: 'operation-1', status: 'deferred',
    });
    expect(backend.operations.has('operation-1')).toBe(true);
    const stored = backend.receipts.get('operation-1');
    expect(stored?.status).toBe('applied');
    expect(backend.receiptsBySequence.get(sequenceKey(stored!))?.status).toBe('applied');
  });

  it(`replays the stored deferred receipt when re-evaluation stays deferred ${evidence}`, async () => {
    const backend = new MemoryPushBackend();
    const counters = { applies: 0 };
    const run = (status: OperationResult['status'], flag?: boolean) =>
      coordinatePushTransaction(new PushHandle(backend), request({ reevaluateDeferred: flag }),
        async (item) => planFor(item, status, counters));

    const first = await run('deferred');
    const second = await run('deferred', true);
    expect(second.results).toEqual(first.results);
    // Re-evaluation returned deferred again: the stored receipt is replayed
    // without running apply or writing a new receipt (Sequence parity).
    expect(counters.applies).toBe(1);
    expect(backend.receipts.get('operation-1')?.result).toEqual(first.results[0]);
  });

  it(`replays a deferred receipt exactly when the flag is absent ${evidence}`, async () => {
    const backend = new MemoryPushBackend();
    const counters = { applies: 0, preflights: 0 };
    const run = (status: OperationResult['status']) =>
      coordinatePushTransaction(new PushHandle(backend), request(),
        async (item) => { counters.preflights += 1; return planFor(item, status, counters); });

    const first = await run('deferred');
    const replay = await run('applied');
    expect(replay.results).toEqual(first.results);
    expect(counters.preflights).toBe(1);
    expect(counters.applies).toBe(1);
    expect(backend.receipts.get('operation-1')?.status).toBe('deferred');
  });

  it(`does not re-evaluate a terminal receipt even when the flag is set ${evidence}`, async () => {
    const backend = new MemoryPushBackend();
    const counters = { applies: 0, preflights: 0 };
    const run = (status: OperationResult['status'], flag?: boolean) =>
      coordinatePushTransaction(new PushHandle(backend), request({ reevaluateDeferred: flag }),
        async (item) => { counters.preflights += 1; return planFor(item, status, counters); });

    const first = await run('applied');
    const replay = await run('rejected', true);
    expect(replay.results).toEqual(first.results);
    expect(counters.preflights).toBe(1);
    expect(counters.applies).toBe(1);
  });

  it(`commits a deferred re-evaluation to terminal inside an atomic batch ${evidence}`, async () => {
    const backend = new MemoryPushBackend();
    const counters = { applies: 0 };
    const run = (status: OperationResult['status'], flag?: boolean) =>
      coordinatePushTransaction(new PushHandle(backend),
        request({ atomic: true, reevaluateDeferred: flag }),
        async (item) => planFor(item, status, counters));

    await run('deferred', false).catch(() => undefined).then(async () => {
      // Atomic batches reject deferred plans; seed the receipt via non-atomic.
    });
    // Seed the deferred receipt non-atomically, then re-evaluate atomically.
    await coordinatePushTransaction(new PushHandle(backend), request(),
      async (item) => planFor(item, 'deferred', counters));
    const second = await run('applied', true);
    expect(second.results[0]!.status).toBe('applied');
    expect(backend.receipts.get('operation-1')?.status).toBe('applied');
    expect(backend.operations.has('operation-1')).toBe(true);
  });

  it(`rejects an atomic batch whose deferred re-evaluation stays deferred ${evidence}`, async () => {
    const backend = new MemoryPushBackend();
    const counters = { applies: 0 };
    await coordinatePushTransaction(new PushHandle(backend), request(),
      async (item) => planFor(item, 'deferred', counters));

    await expect(coordinatePushTransaction(new PushHandle(backend),
      request({ atomic: true, reevaluateDeferred: true }),
      async (item) => planFor(item, 'deferred', counters),
    )).rejects.toBeInstanceOf(AtomicPushNotCommittableError);
    expect(backend.receipts.get('operation-1')?.status).toBe('deferred');
  });

  it(`rejects a non-boolean reevaluateDeferred member ${evidence}`, async () => {
    const backend = new MemoryPushBackend();
    await expect(coordinatePushTransaction(new PushHandle(backend),
      { ...request(), reevaluateDeferred: 'yes' } as never,
      async (item) => planFor(item, 'applied', { applies: 0 }),
    )).rejects.toThrow(/boolean|reevaluateDeferred/i);
  });
});

describe('Recommended helper preserves deferred context [evidence:sync.operation-id-lifetime]', () => {
  it.each([
    { typed: true, atomic: false }, { typed: true, atomic: true },
    { typed: false, atomic: false }, { typed: false, atomic: true },
  ])('converges with typed=$typed and atomic=$atomic using the prior receipt', async ({ typed, atomic }) => {
    const backend = new MemoryPushBackend();
    const counters = { applies: 0 };
    const source = request();
    const original = source.operations[0]!;
    if (original.operation.type !== 'delete_node') throw new Error('Expected delete fixture');
    const item: PushTransactionOperation = typed ? {
      ...original, operation: { ...original.operation, type: 'update_node_content',
        payload: { base: { title: 'before' }, value: { title: 'after' } },
      },
    } : original;
    const input: PushTransactionRequest = { ...source, operations: [item] };
    const observed: Array<PushPreflightContext | undefined> = [];
    const decide = (candidate: PushTransactionOperation, context?: PushPreflightContext): Plan => {
      observed.push(context);
      return planFor(candidate, context?.previousDeferredReceipt === undefined ? 'deferred' : 'applied', counters);
    };
    const preflight = createTypedUpdateMergePushPreflight<Tx, Conflict, Audit, Outbox>({
      loadCurrent: async (_operation, _item, _index, context) => {
        observed.push(context);
        return { title: 'before' };
      },
      planMerged: async ({ item: candidate }, context) => decide(candidate, context),
      planConflict: async () => { throw new Error('Unexpected conflict'); },
      planOther: async (candidate, _index, context) => decide(candidate, context),
    });
    const handle = new PushHandle(backend);
    const first = await coordinatePushTransaction(handle, input, preflight);
    expect(first.results[0]!.status).toBe('deferred');
    const previous = copy(backend.receipts.get(item.operation.opId)!);
    expect(observed.every(context => context?.previousDeferredReceipt === undefined)).toBe(true);
    observed.length = 0;

    const second = await coordinatePushTransaction(handle, { ...input, atomic, reevaluateDeferred: true }, preflight);
    expect(second.results[0]!.status).toBe('applied');
    expect(observed).toHaveLength(typed ? 2 : 1);
    for (const context of observed) {
      expect(context).toBe(observed[0]);
      expect(context?.previousDeferredReceipt).toEqual(previous);
      expect(Object.isFrozen(context)).toBe(true);
      expect(Object.isFrozen(context?.previousDeferredReceipt)).toBe(true);
      expect(Object.isFrozen(context?.previousDeferredReceipt?.result)).toBe(true);
      expect(context?.atomicBatch !== undefined).toBe(atomic);
    }
    expect(backend.receipts.get(item.operation.opId)?.status).toBe('applied');
    expect(backend.operations.size).toBe(1);
    expect(backend.outbox.size).toBe(1);
    expect(counters.applies).toBe(2);
    const replay = await coordinatePushTransaction(handle, {
      ...input, serverCursor: second.serverCursor, atomic, reevaluateDeferred: true,
    }, preflight);
    expect(replay).toEqual(second);
    expect(observed).toHaveLength(typed ? 2 : 1);
    expect(counters.applies).toBe(2);
  });

  it('passes a detached immutable receipt and stable batch identity into conflict planning', async () => {
    const backend = new MemoryPushBackend();
    const counters = { applies: 0 };
    await coordinatePushTransaction(new PushHandle(backend), request(), async item => planFor(item, 'deferred', counters));
    const receipt = copy(backend.receipts.get('operation-1')!);
    const batch = Object.freeze({});
    let loadedContext: PushPreflightContext | undefined;
    let plannedContext: PushPreflightContext | undefined;
    const preflight = createTypedUpdateMergePushPreflight<Tx, Conflict, Audit, Outbox>({
      loadCurrent: async (_operation, _item, _index, context) => {
        loadedContext = context;
        (receipt.result as { code?: string }).code = 'changed-after-call';
        return { title: 'server' };
      },
      planMerged: async () => { throw new Error('Expected conflict'); },
      planConflict: async ({ item }, context) => {
        plannedContext = context;
        return planFor(item, 'rejected', counters);
      },
      planOther: async () => { throw new Error('Expected typed branch'); },
    });
    const original = request().operations[0]!;
    if (original.operation.type !== 'delete_node') throw new Error('Expected delete fixture');
    await preflight({ ...original, operation: { ...original.operation, type: 'update_node_content',
      payload: { base: { title: 'base' }, value: { title: 'client' } },
    } }, 0, { previousDeferredReceipt: receipt, atomicBatch: batch });
    expect(plannedContext).toBe(loadedContext);
    expect(plannedContext?.previousDeferredReceipt).not.toBe(receipt);
    expect(plannedContext?.previousDeferredReceipt?.result).toMatchObject({ code: 'dependency_pending' });
    expect(plannedContext?.atomicBatch).toBe(batch);
    expect(Object.isFrozen(plannedContext?.previousDeferredReceipt?.result)).toBe(true);
  });
});
