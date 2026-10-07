import {randomUUID} from 'node:crypto';
import {sql,type Kysely,type Selectable} from 'kysely';
import {assertCanonicalCommandId,canonicalCommandFingerprint} from '../../modules/commands/index.js';
import {ClassificationProfileError,ClassificationProviderError,classificationCallProvenNotAccepted,classificationFailureReceipt,CLASSIFICATION_PROBE_INPUT,type ClassificationProfileCommand,type ClassificationProfileResult} from '../../modules/collections/index.js';
import type {DatabaseSchema} from '../database/runtime.js';
import type {ClassificationProfileTestTable} from '../database/classification-profile-tables.js';
import {createUnitOfWork} from '../database/unit-of-work.js';
import {createPostgresProductCommandReceiptPort} from '../database/product-command-receipt.js';
import type {ClassificationSecretEnvelope,ClassificationSecretProtector} from '../security/classification-secret-envelope.js';
import {createCloudflareJevTransport} from './classification-provider-cloudflare-transport.js';
import {createCloudflareUpstream} from './classification-provider-factory.js';
import {classificationProfileEtag,classificationProfileView,parseClassificationProfileConfig} from './classification-profile-records.js';
import {lockClassificationProfileOwner,profileCommandResult,profileCommandScope} from './classification-profile-commands.js';
import {classificationBudgetScopes,reserveClassificationProviderCall} from './classification-provider-budget.js';
import {DEFAULT_CLASSIFICATION_PRICING, calculateClassificationSettledMicrousd} from './classification-pricing.js';
type Probe=Selectable<ClassificationProfileTestTable>;
const binding=(row:Probe)=>({principalId:row.principal_id,commandScope:profileCommandScope('test'),commandId:row.command_id});
// Fixed synthetic input shared with the extension's connection test.
const probeInput=CLASSIFICATION_PROBE_INPUT;
const finite=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=1;
export function createClassificationProfileProbes(db:Kysely<DatabaseSchema>,protector:ClassificationSecretProtector|null,
  options:{enabled:()=>boolean;transport?:typeof fetch;signal:AbortSignal}){
  const unit=createUnitOfWork(db);
  async function finish(row:Probe,outcome:'succeeded'|'failed'|'outcome_unknown',settled:number|null,expectedState:'pending'|'dispatching'){
    return unit.execute(async({transaction:tx})=>{
      const owner=await lockClassificationProfileOwner(tx,row.owner_subject_id,false);
      const current=await tx.selectFrom('classification_profile_tests').selectAll().where('id','=',row.id).forUpdate().executeTakeFirstOrThrow();
      // Only the dispatch CAS winner may settle in-flight work. A stale pending reader cannot refund it.
      if(current.state!==expectedState)return;
      const profile=await tx.selectFrom('classification_provider_profiles').selectAll().where('id','=',row.profile_id).where('owner_subject_id','=',row.owner_subject_id).forUpdate().executeTakeFirst();
      const same=profile&&String(profile.revision)===row.profile_revision;
      const valid=same&&owner.status==='active'&&owner.deleted_at===null&&options.enabled()&&current.deadline_at.getTime()>Date.now();
      const success=valid&&outcome==='succeeded';
      let result=classificationFailureReceipt(row.request_id,same?'provider_unavailable':'configuration_changed');
      if(same){
        const updated=await tx.updateTable('classification_provider_profiles').set({status:success?'active':'test_failed',last_tested_at:sql<Date>`clock_timestamp()`,
          revision:sql`revision+1`,updated_at:sql<Date>`clock_timestamp()`}).where('id','=',profile.id).returningAll().executeTakeFirstOrThrow();
        if(valid)result=profileCommandResult(200,{profileId:updated.id,status:success?'ok':'failed',
          capabilities:classificationProfileView(updated).capabilities,checkedAt:updated.last_tested_at!.toISOString()},classificationProfileEtag(updated));
      }
      await tx.updateTable('classification_profile_tests').set({state:success?'succeeded':outcome==='outcome_unknown'?'outcome_unknown':'failed',completed_at:sql<Date>`clock_timestamp()`,settled_microusd:settled===null?null:BigInt(settled)}).where('id','=',row.id).execute();
      if(current.dispatched_at&&settled!==null)for(const scope of classificationBudgetScopes(row.principal_id,row.profile_id)){
        await sql`UPDATE classification_spend_budgets SET spent_microusd=spent_microusd-${Number(current.reserved_microusd)-settled}
          WHERE day=(${current.dispatched_at}::timestamptz AT TIME ZONE 'UTC')::date AND scope=${scope}`.execute(tx);
      }
      await createPostgresProductCommandReceiptPort(tx).complete(binding(row),row.fingerprint,result);
    });
  }
  return {
    async admit(input:ClassificationProfileCommand):Promise<ClassificationProfileResult|{kind:'accepted';id:string}>{
      const commandId=assertCanonicalCommandId(input.commandId),key={principalId:input.actor.principalId,commandScope:profileCommandScope('test'),commandId};
      const fingerprint=canonicalCommandFingerprint({method:'POST',route:`/me/classification-provider-profiles/${input.profileId}/test`,mediaType:'application/json',body:{}});
      return unit.execute(async({transaction:tx})=>{
        const owner=await lockClassificationProfileOwner(tx,input.actor.subjectId);if(owner.id!==input.actor.principalId)throw new ClassificationProfileError('resource_not_found');
        const claim=await createPostgresProductCommandReceiptPort(tx).claim(key,fingerprint);if(claim.kind!=='claimed')return claim;
        const profile=await tx.selectFrom('classification_provider_profiles').selectAll().where('id','=',input.profileId!).where('owner_subject_id','=',input.actor.subjectId).executeTakeFirst();
        if(!profile)throw new ClassificationProfileError('resource_not_found');
        if(!profile.secret_envelope)throw new ClassificationProfileError('feature_temporarily_unavailable');
        const queued=await tx.selectFrom('classification_profile_tests').select('id').where('principal_id','=',input.actor.principalId).where('state','in',['pending','dispatching']).execute();
        if(queued.length>=2)throw new ClassificationProfileError('mutation_conflict');
        const id=randomUUID();await tx.insertInto('classification_profile_tests').values({id,principal_id:input.actor.principalId,owner_subject_id:input.actor.subjectId,
          profile_id:profile.id,profile_revision:String(profile.revision),command_id:commandId,fingerprint,request_id:input.requestId,state:'pending',
          deadline_at:sql<Date>`clock_timestamp()+interval '20 seconds'`,dispatched_at:null,completed_at:null,settled_microusd:null}).execute();return {kind:'accepted',id};
      });
    },
    async process(id:string){
      const row=await db.selectFrom('classification_profile_tests').selectAll().where('id','=',id).executeTakeFirst();if(!row||row.state!=='pending')return;
      const profile=await db.selectFrom('classification_provider_profiles').selectAll().where('id','=',row.profile_id).where('owner_subject_id','=',row.owner_subject_id).executeTakeFirst();
      if(!protector||!options.enabled()||!profile?.secret_envelope||String(profile.revision)!==row.profile_revision){await finish(row,'failed',0,'pending');return;}
      let dispatched=false;
      try{
        await protector.withSecret(profile.secret_envelope as ClassificationSecretEnvelope,{ownerSubjectId:row.owner_subject_id,profileId:profile.id},async secret=>{
          const reserved=await unit.execute(async({transaction:tx})=>{
            await lockClassificationProfileOwner(tx,row.owner_subject_id);
            const live=await tx.selectFrom('classification_provider_profiles').select(['revision','secret_envelope']).where('id','=',profile.id).executeTakeFirst();
            if(!options.enabled()||!live?.secret_envelope||String(live.revision)!==row.profile_revision)throw new ClassificationProviderError('configuration_changed');
            const pending=await tx.selectFrom('classification_profile_tests').select('id').where('id','=',row.id).where('state','=','pending').where('deadline_at','>',sql<Date>`clock_timestamp()`).forUpdate().executeTakeFirst();
            if(!pending)return false;
            await reserveClassificationProviderCall(tx,row.principal_id,row.profile_id,row.id);
            await tx.updateTable('classification_profile_tests').set({state:'dispatching',dispatched_at:sql<Date>`clock_timestamp()`,reserved_microusd:DEFAULT_CLASSIFICATION_PRICING.reservationMicrousd}).where('id','=',row.id).execute();return true;
          });
          if(!reserved)return;dispatched=true;
          const signal=AbortSignal.any([options.signal,AbortSignal.timeout(Math.max(1,row.deadline_at.getTime()-Date.now()))]);
          // The probe verifies the stored credential, not a pinned version: alias mode is correct here.
          const upstream=createCloudflareUpstream({...parseClassificationProfileConfig(profile.config_json),accessKey:secret});
          const result=await createCloudflareJevTransport(upstream,options.transport)(probeInput,signal);
          const answers=result.payload.answers as {folder?:{choice?:unknown;confidence?:unknown;probabilities?:Record<string,unknown>};tag?:{noul?:unknown}}|undefined;
          if(!answers?.folder||!['alpha','beta'].includes(String(answers.folder.choice))||!finite(answers.folder.confidence)||!finite(answers.tag?.noul)
            ||Object.keys(answers.folder.probabilities??{}).sort().join(',')!=='alpha,beta'||Object.values(answers.folder.probabilities!).some(value=>!finite(value))
            ||Math.abs(Object.values(answers.folder.probabilities!).reduce<number>((sum,value)=>sum+Number(value),0)-1)>1e-6)throw new ClassificationProviderError('contract_drift');
          await finish(row,'succeeded',calculateClassificationSettledMicrousd(result.usage.inputTokens),'dispatching');
        });
      }catch(error){
        const provenNotAccepted = classificationCallProvenNotAccepted(error);
        const notAccepted = !dispatched || provenNotAccepted;
        const unknown = dispatched && !provenNotAccepted && !(error instanceof ClassificationProviderError && error.code === 'contract_drift');
        await finish(row, unknown ? 'outcome_unknown' : 'failed', notAccepted ? 0 : null, dispatched ? 'dispatching' : 'pending');
      }
    },
    async reap(){
      const expired=await db.selectFrom('classification_profile_tests').selectAll().where('state','in',['pending','dispatching']).where('deadline_at','<=',sql<Date>`clock_timestamp()`).execute();
      for(const row of expired)await finish(row,row.state==='dispatching'?'outcome_unknown':'failed',row.state==='pending'?0:null,row.state as 'pending'|'dispatching');
      await db.deleteFrom('classification_profile_tests').where('completed_at','<',sql<Date>`clock_timestamp()-interval '30 days'`).execute();
    },
    async pending(){return db.selectFrom('classification_profile_tests').select('id').where('state','=','pending').where('deadline_at','>',sql<Date>`clock_timestamp()`).limit(16).execute();},
  };
}
