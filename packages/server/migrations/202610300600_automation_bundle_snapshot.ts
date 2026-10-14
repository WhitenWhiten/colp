import { sql, type Kysely } from 'kysely';
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE automation_device_bundles ADD COLUMN snapshot_json jsonb;
    CREATE INDEX automation_receipt_collection ON automation_intake_receipts ((receipt_json->'input'->'committedNode'->>'collectionId'), state)`.execute(db);
}
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX automation_receipt_collection; ALTER TABLE automation_device_bundles DROP COLUMN snapshot_json`.execute(db);
}
