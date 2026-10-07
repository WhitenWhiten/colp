import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, test } from 'vitest';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { createPostgresBookmarkSubscriptionUnitOfWork } from '../../../src/infrastructure/bookmark-subscriptions/unit-of-work.js';
import { createPostgresCollectionFollowCommandUnitOfWork } from '../../../src/infrastructure/social/collection-follow-command-postgres.js';
import { createPostgresReportsUnitOfWork } from '../../../src/infrastructure/reports/unit-of-work.js';
import { createPostgresIdentityUnitOfWork } from '../../../src/infrastructure/identity/index.js';
import { followCollection, unfollowCollection } from '../../../src/modules/social/index.js';
import { followDigestSeries, unfollowDigestSeries } from '../../../src/modules/reports/index.js';
import { createSession } from '../../../src/modules/identity/index.js';
import { accessCheck, checkNodes, createMapping, createSnapshot, authorizeSnapshotReceipt, createSubscription, projectionCheck, saveExitPreview, commitExit, acknowledgeAction, listConfiguration, createSubscriptionCursorCodec, snapshotNodes, etag, digest, updateMapping, type SubscriptionActor, type SourceRef, type Mapping } from '../../../src/modules/bookmark-subscriptions/index.js';
import { registerBookmarkSubscriptionRoutes } from '../../../src/transport/product/bookmark-subscription-routes.js';
import { registerReportReaderRoutes } from '../../../src/transport/product/report-reader-routes.js';
import { registerCollectionFollowRoutes } from '../../../src/transport/product/collection-follow-routes.js';
import { registerSecondaryReportRoutes } from '../../../src/transport/product/report-private-secondary-routes.js';
import { createPostgresCollectionFollowQueryUnitOfWork } from '../../../src/infrastructure/social/collection-follow-query-postgres.js';
import { createFixedWindowRateLimiter } from '../../../src/transport/http-security.js';
import { installProductAdmission, parseStrictQuery } from '../../../src/transport/product-admission.js';
import { installProductRouteManifestChecks } from '../../../src/transport/product-route-manifest.js';
import { ProductHttpError, sendProductError } from '../../../src/transport/product-error.js';
import { SESSION_COOKIE_NAME } from '../../../src/transport/session-cookie.js';
import { createIsolatedPostgresRuntime, describeWithPostgres, type IsolatedPostgresRuntime } from '../../support/postgres-test-runtime.js';
import { seedProfileAndCollection } from '../../support/social-feed-fixture.js';

const origin='https://app.example.test';const cursor=createSubscriptionCursorCodec('c'.repeat(32));
describeWithPostgres('bookmark subscriptions production PostgreSQL composition',()=>{
  let isolated:IsolatedPostgresRuntime;
  beforeAll(async()=>{isolated=await createIsolatedPostgresRuntime('bookmark_subscriptions_runtime',{maxConnections:8});await runMigrations(isolated.runtime.db,'latest');},120000);
  afterAll(async()=>isolated?.close());
  const uow=()=>createPostgresBookmarkSubscriptionUnitOfWork(isolated.runtime.db,{origin,reportsEnabled:true});
  async function fixture(){const suffix=randomUUID().slice(0,8);const reader='bs-reader-'+suffix,owner='bs-owner-'+suffix,c='bs-source-'+suffix;await seedProfileAndCollection(isolated,reader,owner,c);await isolated.runtime.pool.query('insert into collection_follows(collection_id,follower_profile_id) values($1,$2)',[c,reader]);await node(c,'child-'+suffix,'root-'+c);return {actor:{accountId:reader,subjectId:'subject-'+reader},owner,ref:{sourceType:'collection',sourceId:c} as SourceRef,nodeId:'child-'+suffix};}
  async function node(c:string,id:string,parent:string,kind='bookmark',visibility='inherit',title='A useful resource'){await isolated.runtime.pool.query("insert into resource_id_ledger(resource_id,resource_type,committed_at) values($1,'node',current_timestamp)",[id]);await isolated.runtime.pool.query("insert into nodes(id,collection_id,parent_id,kind,is_root,title,url,visibility,position_token,resource_revision,children_revision) values($1,$2,$3,$4,false,$5,$6,$7,$8,'node-r1','children-r1')",[id,c,parent,kind,title,kind==='bookmark'?'https://example.test/'+id:null,visibility,'a'+id.replaceAll('-','')]);}
  async function mount(actor:SubscriptionActor,ref:SourceRef,profileId=randomUUID(),mode:'latest'|'recent'='latest',limit=1){return uow().execute(async p=>{await p.lockAccount(actor.accountId);const {value:s}=await createSubscription(p,actor,ref);const m=await createMapping(p,actor,s.subscriptionId,{mappingId:randomUUID(),profileId,profileLabel:'Test browser',mode:'readonly',digestMode:ref.sourceType==='collection'?null:mode,editionLimit:ref.sourceType==='collection'?null:limit,checkIntervalMinutes:15,exitPolicy:{onUnfollow:'inherit',onUnsubscribe:'inherit'}},etag(s));return {s,m};},{write:true});}
  async function series(f:Awaited<ReturnType<typeof fixture>>,visibility='private'){
    const id='bs-digest-'+randomUUID().slice(0,8);const client=await isolated.runtime.pool.connect();try{await client.query('begin');await client.query("insert into resource_id_ledger(resource_id,resource_type,committed_at) values($1,'digest_series',current_timestamp)",[id]);await client.query("insert into digest_series(id,owner_subject_id,title,slug,visibility,state,resource_revision,content_revision,policy_revision,commit_ordinal) values($1,$2,'Private digest',null,$3,'active','r1','c1','p1',1)",[id,'subject-'+f.owner,visibility]);await client.query("insert into digest_members(series_id,subject_id,role) values($1,$2,'owner'),($1,$3,'viewer')",[id,'subject-'+f.owner,f.actor.subjectId]);await client.query('commit');}finally{client.release();}return {sourceType:'digest_series',sourceId:id} as SourceRef;
  }
  async function edition(ref:SourceRef,c:string,ordinal:number,state='published'){const id='bs-edition-'+randomUUID().slice(0,8);await isolated.runtime.pool.query("insert into resource_id_ledger(resource_id,resource_type,committed_at) values($1,'digest_edition',current_timestamp)",[id]);await isolated.runtime.pool.query("insert into digest_editions(id,series_id,source_collection_id,issue_key,edition_ordinal,title_snapshot,source_content_revision,resource_revision,state,published_at) values($1,$2,$3,$4,$5,$6,'c1','r1',$7,case when $7='published' then current_timestamp + ($5::bigint*interval '1 second') else null end)",[id,ref.sourceId,c,'issue-'+ordinal,ordinal,'Edition '+ordinal,state]);return id;}
  test('Collection public/member projections filter ancestor privacy and revoke nodes without content feature',async()=>{
    const f=await fixture();const folder='secret-'+randomUUID();const child='private-'+randomUUID();await node(f.ref.sourceId,folder,'root-'+f.ref.sourceId,'folder','private');await node(f.ref.sourceId,child,folder);
    const {m}=await mount(f.actor,f.ref);
    let projection=await uow().execute(p=>p.sources.project(f.actor,f.ref,null,null));assert.ok(projection);assert.equal(projection.nodes.some(n=>n.key.includes(child)),false);
    await isolated.runtime.pool.query("insert into collection_members(collection_id,subject_id,role) values($1,$2,'viewer')",[f.ref.sourceId,f.actor.subjectId]);
    projection=await uow().execute(p=>p.sources.project(f.actor,f.ref,null,null));assert.equal(projection!.nodes.some(n=>n.key.includes(child)),true);
    await isolated.runtime.pool.query('delete from collection_members where collection_id=$1 and subject_id=$2',[f.ref.sourceId,f.actor.subjectId]);
    const checks=await uow().execute(p=>checkNodes(p,f.actor,m.mappingId,false,m.generation,[{sourceCollectionId:f.ref.sourceId,nodeId:child,editionId:null},{sourceCollectionId:f.ref.sourceId,nodeId:f.nodeId,editionId:null}]));assert.equal(checks.state,'available');if(checks.state==='available'){assert.deepEqual(checks.removeNodes,[{sourceCollectionId:f.ref.sourceId,nodeId:child,editionId:null}]);assert.equal(checks.contentEnabled,false);}
    await assert.rejects(uow().execute(p=>accessCheck(p,{accountId:f.owner,subjectId:'subject-'+f.owner},m.mappingId,false,[])),{code:'resource_not_found'});
  });
  test('single mapping exit preserves sibling and account lifecycle, account exit is immediate, immutable ACK replays',async()=>{
    const f=await fixture();const {s,m}=await mount(f.actor,f.ref);const second=await mount(f.actor,f.ref);const input={trigger:'unsubscribe',target:{kind:'mapping',mappingId:m.mappingId}} as const;
    const batch=await uow().execute(async p=>{await p.lockAccount(f.actor.accountId);return commitExit(p,f.actor,input);},{write:true});
    await uow().execute(async p=>{assert.equal((await p.store.getSubscription(f.actor.accountId,s.subscriptionId))!.status,'active');assert.equal((await p.store.getMapping(f.actor.accountId,second.m.mappingId))!.status,'active');const access=await accessCheck(p,f.actor,m.mappingId,false,[],batch.actions[0]!.actionId);assert.equal(access.state,'available');});
    const receipt=await uow().execute(async p=>{await p.lockAccount(f.actor.accountId);return acknowledgeAction(p,f.actor,batch.actions[0]!.actionId,{mappingId:m.mappingId,generation:m.generation,result:'kept'});},{write:true});
    assert.deepEqual(await uow().execute(p=>acknowledgeAction(p,f.actor,receipt.actionId,receipt)),receipt);
    await assert.rejects(uow().execute(p=>acknowledgeAction(p,f.actor,receipt.actionId,{...receipt,result:'no_local_mount'})),{code:'revision_conflict'});
    await uow().execute(async p=>{await p.lockAccount(f.actor.accountId);await commitExit(p,f.actor,{trigger:'unsubscribe',target:{kind:'subscription',subscriptionId:s.subscriptionId}});},{write:true});
    const next=await mount(f.actor,f.ref);assert.notEqual(next.s.subscriptionId,s.subscriptionId);
  });
  test('preview freezes target versions and detects additions before any effects',async()=>{
    const f=await fixture();const {s,m}=await mount(f.actor,f.ref);const preview=await uow().execute(async p=>{await p.lockAccount(f.actor.accountId);const v=await saveExitPreview(p,f.actor,{trigger:'unsubscribe',target:{kind:'subscription',subscriptionId:s.subscriptionId}});return v;},{write:true});
    await mount(f.actor,f.ref);
    await assert.rejects(uow().execute(async p=>{await p.lockAccount(f.actor.accountId);return commitExit(p,f.actor,{trigger:'unsubscribe',target:{kind:'subscription',subscriptionId:s.subscriptionId}},preview.previewId);},{write:true}),{code:'precondition_failed'});
    assert.equal(await uow().execute(async p=>(await p.store.getMapping(f.actor.accountId,m.mappingId))!.status),'active');
  });
  test('Collection unfollow authority, actions and receipt roll back in one transaction and exact replay is stable',async()=>{
    const f=await fixture();const {s,m}=await mount(f.actor,f.ref);const input={actor:{principalId:f.actor.accountId,profileId:f.actor.accountId,subjectId:f.actor.subjectId},collectionId:f.ref.sourceId,commandId:randomUUID()};
    const broken=createPostgresCollectionFollowCommandUnitOfWork(isolated.runtime.db,{faultInjector:{afterPhase(phase){if(phase==='complete')throw new Error('fault after receipt');}}});
    await assert.rejects(broken.execute(p=>unfollowCollection(p,input)),/fault after receipt/);
    assert.equal((await isolated.runtime.pool.query('select 1 from collection_follows where collection_id=$1 and follower_profile_id=$2',[f.ref.sourceId,f.actor.accountId])).rowCount,1);
    await uow().execute(async p=>{assert.equal((await p.store.getSubscription(f.actor.accountId,s.subscriptionId))!.status,'active');assert.equal((await p.store.tasks(f.actor.accountId)).length,0);});
    const good=createPostgresCollectionFollowCommandUnitOfWork(isolated.runtime.db);assert.equal((await good.execute(p=>unfollowCollection(p,input))).kind,'succeeded');assert.equal((await good.execute(p=>unfollowCollection(p,input))).kind,'replay');
    assert.equal((await good.execute(p=>unfollowCollection(p,{...input,subscriptionExitPreviewId:randomUUID()}))).kind,'reused');
    await uow().execute(async p=>{assert.equal((await p.store.tasks(f.actor.accountId)).length,1);assert.equal((await p.store.getMapping(f.actor.accountId,m.mappingId))!.status,'terminating');});
  });
  test('Digest members discover unpublished-slug series but independently unreadable editions never enter recent window',async()=>{
    const f=await fixture();const ref=await series(f);const older=await edition(ref,f.ref.sourceId,1);const other=await fixture();const hidden=await edition(ref,other.ref.sourceId,2);await isolated.runtime.pool.query("update collections set visibility='private' where id=$1",[other.ref.sourceId]);await edition(ref,f.ref.sourceId,3,'draft');
    const {m}=await mount(f.actor,ref,undefined,'recent',20);const read=await uow().execute(p=>p.sources.project(f.actor,ref,'recent',20));assert.deepEqual(read!.editions.map(e=>e.editionId),[older]);assert.match(read!.source.openUrl,/\/library\/digests\/.+\/read$/);assert.equal(read!.nodes.some(n=>n.editionId===hidden),false);
    const check=await uow().execute(p=>accessCheck(p,f.actor,m.mappingId,false,[older,hidden]));assert.equal(check.state,'available');if(check.state==='available')assert.deepEqual(check.removeEditionIds,[hidden]);
    await isolated.runtime.pool.query("update digest_series set state='archived',deleted_at=current_timestamp where id=$1",[ref.sourceId]);assert.equal((await uow().execute(p=>accessCheck(p,f.actor,m.mappingId,false,[older]))).state,'unavailable');assert.equal(await uow().execute(p=>p.sources.memberSeries(f.actor,ref.sourceId)),null);
  });
  test('Digest unfollow shares follow receipt transaction and retains archived 404 behavior',async()=>{
    const f=await fixture();const ref=await series(f,'public');const reportActor={principalId:f.actor.accountId,subjectId:f.actor.subjectId,profileId:f.actor.accountId};const reports=createPostgresReportsUnitOfWork(isolated.runtime.db);await followDigestSeries(reports,{actor:reportActor,seriesId:ref.sourceId,commandId:randomUUID()});await mount(f.actor,ref);
    const input={actor:reportActor,seriesId:ref.sourceId,commandId:randomUUID()};const broken=createPostgresReportsUnitOfWork(isolated.runtime.db,{afterExecute(){throw new Error('atomic digest fault');}});await assert.rejects(unfollowDigestSeries(broken,input),/atomic digest fault/);assert.equal((await uow().execute(p=>p.store.tasks(f.actor.accountId))).length,0);
    assert.equal((await unfollowDigestSeries(reports,input)).kind,'succeeded');assert.equal((await unfollowDigestSeries(reports,input)).kind,'replay');assert.equal((await uow().execute(p=>p.store.tasks(f.actor.accountId))).length,1);
    await isolated.runtime.pool.query("update digest_series set state='archived',deleted_at=current_timestamp where id=$1",[ref.sourceId]);await assert.rejects(unfollowDigestSeries(reports,{...input,commandId:randomUUID()}),{code:'resource_not_found'});
  });
  test('snapshot materialization uses repeatable read and every continuation rechecks authorization',async()=>{
    const f=await fixture();const {m}=await mount(f.actor,f.ref);const rr=createPostgresBookmarkSubscriptionUnitOfWork(isolated.runtime.db,{origin,reportsEnabled:true,faultInjector:{async beforeCallback(tx){const result=await sql.raw<{isolation:string}>("select current_setting('transaction_isolation') as isolation").execute(tx);assert.equal(result.rows[0]!.isolation,'repeatable read');}}});
    const descriptor=await rr.execute(async p=>{const before=await projectionCheck(p,f.actor,m.mappingId);await isolated.runtime.pool.query('update nodes set title=$1 where id=$2',['Changed concurrently',f.nodeId]);const d=await createSnapshot(p,f.actor,{mappingId:m.mappingId,expectedProjectionEtag:before.etag});const saved=await p.store.getSnapshot(f.actor.accountId,d.snapshotId);assert.equal(saved!.projection.nodes.find(n=>n.key.includes(f.nodeId))!.title,'A useful resource');return d;});
    const page=await uow().execute(p=>snapshotNodes(p,f.actor,descriptor.snapshotId,undefined,cursor));assert.equal(page.complete,true);assert.equal(page.items.length,descriptor.counts.nodes);
    await isolated.runtime.pool.query("update collections set visibility='private' where id=$1",[f.ref.sourceId]);await assert.rejects(uow().execute(p=>snapshotNodes(p,f.actor,descriptor.snapshotId,undefined,cursor)),{code:'resource_not_found'});
    assert.equal((await uow().execute(p=>accessCheck(p,f.actor,m.mappingId,false,[]))).state,'unavailable');
  });
  test('snapshot cache admission rejects stale RR concurrency at exactly eight live caches',async()=>{
    const f=await fixture();const input={...f.ref,digestMode:null,editionLimit:null};
    for(let i=0;i<7;i++)await uow().execute(async p=>{await p.lockAccount(f.actor.accountId);await createSnapshot(p,f.actor,input);});
    let arrived=0;let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);
    const commands=[randomUUID(),randomUUID()];
    const jobs=commands.map(commandId=>uow().execute(async p=>{
      const binding={principalId:f.actor.accountId,commandScope:'POST /bookmark-subscription-concurrency-test',commandId};const fingerprint='sha256:'+commandId;
      await p.receipts.claim(binding,fingerprint);if(++arrived===2)release();await gate;
      await p.lockAccount(f.actor.accountId);const d=await createSnapshot(p,f.actor,input);
      await p.receipts.complete(binding,fingerprint,{status:201,body:Buffer.from(JSON.stringify(d)),stableHeaders:{},mediaType:'application/json',contractVersion:'1'});return d;
    }));
    const results=await Promise.allSettled(jobs);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
    const rejected=results.find(r=>r.status==='rejected') as PromiseRejectedResult;assert.equal(rejected.reason.kind,'serialization_failure');
    const caches=await isolated.runtime.pool.query('select count(*) as count from bookmark_subscription_snapshots where account_id=$1',[f.actor.accountId]);assert.equal(Number(caches.rows[0].count),8);
    const receipts=await isolated.runtime.pool.query('select count(*) as count from product_command_receipts where principal_id=$1',[f.actor.accountId]);assert.equal(Number(receipts.rows[0].count),1);
    await assert.rejects(uow().execute(async p=>{await p.lockAccount(f.actor.accountId);return createSnapshot(p,f.actor,input);}),{code:'rate_limited'});
  });
  test('snapshot pages keep complete parent-first output, bound bytes, and recheck all nodes on continuation',async()=>{
    const f=await fixture();for(let i=0;i<220;i++)await node(f.ref.sourceId,'page-'+i+'-'+randomUUID(),'root-'+f.ref.sourceId,'bookmark','inherit','汉'.repeat(500));
    const d=await uow().execute(p=>createSnapshot(p,f.actor,{...f.ref,digestMode:null,editionLimit:null}));
    const first=await uow().execute(p=>snapshotNodes(p,f.actor,d.snapshotId,undefined,cursor));assert.equal(first.complete,false);assert.ok(first.nextCursor);assert.ok(first.items.length<200);assert.ok(Buffer.byteLength(JSON.stringify(first))<=262144);
    const second=await uow().execute(p=>snapshotNodes(p,f.actor,d.snapshotId,first.nextCursor!,cursor));assert.equal(second.complete,true);assert.equal(second.nextCursor,null);
    const nodes=[...first.items,...second.items];assert.equal(nodes.length,d.counts.nodes);assert.equal(digest(nodes),d.contentDigest);const seen=new Set<string>();for(const n of nodes){if(n.parentKey)assert.ok(seen.has(n.parentKey));seen.add(n.key);}
    await assert.rejects(uow().execute(p=>snapshotNodes(p,f.actor,d.snapshotId,first.nextCursor!+'x',cursor)),{code:'invalid_cursor'});
    await assert.rejects(uow().execute(p=>snapshotNodes(p,{accountId:f.owner,subjectId:'subject-'+f.owner},d.snapshotId,undefined,cursor)),{code:'resource_not_found'});
    await isolated.runtime.pool.query("update nodes set visibility='private' where id=$1",[f.nodeId]);
    await assert.rejects(uow().execute(p=>snapshotNodes(p,f.actor,d.snapshotId,first.nextCursor!,cursor)),{code:'resource_not_found'});
  });
  test('zero-mapping preview binds subscription generation and expired receipt cache does not renew descriptor',async()=>{
    const f=await fixture();const first=await uow().execute(p=>createSubscription(p,f.actor,f.ref),{write:true});
    const input={trigger:'unsubscribe',target:{kind:'source',...f.ref}} as const;
    const preview=await uow().execute(p=>saveExitPreview(p,f.actor,input),{write:true});assert.equal(preview.targets.length,0);
    await uow().execute(p=>commitExit(p,f.actor,input),{write:true});await uow().execute(p=>createSubscription(p,f.actor,f.ref),{write:true});
    await assert.rejects(uow().execute(p=>commitExit(p,f.actor,input,preview.previewId),{write:true}),{code:'precondition_failed'});
    const d=await uow().execute(p=>createSnapshot(p,f.actor,{...f.ref,digestMode:null,editionLimit:null}));
    await isolated.runtime.pool.query('delete from bookmark_subscription_snapshots where id=$1',[d.snapshotId]);await uow().execute(p=>authorizeSnapshotReceipt(p,f.actor,d));
    await isolated.runtime.pool.query("update collections set visibility='private' where id=$1",[f.ref.sourceId]);await assert.rejects(uow().execute(p=>authorizeSnapshotReceipt(p,f.actor,d)),{code:'resource_not_found'});
    assert.ok(first.value.subscriptionId);
  });
  test('member reader includes authorized notes and edition summary; source revocation denies reading',async()=>{
    const f=await fixture();const ref=await series(f);const id=await edition(ref,f.ref.sourceId,1);await isolated.runtime.pool.query('update digest_editions set summary_snapshot=$1 where id=$2',['Curated summary',id]);await isolated.runtime.pool.query('update nodes set description=$1 where id=$2',['Curator note',f.nodeId]);
    const read=await uow().execute(p=>p.sources.memberEdition(f.actor,ref.sourceId,id));assert.equal(read!.reader!.editionSummary,'Curated summary');assert.ok(read!.reader!.notes.some(n=>n.description==='Curator note'));assert.ok(read!.source.openUrl.endsWith('/read'));
    await isolated.runtime.pool.query("update collections set visibility='private' where id=$1",[f.ref.sourceId]);assert.equal(await uow().execute(p=>p.sources.memberEdition(f.actor,ref.sourceId,id)),null);
  });
  test('member reader annotations retain creator-only private notes and independent Collection protection',async()=>{
    const f=await fixture();const ref=await series(f);const id=await edition(ref,f.ref.sourceId,1);
    for(const [label,visibility,creator] of [['public','public',f.owner],['protected','protected',f.owner],['private-owner','private',f.owner],['private-reader','private',f.actor.accountId]]){
      const aid='note-'+randomUUID();const at='2026-09-25T00:00:00Z';
      const payload={id:aid,collectionId:f.ref.sourceId,subject:{type:'node',id:f.nodeId},creator:{id:'https://app.example.test/profiles/curator',name:'Curator'},type:'note',format:'plain',value:label,visibility,revision:'r1',createdAt:at,updatedAt:at,extensions:{}};
      await isolated.runtime.pool.query("insert into resource_id_ledger(resource_id,resource_type,committed_at) values($1,'annotation',current_timestamp)",[aid]);
      await isolated.runtime.pool.query("insert into annotations(id,collection_id,subject_type,subject_id,creator_principal_id,type,format,value_json,visibility,resource_revision,created_at,updated_at,payload_json,payload_schema_version,payload_authority_status) values($1,$2,'node',$3,$4,'note','plain',$5::jsonb,$6,'r1',$7,$7,$8::jsonb,1,'backfilled')",[aid,f.ref.sourceId,f.nodeId,creator,JSON.stringify(label),visibility,at,JSON.stringify(payload)]);
    }
    let read=await uow().execute(p=>p.sources.memberEdition(f.actor,ref.sourceId,id));assert.deepEqual(read!.reader!.annotations.map(a=>a.value).sort(),['private-reader','public']);
    await isolated.runtime.pool.query("insert into collection_members(collection_id,subject_id,role) values($1,$2,'editor')",[f.ref.sourceId,f.actor.subjectId]);
    read=await uow().execute(p=>p.sources.memberEdition(f.actor,ref.sourceId,id));assert.deepEqual(read!.reader!.annotations.map(a=>a.value).sort(),['private-reader','protected','public']);
  });
  test('20k snapshot boundary and 128-node access stay bounded; profile limit is enforced at 50 live mappings',async()=>{
    const f=await fixture();const {m,s}=await mount(f.actor,f.ref);const prefix='capacity-'+randomUUID().slice(0,8)+'-';
    const started=Date.now();
    await isolated.runtime.pool.query("insert into resource_id_ledger(resource_id,resource_type,committed_at) select $1||v::text,'node',current_timestamp from generate_series(1,19997) v",[prefix]);
    for(let start=1;start<=19997;start+=1000)await isolated.runtime.pool.query("insert into nodes(id,collection_id,parent_id,kind,is_root,title,url,visibility,position_token,resource_revision,children_revision) select $1||v::text,$2,$3,'bookmark',false,'Capacity item','https://example.test/'||v::text,'inherit','b'||lpad(v::text,8,'0'),'r1','c1' from generate_series($4::int,$5::int) v",[prefix,f.ref.sourceId,'root-'+f.ref.sourceId,start,Math.min(start+999,19997)]);
    const seedMs=Date.now()-started;const begin=Date.now();
    const d=await uow().execute(p=>createSnapshot(p,f.actor,{...f.ref,digestMode:null,editionLimit:null}));assert.equal(d.counts.nodes,20000);const buildMs=Date.now()-begin;
    const pageBegin=Date.now();const first=await uow().execute(p=>snapshotNodes(p,f.actor,d.snapshotId,undefined,cursor));assert.equal(first.items.length,200);assert.equal(first.complete,false);const pageMs=Date.now()-pageBegin;
    const checkBegin=Date.now();const refs=Array.from({length:128},(_,i)=>({sourceCollectionId:f.ref.sourceId,nodeId:prefix+(i+1),editionId:null}));const access=await uow().execute(p=>checkNodes(p,f.actor,m.mappingId,false,m.generation,refs));assert.equal(access.state,'available');if(access.state==='available')assert.equal(access.removeNodes.length,0);const accessMs=Date.now()-checkBegin;
    await isolated.runtime.pool.query("update nodes set url='https://example.test/'||repeat('x',1900) where collection_id=$1 and kind='bookmark'",[f.ref.sourceId]);
    await assert.rejects(uow().execute(p=>createSnapshot(p,f.actor,{...f.ref,digestMode:null,editionLimit:null})),{code:'payload_too_large'});
    assert.equal((await uow().execute(p=>checkNodes(p,f.actor,m.mappingId,false,m.generation,refs))).state,'available');
    await node(f.ref.sourceId,prefix+'overflow','root-'+f.ref.sourceId);await assert.rejects(uow().execute(p=>createSnapshot(p,f.actor,{...f.ref,digestMode:null,editionLimit:null})),{code:'payload_too_large'});
    // Unavailable live sources still consume the profile quota; availability cannot bypass it.
    await uow().execute(async p=>{for(let i=1;i<50;i++){const source={...s,subscriptionId:randomUUID(),sourceId:'unavailable-'+i};await p.store.saveSubscription(f.actor.accountId,source);await p.store.saveMapping(f.actor.accountId,source,{...m,mappingId:randomUUID(),subscriptionId:source.subscriptionId});}},{write:true});
    const other=await fixture();await isolated.runtime.pool.query('insert into collection_follows(collection_id,follower_profile_id) values($1,$2)',[other.ref.sourceId,f.actor.accountId]);
    const subscription=await uow().execute(p=>createSubscription(p,f.actor,other.ref),{write:true});
    await assert.rejects(uow().execute(p=>createMapping(p,f.actor,subscription.value.subscriptionId,{mappingId:randomUUID(),profileId:m.profileId,profileLabel:'Browser',mode:'readonly',digestMode:null,editionLimit:null,checkIntervalMinutes:15,exitPolicy:{onUnfollow:'inherit',onUnsubscribe:'inherit'}},etag(subscription.value)),{write:true}),{code:'invalid_document'});
    const listed=await uow().execute(p=>listConfiguration(p,f.actor,'mappings',{profileId:m.profileId,status:'live',limit:'50'},cursor));assert.equal(listed.items.length,50);assert.equal(listed.nextCursor,null);
    console.log(JSON.stringify({benchmark:'bookmark-subscriptions-20k',seedMs,buildMs,pageMs,access128Ms:accessMs,bytes:Buffer.byteLength(JSON.stringify(first))}));
  },60000);
  test('recent 1/10/20 backfills older readable published editions; latest/recent keys are stable',async()=>{
    const f=await fixture();const ref=await series(f);const ids:string[]=[];for(let i=1;i<=22;i++)ids.push(await edition(ref,f.ref.sourceId,i));
    const hidden=await fixture();await isolated.runtime.pool.query("update collections set visibility='private' where id=$1",[hidden.ref.sourceId]);for(let i=23;i<=44;i++)await edition(ref,hidden.ref.sourceId,i);await edition(ref,f.ref.sourceId,45,'draft');
    for(const count of [1,10,20]){const p=await uow().execute(p=>p.sources.project(f.actor,ref,'recent',count));assert.equal(p!.editions.length,count);assert.equal(p!.editions[0]!.editionId,ids[21]);assert.equal(p!.editions.at(-1)!.editionId,ids[22-count]);}
    const latest=await uow().execute(p=>p.sources.project(f.actor,ref,'latest',1));const recent=await uow().execute(p=>p.sources.project(f.actor,ref,'recent',1));assert.deepEqual(latest!.nodes.filter(n=>n.role==='content').map(n=>n.key),recent!.nodes.filter(n=>n.role==='content').map(n=>n.key));
    await isolated.runtime.pool.query("update digest_editions set state='withdrawn',withdrawn_at=current_timestamp where id=$1",[ids[21]]);assert.equal((await uow().execute(p=>p.sources.project(f.actor,ref,'latest',1)))!.editions[0]!.editionId,ids[20]);
  });
  test('10,001 unreadable published candidates exhaust the scan budget instead of returning an empty tree',async()=>{
    const f=await fixture();const ref=await series(f);const hidden=await fixture();await isolated.runtime.pool.query("update collections set visibility='private' where id=$1",[hidden.ref.sourceId]);const prefix='scan-'+randomUUID().slice(0,8)+'-';
    await isolated.runtime.pool.query("insert into resource_id_ledger(resource_id,resource_type,committed_at) select $1||v::text,'digest_edition',current_timestamp from generate_series(1,10001) v",[prefix]);
    await isolated.runtime.pool.query("insert into digest_editions(id,series_id,source_collection_id,issue_key,edition_ordinal,title_snapshot,source_content_revision,resource_revision,state,published_at) select $1||v::text,$2,$3,'issue-'||v::text,v,'Hidden edition','c1','r1','published',current_timestamp from generate_series(1,10001) v",[prefix,ref.sourceId,hidden.ref.sourceId]);
    const started=Date.now();await assert.rejects(uow().execute(p=>p.sources.project(f.actor,ref,'latest',1)),{code:'payload_too_large'});console.log(JSON.stringify({benchmark:'bookmark-subscriptions-scan-10001',durationMs:Date.now()-started}));
  },30000);
  test('depth129 fails explicitly; expired snapshot returns 409 even after cache pruning',async()=>{
    const f=await fixture();let parent='root-'+f.ref.sourceId;for(let i=0;i<129;i++){const id='depth-'+randomUUID();await node(f.ref.sourceId,id,parent,'folder');parent=id;}
    await assert.rejects(uow().execute(p=>createSnapshot(p,f.actor,{...f.ref,digestMode:null,editionLimit:null})),{code:'payload_too_large'});
    const other=await fixture();const input={...other.ref,digestMode:null,editionLimit:null};const d=await uow().execute(p=>createSnapshot(p,other.actor,input));
    const expired=new Date(Date.now()-1000).toISOString();await isolated.runtime.pool.query("update bookmark_subscription_snapshots set expires_at=$2::text::timestamptz,descriptor=jsonb_set(descriptor,'{expiresAt}',to_jsonb($2::text)) where id=$1",[d.snapshotId,expired]);
    await uow().execute(p=>createSnapshot(p,other.actor,input));await assert.rejects(uow().execute(p=>snapshotNodes(p,other.actor,d.snapshotId,undefined,cursor)),{code:'snapshot_expired'});
  });
  test('management keyset retains over 50 detached rows and live includes pending exits',async()=>{
    const f=await fixture();const {s,m}=await mount(f.actor,f.ref);await uow().execute(async p=>{await p.lockAccount(f.actor.accountId);for(let i=0;i<65;i++)await p.store.saveMapping(f.actor.accountId,s,{...m,mappingId:randomUUID(),status:'detached',createdAt:new Date(Date.now()-1000*(i+1)).toISOString(),detachedAt:new Date().toISOString()});},{write:true});
    const first=await uow().execute(p=>listConfiguration(p,f.actor,'mappings',{status:'detached',limit:'50'},cursor));assert.equal(first.items.length,50);assert.ok(first.nextCursor);const second=await uow().execute(p=>listConfiguration(p,f.actor,'mappings',{cursor:first.nextCursor!},cursor));assert.equal(second.items.length,15);assert.equal(second.nextCursor,null);
    await uow().execute(async p=>{await p.lockAccount(f.actor.accountId);await commitExit(p,f.actor,{trigger:'unsubscribe',target:{kind:'mapping',mappingId:m.mappingId}});},{write:true});const live=await uow().execute(p=>listConfiguration(p,f.actor,'mappings',{status:'live'},cursor));assert.equal(live.items.length,1);assert.equal((live.items[0] as Mapping).status,'terminating');
  });
  test('both real DELETE follow paths bind current session on CSRF failure, success and cross-session receipt replay',async()=>{
    const f=await fixture();const report=await series(f,'public');const reports=createPostgresReportsUnitOfWork(isolated.runtime.db);
    await followDigestSeries(reports,{actor:{principalId:f.actor.accountId,profileId:f.actor.accountId,subjectId:f.actor.subjectId},seriesId:report.sourceId,commandId:randomUUID()});await mount(f.actor,f.ref);await mount(f.actor,report);
    const identity=createPostgresIdentityUnitOfWork(isolated.runtime.db);const session=await identity.execute(p=>createSession(p,{accountId:f.actor.accountId}));const next=await identity.execute(p=>createSession(p,{accountId:f.actor.accountId}));
    const app=Fastify({exposeHeadRoutes:false,routerOptions:{querystringParser:parseStrictQuery}});installProductRouteManifestChecks(app,{requireComplete:false});installProductAdmission(app);app.setErrorHandler((e,request,reply)=>sendProductError(request,reply,e instanceof ProductHttpError?e:new ProductHttpError({statusCode:500,code:'internal_error',message:e.message})));
    const rateLimiter=createFixedWindowRateLimiter({maxRequests:100,windowMs:60000});
    registerCollectionFollowRoutes(app,{enabled:true,allowedOrigins:[origin],identityUnitOfWork:identity,commandUnitOfWork:createPostgresCollectionFollowCommandUnitOfWork(isolated.runtime.db),queryUnitOfWork:createPostgresCollectionFollowQueryUnitOfWork(isolated.runtime.db),rateLimiter,timeoutMs:15000});
    registerSecondaryReportRoutes(app,{config:{allowedOrigins:[origin],reports:{enabled:true}} as Parameters<typeof registerSecondaryReportRoutes>[1]['config'],identityUnitOfWork:identity,unitOfWork:reports,rateLimiter});
    try{for(const source of [f.ref,report]){
      const preview=await uow().execute(async p=>{await p.lockAccount(f.actor.accountId);return saveExitPreview(p,f.actor,{trigger:'unfollow',target:{kind:'source',...source}});},{write:true});
      const url=source.sourceType==='collection'?'/api/v1/collections/'+source.sourceId+'/follow':'/api/v1/reports/'+source.sourceId+'/follow';
      const base={cookie:SESSION_COOKIE_NAME+'='+encodeURIComponent(session.rawSessionToken),origin,'known-command-id':randomUUID(),'known-subscription-exit-preview':preview.previewId};
      const denied=await app.inject({method:'DELETE',url,headers:base});assert.equal(denied.statusCode,403,denied.body);assert.equal(denied.headers['known-subscription-session'],session.session.id);
      const response=await app.inject({method:'DELETE',url,headers:{...base,'x-csrf-token':session.rawCsrfToken}});assert.equal(response.statusCode,200,response.body);assert.equal(response.headers['known-subscription-session'],session.session.id);assert.equal(response.headers['cache-control'],'private, no-store');
      const replay=await app.inject({method:'DELETE',url,headers:{...base,cookie:SESSION_COOKIE_NAME+'='+encodeURIComponent(next.rawSessionToken),'x-csrf-token':next.rawCsrfToken}});assert.equal(replay.statusCode,200,replay.body);assert.equal(replay.body,response.body);assert.equal(replay.headers['known-subscription-session'],next.session.id);assert.equal(replay.headers['cache-control'],'private, no-store');
    }}finally{await app.close();}
  });
  test('real HTTP authenticates, binds 304 and CSRF errors, keeps exits and access available with content gate off',async()=>{
    const f=await fixture();const {m}=await mount(f.actor,f.ref);const identity=createPostgresIdentityUnitOfWork(isolated.runtime.db);const session=await identity.execute(p=>createSession(p,{accountId:f.actor.accountId}));let enabled=true;const app=Fastify({exposeHeadRoutes:false,routerOptions:{querystringParser:parseStrictQuery}});installProductRouteManifestChecks(app,{requireComplete:false});installProductAdmission(app);app.setErrorHandler((e,request,reply)=>sendProductError(request,reply,e instanceof ProductHttpError?e:new ProductHttpError({statusCode:500,code:'internal_error',message:e.message})));
    const deps={identityUnitOfWork:identity,unitOfWork:uow(),allowedOrigins:[origin],enabled:()=>enabled,protocolReady:()=>true,cursorKey:'c'.repeat(32)};registerBookmarkSubscriptionRoutes(app,deps);registerReportReaderRoutes(app,deps);const headers={cookie:SESSION_COOKIE_NAME+'='+encodeURIComponent(session.rawSessionToken)};
    try{
      const url='/api/v1/me/bookmark-subscription-mappings/'+m.mappingId+'/projection';const first=await app.inject({url,headers});assert.equal(first.statusCode,200,first.body);const unchanged=await app.inject({url,headers:{...headers,'if-none-match':first.headers.etag!}});assert.equal(unchanged.statusCode,304,unchanged.body);assert.equal(unchanged.body,'');assert.equal(unchanged.headers['known-subscription-session'],session.session.id);
      const denied=await app.inject({method:'POST',url:'/api/v1/me/bookmark-subscription-exit-previews',headers:{...headers,origin,'known-command-id':randomUUID()},payload:{trigger:'unsubscribe',target:{kind:'mapping',mappingId:m.mappingId}}});assert.equal(denied.statusCode,403,denied.body);assert.equal(denied.headers['known-subscription-session'],session.session.id);
      enabled=false;assert.equal((await app.inject({url,headers})).statusCode,404);const access=await app.inject({url:url.replace('/projection','/access'),headers});assert.equal(access.statusCode,200,access.body);assert.equal(access.json().contentEnabled,false);
      const preview=await app.inject({method:'POST',url:'/api/v1/me/bookmark-subscription-exit-previews',headers:{...headers,origin,'x-csrf-token':session.rawCsrfToken,'known-command-id':randomUUID()},payload:{trigger:'unsubscribe',target:{kind:'mapping',mappingId:m.mappingId}}});assert.equal(preview.statusCode,201,preview.body);
      const bad=await app.inject({url:'/api/v1/me/bookmark-subscription-mappings?limit=1&limit=2',headers});assert.equal(bad.statusCode,400,bad.body);
      const mutationHeaders={...headers,origin,'x-csrf-token':session.rawCsrfToken};const checkUrl=url.replace('/projection','/node-access-checks');
      const refs=Array.from({length:128},(_,i)=>({sourceCollectionId:f.ref.sourceId,nodeId:'unknown-'+i,editionId:null}));
      const checked=await app.inject({method:'POST',url:checkUrl,headers:mutationHeaders,payload:{generation:m.generation,nodes:refs}});assert.equal(checked.statusCode,200,checked.body);assert.equal(checked.json().removeNodes.length,128);
      assert.equal((await app.inject({method:'POST',url:checkUrl,headers:mutationHeaders,payload:{generation:m.generation,nodes:[...refs,{...refs[0],nodeId:'overflow'}]}})).statusCode,400);
      assert.equal((await app.inject({method:'POST',url:checkUrl,headers:{...mutationHeaders,'known-command-id':randomUUID()},payload:{generation:m.generation,nodes:[]}})).statusCode,400);
      assert.equal((await app.inject({method:'POST',url:checkUrl,headers:mutationHeaders,payload:{generation:m.generation,nodes:[],junk:'x'.repeat(65536)}})).statusCode,413);
      enabled=true;const snapshotUrl='/api/v1/me/bookmark-subscription-snapshots';const commandHeaders={...mutationHeaders,'known-command-id':randomUUID()};const payload={...f.ref,digestMode:null,editionLimit:null};
      const snapshot=await app.inject({method:'POST',url:snapshotUrl,headers:commandHeaders,payload});assert.equal(snapshot.statusCode,201,snapshot.body);
      const replay=await app.inject({method:'POST',url:snapshotUrl,headers:commandHeaders,payload});assert.equal(replay.statusCode,201,replay.body);assert.deepEqual(replay.json(),snapshot.json());assert.equal(replay.headers['known-subscription-session'],session.session.id);
      const report=await series(f);const issue=await edition(report,f.ref.sourceId,1);const member=await app.inject({url:'/api/v1/me/report-readers/'+report.sourceId+'/editions/'+issue,headers});assert.equal(member.statusCode,200,member.body);assert.ok(member.json().reader);assert.equal(member.headers['known-subscription-session'],session.session.id);
      await isolated.runtime.pool.query("update collections set visibility='private' where id=$1",[f.ref.sourceId]);
      const revoked=await app.inject({method:'POST',url:snapshotUrl,headers:commandHeaders,payload});assert.equal(revoked.statusCode,404,revoked.body);assert.ok(!revoked.body.includes('Edition'));const conditional=await app.inject({url,headers:{...headers,'if-none-match':first.headers.etag!}});assert.equal(conditional.statusCode,200,conditional.body);assert.equal(conditional.json().state,'unavailable');

    }finally{await app.close();}
  });
});
