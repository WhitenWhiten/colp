import type { Operation } from '@know-n/colp/types';
import type {
  CanonicalMutationInput,
  CanonicalResourceMutation,
  JsonObject,
} from '../../modules/collections/index.js';

/** Bind the admitted Sync wire document to the canonical Operation write. */
export function syncCanonicalMutationInput(
  operation: Operation,
  actorPrincipalId: string,
  mutation: CanonicalResourceMutation,
): CanonicalMutationInput {
  if (typeof operation.collectionId !== 'string') {
    throw new TypeError('Sync Operation collectionId is required for canonical persistence');
  }
  return Object.freeze({
    operationId: operation.opId,
    collectionId: operation.collectionId,
    actor: Object.freeze({ principalId: actorPrincipalId, principalType: 'account' }),
    operationSyncWire: operation as unknown as JsonObject,
    mutation,
  });
}
