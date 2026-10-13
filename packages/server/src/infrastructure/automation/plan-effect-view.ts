import { sql } from 'kysely';
import type { EffectReceiptView } from '@know-n/colp/automation';
import { planUndoAvailability, type AutomationActor } from '../../modules/automation/index.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import type { PlacementEffectRow } from './placement-history-store.js';
import type { AutomationPlanOperation } from '../../modules/mcp/index.js';

export async function planEffectView(tx: DatabaseTransaction,actor: AutomationActor,row: PlacementEffectRow): Promise<EffectReceiptView> {
  const plan = (await sql<{ operations_json: AutomationPlanOperation[]; version_id: string | null }>`SELECT m.operations_json,e.version_id FROM mcp_change_plans m
    JOIN automation_effect_receipts e ON e.plan_id=m.plan_id WHERE e.id=${row.id} AND m.status='consumed'`.execute(tx)).rows[0];
  const collection = row.collection_id ? await tx.selectFrom('collections').select(['owner_subject_id','content_revision','deleted_at']).where('id','=',row.collection_id).executeTakeFirst() : undefined;
  const node = row.node_id ? await tx.selectFrom('nodes').select(['resource_revision','parent_id','deleted_at']).where('id','=',row.node_id).where('collection_id','=',row.collection_id!).executeTakeFirst() : undefined;
  const parent = row.before_folder ? await tx.selectFrom('nodes').select(['kind','deleted_at']).where('id','=',row.before_folder.nodeId).where('collection_id','=',row.before_folder.collectionId).executeTakeFirst() : undefined;
  const op = plan?.operations_json[0];
  return { id: row.id,kind: 'plan',status: row.undone_operation_id ? 'reverted' : 'committed',effectDigest: row.effect_digest,operationId: row.operation_id,planId: row.plan_id!,...(plan?.version_id ? { versionId: plan.version_id } : {}),
    ...planUndoAvailability({ currentOwner: !!collection && !collection.deleted_at && collection.owner_subject_id === actor.subjectId,versionLinked: !!plan?.version_id,
      operationTypes: plan?.operations_json.map(op => op.type) ?? [],effectUnitMatches: op?.operationId === row.operation_id && op.collectionId === row.collection_id && op.nodeId === row.node_id,
      contentMatches: collection?.content_revision === row.after_content_revision,resourceMatches: !!node && !node.deleted_at && node.resource_revision === row.after_revision && node.parent_id === row.after_parent_id,
      originalFolderAvailable: !!parent && parent.kind === 'folder' && !parent.deleted_at,reverted: !!row.undone_operation_id }) };
}
