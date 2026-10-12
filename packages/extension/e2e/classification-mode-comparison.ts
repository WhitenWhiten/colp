import type {ClassificationPreviewResponse} from '../src/classification-product-client.js';
import type {Page} from '@playwright/test';
import {expect} from '@playwright/test';
import type {startRealStack} from './real-stack.js';
import {FIXTURE_COLLECTION_ID} from './fixture-ids.js';
export const comparisonDocument={source:'extension',bookmark:{title:'学习 AI ＵＮＩＣＯＤＥ',url:'https://example.org/local-classified',description:'学习资料 React context '.repeat(200)},requested:{folder:true,tags:true}};
/**
 * A hosted preview is refused 422 `billing_consent_required` unless the request
 * carries the price the user agreed to, exactly as the popup attaches the quote it
 * displayed (popup-classification.ts: `billing:{priceVersion,maxPoints}`). Only the
 * managed mode charges credits: `server_byok` resolves to the byok billing mode and
 * `extension_local` never reaches the Product route.
 */
// Know-N backend CLASSIFICATION_CREDIT_PRICE; a stale value fails the preview with credit_price_changed.
export const managedPreviewConsent=Object.freeze({priceVersion:'bookmark-classify.v1',maxPoints:1});
export function comparisonRequestDocument(mode:string){
  return mode==='server_managed'?{...comparisonDocument,billing:managedPreviewConsent}:comparisonDocument;
}
export async function compareClassificationMode(page:Page,stack:Awaited<ReturnType<typeof startRealStack>>,mode:string){
  const before=stack.classificationProduct!.providerCallCount(),latencies:number[]=[];let decision:unknown;
  const document=comparisonRequestDocument(mode);
  for(let index=0;index<20;index++){
    const measured=await page.evaluate(async message=>{
      const start=performance.now(),reply=await chrome.runtime.sendMessage(message);return {elapsedMs:performance.now()-start,reply};
    },{kind:'known.classification.preview',collectionId:FIXTURE_COLLECTION_ID,commandId:crypto.randomUUID(),userGesture:true,document});
    expect(measured.reply,JSON.stringify(measured.reply)).toMatchObject({ok:true});latencies.push(measured.elapsedMs);
    const reply=measured.reply as {ok:true;result:ClassificationPreviewResponse};
    const current={folder:reply.result.folder,tags:reply.result.tags,candidateCoverage:reply.result.candidateCoverage};
    if(decision)expect(current).toEqual(decision);decision=current;
  }
  latencies.sort((a,b)=>a-b);const calls=stack.classificationProduct!.providerCallCount()-before;
  return {mode,samples:latencies.length,p50Ms:latencies[9],p95Ms:latencies[18],failures:0,providerCalls:calls,inputTokens:calls,outputTokens:0,
    providerInputHashes:stack.classificationProduct!.providerInputHashes().slice(before),fixtureModelVersion:'jev-1.13.0',estimatedSpendUsd:calls*0.042/1_000_000,decision};
}
export async function enableFixtureByok(web:Page){
  await web.goto('https://known.example/api/v1/session');
  const result=await web.evaluate(async collectionId=>{
    const session=await (await fetch('/api/v1/session',{credentials:'include'})).json();
    const mutate=async(path:string,method:string,document?:unknown,etag?:string,media='application/json')=>{
      const response=await fetch(path,{method,credentials:'include',headers:{'X-CSRF-Token':session.csrfToken,'Known-Command-Id':crypto.randomUUID(),
        ...(document===undefined?{}:{'Content-Type':media}),...(etag?{'If-Match':etag}:{})},...(document===undefined?{}:{body:JSON.stringify(document)})});
      return {status:response.status,body:await response.json()};
    };
    const created=await mutate('/api/v1/me/classification-provider-profiles','POST',{kind:'cloudflare_ai_gateway',model:'typesafe/jev',label:'Chromium BYOK fixture',config:{accountId:'a'.repeat(32),gatewayId:'default'},secret:'byok-fixture-secret'});
    if(created.status!==201)return created;
    const tested=await mutate(`/api/v1/me/classification-provider-profiles/${created.body.profileId}/test`,'POST');if(tested.status!==200)return tested;
    const path=`/api/v1/collections/${collectionId}/classification-settings`,media='application/vnd.known.classification-settings.v2+json';
    const settings=await fetch(path,{credentials:'include',headers:{Accept:media}});
    return mutate(path,'PATCH',{executionMode:'server_byok',providerProfileId:created.body.profileId},settings.headers.get('etag')!,media);
  },FIXTURE_COLLECTION_ID);
  expect(result.status,JSON.stringify(result.body)).toBe(200);
}
