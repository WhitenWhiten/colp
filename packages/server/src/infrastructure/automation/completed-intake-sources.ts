import { sql } from 'kysely';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import type { AutomationSource } from './source-position-store.js';
/** Verified device receipts may arrive after their canonical source cursor. Join committed effects, not live bookmark counts. */
export async function completedIntakeSources(tx:DatabaseTransaction,ownerId:string,collectionId:string):Promise<AutomationSource[]>{
  return (await sql<AutomationSource>`SELECT DISTINCT f.commit_ordinal AS order_ordinal,f.operation_id,f.commit_ordinal::text,f.source_event_id,f.node_id,f.occurred_at,f.origin,f.facts_version,f.facts_json
    FROM automation_effect_receipts e JOIN automation_runs completed ON completed.id=e.run_id
    JOIN automation_event_facts f ON f.operation_id=e.operation_id
    WHERE completed.owner_id=${ownerId} AND f.collection_id=${collectionId} AND e.step_id='intake' AND f.facts_version=1 AND f.facts_json#>>'{after,kind}'='bookmark'
    AND f.facts_json#>>'{after,ancestryComplete}'='true' AND f.facts_json#>>'{after,resourceRevision}' IS NOT NULL
    AND EXISTS(SELECT 1 FROM automation_rules r JOIN automation_rule_revisions v ON v.id=r.current_revision_id
      JOIN automation_activations a ON a.rule_revision_id=v.id AND a.collection_id=${collectionId}
      WHERE r.owner_id=${ownerId} AND r.desired_state='enabled' AND a.disabled_after_ordinal IS NULL
      AND v.definition_json->>'on'='intake.completed' AND v.definition_json#>>'{trigger,mode}'='countBatch'
      AND f.commit_ordinal>a.after_ordinal AND NOT EXISTS(SELECT 1 FROM automation_admission_receipts receipt
        WHERE receipt.rule_revision_id=v.id AND receipt.source_event_id=f.source_event_id AND receipt.stage='intake.completed'))
    ORDER BY order_ordinal,f.source_event_id LIMIT 11`.execute(tx)).rows;
}
