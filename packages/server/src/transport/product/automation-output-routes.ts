import { AutomationError,createAutomationPagination } from '../../modules/automation/index.js';
import { automationView,type AutomationRoute } from './automation-rule-routes.js';
export function automationOutputRoutes(cursorKey:string):AutomationRoute[]{
  const page=createAutomationPagination(cursorKey),id=(params:unknown)=>(params as {runId:string}).runId;
  return [
    {method:'GET',path:'/runs/:runId/outputs',query:['cursor','limit'],action:async({ports,actor,request})=>{
      if(!ports.outputs)throw new AutomationError('automation_unsupported_capability','Run outputs unavailable.');
      const runId=id(request.params),scope=JSON.stringify(['outputs',runId]),now=await ports.now();
      const {limit,after}=page.read(request.query as Record<string,string>,actor.accountId,scope,now),rows=await ports.outputs.list(runId,after,limit+1),last=rows[limit-1];
      return automationView({items:rows.slice(0,limit).map(r=>r.view),nextCursor:rows.length>limit && last?page.next(actor.accountId,scope,limit,{id:last.view.id,createdAt:last.createdAt},now):null});
    }},
    {method:'POST',path:'/runs/:runId/read',ifMatch:true,action:async({ports,request,ifMatch})=>{
      if(!ports.outputs)throw new AutomationError('automation_unsupported_capability','Run outputs unavailable.');
      const result=await ports.outputs.markRead(id(request.params),request.body,ifMatch);return {body:result.receipt,etag:`"${result.revision}"`};
    }},
  ];
}
