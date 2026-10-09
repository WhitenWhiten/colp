import type { PushTransactionRequest } from './push-transaction.js';
import type { SequenceOperationRequest } from './sequence.js';

export function collectionSequenceScopeKey(collectionId: string): string {
  return collectionId;
}

export function sequenceScopeMatchesCollection(sequenceScope: string, collectionId: string): boolean {
  return sequenceScope === collectionId || sequenceScope === `collection:${collectionId}`;
}

export function normalizeSessionBoundPushRequest(
  request: PushTransactionRequest,
  collectionId: string,
): PushTransactionRequest {
  const sequenceScope = collectionSequenceScopeKey(collectionId);
  return Object.freeze({
    ...request,
    operations: Object.freeze(request.operations.map((item) => Object.freeze({
      ...item,
      sequenceScope,
    }))) as PushTransactionRequest['operations'],
  });
}

export function normalizeSessionBoundSequenceRequest(
  request: SequenceOperationRequest,
  collectionId: string,
): SequenceOperationRequest {
  return Object.freeze({
    ...request,
    sequenceScope: collectionSequenceScopeKey(collectionId),
  });
}
