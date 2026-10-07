import { sql, type Kysely, type Migration } from 'kysely';

/**
 * CG review: appeal/affected-owner rights must bind to a STABLE snapshot of
 * the owner captured when the action is created, not to whatever owner the
 * live parent row resolves to today. Previously isAffectedOwner /
 * listActionsAffectingOwner joined only live collections/series/accounts, so
 * deleting the parent Collection/series (or the owning account) permanently
 * stripped the owner of the appeal/self-service right even though the action
 * persists, and transferring ownership moved the right to the new owner.
 *
 * Expand/backfill: add owner_account_id, backfill from current live parents
 * (rows whose parent is already gone backfill to NULL and stay
 * official-managed only; the column is snapshotted going forward by the
 * action command). ON DELETE SET NULL keeps account deletion working while
 * preserving the action row.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE moderation_actions
      ADD COLUMN owner_account_id text REFERENCES accounts(id) ON DELETE SET NULL
  `.execute(db);
  await sql`
    UPDATE moderation_actions
       SET owner_account_id = target_id
     WHERE target_kind = 'account'
  `.execute(db);
  await sql`
    UPDATE moderation_actions a
       SET owner_account_id = acc.id
      FROM collections c
      JOIN accounts acc ON acc.subject_id = c.owner_subject_id
     WHERE a.owner_account_id IS NULL
       AND c.deleted_at IS NULL
       AND (
         (a.target_kind = 'collection' AND c.id = a.target_id)
         OR (a.target_kind = 'bookmark' AND c.id = a.parent_id)
       )
  `.execute(db);
  await sql`
    UPDATE moderation_actions a
       SET owner_account_id = acc.id
      FROM digest_series s
      JOIN accounts acc ON acc.subject_id = s.owner_subject_id
     WHERE a.owner_account_id IS NULL
       AND s.deleted_at IS NULL
       AND s.state = 'active'
       AND (
         (a.target_kind = 'digest_series' AND s.id = a.target_id)
         OR (a.target_kind = 'digest_edition' AND s.id = a.parent_id)
       )
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS moderation_actions_owner_idx
      ON moderation_actions (owner_account_id)
     WHERE owner_account_id IS NOT NULL
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS moderation_actions_owner_idx`.execute(db);
  await sql`ALTER TABLE moderation_actions DROP COLUMN IF EXISTS owner_account_id`.execute(db);
}

export const migration: Migration = { up, down };
export default migration;