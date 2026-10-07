import type { SubscriptionActor, SubscriptionTransactionPorts, BookmarkSubscriptionExitPort } from './contracts.js';
import type { ExitPreviewInput, ExitPreview, ExitBatch, ExitTarget, Mapping, SourceRef, ActionReceipt } from '../domain/types.js';
import { digest, fail, revision } from './validation.js';

async function selection(p: SubscriptionTransactionPorts, actor: SubscriptionActor, input: ExitPreviewInput) {
  const t=input.target;
  if(t.kind==='mapping') {
    const m=await p.store.getMapping(actor.accountId,t.mappingId);if(!m)return fail('resource_not_found');
    const subscription=await p.store.getSubscription(actor.accountId,m.subscriptionId);if(!subscription)return fail('resource_not_found');
    return {subscriptions:[subscription],mappings:m.status==='detached'?[]:[m]};
  }
  const subscriptions=await p.store.subscriptions(actor.accountId,t.kind==='subscription'?{ids:[t.subscriptionId]}:{source:t,status:'active'});
  if(t.kind==='subscription'&&!subscriptions.length)fail('resource_not_found');
  return {subscriptions,mappings:await p.store.mappings(actor.accountId,{status:'live',subscriptionIds:subscriptions.map(s=>s.subscriptionId)})};
}
export async function makeExitPreview(p: SubscriptionTransactionPorts, actor: SubscriptionActor, input: ExitPreviewInput): Promise<ExitPreview> {
  const prefs=await p.preferences(actor.accountId); const selected=await selection(p,actor,input);
  const existing=await p.store.tasks(actor.accountId,{mappingIds:selected.mappings.map(m=>m.mappingId)});const targets:ExitTarget[]=[];
  for(const m of selected.mappings.sort((a,b)=>a.mappingId.localeCompare(b.mappingId))) {
    const subscription=selected.subscriptions.find(s=>s.subscriptionId===m.subscriptionId)!;
    const task=existing.find(t=>t.mappingId===m.mappingId&&t.generation===m.generation);
    let effectiveAction:ExitTarget['effectiveAction'];let policyOrigin:ExitTarget['policyOrigin'];
    if(task) {effectiveAction=task.effectiveAction;policyOrigin=task.policyOrigin;}
    else {
      const readable=await p.sources.check(actor,subscription,[]);
      const override=input.trigger==='unfollow'?m.exitPolicy.onUnfollow:m.exitPolicy.onUnsubscribe;
      effectiveAction=!readable.available?'remove':override==='inherit'?(input.trigger==='unfollow'?prefs.subscriptionOnUnfollow:prefs.subscriptionOnUnsubscribe):override;
      policyOrigin=!readable.available?'authority':override==='inherit'?'global':'mapping';
    }
    targets.push({mappingId:m.mappingId,subscriptionId:m.subscriptionId,profileId:m.profileId,profileLabel:m.profileLabel,generation:m.generation,mappingRevision:m.revision,effectiveAction,policyOrigin});
  }
  return {...input,previewId:revision(),preferenceRevision:prefs.revision,expiresAt:new Date((await p.now()).getTime()+300000).toISOString(),targets};
}
async function selectionRevision(p:SubscriptionTransactionPorts,actor:SubscriptionActor,input:ExitPreviewInput):Promise<string> {
  const selected=await selection(p,actor,input);
  return digest(selected.subscriptions.map(s=>[s.subscriptionId,s.revision,s.status]).sort((a,b)=>a[0]!.localeCompare(b[0]!)));
}
export async function saveExitPreview(p:SubscriptionTransactionPorts,actor:SubscriptionActor,input:ExitPreviewInput):Promise<ExitPreview> {
  const preview=await makeExitPreview(p,actor,input);
  await p.store.savePreview(actor.accountId,preview,await selectionRevision(p,actor,input));
  return preview;
}
export async function commitExit(p: SubscriptionTransactionPorts, actor: SubscriptionActor, input: ExitPreviewInput, previewId?: string): Promise<ExitBatch> {
  const fresh=await makeExitPreview(p,actor,input);
  let frozen=fresh;
  if(previewId) {
    const saved=await p.store.getPreview(actor.accountId,previewId);if(!saved)return fail('resource_not_found');const old=saved.preview;
    if(saved.selectionRevision!==await selectionRevision(p,actor,input))fail('precondition_failed');
    if(new Date(old.expiresAt)<await p.now()||old.trigger!==input.trigger||digest(old.target)!==digest(input.target)||old.preferenceRevision!==fresh.preferenceRevision||digest(old.targets)!==digest(fresh.targets)) fail('precondition_failed');
    frozen=old;
  }
  const chosen=await selection(p,actor,input);const exitId=revision();const actions:ExitBatch['actions']=[];const now=(await p.now()).toISOString();
  // The account lock serializes all configuration writes. Stable ordering also prevents lock inversions with domain commands.
  if(input.target.kind!=='mapping') for(const s of chosen.subscriptions.sort((a,b)=>a.subscriptionId.localeCompare(b.subscriptionId))) {
    if(s.status==='active') await p.store.saveSubscription(actor.accountId,{...s,status:'terminated',terminatedAt:now,revision:revision()});
  }
  for(const target of frozen.targets) {
    const m=chosen.mappings.find(x=>x.mappingId===target.mappingId)!;
    const task=await p.store.saveTask(actor.accountId,{...target,actionId:revision(),exitId,sequence:'0',trigger:input.trigger,preferenceRevision:frozen.preferenceRevision,createdAt:now});
    if(m.status==='active') await p.store.saveMapping(actor.accountId,chosen.subscriptions.find(s=>s.subscriptionId===m.subscriptionId)!,{...m,status:'terminating',revision:revision()});
    actions.push({actionId:task.actionId,mappingId:task.mappingId,generation:task.generation,effectiveAction:task.effectiveAction});
  }
  return {exitId,trigger:input.trigger,actions};
}
export async function acknowledgeAction(p: SubscriptionTransactionPorts, actor: SubscriptionActor, actionId:string, input: Pick<ActionReceipt,'mappingId'|'generation'|'result'>):Promise<ActionReceipt> {
  const task=(await p.store.tasks(actor.accountId,{actionId}))[0];if(!task) return fail('resource_not_found');
  if(task.mappingId!==input.mappingId||task.generation!==input.generation) fail('invalid_request');
  const allowed=task.effectiveAction==='keep'?['kept','removed_access_lost','no_local_mount']:['removed','no_local_mount'];if(!allowed.includes(input.result)) fail('invalid_request');
  const old=await p.store.getReceipt(actor.accountId,actionId);if(old) {if(old.result!==input.result) fail('revision_conflict');return old;}
  const m=await p.store.getMapping(actor.accountId,task.mappingId);if(!m) return fail('resource_not_found');
  const s=await p.store.getSubscription(actor.accountId,m.subscriptionId);if(!s) return fail('resource_not_found');
  const receipt={actionId,...input,acknowledgedAt:(await p.now()).toISOString()};
  await p.store.acknowledge(actor.accountId,receipt);
  await p.store.saveMapping(actor.accountId,s,{...m,status:'detached',detachedAt:receipt.acknowledgedAt,revision:revision()});return receipt;
}
export function createSubscriptionExitCoordinator(p: SubscriptionTransactionPorts):BookmarkSubscriptionExitPort {
  return {lockAccount:p.lockAccount,async unfollow(input) { await commitExit(p,{accountId:input.accountId,subjectId:input.subjectId},{trigger:'unfollow',target:{kind:'source',...input.source}},input.previewId); }};
}
