import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { isMigrationTimestampOrderError } from '../../../src/infrastructure/database/index.js';

describe('Kysely executed-migration timestamp order detector', () => {
  test('matches the Kysely 0.29 order-mismatch message and ignores other failures', () => {
    assert.equal(
      isMigrationTimestampOrderError(new Error(
        'corrupted migrations: expected previously executed migration 202609040100_seed_versions to be at index 80 but 202609050900_better_auth_schema was found in its place. New migrations must always have a name that comes alphabetically after the last executed migration.',
      )),
      true,
    );
    assert.equal(
      isMigrationTimestampOrderError(new Error('corrupted migrations: previously executed migration 202609040100_seed_versions is missing')),
      false,
    );
    assert.equal(isMigrationTimestampOrderError(new Error('relation "kysely_migration" does not exist')), false);
    assert.equal(isMigrationTimestampOrderError('corrupted migrations: expected previously executed migration x'), true);
  });
});
