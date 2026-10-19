import { fieldUndoSupported } from './plan-field-undo.js';
import { sql } from 'kysely';
import type { EffectReceiptView } from '@know-n/colp/automation';
import { placementUndoAvailability, planUndoAvailability, type AutomationActor } from '../../modules/automation/index.js';
import type { AutomationPlanOperation } from '../../modules/mcp/index.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import type { PlacementEffectRow } from './placement-history-store.js';

interface EffectRow extends PlacementEffectRow {
  run_id: string; current_owner: boolean; content_matches: boolean; resource_matches: boolean;
  parent_available: boolean; operations_json: AutomationPlanOperation[] | null; verified_version_id: string | null;
}

export async function readRunEffectsBatch(tx: DatabaseTransaction, actor: AutomationActor, ids: string[]) {
  const result = new Map<string, EffectReceiptView[]>();
  if (!ids.length) return result;
  const rows = (await sql<EffectRow>`WITH effects AS (
    SELECT e.*,row_number() OVER(PARTITION BY e.run_id ORDER BY e.created_at DESC,e.id DESC) AS position
    FROM automation_effect_receipts e JOIN automation_runs r ON r.id=e.run_id
    WHERE e.run_id IN (${sql.join(ids)}) AND r.owner_id=${actor.accountId}
  ) SELECT e.*,coalesce(c.owner_subject_id=${actor.subjectId} AND c.deleted_at IS NULL,false) AS current_owner,
    coalesce(c.content_revision=e.after_content_revision,false) AS content_matches,
    coalesce(n.deleted_at IS NULL AND n.kind='bookmark' AND CASE WHEN m.operations_json->0->>'type'='create_annotation'
      THEN a.deleted_at IS NULL AND a.subject_id=e.node_id AND a.resource_revision=e.after_revision
      ELSE n.resource_revision=e.after_revision AND (m.operations_json->0->>'type'='update_node' OR n.parent_id=e.after_parent_id) END,false) AS resource_matches,
    coalesce(p.kind='folder' AND p.deleted_at IS NULL,false) AS parent_available,
    m.operations_json,CASE WHEN m.plan_id IS NOT NULL THEN e.version_id ELSE NULL END AS verified_version_id
    FROM effects e LEFT JOIN collections c ON c.id=e.collection_id
    LEFT JOIN nodes n ON n.collection_id=e.collection_id AND n.id=e.node_id
    LEFT JOIN nodes p ON p.collection_id=e.before_folder->>'collectionId' AND p.id=e.before_folder->>'nodeId'
    LEFT JOIN mcp_change_plans m ON m.plan_id=e.plan_id AND m.status='consumed'
    LEFT JOIN annotations a ON a.collection_id=e.collection_id AND a.id=m.operations_json->0->>'annotationId'
    WHERE e.position<=100 ORDER BY e.run_id,e.created_at DESC,e.id DESC`.execute(tx)).rows;
  for (const row of rows) {
    const op = row.operations_json?.[0];
    const availability = row.plan_id ? planUndoAvailability({
      currentOwner: row.current_owner, versionLinked: !!row.verified_version_id,
      operationTypes: row.operations_json?.map(o => o.type) ?? [],
      effectUnitMatches: op?.operationId === row.operation_id && op.collectionId === row.collection_id && op.nodeId === row.node_id,
      contentMatches: row.content_matches, resourceMatches: row.resource_matches, fieldRestorable: fieldUndoSupported(op),
      originalFolderAvailable: row.parent_available, reverted: !!row.undone_operation_id,
    }) : placementUndoAvailability({
      originalDestinationKnown: row.before_folder !== null, originalDestinationAvailable: row.parent_available,
      currentOwner: row.current_owner, currentResourceMatches: row.resource_matches,
      currentContentMatches: row.content_matches, alreadyReverted: row.undone_operation_id !== null,
    });
    const view: EffectReceiptView = { id: row.id, kind: row.plan_id ? 'plan' : 'placement',
      status: row.undone_operation_id ? 'reverted' : 'committed', effectDigest: row.effect_digest, operationId: row.operation_id,
      ...(row.plan_id ? { planId: row.plan_id } : {}), ...(row.verified_version_id ? { versionId: row.verified_version_id } : {}), ...availability };
    result.set(row.run_id, [...(result.get(row.run_id) ?? []), view]);
  }
  return result;
}
