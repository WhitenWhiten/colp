import { sql } from 'kysely';
import type { LocalReceiptInput } from '@know-n/colp/automation';
import type { AutomationDeviceActor } from '../../modules/automation/index.js';
import type { InspectAutomationSource } from './source-position-store.js';
import { verifyIntakeReceipt } from './intake-receipt-store.js';
import { recordDevicePlacementRun } from './device-placement-run.js';
import { retireUnavailableWaitingReceipts, RECEIPT_RECONCILIATION_SLICE } from './receipt-waiting.js';

/**
 * The receipt ledger is the work queue; a source slice is only a wake-up. Revisit
 * complete evidence even after its source cursor passed, including resume/retry
 * calls with no new sources. The Owner lock serializes this with device intake.
 */
export function createReceiptReconciler(serverUuid: string): InspectAutomationSource {
  return async (tx, owner, collectionId) => {
    await retireUnavailableWaitingReceipts(tx, owner.accountId);
    const settings = await tx.selectFrom('automation_settings').select('paused')
      .where('owner_id', '=', owner.accountId).executeTakeFirst();
    if (settings?.paused) return false;
    const rows = (await sql<{ id: string; receipt_json: { input: LocalReceiptInput; actor: AutomationDeviceActor } }>`
      SELECT i.id,i.receipt_json FROM automation_intake_receipts i
      JOIN automation_event_facts created ON created.operation_id=i.operation_id
      LEFT JOIN automation_event_facts placed ON placed.operation_id=i.receipt_json#>>'{input,placementOperationId}'
      WHERE i.owner_id=${owner.accountId} AND i.state='waitingForSync'
        AND i.receipt_json#>>'{input,committedNode,collectionId}'=${collectionId}
        AND (i.receipt_json#>>'{input,placementOperationId}' IS NULL OR placed.operation_id IS NOT NULL)
      ORDER BY i.id LIMIT ${RECEIPT_RECONCILIATION_SLICE + 1} FOR UPDATE OF i`.execute(tx)).rows;
    for (const row of rows.slice(0, RECEIPT_RECONCILIATION_SLICE)) {
      const { actor, input } = row.receipt_json;
      const result = await verifyIntakeReceipt(tx, actor, serverUuid, input, row.id);
      if (result.state === 'accepted') await recordDevicePlacementRun(tx, actor, input);
      await sql`UPDATE automation_intake_receipts SET state=${result.state},receipt_json=${JSON.stringify({ input, actor, result })}::jsonb
        WHERE id=${row.id}`.execute(tx);
    }
    return rows.length > RECEIPT_RECONCILIATION_SLICE;
  };
}
