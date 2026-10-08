import {randomUUID} from 'node:crypto';
import {sql} from 'kysely';
import {beforeAll,afterAll,test,expect} from 'vitest';
import {runMigrations} from '../../../src/infrastructure/database/index.js';
import {createIsolatedPostgresRuntime,describeWithPostgres,type IsolatedPostgresRuntime} from '../../support/postgres-test-runtime.js';
import {seedCanonicalClassificationFixture} from '../../support/classification-database-fixture.js';
import {createCollectionNode,deleteCollectionNode,acceptClassifyInboxItem,confirmCollectionBookmarkClassification,CLASSIFICATION_HOSTNAME_PRIOR_POLICY_VERSION,
  type BookmarkClassificationProvider} from '../../../src/modules/collections/index.js';
import {createPostgresClassificationConfirmationUnitOfWork} from '../../../src/infrastructure/collections/classification-confirmation-postgres.js';
import {createPostgresClassifyInboxAcceptUnitOfWork} from '../../../src/infrastructure/collections/classify-inbox-accept-postgres.js';
import {createPostgresClassificationTaxonomyReadPort} from '../../../src/infrastructure/collections/classification-taxonomy-read.js';
import {createPostgresClassificationRuntime} from '../../../src/infrastructure/collections/classification-runtime.js';
import {createBookmarkClassificationProvider} from '../../../src/infrastructure/collections/classification-provider-factory.js';
import {readClassificationHostnameEvidence,pruneClassificationEvidence} from '../../../src/infrastructure/collections/classification-evidence-postgres.js';
import {createUnitOfWork} from '../../../src/infrastructure/database/unit-of-work.js';
describeWithPostgres('CLF-02 explicit hostname evidence',()=>{
  let isolated:IsolatedPostgresRuntime;
  beforeAll(async()=>{isolated=await createIsolatedPostgresRuntime('clf_evidence',{maxConnections:6});await runMigrations(isolated.runtime.db,'latest');},180000);
  afterAll(async()=>isolated?.close());
  async function fixture(){
    const input=await seedCanonicalClassificationFixture(isolated.runtime),actor={principalId:input.collectionId,subjectId:input.ownerSubjectId};
    const canonical=createPostgresClassificationConfirmationUnitOfWork(isolated.runtime.db),accept=createPostgresClassifyInboxAcceptUnitOfWork(isolated.runtime.db);
    async function bookmark(index:number){
      const result=await canonical.execute(({collection})=>createCollectionNode(collection,{actor:{...actor,principalType:'account'},collectionId:input.collectionId,parentId:input.root,
        command:{commandId:randomUUID(),fingerprint:`evidence-create-${index}`},afterId:null,beforeId:null,
        node:{kind:'bookmark',title:`Explicit choice ${index}`,url:`https://WWW.Example.ORG./evidence/${index}`,description:null,tags:[],visibility:'inherit'}}));
      if(result.kind!=='created')throw new Error('missing bookmark');return result.node;
    }
    const rows=()=>isolated.runtime.db.selectFrom('collection_classification_evidence').selectAll().where('collection_id','=',input.collectionId).execute();
    return {input,actor,canonical,accept,bookmark,rows};
  }
  test('create/confirmation/preview write no evidence; explicit Accept is atomic and replay does not double count',async()=>{
    const f=await fixture(),node=await f.bookmark(1);expect(await f.rows()).toHaveLength(0);
    const confirmed=await f.canonical.execute(ports=>confirmCollectionBookmarkClassification(ports,{actor:f.actor,collectionId:f.input.collectionId,nodeId:node.id,
      commandId:randomUUID(),ifMatch:node.etag,document:{folderId:null,addTags:['AI']}}));
    if(confirmed.kind!=='succeeded')throw new Error('missing confirmation');expect(await f.rows()).toHaveLength(0);
    const updated=await isolated.runtime.db.selectFrom('nodes').select('resource_revision').where('id','=',node.id).executeTakeFirstOrThrow();
    const intent={actor:f.actor,nodeId:node.id,commandId:randomUUID(),ifMatch:`"${updated.resource_revision}"`,body:{suggestionId:f.input.folderId}};
    await f.accept.execute(ports=>acceptClassifyInboxItem(ports,intent));await f.accept.execute(ports=>acceptClassifyInboxItem(ports,intent));
    expect(await f.rows()).toHaveLength(1);expect((await f.rows())[0]).toMatchObject({hostname:'example.org',folder_id:f.input.folderId,source:'classify_accept',command_id:intent.commandId});
    const next=await f.bookmark(2),rollback={...intent,nodeId:next.id,commandId:randomUUID(),ifMatch:next.etag};
    await expect(f.accept.execute(async ports=>{await acceptClassifyInboxItem(ports,rollback);throw new Error('rollback_evidence');})).rejects.toThrow('rollback_evidence');
    expect(await f.rows()).toHaveLength(1);
    expect((await isolated.runtime.db.selectFrom('nodes').select('parent_id').where('id','=',next.id).executeTakeFirstOrThrow()).parent_id).toBe(f.input.root);
  });
  test('owned live evidence is isolated, frozen in preview and only reorders ties under a distinct policy version',async()=>{
    const f=await fixture();
    for(let index=0;index<5;index++){const node=await f.bookmark(index);await f.accept.execute(ports=>acceptClassifyInboxItem(ports,{actor:f.actor,nodeId:node.id,commandId:randomUUID(),ifMatch:node.etag,body:{suggestionId:f.input.folderId}}));}
    const reads=createPostgresClassificationTaxonomyReadPort(isolated.runtime.db,{priorEnabled:true});
    const snapshot=await reads.loadSnapshot({collectionId:f.input.collectionId,ownerSubjectId:f.input.ownerSubjectId,bookmarkUrl:'https://example.org/new'});
    expect(snapshot?.hostnameEvidence).toMatchObject([{hostname:'example.org',folderId:f.input.folderId,acceptedCount:5,rejectedCount:null}]);
    const other=await fixture();expect(await createUnitOfWork(isolated.runtime.db).execute(({transaction})=>readClassificationHostnameEvidence(transaction,{collectionId:other.input.collectionId,
      ownerSubjectId:other.input.ownerSubjectId,taxonomyRevision:'any',urls:['https://example.org/new']}))).toEqual([]);
    expect(await reads.loadSnapshot({collectionId:f.input.collectionId,ownerSubjectId:other.input.ownerSubjectId,bookmarkUrl:'https://example.org/new'})).toBeNull();
    const base=createBookmarkClassificationProvider(null),provider:BookmarkClassificationProvider={...base,policyVersion:CLASSIFICATION_HOSTNAME_PRIOR_POLICY_VERSION,async classify(context,execution){
      const answer={folderId:null,confidence:0.1,probabilities:[{folderId:null,probability:0.5},{folderId:f.input.folderId,probability:0.5}]};
      await execution.calls.run('l1',0,{},async()=>({answer,modelVersion:'fixture',inputTokens:0,outputTokens:0}));
      return {l1:answer,l2:null,tags:[],candidateCoverage:context.candidates!.coverage,modelVersion:'fixture'};
    }};
    const runtime=createPostgresClassificationRuntime(isolated.runtime.db,provider,{enabled:true,tagsEnabled:true,priorEnabled:true,onError:()=>{}});
    try{
      const result=await runtime.preview({actor:f.actor,collectionId:f.input.collectionId,commandId:randomUUID(),requestId:'prior-preview',document:{source:'web',bookmark:{title:'New',url:'https://example.org/new',description:null},requested:{folder:true,tags:false}}});
      if(result.kind!=='replay')throw new Error('missing preview');expect(result.result.status).toBe(200);
      const body=JSON.parse(Buffer.from(result.result.body).toString());expect(body.folder).toMatchObject({decision:'later',folderId:null,confidence:0.1});
      expect(body.folder.probabilities[0].folderId).toBe(f.input.folderId);expect(body.provider.policyVersion).toBe(CLASSIFICATION_HOSTNAME_PRIOR_POLICY_VERSION);expect(await f.rows()).toHaveLength(5);
    }finally{await runtime.stop();}
    const folder=await isolated.runtime.db.selectFrom('nodes').select('resource_revision').where('id','=',f.input.folderId).executeTakeFirstOrThrow();
    const collection=await isolated.runtime.db.selectFrom('collections').select('content_revision').where('id','=',f.input.collectionId).executeTakeFirstOrThrow();
    await f.canonical.execute(({collection:ports})=>deleteCollectionNode(ports,{actor:{...f.actor,principalType:'account'},collectionId:f.input.collectionId,nodeId:f.input.folderId,
      command:{commandId:randomUUID(),fingerprint:'delete-evidence-folder'},ifMatch:`"${folder.resource_revision}"`,recursive:true,ifContentMatch:`"${collection.content_revision}"`}));
    expect(await createUnitOfWork(isolated.runtime.db).execute(({transaction})=>readClassificationHostnameEvidence(transaction,{collectionId:f.input.collectionId,ownerSubjectId:f.input.ownerSubjectId,taxonomyRevision:'any',urls:['https://example.org/new']}))).toEqual([]);
  });
  test('retention removes old private host evidence without changing command receipts',async()=>{
    const f=await fixture(),node=await f.bookmark(0),intent={actor:f.actor,nodeId:node.id,commandId:randomUUID(),ifMatch:node.etag,body:{suggestionId:f.input.folderId}};
    await f.accept.execute(ports=>acceptClassifyInboxItem(ports,intent));
    await sql`UPDATE collection_classification_evidence SET created_at=clock_timestamp()-interval '181 days' WHERE collection_id=${f.input.collectionId}`.execute(isolated.runtime.db);
    await pruneClassificationEvidence(isolated.runtime.db);expect(await f.rows()).toHaveLength(0);
    expect((await f.accept.execute(ports=>acceptClassifyInboxItem(ports,intent))).kind).toBe('replay');expect(await f.rows()).toHaveLength(0);
  });
});
