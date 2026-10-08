import { sql, type Kysely, type RawBuilder } from 'kysely';
import type { DatabaseSchema } from '../database/runtime.js';

/** Consume one sorted snapshot without rescanning and sorting every OFFSET page.
 * The caller owns a repeatable-read transaction, including cursor cleanup. */
export async function* readExportProjectionRows<Row>(
  transaction: Kysely<DatabaseSchema>,
  name: 'export_collections' | 'export_nodes',
  query: RawBuilder<Row>,
): AsyncGenerator<Row> {
  if (!transaction.isTransaction) throw new Error('Export cursors require a transaction');
  await sql`DECLARE ${sql.id(name)} NO SCROLL CURSOR FOR ${query}`.execute(transaction);
  let queryFailed = false;
  try {
    for (;;) {
      const page = await sql<Row>`FETCH FORWARD 128 FROM ${sql.id(name)}`.execute(transaction);
      for (const row of page.rows) yield row;
      if (page.rows.length < 128) return;
    }
  } catch (error) {
    // PostgreSQL aborts the transaction after a query failure; rollback closes
    // its cursors. Sending CLOSE here would mask the original query error.
    queryFailed = true;
    throw error;
  } finally {
    if (!queryFailed) await sql`CLOSE ${sql.id(name)}`.execute(transaction);
  }
}
