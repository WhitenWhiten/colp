import { sql } from 'kysely';
import type {
  FaviconPolicyMode,
  FaviconPolicyReadPort,
  FaviconPolicyRow,
  FaviconPolicyWritePort,
} from '../../modules/collections/index.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';

interface PolicyRow {
  account_id: string;
  new_default: FaviconPolicyMode;
  provider_template: string;
  fill_missing: boolean;
  force_all_online: boolean;
  revision: string;
  updated_at: Date;
}

function mapPolicy(row: PolicyRow): FaviconPolicyRow {
  return Object.freeze({
    accountId: row.account_id,
    newDefault: row.new_default,
    providerTemplate: row.provider_template,
    fillMissing: row.fill_missing,
    forceAllOnline: row.force_all_online,
    revision: BigInt(row.revision),
    updatedAt: row.updated_at,
  });
}

const POLICY_COLUMNS = sql`account_id, new_default, provider_template, fill_missing,
  force_all_online, revision, updated_at`;

/**
 * FO-01 account favicon policy storage adapter. The row is lazy: a missing row
 * exposes virtual revision 1 and the first CAS write inserts with revision 2.
 * Concurrent first writes serialize through the unique account_id key; a unique
 * violation is resolved to a stale read instead of an error.
 */
export function createPostgresFaviconPolicyPort(transaction: DatabaseTransaction): FaviconPolicyWritePort {
  return Object.freeze({
    async findByAccountId(accountId) {
      const row = (await sql<PolicyRow>`
        select ${POLICY_COLUMNS}
        from account_favicon_policies
        where account_id = ${accountId}
      `.execute(transaction)).rows[0];
      return row === undefined ? null : mapPolicy(row);
    },
    async update(input) {
      const updated = (await sql<PolicyRow>`
        update account_favicon_policies
        set new_default = ${input.newDefault},
            provider_template = ${input.providerTemplate},
            fill_missing = ${input.fillMissing},
            force_all_online = ${input.forceAllOnline},
            revision = revision + 1,
            updated_at = greatest(${input.updatedAt}::timestamptz,
              updated_at + interval '1 microsecond')
        where account_id = ${input.accountId} and revision = ${input.expectedRevision}
        returning ${POLICY_COLUMNS}
      `.execute(transaction)).rows[0];
      if (updated !== undefined) return { kind: 'updated' as const, row: mapPolicy(updated) };
      if (input.expectedRevision === 1n) {
        try {
          const inserted = (await sql<PolicyRow>`
            insert into account_favicon_policies(
              account_id, new_default, provider_template, fill_missing,
              force_all_online, revision, updated_at)
            values (${input.accountId}, ${input.newDefault}, ${input.providerTemplate},
              ${input.fillMissing}, ${input.forceAllOnline}, 2, ${input.updatedAt})
            returning ${POLICY_COLUMNS}
          `.execute(transaction)).rows[0];
          if (inserted !== undefined) return { kind: 'updated' as const, row: mapPolicy(inserted) };
        } catch (error) {
          if (!isUniqueViolation(error)) throw error;
          // Concurrent first write: another transaction inserted the row.
        }
      }
      const current = (await sql<{ revision: string }>`
        select revision from account_favicon_policies where account_id = ${input.accountId}
      `.execute(transaction)).rows[0];
      return {
        kind: 'stale' as const,
        currentRevision: current === undefined ? 1n : BigInt(current.revision),
      };
    },
  } satisfies FaviconPolicyWritePort);
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && (error as { code?: unknown }).code === '23505';
}