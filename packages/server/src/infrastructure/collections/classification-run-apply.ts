import { withCanonicalTreeCapacityBatch } from './canonical-tree-capacity.js';
import { createClassificationEvidencePort } from './classification-evidence-postgres.js';
import { assertClassificationProfileBinding } from './classification-profile-provider.js';
import { sql,type Kysely } from 'kysely';
import { applyCollectionClassificationRun,ClassificationError,NodeConflictError,type ClassificationRunApplyInput,type BookmarkClassificationProvider } from '../../modules/collections/index.js';
import type { DatabaseSchema } from '../database/runtime.js';
import { type UnitOfWorkOptions } from '../database/unit-of-work.js';
import type { ReportSourceInvalidationOutboxPort } from '../outbox/report-source-invalidation-producer.js';
import { createClassificationCanonicalPorts } from './classification-canonical-ports.js';
import { createClassificationVocabularyPort } from './classification-confirmation-postgres.js';
import { createPostgresClassificationSettingsStore } from './classification-settings-postgres.js';
import { classificationRunDto,classificationRunEtag,readClassificationRunRow,decodeClassificationRunSnapshot } from './classification-run-records.js';
import { lockRunContext, classificationRunApplyTimeoutMs, createClassificationRunUnitOfWork, lockRunCredits, type ClassificationRunCreditsFactory } from './classification-run-billing.js';

export function createClassificationRunApply(db:Kysely<DatabaseSchema>,provider:BookmarkClassificationProvider,options:{
  readonly profilesEnabled?:()=>boolean;readonly enabled:()=>boolean;readonly tagsEnabled:()=>boolean;readonly reportSourceInvalidation?:ReportSourceInvalidationOutboxPort;
  readonly faultInjector?:UnitOfWorkOptions['faultInjector'];readonly credits?:ClassificationRunCreditsFactory;readonly creditEnabled?:boolean;
  readonly cancelBackend?:UnitOfWorkOptions['cancelBackend'];
}){
  return (input:ClassificationRunApplyInput)=>{
    // Size the transaction budget from the document this request actually carries;
    // the wrapper owns lock_timeout/statement_timeout for the transaction.
    const selections=(input.document as {readonly selections?:unknown}|null|undefined)?.selections;
    const admitted=Array.isArray(selections)?selections.length:0;
    return createClassificationRunUnitOfWork(db,{...options,transactionTimeoutMs:classificationRunApplyTimeoutMs(admitted)}).execute(async({transaction:tx})=>{
    const account=await tx.selectFrom('accounts').select(['id','status','deleted_at']).where('id','=',input.actor.principalId)
      .where('subject_id','=',input.actor.subjectId).forShare().executeTakeFirst();
    if(!account||account.status!=='active'||account.deleted_at!==null)throw new ClassificationError('resource_not_found');
    const owned=await tx.selectFrom('collections').select('id').where('id','=',input.collectionId).where('owner_subject_id','=',input.actor.subjectId)
      .where('deleted_at','is',null).executeTakeFirst();
    if(!owned)throw new ClassificationError('resource_not_found');
    const owner=await tx.selectFrom('collection_classification_runs').select(['principal_id','billing_mode']).where('id','=',input.runId)
      .where('collection_id','=',input.collectionId).where('principal_id','=',input.actor.principalId).executeTakeFirst();
    if(owner)await lockRunCredits(tx,{credits:options.credits,creditEnabled:options.creditEnabled},{accountId:owner.principal_id,chargeId:null,mode:owner.billing_mode});
    let usesProfile=false;
    return withCanonicalTreeCapacityBatch(tx,input.collectionId,treeCapacityAdmission=>applyCollectionClassificationRun({evidence:createClassificationEvidencePort(tx),collection:createClassificationCanonicalPorts(tx,{...options,treeCapacityAdmission}),vocabulary:createClassificationVocabularyPort(tx),
      settings:createPostgresClassificationSettingsStore(tx),enabled:()=>options.enabled()&&(!usesProfile||options.profilesEnabled?.()===true),tagsEnabled:options.tagsEnabled,
      runs:{
        async lock(identity){
          const discovered=await readClassificationRunRow(tx,identity);
          await lockRunContext(tx,discovered.id,discovered.collection_id);
          const row=await readClassificationRunRow(tx,identity,true),snapshot=decodeClassificationRunSnapshot(row.snapshot_json);
          usesProfile=Boolean(snapshot?.taxonomy.providerBinding);
          try{await assertClassificationProfileBinding(tx,snapshot?.taxonomy.providerBinding);}catch{throw new NodeConflictError('revision_conflict','Classification profile changed.');}
          return {run:await classificationRunDto(tx,row),snapshot,settingsRevision:row.settings_revision,candidateVersion:row.candidate_version};
        },
        async markApplied(runId){const row=await tx.updateTable('collection_classification_runs').set({status:'applied',revision:sql<bigint>`revision+1`})
          .where('id','=',runId).where('status','=','open').returningAll().executeTakeFirstOrThrow();return classificationRunEtag(row);},
        configurationMatches:run=>run.provider.providerId===provider.id&&run.provider.model===provider.model
          &&run.provider.policyVersion===provider.policyVersion&&run.provider.promptVersion===provider.promptVersion,
      },
    },input));
    });
  };
}
