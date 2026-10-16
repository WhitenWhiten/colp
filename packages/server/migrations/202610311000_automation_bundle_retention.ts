import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE INDEX automation_bundle_expiry ON automation_device_bundles(owner_id,expires_at,device_id,revision);
    CREATE INDEX automation_receipt_bundle ON automation_intake_receipts(owner_id,device_id,(receipt_json#>>'{input,bundleRevision}'))`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX automation_receipt_bundle; DROP INDEX automation_bundle_expiry`.execute(db);
}
