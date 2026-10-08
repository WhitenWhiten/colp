import assert from 'node:assert/strict';
import {beforeAll,afterAll,test} from 'vitest';
import {createIsolatedPostgresRuntime,describeWithPostgres,type IsolatedPostgresRuntime} from '../../support/postgres-test-runtime.js';
import {runMigrations} from '../../../src/infrastructure/database/index.js';
import {createPostgresCanonicalMutationUnitOfWork,createPostgresOwnedCollectionsReadPort} from '../../../src/infrastructure/collections/index.js';
import {createProductOwnedCollectionsCursorSigner} from '../../../src/modules/collections/index.js';
import {createPhase4bMcpOwnedCollectionCreateService,callOwnedCollectionsListTool} from '../../../src/modules/mcp/owned-collection-mcp.js';
import {createMcpApplicationContext} from '../../../src/modules/mcp/application-context.js';
const account=Buffer.alloc(16,131).toString('base64url'),subject=Buffer.alloc(16,132).toString('base64url');
const binding={kind:'authenticated' as const,principalId:account,clientId:'audit-client',credentialBindingId:'audit-binding',resourceAudience:'colp://known/collections',securityEpoch:'0'};
const context={binding,accountSubjectId:subject,scope:['nodes:write']};
describeWithPostgres('MCP owned collection contracts',()=>{
 let isolated:IsolatedPostgresRuntime;
 beforeAll(async()=>{isolated=await createIsolatedPostgresRuntime('mcp_reports_audit',{maxConnections:6});await runMigrations(isolated.runtime.db,'latest');
 await isolated.runtime.pool.query("INSERT INTO accounts(id,subject_id,status,security_epoch) VALUES ($1,$2,'active',0)",[account,subject]);
 await isolated.runtime.pool.query("INSERT INTO profiles(account_id,display_name) VALUES ($1,'Audit owner')",[account]);
 },180000);
 afterAll(async()=>isolated?.close());
 test('owned tools expose every bounded page, bind cursors and preserve text content', async () => {
  const service=createPhase4bMcpOwnedCollectionCreateService({unitOfWork:createPostgresCanonicalMutationUnitOfWork(isolated.runtime.db)});
  const callContext=createMcpApplicationContext({principal:binding,scopes:['mcp:read:own'],abortSignal:new AbortController().signal,
   budgets:{maxDepth:10,maxNodes:100,maxBytes:65536,maxOperations:10},correlationId:'owned-pages',authorization:{accountSubjectId:subject}});
  let now = new Date();
  const ports={reads:createPostgresOwnedCollectionsReadPort(isolated.runtime.db),
   cursors:createProductOwnedCollectionsCursorSigner({current:{id:'audit',key:'audit-owned-collections-signing-key'}}),clock:{now:async()=>now}};
  async function read(input: Record<string, unknown> = {}) {
   const result=await callOwnedCollectionsListTool(ports,callContext,input);
   assert.equal(result.kind,'complete'); if(result.kind!=='complete')throw new Error('not complete');
   const output=result.structuredContent as {collections:{id:string}[];page:{hasMore:boolean;nextCursor:string|null;returnedCount:number}};
   assert.deepEqual(JSON.parse((result.content[0] as {text:string}).text),output);
   assert.equal(output.page.returnedCount,output.collections.length);
   return output;
  }
  const empty=await read(); assert.equal(empty.collections.length,0); assert.equal(empty.page.hasMore,false);
  let created=0;
  for(const count of [30,31,101]) {
   while(created<count) await service.execute({title:`Pagination notebook ${created++}`,idempotencyKey:crypto.randomUUID()},context);
   const ids:string[]=[]; let cursor:string|null=null;
   do {
    const output=await read(cursor?{cursor}:{}); ids.push(...output.collections.map(item=>item.id));
    assert.ok(output.collections.length<=30); assert.equal(output.page.hasMore,output.page.nextCursor!==null);
    cursor=output.page.nextCursor;
   } while(cursor);
   assert.equal(ids.length,count); assert.equal(new Set(ids).size,count);
  }
  const first=await read({limit:10}); assert.equal(first.collections.length,10);
  await assert.rejects(read({limit:10,cursor:first.page.nextCursor}));
  const other=createMcpApplicationContext({principal:binding,scopes:['mcp:read:own'],abortSignal:new AbortController().signal,
   budgets:{maxDepth:10,maxNodes:100,maxBytes:65536,maxOperations:10},correlationId:'other',authorization:{accountSubjectId:'other-subject'}});
  await assert.rejects(callOwnedCollectionsListTool(ports,other,{cursor:first.page.nextCursor}));
  now=new Date(now.getTime()+86400000);
  await assert.rejects(read({cursor:first.page.nextCursor}));
 });
 test('intent keys distinguish same-content creates and replay concurrent retries without duplicate writes', async () => {
  const service=createPhase4bMcpOwnedCollectionCreateService({unitOfWork:createPostgresCanonicalMutationUnitOfWork(isolated.runtime.db)});
  const input={title:'Independent identical notebooks',idempotencyKey:crypto.randomUUID()};
  const first=await service.execute(input,context);
  assert.deepEqual(await service.execute(input,context),first);
  await assert.rejects(service.execute({...input,title:'changed content'},context));
  const second=await service.execute({...input,idempotencyKey:crypto.randomUUID()},context);
  assert.notEqual(first.collectionId,second.collectionId);
  const retryInput={title:'Concurrent retry notebook',idempotencyKey:crypto.randomUUID()};
  const attempts=await Promise.allSettled([service.execute(retryInput,context),service.execute(retryInput,context)]);
  const successful=attempts.filter(item=>item.status==='fulfilled'); assert.ok(successful.length>=1);
  const replay=await service.execute(retryInput,context);
  for(const outcome of successful) if(outcome.status==='fulfilled')assert.equal(outcome.value.collectionId,replay.collectionId);
  const count=await isolated.runtime.pool.query('select count(*)::int as count from collections where title=$1',[retryInput.title]);
  assert.equal(count.rows[0].count,1);
  const client=await isolated.runtime.pool.connect();
  try {
   await client.query('begin');
   await client.query('update nodes set deleted_at=now() where collection_id=$1',[first.collectionId]);
   await client.query('update collections set deleted_at=now() where id=$1',[first.collectionId]);
   await client.query('commit');
  } catch(error) { await client.query('rollback'); throw error; } finally { client.release(); }
  const third=await service.execute({...input,idempotencyKey:crypto.randomUUID()},context);
  assert.notEqual(third.collectionId,first.collectionId);
 });

});
