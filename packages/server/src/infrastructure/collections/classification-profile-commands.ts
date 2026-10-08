import {createHash,randomUUID} from 'node:crypto';
import {sql,type Kysely} from 'kysely';
import {assertCanonicalCommandId,canonicalCommandFingerprint,type ProductCommandResult} from '../../modules/commands/index.js';
import {CollectionPreconditionError,ClassificationProfileError,type ClassificationProfileCommand,type ClassificationProfileResult} from '../../modules/collections/index.js';
import type {DatabaseSchema} from '../database/runtime.js';
import {createUnitOfWork,type DatabaseTransaction} from '../database/unit-of-work.js';
import {createPostgresProductCommandReceiptPort} from '../database/product-command-receipt.js';
import type {ClassificationSecretProtector} from '../security/classification-secret-envelope.js';
import {classificationProfileEtag,classificationProfileView,parseClassificationProfileDocument,type ClassificationProfileRow} from './classification-profile-records.js';
export const profileCommandScope=(method:string)=>`accounts:classification-profile:${method}:v1`;
export const profileCommandResult=(status:number,body:unknown,etag?:string,location?:string):ProductCommandResult=>({status,body:status===204?Buffer.alloc(0):Buffer.from(JSON.stringify(body)),
  mediaType:'application/json',contractVersion:'1.0.0',stableHeaders:{'cache-control':'private, no-store',...(status===204?{}:{'content-type':'application/json; charset=utf-8'}),...(etag?{etag}:{}),...(location?{location}:{})}});
export async function lockClassificationProfileOwner(tx:DatabaseTransaction,subjectId:string,activeOnly=true){
  let query=tx.selectFrom('accounts').select(['id','status','deleted_at']).where('subject_id','=',subjectId);
  if(activeOnly)query=query.where('status','=','active').where('deleted_at','is',null);
  const owner=await query.forUpdate().executeTakeFirst();
  if(!owner)throw new ClassificationProfileError('resource_not_found');return owner;
}
export async function listClassificationProfiles(db:Kysely<DatabaseSchema>,ownerSubjectId:string){
  const rows=await db.selectFrom('classification_provider_profiles').selectAll().where('owner_subject_id','=',ownerSubjectId).orderBy('id').execute();
  const profiles=rows.map(classificationProfileView);return {profiles,etag:`"classification-profiles:${createHash('sha256').update(JSON.stringify(profiles)).digest('base64url')}"`};
}
export function createClassificationProfileCommands(db:Kysely<DatabaseSchema>,protector:ClassificationSecretProtector){
  const unit=createUnitOfWork(db);
  return {
    list:(ownerSubjectId:string)=>listClassificationProfiles(db,ownerSubjectId),
    async mutate(method:'create'|'update'|'delete',input:ClassificationProfileCommand):Promise<ClassificationProfileResult>{
      const document=method==='delete'?{}:parseClassificationProfileDocument(input.document,method==='create');
      // The raw write-only secret is never a canonical fingerprint input or receipt field.
      const {secret,...publicDocument}=document;
      const redacted=Object.hasOwn(document,'secret')?{...publicDocument,secretFingerprint:secret===null?null:protector.fingerprint(secret!)}:publicDocument;
      const commandId=assertCanonicalCommandId(input.commandId),binding={principalId:input.actor.principalId,commandScope:profileCommandScope(method),commandId};
      const fingerprint=canonicalCommandFingerprint({method,route:input.profileId??'/me/classification-provider-profiles',mediaType:'application/json',body:redacted,conditions:{ifMatch:input.ifMatch??null}});
      return unit.execute(async({transaction:tx})=>{
        const owner=await lockClassificationProfileOwner(tx,input.actor.subjectId);if(owner.id!==input.actor.principalId)throw new ClassificationProfileError('resource_not_found');
        const receipts=createPostgresProductCommandReceiptPort(tx),claim=await receipts.claim(binding,fingerprint);
        if(claim.kind!=='claimed')return claim;
        let row:ClassificationProfileRow;
        if(method==='create'){
          const count=await tx.selectFrom('classification_provider_profiles').select(({fn})=>fn.countAll<string>().as('count')).where('owner_subject_id','=',input.actor.subjectId).executeTakeFirstOrThrow();
          if(Number(count.count)>=10)throw new ClassificationProfileError('mutation_conflict');
          const id=randomUUID(),envelope=protector.protect(secret!,{ownerSubjectId:input.actor.subjectId,profileId:id});
          row=await tx.insertInto('classification_provider_profiles').values({id,owner_subject_id:input.actor.subjectId,label:document.label!,kind:'cloudflare_ai_gateway',
            protocol:'cloudflare_ai_run_v1',model:'typesafe/jev',config_json:document.config!,secret_envelope:envelope,secret_fingerprint:protector.fingerprint(secret!),status:'disabled',last_tested_at:null}).returningAll().executeTakeFirstOrThrow();
        }else{
          const current=await tx.selectFrom('classification_provider_profiles').selectAll().where('id','=',input.profileId!).where('owner_subject_id','=',input.actor.subjectId).forUpdate().executeTakeFirst();
          if(!current)throw new ClassificationProfileError('resource_not_found');
          if(input.ifMatch!==classificationProfileEtag(current))throw new CollectionPreconditionError({currentEtag:classificationProfileEtag(current),precondition:'resource',message:'Provider profile changed.'});
          if(method==='delete'){
            const referenced=await tx.selectFrom('collection_classification_settings').select('collection_id').where('provider_profile_id','=',current.id).executeTakeFirst();
            if(referenced)throw new ClassificationProfileError('mutation_conflict');
            await tx.deleteFrom('classification_provider_profiles').where('id','=',current.id).execute();
            const result=profileCommandResult(204,null);await receipts.complete(binding,fingerprint,result);return {kind:'succeeded',result};
          }
          const invalidates=Object.hasOwn(document,'secret')||Object.hasOwn(document,'model')||Object.hasOwn(document,'config');
          row=await tx.updateTable('classification_provider_profiles').set({label:document.label??current.label,model:document.model??current.model,config_json:document.config??current.config_json,
            ...(Object.hasOwn(document,'secret')?{secret_envelope:secret===null?null:protector.protect(secret!,{ownerSubjectId:input.actor.subjectId,profileId:current.id}),
              secret_fingerprint:secret===null?null:protector.fingerprint(secret!)}:{}),revision:sql`revision+1`,updated_at:sql`clock_timestamp()`,
            ...(invalidates?{status:'disabled' as const,last_tested_at:null}:{})}).where('id','=',current.id).returningAll().executeTakeFirstOrThrow();
        }
        const result=profileCommandResult(method==='create'?201:200,classificationProfileView(row),classificationProfileEtag(row),method==='create'?`/api/v1/me/classification-provider-profiles/${row.id}`:undefined);
        await receipts.complete(binding,fingerprint,result);return {kind:'succeeded',result};
      });
    },
  };
}
