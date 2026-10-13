import { sql } from 'kysely';
import type { ReceiptIngestResult } from '@know-n/colp/automation';
import type { DatabaseTransaction } from '../database/unit-of-work.js';

export const MAX_WAITING_INTAKE_RECEIPTS = 1000;
export const RECEIPT_RECONCILIATION_SLICE = 10;

/**
 * The caller holds the Owner account lock. Reclaim only evidence that can no
 * longer be accepted under its immutable pins; never rewrite the input, delete
 * history, or infer that missing Sync operations committed successfully.
 */
export async function retireUnavailableWaitingReceipts(tx: DatabaseTransaction, ownerId: string): Promise<number> {
  const stale = (await sql<{ id: string; reason: string }>`
    SELECT i.id, CASE
      WHEN r.replica_id IS NULL OR r.account_id <> i.owner_id
        OR r.lease_generation <> i.replica_generation OR r.status NOT IN ('active','recovery_required')
        THEN 'generationChanged'
      WHEN b.revision IS NULL OR b.snapshot_json IS NULL OR b.paused THEN 'bundleUnavailable'
      WHEN b.expires_at <= clock_timestamp() THEN 'bundleExpired'
      ELSE 'configurationChanged' END AS reason
    FROM automation_intake_receipts i
    LEFT JOIN sync_replicas r ON r.replica_id=i.receipt_json#>>'{actor,replicaId}'
    LEFT JOIN automation_device_bundles b ON b.owner_id=i.owner_id AND b.device_id=i.device_id
      AND b.revision=(i.receipt_json#>>'{input,bundleRevision}')::bigint
    LEFT JOIN automation_configuration_epochs e ON e.owner_id=i.owner_id
    WHERE i.owner_id=${ownerId} AND i.state='waitingForSync' AND (
      r.replica_id IS NULL OR r.account_id <> i.owner_id OR r.lease_generation <> i.replica_generation
      OR r.status NOT IN ('active','recovery_required') OR b.revision IS NULL OR b.snapshot_json IS NULL
      OR b.paused OR b.expires_at <= clock_timestamp() OR b.settings_revision <> coalesce(e.revision,0))
    ORDER BY i.id LIMIT ${MAX_WAITING_INTAKE_RECEIPTS} FOR UPDATE OF i`.execute(tx)).rows;
  if (!stale.length) return 0;
  const updates = stale.map(row => {
    const result: ReceiptIngestResult = { receiptId: row.id, state: 'review', satisfiedTaskTypes: [], diagnostics: [{
      code: row.reason, severity: 'warning', location: '/',
      message: 'Waiting evidence is no longer eligible under its original device or bundle pins. No effect was inferred.',
    }] };
    return { id: row.id, result };
  });
  await sql`UPDATE automation_intake_receipts i SET state='review',
    receipt_json=jsonb_set(i.receipt_json,'{result}',changes.result)
    FROM jsonb_to_recordset(${JSON.stringify(updates)}::jsonb) AS changes(id text,result jsonb)
    WHERE i.id=changes.id AND i.owner_id=${ownerId} AND i.state='waitingForSync'`.execute(tx);
  return stale.length;
}
