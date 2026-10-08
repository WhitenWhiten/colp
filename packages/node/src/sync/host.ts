/**
 * Production Sync host façade.
 *
 * `createSyncHost` is the only typed exclusive write dispatcher on
 * `@know-n/colp/sync`. It requires a package-minted
 * {@link VerifiedSyncSession} and exactly one opId owner (`sequence` XOR `push`).
 * Composition-free coordinators live on `@know-n/colp/sync/unsafe`.
 * Request-scoped: verify with current credentials, scopes and server time for
 * each request before constructing this host. Methods reuse that snapshot;
 * they do not reload the Session store. Never cache or transfer the host.
 */

import type { Operation, OperationResult } from '../types/index.js';
import {
  coordinateSessionBoundPull,
  coordinateSessionBoundPush,
  coordinateSessionBoundReplicaLifecycle,
  coordinateSessionBoundSequence,
} from './composition.js';
import type { SyncTransaction, SyncUnitOfWork } from './index.js';
import type {
  PurePushPreflight,
  PushConflictRecord,
  PushOperationIdOwner,
  PushTransactionRequest,
  PushTransactionResult,
} from './push-transaction.js';
import type { PushReplicaOwnershipVerifier } from './push-ownership.js';
import type {
  SyncPullCoordinatorResult,
  SyncPullCursorStore,
  SyncPullEventStore,
  SyncPullRequestContext,
  SyncPullSnapshotUrlOptions,
} from './pull.js';
import type {
  ReplicaAuthenticatedLifecycleCommandInput,
  ReplicaLifecycleCoordinatorResult,
  ReplicaLifecycleKey,
  ReplicaLifecycleOwnershipVerifier,
  ReplicaLifecycleTransaction,
  ReplicaLifecycleUnitOfWork,
} from './replica-lifecycle.js';
import type {
  SequenceCoordinatorResult,
  SequenceCoordinatorTransaction,
  SequenceCoordinatorUnitOfWork,
  SequenceEvaluation,
  SequenceEvaluationContext,
  SequenceOperationRequest,
} from './sequence.js';
import {
  isVerifiedSyncSession,
  SyncSessionGateDeniedError,
  type VerifiedSyncSession,
} from './session.js';

export type SyncHostWriteOwner = 'sequence' | 'push';

export interface SequenceSyncHostConfig {
  readonly owner: 'sequence';
  readonly session: VerifiedSyncSession;
  /** Durable principal → Replica binding used by the lifecycle façade. */
  readonly ownershipVerifier?: ReplicaLifecycleOwnershipVerifier;
  /** Required durable principal → Replica lane binding used by Sequence writes; missing evidence denies the write. */
  readonly sequenceOwnershipVerifier?: PushReplicaOwnershipVerifier;
}

export interface PushSyncHostConfig {
  readonly owner: 'push';
  readonly session: VerifiedSyncSession;
  /** Durable principal → Replica binding used by the lifecycle façade. */
  readonly ownershipVerifier?: ReplicaLifecycleOwnershipVerifier;
  /** Required when calling push; verifies every Replica before receipt/claim lookup. */
  readonly pushOwnershipVerifier?: PushReplicaOwnershipVerifier;
}

export type SyncHostConfig = SequenceSyncHostConfig | PushSyncHostConfig;

type HostPull = (
  request: SyncPullRequestContext,
  cursorStore: SyncPullCursorStore,
  eventStore: SyncPullEventStore,
  snapshotUrlOptions?: SyncPullSnapshotUrlOptions,
) => Promise<{ readonly session: VerifiedSyncSession; readonly result: SyncPullCoordinatorResult }>;

type HostReplica = <
  Transaction extends ReplicaLifecycleTransaction = ReplicaLifecycleTransaction,
>(
  unitOfWork: ReplicaLifecycleUnitOfWork<Transaction>,
  key: ReplicaLifecycleKey,
  command: ReplicaAuthenticatedLifecycleCommandInput,
) => Promise<{
  readonly session: VerifiedSyncSession;
  readonly result: ReplicaLifecycleCoordinatorResult;
}>;

export interface SequenceSyncHost {
  readonly owner: 'sequence';
  readonly session: VerifiedSyncSession;
  readonly sequence: <
    Result,
    Transaction extends SequenceCoordinatorTransaction<Result> = SequenceCoordinatorTransaction<Result>,
  >(
    unitOfWork: SequenceCoordinatorUnitOfWork<Result, Transaction>,
    request: SequenceOperationRequest,
    evaluate: (
      context: SequenceEvaluationContext<Result>,
      transaction: Transaction,
    ) => Promise<SequenceEvaluation<Result>>,
  ) => Promise<{ readonly session: VerifiedSyncSession; readonly result: SequenceCoordinatorResult<Result> }>;
  readonly pull: HostPull;
  readonly replica: HostReplica;
}

export interface PushSyncHost {
  readonly owner: 'push';
  readonly session: VerifiedSyncSession;
  readonly push: <
    Conflict extends PushConflictRecord,
    Audit,
    Outbox,
    Transaction extends SyncTransaction<Operation, OperationResult, Conflict, Audit, Outbox>,
  >(
    unitOfWork: SyncUnitOfWork<Operation, OperationResult, Conflict, Audit, Outbox, Transaction>
      & PushOperationIdOwner,
    request: PushTransactionRequest,
    preflight: PurePushPreflight<Transaction, Conflict, Audit, Outbox>,
  ) => Promise<{ readonly session: VerifiedSyncSession; readonly result: PushTransactionResult }>;
  readonly pull: HostPull;
  readonly replica: HostReplica;
}

function assertExclusiveOwner(config: unknown): asserts config is SyncHostConfig {
  if (config === null || typeof config !== 'object') {
    throw new TypeError('createSyncHost config must be a non-null object.');
  }
  const record = config as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(record, 'owners')) {
    throw new TypeError('createSyncHost accepts exactly one owner, not owners.');
  }
  const owner = record.owner;
  if (owner !== 'sequence' && owner !== 'push') {
    throw new TypeError("createSyncHost owner must be exactly 'sequence' or 'push'.");
  }
}

function assertBrandedActiveSession(session: unknown): asserts session is VerifiedSyncSession {
  if (!isVerifiedSyncSession(session) || session.status !== 'active') {
    throw new SyncSessionGateDeniedError({
      state: 'request_binding_mismatch',
      detail:
        'createSyncHost requires a package-minted active VerifiedSyncSession '
        + '(runtime brand; no silent fallback).',
    });
  }
}

function bindPull(session: VerifiedSyncSession): HostPull {
  const gate = { kind: 'verified' as const, session };
  return (request, cursorStore, eventStore, snapshotUrlOptions) =>
    coordinateSessionBoundPull(gate, request, cursorStore, eventStore, snapshotUrlOptions);
}

function bindReplica(
  session: VerifiedSyncSession,
  ownershipVerifier: ReplicaLifecycleOwnershipVerifier | undefined,
): HostReplica {
  const gate = { kind: 'verified' as const, session };
  return (unitOfWork, key, command) =>
    coordinateSessionBoundReplicaLifecycle(gate, unitOfWork, key, command, ownershipVerifier);
}

export function createSyncHost(config: SequenceSyncHostConfig): SequenceSyncHost;
export function createSyncHost(config: PushSyncHostConfig): PushSyncHost;
export function createSyncHost(config: SyncHostConfig): SequenceSyncHost | PushSyncHost {
  assertExclusiveOwner(config);
  assertBrandedActiveSession(config.session);
  const gate = { kind: 'verified' as const, session: config.session };
  const pull = bindPull(config.session);
  const replica = bindReplica(config.session, config.ownershipVerifier);

  if (config.owner === 'sequence') {
    const sequence: SequenceSyncHost['sequence'] = (unitOfWork, request, evaluate) =>
      coordinateSessionBoundSequence(
        gate,
        unitOfWork,
        request,
        evaluate,
        config.sequenceOwnershipVerifier,
      );
    return Object.freeze({
      owner: 'sequence' as const,
      session: config.session,
      sequence,
      pull,
      replica,
    });
  }

  const pushOwnershipVerifier = config.pushOwnershipVerifier;
  const pushGate = { ...gate, enforcePushContinuity: true as const };
  const push: PushSyncHost['push'] = (unitOfWork, request, preflight) =>
    coordinateSessionBoundPush(pushGate, unitOfWork, request, preflight, pushOwnershipVerifier);
  return Object.freeze({
    owner: 'push' as const,
    session: config.session,
    push,
    pull,
    replica,
  });
}
