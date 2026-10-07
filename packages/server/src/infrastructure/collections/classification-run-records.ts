import type { Kysely,Selectable } from 'kysely';
import { sql } from 'kysely';
import { ClassificationError,type ClassificationCreditUsage,type ClassificationRun,type ClassificationRunSnapshot } from '../../modules/collections/index.js';
import type { DatabaseSchema } from '../database/runtime.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import type { ClassificationRunTable } from '../database/classification-run-tables.js';
import type { ClassificationRunCreditsFactory } from './classification-run-billing.js';
export type ClassificationRunRow=Selectable<ClassificationRunTable>;
export const classificationRunEtag=(row:Pick<ClassificationRunRow,'id'|'revision'>)=>`"classification-run:${row.id}:${row.revision}"`;
export async function readClassificationRunRow(db:Kysely<DatabaseSchema>|DatabaseTransaction,input:{collectionId:string;runId:string;ownerSubjectId:string},lock=false){
  let query=db.selectFrom('collection_classification_runs as r').innerJoin('collections as c','c.id','r.collection_id')
    .selectAll('r').where('r.id','=',input.runId).where('r.collection_id','=',input.collectionId)
    .where('r.owner_subject_id','=',input.ownerSubjectId).where('c.owner_subject_id','=',input.ownerSubjectId)
    .where('c.deleted_at','is',null).where('r.expires_at','>',sql<Date>`clock_timestamp()`);
  if(lock)query=query.forUpdate('r');
  const row=await query.executeTakeFirst();if(!row)throw new ClassificationError('resource_not_found');return row;
}
export async function classificationRunDto(db:Kysely<DatabaseSchema>|DatabaseTransaction,row:ClassificationRunRow,
  options:{readonly credits?:ClassificationRunCreditsFactory}={}):Promise<ClassificationRun>{
  const actions=await db.selectFrom('collection_classification_run_actions').selectAll().where('run_id','=',row.id).orderBy('ordinal').execute();
  const usage=await readCreditUsage(db,row,actions,options.credits);
  return {runId:row.id,etag:classificationRunEtag(row),status:row.status,
    failureCode:row.failure_code,taxonomyRevision:row.taxonomy_revision,
    provider:{providerId:row.provider_id,model:row.model,policyVersion:row.policy_version,promptVersion:row.prompt_version},
    createdAt:row.created_at.toISOString(),deadlineAt:row.deadline_at.toISOString(),expiresAt:row.expires_at.toISOString(),
    actions:actions.map(action=>({actionId:action.action_id,nodeId:action.node_id,nodeEtag:action.node_etag,sourceParentId:action.source_parent_id,
      status:action.status,decision:action.decision_json,failureCode:action.failure_code,
      ...(row.billing_mode==='legacy_free'?{}:{creditChargeId:action.credit_charge_id})})),
    ...(usage===null?{}:{creditUsage:usage})};
}

async function readCreditUsage(
  db:Kysely<DatabaseSchema>|DatabaseTransaction,
  row:ClassificationRunRow,
  actions:readonly { readonly credit_charge_id:string|null }[],
  creditsFactory?:ClassificationRunCreditsFactory,
):Promise<ClassificationCreditUsage|null>{
  if(row.billing_mode==='legacy_free')return null;
  const chargeIds=actions.map(action=>action.credit_charge_id).filter((id):id is string=>id!==null);
  if(chargeIds.length===0)return {mode:row.billing_mode,priceVersion:row.price_version,quotedPoints:Number(row.quoted_points),reservedPoints:0,chargedPoints:0,releasedPoints:0};
  if(creditsFactory===undefined)throw new Error('managed run usage requires account credits wiring');
  const totals=await creditsFactory(db as DatabaseTransaction,row.principal_id).totals(chargeIds);
  const usage={reservedPoints:totals.reserved,chargedPoints:totals.settled,releasedPoints:totals.released};
  return {mode:row.billing_mode,priceVersion:row.price_version,quotedPoints:Number(row.quoted_points),...usage};
}

/** JSONB is untrusted at the storage boundary; provider execution still rebuilds its candidate allowlists. */
export function decodeClassificationRunSnapshot(value:unknown):ClassificationRunSnapshot|null {
  if(value===null)return null;
  const object=(input:unknown):input is Record<string,unknown>=>Boolean(input)&&typeof input==='object'&&!Array.isArray(input);
  if(!object(value)||!object(value.taxonomy)||!object(value.requested)||!Array.isArray(value.nodes)||!value.nodes.length||value.nodes.length>50
    ||typeof value.requested.folder!=='boolean'||typeof value.requested.tags!=='boolean'||!Array.isArray(value.taxonomy.folders)
    ||!Array.isArray(value.taxonomy.tagUsage)||!object(value.taxonomy.settings)||typeof value.taxonomy.collectionId!=='string'
    ||typeof value.taxonomy.contentRevision!=='string'||value.nodes.some(node=>!object(node)||typeof node.id!=='string'
      ||typeof node.parentId!=='string'||typeof node.resourceRevision!=='string'||typeof node.title!=='string'||typeof node.url!=='string'
      ||!Array.isArray(node.tags)||node.tags.some(tag=>typeof tag!=='string'))
    ||value.taxonomy.tagUsage.some(tag=>!object(tag)||typeof tag.tag!=='string'||typeof tag.count!=='number'))throw new ClassificationError('contract_drift');
  return value as unknown as ClassificationRunSnapshot;
}
