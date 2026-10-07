import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'vitest';

const migrationUrl = new URL(
  '../../../migrations/202608011000_nodes_live_sibling_position_c_idx.ts',
  import.meta.url,
);
const phase1SchemaUrl = new URL('../../../migrations/202607220900_phase1_schema.ts', import.meta.url);

function stripBlockComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '');
}

describe('live sibling C collation index static contract', () => {
  test('migration defines the R08 index without concurrent build or dropping the unique sibling index', async () => {
    const [migration, phase1Schema] = await Promise.all([
      readFile(migrationUrl, 'utf8'),
      readFile(phase1SchemaUrl, 'utf8'),
    ]);

    assert.match(migration, /CREATE INDEX nodes_live_sibling_position_c_idx/i);
    assert.match(
      migration,
      /ON nodes\s*\(\s*collection_id,\s*parent_id,\s*\(position_token COLLATE "C"\),\s*id\s*\)/is,
    );
    assert.match(migration, /WHERE deleted_at IS NULL/i);
    assert.match(migration, /DROP INDEX IF EXISTS nodes_live_sibling_position_c_idx/i);
    assert.doesNotMatch(stripBlockComments(migration), /CREATE INDEX CONCURRENTLY/i);
    assert.doesNotMatch(migration, /enable_(seqscan|sort|indexscan)/i);
    assert.doesNotMatch(migration, /DROP INDEX nodes_live_sibling_position_unique/i);
    assert.doesNotMatch(migration, /nodes_live_sibling_position_unique/i);

    assert.match(phase1Schema, /CREATE UNIQUE INDEX nodes_live_sibling_position_unique/i);
    assert.match(migration, /Kysely runs PostgreSQL migrations in one transaction/i);
  });
});
