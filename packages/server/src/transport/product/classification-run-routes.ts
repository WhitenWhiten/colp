import type { FastifyInstance,FastifyRequest,FastifyReply } from 'fastify';
import { ClassificationError,ClassificationProviderError,ClassificationRunConflictError,type ClassificationRunRuntime } from '../../modules/collections/index.js';
import { CreditError, type IdentityUnitOfWork } from '../../modules/identity/index.js';
import { sendCreditError } from './credit-error.js';
import { requireMutationActor } from '../mutation-actor.js';
import { requireSessionActor } from '../session-auth.js';
import { ProductHttpError } from '../product-error.js';
import { productRouteMetadata } from '../product-route-manifest.js';
import { consumeProductAdmission,type ProductAdmissionRateLimiter } from '../http-security.js';
import { readCollectionIdParam,readKnownCommandId,readRequiredIfMatch } from './collection-route-helpers.js';
import { mapCollectionMutationError,sendProductCommandReceiptOutcome } from '../product-command-mapping.js';

const BASE='/api/v1/collections/:collectionId/classification-runs',ITEM=`${BASE}/:runId`;
interface Dependencies {
  readonly enabled:boolean;readonly allowedOrigins:readonly string[];readonly identityUnitOfWork:IdentityUnitOfWork;
  readonly runtime:ClassificationRunRuntime;readonly rateLimiter:ProductAdmissionRateLimiter;
  readonly csrfMatches?:(raw:string,expectedHash:string)=>boolean;
}
export function registerClassificationRunRoutes(app:FastifyInstance,deps:Dependencies){
  const config=(method:'GET'|'POST',path:string)=>({config:{...productRouteMetadata(method,path),productTransport:{allowedQuery:[],
    cacheControl:'private-no-store' as const,...(method==='POST'?{acceptedMediaTypes:['application/json'],bodyLimitBytes:path.endsWith('/cancel')?1024:path.endsWith('/apply')?256*1024:128*1024}:{})}}});
  async function admit(request:FastifyRequest,mutation:boolean){
    const {account}=mutation?await requireMutationActor(request,deps):await requireSessionActor(request,deps.identityUnitOfWork,{touch:false});
    if(!deps.enabled)throw new ProductHttpError({statusCode:404,code:'resource_not_found',message:'Classification batches are unavailable.'});
    const admission=await consumeProductAdmission(deps.rateLimiter,`classification-run:${account.id}`);
    if(admission.kind!=='allowed')throw new ProductHttpError({statusCode:admission.kind==='denied'?429:503,
      code:admission.kind==='denied'?'rate_limited':'feature_temporarily_unavailable',message:'Classification run admission unavailable.'});
    return {actor:{principalId:account.id,subjectId:account.subjectId},collectionId:readCollectionIdParam(request)};
  }
  app.post(BASE,config('POST',BASE),async(request,reply)=>{
    const actor=await admit(request,true);
    try{
      const outcome=await deps.runtime.create({...actor,commandId:readKnownCommandId(request),requestId:request.id,document:request.body});
      return sendProductCommandReceiptOutcome(reply,outcome.kind==='replay'?{kind:'replay',...outcome.result}:outcome);
    }catch(error){return respondToRunError(request,reply,error);}
  });
  app.get(ITEM,config('GET',ITEM),async(request,reply)=>{
    const actor=await admit(request,false);
    try{const run=await deps.runtime.get({...actor,runId:runId(request)});return reply.header('etag',run.etag).send(run);}
    catch(error){return respondToRunError(request,reply,error);}
  });
  app.post(`${ITEM}/apply`,config('POST',`${ITEM}/apply`),async(request,reply)=>{
    const actor=await admit(request,true);
    try{
      const outcome=await deps.runtime.apply({...actor,runId:runId(request),commandId:readKnownCommandId(request),
        ifMatch:readRequiredIfMatch(request),document:request.body});
      return sendProductCommandReceiptOutcome(reply,outcome.kind==='replay'?{kind:'replay',...outcome.result}:outcome);
    }catch(error){return respondToRunError(request,reply,error);}
  });
  app.post(`${ITEM}/cancel`,config('POST',`${ITEM}/cancel`),async(request,reply)=>{
    const actor=await admit(request,true);
    try{
      const outcome=await deps.runtime.cancel({...actor,runId:runId(request),commandId:readKnownCommandId(request),
        ifMatch:readRequiredIfMatch(request),document:request.body});
      return sendProductCommandReceiptOutcome(reply,outcome.kind==='replay'?{kind:'replay',...outcome.result}:outcome);
    }catch(error){return respondToRunError(request,reply,error);}
  });
}
function respondToRunError(request:FastifyRequest,reply:FastifyReply,error:unknown){
  if(error instanceof CreditError)return sendCreditError(request,reply,error);
  throw mapError(error);
}
function runId(request:FastifyRequest){
  const value=(request.params as {runId?:unknown}).runId;
  if(typeof value!=='string'||!value.trim()||Buffer.byteLength(value)>128)throw new ProductHttpError({statusCode:400,code:'invalid_request',message:'Invalid run id.'});
  return value;
}
function mapError(error:unknown){
  if(error instanceof ClassificationRunConflictError)return new ProductHttpError({statusCode:409,code:'mutation_conflict',message:error.message});
  if(error instanceof ClassificationError){
    if(error.code==='resource_not_found')return new ProductHttpError({statusCode:404,code:'resource_not_found',message:'Classification run or source not found.'});
    if(error.code==='invalid_input')return new ProductHttpError({statusCode:422,code:'invalid_document',message:'Invalid classification run document.'});
    if(error.code==='context_limit')return new ProductHttpError({statusCode:413,code:'payload_too_large',message:'Classification context exceeds the supported limit.'});
  }
  if(error instanceof ClassificationProviderError)return new ProductHttpError({statusCode:503,code:'feature_temporarily_unavailable',
    message:'Classification run capacity is unavailable.',sameRequestRetrySafe:true,recovery:'same_request'});
  return mapCollectionMutationError(error)??error;
}
