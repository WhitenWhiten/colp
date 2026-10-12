import { mountCaptureProductFixture } from './capture-product-stack.js';
import { createClassificationSecretProtector } from '../../server/src/infrastructure/security/classification-secret-envelope.js';
import { createPostgresClassificationProfilesRuntime } from '../../server/src/infrastructure/collections/classification-profiles-runtime.js';
import { createProfileAwareClassificationProvider } from '../../server/src/infrastructure/collections/classification-profile-provider.js';
import { createCloudflareJevClassificationProvider, createCloudflareUpstream } from '../../server/src/infrastructure/collections/classification-provider-cloudflare-jev.js';
import { registerClassificationProfileRoutes } from '../../server/src/transport/product/classification-profile-routes.js';
import { SYNTHETIC_PIPELINE_CALIBRATION, SYNTHETIC_DEPLOYMENT_IDENTITY } from '../../server/tests/support/classification-auto-calibration.js';
import { createPostgresClassificationAutoTagProcessor } from '../../server/src/infrastructure/collections/classification-auto-tag-process.js';
import { PostgresOutboxRepository } from '../../server/src/infrastructure/outbox/repository.js';
import { CLASSIFICATION_AUTO_TAG_HANDLER } from '../../server/src/infrastructure/outbox/classification-auto-tag.js';
import { createHash, randomUUID } from 'node:crypto';
import { classificationSettingsEtag, updateClassificationSettings, updateCollectionNode } from '../../server/src/modules/collections/index.js';
import { createPostgresClassificationConfirmationUnitOfWork } from '../../server/src/infrastructure/collections/classification-confirmation-postgres.js';
import { registerClassificationConfirmationRoutes } from '../../server/src/transport/product/classification-confirmation-routes.js';
import type { BookmarkClassificationProvider } from '../../server/src/modules/collections/index.js';
import { createPostgresClassificationSettingsRuntime } from '../../server/src/infrastructure/collections/classification-settings-postgres.js';
import { registerClassificationSettingsRoutes } from '../../server/src/transport/product/classification-settings-routes.js';
import type { FastifyInstance } from '../../server/node_modules/fastify/fastify.js';
import { sql } from '../../server/node_modules/kysely/dist/index.js';
import { loadConfig } from '../../server/src/bootstrap/config.js';
import type { DatabaseRuntime } from '../../server/src/infrastructure/database/index.js';
import type { BrowserSessionAuthority } from '../../server/src/modules/auth/index.js';
import { createPostgresAccountCreditsPort, createCreditUnitOfWork, createPostgresCreditLedgerReadPort, createPostgresIdentityUnitOfWork } from '../../server/src/infrastructure/identity/index.js';
import { createCreditLedgerCursorCodec } from '../../server/src/modules/identity/index.js';
import { createPostgresClassificationRuntime } from '../../server/src/infrastructure/collections/classification-runtime.js';
import { createBookmarkClassificationProvider } from '../../server/src/infrastructure/collections/classification-provider-factory.js';
import { registerSessionMeRoutes } from '../../server/src/transport/auth/browser-auth-handlers.js';
import { installClassificationExtensionCors, classificationProductAllowedOrigins } from '../../server/src/transport/classification-extension-cors.js';
import { registerClassificationPreviewRoutes } from '../../server/src/transport/product/classification-preview-routes.js';
import { installProductAdmission } from '../../server/src/transport/product-admission.js';
import { createFixedWindowRateLimiter } from '../../server/src/transport/http-security.js';
import { sendProductError, ProductHttpError } from '../../server/src/transport/product-error.js';
import { registerCreditLedgerRoutes } from '../../server/src/transport/product/credit-ledger-routes.js';
import { externalBackendOrigin, pointExtensionBuildConfig, skippedInProcessProductStack } from './external-backend.js';
import type { ClassificationProductFixture, ClassificationProductObservation } from './cloud-product-fixtures.js';

// Know-N backend only: loaded through loadClassificationProductStack() in cloud-product-fixtures.ts.
export function mountClassificationProductFixture(app:FastifyInstance,database:DatabaseRuntime,authority:BrowserSessionAuthority,extensionOrigin:string,syntheticCapture = false): ClassificationProductFixture {
  // create-user via the server CLI is a precondition; see external-backend.ts.
  const origin = externalBackendOrigin();
  if (origin) {
    pointExtensionBuildConfig(origin);
    return skippedInProcessProductStack('classification-product-stack');
  }
  const base=loadConfig({KNOWN_FEATURE_EXPORT_JOBS:'false',NODE_ENV:'test',DATABASE_URL:'postgres://fixture/unused',PRODUCT_ORIGIN:'https://known.example',ALLOWED_ORIGINS:'https://known.example',
    OIDC_ISSUER:'https://identity.known.example',OIDC_CLIENT_ID:'fixture',OIDC_REDIRECT_URI:'https://known.example/api/v1/auth/oidc/callback',
    OIDC_AUTHORIZATION_ENDPOINT:'https://identity.known.example/authorize',OIDC_TOKEN_ENDPOINT:'https://identity.known.example/token',
    OIDC_ALLOW_TEST_PROVIDER:'true',OIDC_TEST_PROVIDER_HMAC_SECRET:'test-classification-fixture-not-production'});
  const config={...base,betterAuth:{...base.betterAuth,enabled:true,trustedOrigins:[extensionOrigin,'https://known.example']}};
  const identityUnitOfWork=createPostgresIdentityUnitOfWork(database.db);
  const settingsRuntime=createPostgresClassificationSettingsRuntime(database.db);
  const setAutoTagMode=async(collectionId:string,autoTagMode:'suggest'|'auto')=>{
    const owner=await database.db.selectFrom('collections as c').innerJoin('accounts as a','a.subject_id','c.owner_subject_id')
      .select(['a.id as principalId','a.subject_id as subjectId']).where('c.id','=',collectionId).executeTakeFirstOrThrow();
    return settingsRuntime.commands.execute(async ports=>{
      const current=await ports.settings.loadOwned({collectionId,ownerSubjectId:owner.subjectId});
      if(!current)throw new Error('classification_settings_missing');
      return updateClassificationSettings(ports,{actor:owner,collectionId,commandId:randomUUID(),
        ifMatch:classificationSettingsEtag(current),patch:{autoTagMode},v2:true,autoEnabled:true});
    });
  };
  const creditLedgerCursor=createCreditLedgerCursorCodec({active:{id:'fixture-credits-v1',secret:Buffer.alloc(32,0x52).toString('base64')},retained:[]});
  const observations:ClassificationProductObservation[]=[];
  const localCalls:{host:string;cookie:boolean;input:unknown}[]=[];
  let serverProviderCalls=0;const providerInputHashes:string[]=[];
  const recordInput=(input:unknown)=>{providerInputHashes.push(createHash('sha256').update(JSON.stringify(input)).digest('hex'));};
  const fixtureResponse=(body:{input:{questions:Record<string,{type:string;criteria:Record<string,string>}>}})=>{
    recordInput(body.input);
    const answers=Object.fromEntries(Object.entries(body.input.questions).map(([key,question])=>{
      const keys=Object.keys(question.criteria);return [key,question.type==='noul'?{noul:0.99}:{choice:keys[0],confidence:1,probabilities:Object.fromEntries(keys.map((id,index)=>[id,index===0?1:0]))}];
    }));return {model:'jev-1.13.0',answers,usage:{input_tokens:1,output_tokens:0}};
  };
  app.post('/client/v4/accounts/:accountId/ai/run',async(request)=>{
    const body=request.body as Parameters<typeof fixtureResponse>[0];localCalls.push({host:request.hostname,cookie:Boolean(request.headers.cookie),input:body.input});
    return fixtureResponse(body);
  });
  let holdProvider = false, providerHeld = false, releaseProvider: (() => void) | undefined;
  const fixtureTransport:typeof fetch=async(_url,init)=>{serverProviderCalls++;
    if (holdProvider) { holdProvider = false; providerHeld = true; await new Promise<void>(resolve => { releaseProvider = resolve; }); providerHeld = false; }
    return Response.json(fixtureResponse(JSON.parse(String(init?.body))));};
  let holdApply = false, applyHeld = false, releaseApply: (() => void) | undefined;
  app.addHook('onSend',async(request,_reply,payload)=>{
    if (holdApply && request.url.includes('/capture-decisions/') && request.url.endsWith('/apply')) {
      holdApply = false; applyHeld = true; await new Promise<void>(resolve => { releaseApply = resolve; }); applyHeld = false;
    }
    return payload;
  });
  app.decorate('browserSessionAuthority',authority);
  installProductAdmission(app);
  installClassificationExtensionCors(app,config);
  registerCreditLedgerRoutes(app,{creditEnabled:true,identityUnitOfWork,reads:createPostgresCreditLedgerReadPort(database.db),cursor:creditLedgerCursor,
    rateLimiter:createFixedWindowRateLimiter({maxRequests:100,windowMs:60000})});
  app.setErrorHandler((error,request,reply)=>{
    if(request.url.startsWith('/api/v1/session')||request.url.startsWith('/api/v1/me/credits') || request.url.includes('/capture-') || request.url.includes('/bookmark-captures')||(request.url.includes('/classification/')||request.url.endsWith('/classification-confirmations')))return sendProductError(request,reply,error instanceof ProductHttpError?error:new ProductHttpError({statusCode:500,code:'internal_error',message:'Fixture Product error.'}));
    return reply.send(error);
  });
  app.addHook('onResponse',async(request,reply)=>{
    const path=request.url.split('?',1)[0]!;
    if(path==='/api/v1/session'||path.includes('/capture-')||path.includes('/bookmark-captures')||(path.includes('/classification/')||path.endsWith('/classification-confirmations')))observations.push({path,origin:request.headers.origin??null,
      cookie:typeof request.headers.cookie==='string',bearer:typeof request.headers.authorization==='string',csrf:typeof request.headers['x-csrf-token']==='string',status:reply.statusCode});
  });
  registerSessionMeRoutes(app,{config,identityUnitOfWork,browserSessionAuthority:authority});
  registerClassificationSettingsRoutes(app,{enabled:true,byokEnabled:true,allowedOrigins:classificationProductAllowedOrigins(config),identityUnitOfWork,
    ...settingsRuntime,rateLimiter:createFixedWindowRateLimiter({maxRequests:100,windowMs:60000})});
  const unavailable=createBookmarkClassificationProvider(null);let providerAvailable=false;
  const adapter=createCloudflareJevClassificationProvider(createCloudflareUpstream({accountId:'a'.repeat(32),gatewayId:'default',accessKey:'managed-fixture-secret',expectedModelVersion:'jev-1.13.0'}),fixtureTransport);
  const managed:BookmarkClassificationProvider={...unavailable,classify:(input,execution)=>providerAvailable?adapter.classify(input,execution):unavailable.classify(input,execution)};
  const protector=createClassificationSecretProtector([{id:'fixture',version:1,key:Buffer.alloc(32,1)}],Buffer.alloc(32,2));
  const profiles=createPostgresClassificationProfilesRuntime(database.db,protector,{enabled:()=>true,transport:fixtureTransport});
  const provider=createProfileAwareClassificationProvider(database.db,managed,protector,{enabled:()=>true,transport:fixtureTransport});
  registerClassificationProfileRoutes(app,{enabled:true,allowedOrigins:classificationProductAllowedOrigins(config),identityUnitOfWork,runtime:profiles,
    rateLimiter:createFixedWindowRateLimiter({maxRequests:100,windowMs:60000})});
  app.addHook('onReady',async()=>profiles.start());app.addHook('onClose',async()=>profiles.stop());
  const runtime=createPostgresClassificationRuntime(database.db,provider,{enabled:true,tagsEnabled:true,creditEnabled:true,
    credits:(transaction,accountId)=>createPostgresAccountCreditsPort(transaction,accountId),onError:()=>{},cancelBackend:database.cancelBackend});
  registerClassificationPreviewRoutes(app,{enabled:true,allowedOrigins:classificationProductAllowedOrigins(config),identityUnitOfWork,runtime,
    rateLimiter:createFixedWindowRateLimiter({maxRequests:100,windowMs:60000})});
  registerClassificationConfirmationRoutes(app,{enabled:true,allowedOrigins:classificationProductAllowedOrigins(config),identityUnitOfWork,
    commands:createPostgresClassificationConfirmationUnitOfWork(database.db),
    rateLimiter:createFixedWindowRateLimiter({maxRequests:100,windowMs:60000})});
  app.addHook('onReady',async()=>runtime.start());app.addHook('onClose',async()=>runtime.stop());
  const capture = mountCaptureProductFixture(app, database, runtime, classificationProductAllowedOrigins(config), syntheticCapture);
  return {
    capture,
    holdNextProvider: () => { holdProvider = true; }, providerHeld: () => providerHeld, releaseProvider: () => releaseProvider?.(),
    holdNextCaptureApply: () => { holdApply = true; }, captureApplyHeld: () => applyHeld, releaseCaptureApply: () => releaseApply?.(),
    providerInputHashes:()=>[...providerInputHashes],
    providerCallCount:()=>serverProviderCalls+localCalls.length,
    localCalls:()=>localCalls.map(call=>({...call})),
    observations:()=>observations.map(row=>({...row})),
    setProviderAvailable:()=>{providerAvailable=true;},
    async seedTags(collectionId:string){
      const bookmarks=await database.db.selectFrom('nodes').select('url').where('collection_id','=',collectionId).where('kind','=','bookmark').where('deleted_at','is',null).execute();
      for(const bookmark of bookmarks)if(bookmark.url)await this.editBookmark(bookmark.url,['AI'],'Vocabulary seed');
      await setAutoTagMode(collectionId,'suggest');
    },
    async editBookmark(url:string,tags:readonly string[],description:string){
      const row=await database.db.selectFrom('nodes as n').innerJoin('collections as c','c.id','n.collection_id')
        .innerJoin('accounts as a','a.subject_id','c.owner_subject_id')
        .select(['n.id','n.collection_id','n.resource_revision','a.id as accountId','a.subject_id'])
        .where('n.url','=',url).where('n.deleted_at','is',null).executeTakeFirstOrThrow();
      const patch={tags,description};
      return createPostgresClassificationConfirmationUnitOfWork(database.db).execute(({collection})=>
        updateCollectionNode(collection,{actor:{principalId:row.accountId,subjectId:row.subject_id,principalType:'account'},
          collectionId:row.collection_id,nodeId:row.id,ifMatch:`"${row.resource_revision}"`,patch,
          command:{commandId:randomUUID(),fingerprint:createHash('sha256').update(JSON.stringify(patch)).digest('hex')}}));
    },
    async enableAutoTags(collectionId:string){
      await setAutoTagMode(collectionId,'auto');
    },
    async drainAutoTags(){
      // Controlled synthetic pipeline proof only: production calibration remains null/disabled.
      const processor=createPostgresClassificationAutoTagProcessor(database.db,provider,{enabled:()=>true,metric:()=>{},
        identity:SYNTHETIC_DEPLOYMENT_IDENTITY,calibration:()=>SYNTHETIC_PIPELINE_CALIBRATION});
      // Projection delivery is independently driven by this E2E stack; lease only the auto family here.
      await sql`UPDATE outbox_events SET state='completed',completed_at=clock_timestamp() WHERE handler_name<>${CLASSIFICATION_AUTO_TAG_HANDLER}`.execute(database.db);
      const repository=new PostgresOutboxRepository(database.pool);const claim=await repository.claim(30000);
      if(!claim)return false;
      if(claim.handlerName!==CLASSIFICATION_AUTO_TAG_HANDLER)throw new Error('unexpected auto fixture claim');
      await processor((claim.payload as {jobId:string}).jobId,{signal:new AbortController().signal,
        attempt:{outboxId:claim.outboxId,leaseGeneration:claim.leaseGeneration},idempotencyKey:claim.eventId,
        envelope:{event_id:claim.eventId,event_type:claim.eventType,event_version:claim.eventVersion,aggregate_identity:{aggregate_type:claim.aggregateType,
          aggregate_id:claim.aggregateId,aggregate_scope:claim.aggregateScope},aggregate_revision:claim.aggregateRevision,commit_ordinal:claim.commitOrdinal,
          occurred_at:claim.occurredAt.toISOString(),payload:claim.payload as {jobId:string}}});
      await repository.complete(claim);return true;
    },
    async readTags(url:string){
      return (await sql<{tags:string[]}>`SELECT coalesce(tags,'[]'::jsonb) AS tags FROM nodes WHERE url=${url} AND deleted_at IS NULL`.execute(database.db)).rows;
    },
    async ageSessions(){await sql`UPDATE known_auth_session_metadata SET created_at=clock_timestamp()-interval '1 day' WHERE revoked_at IS NULL`.execute(database.db);},
    async fundClassification(collectionId:string){
      const account=await database.db.selectFrom('collections as c').innerJoin('accounts as a','a.subject_id','c.owner_subject_id')
        .select('a.id as accountId').where('c.id','=',collectionId).executeTakeFirstOrThrow();
      const schema=(await sql<{name:string}>`SELECT current_schema() AS name`.execute(database.db)).rows[0]?.name;
      if(!schema)throw new Error('fixture_schema_missing');
      const now=new Date();
      await sql`SELECT * FROM ${sql.id(schema)}.credit_grant_credits(${account.accountId},'mv3-classification-funding',20,
        ${now},${new Date(now.getTime()+86_400_000)},'operator','manual_grant','MV3 classification fixture')`.execute(database.db);
    },
    async seedCreditLedger(collectionId:string){
      const account=await database.db.selectFrom('collections as c').innerJoin('accounts as a','a.subject_id','c.owner_subject_id')
        .select('a.id as accountId').where('c.id','=',collectionId).executeTakeFirstOrThrow();
      const schema=(await sql<{name:string}>`SELECT current_schema() AS name`.execute(database.db)).rows[0]?.name;
      if(!schema)throw new Error('fixture_schema_missing');
      const creditSchema=sql.id(schema);
      const now=new Date();const firstExpiresAt=new Date(now.getTime()+60_000);const expiresAt=new Date(now.getTime()+2_000);
      await sql`SELECT * FROM ${creditSchema}.credit_grant_credits(${account.accountId},'mv3-ledger-grant',5,${now},${firstExpiresAt},'operator','manual_grant','MV3 fixture')`.execute(database.db);
      await sql`SELECT * FROM ${creditSchema}.credit_grant_credits(${account.accountId},'mv3-ledger-expiring',2,${now},${expiresAt},'operator','trial_grant','MV3 fixture')`.execute(database.db);
      const chargeId=randomUUID();
      await createCreditUnitOfWork(database.db).execute(async transaction=>{
        const credits=createPostgresAccountCreditsPort(transaction,account.accountId);await credits.lock();
        await credits.reserve({chargeId,operationKey:'mv3-ledger-reserve',fingerprint:'mv3-ledger-reserve-v1',amount:1,source:'extension',priceVersion:'bookmark-classify.v1',ownerKind:'classification_preview',ownerId:chargeId,
          task:{kind:'classification_preview',collectionId,nodeId:null,runId:null,actionId:null},deadlineAt:new Date(now.getTime()+60_000).toISOString()});
        await credits.settle(chargeId);
      });
      await sql`SELECT * FROM ${creditSchema}.credit_refund_charge(${account.accountId},'mv3-ledger-refund',${chargeId}::uuid,1,${firstExpiresAt},'MV3 fixture')`.execute(database.db);
      await createCreditUnitOfWork(database.db).execute(async transaction=>{
        const credits=createPostgresAccountCreditsPort(transaction,account.accountId);await credits.lock();
        await credits.reconcile(new Date(now.getTime()+5_000).toISOString());
      });
      const rows=await database.db.selectFrom('credit_ledger_entries').select(['id','sequence','charge_id as chargeId'])
        .where('account_id','=',account.accountId).orderBy('sequence','asc').execute();
      return {accountId:account.accountId,chargeId,entryIds:rows.map(row=>row.id),entryCount:rows.length};
    },
    async expireAllCredits(collectionId:string){
      const account=await database.db.selectFrom('collections as c').innerJoin('accounts as a','a.subject_id','c.owner_subject_id')
        .select('a.id as accountId').where('c.id','=',collectionId).executeTakeFirstOrThrow();
      const schema=(await sql<{name:string}>`SELECT current_schema() AS name`.execute(database.db)).rows[0]?.name;
      if(!schema)throw new Error('fixture_schema_missing');
      await createCreditUnitOfWork(database.db).execute(async transaction=>{
        const credits=createPostgresAccountCreditsPort(transaction,account.accountId);await credits.lock();
        await credits.reconcile(new Date(Date.now()+86_400_000).toISOString());
      });
      return account.accountId;
    },
  };
}
