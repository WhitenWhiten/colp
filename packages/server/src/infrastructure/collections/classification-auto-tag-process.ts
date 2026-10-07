import { assertClassificationProfileBinding } from './classification-profile-provider.js';
import { createHash } from 'node:crypto';
import { sql,type Kysely } from 'kysely';
import { canonicalCommandFingerprint } from '../../modules/commands/index.js';
import { CLASSIFICATION_POLICY,eligibleAutoCalibration,selectClassificationAutoTags,loadClassificationContext,runClassificationExecution,updateCollectionNode,
  ClassificationProviderError,type BookmarkClassificationProvider,type ClassificationAutoCalibration,type ClassificationExecutionSeed } from '../../modules/collections/index.js';
import type { DatabaseSchema } from '../database/runtime.js';
import { createUnitOfWork,type UnitOfWorkOptions } from '../database/unit-of-work.js';
import type { ReportSourceInvalidationOutboxPort } from '../outbox/report-source-invalidation-producer.js';
import { OutboxDeliveryError,type OutboxHandlerContext } from '../outbox/router.js';
import { createClassificationCanonicalPorts } from './classification-canonical-ports.js';
import { createPostgresClassificationSettingsStore } from './classification-settings-postgres.js';
import { createClassificationVocabularyPort } from './classification-confirmation-postgres.js';
import { createPostgresClassificationTaxonomyReadPort } from './classification-taxonomy-read.js';
import { createPostgresClassificationExecutionStore } from './classification-execution-postgres.js';
import type { ClassificationDeploymentIdentity } from './classification-provider-factory.js';
import { autoJobTerminal,createClassificationAutoJobStore,fenceClassificationAutoAttempt,type ClassificationAutoJob } from './classification-auto-tag-store.js';

type Disposition='complete'|'retry'|'recompute'|'failed';
interface AutoDecision {taxonomyRevision:string;folder:null;tags:{candidates:{tag:string;noul:number}[]};candidateCoverage:{tagIncluded:number;tagTotal:number}}
export function createPostgresClassificationAutoTagProcessor(db:Kysely<DatabaseSchema>,provider:BookmarkClassificationProvider,options:{
  readonly managedEnabled?:()=>boolean;
  readonly profilesEnabled?:()=>boolean;readonly enabled:()=>boolean;readonly calibration:()=>ClassificationAutoCalibration|null;readonly metric:(code:string)=>void;
  readonly cancelBackend?:UnitOfWorkOptions['cancelBackend'];readonly reportSourceInvalidation?:ReportSourceInvalidationOutboxPort;
  /** Calibration-bound deployment identity; null in alias mode keeps every job skipped. */
  readonly identity?:ClassificationDeploymentIdentity|null;
}){
  const jobs=createClassificationAutoJobStore(db,options),executions=createPostgresClassificationExecutionStore(db);
  function policy(job:ClassificationAutoJob,calibration:ClassificationAutoCalibration|null):calibration is ClassificationAutoCalibration {
    const identity=options.identity??null;
    // The upstream identity comes from the deployment configuration, never from the
    // job row: job creation happens in canonical writes that cannot know it.
    return options.enabled()&&identity!==null&&identity.providerId===provider.id&&identity.model===provider.model
      &&(job.profile_id!==null||options.managedEnabled?.()!==false)
      &&(job.profile_id===null||options.profilesEnabled?.()===true)&&job.policy_version===provider.policyVersion
      &&job.prompt_version===provider.promptVersion&&job.candidate_version===CLASSIFICATION_POLICY.candidateVersion
      &&eligibleAutoCalibration(calibration,{...identity,policyVersion:job.policy_version,promptVersion:job.prompt_version,candidateVersion:job.candidate_version});
  }
  async function terminal(job:ClassificationAutoJob,context:OutboxHandlerContext,status:ClassificationAutoJob['status'],code:string):Promise<Disposition>{
    if(await jobs.mark(job,context,status,code))options.metric(`${status}.${code}`);
    return status==='failed'||status==='outcome_unknown'?'failed':'complete';
  }
  return async(jobId:string,context:OutboxHandlerContext):Promise<Disposition>=>{
    const job=await jobs.read(jobId);if(!job)throw new OutboxDeliveryError('permanent','classification_auto_job_missing');
    if(!context.attempt||job.outbox_id!==context.attempt.outboxId
      ||context.envelope.aggregate_identity.aggregate_id!==job.node_id
      ||context.envelope.aggregate_identity.aggregate_scope!==job.collection_id)
      throw new OutboxDeliveryError('permanent','classification_auto_attempt_mismatch');
    if(autoJobTerminal(job))return 'complete';
    const owner=await db.selectFrom('accounts').select('id').where('id','=',job.principal_id).where('subject_id','=',job.owner_subject_id)
      .where('status','=','active').where('deleted_at','is',null).executeTakeFirst();
    if(!owner)return terminal(job,context,'obsolete','owner_unavailable');
    const calibration=options.calibration();
    if(!policy(job,calibration))return terminal(job,context,'skipped','policy_unavailable');
    if(job.expires_at.getTime()<=Date.now())return terminal(job,context,'skipped','expired');

    await jobs.mark(job,context,'running',null);context.signal.throwIfAborted();
    const current=await loadClassificationContext({collectionId:job.collection_id,ownerSubjectId:job.owner_subject_id,tagsEnabled:true,
      preview:{source:'extension',nodeId:job.node_id,requested:{folder:false,tags:true}}},
    createPostgresClassificationTaxonomyReadPort(db,{signal:context.signal,cancelBackend:options.cancelBackend})).catch(error=>{
      if(error instanceof ClassificationProviderError&&error.code==='configuration_changed')return null;throw error;
    });
    if(job.profile_id!==null&&current?.snapshot.providerBinding?.revision!==job.profile_revision)return terminal(job,context,'obsolete','profile_changed');
    if(!current||current.snapshot.node?.resourceRevision!==job.resource_revision)return terminal(job,context,'obsolete','node_changed');
    if(current.snapshot.settings.autoTagMode!=='auto'||current.snapshot.settings.revision!==job.settings_revision
      ||current.snapshot.settings.providerProfileId!==job.profile_id)return terminal(job,context,'obsolete','settings_changed');
    if(current.snapshot.settings.maxAutoTags===0||(current.snapshot.node?.tags.length??0)>=CLASSIFICATION_POLICY.maxFinalTags)return terminal(job,context,'skipped','tag_limit');
    if(current.candidates&&current.candidates.coverage.tagIncluded!==current.candidates.coverage.tagTotal)return terminal(job,context,'skipped','vocabulary_clipped');
    if(!current.candidates?.tags.length)return terminal(job,context,'skipped','empty_vocabulary');
    const commandId=job.recomputations===0?job.execution_command_id:job.recompute_command_id;
    const seed:ClassificationExecutionSeed={binding:{principalId:job.principal_id,commandScope:'collections:classification-auto-tag:v1',commandId},
      ownerSubjectId:job.owner_subject_id,collectionId:job.collection_id,requestId:job.id,context:current,
      fingerprint:canonicalCommandFingerprint({method:'AUTO-TAGS',route:job.id,mediaType:'application/json',body:{nodeId:job.node_id,revision:job.resource_revision,recomputations:job.recomputations}}),
      providerId:provider.id,model:provider.model,policyVersion:job.policy_version,promptVersion:job.prompt_version,deadlineAt:new Date(Date.now()+20000).toISOString()};
    await executions.reap();
    let admission=await executions.lookup(seed);if(!admission)admission=await executions.admit(seed);
    let failure='provider_unavailable';
    if(admission.kind==='accepted'||admission.kind==='in_progress'){
      const execution=await db.selectFrom('classification_provider_executions').select('id').where('principal_id','=',job.principal_id)
        .where('command_scope','=',seed.binding.commandScope).where('command_id','=',commandId).executeTakeFirst();
      if(!execution)return 'retry';
      await runClassificationExecution(executions,provider,execution.id,{enabled:()=>policy(job,options.calibration()),signal:context.signal,
        onError:code=>{failure=code;options.metric(`execution.${code}`);}});
      await executions.reap();admission=await executions.lookup(seed);
    }
    context.signal.throwIfAborted();
    if(!admission||admission.kind==='accepted'||admission.kind==='in_progress')return 'retry';
    if(admission.kind!=='replay')return terminal(job,context,'failed','execution_unavailable');
    const stillCurrent=await db.selectFrom('nodes as n').innerJoin('collection_classification_settings as s','s.collection_id','n.collection_id')
      .select(['n.resource_revision','n.deleted_at','s.revision','s.auto_tag_mode']).where('n.id','=',job.node_id).where('n.collection_id','=',job.collection_id).executeTakeFirst();
    if(!stillCurrent||stillCurrent.deleted_at!==null||stillCurrent.resource_revision!==job.resource_revision)return terminal(job,context,'obsolete','node_changed');
    if(stillCurrent.auto_tag_mode!=='auto'||String(stillCurrent.revision)!==job.settings_revision)return terminal(job,context,'obsolete','settings_changed');
    const attempts=await db.selectFrom('classification_provider_executions as e').innerJoin('classification_call_attempts as a','a.execution_id','e.id')
      .select(['a.state','a.result_json']).where('e.command_id','=',commandId).where('e.command_scope','=',seed.binding.commandScope).execute();
    if(attempts.some(attempt=>attempt.state==='dispatching'||attempt.state==='unknown'))return terminal(job,context,'outcome_unknown','provider_unknown');
    if(admission.result.status!==200){
      if(admission.result.status===409)return finalize(job,context,calibration,null);
      return terminal(job,context,'failed',failure);
    }
    if(!attempts.length||attempts.some(attempt=>attempt.state!=='succeeded'||(attempt.result_json as {modelVersion?:unknown}|null)?.modelVersion!==calibration.modelVersion)) {
      return terminal(job,context,'obsolete','model_unproven');
    }
    const decision=JSON.parse(Buffer.from(admission.result.body).toString('utf8')) as AutoDecision;
    if(decision.folder!==null||!Array.isArray(decision.tags?.candidates)||decision.tags.candidates.length>15
      ||decision.candidateCoverage.tagIncluded!==decision.candidateCoverage.tagTotal)return terminal(job,context,'failed','invalid_decision');
    return finalize(job,context,calibration,decision);
  };

  async function finalize(job:ClassificationAutoJob,context:OutboxHandlerContext,calibration:ClassificationAutoCalibration,decision:AutoDecision|null):Promise<Disposition>{
    let metric:string|undefined;
    const disposition=await createUnitOfWork(db,{signal:context.signal,cancelBackend:options.cancelBackend}).execute(async({transaction:tx}):Promise<Disposition>=>{
      const ports=createClassificationCanonicalPorts(tx,options),collection=await ports.collections.lockForUpdate(job.collection_id);
      const latest=await tx.selectFrom('collection_classification_tag_jobs').selectAll().where('id','=',job.id).forUpdate().executeTakeFirstOrThrow();
      if(autoJobTerminal(latest))return 'complete';
      if(job.profile_id!==null){
        try{await assertClassificationProfileBinding(tx,{profileId:job.profile_id,revision:job.profile_revision!,ownerSubjectId:job.owner_subject_id});}
        catch{await tx.updateTable('collection_classification_tag_jobs').set({status:'obsolete',failure_code:'profile_changed',completed_at:sql<Date>`clock_timestamp()`}).where('id','=',job.id).execute();
          await fenceClassificationAutoAttempt(tx,latest,context);return 'complete';}
      }
      const node=await ports.nodes.getNode(job.collection_id,job.node_id);
      const settings=await createPostgresClassificationSettingsStore(tx).loadOwned({collectionId:job.collection_id,ownerSubjectId:job.owner_subject_id});
      const stop=async(status:'obsolete'|'skipped',code:string):Promise<Disposition>=>{
        await tx.updateTable('collection_classification_tag_jobs').set({status,failure_code:code,completed_at:sql<Date>`clock_timestamp()`}).where('id','=',job.id).execute();
        await fenceClassificationAutoAttempt(tx,latest,context);metric=`${status}.${code}`;return 'complete';
      };
      const owner=await tx.selectFrom('accounts').select('id').where('id','=',job.principal_id).where('subject_id','=',job.owner_subject_id)
        .where('status','=','active').where('deleted_at','is',null).executeTakeFirst();
      if(!owner)return stop('obsolete','owner_unavailable');
      if(job.expires_at.getTime()<=(await ports.clock.now()).getTime())return stop('skipped','expired');
      if(!policy(job,options.calibration())||JSON.stringify(options.calibration())!==JSON.stringify(calibration))return stop('skipped','policy_changed');
      if(!collection||collection.deletedAt!==null||collection.ownerSubjectId!==job.owner_subject_id||!node||node.deletedAt!==null
        ||node.kind!=='bookmark'||node.resourceRevision!==job.resource_revision)return stop('obsolete','node_changed');
      if(settings?.autoTagMode!=='auto'||settings.revision!==job.settings_revision||settings.providerProfileId!==job.profile_id)return stop('obsolete','settings_changed');
      if(!decision||collection.contentRevision!==decision.taxonomyRevision){
        if(latest.recomputations!==0)return stop('obsolete','taxonomy_changed_twice');
        await tx.updateTable('collection_classification_tag_jobs').set({recomputations:1,status:'pending'}).where('id','=',job.id).execute();
        await fenceClassificationAutoAttempt(tx,latest,context);metric='taxonomy_recompute';return 'recompute';
      }
      const vocabulary=await createClassificationVocabularyPort(tx).existingTags(job.collection_id,decision.tags.candidates.map(candidate=>candidate.tag));
      const tags=selectClassificationAutoTags(decision.tags.candidates,{threshold:calibration.threshold,maxAdded:settings.maxAutoTags,existingTags:node.tags??[],vocabulary});
      if(!tags.length)return stop('skipped','no_eligible_tags');
      const fingerprint=canonicalCommandFingerprint({method:'AUTO-TAG-APPLY',route:job.id,mediaType:'application/json',body:{addTags:tags},conditions:{ifMatch:`"${job.resource_revision}"`}});
      const result=await updateCollectionNode(ports,{actor:{principalId:job.principal_id,subjectId:job.owner_subject_id,principalType:'account'},
        collectionId:job.collection_id,nodeId:job.node_id,ifMatch:`"${job.resource_revision}"`,
        command:{commandId:job.apply_command_id,fingerprint},patch:{tags:[...new Set([...(node.tags??[]),...tags])]}});
      if(result.kind!=='updated'&&result.kind!=='replay')throw new OutboxDeliveryError('retryable','classification_auto_apply_pending');
      await tx.updateTable('collection_classification_tag_jobs').set({status:'applied',completed_at:sql<Date>`clock_timestamp()`,
        selected_tag_count:tags.length,selected_tag_digest:createHash('sha256').update(JSON.stringify(tags)).digest('hex'),failure_code:null}).where('id','=',job.id).execute();
      if(!policy(job,options.calibration()))throw new OutboxDeliveryError('retryable','classification_auto_policy_changed');
      await fenceClassificationAutoAttempt(tx,latest,context);metric='applied';return 'complete';
    });
    if(metric)options.metric(metric);
    return disposition;
  }
}
