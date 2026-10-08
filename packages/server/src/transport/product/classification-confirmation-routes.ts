import type { FastifyInstance } from 'fastify';
import type { IdentityUnitOfWork } from '../../modules/identity/index.js';
import { confirmCollectionBookmarkClassification, type ClassificationConfirmationUnitOfWork } from '../../modules/collections/index.js';
import { requireMutationActor } from '../mutation-actor.js';
import { productRouteMetadata } from '../product-route-manifest.js';
import { ProductHttpError } from '../product-error.js';
import { consumeProductAdmission, type ProductAdmissionRateLimiter } from '../http-security.js';
import { readCollectionIdParam, readNodeIdParam, readKnownCommandId, readRequiredIfMatch } from './collection-route-helpers.js';
import { mapCollectionMutationError, sendProductCommandReceiptOutcome } from '../product-command-mapping.js';

const PATH = '/api/v1/collections/:collectionId/nodes/:nodeId/classification-confirmations';
export interface ClassificationConfirmationRoutesDependencies {
  readonly enabled: boolean; readonly tagsEnabled?: boolean; readonly allowedOrigins: readonly string[];
  readonly identityUnitOfWork: IdentityUnitOfWork; readonly rateLimiter: ProductAdmissionRateLimiter;
  readonly commands: ClassificationConfirmationUnitOfWork;
  readonly csrfMatches?: (raw: string, expectedHash: string) => boolean;
}
export function registerClassificationConfirmationRoutes(app: FastifyInstance, deps: ClassificationConfirmationRoutesDependencies): void {
  app.post(PATH, {config:{...productRouteMetadata('POST',PATH),productTransport:{allowedQuery:[],cacheControl:'private-no-store',
    acceptedMediaTypes:['application/json'],bodyLimitBytes:16*1024}}},async(request,reply)=>{
    const {account}=await requireMutationActor(request,deps);
    const additions=(request.body as {addTags?:unknown}|null)?.addTags;
    if(deps.tagsEnabled===false&&Array.isArray(additions)&&additions.length)throw new ProductHttpError({statusCode:404,code:'resource_not_found',message:'Classification tags are unavailable.'});
    if(!deps.enabled)throw new ProductHttpError({statusCode:404,code:'resource_not_found',message:'Classification is unavailable.'});
    const admission=await consumeProductAdmission(deps.rateLimiter,`classification-confirmation:${account.id}`);
    if(admission.kind==='failed')throw new ProductHttpError({statusCode:503,code:'feature_temporarily_unavailable',message:'Classification admission unavailable.'});
    if(admission.kind==='denied')throw new ProductHttpError({statusCode:429,code:'rate_limited',message:'Classification confirmation rate limit exceeded.',
      retryAfterSeconds:admission.retryAfterSeconds,headers:{'Retry-After':String(admission.retryAfterSeconds)}});
    const input={actor:{principalId:account.id,subjectId:account.subjectId},collectionId:readCollectionIdParam(request),nodeId:readNodeIdParam(request),
      commandId:readKnownCommandId(request),ifMatch:readRequiredIfMatch(request),document:request.body};
    try{
      const result=await deps.commands.execute(ports=>confirmCollectionBookmarkClassification(ports,input));
      if(result.kind!=='succeeded')return sendProductCommandReceiptOutcome(reply,result);
      return reply.header('etag',result.result.etag).header('cache-control','private, no-store').send(result.result);
    }catch(error){throw mapCollectionMutationError(error)??error;}
  });
}
