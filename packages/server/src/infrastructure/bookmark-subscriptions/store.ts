import { sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import type { SubscriptionStore } from '../../modules/bookmark-subscriptions/index.js';
import { fail } from '../../modules/bookmark-subscriptions/index.js';
export function createBookmarkSubscriptionStore(tx: DatabaseTransaction): SubscriptionStore {
  return {
    async getSubscription(accountId,id) { return (await tx.selectFrom('bookmark_subscriptions').select('document').where('account_id','=',accountId).where('id','=',id).executeTakeFirst())?.document??null; },
    async getMapping(accountId,id) { return (await tx.selectFrom('bookmark_subscription_mappings').select('document').where('account_id','=',accountId).where('id','=',id).executeTakeFirst())?.document??null; },
    async subscriptions(accountId,filter={},page) {
      let q=tx.selectFrom('bookmark_subscriptions').select('document').where('account_id','=',accountId);
      if(filter.status)q=q.where('status','=',filter.status);if(filter.source)q=q.where('source_type','=',filter.source.sourceType).where('source_id','=',filter.source.sourceId);if(filter.ids){if(!filter.ids.length)return [];q=q.where('id','in',filter.ids);}
      if(page?.after){const [time,id]=page.after;q=q.where(eb=>eb.or([eb('created_at','<',new Date(time)),eb.and([eb('created_at','=',new Date(time)),eb('id','>',id)])]));}
      q=q.orderBy('created_at','desc').orderBy('id');if(page)q=q.limit(page.limit);return (await q.execute()).map(r=>r.document);
    },
    async mappings(accountId,filter={},page) {
      let q=tx.selectFrom('bookmark_subscription_mappings').select('document').where('account_id','=',accountId);
      if(filter.status)q=filter.status==='live'?q.where('status','!=','detached'):q.where('status','=',filter.status);if(filter.profileId)q=q.where('profile_id','=',filter.profileId);if(filter.source)q=q.where('source_type','=',filter.source.sourceType).where('source_id','=',filter.source.sourceId);if(filter.sourceType)q=q.where('source_type','=',filter.sourceType);
      if(filter.subscriptionIds){if(!filter.subscriptionIds.length)return [];q=q.where('subscription_id','in',filter.subscriptionIds);}if(filter.ids){if(!filter.ids.length)return [];q=q.where('id','in',filter.ids);}
      if(page?.after){const [time,id]=page.after;q=q.where(eb=>eb.or([eb('created_at','<',new Date(time)),eb.and([eb('created_at','=',new Date(time)),eb('id','>',id)])]));}
      q=q.orderBy('created_at','desc').orderBy('id');if(page)q=q.limit(page.limit);return (await q.execute()).map(r=>r.document);
    },
    async saveSubscription(accountId,v) { await tx.insertInto('bookmark_subscriptions').values({id:v.subscriptionId,account_id:accountId,source_type:v.sourceType,source_id:v.sourceId,status:v.status,created_at:new Date(v.createdAt),document:v}).onConflict(o=>o.column('id').doUpdateSet({status:v.status,document:v}).where('bookmark_subscriptions.account_id','=',accountId)).execute(); },
    async saveMapping(accountId,source,v) { const saved=await tx.insertInto('bookmark_subscription_mappings').values({id:v.mappingId,account_id:accountId,subscription_id:v.subscriptionId,source_type:source.sourceType,source_id:source.sourceId,profile_id:v.profileId,status:v.status,created_at:new Date(v.createdAt),document:v}).onConflict(o=>o.column('id').doUpdateSet({status:v.status,document:v}).where('bookmark_subscription_mappings.account_id','=',accountId)).returning('id').executeTakeFirst();if(!saved)fail('revision_conflict'); },
    async getPreview(accountId,id) { const row=await tx.selectFrom('bookmark_subscription_exit_previews').select(['document','selection_revision']).where('account_id','=',accountId).where('id','=',id).executeTakeFirst();return row?{preview:row.document,selectionRevision:row.selection_revision}:null; },
    async savePreview(accountId,v,selectionRevision) { await tx.insertInto('bookmark_subscription_exit_previews').values({id:v.previewId,account_id:accountId,expires_at:new Date(v.expiresAt),document:v,selection_revision:selectionRevision}).execute(); },
    async tasks(accountId,filter={}) {
      let q=tx.selectFrom('bookmark_subscription_actions').select(['document','sequence']).where('account_id','=',accountId);
      if(filter.profileId)q=q.where('profile_id','=',filter.profileId);if(filter.mappingIds){if(!filter.mappingIds.length)return [];q=q.where('mapping_id','in',filter.mappingIds);}if(filter.actionId)q=q.where('id','=',filter.actionId);if(filter.pendingOnly)q=q.where('receipt','is',null);if(filter.afterSequence)q=q.where('sequence','>',BigInt(filter.afterSequence));q=q.orderBy('sequence');if(filter.limit)q=q.limit(filter.limit);
      return (await q.execute()).map(r=>({...r.document,sequence:String(r.sequence)}));
    },
    async saveTask(accountId,v) { const row=await tx.insertInto('bookmark_subscription_actions').values({id:v.actionId,account_id:accountId,mapping_id:v.mappingId,generation:v.generation,profile_id:v.profileId,document:v,receipt:null}).onConflict(o=>o.columns(['mapping_id','generation']).doNothing()).returning(['document','sequence']).executeTakeFirst(); if(row) return {...row.document,sequence:String(row.sequence)}; const existing=await tx.selectFrom('bookmark_subscription_actions').select(['document','sequence']).where('account_id','=',accountId).where('mapping_id','=',v.mappingId).where('generation','=',v.generation).executeTakeFirstOrThrow();return {...existing.document,sequence:String(existing.sequence)}; },
    async getReceipt(accountId,actionId) { return (await tx.selectFrom('bookmark_subscription_actions').select('receipt').where('account_id','=',accountId).where('id','=',actionId).executeTakeFirst())?.receipt??null; },
    async acknowledge(accountId,receipt) { await tx.updateTable('bookmark_subscription_actions').set({receipt}).where('account_id','=',accountId).where('id','=',receipt.actionId).execute(); },
    async getSnapshot(accountId,id) { return await tx.selectFrom('bookmark_subscription_snapshots').select(['descriptor','projection']).where('account_id','=',accountId).where('id','=',id).executeTakeFirst()??null; },
    async saveSnapshot(accountId,descriptor,projection) {
      // A repeatable-read transaction may have waited for the account lock after its
      // receipt established the snapshot. A write conflict on this row forces that
      // stale transaction to abort instead of admitting against an old cache count.
      await tx.insertInto('bookmark_subscription_snapshot_guards').values({account_id:accountId,revision:randomUUID()}).onConflict(o=>o.column('account_id').doUpdateSet({revision:randomUUID()})).execute();
      const now=new Date();
      // Keep only a bounded-lifetime descriptor tombstone after discarding node
      // bytes. An expired known snapshot stays 409 rather than becoming a 404.
      await tx.deleteFrom('bookmark_subscription_snapshots').where('account_id','=',accountId).where('expires_at','<',new Date(now.getTime()-86400000)).execute();
      await tx.updateTable('bookmark_subscription_snapshots').set({size_bytes:0,projection:sql<import('../../modules/bookmark-subscriptions/index.js').SourceProjection>`jsonb_set(projection,'{nodes}','[]'::jsonb)`}).where('account_id','=',accountId).where('expires_at','<',now).where('size_bytes','>',0).execute();
      const live=await tx.selectFrom('bookmark_subscription_snapshots').select('size_bytes').where('account_id','=',accountId).where('expires_at','>=',now).execute();const size=Buffer.byteLength(JSON.stringify({descriptor,projection}));
      if(live.length>=8||live.reduce((n,r)=>n+r.size_bytes,0)+size>128*1024*1024) fail('rate_limited');
      await tx.insertInto('bookmark_subscription_snapshots').values({id:descriptor.snapshotId,account_id:accountId,expires_at:new Date(descriptor.expiresAt),size_bytes:size,descriptor,projection}).execute();
    },
  };
}
