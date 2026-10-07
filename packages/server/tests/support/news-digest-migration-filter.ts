import { runMigrations } from '../../src/infrastructure/database/index.js';
import type { IsolatedPostgresRuntime } from './postgres-test-runtime.js';

/**
 * The expand-only News Digest migrations that a filtered migration run must
 * exclude: they keep their tables on `down`, so a later `up` would collide.
 */
export const EXPAND_ONLY_NEWS_DIGEST_MIGRATIONS: readonly string[] = Object.freeze([
  '202610011500_news_digest_schema',
  '202610011600_news_digest_owner_trigger_fix',
  '202610011700_news_digest_source_fanout_continuation',
  '202610012000_digest_subject_id_remap',
  // Both of these read the News Digest tables, so neither can run in a
  // directory where the schema migrations above are excluded.
  '202610012400_catalog_preferences_and_digest_catalog',
  '202610012900_moderation_actions_owner_snapshot',
]);

/**
 * Migrate a filtered migration directory, and turn the one failure that means
 * "the exclusion set is incomplete" into a message that says so.
 *
 * Tested by trying: a migration added later reached for `digest_series`, which
 * the exclusion set removes, and the only signal was a 20-second timeout reading
 * `relation "digest_series" does not exist`. A static scan for such references
 * gives false positives (`to_regclass('digest_audit_events')` is an
 * existence-guarded reference), so the hint is attached to the failure it
 * explains instead of being predicted.
 */
export async function runMigrationsExcludingNewsDigest(
  runtime: IsolatedPostgresRuntime,
  directory: string,
  excluded: ReadonlySet<string> = new Set(EXPAND_ONLY_NEWS_DIGEST_MIGRATIONS),
): Promise<void> {
  try {
    await runMigrations(runtime.runtime.db, 'latest', directory);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const migration = /migrations\/([0-9][0-9_a-z]*)\.ts/u.exec(
      error instanceof Error ? error.stack ?? '' : '',
    )?.[1];
    if (migration !== undefined && /relation "digest_[a-z_]+" does not exist/u.test(message)) {
      throw new Error(`migration ${migration} needs a News Digest table that the excluded set `
        + `(${[...excluded].join(', ')}) removes. Add that migration to the set, or stop excluding `
        + `what it needs. Original error: ${message}`, { cause: error });
    }
    throw error;
  }
}
