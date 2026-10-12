/**
 * C-01: a logical Operation identity is not an HTTP attempt.
 * Attempt fields live on `QueueOperation.attempt` and must not change a
 * successful logical identity.
 */
import type { Lifecycle } from './sync-state/types.js';

export interface LogicalOperationIdentity {
  readonly serverId: string;
  readonly accountId: string;
  readonly collectionId: string;
  readonly replicaId: string;
  readonly generation: number;
  readonly sequenceScope: string;
  readonly sequence: number;
  readonly opId: string;
  readonly atomic: boolean;
  readonly operationDigest: string;
}

export interface SequenceReuseFacts {
  readonly code: 'sequence_reuse' | 'op_id_reused';
  readonly authValid: boolean;
  readonly accountMatches: boolean;
  readonly collectionMatches: boolean;
  readonly replicaMatches: boolean;
  readonly replicaLifecycle: Lifecycle;
  readonly generationMatches: boolean;
  readonly sequenceMatches: boolean;
  readonly opIdMatches: boolean;
  readonly operationBytesMatch: boolean;
  readonly isLocalPendingInScope: boolean;
  readonly clientResultUnknown: boolean;
}

export type SequenceReuseClass = 'illegal' | 'reconcile' | 'unknown';

export function logicalOperationIdentity(input: LogicalOperationIdentity): LogicalOperationIdentity {
  return Object.freeze({
    serverId: input.serverId,
    accountId: input.accountId,
    collectionId: input.collectionId,
    replicaId: input.replicaId,
    generation: input.generation,
    sequenceScope: input.sequenceScope,
    sequence: input.sequence,
    opId: input.opId,
    atomic: input.atomic,
    operationDigest: input.operationDigest,
  });
}

export function classifySequenceReuse(input: SequenceReuseFacts): SequenceReuseClass {
  if (!input.authValid || !input.accountMatches || !input.collectionMatches || !input.replicaMatches
      || input.replicaLifecycle === 'retired' || !input.generationMatches || !input.sequenceMatches
      || !input.opIdMatches || !input.operationBytesMatch || !input.isLocalPendingInScope) {
    return 'illegal';
  }
  // sequence_reuse/op_id_reused is not "did not execute".
  return input.clientResultUnknown ? 'unknown' : 'reconcile';
}
