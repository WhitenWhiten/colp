import { sql, type Kysely, type Migration } from 'kysely';
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE bookmark_capture_decisions ADD COLUMN original_hostname text`.execute(db);
  await sql`UPDATE bookmark_capture_decisions d SET original_hostname=regexp_replace(rtrim(lower(n.search_url_host),'.'),'^www\.','')
    FROM nodes n WHERE n.id=d.node_id AND n.collection_id=d.collection_id AND n.url=d.original_url`.execute(db);
  await sql`CREATE INDEX capture_memory_host ON bookmark_capture_decisions(account_id, collection_id, original_hostname)`.execute(db);
  await sql`ALTER TABLE collection_classification_evidence ADD COLUMN bookmark_key text, ADD COLUMN evidence_generation integer NOT NULL DEFAULT 0`.execute(db);
  await sql`CREATE TABLE classification_evidence_erasure (
    owner_subject_id text NOT NULL, source text NOT NULL, command_id text NOT NULL, node_id text NOT NULL,
    PRIMARY KEY(owner_subject_id, source, command_id, node_id)
  )`.execute(db);
}
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE classification_evidence_erasure`.execute(db);
  await sql`ALTER TABLE collection_classification_evidence DROP COLUMN bookmark_key, DROP COLUMN evidence_generation`.execute(db);
  await sql`DROP INDEX capture_memory_host`.execute(db);
  await sql`ALTER TABLE bookmark_capture_decisions DROP COLUMN original_hostname`.execute(db);
}
export const migration: Migration = { up, down };
export default migration;
