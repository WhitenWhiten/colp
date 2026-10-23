import { sql, type Kysely, type Migration } from 'kysely';

/** Page-local parent authority; existing headers remain readable by N-1 binaries. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table sync_bootstrap_snapshot_nodes add column children_revision text`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`alter table sync_bootstrap_snapshot_nodes drop column children_revision`.execute(db);
}

export const migration: Migration = { up, down };
