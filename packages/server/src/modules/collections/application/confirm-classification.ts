import { assertCanonicalCommandId, canonicalCommandFingerprint } from '../../commands/index.js';
import { CollectionAuthorizationError, CollectionsError } from '../domain/index.js';
import type { ProductCollectionCanonicalPorts } from './ports.js';
import { claimProductMutation } from './product-mutation-admission.js';
import { applyClassificationContent, isClassificationOpaqueId, parseClassificationConfirmation, type ClassificationVocabularyPort } from './classification-content.js';

export interface ClassificationConfirmationPorts {
  readonly collection: ProductCollectionCanonicalPorts;
  readonly vocabulary: ClassificationVocabularyPort;
}
export interface ClassificationConfirmationUnitOfWork {
  execute<T>(work: (ports: ClassificationConfirmationPorts) => Promise<T>): Promise<T>;
}
export async function confirmCollectionBookmarkClassification(ports: ClassificationConfirmationPorts, input: {
  readonly actor:{readonly principalId:string;readonly subjectId:string};readonly collectionId:string;readonly nodeId:string;
  readonly commandId:string;readonly ifMatch:string;readonly document:unknown;
}) {
  const selection = parseClassificationConfirmation(input.document);
  if (!isClassificationOpaqueId(input.collectionId) || !isClassificationOpaqueId(input.nodeId)) throw new CollectionAuthorizationError({outcome:'conceal',reasonCategory:'resource_missing'});
  if (!input.actor.principalId || !input.actor.subjectId || !/^"[^"\r\n]+"$/.test(input.ifMatch)) throw new CollectionsError('invalid_node_input', 'Actor and a strong Node If-Match are required.');
  const binding = {principalId:input.actor.principalId,commandScope:'collections:classification-confirmation:v1',commandId:assertCanonicalCommandId(input.commandId)};
  const fingerprint = canonicalCommandFingerprint({method:'POST',route:`/api/v1/collections/${input.collectionId}/nodes/${input.nodeId}/classification-confirmations`,
    mediaType:'application/json',body:selection,conditions:{ifMatch:input.ifMatch}});
  const claim = await claimProductMutation(ports.collection,binding,fingerprint);
  if (claim.kind !== 'claimed') return claim;
  const locked = await ports.collection.collections.lockForUpdate(input.collectionId);
  if (!locked || locked.deletedAt !== null || locked.ownerSubjectId !== input.actor.subjectId) throw new CollectionAuthorizationError({outcome:'conceal',reasonCategory:'resource_missing'});
  const result = await applyClassificationContent({...ports.collection,vocabulary:ports.vocabulary},{actor:{principalId:input.actor.principalId,principalType:'account'},
    collectionId:input.collectionId,nodeId:input.nodeId,ifMatch:input.ifMatch,selection});
  await ports.collection.receipts.complete(binding,fingerprint,{status:200,mediaType:'application/json',contractVersion:'1.0.0',
    stableHeaders:{etag:result.etag,'cache-control':'private, no-store','content-type':'application/json; charset=utf-8'},body:Buffer.from(JSON.stringify(result))});
  return {kind:'succeeded' as const,result};
}
