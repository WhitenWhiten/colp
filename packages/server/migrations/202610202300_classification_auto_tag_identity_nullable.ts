import { sql, type Kysely } from 'kysely';

/**
 * Auto-tag jobs are created by canonical node writes, which have no view of the
 * classification deployment configuration. They must not stamp a fabricated
 * upstream identity, so the identity columns become unknown-until-resolved and
 * the runtime gate binds the calibration and the live provider instead.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE collection_classification_tag_jobs
    ALTER COLUMN provider_id DROP NOT NULL,
    ALTER COLUMN model DROP NOT NULL,
    ALTER COLUMN model_version DROP NOT NULL`.execute(db);
}

/** Developer-only destructive rollback. `unknown` keeps a recovered row fail-closed:
 * the pre-migration runtime compares the job row against the deployment identity, so an
 * unresolved identity is skipped rather than bound to an invented upstream. The rollback
 * must not reintroduce a vendor name the deployment may not even use (plan D2). */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`UPDATE collection_classification_tag_jobs SET provider_id=coalesce(provider_id,'unknown'),
    model=coalesce(model,'unknown'),model_version=coalesce(model_version,'unknown')`.execute(db);
  await sql`ALTER TABLE collection_classification_tag_jobs
    ALTER COLUMN provider_id SET NOT NULL,
    ALTER COLUMN model SET NOT NULL,
    ALTER COLUMN model_version SET NOT NULL`.execute(db);
}
