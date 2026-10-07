import {sql,type Kysely} from 'kysely';
export async function up(db:Kysely<unknown>):Promise<void>{
  await sql`CREATE TABLE collection_classification_evidence (
    evidence_id text PRIMARY KEY,collection_id text NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    owner_subject_id text NOT NULL REFERENCES accounts(subject_id) ON DELETE CASCADE,node_id text NOT NULL,hostname text NOT NULL,
    folder_id text,source text NOT NULL CHECK(source IN ('classify_accept','run_apply')),command_id text NOT NULL,
    operation_id text REFERENCES operations(operation_id) ON DELETE SET NULL,taxonomy_revision text NOT NULL,
    tag_count integer NOT NULL CHECK(tag_count BETWEEN 0 AND 3),tag_digest text,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY(collection_id,node_id) REFERENCES nodes(collection_id,id) ON DELETE CASCADE,
    FOREIGN KEY(collection_id,folder_id) REFERENCES nodes(collection_id,id) ON DELETE CASCADE,
    UNIQUE(source,command_id,node_id),CHECK(folder_id IS NOT NULL OR tag_count>0),CHECK(length(hostname) BETWEEN 1 AND 253)
  )`.execute(db);
  await sql`CREATE INDEX classification_evidence_host ON collection_classification_evidence(collection_id,owner_subject_id,hostname,created_at,folder_id)`.execute(db);
  await sql`CREATE INDEX classification_evidence_retention ON collection_classification_evidence(created_at)`.execute(db);
}
export async function down(db:Kysely<unknown>):Promise<void>{await sql`DROP TABLE collection_classification_evidence`.execute(db);}
