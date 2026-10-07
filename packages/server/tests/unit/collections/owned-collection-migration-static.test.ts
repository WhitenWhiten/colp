/**
 * Static contract for P1-04 collections.summary expand migration.
 */
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { describe, test } from 'vitest';

const MIGRATIONS_DIR = new URL('../../../migrations/', import.meta.url);
const SUMMARY_MIGRATION = '202607221800_collection_summary.ts';

describe('owned collection summary migration static contract', () => {
  test('expand migration adds collections.summary with length check and explicit up/down', async () => {
    const names = (await readdir(MIGRATIONS_DIR))
      .filter((name) => name.endsWith('.ts') && !name.endsWith('.d.ts'))
      .sort();
    assert.ok(names.includes(SUMMARY_MIGRATION), `missing ${SUMMARY_MIGRATION}`);

    const source = await readFile(new URL(SUMMARY_MIGRATION, MIGRATIONS_DIR), 'utf8');
    assert.match(source, /export async function up/);
    assert.match(source, /export async function down/);
    assert.match(source, /export const migration|export default migration/);
    assert.match(source, /\bsummary\b/);
    assert.match(source, /collections/i);
    assert.match(source, /ADD COLUMN\s+summary/i);
    assert.match(source, /2000/);
    assert.match(source, /DROP COLUMN/i);

    // Expand-only: do not rewrite the committed Phase 0 baseline.
    const baseline = await readFile(new URL('202607220900_phase1_schema.ts', MIGRATIONS_DIR), 'utf8');
    assert.doesNotMatch(baseline, /\bsummary\b/);

    assert.doesNotMatch(
      source,
      /CREATE TABLE\s+(publications|sync_sessions|subscriptions|attachments)\b/i,
      'summary migration must not create future-phase tables',
    );
  });
});
