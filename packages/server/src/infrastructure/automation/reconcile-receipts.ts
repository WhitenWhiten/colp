import { sql } from 'kysely';
import type { LocalReceiptInput } from '@know-n/colp/automation';
import type { AutomationDeviceActor } from '../../modules/automation/index.js';
import type { InspectAutomationSource } from './source-position-store.js';
import { verifyIntakeReceipt } from './intake-receipt-store.js';
import { recordDevicePlacementRun } from './device-placement-run.js';
/** Revisit waiting evidence on either canonical operation's arrival, before fallback admission. */
export function createReceiptReconciler(serverUuid: string): InspectAutomationSource {
  return async (tx, owner, collectionId, sources) => {
    const operations = sources.map(source => source.operation_id);
    if (!operations.length) return;
    const rows = (await sql<{ id: string; receipt_json: { input: LocalReceiptInput; actor: AutomationDeviceActor } }>`
      SELECT id,receipt_json FROM automation_intake_receipts WHERE owner_id=${owner.accountId} AND state='waitingForSync'
        AND receipt_json->'input'->'committedNode'->>'collectionId'=${collectionId}
        AND (operation_id=ANY(${operations}::text[]) OR receipt_json->'input'->>'placementOperationId'=ANY(${operations}::text[]))
      ORDER BY id LIMIT 1001 FOR UPDATE`.execute(tx)).rows;
    if (rows.length > 1000) throw new Error('Automation receipt reconciliation bound exceeded');
    for (const row of rows) {
      const { actor, input } = row.receipt_json;
      const replica = await tx.selectFrom('sync_replicas').select(['lease_generation', 'status', 'account_id'])
        .where('replica_id', '=', actor.replicaId).executeTakeFirst();
      const result = !replica || replica.account_id !== owner.accountId || String(replica.lease_generation) !== actor.replicaGeneration
        || !['active','recovery_required'].includes(replica.status)
        ? { receiptId: row.id, state: 'review' as const, satisfiedTaskTypes: [], diagnostics: [{ code: 'generationChanged',
          severity: 'warning' as const, location: '/', message: 'Device replica generation is no longer current.' }] }
        : await verifyIntakeReceipt(tx, actor, serverUuid, input, row.id);
      if (result.state === 'accepted') await recordDevicePlacementRun(tx, actor, input);
      await sql`UPDATE automation_intake_receipts SET state=${result.state},receipt_json=${JSON.stringify({ input, actor, result })}::jsonb
        WHERE id=${row.id}`.execute(tx);
    }
  };
}
