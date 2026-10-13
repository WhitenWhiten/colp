import { afterEach,expect,test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { automationPollingFixture } from '../../support/automation-polling-fixture.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import { apps,startApi,mcpEnv,postJson,modernBody } from '../../support/phase4b-mcp-transport-scaffold.js';
import { createMcpEventsAdapter } from '../../../src/modules/mcp/events-adapter.js';
import { createSubscriptionStore } from '../../../src/infrastructure/automation/subscription-store.js';
import { createWebhookVerifier } from '../../../src/infrastructure/automation/webhook-verifier.js';
import { createDeliveryWorker } from '../../../src/infrastructure/automation/delivery-worker.js';
import { createAutomationToolPort,withAutomationCatalog,automationWorkPrincipal,type McpApplicationFacade } from '../../../src/modules/mcp/index.js';
const base:McpApplicationFacade={listTools:async()=>({tools:[]}),callTool:async()=>({kind:'rejected',stableCode:'unknown_tool',safeMessage:'Unknown',retryable:false}),
  listResources:async()=>({resources:[]}),listResourceTemplates:async()=>({resourceTemplates:[]}),readResource:async()=>({contents:[]})};
describeWithPostgres('AW-46 production MCP Events envelope lifecycle (simulated host)',()=>{
  let f:Awaited<ReturnType<typeof automationPollingFixture>>,server:Awaited<ReturnType<typeof startApi>>;
  afterEach(async()=>{for(const app of apps.splice(0))await app.close();await f?.close();});
  test('authenticated discovery → challenge → wake → queue reconciliation → one canonical effect; replay and cancellation',async()=>{
    const secret='whsec_'+Buffer.alloc(32,4).toString('base64'),delivered:string[]=[];
    const verifier=createWebhookVerifier(Buffer.alloc(32,8),{resolve:async()=>['8.8.8.8'],connect:async(_target,init)=>{
      const body=JSON.parse(String(init.body));if(body.type==='verification')return Response.json({challenge:_target.url.pathname==='/bad'?'mismatch':body.challenge});
      delivered.push(String(init.body));return new Response(null,{status:204});
    }});
    let subscription:Record<string,unknown>,input:Record<string,unknown>;
    const rpc=async(method:string,params:Record<string,unknown>={})=>{
      const response=await postJson(server,method,1,{headers:{authorization:'Bearer '+f.token,...(method==='tools/call'?{'mcp-name':String(params.name)}:{})},body:modernBody(method,1,params)});
      const text=await response.text();expect(response.status,text).toBe(200);return JSON.parse(text);
    };
    f=await automationPollingFixture('aw46_lifecycle',{wakeMode:'events',pair:async(baseFixture,grant)=>{
      expect((await baseFixture.pair(grant)).statusCode).toBe(200);
      const facade=withAutomationCatalog(base,createAutomationToolPort({access:c=>baseFixture.worker.access(automationWorkPrincipal(c)),
        configurations:baseFixture.uow,worker:baseFixture.work,pairing:baseFixture.worker,cursorKey:'events-test-cursor-key-at-least-32-bytes'}));
      const origin='https://automation.example.test';
      server=await startApi(mcpEnv({PUBLICATION_ORIGIN:origin,MCP_OAUTH_AUDIENCE:origin+'/collections/-/mcp',MCP_OAUTH_ISSUER:origin+'/api/v1/auth',MCP_OAUTH_JWKS_URI:origin+'/api/v1/auth/jwks',MCP_OAUTH_AUTHORIZATION_SERVER_METADATA_URL:origin+'/.well-known/oauth-authorization-server/api/v1/auth',MCP_OAUTH_SCOPES:'automation:work'}),{
        oauthVerifier:baseFixture.verifier,applicationFacade:{...facade,events:createMcpEventsAdapter(createSubscriptionStore(baseFixture.db,baseFixture.worker,verifier))}});
      input={name:'colp.automation.triggered',arguments:{targetId:grant.targetId},delivery:{mode:'webhook',url:'https://receiver.example/hook',secret}};
      const response=await postJson(server,'events/subscribe',1,{headers:{authorization:'Bearer '+baseFixture.token},body:modernBody('events/subscribe',1,input)});
      expect(response.status).toBe(200);const value=await response.json();expect(value.error).toBeUndefined();subscription=value.result;
    }});
    expect((await rpc('server/discover')).result.capabilities.events).toEqual({});
    expect((await rpc('events/list')).result.events[0].delivery).toEqual(['webhook']);
    expect((await rpc('events/subscribe',{...input!,delivery:{mode:'webhook',url:'https://receiver.example/bad',secret}})).error.code).toBe(-32015);
    const anonymous=await postJson(server,'events/list',1);expect((await anonymous.json()).error.code).toBe(-32601);
    const anonymousDiscovery=await postJson(server,'server/discover',1);expect((await anonymousDiscovery.json()).result.capabilities.events).toBeUndefined();
    expect((await rpc('events/subscribe',{...input!,cursor:'replay'})).error.code).toBe(-32602);
    expect((await rpc('events/subscribe',input!)).result.id).toBe(subscription!.id);
    // Renewal preserves queued occurrences; host reconciliation still tolerates missed/duplicate wakes.
    const worker=createDeliveryWorker(f.db,f.worker.authorize,verifier);await worker.tick();expect(delivered).toHaveLength(1);
    await f.createNode('second-paper','root','Second','https://arxiv.org/abs/second');
    await f.createNode('third-paper','root','Third','https://arxiv.org/abs/third');await f.inspect();await worker.tick();await worker.tick();expect(delivered).toHaveLength(3);
    delivered.reverse(); // Simulated host processes the burst out of order and may repeat any wake.
    const call=async(name:string,args:Record<string,unknown>)=>{
      const result=await rpc('tools/call',{name,arguments:args});expect(result.error,JSON.stringify(result)).toBeUndefined();
      return result.result.structuredContent;
    };
    const queue=await call('automation.jobs.list',{targetId:f.target.id});expect(queue.items).toHaveLength(3);
    const job=queue.items.find((item:{id:string})=>item.id===JSON.parse(delivered[0]!).data.jobId),inputs=await call('automation.jobs.inputs',{jobId:job.id,deliveryHandle:job.deliveryHandle});
    const lease=await call('automation.jobs.claim',{jobId:job.id,commandId:randomUUID(),request:{deliveryHandle:job.deliveryHandle}});
    const request={claimToken:lease.claimToken,generation:lease.generation,inputDigest:lease.inputDigest,outputContract:job.task.outputContract,
      output:{kind:'text',textType:'summary',text:'Simulated host lifecycle result.',language:'en',evidence:[{kind:'source',reference:inputs.items[0].sourceEventId,observedAt:new Date().toISOString()}]}};
    const args={jobId:job.id,commandId:randomUUID(),request};
    expect((await call('automation.jobs.submit',args)).status).toBe('succeeded');await call('automation.jobs.submit',args);
    expect((await sql`SELECT id FROM automation_effect_receipts WHERE job_id=${job.id}`.execute(f.db)).rows).toHaveLength(1);
    const unsubscribe={...input!,delivery:{mode:'webhook',url:'https://receiver.example/hook'}};
    expect((await rpc('events/unsubscribe',unsubscribe)).result).toEqual({});expect((await rpc('events/unsubscribe',unsubscribe)).result).toEqual({});
  });
});
