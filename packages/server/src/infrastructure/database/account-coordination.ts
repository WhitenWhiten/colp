import { sql, type Kysely, type Transaction } from 'kysely';
import type { DatabaseSchema } from './runtime.js';

/** Receipt claim precedes this lock; domain and mapping locks follow it. */
export async function lockBookmarkSubscriptionAccount(
  transaction: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>, accountId: string,
): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtextextended(${`bookmark-subscriptions:${accountId}`}, 0))`.execute(transaction);
}
