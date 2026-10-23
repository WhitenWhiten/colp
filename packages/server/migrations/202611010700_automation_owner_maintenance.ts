import { sql, type Kysely } from 'kysely';

const ownerTables = [
  'automation_rules', 'automation_runs', 'automation_source_positions', 'automation_device_bundles',
  'automation_preview_records', 'automation_pairings', 'automation_event_subscriptions', 'automation_settings',
] as const;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE TABLE automation_owner_maintenance (
    owner_id text PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
    next_due_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    lease_until timestamptz,
    lease_generation bigint NOT NULL DEFAULT 0 CHECK (lease_generation >= 0)
  );
  CREATE INDEX automation_owner_maintenance_due ON automation_owner_maintenance(next_due_at,owner_id);
  CREATE FUNCTION register_automation_maintenance_owner() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    INSERT INTO automation_owner_maintenance(owner_id) VALUES (NEW.owner_id) ON CONFLICT DO NOTHING;
    RETURN NEW;
  END $$`.execute(db);
  for (const table of ownerTables) {
    await sql.raw(`INSERT INTO automation_owner_maintenance(owner_id) SELECT DISTINCT owner_id FROM ${table} ON CONFLICT DO NOTHING;
      CREATE TRIGGER register_maintenance_owner AFTER INSERT ON ${table}
      FOR EACH ROW EXECUTE FUNCTION register_automation_maintenance_owner()`).execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const table of ownerTables) await sql.raw(`DROP TRIGGER register_maintenance_owner ON ${table}`).execute(db);
  await sql`DROP FUNCTION register_automation_maintenance_owner(); DROP TABLE automation_owner_maintenance`.execute(db);
}
