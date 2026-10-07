import { afterEach,expect,test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createProductClassificationClient } from '../../../generated/openapi/product-v1.client.js';
import { parseClassificationRunCreate,type ClassificationRunRuntime } from '../../../src/modules/collections/index.js';
import { classificationHttpHarness,classificationAuthHeaders } from '../../support/classification-http-harness.js';
const apps:ReturnType<typeof classificationHttpHarness>[]=[];
afterEach(async()=>{await Promise.all(apps.splice(0).map(app=>app.close()));});
const runtime:ClassificationRunRuntime={create:async input=>{parseClassificationRunCreate(input.document);return {kind:'in_progress',retryAfterSeconds:1};},
  apply:async()=>({kind:'in_progress',retryAfterSeconds:1}),get:async()=>{throw new Error('not called');},cancel:async()=>({kind:'in_progress',retryAfterSeconds:1}),start(){},async stop(){}};
const request={method:'POST' as const,url:'/api/v1/collections/library/classification-runs',
  headers:{...classificationAuthHeaders,'known-command-id':randomUUID()},payload:{nodeIds:['node'],requested:{folder:true,tags:false},maxItems:50}};
test('run feature-off conceals only after Product auth; enabled create enforces selectors and 128 KiB escaped-body budget',async()=>{
  const off=classificationHttpHarness({preview:async()=>({kind:'in_progress',retryAfterSeconds:1})},{runs:runtime,enabled:false});apps.push(off);
  expect((await off.inject({...request,headers:{}})).statusCode).toBe(401);
  expect((await off.inject(request)).statusCode).toBe(404);
  const app=classificationHttpHarness({preview:async()=>({kind:'in_progress',retryAfterSeconds:1})},{runs:runtime});apps.push(app);
  expect((await app.inject({...request,payload:{...request.payload,extra:true}})).statusCode).toBe(422);
  const ids=Array.from({length:50},(_,i)=>String(i).padStart(128,'a'));
  const body=JSON.stringify({...request.payload,nodeIds:ids,sourceFolderIds:ids}).replace(/a{10,}/g,chunk=>'\\u0061'.repeat(chunk.length));
  expect(Buffer.byteLength(body)).toBeGreaterThan(64*1024);
  expect((await app.inject({...request,headers:{...request.headers,'content-type':'application/json'},payload:body})).statusCode).toBe(409);
  expect((await app.inject({...request,payload:{...request.payload,nodeIds:['a'.repeat(129)]}})).statusCode).toBe(422);
  expect((await app.inject({...request,headers:{...request.headers,'content-type':'application/json'},payload:' '.repeat(128*1024+1)})).statusCode).toBe(413);
});
test('generated run client allocates no commands or retries and preserves cancellation CAS',async()=>{
  const calls:Array<{method:string;path:string;headers:Headers;body:unknown}>=[];const command=randomUUID();
  const client=createProductClassificationClient({origin:'https://app.example.test',csrfToken:'csrf',fetch:async(url,init)=>{
    calls.push({method:init!.method!,path:new URL(String(url)).pathname,headers:new Headers(init?.headers),body:init?.body?JSON.parse(String(init.body)):null});
    return Response.json({runId:'run'},{status:200});
  }});
  await client.createRun('library',request.payload,command);await client.getRun('library','run');await client.cancelRun('library','run',command,'"r1"');
  expect(calls.map(call=>call.method)).toEqual(['POST','GET','POST']);
  expect(calls[0]!.headers.get('known-command-id')).toBe(command);expect(calls[2]!.headers.get('if-match')).toBe('"r1"');
  expect(calls[2]!.body).toEqual({});expect(calls[1]!.headers.has('known-command-id')).toBe(false);
});

test('Apply requires a single strong run ETag and the 256 KiB budget is independent from create/cancel',async()=>{
  const app=classificationHttpHarness({preview:async()=>({kind:'in_progress',retryAfterSeconds:1})},{runs:runtime});apps.push(app);
  const input={...request,url:request.url+'/run/apply',payload:{selections:[{actionId:'action',folderId:'folder',addTags:[]}]}};
  expect((await app.inject(input)).statusCode).toBe(428);
  expect((await app.inject({...input,headers:{...input.headers,'if-match':'*'}})).statusCode).toBe(400);
  expect((await app.inject({...input,headers:{...input.headers,'if-match':'"r1"','content-type':'application/json'},payload:' '.repeat(256*1024+1)})).statusCode).toBe(413);
});
