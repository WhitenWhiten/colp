import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, test, expect, vi } from 'vitest';
import { ClassificationError, ClassificationProviderError, classificationFailureReceipt, type ClassificationPreviewRuntime } from '../../../src/modules/collections/index.js';
import { createFixedWindowRateLimiter } from '../../../src/transport/http-security.js';
import { createProductClassificationClient } from '../../../generated/openapi/product-v1.client.js';
import { classificationHttpHarness, classificationAuthHeaders } from '../../support/classification-http-harness.js';
import { CreditError, type CreditFailureCode, type CreditQuoteContext } from '../../../src/modules/identity/index.js';

const servers: ReturnType<typeof classificationHttpHarness>[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(app => app.close())); });
const path = '/api/v1/collections/library/classification/preview';
const payload = {source:'web' as const,nodeId:'bookmark',requested:{folder:true,tags:true}};
const headers = () => ({...classificationAuthHeaders,'known-command-id':randomUUID()});
function setup(preview: ClassificationPreviewRuntime['preview'] = async () => ({kind:'in_progress',retryAfterSeconds:1}), options: Parameters<typeof classificationHttpHarness>[1] = {}) {
  const spy = vi.fn(preview); const app = classificationHttpHarness({preview:spy},options); servers.push(app);return {app,spy};
}
test('preview enforces session, Origin, CSRF and command admission before calling runtime',async()=>{
  const {app,spy} = setup();
  for (const [changes,status] of [[{cookie:undefined},401],[{authorization:'Bearer colp-sync',cookie:undefined},401],
    [{authorization:'Bearer colp-sync'},400],[{origin:'https://evil.test'},403],[{'x-csrf-token':'bad'},403],
    [{'known-command-id':undefined},400],[{'known-command-id':'invalid'},400]] as const) {
    const response=await app.inject({method:'POST',url:path,headers:Object.fromEntries(Object.entries({...headers(),...changes}).filter((entry): entry is [string,string] => entry[1] !== undefined)),payload});expect(response.statusCode).toBe(status);
  }
  expect(spy).not.toHaveBeenCalled();
  const disabled=setup(undefined,{enabled:false});
  expect((await disabled.app.inject({method:'POST',url:path,payload})).statusCode).toBe(401);
  expect((await disabled.app.inject({method:'POST',url:path,headers:headers(),payload})).statusCode).toBe(404);
  expect(disabled.spy).not.toHaveBeenCalled();
});
test('closed DTO, field byte limits, query/media and 128 KiB body limit fail before runtime',async()=>{
  const {app,spy}=setup();
  const bookmark={title:'title',url:'https://example.org',description:null};
  const incoming={source:'extension',requested:payload.requested,bookmark};
  for(const body of [{...payload,bookmark},{...payload,taxonomy:[]},{...payload,requested:{folder:false,tags:false}},
    {...incoming,bookmark:{...bookmark,title:'中'.repeat(342)}},{...incoming,bookmark:{...bookmark,description:'中'.repeat(5462)}},
    {...incoming,bookmark:{...bookmark,url:'https://user:pass@example.org'}}]) {
    expect((await app.inject({method:'POST',url:path,headers:headers(),payload:body})).statusCode).toBe(422);
  }
  expect((await app.inject({method:'POST',url:path+'?extra=1',headers:headers(),payload})).statusCode).toBe(400);
  expect((await app.inject({method:'POST',url:path,headers:{...headers(),'content-type':'text/plain'},payload:'x'})).statusCode).toBe(415);
  expect((await app.inject({method:'POST',url:path,headers:headers(),payload:{...incoming,bookmark:{...bookmark,description:'x'.repeat(128*1024)}}})).statusCode).toBe(413);
  expect(spy).not.toHaveBeenCalled();
});
test('receipt outcomes keep exact bytes and stable headers; pending and reuse have canonical errors',async()=>{
  const receipt=classificationFailureReceipt('original-request','outcome_unknown');
  const {app,spy}=setup(async()=>({kind:'replay',result:receipt}));
  const response=await app.inject({method:'POST',url:path,headers:headers(),payload});
  expect(response.statusCode).toBe(503);expect(response.body).toBe(Buffer.from(receipt.body).toString());
  expect(response.headers['content-type']).toBe('application/json; charset=utf-8');expect(response.headers['cache-control']).toBe('private, no-store');
  expect(response.json().error.sameRequestRetrySafe).toBe(false);
  for(const [outcome,status,code] of [[{kind:'in_progress',retryAfterSeconds:2},409,'command_in_progress'],[{kind:'reused'},409,'command_id_reused'],[{kind:'expired'},410,'command_result_expired']] as const){
    spy.mockResolvedValueOnce(outcome);const result=await app.inject({method:'POST',url:path,headers:headers(),payload});
    expect(result.statusCode).toBe(status);expect(result.json().error.code).toBe(code);
  }
});
test('errors conceal resources and allow only same-command retry when deadline wins',async()=>{
  const {app,spy}=setup();
  for(const [error,status,code] of [[new ClassificationError('resource_not_found'),404,'resource_not_found'],[new ClassificationError('context_limit'),413,'payload_too_large'],[new ClassificationProviderError('deadline'),503,'feature_temporarily_unavailable']] as const){
    spy.mockRejectedValueOnce(error);const response=await app.inject({method:'POST',url:path,headers:headers(),payload});
    expect(response.statusCode).toBe(status);expect(response.json().error.code).toBe(code);
    if(status===503)expect(response.json().error).toMatchObject({recovery:'same_request',sameRequestRetrySafe:true});
  }
});
test('rate limits prevent runtime calls and generated preview client preserves command intent without retries',async()=>{
  const {app,spy}=setup(undefined,{limiter:createFixedWindowRateLimiter({maxRequests:1,windowMs:60000})});
  const command=randomUUID();
  const transport:typeof fetch=async(url,init)=>{
    const result=await app.inject({method:'POST',url:new URL(String(url)).pathname,headers:Object.fromEntries(new Headers(init?.headers)),payload:init?.body as string});
    return new Response(result.body,{status:result.statusCode,headers:new Headers(result.headers as Record<string,string>)});
  };
  const client=createProductClassificationClient({origin:'https://app.example.test',sessionCookie:classificationAuthHeaders.cookie,csrfToken:'csrf',originHeader:classificationAuthHeaders.origin,fetch:transport});
  await expect(client.preview('library',payload,command)).rejects.toMatchObject({status:409,problem:{error:{code:'command_in_progress'}}});
  expect(spy).toHaveBeenCalledTimes(1);expect(spy.mock.calls[0]?.[0]).toMatchObject({commandId:command,document:payload,actor:{principalId:'account',subjectId:'owner'}});
  await expect(client.preview('library',payload,command)).rejects.toMatchObject({status:429});expect(spy).toHaveBeenCalledTimes(1);
});

test('legal escaped maximum incoming description fits preview body budget and preserves bytes',async()=>{
  const {app,spy}=setup();
  const incoming={source:'extension',requested:{folder:false,tags:true},bookmark:{title:'中'.repeat(341),url:'https://example.org',description:'\u0001'.repeat(16384)}};
  const result=await app.inject({method:'POST',url:path,headers:headers(),payload:incoming});
  expect(result.statusCode).toBe(409);expect(spy.mock.calls[0]?.[0].document).toEqual(incoming);
});

test('billing stays closed, preserves consent in the command input, and cannot declare a free mode', async () => {
  const {app,spy}=setup();
  const billing={priceVersion:'bookmark-classify.v1',maxPoints:1};
  const accepted=await app.inject({method:'POST',url:path,headers:headers(),payload:{...payload,billing}});
  expect(accepted.statusCode).toBe(409);
  expect(spy.mock.calls[0]?.[0].document).toEqual({...payload,billing});
  spy.mockClear();
  for(const invalid of [null,{}, {...billing,mode:'byok'}, {...billing,chargeId:randomUUID()},
    {...billing,maxPoints:-1},{...billing,maxPoints:1.5},{...billing,maxPoints:2147483648},
    {...billing,priceVersion:'Not A Price'},{...billing,maxPoints:'1'}]) {
    const result=await app.inject({method:'POST',url:path,headers:headers(),payload:{...payload,billing:invalid}});
    expect(result.statusCode).toBe(422);
    expect(result.json().error.code).toBe('invalid_document');
  }
  expect(spy).not.toHaveBeenCalled();
});

test('credit failures retain the shared golden envelope semantics and exact HTTP retry policy', async () => {
  const golden=JSON.parse(readFileSync(new URL('../../../../docs/plans/active/cross-module/classification-credits/contracts/golden.json',import.meta.url),'utf8')) as {
    name:string;schema:string;value:{error:{code:CreditFailureCode;creditContext?:CreditQuoteContext;recovery:string;sameRequestRetrySafe:boolean;retryAfterSeconds:number|null}};
  }[];
  const {app,spy}=setup();
  for(const fixture of golden.filter(item=>item.schema==='CreditErrorEnvelope'&&!['invalid_cursor','cursor_expired'].includes(item.name))) {
    const expected=fixture.value.error;
    spy.mockRejectedValueOnce(new CreditError(expected.code,expected.creditContext));
    const result=await app.inject({method:'POST',url:path,headers:headers(),payload});
    const status=expected.code==='billing_consent_required'?422:expected.code.startsWith('credits_')?503:409;
    expect(result.statusCode).toBe(status);
    expect(result.json().error).toMatchObject({code:expected.code,recovery:expected.recovery,
      sameRequestRetrySafe:expected.sameRequestRetrySafe,retryAfterSeconds:expected.retryAfterSeconds,
      precondition:null,currentEtag:null,fieldErrors:[],...(expected.creditContext?{creditContext:expected.creditContext}:{})});
    expect(result.headers['cache-control']).toBe('private, no-store');
    expect(result.headers['retry-after']).toBe(status===503?'1':undefined);
    if(!expected.creditContext)expect(result.json().error).not.toHaveProperty('creditContext');
  }
});
