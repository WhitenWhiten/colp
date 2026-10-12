import { IDBFactory } from 'fake-indexeddb';
import { createSubscriptionStore } from '../src/bookmark-subscriptions/store.js';
import type { LocalMapping, OwnedNode } from '../src/bookmark-subscriptions/local-types.js';
import type { NativeApi } from '../src/bookmark-subscriptions/native.js';
import { fingerprint } from '../src/bookmark-subscriptions/native.js';
import type { ProjectionNode } from '../src/bookmark-subscriptions/contracts.js';
export const scope={serverOrigin:'https://known.test',accountId:'account-a',authorityGeneration:1,profileId:'e83f46da-a4e2-4575-8b2b-2f490adbf027'};
export const row=():LocalMapping=>({id:'91acdb24-41a4-48df-9b8a-3a965e415b71',scope,source:{sourceType:'collection',sourceId:'collection'},mapping:{mappingId:'91acdb24-41a4-48df-9b8a-3a965e415b71',subscriptionId:'sub',profileId:scope.profileId,profileLabel:'Profile',mode:'readonly',digestMode:null,editionLimit:null,checkIntervalMinutes:15,exitPolicy:{onUnfollow:'inherit',onUnsubscribe:'inherit'},generation:'g1',revision:'r1',status:'active',createdAt:new Date().toISOString(),detachedAt:null},enabled:true,applyEpoch:1,mountParentNativeId:'bar',localAlias:'Source',state:'initializing',reserved:0,nextCheckAt:0,nextMaintenanceAt:0});
export const root:ProjectionNode={key:JSON.stringify(['synthetic','root','collection','collection']),parentKey:null,index:0,kind:'folder',role:'root',editionId:null,title:'Source'};
export const leaf=(id='node',parent=root.key):ProjectionNode=>({key:JSON.stringify(['collection','collection',id]),parentKey:parent,index:0,kind:'bookmark',role:'content',editionId:null,title:id,url:'https://example.test/'+id});
export function owned(mapping:LocalMapping,node:ProjectionNode,nativeId:string,parentNativeId='bar'):OwnedNode{return {id:JSON.stringify([mapping.id,mapping.mapping.generation,node.key]),mappingId:mapping.id,generation:mapping.mapping.generation,key:node.key,nativeId,parentNativeId,index:node.index,fingerprint:fingerprint(node),node,...(node.role==='content'?{ref:{sourceCollectionId:'collection',nodeId:JSON.parse(node.key)[2],editionId:null}}:{})};}
export function database(){return createSubscriptionStore('subscriptions-'+crypto.randomUUID(),new IDBFactory());}
export function nativeFixture(){
  const nodes=new Map<string,chrome.bookmarks.BookmarkTreeNode>([['0',{id:'0',title:''}],['bar',{id:'bar',parentId:'0',title:'Bar',folderType:'bookmarks-bar',index:0}]]);let serial=0;const calls:string[]=[];
  const getNode=(id:string)=>{const node=nodes.get(id);if(!node)throw new Error("Can't find bookmark for id.");return node;};
  const api:NativeApi={async get(id){return [{...getNode(id)}];},async getChildren(id){getNode(id);return [...nodes.values()].filter(n=>n.parentId===id).sort((a,b)=>(a.index??0)-(b.index??0)).map(n=>({...n}));},async create(input){getNode(input.parentId!);const n={id:String(++serial),parentId:input.parentId,title:input.title??'',index:input.index??0,...(input.url?{url:input.url}:{})};nodes.set(n.id,n);calls.push('create:'+n.id);return {...n};},async update(id,input){const n=getNode(id);Object.assign(n,input);calls.push('update:'+id);return {...n};},async move(id,input){const n=getNode(id);if(input.parentId)getNode(input.parentId);Object.assign(n,input);calls.push('move:'+id);return {...n};},async remove(id){getNode(id);if([...nodes.values()].some(n=>n.parentId===id))throw new Error('Folder is not empty');nodes.delete(id);calls.push('remove:'+id);}};
  return {api,nodes,calls};
}
