import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import {
  assertCanonicalCommandId,
  stableReplayHeaders,
  type ProductCommandClaim,
  type ProductCommandReceiptPort,
} from '../../modules/commands/index.js';
import { createUnitOfWork, type DatabaseTransaction } from './unit-of-work.js';
import type { Kysely } from 'kysely';
import type { DatabaseSchema } from './runtime.js';

/** PostgreSQL adapter. Its transaction is supplied by the admission-layer unit of work. */
export function createPostgresProductCommandReceiptPort(
  transaction: DatabaseTransaction,
): ProductCommandReceiptPort {
  return {
    async claim(binding, fingerprint): Promise<ProductCommandClaim> {
      assertCanonicalCommandId(binding.commandId);
      // Avoid waiting on an uncommitted winner's unique-index entry or row lock.
      const claimGate = await sql<{ acquired: boolean }>`select pg_try_advisory_xact_lock(
        hashtextextended(json_build_array(
          ${binding.principalId}::text, ${binding.commandScope}::text, ${binding.commandId}::text
        )::text, 0)
      ) as acquired`.execute(transaction);
      if (!claimGate.rows[0]?.acquired) {
        return { kind: 'in_progress', retryAfterSeconds: 1 };
      }
      const inserted = await transaction.insertInto('product_command_receipts').values({
        principal_id: binding.principalId,
        command_scope: binding.commandScope,
        command_id: binding.commandId,
        request_fingerprint: fingerprint,
        claimed_at: sql<Date>`current_timestamp`,
        compact_claim: false,
        contract_version: '1.0.0',
      }).onConflict((oc) => oc.columns(['principal_id', 'command_scope', 'command_id']).doNothing())
        .returning('command_id').executeTakeFirst();
      if (inserted) return { kind: 'claimed' };

      const row = await transaction.selectFrom('product_command_receipts').selectAll()
        .where('principal_id', '=', binding.principalId)
        .where('command_scope', '=', binding.commandScope)
        .where('command_id', '=', binding.commandId)
        .executeTakeFirstOrThrow();
      if (row.request_fingerprint !== fingerprint) return { kind: 'reused' };
      if ((row.compact_claim || row.result_purged_at !== null || row.result_bytes === null)
          && row.completed_at !== null) {
        return { kind: 'expired', resultDigest: row.result_digest };
      }
      if (row.completed_at === null) return { kind: 'in_progress', retryAfterSeconds: 1 };
      return {
        kind: 'replay',
        result: {
          status: row.result_status!,
          body: row.result_bytes!,
          stableHeaders: row.result_headers ?? {},
          mediaType: row.result_media_type!,
          contractVersion: row.contract_version,
          targetIdentity: row.target_identity ?? undefined,
        },
      };
    },

    async complete(binding, fingerprint, result): Promise<void> {
      const body = Buffer.from(result.body);
      const digest = createHash('sha256').update(body).digest('hex');
      const updated = await transaction.updateTable('product_command_receipts').set({
        result_status: result.status,
        result_headers: stableReplayHeaders(result.stableHeaders),
        result_media_type: result.mediaType,
        result_bytes: body,
        result_digest: digest,
        contract_version: result.contractVersion,
        target_identity: result.targetIdentity ?? null,
        completed_at: sql<Date>`current_timestamp`,
        result_expires_at: sql<Date>`current_timestamp + interval '30 days'`,
      }).where('principal_id', '=', binding.principalId)
        .where('command_scope', '=', binding.commandScope)
        .where('command_id', '=', binding.commandId)
        .where('request_fingerprint', '=', fingerprint)
        .where('completed_at', 'is', null).executeTakeFirst();
      if (Number(updated.numUpdatedRows) !== 1) {
        throw new Error('product command receipt was not claim owner');
      }
    },

    async purgeExpired(options = {}): Promise<number> {
      const limit = Math.max(1, Math.min(options.limit ?? 100, 10_000));
      // Single bounded statement: the candidate CTE locks the batch with
      // FOR UPDATE SKIP LOCKED so concurrent purgers partition rows instead of
      // double-compacting them. Compaction is an UPDATE, never a DELETE — the
      // permanent compact claim keeps command-ID reuse semantics (claim -> expired).
      const purged = await sql<{ principal_id: string }>`
        WITH candidates AS (
          SELECT principal_id, command_scope, command_id
          FROM product_command_receipts
          WHERE completed_at IS NOT NULL
            AND result_expires_at <= current_timestamp
            AND result_bytes IS NOT NULL
          ORDER BY result_expires_at
          FOR UPDATE SKIP LOCKED
          LIMIT ${limit}
        )
        UPDATE product_command_receipts receipt
        SET result_bytes = NULL,
            result_headers = NULL,
            result_media_type = NULL,
            result_status = NULL,
            result_purged_at = current_timestamp,
            compact_claim = true
        FROM candidates
        WHERE (receipt.principal_id, receipt.command_scope, receipt.command_id)
            = (candidates.principal_id, candidates.command_scope, candidates.command_id)
          AND receipt.result_bytes IS NOT NULL
        RETURNING receipt.principal_id
      `.execute(transaction);
      options.onPurged?.(purged.rows.length);
      return purged.rows.length;
    },

    async deletePrincipalReceipts(principalId): Promise<number> {
      const result = await transaction.deleteFrom('product_command_receipts')
        .where('principal_id', '=', principalId).executeTakeFirst();
      return Number(result.numDeletedRows);
    },
  };
}

/** Creates a fresh transaction-bound port for each scheduled operation. */
export function createPostgresProductCommandReceiptPortFactory(
  db: Kysely<DatabaseSchema>,
): () => Promise<ProductCommandReceiptPort> {
  return async () => {
    const port: ProductCommandReceiptPort = {
      claim: (binding, fingerprint) => createUnitOfWork(db).execute(({ transaction }) =>
        createPostgresProductCommandReceiptPort(transaction).claim(binding, fingerprint)),
      complete: (binding, fingerprint, result) => createUnitOfWork(db).execute(({ transaction }) =>
        createPostgresProductCommandReceiptPort(transaction).complete(binding, fingerprint, result)),
      purgeExpired: (options) => createUnitOfWork(db).execute(({ transaction }) =>
        createPostgresProductCommandReceiptPort(transaction).purgeExpired(options)),
      deletePrincipalReceipts: (principalId) => createUnitOfWork(db).execute(({ transaction }) =>
        createPostgresProductCommandReceiptPort(transaction).deletePrincipalReceipts(principalId)),
    };
    return port;
  };
}
