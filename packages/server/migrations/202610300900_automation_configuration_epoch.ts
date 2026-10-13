import { sql, type Kysely } from 'kysely';
/** Snapshot ordering is independent of the Pause API ETag, and includes all configuration changes. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE TABLE automation_configuration_epochs (
    owner_id text PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
    revision bigint NOT NULL CHECK (revision > 0)
  );
  INSERT INTO automation_configuration_epochs(owner_id,revision)
    SELECT a.id, greatest(coalesce(s.revision,0),coalesce(b.revision,0))+1 FROM accounts a
    LEFT JOIN automation_settings s ON s.owner_id=a.id
    LEFT JOIN (SELECT owner_id,max(settings_revision) AS revision FROM automation_device_bundles GROUP BY owner_id) b ON b.owner_id=a.id
    WHERE s.owner_id IS NOT NULL OR b.owner_id IS NOT NULL OR EXISTS (SELECT 1 FROM automation_rules r WHERE r.owner_id=a.id)`.execute(db);
}
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE automation_configuration_epochs`.execute(db);
}
