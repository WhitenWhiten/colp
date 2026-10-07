import type { SubscriptionTransactionPorts, SubscriptionActor } from './contracts.js';
import type { Subscription, Mapping, SourceView, CreateMapping, MappingPatch, SubscriptionListItem, MappingListItem } from '../domain/types.js';
import { etag, fail, mappingInput, requireMatch, revision, sourceRef, uuid } from './validation.js';
import { createSubscriptionCursorCodec } from './cursor.js';
import { mappingAndSource } from './projections.js';
export async function createSubscription(p:SubscriptionTransactionPorts,actor:SubscriptionActor,input:unknown):Promise<{value:Subscription;status:number}> {
  const ref=sourceRef(input);if(!await p.sources.get(actor,ref))fail('resource_not_found');
  const existing=(await p.store.subscriptions(actor.accountId,{status:'active',source:ref},{limit:1}))[0];if(existing)return {value:existing,status:200};
  const value:Subscription={...ref,subscriptionId:revision(),status:'active',revision:revision(),createdAt:(await p.now()).toISOString(),terminatedAt:null};await p.store.saveSubscription(actor.accountId,value);return {value,status:201};
}
export async function createMapping(p:SubscriptionTransactionPorts,actor:SubscriptionActor,subscriptionId:string,input:unknown,match?:string):Promise<Mapping> {
  const s=await p.store.getSubscription(actor.accountId,subscriptionId);if(!s)return fail('resource_not_found');requireMatch(match,s);if(s.status!=='active'||!await p.sources.get(actor,s))fail('resource_not_found');const config=mappingInput(s.sourceType,input) as CreateMapping;
  if(await p.store.getMapping(actor.accountId,config.mappingId))fail('revision_conflict');
  if((await p.store.mappings(actor.accountId,{status:'live',source:s,profileId:config.profileId},{limit:1})).length)fail('revision_conflict');
  if((await p.store.mappings(actor.accountId,{status:'live',profileId:config.profileId},{limit:50})).length>=50||(await p.store.mappings(actor.accountId,{status:'live',subscriptionIds:[s.subscriptionId]},{limit:100})).length>=100)fail('invalid_document');
  const value:Mapping={...config,subscriptionId,generation:revision(),revision:revision(),status:'active',createdAt:(await p.now()).toISOString(),detachedAt:null};await p.store.saveMapping(actor.accountId,s,value);return value;
}
export async function updateMapping(p:SubscriptionTransactionPorts,actor:SubscriptionActor,id:string,input:unknown,match?:string):Promise<Mapping> {
  const {mapping:m,source:s}=await mappingAndSource(p,actor,id);requireMatch(match,m);if(m.status!=='active'||s.status!=='active'||!await p.sources.get(actor,s,false))fail('resource_not_found');
  const patch=mappingInput(s.sourceType,input,m) as MappingPatch;const value={...m,...patch,revision:revision()};await p.store.saveMapping(actor.accountId,s,value);return value;
}
export async function listConfiguration(p:SubscriptionTransactionPorts,actor:SubscriptionActor,scope:'sources'|'subscriptions'|'mappings'|'actions',query:Record<string,string>,codec:ReturnType<typeof createSubscriptionCursorCodec>,subscriptionId?:string) {
  if(query.cursor&&Object.keys(query).length!==1)fail('invalid_query');const now=(await p.now()).getTime();const cursor=query.cursor?codec.decode(query.cursor,actor.accountId,scope+(subscriptionId??''),now):null;
  const filter=cursor?.filter??query;const limit=Number(filter.limit??20);if(!Number.isInteger(limit)||limit<1||limit>50)fail('invalid_query');
  if(filter.profileId)uuid(filter.profileId);if(filter.q!==undefined&&(filter.q.length>100||filter.q.trim()===''))fail('invalid_query');if(filter.sourceType&&!['collection','digest_series'].includes(filter.sourceType))fail('invalid_query');
  const encode=(after:string)=>codec.encode({accountId:actor.accountId,scope:scope+(subscriptionId??''),filter,after,expiresAt:cursor?.expiresAt??now+900000});
  if(scope==='sources') {
    if(filter.relation&&!['followed','shared'].includes(filter.relation))fail('invalid_query');const rows=await p.sources.list(actor,filter,cursor?.after,limit+1);const items=rows.slice(0,limit);const last=items.at(-1);return {items,nextCursor:rows.length>limit&&last?encode(JSON.stringify([last.updatedAt,last.sourceType,last.sourceId])):null};
  }
  if(scope==='actions') {
    if(!filter.profileId)fail('invalid_query');const rows=await p.store.tasks(actor.accountId,{profileId:filter.profileId,pendingOnly:true,afterSequence:cursor?.after,limit:limit+1});const items=rows.slice(0,limit);return {items,nextCursor:rows.length>limit?encode(items.at(-1)!.sequence):null};
  }
  let after=cursor?JSON.parse(cursor.after) as [string,string]:undefined;
  if(scope==='subscriptions') {
    const status=filter.status??'active';if(!['active','terminated','all'].includes(status))fail('invalid_query');
    const rows=await p.store.subscriptions(actor.accountId,status==='all'?{}:{status:status as 'active'|'terminated'},{after,limit:limit+1});const items:SubscriptionListItem[]=[];
    for(const s of rows.slice(0,limit)){const source=await p.sources.get(actor,s,false);items.push({...s,source,availability:source?'available':'unavailable'});}
    const last=items.at(-1);return {items,nextCursor:rows.length>limit&&last?encode(JSON.stringify([last.createdAt,last.subscriptionId])):null};
  }
  if(subscriptionId&&!await p.store.getSubscription(actor.accountId,subscriptionId))fail('resource_not_found');
  const status=filter.status??(subscriptionId?'all':'active');if(!['active','terminating','detached','live','all'].includes(status))fail('invalid_query');
  const sourceCache=new Map<string,Subscription>();const viewCache=new Map<string,SourceView|null>();const items:MappingListItem[]=[];let exhausted=false;
  while(items.length<=limit&&!exhausted) {
    const rows=await p.store.mappings(actor.accountId,{...(status!=='all'?{status:status as 'active'|'terminating'|'detached'|'live'}:{}),...(subscriptionId?{subscriptionIds:[subscriptionId]}:{}),...(filter.profileId?{profileId:filter.profileId}:{}),...(filter.sourceType?{sourceType:filter.sourceType}:{})},{after,limit:100});
    exhausted=rows.length<100;
    sourceCache.clear();viewCache.clear();
    const missing=[...new Set(rows.map(m=>m.subscriptionId).filter(id=>!sourceCache.has(id)))];if(missing.length)for(const s of await p.store.subscriptions(actor.accountId,{ids:missing}))sourceCache.set(s.subscriptionId,s);
    for(const m of rows){after=[m.createdAt,m.mappingId];const s=sourceCache.get(m.subscriptionId)!;if(!viewCache.has(s.subscriptionId))viewCache.set(s.subscriptionId,await p.sources.get(actor,s,false));const source=viewCache.get(s.subscriptionId)!;
      if(filter.q&&(!source||!(source.title+' '+(source.owner?.displayName??'')).toLowerCase().includes(filter.q.toLowerCase())))continue;
      items.push({...m,sourceRef:{sourceType:s.sourceType,sourceId:s.sourceId},availability:source?'available':'unavailable',source});if(items.length>limit)break;
    }
  }
  const values=items.slice(0,limit);const last=values.at(-1);return {items:values,nextCursor:items.length>limit&&last?encode(JSON.stringify([last.createdAt,last.mappingId])):null};
}
