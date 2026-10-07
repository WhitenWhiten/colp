/**
 * P4A-I15 durable admission switch store over PostgreSQL.
 *
 * Implements the attachments module's `AttachmentsAdmissionSwitchStore` over
 * the single-row `attachments_operations_switch` table. `transition` is a
 * single-row CAS fenced on `lease_generation`: it only succeeds when the
 * expected generation matches the current row, so a stale operator can never
 * overwrite a newer one (lease fencing). The row is durable — issuance stops
 * and drains are observed by any connection/process, never by killing a
 * process to guess state.
 */
import type { DatabaseRuntime } from './runtime.js';
import type {
  AttachmentsAdmissionSwitchState,
  AttachmentsAdmissionSwitchStore,
} from '../../modules/attachments/index.js';

interface AdmissionSwitchRow {
  admission_enabled: boolean;
  drain_verification: boolean;
  reason: string | null;
  lease_owner: string | null;
  lease_generation: string;
  lease_expires_at: Date | null;
  updated_at: Date;
}

function mapRow(row: AdmissionSwitchRow): AttachmentsAdmissionSwitchState {
  return {
    admissionEnabled: row.admission_enabled,
    drainVerification: row.drain_verification,
    reason: row.reason,
    leaseOwner: row.lease_owner,
    leaseGeneration: row.lease_generation,
    leaseExpiresAtIso: row.lease_expires_at === null ? null : row.lease_expires_at.toISOString(),
    updatedAtIso: row.updated_at.toISOString(),
  };
}

export function createPostgresAttachmentsAdmissionSwitchStore(
  runtime: DatabaseRuntime,
): AttachmentsAdmissionSwitchStore {
  return Object.freeze({
    async read(): Promise<AttachmentsAdmissionSwitchState> {
      const rows = await runtime.pool.query<AdmissionSwitchRow>(`
        select admission_enabled, drain_verification, reason, lease_owner,
               lease_generation::text, lease_expires_at, updated_at
        from attachments_operations_switch
        where switch_id = 'global'
      `);
      if (rows.rows.length === 0) {
        throw new Error('attachments_admission_switch_row_missing');
      }
      return mapRow(rows.rows[0]!);
    },
    async transition(input: {
      readonly expectedLeaseGeneration: string;
      readonly admissionEnabled: boolean;
      readonly drainVerification: boolean;
      readonly reason: string | null;
      readonly leaseOwner: string | null;
      readonly leaseGeneration: string;
      readonly leaseExpiresAtIso: string | null;
    }): Promise<{ outcome: 'updated'; state: AttachmentsAdmissionSwitchState } | { outcome: 'lease_conflict' }> {
      const rows = await runtime.pool.query<AdmissionSwitchRow>(`
        update attachments_operations_switch
        set admission_enabled = $2,
            drain_verification = $3,
            reason = $4,
            lease_owner = $5,
            lease_generation = $6::bigint,
            lease_expires_at = $7,
            updated_at = now()
        where switch_id = 'global'
          and lease_generation = $1::bigint
        returning admission_enabled, drain_verification, reason, lease_owner,
                  lease_generation::text, lease_expires_at, updated_at
      `, [
        input.expectedLeaseGeneration,
        input.admissionEnabled,
        input.drainVerification,
        input.reason,
        input.leaseOwner,
        input.leaseGeneration,
        input.leaseExpiresAtIso,
      ]);
      if (rows.rows.length === 0) return { outcome: 'lease_conflict' };
      return { outcome: 'updated', state: mapRow(rows.rows[0]!) };
    },
  });
}