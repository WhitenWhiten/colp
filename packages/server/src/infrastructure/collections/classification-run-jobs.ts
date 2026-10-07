import { reconcileClassificationCredits } from './classification-credit-transactions.js';
import { assertClassificationProfileBinding } from './classification-profile-provider.js';
import { decodeClassificationRunSnapshot } from './classification-run-records.js';
import { sql,type Kysely } from 'kysely';
import type { ClassificationActionFailure } from '../../modules/collections/index.js';
import type { DatabaseSchema } from '../database/runtime.js';
import { type DatabaseTransaction } from '../database/unit-of-work.js';
import type { ClassificationRunRow } from './classification-run-records.js';
import { createClassificationRunUnitOfWork, lockRunContext, finishActionCharge, fenceActionExecution, lockActionReceipts, lockRunCredits, type ClassificationRunBillingOptions } from './classification-run-billing.js';

export interface ClassificationRunLease {readonly row:ClassificationRunRow;readonly generation:bigint}
async function completeJob(tx:DatabaseTransaction,id:string){
  await tx.updateTable('collection_classification_run_jobs').set({state:'complete',lease_until:null,generation:sql<bigint>`generation+1`}).where('run_id','=',id).execute();
}
async function finalizeRun(tx:DatabaseTransaction,row:ClassificationRunRow){
  const actions=await tx.selectFrom('collection_classification_run_actions').select('status').where('run_id','=',row.id).execute();
  if(actions.some(action=>action.status==='pending'||action.status==='running'))return;
  const current=await tx.selectFrom('collections as c').leftJoin('collection_classification_settings as s','s.collection_id','c.id')
    .select(['c.owner_subject_id','c.deleted_at','c.content_revision','s.revision']).where('c.id','=',row.collection_id).executeTakeFirst();
  const stale=!current||current.deleted_at!==null||current.owner_subject_id!==row.owner_subject_id||current.content_revision!==row.taxonomy_revision;
  let changed=String(current?.revision??0)!==row.settings_revision;
  try{await assertClassificationProfileBinding(tx,decodeClassificationRunSnapshot(row.snapshot_json)?.taxonomy.providerBinding);}catch{changed=true;}
  const succeeded=actions.some(action=>action.status==='succeeded');
  const failure=stale?'stale_snapshot':changed?'configuration_changed':!succeeded?'all_actions_failed':null;
  await tx.updateTable('collection_classification_runs').set({status:failure?'failed':'open',failure_code:failure,
    revision:sql<bigint>`revision+1`}).where('id','=',row.id).execute();
  await completeJob(tx,row.id);
}
export function createClassificationRunJobs(db:Kysely<DatabaseSchema>,options:ClassificationRunBillingOptions={}){
  const unit=createClassificationRunUnitOfWork(db,options);
  return {
    async pending(){
      return (await sql<{id:string}>`SELECT r.id FROM collection_classification_runs r JOIN collection_classification_run_jobs j ON j.run_id=r.id
        WHERE r.status IN ('queued','running') AND r.deadline_at>clock_timestamp() AND j.available_at<=clock_timestamp()
        AND (j.state='pending' OR (j.state='running' AND j.lease_until<clock_timestamp())) ORDER BY r.created_at,r.id LIMIT 4`.execute(db)).rows.map(row=>row.id);
    },
    lease(id:string):Promise<ClassificationRunLease|null>{
      // Discovery is lock-free. The account and business locks are acquired
      // only after the candidate has been re-read inside the worker transaction.
      return unit.execute(async({transaction:tx})=>{
        const candidate=await tx.selectFrom('collection_classification_runs').select(['id','collection_id','principal_id','billing_mode','command_scope','command_id'])
          .where('id','=',id).where('status','in',['queued','running']).where('deadline_at','>',sql<Date>`clock_timestamp()`).executeTakeFirst();
        if(!candidate)return null;
        const account=await tx.selectFrom('accounts').select(['id','status','deleted_at']).where('id','=',candidate.principal_id).forShare().executeTakeFirst();
        if(!account||account.status!=='active'||account.deleted_at!==null)return null;
        await lockRunCredits(tx,options,{accountId:candidate.principal_id,chargeId:null,mode:candidate.billing_mode});
        await tx.selectFrom('product_command_receipts').select('command_id').where('principal_id','=',candidate.principal_id)
          .where('command_scope','=',candidate.command_scope).where('command_id','=',candidate.command_id).forUpdate().executeTakeFirst();
        await lockRunContext(tx,candidate.id,candidate.collection_id);
        const row=await tx.selectFrom('collection_classification_runs').selectAll().where('id','=',id).where('status','in',['queued','running'])
          .where('deadline_at','>',sql<Date>`clock_timestamp()`).forUpdate().skipLocked().executeTakeFirst();
        if(!row||!row.snapshot_json)return null;
        const job=(await sql<{generation:string}>`UPDATE collection_classification_run_jobs SET state='running',generation=generation+1,
          attempts=attempts+1,lease_until=clock_timestamp()+interval '30 seconds' WHERE run_id=${id}
          AND (state='pending' OR (state='running' AND lease_until<clock_timestamp())) RETURNING generation::text`.execute(tx)).rows[0];
        if(!job)return null;
        const updated=await tx.updateTable('collection_classification_runs').set({status:'running',revision:sql<bigint>`revision+1`}).where('id','=',id).returningAll().executeTakeFirstOrThrow();
        return {row:updated,generation:BigInt(job.generation)};
      });
    },
    async heartbeat(lease:ClassificationRunLease){
      return unit.execute(async({transaction:tx})=>{
        await lockRunCredits(tx,options,{accountId:lease.row.principal_id,chargeId:null,mode:lease.row.billing_mode});
        await tx.selectFrom('product_command_receipts').select('command_id').where('principal_id','=',lease.row.principal_id)
          .where('command_scope','=',lease.row.command_scope).where('command_id','=',lease.row.command_id).forUpdate().executeTakeFirst();
        await lockRunContext(tx,lease.row.id,lease.row.collection_id);
        const row=await tx.updateTable('collection_classification_run_jobs').set({lease_until:sql<Date>`clock_timestamp()+interval '30 seconds'`})
          .where('run_id','=',lease.row.id).where('generation','=',lease.generation).where('state','=','running')
          .where('lease_until','>',sql<Date>`clock_timestamp()`).returning('run_id').executeTakeFirst();return Boolean(row);
      });
    },
    async actions(lease:ClassificationRunLease){
      return db.selectFrom('collection_classification_run_actions').selectAll().where('run_id','=',lease.row.id)
        .where('status','in',['pending','running']).orderBy('ordinal').execute();
    },
    async markRunning(lease:ClassificationRunLease,actionId:string){
      return unit.execute(async({transaction:tx})=>{
        await lockRunCredits(tx,options,{accountId:lease.row.principal_id,chargeId:null,mode:lease.row.billing_mode});
        await tx.selectFrom('product_command_receipts').select('command_id').where('principal_id','=',lease.row.principal_id)
          .where('command_scope','=',lease.row.command_scope).where('command_id','=',lease.row.command_id).forUpdate().executeTakeFirst();
        await lockRunContext(tx,lease.row.id,lease.row.collection_id);
        if(!await valid(tx,lease))return false;
        const changed=await tx.updateTable('collection_classification_run_actions').set({status:'running'}).where('run_id','=',lease.row.id)
          .where('action_id','=',actionId).where('status','=','pending').returning('action_id').executeTakeFirst();
        if(changed)await tx.updateTable('collection_classification_runs').set({revision:sql<bigint>`revision+1`}).where('id','=',lease.row.id).execute();
        return true;
      });
    },
    async finishAction(lease:ClassificationRunLease,actionId:string,decision:Record<string,unknown>|null,failure:ClassificationActionFailure|null){
      if(lease.row.billing_mode==='managed')await reconcileClassificationCredits(db,options.credits,lease.row.principal_id,{allowInactive:true,cancelBackend:options.cancelBackend});
      return unit.execute(async({transaction:tx})=>{
        const credits=await lockRunCredits(tx,options,{accountId:lease.row.principal_id,chargeId:null,mode:lease.row.billing_mode},true);
        const actionCandidate=await tx.selectFrom('collection_classification_run_actions').select('execution_command_id').where('run_id','=',lease.row.id)
          .where('action_id','=',actionId).where('status','in',['pending','running']).executeTakeFirst();
        if(!actionCandidate)return false;
        await lockActionReceipts(tx,lease.row.principal_id,[actionCandidate.execution_command_id]);
        await tx.selectFrom('product_command_receipts').select('command_id').where('principal_id','=',lease.row.principal_id)
          .where('command_scope','=',lease.row.command_scope).where('command_id','=',lease.row.command_id).forUpdate().executeTakeFirst();
        await lockRunContext(tx,lease.row.id,lease.row.collection_id);
        const row=await valid(tx,lease);if(!row)return false;
        const action=await tx.selectFrom('collection_classification_run_actions').selectAll().where('run_id','=',row.id).where('action_id','=',actionId).forUpdate().executeTakeFirst();
        if(!action||!['pending','running'].includes(action.status))return false;
        await fenceActionExecution(tx,lease.row.principal_id,action.execution_command_id);
        let chargeable=Boolean(decision);
        if(decision&&row.billing_mode==='managed'){
          const execution=await tx.selectFrom('classification_provider_executions').select(['id','state'])
            .where('principal_id','=',row.principal_id).where('command_scope','=','collections:classification-run-action:v1')
            .where('command_id','=',action.execution_command_id).executeTakeFirst();
          const receipt=await tx.selectFrom('product_command_receipts').select(['result_status','result_bytes'])
            .where('principal_id','=',row.principal_id).where('command_scope','=','collections:classification-run-action:v1')
            .where('command_id','=',action.execution_command_id).executeTakeFirst();
          if(!execution||execution.state!=='succeeded'||receipt?.result_status!==200||!receipt.result_bytes)return false;
          decision=JSON.parse(Buffer.from(receipt.result_bytes).toString('utf8')) as Record<string,unknown>;
          chargeable=Boolean(await tx.selectFrom('classification_call_attempts').select('execution_id').where('execution_id','=',execution.id).where('state','=','succeeded').executeTakeFirst());
          const current=await tx.selectFrom('collections as c').leftJoin('collection_classification_settings as s','s.collection_id','c.id')
            .select(['c.owner_subject_id','c.deleted_at','c.content_revision','s.revision']).where('c.id','=',row.collection_id).executeTakeFirst();
          let publishable=Boolean(current&&current.deleted_at===null&&current.owner_subject_id===row.owner_subject_id
            &&current.content_revision===row.taxonomy_revision&&String(current.revision??0)===row.settings_revision);
          try{await assertClassificationProfileBinding(tx,decodeClassificationRunSnapshot(row.snapshot_json)?.taxonomy.providerBinding);}catch{publishable=false;}
          if(!publishable){decision=null;chargeable=false;failure='cancelled';}

        }
        await tx.updateTable('collection_classification_run_actions').set({status:decision?'succeeded':'failed',decision_json:decision,
          failure_code:decision?null:failure??'provider_unavailable'}).where('run_id','=',row.id).where('action_id','=',actionId)
          .where('status','in',['pending','running']).execute();
        if(!await finishActionCharge(credits,action.credit_charge_id,chargeable,decision?'classification_unneeded':'classification_failed'))return false;
        await tx.updateTable('collection_classification_runs').set({revision:sql<bigint>`revision+1`}).where('id','=',row.id).execute();
        await finalizeRun(tx,row);return true;
      });
    },
    async stopRun(lease:ClassificationRunLease,reason:'disabled'|'configuration_changed'){
      if(lease.row.billing_mode==='managed')await reconcileClassificationCredits(db,options.credits,lease.row.principal_id,{allowInactive:true,cancelBackend:options.cancelBackend});
      await unit.execute(async({transaction:tx})=>{
        const credits=await lockRunCredits(tx,options,{accountId:lease.row.principal_id,chargeId:null,mode:lease.row.billing_mode},true);
        const actionCandidates=(await tx.selectFrom('collection_classification_run_actions').select('execution_command_id').where('run_id','=',lease.row.id)
          .where('status','in',['pending','running']).orderBy('ordinal').execute()).map(action=>action.execution_command_id);
        await lockActionReceipts(tx,lease.row.principal_id,actionCandidates);
        await tx.selectFrom('product_command_receipts').select('command_id').where('principal_id','=',lease.row.principal_id)
          .where('command_scope','=',lease.row.command_scope).where('command_id','=',lease.row.command_id).forUpdate().executeTakeFirst();
        await lockRunContext(tx,lease.row.id,lease.row.collection_id);
        const row=await valid(tx,lease);if(!row)return;
        const actions=await tx.selectFrom('collection_classification_run_actions').selectAll().where('run_id','=',lease.row.id)
          .where('status','in',['pending','running']).orderBy('ordinal').forUpdate().execute();
        for(const action of actions)await fenceActionExecution(tx,row.principal_id,action.execution_command_id);
        if(credits)await credits.lockFinancialRows();
        for(const action of actions){
          await tx.updateTable('collection_classification_run_actions').set({status:'failed',failure_code:'cancelled',decision_json:null})
            .where('run_id','=',lease.row.id).where('action_id','=',action.action_id).where('status','in',['pending','running']).execute();
          if(credits&&action.credit_charge_id)await finishActionCharge(credits,action.credit_charge_id,false,'classification_cancelled');
        }
        await tx.updateTable('collection_classification_runs').set({status:reason==='disabled'?'cancelled':'failed',failure_code:reason==='disabled'?null:'configuration_changed',revision:sql<bigint>`revision+1`})
          .where('id','=',lease.row.id).execute();await completeJob(tx,lease.row.id);
      });
    },
    async release(lease:ClassificationRunLease){
      await unit.execute(async({transaction:tx})=>{
        await lockRunCredits(tx,options,{accountId:lease.row.principal_id,chargeId:null,mode:lease.row.billing_mode},true);
        await tx.selectFrom('collection_classification_runs').select('id').where('id','=',lease.row.id).forUpdate().executeTakeFirst();
        await tx.updateTable('collection_classification_run_jobs').set({state:'pending',lease_until:null,available_at:sql<Date>`clock_timestamp()+interval '1 second'`})
          .where('run_id','=',lease.row.id).where('state','=','running').where('generation','=',lease.generation).execute();
      });
    },
    async reap(){
      // Profile rotation/revocation invalidates open results as well as undispatched work.
      const changedProfiles=await sql<{id:string;collection_id:string;principal_id:string;billing_mode:'managed'|'byok'|'legacy_free';command_scope:string;command_id:string}>`SELECT r.id,r.collection_id,r.principal_id,r.billing_mode,r.command_scope,r.command_id FROM collection_classification_runs r
        WHERE r.status IN ('queued','running','open') AND r.snapshot_json->'taxonomy'->'providerBinding' IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM classification_provider_profiles p JOIN accounts a ON a.subject_id=p.owner_subject_id
          WHERE p.id=r.snapshot_json->'taxonomy'->'providerBinding'->>'profileId'
          AND p.revision::text=r.snapshot_json->'taxonomy'->'providerBinding'->>'revision'
          AND p.owner_subject_id=r.owner_subject_id AND p.status='active' AND p.secret_envelope IS NOT NULL
          AND a.status='active' AND a.deleted_at IS NULL) ORDER BY r.created_at LIMIT 100`.execute(db);
      for(const candidate of changedProfiles.rows)await ownerUnit(candidate,async({transaction:tx})=>{
        const credits=await lockRunCredits(tx,options,{accountId:candidate.principal_id,chargeId:null,mode:candidate.billing_mode},true);
        const actionCommandIds=(await tx.selectFrom('collection_classification_run_actions').select('execution_command_id').where('run_id','=',candidate.id)
          .where('status','in',['pending','running']).orderBy('ordinal').execute()).map(action=>action.execution_command_id);
        await lockActionReceipts(tx,candidate.principal_id,actionCommandIds);
        await tx.selectFrom('product_command_receipts').select('command_id').where('principal_id','=',candidate.principal_id)
          .where('command_scope','=',candidate.command_scope).where('command_id','=',candidate.command_id).forUpdate().executeTakeFirst();
        await lockRunContext(tx,candidate.id,candidate.collection_id);
        const row=await tx.selectFrom('collection_classification_runs').selectAll().where('id','=',candidate.id).where('status','in',['queued','running','open']).forUpdate().executeTakeFirst();
        if(!row)return;
        await tx.selectFrom('collection_classification_run_jobs').select('run_id').where('run_id','=',row.id).forUpdate().executeTakeFirst();
        try{await assertClassificationProfileBinding(tx,decodeClassificationRunSnapshot(row.snapshot_json)?.taxonomy.providerBinding);return;}catch{/* Converge the old revision below. */}
        const actions=await tx.selectFrom('collection_classification_run_actions').selectAll().where('run_id','=',row.id)
          .where('status','in',['pending','running']).orderBy('ordinal').forUpdate().execute();
        for(const action of actions)await fenceActionExecution(tx,row.principal_id,action.execution_command_id);
        if(credits)await credits.lockFinancialRows();
        for(const action of actions){
          await tx.updateTable('collection_classification_run_actions').set({status:'failed',failure_code:'cancelled',decision_json:null})
            .where('run_id','=',row.id).where('action_id','=',action.action_id).execute();
          if(credits&&action.credit_charge_id)await finishActionCharge(credits,action.credit_charge_id,false,'classification_cancelled');
        }
        await tx.updateTable('collection_classification_runs').set({status:'failed',failure_code:'configuration_changed',revision:sql<bigint>`revision+1`}).where('id','=',row.id).execute();
        await completeJob(tx,row.id);
      });
      const due=await db.selectFrom('collection_classification_runs').select(['id','collection_id','principal_id','billing_mode','command_scope','command_id']).where('status','in',['queued','running'])
        .where('deadline_at','<=',sql<Date>`clock_timestamp()`).orderBy('deadline_at').limit(100).execute();
      for(const candidate of due)await ownerUnit(candidate,async({transaction:tx})=>{
        const credits=await lockRunCredits(tx,options,{accountId:candidate.principal_id,chargeId:null,mode:candidate.billing_mode},true);
        const actionCommandIds=(await tx.selectFrom('collection_classification_run_actions').select('execution_command_id').where('run_id','=',candidate.id)
          .where('status','in',['pending','running']).orderBy('ordinal').execute()).map(action=>action.execution_command_id);
        await lockActionReceipts(tx,candidate.principal_id,actionCommandIds);
        await tx.selectFrom('product_command_receipts').select('command_id').where('principal_id','=',candidate.principal_id)
          .where('command_scope','=',candidate.command_scope).where('command_id','=',candidate.command_id).forUpdate().executeTakeFirst();
        await lockRunContext(tx,candidate.id,candidate.collection_id);
        const row=await tx.selectFrom('collection_classification_runs').selectAll().where('id','=',candidate.id)
          .where('status','in',['queued','running']).where('deadline_at','<=',sql<Date>`clock_timestamp()`).forUpdate().skipLocked().executeTakeFirst();
        if(!row)return;
        await tx.selectFrom('collection_classification_run_jobs').select('run_id').where('run_id','=',row.id).forUpdate().executeTakeFirst();
        const actions=await tx.selectFrom('collection_classification_run_actions').selectAll().where('run_id','=',row.id)
          .where('status','in',['pending','running']).orderBy('ordinal').forUpdate().execute();
        for(const action of actions)await fenceActionExecution(tx,row.principal_id,action.execution_command_id);
        if(credits)await credits.lockFinancialRows();
        for(const action of actions){
          if(action.status==='pending')await tx.updateTable('collection_classification_run_actions').set({status:'failed',failure_code:'deadline_exceeded',decision_json:null})
            .where('run_id','=',row.id).where('action_id','=',action.action_id).execute();
          if(credits&&action.credit_charge_id)await finishActionCharge(credits,action.credit_charge_id,false,'hold_expired');
        }
        await sql`UPDATE collection_classification_run_actions a SET status='failed',decision_json=NULL,
          failure_code=CASE WHEN EXISTS(SELECT 1 FROM classification_provider_executions e
            JOIN classification_call_attempts c ON c.execution_id=e.id WHERE e.command_id=a.execution_command_id
            AND e.command_scope='collections:classification-run-action:v1' AND c.state IN ('dispatching','unknown'))
            THEN 'outcome_unknown' ELSE 'deadline_exceeded' END
          WHERE a.run_id=${row.id} AND a.status='running'`.execute(tx);
        await finalizeRun(tx,row);
      });
      const expiredCandidates=await db.selectFrom('collection_classification_runs').select(['id','collection_id','principal_id','billing_mode','command_scope','command_id'])
        .where('expires_at','<=',sql<Date>`clock_timestamp()`).where('snapshot_json','is not',null).orderBy('expires_at').limit(100).execute();
      for(const candidate of expiredCandidates)await ownerUnit(candidate,async({transaction:tx})=>{
        const credits=await lockRunCredits(tx,options,{accountId:candidate.principal_id,chargeId:null,mode:candidate.billing_mode},true);
        const actionCommandIds=(await tx.selectFrom('collection_classification_run_actions').select('execution_command_id').where('run_id','=',candidate.id)
          .where('status','in',['pending','running']).orderBy('ordinal').execute()).map(action=>action.execution_command_id);
        await lockActionReceipts(tx,candidate.principal_id,actionCommandIds);
        await tx.selectFrom('product_command_receipts').select('command_id').where('principal_id','=',candidate.principal_id)
          .where('command_scope','=',candidate.command_scope).where('command_id','=',candidate.command_id).forUpdate().executeTakeFirst();
        await lockRunContext(tx,candidate.id,candidate.collection_id);
        const row=await tx.selectFrom('collection_classification_runs').selectAll().where('id','=',candidate.id)
          .where('expires_at','<=',sql<Date>`clock_timestamp()`).where('snapshot_json','is not',null).forUpdate().executeTakeFirst();
        if(!row)return;
        await tx.selectFrom('collection_classification_run_jobs').select('run_id').where('run_id','=',row.id).forUpdate().executeTakeFirst();
        await tx.selectFrom('collection_classification_run_actions').select('action_id').where('run_id','=',row.id).orderBy('ordinal').forUpdate().execute();
        const actions=await tx.selectFrom('collection_classification_run_actions').selectAll().where('run_id','=',row.id)
          .where('status','in',['pending','running']).orderBy('ordinal').forUpdate().execute();
        for(const action of actions)await fenceActionExecution(tx,row.principal_id,action.execution_command_id);
        if(credits)await credits.lockFinancialRows();
        for(const action of actions){
          if(credits&&action.credit_charge_id)await finishActionCharge(credits,action.credit_charge_id,false,'hold_expired');
        }
        await tx.deleteFrom('collection_classification_run_actions').where('run_id','=',row.id).execute();
        await tx.updateTable('collection_classification_runs').set({status:'expired',snapshot_json:null,revision:sql<bigint>`revision+1`}).where('id','=',row.id).execute();
        await completeJob(tx,row.id);
      });
    },
  };
  async function ownerUnit(owner:{principal_id:string;billing_mode:string},work:(context:{transaction:DatabaseTransaction})=>Promise<void>){
    if(owner.billing_mode==='managed')await reconcileClassificationCredits(db,options.credits,owner.principal_id,{allowInactive:true,cancelBackend:options.cancelBackend});
    return unit.execute(work);
  }
  async function valid(tx:DatabaseTransaction,lease:ClassificationRunLease){
    const row=await tx.selectFrom('collection_classification_runs').selectAll().where('id','=',lease.row.id).where('status','=','running')
      .where('deadline_at','>',sql<Date>`clock_timestamp()`).forUpdate().executeTakeFirst();
    if(!row)return null;
    const job=await tx.selectFrom('collection_classification_run_jobs').select('run_id').where('run_id','=',row.id).where('state','=','running')
      .where('generation','=',lease.generation).where('lease_until','>',sql<Date>`clock_timestamp()`).forUpdate().executeTakeFirst();
    return job?row:null;
  }
}
