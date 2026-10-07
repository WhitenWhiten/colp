import { sql, type Kysely, type Migration } from 'kysely';
import {
  ensureTransactionalPerformanceIndex,
  ONLINE_PERFORMANCE_INDEXES,
} from '../src/infrastructure/database/online-performance-indexes.js';

/**
 * Unique indexed lookup for protected session tokens. Large installations
 * stop before a blocking build and direct operators to the online index CLI;
 * the preceding expand migration remains committed and is safe for N-1 code.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await ensureTransactionalPerformanceIndex(db, ONLINE_PERFORMANCE_INDEXES.authSessionTokenLookup);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS auth_sessions_token_lookup_hash_uidx`.execute(db);
}

export const migration: Migration = { up, down };
export default migration;

