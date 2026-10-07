import {SYNTHETIC_PIPELINE_CALIBRATION as calibration,SYNTHETIC_DEPLOYMENT_IDENTITY} from '../../support/classification-auto-calibration.js';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { beforeAll,afterAll,test,expect } from 'vitest';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { createIsolatedPostgresRuntime,describeWithPostgres,type IsolatedPostgresRuntime } from '../../support/postgres-test-runtime.js';
import { seedCanonicalClassificationFixture } from '../../support/classification-database-fixture.js';
import { canonicalCommandFingerprint } from '../../../src/modules/commands/index.js';
import { createCollectionNode,updateCollectionNode,type BookmarkClassificationProvider,type ClassificationAutoCalibration } from '../../../src/modules/collections/index.js';
import { createPostgresClassificationConfirmationUnitOfWork } from '../../../src/infrastructure/collections/classification-confirmation-postgres.js';
import { createPostgresClassificationAutoTagProcessor } from '../../../src/infrastructure/collections/classification-auto-tag-process.js';
import { createBookmarkClassificationProvider } from '../../../src/infrastructure/collections/classification-provider-factory.js';
import { appendClassificationAutoTagJob } from '../../../src/infrastructure/collections/classification-auto-tag-producer.js';
import { createClassificationAutoTagOutboxRoute,CLASSIFICATION_AUTO_TAG_HANDLER } from '../../../src/infrastructure/outbox/classification-auto-tag.js';
import { PostgresOutboxRepository,type OutboxClaim } from '../../../src/infrastructure/outbox/repository.js';
import { OutboxContinuationRequested,type OutboxHandlerContext } from '../../../src/infrastructure/outbox/router.js';
import { createUnitOfWork } from '../../../src/infrastructure/database/unit-of-work.js';

describeWithPostgres('CLF-EXT-02 canonical auto-tag jobs',()=>{
  let isolated:IsolatedPostgresRuntime;
  beforeAll(async()=>{isolated=await createIsolatedPostgresRuntime('classification_auto',{maxConnections:6});await runMigrations(isolated.runtime.db,'latest');},180000);
  afterAll(async()=>isolated?.close());
  async function seed(auto=true){
    const input=await seedCanonicalClassificationFixture(isolated.runtime);
    await sql`INSERT INTO collection_classification_settings(collection_id,owner_subject_id,auto_tag_mode,max_auto_tags,execution_mode,provider_profile_id,revision)
      VALUES(${input.collectionId},${input.ownerSubjectId},${auto?'auto':'suggest'},3,'server_managed',NULL,1)`.execute(isolated.runtime.db);
    const request={actor:{principalId:input.collectionId,subjectId:input.ownerSubjectId,principalType:'account' as const},collectionId:input.collectionId,parentId:input.root,
      command:{commandId:randomUUID(),fingerprint:'classification-auto-create'},afterId:null,beforeId:null,
      node:{kind:'bookmark' as const,title:'New auto bookmark',url:'https://example.org/new-auto',description:null,tags:['manual'],visibility:'inherit' as const}};
    return {input,request};
  }
  const create=(request:Awaited<ReturnType<typeof seed>>['request'])=>createPostgresClassificationConfirmationUnitOfWork(isolated.runtime.db)
    .execute(({collection})=>createCollectionNode(collection,request));
  function fixtureProvider(onCall?:()=>Promise<void>){
    let calls=0;
    const provider:BookmarkClassificationProvider={...createBookmarkClassificationProvider(null),async classify(input,execution){
      const tags=[];
      for(const [chunkIndex,chunk] of input.candidates!.tagChunks.entries()){
        const result=await execution.calls.run('tags',chunkIndex,{fixture:chunk},async()=>{
          calls++;await onCall?.();return {answer:chunk.map(tag=>({tag,noul:tag==='AI'?0.99:0.1})),modelVersion:'jev-1.13.0',inputTokens:1,outputTokens:0};
        });tags.push(...result.answer as {tag:string;noul:number}[]);
      }
      return {l1:null,l2:null,tags,candidateCoverage:input.candidates!.coverage,modelVersion:'jev-1.13.0'};
    }};return {provider,calls:()=>calls};
  }
  async function claim(){
    // Other projection families are isolated by the fixture; this family uses the real durable lease repository.
    await sql`UPDATE outbox_events SET state='completed',completed_at=clock_timestamp() WHERE handler_name<>${CLASSIFICATION_AUTO_TAG_HANDLER}`.execute(isolated.runtime.db);
    const repository=new PostgresOutboxRepository(isolated.runtime.pool),claimed=await repository.claim(30000);
    if(!claimed)throw new Error('missing auto outbox claim');expect(claimed.handlerName).toBe(CLASSIFICATION_AUTO_TAG_HANDLER);
    return {repository,claimed,context:contextFor(claimed)};
  }
  function contextFor(claimed:OutboxClaim):OutboxHandlerContext{
    return {signal:new AbortController().signal,attempt:{outboxId:claimed.outboxId,leaseGeneration:claimed.leaseGeneration},idempotencyKey:claimed.eventId,
      envelope:{event_id:claimed.eventId,event_type:claimed.eventType,event_version:claimed.eventVersion,
        aggregate_identity:{aggregate_type:claimed.aggregateType,aggregate_id:claimed.aggregateId,aggregate_scope:claimed.aggregateScope},
        aggregate_revision:claimed.aggregateRevision,commit_ordinal:claimed.commitOrdinal,occurred_at:claimed.occurredAt.toISOString(),payload:claimed.payload as {jobId:string}}};
  }
  const processor=(provider:BookmarkClassificationProvider,approved:ClassificationAutoCalibration|null=calibration)=>createPostgresClassificationAutoTagProcessor(isolated.runtime.db,provider,
      {enabled:()=>true,calibration:()=>approved,identity:SYNTHETIC_DEPLOYMENT_IDENTITY,metric:()=>{},cancelBackend:isolated.runtime.cancelBackend});

  test('account automatic capture owns execution and suppresses the independent auto-tag producer', async () => {
    const { input, request } = await seed();
    await sql`INSERT INTO bookmark_preferences(account_id, bookmark_insert_position, folders_first, revision, updated_at, capture_mode)
      VALUES (${input.collectionId}, 'bottom', true, '1', now(), 'automatic')`.execute(isolated.runtime.db);
    const result = await create(request); if (result.kind !== 'created') throw new Error('not created');
    expect(await isolated.runtime.db.selectFrom('collection_classification_tag_jobs').select('id').where('node_id', '=', result.node.id).execute()).toEqual([]);
  });

  test('creation enqueues atomically, adds only existing tags and never adds a user-deleted tag again',async()=>{
    const {input,request}=await seed();const result=await create(request);if(result.kind!=='created')throw new Error('not created');
    expect((await create(request)).kind).toBe('replay');
    const jobs=await isolated.runtime.db.selectFrom('collection_classification_tag_jobs').selectAll().where('node_id','=',result.node.id).execute();expect(jobs).toHaveLength(1);
    const {provider,calls}=fixtureProvider();expect(calls()).toBe(0);
    const delivery=await claim(),route=createClassificationAutoTagOutboxRoute(processor(provider));await route.handle(delivery.context);
    expect(await delivery.repository.complete(delivery.claimed)).toBe(true);
    const tagged=await isolated.runtime.db.selectFrom('nodes').select(['tags','resource_revision']).where('id','=',result.node.id).executeTakeFirstOrThrow();
    expect(tagged.tags).toEqual(['manual','AI']);expect(calls()).toBe(1);
    const job=await isolated.runtime.db.selectFrom('collection_classification_tag_jobs').selectAll().where('id','=',jobs[0]!.id).executeTakeFirstOrThrow();
    expect(job).toMatchObject({status:'applied',selected_tag_count:1});expect(job.selected_tag_digest).toMatch(/^[a-f0-9]{64}$/u);
    await createPostgresClassificationConfirmationUnitOfWork(isolated.runtime.db).execute(({collection})=>updateCollectionNode(collection,{
      actor:request.actor,collectionId:input.collectionId,nodeId:result.node.id,ifMatch:`"${tagged.resource_revision}"`,
      command:{commandId:randomUUID(),fingerprint:'remove-auto-tag'},patch:{tags:['manual']}}));
    await route.handle(delivery.context);
    expect((await isolated.runtime.db.selectFrom('nodes').select('tags').where('id','=',result.node.id).executeTakeFirstOrThrow()).tags).toEqual(['manual']);
    expect(calls()).toBe(1);
  });

  test('suggest creates no auto job; failed calibration never calls provider or changes the bookmark',async()=>{
    const suggested=await seed(false);const native=await create(suggested.request);if(native.kind!=='created')throw new Error('not created');
    expect(await isolated.runtime.db.selectFrom('collection_classification_tag_jobs').select('id').where('node_id','=',native.node.id).execute()).toHaveLength(0);
    const auto=await seed();const created=await create(auto.request);if(created.kind!=='created')throw new Error('not created');
    const fake=fixtureProvider(),delivery=await claim();await createClassificationAutoTagOutboxRoute(processor(fake.provider,null)).handle(delivery.context);
    await delivery.repository.complete(delivery.claimed);expect(fake.calls()).toBe(0);
    expect((await isolated.runtime.db.selectFrom('nodes').select('tags').where('id','=',created.node.id).executeTakeFirstOrThrow()).tags).toEqual(['manual']);
  });

  test('replayed creation/policy changes do not replace the original intent; enqueue failure rolls back the canonical creation',async()=>{
    const {request}=await seed();const created=await create(request);if(created.kind!=='created')throw new Error('not created');
    const job=await isolated.runtime.db.selectFrom('collection_classification_tag_jobs').selectAll().where('node_id','=',created.node.id).executeTakeFirstOrThrow();
    const outbox=await isolated.runtime.db.selectFrom('outbox_events').selectAll().where('outbox_id','=',job.outbox_id!).executeTakeFirstOrThrow();
    await isolated.runtime.db.updateTable('collection_classification_tag_jobs').set({policy_version:'old-policy'}).where('id','=',job.id).execute();
    await createUnitOfWork(isolated.runtime.db).execute(({transaction})=>appendClassificationAutoTagJob(transaction,{domainEventId:outbox.domain_event_id,
      operationId:created.operationId,collectionId:request.collectionId,aggregateType:'node',aggregateId:created.node.id,aggregateRevision:job.resource_revision,
      eventType:'resource.create',eventVersion:1,commitOrdinal:created.commitOrdinal,payload:{}}));
    expect((await isolated.runtime.db.selectFrom('collection_classification_tag_jobs').selectAll().where('node_id','=',created.node.id).execute())).toHaveLength(1);
    expect((await isolated.runtime.db.selectFrom('collection_classification_tag_jobs').select('policy_version').where('id','=',job.id).executeTakeFirstOrThrow()).policy_version).toBe('old-policy');
    const delivery=await claim();await createClassificationAutoTagOutboxRoute(processor(fixtureProvider().provider)).handle(delivery.context);await delivery.repository.complete(delivery.claimed);
    const failed=await seed();
    await expect(createPostgresClassificationConfirmationUnitOfWork(isolated.runtime.db,{faultInjector:{afterCallbackBeforeCommit(){throw new Error('enqueue_rollback');}}})
      .execute(({collection})=>createCollectionNode(collection,failed.request))).rejects.toThrow('enqueue_rollback');
    expect(await isolated.runtime.db.selectFrom('collection_classification_tag_jobs').select('id').where('collection_id','=',failed.input.collectionId).execute()).toHaveLength(0);
    expect(await isolated.runtime.db.selectFrom('nodes').select('id').where('collection_id','=',failed.input.collectionId).where('url','=','https://example.org/new-auto').execute()).toHaveLength(0);
  });

  test('a user edit during the provider call obsoletes the job without overwriting the edit',async()=>{
    const {request}=await seed();const created=await create(request);if(created.kind!=='created')throw new Error('not created');
    const fake=fixtureProvider(async()=>{
      await createPostgresClassificationConfirmationUnitOfWork(isolated.runtime.db).execute(({collection})=>updateCollectionNode(collection,{
        actor:request.actor,collectionId:request.collectionId,nodeId:created.node.id,ifMatch:created.node.etag,
        command:{commandId:randomUUID(),fingerprint:'concurrent-user-tags'},patch:{tags:['manual','user']}}));
    });
    const delivery=await claim();await createClassificationAutoTagOutboxRoute(processor(fake.provider)).handle(delivery.context);await delivery.repository.complete(delivery.claimed);
    expect((await isolated.runtime.db.selectFrom('collection_classification_tag_jobs').select('status').where('node_id','=',created.node.id).executeTakeFirstOrThrow()).status).toBe('obsolete');
    expect((await isolated.runtime.db.selectFrom('nodes').select('tags').where('id','=',created.node.id).executeTakeFirstOrThrow()).tags).toEqual(['manual','user']);
    expect(fake.calls()).toBe(1);
  });

  test('taxonomy-only change permits one recorded recomputation with a distinct execution command',async()=>{
    const {input,request}=await seed();const created=await create(request);if(created.kind!=='created')throw new Error('not created');
    let changed=false;
    const fake=fixtureProvider(async()=>{
      if(changed)return;changed=true;
      await createPostgresClassificationConfirmationUnitOfWork(isolated.runtime.db).execute(({collection})=>updateCollectionNode(collection,{
        actor:request.actor,collectionId:input.collectionId,nodeId:input.folderId,ifMatch:'"r1"',
        command:{commandId:randomUUID(),fingerprint:'folder-description-change'},patch:{description:'A changed folder description'}}));
    });
    const first=await claim(),route=createClassificationAutoTagOutboxRoute(processor(fake.provider));
    await expect(route.handle(first.context)).rejects.toBeInstanceOf(OutboxContinuationRequested);
    expect(await first.repository.continue(first.claimed)).toBe(true);
    const second=await claim();await route.handle(second.context);await second.repository.complete(second.claimed);
    expect(fake.calls()).toBe(2);
    expect((await isolated.runtime.db.selectFrom('collection_classification_tag_jobs').select(['status','recomputations']).where('node_id','=',created.node.id).executeTakeFirstOrThrow()))
      .toMatchObject({status:'applied',recomputations:1});
    expect(await isolated.runtime.db.selectFrom('classification_provider_executions').select('id').where('collection_id','=',input.collectionId).execute()).toHaveLength(2);
  });
  test('a lost outbox lease cannot publish; its successor reuses the known provider result',async()=>{
    const {request}=await seed();const created=await create(request);if(created.kind!=='created')throw new Error('not created');
    const first=await claim();
    const fake=fixtureProvider(async()=>{
      await isolated.runtime.db.updateTable('outbox_events').set({lease_generation:sql`lease_generation+1`,locked_until:sql`clock_timestamp()+interval '30 seconds'`})
        .where('outbox_id','=',first.claimed.outboxId).execute();
    });
    const route=createClassificationAutoTagOutboxRoute(processor(fake.provider));
    await expect(route.handle(first.context)).rejects.toThrow('classification_auto_lease_lost');
    expect((await isolated.runtime.db.selectFrom('nodes').select('tags').where('id','=',created.node.id).executeTakeFirstOrThrow()).tags).toEqual(['manual']);
    await isolated.runtime.db.updateTable('outbox_events').set({state:'pending',locked_until:null}).where('outbox_id','=',first.claimed.outboxId).execute();
    const next=await claim();await route.handle(next.context);await next.repository.complete(next.claimed);
    expect(fake.calls()).toBe(1);
    expect((await isolated.runtime.db.selectFrom('nodes').select('tags').where('id','=',created.node.id).executeTakeFirstOrThrow()).tags).toEqual(['manual','AI']);
  });

  test('unknown provider outcome is terminal across retry and retains reserved cost',async()=>{
    const {request}=await seed();const created=await create(request);if(created.kind!=='created')throw new Error('not created');
    const fake=fixtureProvider(async()=>{throw new Error('response lost after dispatch');});
    const delivery=await claim(),route=createClassificationAutoTagOutboxRoute(processor(fake.provider));
    await expect(route.handle(delivery.context)).rejects.toThrow();
    const job=await isolated.runtime.db.selectFrom('collection_classification_tag_jobs').select(['status','id']).where('node_id','=',created.node.id).executeTakeFirstOrThrow();
    expect(job.status).toBe('outcome_unknown');
    await route.handle(delivery.context);await delivery.repository.complete(delivery.claimed);expect(fake.calls()).toBe(1);
    const attempts=await isolated.runtime.db.selectFrom('classification_call_attempts as a').innerJoin('classification_provider_executions as e','e.id','a.execution_id')
      .select(['a.state','a.reserved_microusd']).where('e.collection_id','=',request.collectionId).execute();
    expect(attempts).toHaveLength(1);expect(attempts[0]?.state).toBe('unknown');expect(Number(attempts[0]?.reserved_microusd)).toBeGreaterThan(0);
  });

});
