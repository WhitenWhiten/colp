import { assertClassificationProfileBinding } from './classification-profile-provider.js';
import { randomUUID } from 'node:crypto';
import { sql,type Kysely } from 'kysely';
import { assertCanonicalCommandId,canonicalCommandFingerprint,canonicalJson,type ProductCommandResult } from '../../modules/commands/index.js';
import { CLASSIFICATION_POLICY,ClassificationError,ClassificationProviderError,NodeConflictError,CollectionPreconditionError,ClassificationRunConflictError,
  parseClassificationRunCreate,type BookmarkClassificationProvider,type ClassificationRun,type ClassificationRunRuntime } from '../../modules/collections/index.js';
import type { DatabaseSchema } from '../database/runtime.js';
import { createUnitOfWork,type DatabaseTransaction,type UnitOfWorkOptions } from '../database/unit-of-work.js';
import { createPostgresProductCommandReceiptPort } from '../database/product-command-receipt.js';
import { createClassificationCanonicalPorts } from './classification-canonical-ports.js';
import { createPostgresClassificationSettingsStore } from './classification-settings-postgres.js';
import { readClassificationRunSnapshot } from './classification-run-snapshot.js';
import { classificationRunDto,classificationRunEtag,readClassificationRunRow } from './classification-run-records.js';
import { createClassificationRunUnitOfWork, lockRunCredits, lockedCreditsAsOf, finishActionCharge, fenceActionExecution, lockActionReceipts, type ClassificationRunBillingOptions } from './classification-run-billing.js';
import { CLASSIFICATION_CREDIT_PRICE, CreditError, checkClassificationCreditConsent } from '../../modules/identity/index.js';
import { createClassificationCreditTransactions, mapClassificationCreditError, reconcileClassificationCredits } from './classification-credit-transactions.js';

export function classificationRunReceipt(run:ClassificationRun,status=200,collectionId?:string):ProductCommandResult {
  return {status,mediaType:'application/json',contractVersion:'1.0.0',body:Buffer.from(canonicalJson(run)),
    stableHeaders:{'content-type':'application/json; charset=utf-8','cache-control':'private, no-store',etag:run.etag,
      ...(status===201?{location:`/api/v1/collections/${encodeURIComponent(collectionId!)}/classification-runs/${encodeURIComponent(run.runId)}`}:{})}};
}
async function assertOwned(tx:DatabaseTransaction,collectionId:string,ownerSubjectId:string){
  const row=await tx.selectFrom('collections').select('id').where('id','=',collectionId).where('owner_subject_id','=',ownerSubjectId)
    .where('deleted_at','is',null).executeTakeFirst();if(!row)throw new ClassificationError('resource_not_found');
}
function runBillingMode(snapshot:Awaited<ReturnType<typeof readClassificationRunSnapshot>>,creditEnabled:boolean):'managed'|'byok'|'legacy_free'{
  return snapshot.taxonomy.settings.executionMode==='server_byok'?'byok':creditEnabled?'managed':'legacy_free';
}
function creditFailureReceipt(requestId:string,error:CreditError):ProductCommandResult{
  const status=error.code==='billing_consent_required'?422:['credit_price_changed','credit_limit_exceeded','insufficient_credits'].includes(error.code)?409:503;
  const body={error:{code:error.code,message:'Classification batch credit admission was refused.',requestId,
    recovery:status===503?'same_request':'user_action',sameRequestRetrySafe:status===503,precondition:null,currentEtag:null,
    retryAfterSeconds:status===503?1:null,fieldErrors:[],...(error.creditContext?{creditContext:error.creditContext}:{})}};
  return {status,contractVersion:'1.0.0',mediaType:'application/json',stableHeaders:{'content-type':'application/json; charset=utf-8','cache-control':'private, no-store'},body:Buffer.from(JSON.stringify(body))};
}
export function createClassificationRunCommands(db:Kysely<DatabaseSchema>,provider:BookmarkClassificationProvider,
  options:Pick<UnitOfWorkOptions,'cancelBackend'|'faultInjector'>&{readonly idGenerator?:()=>string;readonly priorEnabled?:boolean}&ClassificationRunBillingOptions={}):Pick<ClassificationRunRuntime,'create'|'get'|'cancel'>{
  return {
    async create(input){
      const document=parseClassificationRunCreate(input.document),commandId=assertCanonicalCommandId(input.commandId);
      const binding={principalId:input.actor.principalId,commandScope:'collections:classification-run-create:v1',commandId};
      const fingerprint=canonicalCommandFingerprint({method:'POST',route:`/api/v1/collections/${input.collectionId}/classification-runs`,mediaType:'application/json',body:input.document});
      const signal=AbortSignal.timeout(2000);
      // Replay before mutable selectors/snapshot reads, even after the run payload TTL.
      const prior=await createClassificationRunUnitOfWork(db,options).execute(async({transaction:tx})=>{
        const account=await tx.selectFrom('accounts').select(['id','status','deleted_at']).where('id','=',input.actor.principalId)
          .where('subject_id','=',input.actor.subjectId).forShare().executeTakeFirst();
        if(!account||account.status!=='active'||account.deleted_at!==null)throw new ClassificationError('resource_not_found');
        await assertOwned(tx,input.collectionId,input.actor.subjectId);
        if(options.credits)await options.credits(tx,input.actor.principalId).lock();
        const row=await tx.selectFrom('product_command_receipts').select('command_id').where('principal_id','=',binding.principalId)
          .where('command_scope','=',binding.commandScope).where('command_id','=',binding.commandId).executeTakeFirst();
        if(!row)return null;
        const claim=await createPostgresProductCommandReceiptPort(tx).claim(binding,fingerprint);
        if(claim.kind==='claimed')throw new Error('Receipt disappeared');
        await createClassificationCanonicalPorts(tx).collections.lockForUpdate(input.collectionId);
        await assertOwned(tx,input.collectionId,input.actor.subjectId);return claim;
      });
      if(prior)return prior;
      const snapshot=await readClassificationRunSnapshot(db,{collectionId:input.collectionId,ownerSubjectId:input.actor.subjectId,document},{...options,signal});
      const billingMode=runBillingMode(snapshot,options.creditEnabled===true);
      if(billingMode==='managed'&&options.credits!==undefined){
        await reconcileClassificationCredits(db,options.credits,input.actor.principalId,{cancelBackend:options.cancelBackend});
      }
      return createClassificationCreditTransactions(db,{...options,signal}).execute(async({transaction:tx})=>{
        const account=await tx.selectFrom('accounts').select(['id','status','deleted_at']).where('id','=',input.actor.principalId)
          .where('subject_id','=',input.actor.subjectId).forShare().executeTakeFirst();
        if(!account||account.status!=='active'||account.deleted_at!==null)throw new ClassificationError('resource_not_found');
        const credits=await lockRunCredits(tx,options,{accountId:input.actor.principalId,chargeId:null,mode:billingMode});
        if(credits!==null){
          const asOf=lockedCreditsAsOf(credits);
          if(await credits.hasExpiryBacklog(asOf)){
            throw new CreditError('credits_reconciling');
          }
        }
        const receipts=createPostgresProductCommandReceiptPort(tx),claim=await receipts.claim(binding,fingerprint);
        if(claim.kind!=='claimed')return claim;
        const gate=(await sql<{ok:boolean}>`SELECT pg_try_advisory_xact_lock(hashtextextended('known:classification:run-admission:v1',0)) AS ok`.execute(tx)).rows[0];
        if(!gate?.ok)throw new ClassificationProviderError('budget_exhausted');
        const active=(await sql<{total:number;account:number}>`SELECT count(*)::int AS total,
          count(*) FILTER(WHERE principal_id=${input.actor.principalId})::int AS account FROM collection_classification_runs
          WHERE status IN ('queued','running')`.execute(tx)).rows[0]!;
        if(active.total>=32||active.account>=2)throw new ClassificationProviderError('budget_exhausted');
        const collection=await createClassificationCanonicalPorts(tx).collections.lockForUpdate(input.collectionId);
        await assertOwned(tx,input.collectionId,input.actor.subjectId);
        const settings=await createPostgresClassificationSettingsStore(tx).loadOwned({collectionId:input.collectionId,ownerSubjectId:input.actor.subjectId});
        if(!collection||collection.contentRevision!==snapshot.taxonomy.contentRevision||settings?.revision!==snapshot.taxonomy.settings.revision) {
          throw new NodeConflictError('revision_conflict','Classification snapshot changed before admission.');
        }
        try{await assertClassificationProfileBinding(tx,snapshot.taxonomy.providerBinding);}
        catch{throw new NodeConflictError('revision_conflict','Classification profile changed before admission.');}
        if(options.managedAdmissionEnabled===false&&billingMode!=='byok')throw new ClassificationProviderError('disabled');
        const clock=(await sql<{created:string;deadline:string;expires:string}>`SELECT
          clock_timestamp()::text AS created,
          (clock_timestamp()+interval '4 minutes')::text AS deadline,
          (clock_timestamp()+interval '30 minutes')::text AS expires`.execute(tx)).rows[0]!;
        if(billingMode==='managed'){
          if(!credits)throw new CreditError('credits_unavailable');
          const asOf=lockedCreditsAsOf(credits);
          const balance=await credits.balance(asOf);
          const refusal=checkClassificationCreditConsent(document.billing, snapshot.nodes.length, balance.available);
          if(refusal){
            await receipts.complete(binding,fingerprint,creditFailureReceipt(input.requestId,refusal));
            return {kind:'replay' as const,result:creditFailureReceipt(input.requestId,refusal)};
          }
        }
        const id=(options.idGenerator??randomUUID)();
        await sql`SAVEPOINT classification_run_credit_admission`.execute(tx);
        try{
        const row=await tx.insertInto('collection_classification_runs').values({id,collection_id:input.collectionId,
          principal_id:binding.principalId,owner_subject_id:input.actor.subjectId,command_id:commandId,command_scope:binding.commandScope,revision:1n,
          status:'queued',failure_code:null,taxonomy_revision:snapshot.taxonomy.contentRevision,settings_revision:snapshot.taxonomy.settings.revision,
          profile_revision:null,provider_id:provider.id,model:provider.model,policy_version:provider.policyVersion,prompt_version:provider.promptVersion,
          candidate_version:CLASSIFICATION_POLICY.candidateVersion,snapshot_json:snapshot,created_at:sql<Date>`${clock.created}::timestamptz`,
          deadline_at:sql<Date>`${clock.deadline}::timestamptz`,expires_at:sql<Date>`${clock.expires}::timestamptz`,billing_mode:billingMode,
          price_version:billingMode==='managed'?CLASSIFICATION_CREDIT_PRICE.priceVersion:null,
          quoted_points:BigInt(billingMode==='managed'?snapshot.nodes.length:0)}).returningAll().executeTakeFirstOrThrow();
        const actionRows=snapshot.nodes.map((node,ordinal)=>({
          run_id:id,action_id:(options.idGenerator??randomUUID)(),ordinal,node_id:node.id,node_etag:`"${node.resourceRevision}"`,source_parent_id:node.parentId,
          execution_command_id:randomUUID(),principal_id:input.actor.principalId,credit_charge_id:null as string|null,billing_owner_kind:'action' as const,
          status:'pending' as const,decision_json:null,failure_code:null}));
        if(billingMode==='managed'){
          if(!credits)throw new CreditError('credits_unavailable');
          for(const action of actionRows){
            const chargeId=randomUUID();
            const operationKey=canonicalJson(['classification-run-action',id,action.action_id]);
            const fingerprint=canonicalCommandFingerprint({method:'POST',route:`/api/v1/collections/${input.collectionId}/classification-runs/${id}/actions/${action.action_id}`,mediaType:'application/json',body:{nodeId:action.node_id,nodeEtag:action.node_etag,billing:document.billing}});
            await credits.reserve({chargeId,operationKey,fingerprint,amount:1,source:'batch',priceVersion:CLASSIFICATION_CREDIT_PRICE.priceVersion,
              ownerKind:'classification_action',ownerId:action.action_id,task:{kind:'classification_action',collectionId:input.collectionId,nodeId:action.node_id,runId:id,actionId:action.action_id},deadlineAt:clock.deadline}).catch(error => { throw mapClassificationCreditError(error); });
            action.credit_charge_id=chargeId;
          }
        }
        await tx.insertInto('collection_classification_run_actions').values(actionRows).execute();
        await tx.insertInto('collection_classification_run_jobs').values({run_id:id,state:'pending',lease_until:null,generation:0n,attempts:0,available_at:sql<Date>`${clock.created}::timestamptz`}).execute();
        const result=classificationRunReceipt(await classificationRunDto(tx,row,{credits:options.credits}),201,input.collectionId);await receipts.complete(binding,fingerprint,result);
        await sql`RELEASE SAVEPOINT classification_run_credit_admission`.execute(tx);
        return {kind:'replay' as const,result};
        }catch(error){
          await sql`ROLLBACK TO SAVEPOINT classification_run_credit_admission`.execute(tx);
          if(error instanceof CreditError && error.code==='insufficient_credits' && credits){
            const now=(await sql<{value:string}>`SELECT clock_timestamp()::text AS value`.execute(tx)).rows[0]!.value;
            const balance=await credits.balance(now);
            const refusal=new CreditError('insufficient_credits',{
              requiredPoints:snapshot.nodes.length,availablePoints:balance.available,
              maxPoints:document.billing?.maxPoints??0,priceVersion:CLASSIFICATION_CREDIT_PRICE.priceVersion,
            },{cause:error});
            const result=creditFailureReceipt(input.requestId,refusal);
            await receipts.complete(binding,fingerprint,result);
            return {kind:'replay' as const,result};
          }
          throw error;
        }
      });
    },
    get(input){
      return createUnitOfWork(db,{isolationLevel:'repeatable read'}).execute(async({transaction:tx})=>{
        await sql`SET TRANSACTION READ ONLY`.execute(tx);
        return classificationRunDto(tx,await readClassificationRunRow(tx,{...input,ownerSubjectId:input.actor.subjectId}),{credits:options.credits});
      });
    },
    async cancel(input){
      if(!input.document||typeof input.document!=='object'||Array.isArray(input.document)||Object.keys(input.document).length)throw new ClassificationError('invalid_input');
      const binding={principalId:input.actor.principalId,commandScope:'collections:classification-run-cancel:v1',commandId:assertCanonicalCommandId(input.commandId)};
      const fingerprint=canonicalCommandFingerprint({method:'POST',route:`/api/v1/collections/${input.collectionId}/classification-runs/${input.runId}/cancel`,mediaType:'application/json',body:{},conditions:{ifMatch:input.ifMatch}});
      const candidate=await db.selectFrom('collection_classification_runs').select(['billing_mode','principal_id'])
        .where('id','=',input.runId).where('collection_id','=',input.collectionId).where('principal_id','=',input.actor.principalId).executeTakeFirst();
      if(!candidate)throw new ClassificationError('resource_not_found');
      const existing=await db.selectFrom('product_command_receipts').select('completed_at').where('principal_id','=',binding.principalId)
        .where('command_scope','=',binding.commandScope).where('command_id','=',binding.commandId).executeTakeFirst();
      if(candidate.billing_mode==='managed'&&!existing?.completed_at)await reconcileClassificationCredits(db,options.credits,input.actor.principalId,{cancelBackend:options.cancelBackend});
      return createClassificationRunUnitOfWork(db,options).execute(async({transaction:tx})=>{
        const account=await tx.selectFrom('accounts').select(['id','status','deleted_at']).where('id','=',input.actor.principalId)
          .where('subject_id','=',input.actor.subjectId).forShare().executeTakeFirst();
        if(!account||account.status!=='active'||account.deleted_at!==null)throw new ClassificationError('resource_not_found');
        const rowForMode=await tx.selectFrom('collection_classification_runs').select(['billing_mode','principal_id']).where('id','=',input.runId).where('collection_id','=',input.collectionId).where('principal_id','=',input.actor.principalId).executeTakeFirst();
        if(!rowForMode)throw new ClassificationError('resource_not_found');
        const credits=await lockRunCredits(tx,options,{accountId:rowForMode.principal_id,chargeId:null,mode:rowForMode.billing_mode});
        const childCommandIds=(await tx.selectFrom('collection_classification_run_actions').select('execution_command_id').where('run_id','=',input.runId)
          .where('status','in',['pending','running']).orderBy('ordinal').execute()).map(action=>action.execution_command_id);
        await lockActionReceipts(tx,input.actor.principalId,childCommandIds);
        const receipts=createPostgresProductCommandReceiptPort(tx),claim=await receipts.claim(binding,fingerprint);
        if(claim.kind!=='claimed'){
          await createClassificationCanonicalPorts(tx).collections.lockForUpdate(input.collectionId);
          await assertOwned(tx,input.collectionId,input.actor.subjectId);return claim;
        }
        await createClassificationCanonicalPorts(tx).collections.lockForUpdate(input.collectionId);
        const row=await readClassificationRunRow(tx,{...input,ownerSubjectId:input.actor.subjectId},true);
        if(row.status==='applied')throw new ClassificationRunConflictError('An applied classification run cannot be cancelled.');
        if(input.ifMatch!==classificationRunEtag(row))throw new CollectionPreconditionError({currentEtag:classificationRunEtag(row)});
        if(!['queued','running','open'].includes(row.status))throw new ClassificationRunConflictError('Classification run is terminal.');
        await tx.selectFrom('collection_classification_run_jobs').select('run_id').where('run_id','=',row.id).forUpdate().executeTakeFirst();
        const unfinished=await tx.selectFrom('collection_classification_run_actions').selectAll().where('run_id','=',row.id)
          .where('status','in',['pending','running']).orderBy('ordinal').forUpdate().execute();
        for(const action of unfinished)await fenceActionExecution(tx,input.actor.principalId,action.execution_command_id);
        if(credits)await credits.lockFinancialRows();
        for(const action of unfinished){
          await tx.updateTable('collection_classification_run_actions').set({status:'failed',failure_code:'cancelled',decision_json:null})
            .where('run_id','=',row.id).where('action_id','=',action.action_id).where('status','in',['pending','running']).execute();
          if(credits&&action.credit_charge_id)await finishActionCharge(credits,action.credit_charge_id,false,'classification_cancelled');
        }
        await tx.updateTable('collection_classification_run_jobs').set({state:'complete',lease_until:null,generation:sql<bigint>`generation+1`}).where('run_id','=',row.id).execute();
        const updated=await tx.updateTable('collection_classification_runs').set({status:'cancelled',revision:sql<bigint>`revision+1`})
          .where('id','=',row.id).returningAll().executeTakeFirstOrThrow();
        const result=classificationRunReceipt(await classificationRunDto(tx,updated,{credits:options.credits}));await receipts.complete(binding,fingerprint,result);
        return {kind:'replay',result};
      });
    },
  };
}
