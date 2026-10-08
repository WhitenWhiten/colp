import { sql, type Kysely, type Migration } from 'kysely';
import {
  ensureTransactionalPerformanceIndex,
  type OnlinePerformanceIndexDefinition,
} from '../src/infrastructure/database/online-performance-indexes.js';

const LEGACY_ATTACHMENT_FINALIZE_INDEX: OnlinePerformanceIndexDefinition = Object.freeze({
  name: 'operations_attachment_finalize_command_idx', tableName: 'operations',
  createConcurrentlySql: `CREATE INDEX CONCURRENTLY operations_attachment_finalize_command_idx
    ON operations ((payload_json ->> 'commandId'), commit_ordinal DESC)
    INCLUDE (operation_id, collection_id)
    WHERE operation_type = 'attachment.finalized' AND payload_json ? 'commandId'`,
  definitionPatterns: Object.freeze([/payload_json/iu]),
});

/**
 * Attachment finalize performs a durable idempotency lookup by the Product
 * command id stored in the canonical Operation payload. `operations` is an
 * append-only ledger, so leaving this as a JSONB sequential scan makes every
 * finalize transaction slower as unrelated history grows.
 *
 * The partial expression index contains only attachment finalize Operations
 * that actually carry a command id. `commit_ordinal DESC` matches the
 * defensive latest-row ordering without imposing a new uniqueness contract on
 * historical data. Included identity columns avoid extra heap reads for the
 * common lookup; payload_json remains a heap read because duplicating the full
 * canonical payload in the index would amplify ledger storage.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await ensureTransactionalPerformanceIndex(db, LEGACY_ATTACHMENT_FINALIZE_INDEX);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS operations_attachment_finalize_command_idx`.execute(db);
}

export const migration: Migration = { up, down };
export default migration;
