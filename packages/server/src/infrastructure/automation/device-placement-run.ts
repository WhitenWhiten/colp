import { recordPlacementHistory } from './placement-history-store.js';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { LocalReceiptInput } from '@know-n/colp/automation';
import type { AutomationDeviceActor } from '../../modules/automation/index.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
/** Called only after canonical device evidence verification, under owner serialization. */
export async function recordDevicePlacementRun(tx: DatabaseTransaction, actor: AutomationDeviceActor, input: LocalReceiptInput): Promise<void> {
  const revision = await tx.selectFrom('automation_rule_revisions').select(['id', 'binding_set_id'])
    .where('rule_id', '=', input.ruleId).where('revision', '=', input.ruleRevision).where('owner_id', '=', actor.accountId).executeTakeFirstOrThrow();
  const fact = (await sql<{ source_event_id: string }>`SELECT source_event_id FROM automation_event_facts
    WHERE operation_id=${input.operationId}`.execute(tx)).rows[0]!;
  await sql`INSERT INTO automation_admission_receipts(rule_revision_id,source_event_id,stage,decision,run_id)
    VALUES (${revision.id},${fact.source_event_id},'intake','verifiedDevicePlacement',NULL) ON CONFLICT DO NOTHING`.execute(tx);
  const receipt = (await sql<{ run_id: string | null }>`SELECT run_id FROM automation_admission_receipts
    WHERE rule_revision_id=${revision.id} AND source_event_id=${fact.source_event_id} AND stage='intake' FOR UPDATE`.execute(tx)).rows[0]!;
  if (receipt.run_id) {
    await sql`UPDATE automation_runs SET state='completed', revision=revision+1, updated_at=clock_timestamp(),
      explanation_json=explanation_json || ${JSON.stringify({ devicePlacementOperationId: input.placementOperationId ?? input.operationId,
        verifiedDevicePlacement: true, inputDigest: input.inputDigest })}::jsonb
      WHERE id=${receipt.run_id} AND state='waiting'`.execute(tx);
    await recordPlacementHistory(tx, actor, input.committedNode.serverUuid, receipt.run_id, input.placementOperationId ?? input.operationId);
    return; // Late evidence cannot recreate completed or cancelled work.
  }
  const id = randomUUID();
  await sql`INSERT INTO automation_runs(id,owner_id,kind,rule_revision_id,binding_set_id,binding_revision,policy_revision,member_ids,state,explanation_json)
    VALUES (${id},${actor.accountId},'intake',${revision.id},${revision.binding_set_id},${input.bindingRevision}::bigint,NULL,
      ${JSON.stringify([fact.source_event_id])}::jsonb,'completed',${JSON.stringify({ collectionId: actor.collectionId,
        nodeId: input.committedNode.nodeId, causationRoot: id, operationId: input.operationId, devicePlacementOperationId: input.placementOperationId ?? input.operationId,
        verifiedDevicePlacement: true, inputDigest: input.inputDigest })}::jsonb)`.execute(tx);
  await sql`UPDATE automation_admission_receipts SET run_id=${id},decision='verifiedDevicePlacement'
    WHERE rule_revision_id=${revision.id} AND source_event_id=${fact.source_event_id} AND stage='intake'`.execute(tx);
  await recordPlacementHistory(tx, actor, input.committedNode.serverUuid, id, input.placementOperationId ?? input.operationId);
}
