import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  SNAPSHOT_COMPLETED_AT_SQL, SNAPSHOT_GENERATED_AT_SQL, snapshotCompletedAtMs,
  snapshotCompletionWindowHolds, snapshotExpiresAtSql,
} from '../../../src/infrastructure/sync/sync-bootstrap-snapshot-clock.js';

test('JS Date ahead of PostgreSQL current_timestamp inverts generated vs completed', () => {
  const databaseNow = Date.parse('2026-09-10T01:42:17.804Z');
  const jsGenerated = Date.parse('2026-09-10T01:42:18.466Z');
  const expires = jsGenerated + 10 * 60_000;
  assert.equal(snapshotCompletionWindowHolds(jsGenerated, databaseNow, expires), false);
});

test('GREATEST(generated_at, current_timestamp) restores the completion window', () => {
  const databaseNow = Date.parse('2026-09-10T01:42:17.804Z');
  const jsGenerated = Date.parse('2026-09-10T01:42:18.466Z');
  const expires = jsGenerated + 10 * 60_000;
  const completed = snapshotCompletedAtMs(jsGenerated, databaseNow);
  assert.equal(snapshotCompletionWindowHolds(jsGenerated, completed, expires), true);
  assert.equal(completed, jsGenerated);
});

test('same-clock generated and completed stay ordered', () => {
  const generated = Date.parse('2026-09-10T01:42:17.804Z');
  const completed = Date.parse('2026-09-10T01:42:18.100Z');
  const expires = generated + 300_000;
  assert.equal(snapshotCompletedAtMs(generated, completed), completed);
  assert.equal(snapshotCompletionWindowHolds(generated, completed, expires), true);
});

test('expiry equality completed === expires is outside the CHECK window and must not complete', () => {
  const generated = Date.parse('2026-09-10T01:42:17.804Z');
  const expires = generated + 300_000;
  assert.equal(snapshotCompletionWindowHolds(generated, expires, expires), false);
  assert.equal(snapshotCompletionWindowHolds(generated, expires - 1, expires), true);
});

test('SQL fragments bind Snapshot times to PostgreSQL current_timestamp', () => {
  assert.equal(SNAPSHOT_GENERATED_AT_SQL, 'current_timestamp');
  assert.equal(SNAPSHOT_COMPLETED_AT_SQL, 'GREATEST(generated_at, current_timestamp)');
  assert.equal(snapshotExpiresAtSql('$14'), "current_timestamp + ($14::bigint * interval '1 millisecond')");
  assert.doesNotMatch(SNAPSHOT_GENERATED_AT_SQL + SNAPSHOT_COMPLETED_AT_SQL + snapshotExpiresAtSql('$1'), /Date/);
});
