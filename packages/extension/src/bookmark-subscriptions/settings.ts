import type { SubscriptionCommand } from './commands.js';
import type { MaintenanceContext } from './maintenance.js';
import { subscriptionStore as db } from './store.js';
import { assertPersonalNativeAllowed } from './guards.js';
import { assertBookmarkFolderAllowed } from '../bookmark-folder-policy.js';
export async function localSettings(ctx:Pick<MaintenanceContext,'scope'|'assertCurrent'>,c:SubscriptionCommand):Promise<{handled:boolean;data?:unknown}>{
  const owner=JSON.stringify([ctx.scope.serverOrigin,ctx.scope.accountId,ctx.scope.profileId]);
  if(c.kind==='wizardDraft'){
    const key='wizard:'+owner;
    if(c.value===null){await db.remove('meta',key);return {handled:true,data:null};}
    if(c.value!==undefined){await ctx.assertCurrent();await db.put('meta',{id:key,value:{value:c.value,expiresAt:Date.now()+900000}});return {handled:true,data:c.value};}
    const stored=(await db.get('meta',key))?.value as {value:unknown;expiresAt:number}|undefined;
    return {handled:true,data:stored&&stored.expiresAt>Date.now()?stored.value:null};
  }
  if(c.kind==='directoryDefaults')return {handled:true,data:(await db.get('meta','directories:'+owner))?.value??{mountParentNativeId:null,preservationParentNativeId:null}};
  async function validate(id:unknown){if(typeof id!=='string'||!id||id.length>256)throw new Error('directory_invalid');await assertPersonalNativeAllowed(id);await assertBookmarkFolderAllowed(id);const n=(await chrome.bookmarks.get(id))[0];if(!n||n.url||n.unmodifiable||!n.parentId)throw new Error('directory_invalid');}
  if(c.kind==='directoryPreview'){
    if(c.mountParentNativeId!==undefined)await validate(c.mountParentNativeId);if(c.preservationParentNativeId!==undefined)await validate(c.preservationParentNativeId);
    const token=crypto.randomUUID(),expiresAt=Date.now()+300000;await db.put('meta',{id:'directory-preview:'+token,value:{owner,scope:ctx.scope,expiresAt,mountParentNativeId:c.mountParentNativeId,preservationParentNativeId:c.preservationParentNativeId}});return {handled:true,data:{token,expiresAt}};
  }
  if(c.kind==='directoryConfirm'){
    const row=(await db.get('meta','directory-preview:'+c.token))?.value as {owner:string;scope:{authorityGeneration:number};expiresAt:number;mountParentNativeId?:string;preservationParentNativeId?:string}|undefined;
    if(!row||row.owner!==owner||row.scope.authorityGeneration!==ctx.scope.authorityGeneration||row.expiresAt<Date.now())throw new Error('preview_invalid');
    if(row.mountParentNativeId!==undefined)await validate(row.mountParentNativeId);if(row.preservationParentNativeId!==undefined)await validate(row.preservationParentNativeId);
    await ctx.assertCurrent();const old=(await db.get('meta','directories:'+owner))?.value as object|undefined;const next={...old,...(row.mountParentNativeId?{mountParentNativeId:row.mountParentNativeId}:{}),...(row.preservationParentNativeId?{preservationParentNativeId:row.preservationParentNativeId}:{})};await db.put('meta',{id:'directories:'+owner,value:next});await db.remove('meta','directory-preview:'+c.token);return {handled:true,data:next};
  }
  return {handled:false};
}
