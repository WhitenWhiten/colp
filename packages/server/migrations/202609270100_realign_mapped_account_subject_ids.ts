import { type Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import type { DatabaseSchema } from '../src/infrastructure/database/runtime.js';
import { runSubjectIdReferenceCascade } from '../src/infrastructure/seed/subject-id-reference-cascade.js';

/**
 * Re-run the T-03 subject cascade after a later demo seed restore.
 *
 * `202609230200` / `202609230300` are one-shot. A subsequent seed apply
 * writes `accounts.subject_id = sub-uNN` again while Better Auth keeps
 * `user.id = seed-auser-uNN`. MCP verifies JWT `sub` against
 * `accounts.subject_id`, so demo-account OAuth tokens then fail as
 * `invalid_token`. This expand is the same idempotent DO block.
 *
 * Seed apply also invokes the cascade after the auth phase, so the next
 * inject does not wait for another one-shot migration.
 */
export async function up(db: Kysely<DatabaseSchema>): Promise<void> {
  await runSubjectIdReferenceCascade(db);
}

/** Data backfill cannot be undone without stealing later application writes. */
export async function down(_db: Kysely<unknown>): Promise<void> {
  // no-op
}

export const migration: Migration = { up, down };
export default migration;
