import { sql, type Kysely } from 'kysely';
import type { DatabaseSchema } from '../database/index.js';
/** A bounded batch; the next hourly pass continues without holding a long account lock. */
export async function purgeActivity(db: Kysely<DatabaseSchema>, limit = 1000): Promise<number> {
  const result = await sql`WITH expired AS (SELECT id FROM activity_items
    WHERE occurred_at<clock_timestamp()-interval '365 days'
      OR (read_at IS NOT NULL AND updated_at<clock_timestamp()-interval '90 days')
    ORDER BY occurred_at,id LIMIT ${limit} FOR UPDATE SKIP LOCKED)
    DELETE FROM activity_items USING expired WHERE activity_items.id=expired.id RETURNING activity_items.id`.execute(db);
  return result.rows.length;
}
