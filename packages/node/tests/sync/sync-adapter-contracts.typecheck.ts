/**
 * Consumer typecheck for the public Sync adapter contracts (`npm run typecheck`).
 *
 * Minimal adapters written only against the members the coordinators use
 * must compile; removed or misplaced members must not.
 */
import type { Operation, OperationResult } from '../../src/types/index.js';
import type {
  PushExecutionScope,
  PushReceiptWriteCondition,
  SyncPullCursorStore,
  SyncTransaction,
  SyncUnitOfWork,
} from '../../src/sync/index.js';
import {
  PushOperationReuseError,
  PushReceiptConditionFailedError,
  SyncOperationReuseError,
} from '../../src/sync/index.js';
import { canonicalOperationDigest, parseNetscapeBookmarkHtml } from '../../src/sync/browser.js';
// @ts-expect-error coordinators are not on the browser-safe entry
import { createSyncHost } from '../../src/sync/browser.js';
// @ts-expect-error the Proxy-guarded merge stays server-side on ./sync
import { mergeSyncTypedUpdate } from '../../src/sync/browser.js';

type Tx = SyncTransaction<Operation, OperationResult, { readonly id: string }, unknown, unknown>;

declare const base: Omit<Tx, 'receipts'>;

// A Push transaction needs no Replica, purge-boundary or watermark ports.
const transaction: Tx = {
  ...base,
  receipts: {
    findByOperationId: async () => undefined,
    findBySequence: async () => undefined,
    save: async (_receipt, condition: PushReceiptWriteCondition) => {
      if (condition.kind === 'replace_deferred') void condition.operationId;
    },
  },
};
// @ts-expect-error replicas is no longer part of the Push transaction contract
void transaction.replicas;
// @ts-expect-error advancePurgedThroughCursor belongs to Tombstone purge
void transaction.advancePurgedThroughCursor;

// The execution scope is supplied as a trailing argument.
const unitOfWork: SyncUnitOfWork<Operation, OperationResult, { readonly id: string }, unknown, unknown, Tx> = {
  operationIdReservationOwner: 'push',
  execute: async (work, scope: PushExecutionScope) => {
    const lanes: readonly { readonly replicaId: string; readonly sequenceScope: string }[] = scope.lanes;
    void lanes;
    return work(transaction);
  },
};
void unitOfWork;

// A one-argument execute written against the earlier contract still compiles.
const legacyUnitOfWork: SyncUnitOfWork<Operation, OperationResult, { readonly id: string }, unknown, unknown, Tx> = {
  operationIdReservationOwner: 'push',
  execute: async (work) => work(transaction),
};
void legacyUnitOfWork;

// Pull stores need only resolveCursor; lifecycle and batch methods are optional.
const minimalPullStore: SyncPullCursorStore = { resolveCursor: async () => null };
void minimalPullStore;

// Reuse errors keep their base class; partial progress is typed.
declare const error: unknown;
if (error instanceof PushOperationReuseError) {
  const base: SyncOperationReuseError = error;
  const failedIndex: number = error.progress.failed.index;
  void base;
  void failedIndex;
}
if (error instanceof PushReceiptConditionFailedError) {
  const retryable: true = error.retryable;
  void retryable;
}

void canonicalOperationDigest;
void parseNetscapeBookmarkHtml;
void createSyncHost;
void mergeSyncTypedUpdate;
