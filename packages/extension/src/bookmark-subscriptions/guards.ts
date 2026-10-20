import { classifyBookmarkApiFailure } from '../bookmark-api-error.js';
import { withSubscriptionRead } from './barrier.js';
import { subscriptionStore as db } from './store.js';
import { assertBookmarkFolderAllowed } from '../bookmark-folder-policy.js';
import { NativeWriteNotStartedError, type NativeWriteCheck } from '../native-call-result.js';
export async function exclusionIds(readonlyOnly=false):Promise<Set<string>>{
  const [nodes,mappings,operations,exclusions]=await Promise.all([db.all('nodes'),db.all('mappings'),db.pendingOperations(),db.all('exclusions')]);
  return new Set([...nodes.map(n=>n.nativeId),...mappings.filter(m=>m.state!=='detached').flatMap(m=>m.rootNativeId?[m.rootNativeId]:[]),...exclusions.filter(n=>!readonlyOnly||n.reason==='quarantine').map(n=>n.nativeId),...operations.filter(o=>!o.settled).flatMap(o=>[...(o.resultId?[o.resultId]:[]),...(o.kind==='create'&&o.phase!=='received'&&o.parentNativeId?[o.parentNativeId]:[])])]);
}
export async function isSubscriptionExcluded(nativeId:string,lookup:(id:string)=>Promise<{parentId?:string}|undefined>=async id=>{try{return (await chrome.bookmarks.get(id))[0];}catch(error){if(classifyBookmarkApiFailure(error)==='not_found')return undefined;throw error;}},readonlyOnly=false):Promise<boolean>{
  const [nodeCount,exclusionCount,operations,mappings]=await Promise.all([db.count('nodes'),db.count('exclusions'),db.pendingOperations(),db.all('mappings')]);
  const temporary=new Set([...mappings.filter(m=>m.state!=='detached').flatMap(m=>m.rootNativeId?[m.rootNativeId]:[]),...operations.flatMap(o=>[...(o.resultId?[o.resultId]:[]),...(o.kind==='create'&&o.phase!=='received'&&o.parentNativeId?[o.parentNativeId]:[])])]);
  if(!nodeCount&&!exclusionCount&&!temporary.size)return false;
  const seen=new Set<string>();let id:string|undefined=nativeId;
  while(id){if(temporary.has(id)||await db.nodeForNative(id))return true;const exclusion=await db.get('exclusions',id);if(exclusion&&(!readonlyOnly||exclusion.reason==='quarantine'))return true;if(seen.has(id)||seen.size>256)throw new Error('subscription_ancestry_unproven');seen.add(id);id=(await lookup(id))?.parentId;}
  return false;
}
export async function assertPersonalNativeAllowed(nativeId:string|undefined):Promise<void>{
  if(!nativeId){await db.ready();return;}
  if(await isSubscriptionExcluded(nativeId,undefined,true)){
    const [nodes,mappings]=await Promise.all([db.all('nodes'),db.all('mappings')]);
    let owner=nodes.find(n=>n.nativeId===nativeId)?.mappingId;let id:string|undefined=nativeId;const seen=new Set<string>();
    while(!owner&&id&&!seen.has(id)){seen.add(id);owner=mappings.find(m=>m.rootNativeId===id)?.id;id=(await chrome.bookmarks.get(id).catch(()=>[]))[0]?.parentId;}
    const mapping=mappings.find(m=>m.id===owner);
    if(mapping)await db.put('diagnostics',{id:crypto.randomUUID(),scope:mapping.scope,mappingId:mapping.id,reasonCode:'readonly_write_blocked',resolution:'blocked',nativeId,origin:'extension',time:Date.now(),count:1});
    throw new Error('readonly_write_blocked');
  }
}
export async function assertPersonalTreeAllowed(nativeId:string):Promise<void>{
  await assertPersonalNativeAllowed(nativeId);const excluded=await exclusionIds(true);if(excluded.size===0)return;
  const tree=await chrome.bookmarks.getSubTree(nativeId);const stack=[...tree];while(stack.length){const node=stack.pop()!;if(excluded.has(node.id))throw new Error('readonly_write_blocked');if(node.children)stack.push(...node.children);}
}
function writePersonal<T>(admit: NativeWriteCheck, write: () => Promise<T>, beforeNative?: NativeWriteCheck): Promise<T> {
  return withSubscriptionRead(async () => {
    try { await admit(); await beforeNative?.(); }
    catch (error) { throw new NativeWriteNotStartedError(error); }
    // No admission await follows the caller's frozen-authority check. A raw
    // Chrome rejection is deliberately outside the not-started catch.
    return write();
  });
}
export const personalBookmarks = {
  create(input: Parameters<typeof chrome.bookmarks.create>[0], beforeNative?: NativeWriteCheck) {
    return writePersonal(async () => {
      await assertPersonalNativeAllowed(input.parentId); await assertBookmarkFolderAllowed(input.parentId);
    }, () => chrome.bookmarks.create(input), beforeNative);
  },
  update(id: string, changes: Parameters<typeof chrome.bookmarks.update>[1], beforeNative?: NativeWriteCheck) {
    return writePersonal(() => assertPersonalNativeAllowed(id), () => chrome.bookmarks.update(id, changes), beforeNative);
  },
  move(id: string, destination: Parameters<typeof chrome.bookmarks.move>[1], beforeNative?: NativeWriteCheck) {
    return writePersonal(async () => {
      await assertPersonalTreeAllowed(id); await assertPersonalNativeAllowed(destination.parentId);
      await assertBookmarkFolderAllowed(destination.parentId);
    }, () => chrome.bookmarks.move(id, destination), beforeNative);
  },
  remove(id: string, beforeNative?: NativeWriteCheck) {
    return writePersonal(() => assertPersonalNativeAllowed(id), () => chrome.bookmarks.remove(id), beforeNative);
  },
  removeTree(id: string, beforeNative?: NativeWriteCheck) {
    return writePersonal(() => assertPersonalTreeAllowed(id), () => chrome.bookmarks.removeTree(id), beforeNative);
  },
};
