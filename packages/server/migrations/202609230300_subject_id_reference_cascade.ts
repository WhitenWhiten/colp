import { type Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import type { DatabaseSchema } from '../src/infrastructure/database/runtime.js';
import { runSubjectIdReferenceCascade } from '../src/infrastructure/seed/subject-id-reference-cascade.js';

/**
 * Follow-up to T-03 / `202609230200_accounts_subject_id_backfill`.
 *
 * Body lives in `src/infrastructure/seed/subject-id-reference-cascade.ts`
 * so seed apply can re-run it without pulling this file into
 * `tsc -p tsconfig.json`.
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
