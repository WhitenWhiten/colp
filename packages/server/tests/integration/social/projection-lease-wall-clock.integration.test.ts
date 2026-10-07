import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { createPostgresSocialFeedWithdrawalWorkerRepository } from '../../../src/infrastructure/social/feed-withdrawal-worker-postgres.js';
import { createPostgresSocialNotificationWorkerRepository } from '../../../src/infrastructure/notifications/social-notification-worker-postgres.js';
import { createPostgresCommunityNotificationWorkerRepository } from '../../../src/infrastructure/community/community-notification-worker-postgres.js';
import { COMMUNITY_STATIC_GENERATION } from '../../../src/modules/community/index.js';
import { createIsolatedPostgresRuntime, describeWithPostgres, type IsolatedPostgresRuntime } from '../../support/postgres-test-runtime.js';
import { seedProfileAndCollection } from '../../support/social-feed-fixture.js';
import { createCommentNotificationFixture } from '../community/comment-notification-worker-helpers.js';

describeWithPostgres('projection wall-clock fences after row lock acquisition', () => {
 let isolated: IsolatedPostgresRuntime;
 const recipient='lease-recipient', actor='lease-actor', collection='lease-collection';
 beforeAll(async()=>{
  isolated=await createIsolatedPostgresRuntime('projection_wall_clock',{maxConnections:8});
  await runMigrations(isolated.runtime.db,'latest');
  await seedProfileAndCollection(isolated,recipient,actor,collection);
  await isolated.runtime.pool.query(`insert into follows(actor_profile_id,target_profile_id,followed_at) values($1,$2,clock_timestamp()-interval '1 minute')`,[recipient,actor]);
 },120000);
 afterAll(async()=>isolated?.close());
 for(const kind of ['withdrawal','social','community'] as const) {
  test.each(['expiry','lock_wait','takeover','renewal'] as const)(`${kind}: %s fences effects on latest schema`,async(mode)=>{
   const pool=isolated.runtime.pool;
   const id=`lease-${kind}-${mode}`, eventId=`${id}-event`, occurredAt=new Date();
   const eventType=kind==='withdrawal'?'social.follow-removed':kind==='social'?'social.follow-created':'community.comment-created';
   const handler=kind==='withdrawal'?'social_feed_withdrawal':kind==='social'?'social_follow_activity':'community_comment_notification';
   await pool.query(`insert into resource_id_ledger(resource_id,resource_type) values($1,'social-domain-event'),($2,'social-outbox')`,[eventId,id]);
   await pool.query(`insert into outbox_events(outbox_id,domain_event_id,event_type,event_version,handler_name,handler_mode,
    aggregate_type,aggregate_id,aggregate_scope,occurred_at,payload_json,state,attempt_count,available_at,lease_generation,locked_until)
    values($1,$2,$3,1,$4,'delivery_each_event','profile-follow',$5,$6,$7,'{}','leased',1,clock_timestamp(),1,clock_timestamp()+interval '1 minute')`,
   [id,eventId,eventType,handler,recipient,actor,occurredAt]);
   if(kind==='withdrawal') await pool.query(`insert into social_feed_items(feed_item_id,source_event_id,kind,recipient_profile_id,actor_profile_id,
    collection_id,source_event_version,source_commit_ordinal,publication_revision,discoverability_recheck_key,published_at,retain_until,state)
    values($1,$2,'collection_change',$3,$4,$5,2,1,'c1.p1',$6,current_timestamp-interval '1 minute',current_timestamp-interval '1 minute'+interval '90 days','visible')`,
   [id,eventId,recipient,actor,collection,`publication.collection:${collection}`]);
   if(kind==='community') await createCommentNotificationFixture(()=>isolated).seedCommentRow({
    id:`${id}-comment`, targetKind:'collection',targetId:collection,generation:COMMUNITY_STATIC_GENERATION,authorAccountId:recipient,body:'lease boundary comment',
   });
   let releaseLock: Promise<unknown>|undefined;
   const faultInjector={beforeAttemptFence:async()=>{
    if(mode==='takeover') {
     await pool.query('update outbox_events set lease_generation=2 where outbox_id=$1',[id]);
    } else if(mode==='renewal') {
     await pool.query("update outbox_events set locked_until=clock_timestamp()+interval '1 minute' where outbox_id=$1",[id]);
    } else {
     // Shorten the fixture lease while it remains valid, then let real time
     // elapse without any generation change or abort signal.
     await pool.query("update outbox_events set locked_until=clock_timestamp()+interval '150 milliseconds' where outbox_id=$1",[id]);
     if(mode==='expiry') await pool.query('select pg_sleep(0.3)');
     else {
      const locker=await pool.connect();
      await locker.query('begin');
      await locker.query('select outbox_id from outbox_events where outbox_id=$1 for update',[id]);
      releaseLock=(async()=>{try { await locker.query('select pg_sleep(0.3)'); await locker.query('commit'); } finally {locker.release();}})();
     }
    }
   }};
   const common={attempt:{outboxId:id,leaseGeneration:'1'},signal:new AbortController().signal};
   const result=kind==='withdrawal'
    ? await createPostgresSocialFeedWithdrawalWorkerRepository(pool,{faultInjector}).project({...common,maxRecipients:100,event:{eventId,eventVersion:1,actorProfileId:recipient,targetProfileId:actor,occurredAt}})
    : kind==='social'
     ? await createPostgresSocialNotificationWorkerRepository(pool,{faultInjector}).project({...common,event:{kind:'follow_created',eventId,eventVersion:1,actorProfileId:recipient,recipientProfileId:actor,occurredAt}})
     : await createPostgresCommunityNotificationWorkerRepository(isolated.runtime.db,{faultInjector}).project({...common,event:{kind:'comment_created',eventId,eventVersion:1,commentId:`${id}-comment`,replyToId:null,target:{kind:'collection',id:collection,collectionId:null,seriesId:null},targetGeneration:COMMUNITY_STATIC_GENERATION,actorAccountId:recipient,recipientAccountId:actor,occurredAt}});
   await releaseLock;
   assert.equal(result.disposition,mode==='renewal'?'applied':'lease_lost');
   if(kind==='withdrawal') assert.equal((await pool.query('select state from social_feed_items where feed_item_id=$1',[id])).rows[0].state,mode==='renewal'?'withdrawn':'visible');
   else assert.equal((await pool.query('select count(*)::int as count from notifications where source_event_id=$1',[eventId])).rows[0].count,mode==='renewal'?1:0);
  });
 }
});
