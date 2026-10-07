import type { FastifyInstance } from 'fastify';
import { createSubscriptionCursorCodec, fail, opaque } from '../../modules/bookmark-subscriptions/index.js';
import { requireSessionActor } from '../session-auth.js';
import { productRouteMetadata } from '../product-route-manifest.js';
import { consumeProductAdmission } from '../http-security.js';
import { mapSubscriptionError, type BookmarkSubscriptionRouteDeps } from './bookmark-subscription-routes.js';
export function registerReportReaderRoutes(app:FastifyInstance,deps:BookmarkSubscriptionRouteDeps):void {
  const codec=createSubscriptionCursorCodec(deps.cursorKey);
  for(const edition of [false,true]){const path='/api/v1/me/report-readers/:reportId'+(edition?'/editions/:editionId':'');
    app.get(path,{exposeHeadRoute:false,config:{...productRouteMetadata('GET',path),productTransport:{allowedQuery:edition?[]:['cursor','limit'],rejectRequestBody:true,cacheControl:'private-no-store'}}},async(request,reply)=>{
      reply.header('Cache-Control','private, no-store');
      try {
        if(!deps.identityUnitOfWork||!deps.unitOfWork)fail('feature_temporarily_unavailable');
        const identity=await requireSessionActor(request,deps.identityUnitOfWork,{touch:false});if('session'in identity)reply.header('Known-Subscription-Session',identity.session.id);
        const actor={accountId:identity.account.id,subjectId:identity.account.subjectId};const params=request.params as {reportId:string;editionId?:string};const id=opaque(params.reportId);const query=request.query as Record<string,string>;
        if(deps.rateLimiter){const decision=await consumeProductAdmission(deps.rateLimiter,'subscription-read:'+actor.accountId);if(decision.kind==='failed')fail('feature_temporarily_unavailable');if(decision.kind==='denied')fail('rate_limited');}
        if(query.cursor&&query.limit)fail('invalid_query');const token=query.cursor?codec.decode(query.cursor,actor.accountId,'member-reader:'+id):null;const limit=Number(token?.filter.limit??query.limit??20);if(!Number.isInteger(limit)||limit<1||limit>50)fail('invalid_query');
        return await deps.unitOfWork.execute(async p=>{const series=await p.sources.memberSeries(actor,id);if(!series)fail('resource_not_found');
          if(edition){const projection=await p.sources.memberEdition(actor,id,opaque(params.editionId));if(!projection)fail('resource_not_found');return reply.send({series,edition:projection.editions[0],nodes:projection.nodes,reader:projection.reader});}
          const rows=await p.sources.memberEditions(actor,id,token?.after,limit+1);const editions=rows.slice(0,limit);const nextCursor=rows.length>limit?codec.encode({accountId:actor.accountId,scope:'member-reader:'+id,filter:{limit:String(limit)},after:editions.at(-1)!.editionId,expiresAt:token?.expiresAt??Date.now()+900000}):null;return reply.send({series,editions,nextCursor});
        });
      }catch(error){mapSubscriptionError(error);}
    });
  }
}
