import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {IdentityUnitOfWork} from '../../modules/identity/index.js';
import {ClassificationProfileError,type ClassificationProfilesRuntime} from '../../modules/collections/index.js';
import {requireSessionActor} from '../session-auth.js';
import {requireMutationActor} from '../mutation-actor.js';
import {productRouteMetadata} from '../product-route-manifest.js';
import {ProductHttpError} from '../product-error.js';
import {consumeProductAdmission,type ProductAdmissionRateLimiter} from '../http-security.js';
import {readKnownCommandId,readRequiredIfMatch} from './collection-route-helpers.js';
import {mapCollectionMutationError,sendProductCommandReceiptOutcome} from '../product-command-mapping.js';
const BASE='/api/v1/me/classification-provider-profiles',ITEM=`${BASE}/:profileId`;
interface Dependencies {readonly enabled:boolean;readonly allowedOrigins:readonly string[];readonly identityUnitOfWork:IdentityUnitOfWork;
  readonly runtime:ClassificationProfilesRuntime;readonly rateLimiter:ProductAdmissionRateLimiter;readonly csrfMatches?:(raw:string,hash:string)=>boolean}
export function registerClassificationProfileRoutes(app:FastifyInstance,deps:Dependencies){
  if (!deps.enabled) return;
  const config=(method:'GET'|'POST'|'PATCH'|'DELETE',path:string)=>({config:{...productRouteMetadata(method,path),productTransport:{allowedQuery:[],cacheControl:'private-no-store' as const,
    ...(method==='GET'?{}:{acceptedMediaTypes:['application/json'],bodyLimitBytes:16*1024})}}});
  const admit=async(request:FastifyRequest,mutation:boolean)=>{
    const {account}=mutation?await requireMutationActor(request,deps):await requireSessionActor(request,deps.identityUnitOfWork,{touch:false});
    if(!deps.enabled)throw new ProductHttpError({statusCode:404,code:'resource_not_found',message:'Classification profiles are unavailable.'});
    const result=await consumeProductAdmission(deps.rateLimiter,`classification-profile:${account.id}`);
    if(result.kind!=='allowed')throw new ProductHttpError({statusCode:result.kind==='denied'?429:503,
      code:result.kind==='denied'?'rate_limited':'feature_temporarily_unavailable',message:'Classification profile admission unavailable.'});
    return {principalId:account.id,subjectId:account.subjectId};
  };
  app.get(BASE,{...config('GET',BASE),exposeHeadRoute:false},async(request,reply)=>{
    const actor=await admit(request,false);
    try{const result=await deps.runtime.list(actor.subjectId);return reply.header('etag',result.etag).header('cache-control','private, no-store').send({profiles:result.profiles});}
    catch(error){throw mapError(error);}
  });
  for(const [method,path,action] of [['POST',BASE,'create'],['PATCH',ITEM,'update'],['DELETE',ITEM,'delete'],['POST',`${ITEM}/test`,'test']] as const){
    app.route({method,url:path,...config(method,path),async handler(request,reply){
      const actor=await admit(request,true);
      try{
        if((action==='delete'||action==='test')&&request.body!==undefined&&request.body!==null)throw new ClassificationProfileError('invalid_document');
        const result=await deps.runtime[action]({actor,commandId:readKnownCommandId(request),requestId:request.id,
          ...(action==='create'?{}:{profileId:profileId(request)}),...(action==='update'||action==='delete'?{ifMatch:readRequiredIfMatch(request)}:{}),document:request.body});
        return sendProductCommandReceiptOutcome(reply,result.kind==='succeeded'||result.kind==='replay'?{kind:'replay',...result.result}:result);
      }catch(error){throw mapError(error);}
    }});
  }
}
function profileId(request:FastifyRequest){const id=(request.params as {profileId?:unknown}).profileId;
  if(typeof id!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/u.test(id))throw new ProductHttpError({statusCode:400,code:'invalid_request',message:'Invalid profile id.'});return id;}
function mapError(error:unknown){
  if(error instanceof ClassificationProfileError)return new ProductHttpError({statusCode:{invalid_document:422,resource_not_found:404,mutation_conflict:409,feature_temporarily_unavailable:503}[error.code],code:error.code,message:'Classification profile request could not be completed.'});
  return mapCollectionMutationError(error)??error;
}
