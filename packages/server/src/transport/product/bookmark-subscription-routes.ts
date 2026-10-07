import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ActorCollectionReadLimitError } from '../../modules/collections/index.js';
import type { IdentityUnitOfWork } from '../../modules/identity/index.js';
import type { BookmarkSubscriptionUnitOfWork, SubscriptionActor, SubscriptionTransactionPorts, ActionReceipt } from '../../modules/bookmark-subscriptions/index.js';
import { BookmarkSubscriptionError, acknowledgeAction, accessCheck, authorizeSnapshotReceipt, checkNodes, commitExit, createMapping, createSnapshot, createSubscription, createSubscriptionCursorCodec, etag, exitInput, fail, listConfiguration, saveExitPreview, nodeRefs, object, opaque, projectionCheck, snapshotNodes, sourceRef, updateMapping, uuid } from '../../modules/bookmark-subscriptions/index.js';
import { canonicalCommandFingerprint, type ProductCommandClaim } from '../../modules/commands/index.js';
import { requireMutationActor } from '../mutation-actor.js';
import { requireSessionActor } from '../session-auth.js';
import { productRouteMetadata } from '../product-route-manifest.js';
import { ProductHttpError } from '../product-error.js';
import { sendProductCommandReceiptOutcome, mapProductDatabaseError } from '../product-command-mapping.js';
import { DatabaseOperationError } from '../../infrastructure/database/errors.js';
import { readKnownCommandId } from './collection-route-helpers.js';
import { consumeProductAdmission, type ProductAdmissionRateLimiter } from '../http-security.js';
import { httpCommandScopeV1 } from '../http-command-scope.js';

export interface BookmarkSubscriptionRouteDeps {
  identityUnitOfWork?:IdentityUnitOfWork; unitOfWork?:BookmarkSubscriptionUnitOfWork; allowedOrigins:readonly string[];
  enabled:()=>boolean; protocolReady:()=>boolean; cursorKey:string|Uint8Array;
  rateLimiter?:ProductAdmissionRateLimiter; csrfMatches?:(raw:string,expectedHash:string)=>boolean;
}
const BASE='/api/v1/me/';
export const BOOKMARK_SUBSCRIPTION_ROUTES = [
  ['GET','bookmark-subscription-capabilities','capabilities',[]],
  ['GET','bookmark-subscription-sources','sources',['sourceType','relation','q','limit','cursor']],
  ['GET','bookmark-subscription-sources/:sourceType/:sourceId','source',[]],
  ['GET','bookmark-subscriptions','subscriptions',['status','limit','cursor']],
  ['POST','bookmark-subscriptions','createSubscription',[]],
  ['GET','bookmark-subscriptions/:subscriptionId','subscription',[]],
  ['GET','bookmark-subscriptions/:subscriptionId/mappings','subscriptionMappings',['profileId','limit','cursor']],
  ['POST','bookmark-subscriptions/:subscriptionId/mappings','createMapping',[]],
  ['GET','bookmark-subscription-mappings','mappings',['profileId','sourceType','status','q','limit','cursor']],
  ['GET','bookmark-subscription-mappings/:mappingId','mapping',[]],
  ['PATCH','bookmark-subscription-mappings/:mappingId','updateMapping',[]],
  ['GET','bookmark-subscription-mappings/:mappingId/projection','projection',[]],
  ['GET','bookmark-subscription-mappings/:mappingId/access','access',['editionIds','actionId']],
  ['POST','bookmark-subscription-mappings/:mappingId/node-access-checks','nodeAccess',[]],
  ['POST','bookmark-subscription-snapshots','snapshot',[]],
  ['GET','bookmark-subscription-snapshots/:snapshotId/nodes','nodes',['cursor']],
  ['POST','bookmark-subscription-exit-previews','preview',[]],
  ['POST','bookmark-subscription-exits','exit',[]],
  ['GET','bookmark-subscription-actions','actions',['profileId','limit','cursor']],
  ['POST','bookmark-subscription-actions/:actionId/ack','ack',[]],
] as const;
const gated=new Set(['sources','source','createSubscription','createMapping','updateMapping','projection','snapshot','nodes']);
export const SUBSCRIPTION_LIMITS={editionsPerMapping:20,mappingsPerProfile:50,nodesPerProfile:20000,nodesPerSnapshot:20000,nodeAccessBatchSize:128,nodeAccessRequestBytes:65536,maxDepth:128,snapshotBytes:33554432,editionScanCandidates:10000} as const;
export function mapSubscriptionError(error:unknown):never {
  if(error instanceof ActorCollectionReadLimitError)error=new BookmarkSubscriptionError('payload_too_large');
  if(error instanceof BookmarkSubscriptionError){const status={invalid_request:400,invalid_query:400,invalid_cursor:400,resource_not_found:404,revision_conflict:409,precondition_failed:412,precondition_required:428,payload_too_large:413,invalid_document:422,snapshot_expired:409,rate_limited:429,feature_temporarily_unavailable:503}[error.code];throw new ProductHttpError({statusCode:status,code:error.code,message:error.message,...(status===429||status===503?{retryAfterSeconds:1,headers:{'Retry-After':'1'}}:{})});}
  if(error instanceof DatabaseOperationError)throw mapProductDatabaseError(error);throw error;
}
export function registerBookmarkSubscriptionRoutes(app:FastifyInstance,deps:BookmarkSubscriptionRouteDeps):void {
  const codec=createSubscriptionCursorCodec(deps.cursorKey);const builds=new Map<string,number>();
  for(const [method,suffix,operation,allowedQuery]of BOOKMARK_SUBSCRIPTION_ROUTES){const route=BASE+suffix;const read=method==='GET';const mutation=!read&&operation!=='nodeAccess';
    app.route({method,url:route,exposeHeadRoute:false,bodyLimit:operation==='nodeAccess'?65536:4096,config:{...productRouteMetadata(method,route),productTransport:{allowedQuery:[...allowedQuery],rejectRequestBody:read,acceptedMediaTypes:read?[]:['application/json'],bodyLimitBytes:operation==='nodeAccess'?65536:4096,cacheControl:'private-no-store'}},handler:async(request,reply)=>{
      reply.header('Cache-Control','private, no-store');
      try {
        if(!deps.identityUnitOfWork||!deps.unitOfWork)fail('feature_temporarily_unavailable');
        if(!read && request.headers.cookie){const current=await requireSessionActor(request,deps.identityUnitOfWork,{touch:false});if('session'in current)reply.header('Known-Subscription-Session',current.session.id);}
        const identity=read?await requireSessionActor(request,deps.identityUnitOfWork,{touch:false}):await requireMutationActor(request,{identityUnitOfWork:deps.identityUnitOfWork,allowedOrigins:deps.allowedOrigins,csrfMatches:deps.csrfMatches});
        if('session'in identity)reply.header('Known-Subscription-Session',identity.session.id);
        const actor={accountId:identity.account.id,subjectId:identity.account.subjectId};
        if(gated.has(operation)&&(!deps.enabled()||!deps.protocolReady()))fail('resource_not_found');
        if(deps.rateLimiter){const purpose=operation==='snapshot'?'subscription-snapshot':mutation?'subscription-command':'subscription-read';const admission=await consumeProductAdmission(deps.rateLimiter,purpose+':'+actor.accountId);if(admission.kind==='failed')fail('feature_temporarily_unavailable');if(admission.kind==='denied')throw new ProductHttpError({statusCode:429,code:'rate_limited',message:'Too many subscription requests.',retryAfterSeconds:admission.retryAfterSeconds,headers:{'Retry-After':String(admission.retryAfterSeconds)}});}
        const query=request.query as Record<string,string>;const params=request.params as Record<string,string>;const id=(name:string)=>name==='subscriptionId'?opaque(params[name]):uuid(params[name]);
        if(operation==='capabilities'){if(!deps.protocolReady())fail('feature_temporarily_unavailable');return reply.send({protocolVersion:1,contentEnabled:deps.enabled(),limits:SUBSCRIPTION_LIMITS});}
        if(operation==='nodeAccess'&&request.headers['known-command-id']!==undefined)fail('invalid_request');
        if(operation==='access'&&request.headers['if-none-match']!==undefined)fail('invalid_request');
        const execute=async(p:SubscriptionTransactionPorts):Promise<{status:number;body:unknown;etag?:string}>=>{
          const ok=(body:unknown,status=200,tag?:string)=>({body,status,...(tag?{etag:tag}:{})});
          switch(operation){
            case 'sources':case 'subscriptions':case 'mappings':case 'actions':return ok(await listConfiguration(p,actor,operation,query,codec));
            case 'source':{const value=await p.sources.get(actor,sourceRef(params));if(!value)fail('resource_not_found');return ok(value);}
            case 'subscription':{const value=await p.store.getSubscription(actor.accountId,id('subscriptionId'));if(!value)fail('resource_not_found');return ok(value,200,etag(value));}
            case 'mapping':{const value=await p.store.getMapping(actor.accountId,id('mappingId'));if(!value)fail('resource_not_found');return ok(value,200,etag(value));}
            case 'subscriptionMappings':return ok(await listConfiguration(p,actor,'mappings',query,codec,id('subscriptionId')));
            case 'createSubscription':{const result=await createSubscription(p,actor,request.body);return ok(result.value,result.status,etag(result.value));}
            case 'createMapping':{const value=await createMapping(p,actor,id('subscriptionId'),request.body,header(request,'if-match'));return ok(value,201,etag(value));}
            case 'updateMapping':{const value=await updateMapping(p,actor,id('mappingId'),request.body,header(request,'if-match'));return ok(value,200,etag(value));}
            case 'projection':{const value=await projectionCheck(p,actor,id('mappingId'));return ok(value.value,value.etag&&header(request,'if-none-match')===value.etag?304:200,value.etag);}
            case 'access':{const editions=query.editionIds===undefined?[]:query.editionIds.split(',');if(editions.length>20||new Set(editions).size!==editions.length)fail('invalid_query');editions.forEach(opaque);if(query.actionId)uuid(query.actionId);if(query.editionIds!==undefined){const mapping=await p.store.getMapping(actor.accountId,id('mappingId'));if(mapping){const source=await p.store.getSubscription(actor.accountId,mapping.subscriptionId);if(source?.sourceType==='collection')fail('invalid_query');}}return ok(await accessCheck(p,actor,id('mappingId'),deps.enabled()&&deps.protocolReady(),editions,query.actionId));}
            case 'nodeAccess':{const body=object(request.body,['generation','actionId','nodes'],['generation','nodes']);if(body.actionId!==undefined)uuid(body.actionId);return ok(await checkNodes(p,actor,id('mappingId'),deps.enabled()&&deps.protocolReady(),opaque(body.generation),nodeRefs(body.nodes),body.actionId as string|undefined));}
            case 'snapshot':return ok(await createSnapshot(p,actor,request.body),201);
            case 'nodes':return ok(await snapshotNodes(p,actor,id('snapshotId'),query.cursor,codec));
            case 'preview':{const input=exitInput(request.body);const value=await saveExitPreview(p,actor,input);return ok(value,201);}
            case 'exit':{const body=object(request.body,['previewId']);const savedPreview=await p.store.getPreview(actor.accountId,uuid(body.previewId));const preview=savedPreview?.preview;if(!preview)fail('resource_not_found');if(preview.trigger!=='unsubscribe')fail('invalid_request');return ok(await commitExit(p,actor,exitInput({trigger:preview.trigger,target:preview.target}),preview.previewId),202);}
            case 'ack':{const body=object(request.body,['mappingId','generation','result']);return ok(await acknowledgeAction(p,actor,id('actionId'),{mappingId:uuid(body.mappingId),generation:opaque(body.generation),result:body.result as ActionReceipt['result']}));}
            default:return fail('invalid_request');
          }
        };
        const building=operation==='snapshot';if(building){const count=builds.get(actor.accountId)??0;if(count>=2)fail('rate_limited');builds.set(actor.accountId,count+1);}
        const controller=new AbortController();const timer=setTimeout(()=>controller.abort(new Error('Subscription request budget exhausted')),15000);
        const abort=()=>controller.abort(new Error('Subscription request disconnected'));request.raw.once('aborted',abort);
        try {
          const response=await deps.unitOfWork.execute(async p=>{
            if(!mutation)return execute(p);
            const commandId=readKnownCommandId(request);const binding={principalId:actor.accountId,commandScope:httpCommandScopeV1(method,route),commandId};
            const fingerprint=canonicalCommandFingerprint({method,route,mediaType:'application/json',body:{params,body:request.body},query:{},conditions:{ifMatch:header(request,'if-match')}});
            const claim=await p.receipts.claim(binding,fingerprint);
            if(claim.kind!=='claimed'){
              if(claim.kind==='replay'&&operation==='snapshot'){const descriptor=JSON.parse(Buffer.from(claim.result.body).toString()) as import('../../modules/bookmark-subscriptions/index.js').SnapshotDescriptor;await authorizeSnapshotReceipt(p,actor,descriptor);}
              return {claim};
            }
            await p.lockAccount(actor.accountId);const result=await execute(p);
            await p.receipts.complete(binding,fingerprint,{status:result.status,body:Buffer.from(JSON.stringify(result.body)),stableHeaders:{'cache-control':'private, no-store',...(result.etag?{etag:result.etag}:{})},mediaType:'application/json',contractVersion:'1',targetIdentity:typeof result.body==='object'&&result.body!==null?'bookmark-subscriptions':undefined});
            return result;
          },{write:mutation&&operation!=='snapshot',signal:controller.signal});
          if('claim'in response){const claim=response.claim;if(claim.kind==='replay')return sendProductCommandReceiptOutcome(reply,{kind:'replay',...claim.result});return sendProductCommandReceiptOutcome(reply,claim as Exclude<ProductCommandClaim,{kind:'claimed'}|{kind:'replay'}>);}
          if(response.etag)reply.header('ETag',response.etag);return reply.code(response.status).send(response.status===304?undefined:response.body);
        }finally{clearTimeout(timer);request.raw.removeListener('aborted',abort);if(building){const count=(builds.get(actor.accountId)??1)-1;if(count)builds.set(actor.accountId,count);else builds.delete(actor.accountId);}}
      }catch(error){mapSubscriptionError(error);}
    }});
  }
}
function header(request:FastifyRequest,name:string):string|undefined {const v=request.headers[name];if(v!==undefined&&typeof v!=='string')fail('invalid_request');return v as string|undefined;}
