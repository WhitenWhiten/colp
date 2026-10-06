/**
 * Lane-serialized Push adapter model. Not a test file.
 *
 * Models what a database adapter provides, rather than an in-process mutex
 * around the whole coordinator:
 * - per-lane locks acquired in `PushExecutionScope.lanes` order (like
 *   `SELECT … FOR UPDATE` on lane rows); disjoint lanes run concurrently;
 * - a snapshot per transaction taken after locks, with read-your-writes;
 * - commit replays the transaction's journal onto the live state and enforces
 *   unique receipts per Sequence tuple and per operation ID, and globally
 *   unique operation claims, so a lost race rolls the whole transaction back;
 * - a non-transactional cursor sequence (like a database sequence).
 */
import type { Operation, OperationResult } from '../../src/types/index.js';
import {
  PushReceiptConditionFailedError,
  type PushExecutionScope,
  type PushReceiptWriteCondition,
  type StoredOperationReceipt,
  type SyncOperationClaim,
  type SyncOperationReuseAudit,
  type SyncTransaction,
  type SyncUnitOfWork,
} from '../../src/sync/index.js';

export interface LaneConflict { readonly id: string }
export interface LaneAudit { readonly id: string }
export interface LaneOutbox { readonly id: string; readonly cursor: string }

export interface LaneTransaction
  extends SyncTransaction<Operation, OperationResult, LaneConflict, LaneAudit, LaneOutbox> {
  putBusiness(value: string): Promise<void>;
}

export interface LaneState {
  readonly business: string[];
  readonly operations: Operation[];
  readonly receipts: StoredOperationReceipt<OperationResult>[];
  readonly claims: Map<string, SyncOperationClaim>;
  readonly reuseAudits: Map<string, SyncOperationReuseAudit>;
  readonly conflicts: LaneConflict[];
  readonly audits: LaneAudit[];
  readonly outbox: LaneOutbox[];
}

export class UniqueViolation extends Error {
  constructor(constraint: string) {
    super(`unique violation: ${constraint}`);
    this.name = 'UniqueViolation';
  }
}

function emptyLaneState(): LaneState {
  return {
    business: [], operations: [], receipts: [], claims: new Map(), reuseAudits: new Map(),
    conflicts: [], audits: [], outbox: [],
  };
}

class LaneLocks {
  private readonly tails = new Map<string, Promise<void>>();

  async lock(key: string): Promise<() => void> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => held);
    this.tails.set(key, tail);
    await previous;
    return () => {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    };
  }
}

type Write = (state: LaneState) => void;

/** Conditional receipt write, checked atomically against the state it is applied to. */
function saveReceipt(
  receipt: StoredOperationReceipt<OperationResult>,
  condition: PushReceiptWriteCondition,
): Write {
  return (state) => {
    const bySequence = state.receipts.findIndex(stored => stored.replicaId === receipt.replicaId
      && stored.sequenceScope === receipt.sequenceScope && stored.sequence === receipt.sequence);
    const byOperation = state.receipts.findIndex(stored => stored.operationId === receipt.operationId);
    if (condition.kind === 'absent') {
      if (bySequence !== -1 || byOperation !== -1) throw new PushReceiptConditionFailedError(condition);
      state.receipts.push(structuredClone(receipt));
      return;
    }
    const existing = state.receipts[bySequence];
    if (existing === undefined || bySequence !== byOperation || existing.status !== 'deferred'
        || existing.operationId !== condition.operationId || existing.digest !== condition.digest
        || receipt.operationId !== condition.operationId || receipt.digest !== condition.digest) {
      throw new PushReceiptConditionFailedError(condition);
    }
    state.receipts[bySequence] = structuredClone(receipt);
  };
}

export class LaneSerializedDatabase {
  state = emptyLaneState();
  readonly scopes: PushExecutionScope[] = [];
  readonly receiptConditions: PushReceiptWriteCondition[] = [];
  readonly locks = new LaneLocks();
  active = 0;
  maxActive = 0;
  commits = 0;
  rollbacks = 0;
  private cursorSequence = 0;
  private auditSequence = 0;
  /** Awaited after lane locks are held and before the callback runs. */
  onBegin: ((scope: PushExecutionScope) => Promise<void>) | undefined;
  /** Awaited after the callback returns and before commit. */
  beforeCommit: ((scope: PushExecutionScope) => Promise<void>) | undefined;

  nextCursor(): string {
    this.cursorSequence += 1;
    return `cursor-${this.cursorSequence}`;
  }

  nextAuditKey(): string {
    this.auditSequence += 1;
    return `reuse-${this.auditSequence}`;
  }
}

export class LaneSerializedUnitOfWork
implements SyncUnitOfWork<Operation, OperationResult, LaneConflict, LaneAudit, LaneOutbox, LaneTransaction> {
  readonly operationIdReservationOwner = 'push' as const;

  constructor(readonly db: LaneSerializedDatabase) {}

  async execute<Value>(
    work: (transaction: LaneTransaction) => Promise<Value>,
    scope: PushExecutionScope,
  ): Promise<Value> {
    if (scope === undefined || scope.lanes.length === 0) {
      throw new TypeError('Lane-serialized adapter requires a Push execution scope.');
    }
    this.db.scopes.push(structuredClone(scope));
    const releases: Array<() => void> = [];
    for (const lane of scope.lanes) {
      releases.push(await this.db.locks.lock(JSON.stringify([lane.replicaId, lane.sequenceScope])));
    }
    this.db.active += 1;
    this.db.maxActive = Math.max(this.db.maxActive, this.db.active);
    try {
      await this.db.onBegin?.(scope);
      const draft = structuredClone(this.db.state);
      const journal: Write[] = [];
      const result = await work(this.transaction(draft, journal));
      await this.db.beforeCommit?.(scope);
      const next = structuredClone(this.db.state);
      for (const write of journal) write(next);
      this.db.state = next;
      this.db.commits += 1;
      return result;
    } catch (error) {
      this.db.rollbacks += 1;
      throw error;
    } finally {
      this.db.active -= 1;
      for (const release of releases.reverse()) release();
    }
  }

  private transaction(draft: LaneState, journal: Write[]): LaneTransaction {
    const write = (apply: Write): void => {
      apply(draft);
      journal.push(apply);
    };
    return {
      idReservations: { reserveAll: async () => ({ state: 'reserved' }) },
      operationClaims: {
        load: async (operationId) => structuredClone(draft.claims.get(operationId)),
        save: async (claim) => write((state) => {
          if (state.claims.has(claim.operationId)) throw new UniqueViolation('operation claim');
          state.claims.set(claim.operationId, structuredClone(claim));
        }),
      },
      reuseAudits: {
        append: async (audit) => {
          const key = this.db.nextAuditKey();
          write(state => { state.reuseAudits.set(key, structuredClone(audit)); });
          return key;
        },
        load: async (key) => structuredClone(draft.reuseAudits.get(key)),
      },
      receipts: {
        findByOperationId: async (operationId) =>
          structuredClone(draft.receipts.find(receipt => receipt.operationId === operationId)),
        findBySequence: async (replicaId, sequenceScope, sequence) =>
          structuredClone(draft.receipts.find(receipt => receipt.replicaId === replicaId
            && receipt.sequenceScope === sequenceScope && receipt.sequence === sequence)),
        save: async (receipt, condition) => {
          this.db.receiptConditions.push(structuredClone(condition));
          write(saveReceipt(receipt, condition));
        },
      },
      putBusiness: async (value) => write(state => { state.business.push(value); }),
      appendOperation: async (operation) => write(state => { state.operations.push(structuredClone(operation)); }),
      saveConflict: async (conflict) => write(state => { state.conflicts.push(structuredClone(conflict)); }),
      allocateCursor: async () => this.db.nextCursor(),
      appendAudit: async (audit) => write(state => { state.audits.push(structuredClone(audit)); }),
      appendOutbox: async (message) => write(state => { state.outbox.push(structuredClone(message)); }),
    };
  }
}

/** A deferred latch: `wait()` resolves once `open()` is called. */
export function latch(): { readonly wait: () => Promise<void>; readonly open: () => void } {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return { wait: () => opened, open };
}
