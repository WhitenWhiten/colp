import { createProductClassificationClient } from '../../../generated/openapi/product-v1.client.js';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, test } from 'vitest';
import { parseClassificationConfirmation } from '../../../src/modules/collections/index.js';
import { classificationHttpHarness, classificationAuthHeaders } from '../../support/classification-http-harness.js';

const apps: ReturnType<typeof classificationHttpHarness>[]=[];
afterEach(async()=>{await Promise.all(apps.splice(0).map(app=>app.close()));});
test('confirmation accepts exact 128-byte IDs and case-sensitive tags, rejects open or empty selections',()=>{
  const id='中'.repeat(42)+'ab';
  expect(parseClassificationConfirmation({folderId:id,addTags:['AI','ai','中'.repeat(64)]})).toEqual({folderId:id,addTags:['AI','ai','中'.repeat(64)]});
  for(const value of [{folderId:null,addTags:[]},{folderId:id+'a',addTags:[]},{folderId:' ',addTags:['AI']},
    {folderId:null,addTags:['AI','AI']},{folderId:null,addTags:[' ']},{folderId:null,addTags:['x'.repeat(65)]},
    {folderId:null,addTags:['a','b','c','d']},{folderId:null,addTags:['AI'],probability:0.9},{addTags:['AI']}])expect(()=>parseClassificationConfirmation(value)).toThrow();
});
test('confirmation requires mutation auth and one strong Node ETag before starting transaction',async()=>{
  let transactions=0;
  const app=classificationHttpHarness({preview:async()=>({kind:'in_progress',retryAfterSeconds:1})},{confirmation:{execute:async()=>{transactions++;throw new Error('must not execute');}}});apps.push(app);
  const request={method:'POST' as const,url:'/api/v1/collections/library/nodes/bookmark/classification-confirmations',
    headers:{...classificationAuthHeaders,'known-command-id':randomUUID(),'if-match':'"r1"'},payload:{folderId:null,addTags:['AI']}};
  for(const [change,status] of [[{'if-match':undefined},428],[{'if-match':'*'},400],[{'if-match':'W/"r1"'},400],
    [{'if-match':'"r1", "r2"'},400],[{'x-csrf-token':'bad'},403],[{origin:'https://evil.test'},403],[{cookie:undefined},401]] as const){
    const headers=Object.fromEntries(Object.entries({...request.headers,...change}).filter((entry):entry is [string,string]=>entry[1]!==undefined));
    expect((await app.inject({...request,headers})).statusCode).toBe(status);
  }
  expect(transactions).toBe(0);
});

test('generated confirmation client preserves command and If-Match and does not retry a stale decision',async()=>{
  let calls=0;const command=randomUUID();
  const client=createProductClassificationClient({origin:'https://app.example.test',csrfToken:'csrf',fetch:async(url,init)=>{
    calls++;expect(new URL(String(url)).pathname).toBe('/api/v1/collections/library/nodes/bookmark/classification-confirmations');
    const headers=new Headers(init?.headers);expect(headers.get('known-command-id')).toBe(command);expect(headers.get('if-match')).toBe('"old"');
    expect(JSON.parse(String(init?.body))).toEqual({folderId:null,addTags:['AI']});
    return Response.json({error:{code:'precondition_failed',currentEtag:'"new"'}},{status:412});
  }});
  await expect(client.confirm('library','bookmark',{folderId:null,addTags:['AI']},command,'"old"')).rejects.toMatchObject({status:412,problem:{error:{currentEtag:'"new"'}}});
  expect(calls).toBe(1);
});

test('generated Accept client sends optional additions without changing legacy body',async()=>{
  const sent:unknown[]=[];
  const client=createProductClassificationClient({origin:'https://app.example.test',csrfToken:'csrf',fetch:async(_url,init)=>{
    sent.push(JSON.parse(String(init?.body)));return Response.json({nodeId:'bookmark',decision:'accepted',folderId:'folder'});
  }});
  await client.acceptInbox('bookmark',{suggestionId:'folder'},randomUUID(),'"r1"');
  await client.acceptInbox('bookmark',{suggestionId:'folder',addTags:['AI']},randomUUID(),'"r1"');
  expect(sent).toEqual([{suggestionId:'folder'},{suggestionId:'folder',addTags:['AI']}]);
});

test('tag kill switch rejects confirmation before mutation while folder-only confirmation remains admitted',async()=>{
  let transactions=0;
  const app=classificationHttpHarness({preview:async()=>({kind:'in_progress',retryAfterSeconds:1})},
    {tagsEnabled:false,confirmation:{execute:async()=>{transactions++;return {kind:'in_progress',retryAfterSeconds:1} as never;}}});apps.push(app);
  const request={method:'POST' as const,url:'/api/v1/collections/library/nodes/bookmark/classification-confirmations',
    headers:{...classificationAuthHeaders,'known-command-id':randomUUID(),'if-match':'"r1"'}};
  expect((await app.inject({...request,payload:{folderId:null,addTags:['AI']}})).statusCode).toBe(404);
  expect(transactions).toBe(0);
  await app.inject({...request,payload:{folderId:'folder',addTags:[]}});
  expect(transactions).toBe(1);
});

test('tag kill switch also fences Accept additions without disabling the legacy move request',async()=>{
  let transactions=0;
  const app=classificationHttpHarness({preview:async()=>({kind:'in_progress',retryAfterSeconds:1})},
    {tagsEnabled:false,inboxAccept:{execute:async()=>{transactions++;return {kind:'in_progress',retryAfterSeconds:1} as never;}}});apps.push(app);
  const request={method:'POST' as const,url:'/api/v1/me/classify-inbox/bookmark/accept',
    headers:{...classificationAuthHeaders,'known-command-id':randomUUID(),'if-match':'"r1"'}};
  expect((await app.inject({...request,payload:{suggestionId:'folder',addTags:['AI']}})).statusCode).toBe(404);
  expect(transactions).toBe(0);
  await app.inject({...request,payload:{suggestionId:'folder'}});
  expect(transactions).toBe(1);
});
