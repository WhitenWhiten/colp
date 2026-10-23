import type { ProblemCode } from '@know-n/colp/server';
import type { SubtreeObservationSummary, SyncPush, SyncPushResult } from '@know-n/colp/types';
import type { VerifiedExtensionCredential } from '../identity/index.js';

export interface SyncPushHttpApplicationInput {
  readonly credential: VerifiedExtensionCredential;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
  readonly origin: string;
  readonly mediaType: 'application/json';
  readonly endpointIdentity: string;
  readonly request: SyncPush;
}

export interface SyncPushHttpApplication {
  readonly runtimeOwnership: {
    readonly operationIdReservationOwner: 'sequence';
    readonly usesPushCoordinator: false;
    readonly maxBatchOperations: number;
    readonly evaluator: 'canonical_node_create' | 'canonical_node_create_update'
      | 'canonical_node_create_update_move' | 'canonical_node_create_update_move_delete';
    readonly trustedBaseOwner?: 'sync_node_revision_history';
    readonly conflictBoundary?: 'deferred_until_p3_17' | 'persisted_open';
  };
  admit(input: SyncPushHttpApplicationInput): Promise<SyncPushResult>;
}

export function probeSyncPushRuntimeOwnership(
  application: SyncPushHttpApplication,
  maxBatchOperations: number,
): SyncPushHttpApplication['runtimeOwnership'] {
  const ownership = application.runtimeOwnership;
  if (!Number.isSafeInteger(maxBatchOperations) || maxBatchOperations < 1 || maxBatchOperations > 50
      || ownership.operationIdReservationOwner !== 'sequence'
      || ownership.usesPushCoordinator !== false || !Number.isSafeInteger(ownership.maxBatchOperations)
      || ownership.maxBatchOperations < maxBatchOperations || ownership.maxBatchOperations > 50
      || (ownership.evaluator !== 'canonical_node_create'
        && ownership.evaluator !== 'canonical_node_create_update'
        && ownership.evaluator !== 'canonical_node_create_update_move'
        && ownership.evaluator !== 'canonical_node_create_update_move_delete')
      || ((ownership.evaluator === 'canonical_node_create_update'
        || ownership.evaluator === 'canonical_node_create_update_move'
        || ownership.evaluator === 'canonical_node_create_update_move_delete')
        && (ownership.trustedBaseOwner !== 'sync_node_revision_history'
          || (ownership.conflictBoundary !== 'deferred_until_p3_17'
            && ownership.conflictBoundary !== 'persisted_open')))) {
    throw new TypeError('syncPush runtime ownership probe failed closed');
  }
  return ownership;
}

/** A `delete_subtree` target's current members, in the shape the Problem's `currentSubtree` carries. */
export type SyncPushSubtreeSummary = Readonly<SubtreeObservationSummary>;

/** What a stale delete was refused against, so the client can rebase or ask the user (03 §13.1). */
export interface SyncPushStaleDeleteFacts {
  readonly currentRevision: string;
  readonly currentSubtree?: SyncPushSubtreeSummary;
}

export class SyncPushHttpError extends Error {
  constructor(
    public readonly code: ProblemCode,
    public readonly retryAfterSeconds?: number,
    public readonly expectedSequence?: number,
    options?: ErrorOptions,
    public readonly staleDelete?: SyncPushStaleDeleteFacts,
  ) {
    super(`Sync Push admission denied: ${code}`, options);
    this.name = 'SyncPushHttpError';
  }
}

/** Fail-closed fallback; throwing keeps lane, claim, and receipt in the rolled-back transaction. */
export function evaluateUnsupportedSyncOperation(): never {
  throw new SyncPushHttpError('unsupported_operation');
}
