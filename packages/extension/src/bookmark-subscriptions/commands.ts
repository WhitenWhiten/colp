import type { CreateMapping, MappingPatch, SourceRef } from './contracts.js';
import { UUID } from './product-client.js';
export type MountInput=SourceRef & Pick<CreateMapping,'digestMode'|'editionLimit'|'checkIntervalMinutes'|'exitPolicy'|'profileLabel'> & {parentNativeId:string;index?:number;localAlias:string;parentDraft?:{title:string}};
export type SubscriptionCommand=(
 | {kind:'list';cursor?:string;status?:'live'|'detached';scope?:'this_browser'|'all_browsers';q?:string;sourceType?:SourceRef['sourceType']} | {kind:'subscriptions';cursor?:string}
 | {kind:'sources';sourceType?:SourceRef['sourceType'];relation?:'followed'|'shared';q?:string;cursor?:string}
 | ({kind:'source'}&SourceRef) | ({kind:'sourcePreview';digestMode:'latest'|'recent'|null;editionLimit:number|null}&SourceRef)
 | {kind:'folders';parentId?:string} | ({kind:'mountPreview'}&MountInput) | {kind:'mountConfirm';token:string}
 | {kind:'mapping'|'pause'|'resume'|'refresh'|'locate'|'repair';mappingId:string}
 | {kind:'patch';mappingId:string;ifMatch:string;patch:MappingPatch}
 | {kind:'rename';mappingId:string;localAlias:string}
 | {kind:'relocatePreview';mappingId:string;parentNativeId:string;index?:number} | {kind:'relocateConfirm';token:string}
 | {kind:'exitPreview';mappingId:string;scope?:'mapping'|'subscription'} | {kind:'exitConfirm';previewId:string}
 | {kind:'diagnostics';mappingId?:string;resolution?:'blocked'|'restored'|'preserved'|'pending'|'resolved'}
 | {kind:'diagnosticLocate';eventId:string} | {kind:'diagnosticsExport'|'draft'|'directoryDefaults'} | {kind:'diagnosticsClear';eventIds:string[]}
 | {kind:'wizardDraft';value?:Partial<MountInput>|null}
 | {kind:'directoryPreview';mountParentNativeId?:string;preservationParentNativeId?:string}
 | {kind:'directoryConfirm';token:string} | {kind:'recoveryPreview';mappingId:string;action:'restore'|'copy_detach';parentNativeId?:string;index?:number} | {kind:'recoveryConfirm';token:string}) & {expectedGeneration?:string};
export interface SubscriptionRequest {type:'BOOKMARK_SUBSCRIPTIONS';requestId:string;command:SubscriptionCommand}
export type SubscriptionResponse<T=unknown>={ok:true;data:T}|{ok:false;error:string};
const fields:Record<SubscriptionCommand['kind'],string[]>={list:['cursor','status','scope','q','sourceType'],subscriptions:['cursor'],sources:['sourceType','relation','q','cursor'],source:['sourceType','sourceId'],sourcePreview:['sourceType','sourceId','digestMode','editionLimit'],folders:['parentId'],mountPreview:['sourceType','sourceId','digestMode','editionLimit','checkIntervalMinutes','exitPolicy','parentNativeId','index','localAlias','profileLabel','parentDraft'],mountConfirm:['token'],mapping:['mappingId'],pause:['mappingId'],resume:['mappingId'],refresh:['mappingId'],locate:['mappingId'],repair:['mappingId'],patch:['mappingId','ifMatch','patch'],rename:['mappingId','localAlias'],relocatePreview:['mappingId','parentNativeId','index'],relocateConfirm:['token'],exitPreview:['mappingId','scope'],exitConfirm:['previewId'],diagnostics:['mappingId','resolution'],diagnosticsExport:[],diagnosticLocate:['eventId'],draft:[],directoryDefaults:[],wizardDraft:['value'],directoryPreview:['mountParentNativeId','preservationParentNativeId'],directoryConfirm:['token'],diagnosticsClear:['eventIds'],recoveryPreview:['mappingId','action','parentNativeId','index'],recoveryConfirm:['token']};
export const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
export function validMode(sourceType:unknown,mode:unknown,limit:unknown):boolean{return sourceType==='collection'?mode===null&&limit===null:sourceType==='digest_series'&&((mode==='latest'&&limit===1)||(mode==='recent'&&Number.isInteger(limit)&&Number(limit)>=1&&Number(limit)<=20));}
export function validateCommand(value:unknown):value is SubscriptionRequest{
  if(!record(value)||Object.keys(value).some(k=>!['type','requestId','command'].includes(k))||value.type!=='BOOKMARK_SUBSCRIPTIONS'||typeof value.requestId!=='string'||!UUID.test(value.requestId)||!record(value.command))return false;
  const c=value.command;if(typeof c.kind!=='string'||!Object.hasOwn(fields,c.kind)||Object.keys(c).some(k=>k!=='kind'&&k!=='expectedGeneration'&&!fields[c.kind as SubscriptionCommand['kind']].includes(k)))return false;
  if(c.expectedGeneration!==undefined&&(typeof c.expectedGeneration!=='string'||!c.expectedGeneration||c.expectedGeneration.length>128))return false;
  for(const k of ['mappingId','token','previewId','eventId'])if(k in c&&(typeof c[k]!=='string'||!UUID.test(c[k])))return false;
  if(fields[c.kind as SubscriptionCommand['kind']].includes('mappingId')&&c.kind!=='diagnostics'&&!c.mappingId)return false;
  for(const k of ['cursor','q','parentId','parentNativeId','localAlias','profileLabel','sourceId','ifMatch'])if(k in c&&(typeof c[k]!=='string'||!(c[k] as string).length||(c[k] as string).length>({q:100,localAlias:4096,profileLabel:80,sourceId:128}[k]??4096)))return false;
  if(c.sourceType!==undefined&&!['collection','digest_series'].includes(String(c.sourceType)))return false;
  if(['source','sourcePreview','mountPreview'].includes(c.kind)&&(!c.sourceType||!c.sourceId))return false;
  if(['sourcePreview','mountPreview'].includes(c.kind)&&!validMode(c.sourceType,c.digestMode,c.editionLimit))return false;
  if(c.parentDraft!==undefined&&(!record(c.parentDraft)||Object.keys(c.parentDraft).length!==1||typeof c.parentDraft.title!=='string'||!c.parentDraft.title.trim()||c.parentDraft.title.length>4096))return false;
  if(c.kind==='recoveryPreview'&&!['restore','copy_detach'].includes(String(c.action)))return false;
  if(c.kind==='mountPreview'&&(!c.parentNativeId||!c.localAlias||!c.profileLabel||!validSettings(c)))return false;
  if(c.kind==='rename'&&!c.localAlias||c.kind==='relocatePreview'&&!c.parentNativeId)return false;
  if(c.index!==undefined&&(!Number.isSafeInteger(c.index)||Number(c.index)<0))return false;
  if(c.kind==='patch'&&(!c.ifMatch||!record(c.patch)||!Object.keys(c.patch).length||Object.keys(c.patch).some(k=>!['profileLabel','digestMode','editionLimit','checkIntervalMinutes','exitPolicy'].includes(k))))return false;
  if(c.kind==='diagnosticLocate'&&!c.eventId)return false;
  if(c.status!==undefined&&!['live','detached'].includes(String(c.status))||c.relation!==undefined&&!['followed','shared'].includes(String(c.relation))||c.resolution!==undefined&&!['blocked','restored','preserved','pending','resolved'].includes(String(c.resolution)))return false;
  if(c.kind==='diagnosticsClear'&&(!Array.isArray(c.eventIds)||c.eventIds.length>1000||!c.eventIds.every(id=>typeof id==='string'&&UUID.test(id))))return false;
  if(c.kind==='mountConfirm'||c.kind==='relocateConfirm'||c.kind==='directoryConfirm'||c.kind==='recoveryConfirm')return typeof c.token==='string';if(c.kind==='exitConfirm')return typeof c.previewId==='string';
  if(c.kind==='list'&&c.scope!==undefined&&!['this_browser','all_browsers'].includes(String(c.scope)))return false;
  if(c.kind==='list'&&typeof c.q==='string'&&!c.q.trim())return false;
  if(c.kind==='list'&&c.cursor!==undefined&&Object.keys(c).some(k=>k!=='kind'&&k!=='cursor'))return false;
  if(c.kind==='wizardDraft'&&c.value!==undefined&&c.value!==null&&(!record(c.value)||Object.keys(c.value).some(k=>!fields.mountPreview.includes(k))||JSON.stringify(c.value).length>12000))return false;
  if(c.kind==='directoryPreview'&&(!c.mountParentNativeId&&!c.preservationParentNativeId))return false;
  return true;
}
export function validSettings(c:Record<string,unknown>):boolean{const e=c.exitPolicy;return [null,5,15,60].includes(c.checkIntervalMinutes as number|null)&&record(e)&&Object.keys(e).length===2&&['inherit','keep','remove'].includes(String(e.onUnfollow))&&['inherit','keep','remove'].includes(String(e.onUnsubscribe));}

export function validSubscriptionSender(sender:{id?:string;url?:string},extensionId:string):boolean{
  if(sender.id!==extensionId||!sender.url)return false;try{const page=new URL(sender.url);return page.protocol==='chrome-extension:'&&page.hostname===extensionId&&page.pathname==='/options.html'&&!page.username&&!page.password&&!page.search;}catch{return false;}
}
