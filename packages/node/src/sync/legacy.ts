/**
 * Pure Sync reducers kept for property tests and local modelling.
 *
 * They do **not** establish durable adapter persistence, Session authz,
 * lifetime Operation claims, or authoritative Replica state, and are not part
 * of the public package surface. Hosts use the durable coordinators:
 *
 * | Pure helper | Durable counterpart |
 * |---|---|
 * | `decideSequence` / `createSequenceState` / `recordSequenceResult` | `coordinateSequenceOperation` |
 * | `canPurgeTombstone` | `coordinateTombstonePurge` |
 * | `transitionReplicaLifecycle` | `coordinateReplicaLifecycle` |
 * | `haveMatchingTypedUpdateFields` | `validateSyncTypedUpdateOperationPayload` |
 */

import type { SequenceReceipt } from './index.js';

export type { SequenceReceipt };

export {
  transitionReplicaLifecycle,
  type ReplicaCheckpoint,
  type ReplicaLifecycleEvent,
} from './replica-lifecycle-transitions.js';

export interface SequenceState<Result> {
  readonly nextSequence: number;
  readonly terminalReceipts: ReadonlyMap<number, SequenceReceipt<Result>>;
  readonly pendingReceipt?: SequenceReceipt<Result>;
}

export type SequenceDecision<Result> =
  | { readonly kind: 'accept' }
  | { readonly kind: 'replay'; readonly result: Result }
  | { readonly kind: 'sequence_reuse' }
  | { readonly kind: 'sequence_gap'; readonly expectedSequence: number }
  | { readonly kind: 'sequence_blocked'; readonly expectedSequence: number }
  | { readonly kind: 'receipt_missing'; readonly expectedSequence: number };

/**
 * Prefer {@link createSyncHost} with `owner: 'sequence'`. This pure
 * helper does not establish adapter persistence, lifetime opId claims, or durable
 * receipts.
 */
export function createSequenceState<Result>(nextSequence = 1): SequenceState<Result> {
  if (!Number.isSafeInteger(nextSequence) || nextSequence < 1) {
    throw new RangeError('nextSequence must be a positive safe integer.');
  }
  return { nextSequence, terminalReceipts: new Map() };
}

/**
 * Prefer {@link createSyncHost} with `owner: 'sequence'`, which
 * enforces `sequence_gap` / `sequence_blocked` against durable lane state. This
 * pure helper is for tests and local modeling only.
 */
export function decideSequence<Result>(
  state: SequenceState<Result>,
  sequence: number,
  digest: string,
): SequenceDecision<Result> {
  const terminal = state.terminalReceipts.get(sequence);
  if (terminal !== undefined) {
    return terminal.digest === digest
      ? { kind: 'replay', result: terminal.result }
      : { kind: 'sequence_reuse' };
  }

  const pending = state.pendingReceipt;
  if (pending !== undefined) {
    if (sequence === pending.sequence) {
      return pending.digest === digest
        ? { kind: 'replay', result: pending.result }
        : { kind: 'sequence_reuse' };
    }
    if (sequence > pending.sequence) {
      return { kind: 'sequence_blocked', expectedSequence: pending.sequence };
    }
  }

  if (sequence === state.nextSequence) {
    return { kind: 'accept' };
  }
  if (sequence > state.nextSequence) {
    return { kind: 'sequence_gap', expectedSequence: state.nextSequence };
  }
  return { kind: 'receipt_missing', expectedSequence: state.nextSequence };
}

/**
 * Prefer {@link createSyncHost} with `owner: 'sequence'` for durable
 * receipt writes. This pure helper does not persist.
 */
export function recordSequenceResult<Result>(
  state: SequenceState<Result>,
  receipt: SequenceReceipt<Result>,
): SequenceState<Result> {
  if (!Number.isSafeInteger(receipt.sequence) || receipt.sequence !== state.nextSequence) {
    throw new RangeError('A result can only be recorded for the current expected Sequence.');
  }
  if (state.pendingReceipt !== undefined && state.pendingReceipt.digest !== receipt.digest) {
    throw new Error('A deferred Sequence cannot be replaced with a different request digest.');
  }

  if (receipt.status === 'deferred') {
    return { ...state, pendingReceipt: receipt };
  }

  const terminalReceipts = new Map(state.terminalReceipts);
  terminalReceipts.set(receipt.sequence, receipt);
  return {
    nextSequence: state.nextSequence + 1,
    terminalReceipts,
  };
}

/**
 * Prefer durable {@link coordinateTombstonePurge} facts and
 * transaction ports.
 */
export interface ActiveReplicaAck {
  readonly acknowledgedDeletion: boolean;
  readonly queuedOperationsReconciled: boolean;
}

/**
 * Prefer durable {@link coordinateTombstonePurge}.
 */
export interface TombstonePurgeFacts {
  readonly retentionElapsed: boolean;
  readonly activeReplicaAcks: readonly ActiveReplicaAck[];
  readonly purgeBoundaryReady: boolean;
  readonly deletionWatermarkReady: boolean;
}

/**
 * Prefer {@link coordinateTombstonePurge}. This pure predicate does
 * not load replica state or enforce adapter retention.
 */
export function canPurgeTombstone(facts: TombstonePurgeFacts): boolean {
  return (
    facts.retentionElapsed &&
    facts.activeReplicaAcks.every(
      (replica) => replica.acknowledgedDeletion && replica.queuedOperationsReconciled,
    ) &&
    facts.purgeBoundaryReady &&
    facts.deletionWatermarkReady
  );
}

/**
 * Weak key-set equality for plain records (Object.keys only; no prototype /
 * descriptor checks).
 *
 * Prefer {@link validateSyncTypedUpdateOperationPayload} /
 * {@link assertSyncTypedUpdateOperationPayload}, which enforce the stronger
 * typed-update key-set rules required for SYNC-0016.
 */
export function haveMatchingTypedUpdateFields(
  base: Readonly<Record<string, unknown>>,
  value: Readonly<Record<string, unknown>>,
): boolean {
  const baseFields = Object.keys(base).sort();
  const valueFields = Object.keys(value).sort();
  return (
    baseFields.length === valueFields.length &&
    baseFields.every((field, index) => field === valueFields[index])
  );
}
