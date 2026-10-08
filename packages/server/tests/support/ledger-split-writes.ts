import type { Kysely } from 'kysely';
import {
  appendAuditEvent,
  appendOperationWithPayload,
  type AppendAuditEventInput,
  type AppendOperationWithPayloadInput,
  type DatabaseSchema,
} from '../../src/infrastructure/database/index.js';

/** Write an Operation fact+payload pair the way production does after the split. */
export async function insertTestOperation(
  db: Kysely<DatabaseSchema>,
  input: AppendOperationWithPayloadInput,
): Promise<void> {
  await db.transaction().execute((transaction) => appendOperationWithPayload(transaction, input));
}

/** Write an audit header+payload pair the way production does after the split. */
export async function insertTestAuditEvent(
  db: Kysely<DatabaseSchema>,
  input: AppendAuditEventInput,
): Promise<bigint> {
  return db.transaction().execute((transaction) => appendAuditEvent(transaction, input));
}
