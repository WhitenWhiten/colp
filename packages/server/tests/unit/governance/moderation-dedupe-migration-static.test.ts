import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'vitest';

/**
 * CG-F011: the unit moderation-store harness replicates the production
 * dedupe predicate (open-state only) in memory, so a widening of the
 * production unique index to all case statuses would go undetected at unit
 * level (the memory mock keeps passing). Pin the production definition
 * statically: a structural change to the dedupe index must fail here.
 */
test('CG-F011 the production case-dedupe index stays open-status only', async () => {
  const migration = await readFile(
    new URL('../../../migrations/202610012500_moderation_cases_and_roles.ts', import.meta.url),
    'utf8',
  );
  const index = migration.match(
    /CREATE UNIQUE INDEX IF NOT EXISTS moderation_cases_open_dedupe[\s\S]*?WHERE status IN \('submitted', 'in_review'\)/u,
  )?.[0];
  assert.ok(index, 'the open-dedupe partial unique index must remain UNIQUE + open-status-scoped');
  // A structural change to the index definition (dropping the partial WHERE,
  // renaming, removing UNIQUE) breaks this pin — the unit harness that
  // replicates the predicate in memory would otherwise stay green.
  assert.doesNotMatch(index, /'resolved'|'dismissed'/u,
    'closed/terminal statuses must never participate in the open-case dedupe');
});