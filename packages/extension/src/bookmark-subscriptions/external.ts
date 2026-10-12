import { subscriptionLane } from './coordination.js';
import type { BuildConfig } from '../types.js';
import { isProtocolOpaqueId } from '../protocol-id.js';
import { UUID } from './product-client.js';
import { record } from './commands.js';
import type { Draft } from './local-types.js';
import { subscriptionStore as db } from './store.js';
export function validateExternalReference(message:unknown,senderUrl:string|undefined,config:BuildConfig):Draft|null{
  if(!record(message)||Object.keys(message).length!==4||Object.keys(message).some(k=>!['kind','requestId','sourceType','sourceId'].includes(k))||message.kind!=='known.subscription.open'||typeof message.requestId!=='string'||!UUID.test(message.requestId)||!['collection','digest_series'].includes(String(message.sourceType))||!isProtocolOpaqueId(message.sourceId)||typeof message.sourceId!=='string'||message.sourceId.length>128||!senderUrl)return null;
  let origin:string;try{const url=new URL(senderUrl);if(url.username||url.password)return null;origin=url.origin;}catch{return null;}
  const trusted=config.subscriptionBridgeOrigins?.find(entry=>entry.webOrigin===origin&&entry.serverOrigin===config.serverOrigin);if(!trusted)return null;
  return {requestId:message.requestId,sourceType:message.sourceType as Draft['sourceType'],sourceId:message.sourceId,serverOrigin:trusted.serverOrigin,expiresAt:Date.now()+900000};
}
export async function acceptExternalReference(message:unknown,senderUrl:string|undefined,config:BuildConfig):Promise<{accepted:true;protocolVersion:1}>{
  const draft=validateExternalReference(message,senderUrl,config);if(!draft)throw new Error('external_reference_rejected');
  return subscriptionLane('external:'+draft.requestId,async()=>{
    const key='external-request:'+draft.requestId;const duplicate=(await db.get('meta',key))?.value as {expiresAt:number;sourceType:string;sourceId:string;serverOrigin:string}|undefined;
    if(duplicate&&duplicate.expiresAt>Date.now()){if(duplicate.sourceType!==draft.sourceType||duplicate.sourceId!==draft.sourceId||duplicate.serverOrigin!==draft.serverOrigin)throw new Error('external_request_reused');return {accepted:true,protocolVersion:1};}
    await db.put('meta',{id:'external-draft',value:draft});
    await chrome.tabs.create({url:chrome.runtime.getURL('options.html#subscriptions/new?draft='+draft.requestId)});
    await db.put('meta',{id:key,value:draft});
    for(const old of await db.all('meta'))if(old.id.startsWith('external-request:')&&(old.value as {expiresAt?:number})?.expiresAt!<=Date.now())await db.remove('meta',old.id);
    return {accepted:true,protocolVersion:1};
  });
}
