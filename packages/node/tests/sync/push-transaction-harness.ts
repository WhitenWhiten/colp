/** Shared Sync push-transaction test harness. Not a test file. */
import type { Operation, OperationResult } from '../../src/types/index.js';
import {
  PushReceiptConditionFailedError,
  type PushPreparedOperation,
  type PushTransactionRequest,
  type StoredOperationReceipt,
  type SyncTransaction,
  type SyncUnitOfWork,
} from '../../src/sync/index.js';

export const evidence = '[evidence:sync.batch]';

export interface Conflict { readonly id: string; readonly detail: { readonly value: string } }
export interface Audit { readonly id: string; readonly result: { readonly status: string } }
export interface Outbox { readonly id: string; readonly cursor: string }

export interface DurableState {
  readonly business: string[];
  readonly operations: Operation[];
  readonly receipts: StoredOperationReceipt<OperationResult>[];
  readonly conflicts: Conflict[];
  readonly cursors: string[];
  readonly audits: Audit[];
  readonly outbox: Outbox[];
  readonly operationClaims: Map<string, any>;
  readonly reuseAudits: Map<string, any>;
}

export type FailurePoint = 'cursor' | 'operation' | 'receipt' | 'conflict' | 'audit' | 'outbox' | undefined;

export interface TestTransaction extends SyncTransaction<Operation, OperationResult, Conflict, Audit, Outbox> {
  putBusiness(value: string): Promise<void>;
}

export function emptyState(): DurableState {
  return { business: [], operations: [], receipts: [], conflicts: [], cursors: [], audits: [], outbox: [], operationClaims: new Map(), reuseAudits: new Map() };
}

function cloneState(state: DurableState): DurableState {
  return structuredClone(state);
}

export class SharedDurableBackend {
  state = emptyState();
}

export class DurableContractHandle implements SyncUnitOfWork<Operation, OperationResult, Conflict, Audit, Outbox, TestTransaction> {
  readonly operationIdReservationOwner = 'push' as const;
  readonly trace: string[] = [];
  executeCount = 0;
  failure: FailurePoint;
  rejectAfterCommitOnce = false;

  constructor(readonly backend = new SharedDurableBackend()) {}

  async execute<Value>(work: (transaction: TestTransaction) => Promise<Value>): Promise<Value> {
    this.executeCount += 1;
    const transactionNumber = this.executeCount;
    this.trace.push(`tx:${transactionNumber}:begin`);
    const draft = cloneState(this.backend.state);
    try {
      const result = await work(this.transaction(draft, transactionNumber));
      this.backend.state = draft;
      this.trace.push(`tx:${transactionNumber}:commit`);
      if (this.rejectAfterCommitOnce) {
        this.rejectAfterCommitOnce = false;
        throw new Error('commit outcome unknown');
      }
      return result;
    } catch (error) {
      this.trace.push(`tx:${transactionNumber}:reject`);
      throw error;
    }
  }

  private transaction(draft: DurableState, transactionNumber: number): TestTransaction {
    const fail = (point: Exclude<FailurePoint, undefined>): void => {
      if (this.failure === point) throw new Error(`injected ${point} failure`);
    };
    return {
      idReservations: { reserveAll: async () => ({ state: 'reserved' }) },
      operationClaims: {
        load: async (id: string) => structuredClone(draft.operationClaims.get(id)),
        save: async (claim: any) => { draft.operationClaims.set(claim.operationId, structuredClone(claim)); },
      },
      reuseAudits: {
        append: async (audit: any) => { const key = `reuse-${draft.reuseAudits.size + 1}`; draft.reuseAudits.set(key, structuredClone(audit)); return key; },
        load: async (key: string) => structuredClone(draft.reuseAudits.get(key)),
      },
      receipts: {
        findByOperationId: async (operationId) => structuredClone(
          draft.receipts.find((receipt) => receipt.operationId === operationId),
        ),
        findBySequence: async (replicaId, sequenceScope, sequence) => structuredClone(
          draft.receipts.find((receipt) => receipt.replicaId === replicaId
            && receipt.sequenceScope === sequenceScope && receipt.sequence === sequence),
        ),
        save: async (receipt, condition) => {
          fail('receipt');
          this.trace.push(`tx:${transactionNumber}:receipt:${receipt.operationId}`);
          const index = draft.receipts.findIndex((stored) => stored.operationId === receipt.operationId
            || (stored.replicaId === receipt.replicaId && stored.sequenceScope === receipt.sequenceScope
              && stored.sequence === receipt.sequence));
          const existing = draft.receipts[index];
          if (condition.kind === 'absent' && existing === undefined) {
            draft.receipts.push(structuredClone(receipt));
          } else if (condition.kind === 'replace_deferred' && existing?.status === 'deferred'
              && existing.operationId === condition.operationId && existing.digest === condition.digest) {
            draft.receipts[index] = structuredClone(receipt);
          } else {
            throw new PushReceiptConditionFailedError(condition);
          }
        },
      },
      putBusiness: async (value) => {
        this.trace.push(`tx:${transactionNumber}:business:${value}`);
        draft.business.push(value);
      },
      appendOperation: async (operation) => {
        fail('operation');
        this.trace.push(`tx:${transactionNumber}:operation:${operation.opId}`);
        draft.operations.push(structuredClone(operation));
      },
      saveConflict: async (conflict) => {
        fail('conflict');
        this.trace.push(`tx:${transactionNumber}:conflict:${conflict.id}`);
        draft.conflicts.push(structuredClone(conflict));
      },
      allocateCursor: async () => {
        fail('cursor');
        const cursor = `cursor-${draft.cursors.length + 1}`;
        this.trace.push(`tx:${transactionNumber}:cursor:${cursor}`);
        draft.cursors.push(cursor);
        return cursor;
      },
      appendAudit: async (audit) => {
        fail('audit');
        this.trace.push(`tx:${transactionNumber}:audit:${audit.id}`);
        draft.audits.push(structuredClone(audit));
      },
      appendOutbox: async (message) => {
        fail('outbox');
        this.trace.push(`tx:${transactionNumber}:outbox:${message.id}`);
        draft.outbox.push(structuredClone(message));
      },
    };
  }
}

export function operation(index: number): Operation {
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

export function request(atomic: boolean, count = 2): PushTransactionRequest {
  return {
    batchId: 'batch-1', atomic, serverCursor: 'cursor-0',
    operations: Array.from({ length: count }, (_, index) => ({
      operation: operation(index + 1), sequenceScope: 'collection-1', digest: `digest-${index + 1}`,
    })) as unknown as PushTransactionRequest['operations'],
  };
}

export type Status = OperationResult['status'];

export function plan(
  status: Status,
  index: number,
  options: { businessFailure?: boolean; nested?: string } = {},
): PushPreparedOperation<TestTransaction, Conflict, Audit, Outbox> {
  const result = () => {
    const base = { opId: `operation-${index}`, sequence: index, status, warnings: [] as const };
    switch (status) {
      case 'applied': return { ...base, status, revision: `revision-applied-${index}` };
      case 'rebased': return { ...base, status, revision: `revision-rebased-${index}`, transform: { nested: options.nested ?? 'v' } };
      case 'conflicted': return {
        result: { ...base, status, conflictId: `conflict-${index}` },
        conflict: { id: `conflict-${index}`, detail: { value: options.nested ?? 'v' } },
      };
      case 'noop': return { ...base, status, revision: `revision-noop-${index}` };
      case 'rejected': return { ...base, status, code: 'policy_denied' };
      case 'deferred': return { ...base, status, code: 'dependency_pending', retryAfterSeconds: 5 };
    }
  };
  const apply = async (transaction: TestTransaction) => {
    if (status === 'applied' || status === 'rebased') {
      await transaction.putBusiness(`business-${index}`);
    }
    if (options.businessFailure) throw new Error('injected business failure');
    return result();
  };
  if (status === 'deferred') return { status, apply } as PushPreparedOperation<TestTransaction, Conflict, Audit, Outbox>;
  const audit = async (context: { readonly result: OperationResult }) => ({
    id: `audit-${index}`, result: { status: context.result.status },
  });
  if (status === 'noop' || status === 'rejected') {
    return { status, apply, audit } as PushPreparedOperation<TestTransaction, Conflict, Audit, Outbox>;
  }
  const outbox = async (context: { readonly cursor?: string }) => ({
    id: `outbox-${index}`, cursor: context.cursor!,
  });
  return { status, apply, audit, outbox } as PushPreparedOperation<TestTransaction, Conflict, Audit, Outbox>;
}
