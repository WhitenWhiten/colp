import type { ProblemCode } from '@know-n/colp/server';
import type { SyncPush, SyncPushResult } from '@know-n/colp/types';
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
    readonly maxBatchOperations: 1;
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
  if (maxBatchOperations !== 1 || ownership.operationIdReservationOwner !== 'sequence'
      || ownership.usesPushCoordinator !== false || ownership.maxBatchOperations !== 1
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

export class SyncPushHttpError extends Error {
  constructor(
    public readonly code: ProblemCode,
    public readonly retryAfterSeconds?: number,
    public readonly expectedSequence?: number,
    options?: ErrorOptions,
  ) {
    super(`Sync Push admission denied: ${code}`, options);
    this.name = 'SyncPushHttpError';
  }
}

/** Fail-closed fallback; throwing keeps lane, claim, and receipt in the rolled-back transaction. */
export function evaluateUnsupportedSyncOperation(): never {
  throw new SyncPushHttpError('unsupported_operation');
}
