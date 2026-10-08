import { createClassificationCreditTransactions, mapClassificationCreditError as mapCreditError } from './classification-credit-transactions.js';
import { assertClassificationProfileBinding } from './classification-profile-provider.js';
import { reserveClassificationProviderCall } from './classification-provider-budget.js';
import { DEFAULT_CLASSIFICATION_PRICING, calculateClassificationSettledMicrousd } from './classification-pricing.js';
import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { canonicalJson, type ProductCommandResult } from '../../modules/commands/index.js';
import {
  ClassificationProviderError, ClassificationError, classificationFailureReceipt, persistedClassificationContext,
  type ClassificationExecutionStore, type ClassificationExecutionLease, type ClassificationExecutionSeed,
  type ClassificationCallResult,
} from '../../modules/collections/index.js';
import {
  CLASSIFICATION_CREDIT_PRICE, CreditError, checkClassificationCreditConsent,
  type AccountCreditsPort, type CreditQuoteContext, type CreditReleaseReason,
} from '../../modules/identity/index.js';
import type { DatabaseSchema } from '../database/runtime.js';
import { DatabaseOperationError } from '../database/errors.js';
import { createUnitOfWork, type DatabaseTransaction, type UnitOfWorkOptions } from '../database/unit-of-work.js';
import { createPostgresProductCommandReceiptPort } from '../database/product-command-receipt.js';

interface ExecutionRow {
  id:string; principal_id:string; owner_subject_id:string; collection_id:string; command_scope:string; command_id:string;
  fingerprint:string; request_id:string; provider_id:string; model:string; policy_version:string; prompt_version:string;
  input_json:ClassificationExecutionSeed['context']; generation:string; deadline_at:Date;
  billing_mode:'managed'|'byok'|'legacy_free'; credit_charge_id:string|null; billing_owner_kind:'execution'|'action';
}
const leaseOf = (row:ExecutionRow):ClassificationExecutionLease => ({id:row.id,generation:String(row.generation),deadlineAt:row.deadline_at.toISOString(),
  binding:{principalId:row.principal_id,commandScope:row.command_scope,commandId:row.command_id},ownerSubjectId:row.owner_subject_id,
  collectionId:row.collection_id,fingerprint:row.fingerprint,requestId:row.request_id,providerId:row.provider_id,model:row.model,
  policyVersion:row.policy_version,promptVersion:row.prompt_version,context:row.input_json,
  billingMode:row.billing_mode,creditChargeId:row.credit_charge_id,billingOwnerKind:row.billing_owner_kind});

export interface ClassificationCreditsFactory {
  (transaction: DatabaseTransaction, accountId: string): AccountCreditsPort;
}

export interface ClassificationExecutionStoreOptions extends Pick<UnitOfWorkOptions,'faultInjector'|'signal'|'cancelBackend'> {
  readonly credits?: ClassificationCreditsFactory;
  /** Defaults false so existing deployments and legacy tests remain free. */
  readonly creditEnabled?: boolean;
  readonly managedAdmissionEnabled?: boolean;
}

/** Every method owns a short transaction. No provider callback enters this adapter. */
export function createPostgresClassificationExecutionStore(db:Kysely<DatabaseSchema>, options: ClassificationExecutionStoreOptions = {}):ClassificationExecutionStore {
  const transactionExecute=createClassificationCreditTransactions(db,options).execute;
  const creditEnabled=options.creditEnabled===true;
  const modeFor=(seed:ClassificationExecutionSeed):'managed'|'byok'|'legacy_free' =>
    seed.billingMode??(seed.context.snapshot.settings.executionMode==='server_byok'?'byok':seed.billingOwnerKind==='action'?'managed':creditEnabled?'managed':'legacy_free');
  const creditsFor=(tx:DatabaseTransaction,accountId:string):AccountCreditsPort|null=>options.credits?.(tx,accountId)??null;
  const operationKey=(seed:ClassificationExecutionSeed)=>canonicalJson([seed.binding.commandScope,seed.binding.commandId]);
  const creditCall=async<Result>(work:()=>Promise<Result>):Promise<Result>=>{
    try{return await work();}catch(error){throw mapCreditError(error);}
  };
  const failureReceipt=(requestId:string,error:CreditError):ProductCommandResult=>{
    const status=error.code==='billing_consent_required'?422
      :(['credit_price_changed','credit_limit_exceeded','insufficient_credits'].includes(error.code)?409:503);
    return {status,contractVersion:'1.0.0',mediaType:'application/json',
      stableHeaders:{'content-type':'application/json; charset=utf-8','cache-control':'private, no-store'},
      body:Buffer.from(JSON.stringify({error:{code:error.code,message:'Classification credit admission was refused.',requestId,
        recovery:status===503?'same_request':'user_action',sameRequestRetrySafe:status===503,precondition:null,currentEtag:null,
        retryAfterSeconds:status===503?1:null,fieldErrors:[],...(error.creditContext?{creditContext:error.creditContext}:{})}}))};
  };
  const withCreditUsage=(result:ProductCommandResult,usage:{mode:'managed'|'byok'|'legacy_free';priceVersion:string|null;quotedPoints:number;reservedPoints:number;chargedPoints:number;releasedPoints:number}):ProductCommandResult=>{
    if(result.status!==200)return result;
    try{
      const body=JSON.parse(Buffer.from(result.body).toString('utf8')) as Record<string,unknown>;
      return {...result,body:Buffer.from(canonicalJson({...body,creditUsage:usage}))};
    }catch{throw new CreditError('credits_unavailable');}
  };
  const reconcileAccount=async(accountId:string,allowInactive=false):Promise<void>=>{
    if(!options.credits)return;
    const result=await transactionExecute(async({transaction:tx})=>{
      const credits=creditsFor(tx,accountId);if(!credits)throw new CreditError('credits_unavailable');
      await creditCall(()=>credits.lock({allowInactive}));return creditCall(()=>credits.reconcile());
    },false);
    if(result.hasMore)throw new CreditError('credits_reconciling');
  };
  const releaseReason=(failureCode?:string):CreditReleaseReason=>
    failureCode==='deadline'||failureCode==='deadline_exceeded'?'hold_expired':'classification_failed';
  const lockActionOwner=async(tx:DatabaseTransaction,accountId:string,commandId:string,expectedMode:'managed'|'byok'|'legacy_free'):Promise<{readonly chargeId:string|null;readonly runId:string;readonly actionId:string}>=>{
    const parent=await sql<{run_id:string;action_id:string;principal_id:string;credit_charge_id:string|null;billing_mode:'managed'|'byok'|'legacy_free'}>`SELECT r.id AS run_id,a.action_id,r.principal_id,a.credit_charge_id,r.billing_mode
      FROM collection_classification_runs r JOIN collection_classification_run_actions a ON a.run_id=r.id
      WHERE r.principal_id=${accountId} AND a.execution_command_id=${commandId} AND a.status IN ('pending','running') AND r.status='running' AND r.deadline_at>clock_timestamp() FOR UPDATE OF r`.execute(tx);
    const owner=parent.rows[0];
    if(!owner||owner.billing_mode!==expectedMode)throw new ClassificationProviderError('lease_lost');
    await sql`SELECT j.run_id FROM collection_classification_run_jobs j JOIN collection_classification_run_actions a ON a.run_id=j.run_id
      WHERE a.execution_command_id=${commandId} FOR UPDATE OF j`.execute(tx);
    await sql`SELECT a.run_id,a.action_id FROM collection_classification_run_actions a
      WHERE a.execution_command_id=${commandId} FOR UPDATE`.execute(tx);
    return {runId:owner.run_id,actionId:owner.action_id,chargeId:owner.credit_charge_id};
  };
  async function fence(tx:DatabaseTransaction, lease:ClassificationExecutionLease, checkContext=true,
    allowInactive=!checkContext, withCredits=lease.billingMode==='managed'):
    Promise<{readonly credits:AccountCreditsPort|null}> {
    let lockedCredits:AccountCreditsPort|null=null;
    const account=await tx.selectFrom('accounts').select(['id','status','deleted_at']).where('id','=',lease.binding.principalId)
      .where('subject_id','=',lease.ownerSubjectId).forShare().executeTakeFirst();
    if(!account)throw new ClassificationProviderError('lease_lost');
    if(lease.billingMode==='managed'){
      lockedCredits=creditsFor(tx,lease.binding.principalId);
      if(!lockedCredits)throw new CreditError('credits_unavailable');
      await creditCall(()=>lockedCredits!.lock({allowInactive}));
    }
    // Receipt is L2 and must be locked before collection/execution rows.
    await tx.selectFrom('product_command_receipts').select('command_id').where('principal_id','=',lease.binding.principalId)
      .where('command_scope','=',lease.binding.commandScope).where('command_id','=',lease.binding.commandId).forUpdate().executeTakeFirst();
    if(checkContext){
      // Serialize semantic checks with owner revocation, settings (including their
      // first insert), and canonical taxonomy writes. No network runs here.
      // T-10 (ADR-0027): this context-revalidation transaction never executes a
      // canonical node mutation (its ports are built without
      // `invalidateSyncReplicasOnNodeMutation`), so it never touches
      // `sync_replicas` afterwards and may keep the Collection-first lock.
      // The classification path that does mutate nodes is the run apply
      // transaction, which takes its collection lock through
      // `lockRunContext` (replica-first).
      await tx.selectFrom('collections').select('id').where('id','=',lease.collectionId).forUpdate().executeTakeFirst();
      await tx.selectFrom('collection_classification_settings').select('collection_id').where('collection_id','=',lease.collectionId)
        .forShare().executeTakeFirst();
    }
    if(checkContext)await assertClassificationProfileBinding(tx,lease.context.snapshot.providerBinding);
    if(checkContext&&lease.binding.commandScope==='collections:classification-run-action:v1'){
      await lockActionOwner(tx,lease.binding.principalId,lease.binding.commandId,lease.billingMode??'legacy_free');
    }
    const rows=await sql<{id:string;account_current:boolean;context_current:boolean}>`SELECT e.id,
      (account.status='active' AND account.deleted_at IS NULL) AS account_current,
      (c.deleted_at IS NULL AND c.owner_subject_id=e.owner_subject_id AND c.content_revision=e.content_revision
       AND coalesce(s.revision::text,'0')=e.settings_revision) AS context_current
      FROM classification_provider_executions e JOIN accounts account ON account.id=e.principal_id AND account.subject_id=e.owner_subject_id JOIN collections c ON c.id=e.collection_id
      LEFT JOIN collection_classification_settings s ON s.collection_id=e.collection_id
      WHERE e.id=${lease.id} AND e.generation=${lease.generation}::bigint AND e.state='running'
        AND e.lease_until>clock_timestamp() AND e.deadline_at>clock_timestamp() FOR UPDATE OF e`.execute(tx);
    if(!rows.rows[0])throw new ClassificationProviderError('lease_lost');
    if(checkContext&&(!rows.rows[0].context_current||(!rows.rows[0].account_current&&!allowInactive)))
      throw new ClassificationProviderError('configuration_changed');
    if(withCredits&&lease.billingMode==='managed'&&lease.creditChargeId){
      const chargeId=lease.creditChargeId;
      if(!lockedCredits||!await creditCall(()=>lockedCredits.isReserved(chargeId)))throw new ClassificationProviderError('lease_lost');
    }
    return {credits:lockedCredits};
  }
  return {
    async lookup(input){
      return transactionExecute(async({transaction:tx})=>{
        const account=await tx.selectFrom('accounts').select(['id','status','deleted_at']).where('id','=',input.binding.principalId)
          .where('subject_id','=',input.ownerSubjectId).forShare().executeTakeFirst();
        if(!account||account.status!=='active'||account.deleted_at!==null)throw new ClassificationError('resource_not_found');
        const owner=await tx.selectFrom('collections').select('id').where('id','=',input.collectionId)
          .where('owner_subject_id','=',input.ownerSubjectId).where('deleted_at','is',null).executeTakeFirst();
        if(!owner)throw new ClassificationError('resource_not_found');
        const credits=creditsFor(tx,input.binding.principalId);if(credits)await creditCall(()=>credits.lock());
        const row=await tx.selectFrom('product_command_receipts').select('command_id').where('principal_id','=',input.binding.principalId)
          .where('command_scope','=',input.binding.commandScope).where('command_id','=',input.binding.commandId).executeTakeFirst();
        if(!row)return null;
        const claim=await createPostgresProductCommandReceiptPort(tx).claim(input.binding,input.fingerprint);
        if(claim.kind==='claimed')throw new Error('Existing receipt disappeared during locked lookup');
        const lockedOwner=await tx.selectFrom('collections').select('id').where('id','=',input.collectionId)
          .where('owner_subject_id','=',input.ownerSubjectId).where('deleted_at','is',null).forUpdate().executeTakeFirst();
        if(!lockedOwner)throw new ClassificationError('resource_not_found');
        return claim;
      });
    },
    async admit(seed){
      if(modeFor(seed)==='managed')await reconcileAccount(seed.binding.principalId);
      return transactionExecute(async({transaction:tx})=>{
        // L0: account lifecycle, followed by L1: the account-owned credit row.
        const account=await tx.selectFrom('accounts').select(['id','status','deleted_at']).where('id','=',seed.binding.principalId)
          .where('subject_id','=',seed.ownerSubjectId).forShare().executeTakeFirst();
        if(!account||account.status!=='active'||account.deleted_at!==null)throw new ClassificationError('resource_not_found');
        const mode=modeFor(seed);
        const credits=mode==='managed'?creditsFor(tx,seed.binding.principalId):null;
        if(mode==='managed'&&credits)await creditCall(()=>credits.lock());
        // L2: claim the receipt before any mutable classification admission work.
        const claim=await createPostgresProductCommandReceiptPort(tx).claim(seed.binding,seed.fingerprint);
        if(claim.kind!=='claimed')return claim;
        const completeCreditFailure=async(error:CreditError)=>{
          const result=failureReceipt(seed.requestId,error);
          await createPostgresProductCommandReceiptPort(tx).complete(seed.binding,seed.fingerprint,result);
          return {kind:'replay' as const,result};
        };
        await sql`SET LOCAL lock_timeout='250ms'`.execute(tx);
        // L3: shared classification admission capacity.
        await sql`SELECT pg_advisory_xact_lock(hashtextextended('known:classification:execution-admission:v1',0))`.execute(tx);
        const queued=(await sql<{total:number;account:number}>`SELECT count(*)::int AS total,
          count(*) FILTER(WHERE principal_id=${seed.binding.principalId})::int AS account FROM classification_provider_executions WHERE state IN ('pending','running')`.execute(tx)).rows[0]!;
        if(queued.total>=64||queued.account>=8)throw new ClassificationProviderError('budget_exhausted');
        // L4: collection/settings/profile snapshot revalidation.
        const collection=await tx.selectFrom('collections').select('id').where('id','=',seed.collectionId)
          .where('owner_subject_id','=',seed.ownerSubjectId).where('deleted_at','is',null).forUpdate().executeTakeFirst();
        if(!collection)throw new ClassificationError('resource_not_found');
        const settings=await tx.selectFrom('collection_classification_settings').selectAll().where('collection_id','=',seed.collectionId)
          .forShare().executeTakeFirst();
        if((settings&&String(settings.revision)!==String(seed.context.snapshot.settings.revision))
          ||(!settings&&String(seed.context.snapshot.settings.revision)!=='0'))throw new ClassificationProviderError('configuration_changed');
        try{await assertClassificationProfileBinding(tx,seed.context.snapshot.providerBinding);}
        catch{throw new ClassificationProviderError('configuration_changed');}
        if(options.managedAdmissionEnabled===false&&mode!=='byok'&&seed.billingOwnerKind!=='action')throw new ClassificationProviderError('disabled');
        let actionOwner:{readonly chargeId:string|null;readonly runId:string;readonly actionId:string}|null=null;
        if(seed.billingOwnerKind==='action'){
          const owner=await lockActionOwner(tx,seed.binding.principalId,seed.binding.commandId,mode);
          actionOwner=owner;
          if(seed.creditChargeId!==owner.chargeId)throw new ClassificationProviderError('lease_lost');
          if(mode==='managed'){
            const chargeId=owner.chargeId;
            if(!chargeId||!credits)throw new CreditError('credits_unavailable');
            if(!await creditCall(()=>credits.isReserved(chargeId)))throw new ClassificationProviderError('lease_lost');
          }
        }
        let quoteContext:CreditQuoteContext|undefined;
        if(mode==='managed'&&actionOwner===null){
          if(!credits)throw new CreditError('credits_unavailable');
          const quoteNow=(await sql<{now:string}>`SELECT clock_timestamp()::text AS now`.execute(tx)).rows[0]!.now;
          if(await creditCall(()=>credits.hasExpiryBacklog(quoteNow!)))throw new CreditError('credits_reconciling');
          const balance=await creditCall(()=>credits.balance(quoteNow));
          quoteContext={requiredPoints:1,availablePoints:balance.available,maxPoints:seed.billing?.maxPoints??0,
            priceVersion:'bookmark-classify.v1'};
          const refusal=checkClassificationCreditConsent(seed.billing,1,balance.available);
          if(refusal)return completeCreditFailure(refusal);
        }
        // L5/L6 are enclosed in a savepoint. The outer receipt claim remains
        // committed when a stable credit refusal is returned.
        try{
        await sql`SAVEPOINT classification_credit_admission`.execute(tx);
        const id=randomUUID();
        const creditChargeId=actionOwner?.chargeId??(mode==='managed'?randomUUID():null);
        await sql`INSERT INTO classification_provider_executions(id,principal_id,owner_subject_id,collection_id,command_scope,command_id,fingerprint,request_id,
          provider_id,model,policy_version,prompt_version,input_json,settings_revision,content_revision,state,deadline_at,
          billing_mode,credit_charge_id,billing_owner_kind)
          VALUES(${id},${seed.binding.principalId},${seed.ownerSubjectId},${seed.collectionId},${seed.binding.commandScope},${seed.binding.commandId},${seed.fingerprint},${seed.requestId},
          ${seed.providerId},${seed.model},${seed.policyVersion},${seed.promptVersion},${canonicalJson(persistedClassificationContext(seed.context))}::jsonb,
        ${seed.context.snapshot.settings.revision},${seed.context.snapshot.contentRevision},'pending',least(${seed.deadlineAt}::timestamptz,clock_timestamp()+interval '20 seconds'),
          ${mode},${creditChargeId},${actionOwner===null?'execution':'action'})`.execute(tx);
        if(mode==='managed'&&actionOwner===null){
          const savepointCredits=credits;
          if(!savepointCredits||!creditChargeId)throw new CreditError('credits_unavailable');
          const charge=await creditCall(()=>savepointCredits.reserve({chargeId:creditChargeId,operationKey:operationKey(seed),fingerprint:seed.fingerprint,
            amount:1,source:seed.source??'system',priceVersion:seed.billing?.priceVersion??'bookmark-classify.v1',ownerKind:'classification_preview',ownerId:id,
            task:{kind:'classification_preview',collectionId:seed.collectionId,nodeId:seed.context.snapshot.node?.id??null,runId:null,actionId:null},deadlineAt:seed.deadlineAt}));
          await sql`UPDATE classification_provider_executions SET credit_charge_id=${charge} WHERE id=${id}`.execute(tx);
        }
        await sql`RELEASE SAVEPOINT classification_credit_admission`.execute(tx);
        return {kind:'accepted' as const,executionId:id};
        }catch(error:unknown){
          await sql`ROLLBACK TO SAVEPOINT classification_credit_admission`.execute(tx);
          const code=(error as {code?:unknown}).code;
          if(error instanceof CreditError&&typeof code==='string'&&code==='insufficient_credits')
            return completeCreditFailure(new CreditError('insufficient_credits',quoteContext,{cause:error}));
          throw error;
        }
      });
    },
    async lease(id){
      const candidate=(await sql<ExecutionRow>`SELECT * FROM classification_provider_executions WHERE id=${id}
        AND deadline_at>clock_timestamp() AND (state='pending' OR (state='running' AND lease_until<clock_timestamp()))`.execute(db)).rows[0];
      if(!candidate)return null;
      return transactionExecute(async({transaction:tx})=>{
        const account=await tx.selectFrom('accounts').select(['id','status','deleted_at']).where('id','=',candidate.principal_id)
          .where('subject_id','=',candidate.owner_subject_id).forShare().executeTakeFirst();
        if(!account||account.status!=='active'||account.deleted_at!==null)return null;
        const credits=candidate.billing_mode==='managed'?creditsFor(tx,candidate.principal_id):null;
        if(candidate.billing_mode==='managed'){
          if(!credits)throw new CreditError('credits_unavailable');
          await creditCall(()=>credits.lock());
        }
        await tx.selectFrom('product_command_receipts').select('command_id').where('principal_id','=',candidate.principal_id)
          .where('command_scope','=',candidate.command_scope).where('command_id','=',candidate.command_id).forUpdate().executeTakeFirst();
        await tx.selectFrom('collections').select('id').where('id','=',candidate.collection_id).forUpdate().executeTakeFirst();
        await tx.selectFrom('collection_classification_settings').select('collection_id').where('collection_id','=',candidate.collection_id)
          .forShare().executeTakeFirst();
        try{await assertClassificationProfileBinding(tx,candidate.input_json.snapshot.providerBinding);}catch{return null;}
        if(candidate.command_scope==='collections:classification-run-action:v1')await lockActionOwner(tx,candidate.principal_id,candidate.command_id,candidate.billing_mode);
        const row=(await sql<ExecutionRow>`SELECT * FROM classification_provider_executions WHERE id=${id}
          AND deadline_at>clock_timestamp() AND (state='pending' OR (state='running' AND lease_until<clock_timestamp()))
          FOR UPDATE SKIP LOCKED`.execute(tx)).rows[0];
        if(!row)return null;
        if(row.billing_mode==='managed'&&row.credit_charge_id){
          const chargeId=row.credit_charge_id;
          if(!credits||!await creditCall(()=>credits.isReserved(chargeId)))return null;
        }
        const updated=(await sql<ExecutionRow>`UPDATE classification_provider_executions SET state='running',generation=generation+1,
          lease_until=clock_timestamp()+interval '30 seconds' WHERE id=${id} AND deadline_at>clock_timestamp()
          AND (state='pending' OR (state='running' AND lease_until<clock_timestamp())) RETURNING *`.execute(tx)).rows[0];
        return updated?leaseOf(updated):null;
      });
    },
    async heartbeat(lease){
      return transactionExecute(async({transaction:tx})=>{
        const account=await tx.selectFrom('accounts').select(['id','status','deleted_at']).where('id','=',lease.binding.principalId)
          .where('subject_id','=',lease.ownerSubjectId).forShare().executeTakeFirst();
        if(!account||account.status!=='active'||account.deleted_at!==null)return false;
        const credits=lease.billingMode==='managed'?creditsFor(tx,lease.binding.principalId):null;
        if(lease.billingMode==='managed'){
          if(!credits)throw new CreditError('credits_unavailable');
          await creditCall(()=>credits.lock());
        }
        if(lease.billingMode==='managed'&&lease.creditChargeId){
          const chargeId=lease.creditChargeId;
          if(!credits||!await creditCall(()=>credits.isReserved(chargeId)))return false;
        }
        await tx.selectFrom('product_command_receipts').select('command_id').where('principal_id','=',lease.binding.principalId)
          .where('command_scope','=',lease.binding.commandScope).where('command_id','=',lease.binding.commandId).forUpdate().executeTakeFirst();
        await tx.selectFrom('collections').select('id').where('id','=',lease.collectionId).forUpdate().executeTakeFirst();
        await tx.selectFrom('collection_classification_settings').select('collection_id').where('collection_id','=',lease.collectionId)
          .forShare().executeTakeFirst();
        try{await assertClassificationProfileBinding(tx,lease.context.snapshot.providerBinding);}catch{return false;}
        if(lease.binding.commandScope==='collections:classification-run-action:v1')await lockActionOwner(tx,lease.binding.principalId,lease.binding.commandId,lease.billingMode??'legacy_free');
        const result=await sql`UPDATE classification_provider_executions SET lease_until=clock_timestamp()+interval '30 seconds'
          WHERE id=${lease.id} AND generation=${lease.generation}::bigint AND state='running' AND deadline_at>clock_timestamp() AND lease_until>clock_timestamp()`.execute(tx);
        return Number(result.numAffectedRows)===1;
      });
    },
    async prepare(lease,stage,chunk,digest){
      return transactionExecute(async({transaction:tx})=>{
        await fence(tx,lease);
        await sql`INSERT INTO classification_call_attempts(execution_id,stage,chunk_index,input_digest,state)
          VALUES(${lease.id},${stage},${chunk},${digest},'ready') ON CONFLICT DO NOTHING`.execute(tx);
        const row=(await sql<{state:string;input_digest:string;result_json:ClassificationCallResult|null}>`SELECT state,input_digest,result_json FROM classification_call_attempts
          WHERE execution_id=${lease.id} AND stage=${stage} AND chunk_index=${chunk} FOR UPDATE`.execute(tx)).rows[0]!;
        if(row.input_digest!==digest)throw new ClassificationProviderError('contract_drift');
        if(row.state==='succeeded'&&row.result_json)return row.result_json;
        if(row.state!=='ready')throw new ClassificationProviderError('outcome_unknown');
        return null;
      });
    },
    async dispatch(lease,stage,chunk){
      await transactionExecute(async({transaction:tx})=>{
        await fence(tx,lease);
        const attempt=await tx.selectFrom('classification_call_attempts').select('state')
          .where('execution_id','=',lease.id).where('stage','=',stage).where('chunk_index','=',chunk).forUpdate().executeTakeFirst();
        if(attempt?.state!=='ready')throw new ClassificationProviderError('outcome_unknown');
        await reserveClassificationProviderCall(tx,lease.binding.principalId,lease.context.snapshot.providerBinding?.profileId??lease.providerId,lease.id);
        const changed=await sql`UPDATE classification_call_attempts SET state='dispatching',attempt_number=1,reserved_microusd=${Number(DEFAULT_CLASSIFICATION_PRICING.reservationMicrousd)},dispatched_at=clock_timestamp()
          WHERE execution_id=${lease.id} AND stage=${stage} AND chunk_index=${chunk} AND state='ready' RETURNING execution_id`.execute(tx);
        if(!changed.rows.length)throw new ClassificationProviderError('outcome_unknown');
      });
    },
    async completeCall(lease,stage,chunk,result){
      await transactionExecute(async({transaction:tx})=>{
        await fence(tx,lease,false,true,false);
        const settled=calculateClassificationSettledMicrousd(result.inputTokens);
        const changed=await sql<{day:string;reserved:string}>`UPDATE classification_call_attempts SET state='succeeded',result_json=${canonicalJson(result)}::jsonb,
          reported_model_version=${result.modelVersion ?? null},attempt_number=GREATEST(attempt_number,${result.attemptNumber ?? 1}),settled_microusd=${settled},completed_at=clock_timestamp() WHERE execution_id=${lease.id} AND stage=${stage} AND chunk_index=${chunk}
          AND state='dispatching' RETURNING (dispatched_at AT TIME ZONE 'UTC')::date::text AS day,reserved_microusd::text AS reserved`.execute(tx);
        if(!changed.rows[0])throw new ClassificationProviderError('lease_lost');
        // Refund against the amount THIS row reserved, never the current price
        // constant: a price change between reserve and settle would otherwise
        // drive a scope's spent_microusd negative and trip its CHECK constraint.
        const refunded=Number(changed.rows[0].reserved)-settled;
        for(const scope of ['global',`profile:${lease.context.snapshot.providerBinding?.profileId??lease.providerId}`,`account:${lease.binding.principalId}`])await sql`UPDATE classification_spend_budgets
          SET spent_microusd=spent_microusd-${refunded} WHERE day=${changed.rows[0].day}::date AND scope=${scope}`.execute(tx);
      });
    },
    async rejectCall(lease,stage,chunk,notAccepted,attempts){
      await transactionExecute(async({transaction:tx})=>{
        await fence(tx,lease,false,true,false);
        const rows=(await sql<{day:string;reserved:string}>`UPDATE classification_call_attempts SET state='failed',
          attempt_number=GREATEST(attempt_number,${attempts ?? 1}),
          settled_microusd=${notAccepted?0:Number(DEFAULT_CLASSIFICATION_PRICING.reservationMicrousd)},completed_at=clock_timestamp() WHERE execution_id=${lease.id} AND stage=${stage} AND chunk_index=${chunk}
          AND state='dispatching' RETURNING (dispatched_at AT TIME ZONE 'UTC')::date::text AS day,reserved_microusd::text AS reserved`.execute(tx)).rows;
        if(notAccepted&&rows[0])for(const scope of ['global',`profile:${lease.context.snapshot.providerBinding?.profileId??lease.providerId}`,`account:${lease.binding.principalId}`])await sql`UPDATE classification_spend_budgets
          SET spent_microusd=spent_microusd-${rows[0].reserved}::bigint WHERE day=${rows[0].day}::date AND scope=${scope}`.execute(tx);
      });
    },
    async finish(lease,state,result,failureCode){
      const previous=await txState(lease);
      if(!previous||previous.state!=='running'||String(previous.generation)!==lease.generation)return false;
      if(lease.billingMode==='managed'&&lease.billingOwnerKind==='execution')await reconcileAccount(lease.binding.principalId,true);
      try{return await transactionExecute(async({transaction:tx})=>{
        const locked=await fence(tx,lease,state==='succeeded',true);
        const providerCall=await tx.selectFrom('classification_call_attempts').select('execution_id')
          .where('execution_id','=',lease.id).where('state','=','succeeded').executeTakeFirst();
        const updated=await sql`UPDATE classification_provider_executions SET state=${state},failure_code=${failureCode??null},completed_at=clock_timestamp(),lease_until=NULL
          WHERE id=${lease.id} AND generation=${lease.generation}::bigint AND state='running' RETURNING id`.execute(tx);
        if(!updated.rows.length)return false;
        await sql`UPDATE classification_call_attempts SET state='unknown',settled_microusd=reserved_microusd,completed_at=clock_timestamp()
          WHERE execution_id=${lease.id} AND state='dispatching'`.execute(tx);
        let finalResult=result;
        if(lease.billingMode==='managed'&&lease.billingOwnerKind==='execution'&&lease.creditChargeId){
          const chargeId=lease.creditChargeId;
          const credits=locked.credits;
          if(!credits)throw new CreditError('credits_unavailable');
          const totals=await creditCall(()=>credits.totals([chargeId]));
          const hasProviderCall=providerCall!==undefined;
          const changed=state==='succeeded'&&hasProviderCall
            ?await creditCall(()=>credits.settle(chargeId))
            :await creditCall(()=>credits.release(chargeId,state==='succeeded'&&!hasProviderCall?'classification_unneeded':releaseReason(failureCode)));
          if(!changed)throw new CreditError('credits_unavailable');
          finalResult=withCreditUsage(result,{mode:'managed',priceVersion:CLASSIFICATION_CREDIT_PRICE.priceVersion,quotedPoints:totals.quoted,
            reservedPoints:0,chargedPoints:state==='succeeded'&&hasProviderCall?totals.quoted:0,
            releasedPoints:state==='succeeded'&&hasProviderCall?0:totals.quoted});
        }else if(lease.billingOwnerKind==='execution'&&(lease.billingMode==='byok'||lease.billingMode==='legacy_free')){
          finalResult=withCreditUsage(result,{mode:lease.billingMode,priceVersion:null,quotedPoints:0,reservedPoints:0,chargedPoints:0,releasedPoints:0});
        }
        await createPostgresProductCommandReceiptPort(tx).complete(lease.binding,lease.fingerprint,finalResult);
        return true;
      });}catch(error){
        if(error instanceof ClassificationProviderError&&error.code==='lease_lost'){
          const current=await txState(lease);
          if(!current||current.state!=='running'||String(current.generation)!==lease.generation)return false;
        }
        throw error;
      }
    },
    async pending(){return (await sql<{id:string}>`SELECT id FROM classification_provider_executions WHERE deadline_at>clock_timestamp() AND command_scope='collections:classification-preview:v1'
      AND (state='pending' OR (state='running' AND lease_until<clock_timestamp())) ORDER BY created_at LIMIT 16`.execute(db)).rows.map(r=>r.id);},
    async reap(){
      // Discovery deliberately takes no row locks. Each candidate is then
      // re-read in its own account-scoped transaction, so a reaper cannot
      // acquire execution first and later deadlock on the account ledger row.
      const candidates=(await sql<{id:string;principal_id:string;command_scope:string;command_id:string;collection_id:string;billing_mode:string}>`SELECT id,principal_id,command_scope,command_id,collection_id,billing_mode
        FROM classification_provider_executions WHERE state IN ('pending','running') AND deadline_at<=clock_timestamp()
        ORDER BY deadline_at LIMIT 100`.execute(db)).rows;
      let completed=0;
      for(const candidate of candidates){
        if(candidate.billing_mode==='managed'){
          try{await reconcileAccount(candidate.principal_id,true);}
          catch(error){if(error instanceof CreditError&&['credits_busy','credits_reconciling'].includes(error.code))continue;throw error;}
        }
        const changed=await transactionExecute(async({transaction:tx})=>{
          const account=await tx.selectFrom('accounts').select('id').where('id','=',candidate.principal_id).forShare().executeTakeFirst();
          if(!account)return false;
          const credits=candidate.billing_mode==='managed'?creditsFor(tx,candidate.principal_id):null;
          if(candidate.billing_mode==='managed'){
            if(!credits)throw new CreditError('credits_unavailable');
            await creditCall(()=>credits.lock({allowInactive:true}));
          }
          const receipt=await tx.selectFrom('product_command_receipts').select('command_id').where('principal_id','=',candidate.principal_id)
            .where('command_scope','=',candidate.command_scope).where('command_id','=',candidate.command_id).forUpdate().executeTakeFirst();
          if(!receipt)return false;
          await tx.selectFrom('collections').select('id').where('id','=',candidate.collection_id).forUpdate().executeTakeFirst();
          await tx.selectFrom('collection_classification_settings').select('collection_id').where('collection_id','=',candidate.collection_id)
            .forShare().executeTakeFirst();
          try{await assertClassificationProfileBinding(tx,(await sql<ExecutionRow>`SELECT input_json FROM classification_provider_executions WHERE id=${candidate.id}`.execute(tx)).rows[0]?.input_json?.snapshot.providerBinding);}catch{/* reaper still releases the fenced charge */}
          const row=(await sql<ExecutionRow>`SELECT * FROM classification_provider_executions WHERE id=${candidate.id}
            AND state IN ('pending','running') AND deadline_at<=clock_timestamp() FOR UPDATE`.execute(tx)).rows[0];
          if(!row)return false;
          const unknown=(await sql`UPDATE classification_call_attempts SET state='unknown',settled_microusd=reserved_microusd,completed_at=clock_timestamp()
            WHERE execution_id=${row.id} AND state='dispatching' RETURNING execution_id`.execute(tx)).rows.length>0;
          await sql`UPDATE classification_provider_executions SET state=${unknown?'outcome_unknown':'failed'},failure_code=${unknown?'outcome_unknown':'deadline'},generation=generation+1,completed_at=clock_timestamp(),lease_until=NULL WHERE id=${row.id}`.execute(tx);
          if(row.billing_mode==='managed'&&row.billing_owner_kind==='execution'&&row.credit_charge_id){
            const chargeId=row.credit_charge_id;
            if(!credits)throw new CreditError('credits_unavailable');
            if(!await creditCall(()=>credits.release(chargeId,'hold_expired')))throw new CreditError('credits_unavailable');
          }
          await createPostgresProductCommandReceiptPort(tx).complete(leaseOf(row).binding,row.fingerprint,classificationFailureReceipt(row.request_id,unknown?'outcome_unknown':'deadline'));
          return true;
        });
        if(changed)completed+=1;
      }
      const cleanupCandidates=(await sql<{id:string;principal_id:string}>`SELECT id,principal_id
        FROM classification_provider_executions WHERE completed_at<clock_timestamp()-interval '30 minutes'
          AND input_json IS NOT NULL LIMIT 100`.execute(db)).rows;
      for(const candidate of cleanupCandidates){
        await transactionExecute(async({transaction:tx})=>{
          await tx.selectFrom('accounts').select('id').where('id','=',candidate.principal_id).forShare().executeTakeFirst();
          const row=(await sql<{id:string}>`SELECT id FROM classification_provider_executions WHERE id=${candidate.id}
            AND completed_at<clock_timestamp()-interval '30 minutes' AND input_json IS NOT NULL FOR UPDATE`.execute(tx)).rows[0];
          if(!row)return;
          await sql`UPDATE classification_provider_executions SET input_json=NULL WHERE id=${candidate.id}`.execute(tx);
          await sql`UPDATE classification_call_attempts SET result_json=NULL WHERE execution_id=${candidate.id}`.execute(tx);
        });
      }
      return completed;
    },
  };
  async function txState(lease:ClassificationExecutionLease){
    return db.selectFrom('classification_provider_executions').select(['state','generation'])
      .where('id','=',lease.id).where('principal_id','=',lease.binding.principalId).executeTakeFirst();
  }
}
