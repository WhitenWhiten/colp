import { withSubscriptionRead } from './barrier.js';
import { subscriptionStore as db } from './store.js';
import { exclusionIds, isSubscriptionExcluded, assertPersonalNativeAllowed } from './guards.js';
import type { ChromeBookmarkNode, BookmarkTreeApi } from '../chrome-bookmark-tree.js';
import type { QueueOperation, SyncScope, createSyncStateStore } from '../sync-state-store.js';
import { plannedCreateNativeId } from '../bookmark-event-codec.js';
export async function filterPersonalTree(raw:readonly ChromeBookmarkNode[]):Promise<ChromeBookmarkNode[]>{
  const operations=await db.pendingOperations();if(operations.some(o=>o.kind==='create'&&o.phase!=='received'))throw new Error('subscription_create_pending');
  const excluded=await exclusionIds();const result:ChromeBookmarkNode[]=[];const stack=raw.map(n=>({node:n,out:result})).reverse();
  while(stack.length){const {node,out}=stack.pop()!;if(excluded.has(node.id))continue;const children:ChromeBookmarkNode[]=[];const copy={...node,...(node.children?{children}:{})};out.push(copy);if(node.children)for(let i=node.children.length-1;i>=0;i--)stack.push({node:node.children[i]!,out:children});}
  return result;
}
export function personalTreeApi():BookmarkTreeApi{return {getTree:async()=>withSubscriptionRead(async()=>filterPersonalTree(await chrome.bookmarks.getTree())),getChildren:async id=>withSubscriptionRead(async()=>{await assertPersonalNativeAllowed(id);return filterPersonalTree(await chrome.bookmarks.getChildren(id));}),getSubTree:async id=>withSubscriptionRead(async()=>{await assertPersonalNativeAllowed(id);return filterPersonalTree(await chrome.bookmarks.getSubTree(id));})};}
export async function assertSubscriptionUploadAllowed(
  store: ReturnType<typeof createSyncStateStore>, scope: SyncScope, queue: QueueOperation,
) {
  await db.ready();
  // Dispatch holds the shared subscription barrier. Counts include every account:
  // old ownership, exclusions and unreceived creates must still block stale uploads.
  const [nodeCount, mappingCount, exclusionCount, operations] = await Promise.all([
    db.count('nodes'), db.count('mappings'), db.count('exclusions'), db.pendingOperations(),
  ]);
  if (!nodeCount && !mappingCount && !exclusionCount && !operations.length) return;

  const ids = new Set<string>();
  const planned = plannedCreateNativeId(queue.opId);
  if (planned) ids.add(planned);
  const tokens = new Set<string>(['pending-' + queue.opId]);
  const stack: unknown[] = [queue.payload];
  while (stack.length) {
    const value = stack.pop();
    if (!value || typeof value !== 'object') continue;
    for (const [key, child] of Object.entries(value)) {
      if (typeof child === 'string' && ['targetId', 'parentId', 'nodeId', 'id', 'nativeId', 'parentNativeId'].includes(key)) {
        tokens.add(child);
        if (key === 'nativeId' || key === 'parentNativeId') ids.add(child);
      } else if (child && typeof child === 'object') stack.push(child);
    }
  }
  for (const token of tokens) {
    const mapping = await store.getMappingByColpId(scope, token);
    if (mapping) {
      ids.add(mapping.nativeId);
      if (mapping.parentNativeId) ids.add(mapping.parentNativeId);
    }
  }
  for (const id of ids) if (await isSubscriptionExcluded(id)) throw new Error('subscription_upload_excluded');
  const checkEvent = async (nativeId: string) => {
    if (ids.has(nativeId)) return;
    ids.add(nativeId);
    if (await isSubscriptionExcluded(nativeId)) throw new Error('subscription_upload_excluded');
  };
  // A historical event can outlive its native/COLP mapping. Keep both identities,
  // but read only this operation's evidence, never unrelated profile history.
  const original = await store.getBookmarkEvent(scope, queue.opId);
  if (original) await checkEvent(original.nativeId);
  let after = 0;
  for (;;) {
    const events = await store.listBookmarkEventsByOperation(scope, queue.opId, after, 500);
    for (const event of events) await checkEvent(event.nativeId);
    if (events.length < 500) break;
    after = events.at(-1)!.ordinal;
  }
}
