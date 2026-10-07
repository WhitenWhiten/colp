import { sql, type Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';

/**
 * P4A-I14 expand migration: DB-clock retirement timestamps + retention index
 * for the bounded cleanup coordinator.
 *
 * `blob_generations.retired_at` / `orphaned_at` record WHEN a generation
 * entered the claimable retired/orphaned state (database clock, set by the
 * production transition writers). The cleanup claim compares
 * `coalesce(retired_at, orphaned_at) <= now() - retiredRetentionDays` in SQL
 * (boundary inclusive, DB clock only — never a JS wall clock), so a retained
 * generation is never deleted early and clock skew can never omit an eligible
 * candidate.
 *
 * `blob_generations_cleanup_retention_idx` backs the retention-expired
 * candidate scan on `(coalesce(retired_at, orphaned_at), created_at,
 * generation_id)` over exactly the claimable states. The existing
 * `blob_generations_cleanup_candidate_idx` (I07, on `(created_at,
 * generation_id)`) continues to back the raw keyset scan; both are bounded
 * partial indexes (no Seq Scan cheat in the plan proofs).
 *
 * Expand-only: the columns are nullable so N/N-1 binaries and legacy/direct
 * fixture rows without a retirement timestamp are unaffected (cleanup simply
 * never treats a null timestamp as expired). `down()` rolls back cleanly.
 */
const DDL_STATEMENTS: readonly string[] = [
  `alter table blob_generations
    add column retired_at timestamptz,
    add column orphaned_at timestamptz`,
  `create index blob_generations_cleanup_retention_idx
    on blob_generations (coalesce(retired_at, orphaned_at), created_at, generation_id)
    where generation_state in ('retired', 'orphaned', 'deletion_pending')`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const statement of DDL_STATEMENTS) {
    await sql.raw(statement).execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw('drop index if exists blob_generations_cleanup_retention_idx').execute(db);
  await sql.raw('alter table blob_generations drop column if exists orphaned_at').execute(db);
  await sql.raw('alter table blob_generations drop column if exists retired_at').execute(db);
}

const migration: Migration = { up, down };
export default migration;
