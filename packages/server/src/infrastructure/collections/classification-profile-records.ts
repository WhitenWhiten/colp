import type {Selectable} from 'kysely';
import {ClassificationProfileError,type ClassificationProviderProfile} from '../../modules/collections/index.js';
import type {ClassificationProviderProfileTable} from '../database/classification-profile-tables.js';
export type ClassificationProfileRow=Selectable<ClassificationProviderProfileTable>;
export type ClassificationProfileConfig={accountId:string;gatewayId:string};
const invalid=():never=>{throw new ClassificationProfileError('invalid_document');};
export function parseClassificationProfileDocument(value:unknown,create:boolean){
  if(!value||typeof value!=='object'||Array.isArray(value))return invalid();
  const raw=value as Record<string,unknown>,allowed=create?['kind','label','model','config','secret']:['label','model','config','secret'];
  if(!Object.keys(raw).length||Object.keys(raw).some(key=>!allowed.includes(key))||(create&&allowed.some(key=>!Object.hasOwn(raw,key))))return invalid();
  if(create&&raw.kind!=='cloudflare_ai_gateway')return invalid();
  if(Object.hasOwn(raw,'label')&&(typeof raw.label!=='string'||!raw.label.trim()||[...raw.label].length>80))return invalid();
  if(Object.hasOwn(raw,'model')&&raw.model!=='typesafe/jev')return invalid();
  if(Object.hasOwn(raw,'secret')&&!(raw.secret===null&&!create)&&(typeof raw.secret!=='string'||!raw.secret||Buffer.byteLength(raw.secret)>4096||/[\r\n\0]/u.test(raw.secret)))return invalid();
  if(Object.hasOwn(raw,'config'))parseClassificationProfileConfig(raw.config);
  return raw as {kind?:'cloudflare_ai_gateway';label?:string;model?:'typesafe/jev';config?:ClassificationProfileConfig;secret?:string|null};
}
export function parseClassificationProfileConfig(value:unknown):ClassificationProfileConfig {
  if(!value||typeof value!=='object'||Array.isArray(value))return invalid();
  const config=value as Record<string,unknown>;
  if(Object.keys(config).length!==2||typeof config.accountId!=='string'||!/^[a-f0-9]{32}$/iu.test(config.accountId)
    ||typeof config.gatewayId!=='string'||!/^[a-z0-9_-]{1,64}$/iu.test(config.gatewayId))return invalid();
  return {accountId:config.accountId,gatewayId:config.gatewayId};
}
export const classificationProfileEtag=(row:ClassificationProfileRow)=>`"classification-profile:${row.id}:${row.revision}"`;
export function classificationProfileView(row:ClassificationProfileRow):ClassificationProviderProfile {
  return {profileId:row.id,label:row.label,kind:row.kind,protocol:row.protocol,model:row.model,
    capabilities:['folder_choice','tag_noul','confidence'],status:row.status,endpointHost:'api.cloudflare.com',
    lastTestedAt:row.last_tested_at?.toISOString()??null,createdAt:row.created_at.toISOString(),updatedAt:row.updated_at.toISOString(),etag:classificationProfileEtag(row)};
}
