import type {Kysely} from 'kysely';
import {ClassificationProviderError,type BookmarkClassificationProvider,type ClassificationTaxonomySnapshot} from '../../modules/collections/index.js';
import type {DatabaseSchema} from '../database/runtime.js';
import type {DatabaseTransaction} from '../database/unit-of-work.js';
import type {ClassificationSecretEnvelope,ClassificationSecretProtector} from '../security/classification-secret-envelope.js';
import {createCloudflareJevClassificationProvider, createCloudflareUpstream} from './classification-provider-factory.js';
import {parseClassificationProfileConfig} from './classification-profile-records.js';
export async function readClassificationProfileBinding(db:Kysely<DatabaseSchema>|DatabaseTransaction,profileId:string,ownerSubjectId:string){
  const row=await db.selectFrom('classification_provider_profiles').select(['id','revision']).where('id','=',profileId).where('owner_subject_id','=',ownerSubjectId)
    .where('status','=','active').where('secret_envelope','is not',null).executeTakeFirst();
  if(!row)throw new ClassificationProviderError('configuration_changed');return {profileId:row.id,revision:String(row.revision),ownerSubjectId};
}
export async function assertClassificationProfileBinding(tx:DatabaseTransaction,binding:ClassificationTaxonomySnapshot['providerBinding']){
  if(!binding)return;
  const profile=await tx.selectFrom('classification_provider_profiles as p').innerJoin('accounts as a','a.subject_id','p.owner_subject_id')
    .select('p.id').where('p.id','=',binding.profileId).where('p.owner_subject_id','=',binding.ownerSubjectId).where('p.revision','=',BigInt(binding.revision))
    .where('p.status','=','active').where('p.secret_envelope','is not',null).where('a.status','=','active').where('a.deleted_at','is',null).forShare('p').executeTakeFirst();
  if(!profile)throw new ClassificationProviderError('configuration_changed');
}
export function createProfileAwareClassificationProvider(db:Kysely<DatabaseSchema>,deployment:BookmarkClassificationProvider,protector:ClassificationSecretProtector|null,
  options:{enabled:()=>boolean;transport?:typeof fetch}):BookmarkClassificationProvider {
  return {...deployment,async classify(input,execution){
    const profileId=input.snapshot.settings.providerProfileId;
    if(input.snapshot.settings.executionMode==='server_managed'){
      if(profileId!==null||input.snapshot.providerBinding)throw new ClassificationProviderError('configuration_changed');
      return deployment.classify(input,execution);
    }
    const binding=input.snapshot.providerBinding;
    if(!options.enabled()||!protector||!profileId||!binding||binding.profileId!==profileId)throw new ClassificationProviderError('configuration_changed');
    const profile=await db.selectFrom('classification_provider_profiles').selectAll().where('id','=',profileId).where('owner_subject_id','=',binding.ownerSubjectId)
      .where('revision','=',BigInt(binding.revision)).where('status','=','active').executeTakeFirst();
    if(!profile?.secret_envelope)throw new ClassificationProviderError('configuration_changed');
    try{return await protector.withSecret(profile.secret_envelope as ClassificationSecretEnvelope,binding,async secret=>{
      // Alias semantics: the profile selects a catalogue model, not a pinned upstream version.
      const upstream=createCloudflareUpstream({...parseClassificationProfileConfig(profile.config_json),accessKey:secret});
      const adapter=createCloudflareJevClassificationProvider(upstream,options.transport);
      const output=await adapter.classify(input,execution);
      if(!options.enabled())throw new ClassificationProviderError('disabled');return output;
    });}catch(error){if(error instanceof ClassificationProviderError)throw error;throw new ClassificationProviderError('credentials');}
  }};
}
