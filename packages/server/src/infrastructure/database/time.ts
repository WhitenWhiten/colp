import { sql, type Kysely, type Transaction } from 'kysely';
import type { DatabaseSchema } from './runtime.js';

type DatabaseExecutor = Kysely<DatabaseSchema> | Transaction<DatabaseSchema>;

export async function databaseNow(executor: DatabaseExecutor): Promise<Date> {
  const result = await sql<{ now: Date }>`select current_timestamp as now`.execute(executor);
  const now = result.rows[0]?.now;
  if (!(now instanceof Date)) throw new TypeError('PostgreSQL returned an invalid current_timestamp');
  return now;
}
