import { sql, type Kysely, type Migration } from 'kysely';

/**
 * CS-03 community comments and replies: the durable comment tree.
 *
 * `community_comments` keeps one row per comment or reply. The row binds the
 * closed target identity AND the `target_generation` it was written against,
 * so a bookmark whose source URL advanced (generation fencing from CS-01)
 * conceals its old thread with the content it described — reads always filter
 * on the target's CURRENT generation.
 *
 * Shape invariants are enforced at the row level: a root has `depth = 0`,
 * `reply_to_id IS NULL` and `root_id = comment_id`; replies have depth 1 or 2,
 * a non-null `reply_to_id`, and a `root_id` pointing at the root row. Depth 3
 * is structurally impossible. `body` allows NULL so CS-04 tombstones
 * (deleted/hidden) retain the row with `body = null`; `state` and
 * `revision` (the If-Match ETag source) are present now but only `visible`
 * rows at revision 1 are written by CS-03. The tombstone CHECK pins the
 * never-leak rule: `deleted` rows can never carry a body again, `visible`
 * rows always do, and `hidden` may keep its body for a later unhide.
 *
 * `comment_id` is a server-minted durable id reserved through
 * `resource_id_ledger` like every other durable resource id; the FK makes a
 * never-registered id uninsertable. The thread/tree invariants that need the
 * parent row's target columns (same target, same generation, parent depth)
 * are enforced by the command under the target's serializable lock because a
 * plain CHECK cannot see another row.
 *
 * Deliberately NOT marked `known.append_heavy=true` and absent from
 * `LEDGER_CAPACITY_TARGETS`: the append-heavy completeness authority covers
 * append-only ledger relations, while comments are mutable product content
 * (CS-04 edits, tombstone and curation transitions bump `revision`) — the
 * same precedent as `community_votes` and `community_hot_ranking`.
 *
 * Expand-only: new table and indexes, no existing reader or writer is
 * affected. Empty `down` leaves objects in place, so `up` must be re-entrant
 * after Kysely forgets the migration row.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE TABLE IF NOT EXISTS community_comments (
    comment_id text PRIMARY KEY REFERENCES resource_id_ledger(resource_id) ON DELETE RESTRICT
      CHECK (length(comment_id) BETWEEN 1 AND 128),
    target_kind text NOT NULL CHECK (target_kind IN ('collection','bookmark','digest_series','digest_edition')),
    target_id text NOT NULL,
    target_collection_id text,
    target_series_id text,
    target_generation text NOT NULL CHECK (length(target_generation) BETWEEN 1 AND 128),
    root_id text NOT NULL REFERENCES community_comments(comment_id) ON DELETE RESTRICT,
    reply_to_id text REFERENCES community_comments(comment_id) ON DELETE RESTRICT,
    depth smallint NOT NULL CHECK (depth BETWEEN 0 AND 2),
    author_account_id text NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    body text CHECK (body IS NULL OR (char_length(body) BETWEEN 1 AND 4000)),
    state text NOT NULL DEFAULT 'visible' CHECK (state IN ('visible','deleted','hidden')),
    revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (
      (target_kind = 'bookmark' AND target_collection_id IS NOT NULL AND target_series_id IS NULL)
      OR (target_kind = 'digest_edition' AND target_series_id IS NOT NULL AND target_collection_id IS NULL)
      OR (target_kind IN ('collection','digest_series') AND target_collection_id IS NULL AND target_series_id IS NULL)
    ),
    CHECK (
      (depth = 0 AND reply_to_id IS NULL AND root_id = comment_id)
      OR (depth IN (1,2) AND reply_to_id IS NOT NULL AND root_id <> comment_id)
    ),
    CHECK (
      (state = 'visible' AND body IS NOT NULL)
      OR (state = 'hidden')
      OR (state = 'deleted' AND body IS NULL)
    )
  )`.execute(db);

  // Root listing: newest-first keyset on (created_at DESC, comment_id ASC)
  // scoped to one target generation; only roots appear on that page.
  await sql`CREATE INDEX IF NOT EXISTS community_comments_root_list_idx
    ON community_comments (target_kind, target_id, target_generation, created_at DESC, comment_id ASC)
    WHERE depth = 0`.execute(db);

  // Reply listing: flattened descendants of one root, oldest-first keyset.
  await sql`CREATE INDEX IF NOT EXISTS community_comments_thread_idx
    ON community_comments (root_id, created_at ASC, comment_id ASC)
    WHERE depth > 0`.execute(db);

  // replyCount + parent lookup support.
  await sql`CREATE INDEX IF NOT EXISTS community_comments_reply_to_idx
    ON community_comments (reply_to_id)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS community_comments_author_idx
    ON community_comments (author_account_id)`.execute(db);
}

/** Expand-only contract: production rollback is flag-off; never run migration down. */
export async function down(_db: Kysely<unknown>): Promise<void> {
  // Intentionally empty. These tables are retained for rollback safety and auditability.
}

export const migration: Migration = { up, down };
export default migration;
