import { sql, type Kysely, type Migration } from 'kysely';

/**
 * C4 never-bound compact JWS: revokeAll only increments accounts.security_epoch.
 * Bound Sync credentials compare bind-time epoch on verify; a JWT that was
 * never inserted into sync_extension_credentials has no epoch snapshot, so
 * verify used to admit it and first-bind at the new epoch. Stamp the bump
 * time so missing-row verify can compare the signed iat against it.
 *
 * Epoch 0 (never bumped) keeps a NULL timestamp and stays admissible.
 * Existing bumped rows get current_timestamp — historical bump times are
 * unknown, so never-bound tokens issued before this migration fail closed.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE accounts
    ADD COLUMN security_epoch_bumped_at timestamptz`.execute(db);
  await sql`UPDATE accounts
    SET security_epoch_bumped_at = current_timestamp
    WHERE security_epoch > 0`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE accounts
    DROP COLUMN IF EXISTS security_epoch_bumped_at`.execute(db);
}

export const migration: Migration = { up, down };
export default migration;
