import { sql, type Kysely, type Migration } from 'kysely';
import {
  ensureTransactionalPerformanceIndex,
  ONLINE_PERFORMANCE_INDEXES,
} from '../src/infrastructure/database/online-performance-indexes.js';

/**
 * Match the Product Editor live-node keyset comparator exactly. The partial
 * predicate keeps roots and tombstones out of the read-path index. Existing
 * installations prebuild this manifest-owned index with db:indexes:online;
 * fresh/small databases can still build it in the migration transaction.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`SET CONSTRAINTS ALL IMMEDIATE`.execute(db);
  await ensureTransactionalPerformanceIndex(db, ONLINE_PERFORMANCE_INDEXES.nodesLiveEditorKeyset);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX nodes_live_editor_keyset_idx`.execute(db);
}

export const migration: Migration = { up, down };
export default migration;
