import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'vitest';

const migrationUrl = new URL('../../../migrations/202608020100_sync_evidence_maintenance.ts', import.meta.url);

function stripBlockComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '');
}

describe('R15 sync evidence maintenance migration static contract', () => {
  test('adds a cleanup index lead by cursor_expires_at and drops only that index on down', async () => {
    const source = await readFile(migrationUrl, 'utf8');

    // up creates the expiry-first cleanup index on the evidence table.
    assert.match(source, /CREATE INDEX sync_pull_cursor_evidence_cleanup_idx/i);
    assert.match(source, /ON sync_pull_cursor_evidence\s*\(\s*cursor_expires_at,\s*replica_id\s*\)/i);

    // down drops only this migration's index and never touches evidence/proof DDL.
    assert.match(source, /DROP INDEX IF EXISTS sync_pull_cursor_evidence_cleanup_idx/i);
    assert.doesNotMatch(source, /DROP TABLE/i);
    assert.doesNotMatch(source, /DROP TRIGGER/i);
    assert.doesNotMatch(source, /DROP FUNCTION/i);
    assert.doesNotMatch(source, /ALTER TABLE/i);

    // R15 is a pure additive index: no tables, triggers, functions, or columns.
    assert.doesNotMatch(source, /CREATE TABLE/i);
    assert.doesNotMatch(source, /CREATE (?:OR REPLACE )?FUNCTION/i);
    assert.doesNotMatch(source, /CREATE TRIGGER/i);
    assert.doesNotMatch(source, /ADD COLUMN/i);

    // Kysely runs migrations inside one transaction: no CONCURRENTLY.
    assert.doesNotMatch(stripBlockComments(source), /CREATE INDEX CONCURRENTLY/i);
    assert.match(source, /Kysely runs PostgreSQL migrations in one transaction/i);
  });
});
