import { sql, type Kysely, type Migration } from 'kysely';

/**
 * ADR-0021 expand-only: terminal classify-inbox decisions for owned root
 * bookmarks. Absence of a row means the bookmark is still in the queue.
 * N-1 binaries ignore the table.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE TABLE collection_classify_inbox_decision (
    node_id text NOT NULL,
    collection_id text NOT NULL,
    account_subject_id text NOT NULL,
    status text NOT NULL CHECK (status IN ('accepted','skipped')),
    suggestion_id text,
    decided_at timestamptz NOT NULL,
    CONSTRAINT collection_classify_inbox_decision_pkey PRIMARY KEY (node_id),
    CONSTRAINT collection_classify_inbox_decision_node_fk FOREIGN KEY (node_id)
      REFERENCES nodes(id) ON DELETE CASCADE,
    CONSTRAINT collection_classify_inbox_decision_collection_fk FOREIGN KEY (collection_id)
      REFERENCES collections(id),
    CONSTRAINT collection_classify_inbox_decision_identity_lengths CHECK (
      length(node_id) BETWEEN 1 AND 128
      AND length(collection_id) BETWEEN 1 AND 128
      AND length(account_subject_id) BETWEEN 1 AND 128
    ),
    CONSTRAINT collection_classify_inbox_decision_suggestion_shape CHECK (
      (status = 'skipped' AND suggestion_id IS NULL)
      OR (
        status = 'accepted'
        AND suggestion_id IS NOT NULL
        AND length(suggestion_id) BETWEEN 1 AND 128
      )
    ),
    CONSTRAINT collection_classify_inbox_decision_time_finite CHECK (
      decided_at > '-infinity'::timestamptz AND decided_at < 'infinity'::timestamptz
    )
  )`.execute(db);

  await sql`COMMENT ON TABLE collection_classify_inbox_decision IS
    'Terminal classify-inbox skip/accept decisions; missing row means still queued.'`.execute(db);
  await sql`CREATE INDEX collection_classify_inbox_decision_account_idx
    ON collection_classify_inbox_decision (account_subject_id)`.execute(db);
}

/** Developer-only destructive rollback; drain classify-inbox writers before migrating down. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS collection_classify_inbox_decision`.execute(db);
}

export const migration: Migration = { up, down };
export default migration;
