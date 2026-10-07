/**
 * Static contract for ADR-0007 expand: canonical resource payload_json columns.
 */
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'vitest';
import { readApiCompositionSource } from '../../support/api-composition-source.js';

const MIGRATIONS_DIR = new URL('../../../migrations/', import.meta.url);
const PAYLOAD_MIGRATION = '202607222600_canonical_resource_payloads.ts';
const PHASE1_SCHEMA = '202607220900_phase1_schema.ts';

const EXPAND_COLUMNS = [
  'payload_json',
  'payload_schema_version',
  'payload_authority_status',
] as const;

const RELATIONAL_AUTHORITY_COLUMNS = [
  'title',
  'kind',
  'visibility',
  'resource_revision',
  'content_revision',
  'policy_revision',
  'root_node_id',
  'parent_id',
  'position_token',
  'children_revision',
] as const;

describe('canonical resource payload migration static contract', () => {
  test('expand migration adds payload columns without dropping relational authority fields', async () => {
    const names = (await readdir(MIGRATIONS_DIR))
      .filter((name) => name.endsWith('.ts') && !name.endsWith('.d.ts'))
      .sort();
    assert.ok(names.includes(PAYLOAD_MIGRATION), `missing ${PAYLOAD_MIGRATION}`);
    assert.ok(names.includes(PHASE1_SCHEMA), `missing baseline ${PHASE1_SCHEMA}`);
    assert.ok(
      names.indexOf(PAYLOAD_MIGRATION) > names.indexOf(PHASE1_SCHEMA),
      'payload expand must sort after phase1 schema',
    );

    const source = await readFile(new URL(PAYLOAD_MIGRATION, MIGRATIONS_DIR), 'utf8');
    assert.match(source, /export async function up/);
    assert.match(source, /export async function down/);
    assert.match(source, /export const migration|export default migration/);
    assert.match(source, /collections/);
    assert.match(source, /nodes/);
    assert.match(source, /ADD COLUMN/i);
    assert.match(source, /payload_json\s+jsonb/i);
    assert.match(source, /payload_schema_version/i);
    assert.match(source, /payload_authority_status/i);
    assert.match(source, /'pending'\s*,\s*'backfilled'\s*,\s*'malformed'|IN\s*\(\s*'pending'/i);
    assert.match(source, /materializeCollectionPayload|backfill/i);
    assert.match(source, /materializeNodePayload|malformed/i);
    assert.match(source, /live collection .* is malformed/i);
    assert.match(source, /live node .* is malformed/i);
    assert.match(source, /canonical payload backfill blocked/i);
    assert.match(source, /forEachQueryPage/);
    assert.match(source, /keysetIdPredicate/);
    assert.match(source, /ORDER BY id/);
    assert.match(source, /LIMIT \$\{limit\}/);
    assert.doesNotMatch(source, /FROM collections\s*`\.execute/);
    assert.doesNotMatch(source, /FROM nodes\s*`\.execute/);

    for (const column of EXPAND_COLUMNS) {
      assert.match(source, new RegExp(`\\b${column}\\b`), `missing expand column ${column}`);
    }

    // Must not drop relational authority columns.
    for (const column of RELATIONAL_AUTHORITY_COLUMNS) {
      assert.doesNotMatch(
        source,
        new RegExp(`DROP COLUMN\\s+(IF EXISTS\\s+)?${column}\\b`, 'i'),
        `must not drop relational authority column ${column}`,
      );
    }

    // Expand must not claim contract completion or drop tables.
    assert.doesNotMatch(source, /DROP TABLE\s+(IF EXISTS\s+)?(collections|nodes)\b/i);
    assert.doesNotMatch(
      source,
      /CREATE TABLE\s+(publications|sync_sessions|subscriptions|attachments|annotations|relations)\b/i,
    );

    // Baseline schema must not already define resource payload columns.
    const baseline = await readFile(new URL(PHASE1_SCHEMA, MIGRATIONS_DIR), 'utf8');
    // operations/outbox already use payload_json — only assert collections/nodes create blocks lack resource payload authority columns.
    assert.doesNotMatch(baseline, /CREATE TABLE collections[\s\S]*?payload_schema_version/i);
    assert.doesNotMatch(baseline, /CREATE TABLE nodes[\s\S]*?payload_schema_version/i);
    assert.doesNotMatch(baseline, /payload_authority_status/);
  });

  test('catalog payload repair pages collections and nodes by id', async () => {
    const source = await readFile(
      new URL('202609230500_collection_catalog_and_node_payloads.ts', MIGRATIONS_DIR),
      'utf8',
    );
    assert.match(source, /forEachQueryPage/);
    assert.match(source, /keysetIdPredicate/);
    assert.match(source, /ORDER BY id/);
    assert.match(source, /LIMIT \$\{limit\}/);
    assert.doesNotMatch(source, /FROM collections\s*`\.execute/);
    assert.doesNotMatch(source, /FROM nodes\s*`\.execute/);
  });

  test('down is rollback-safe for expand payload columns only', async () => {
    const source = await readFile(new URL(PAYLOAD_MIGRATION, MIGRATIONS_DIR), 'utf8');
    const downMatch = source.match(
      /export async function down[\s\S]*?(?=export const migration|export default migration|$)/,
    );
    assert.ok(downMatch, 'expected down function body');
    const down = downMatch[0];
    for (const column of EXPAND_COLUMNS) {
      assert.match(down, new RegExp(`DROP COLUMN IF EXISTS ${column}`));
    }
    for (const column of RELATIONAL_AUTHORITY_COLUMNS) {
      assert.doesNotMatch(down, new RegExp(`DROP COLUMN IF EXISTS ${column}\\b`));
    }
    assert.match(down, /collections/);
    assert.match(down, /nodes/);
  });

  test('production collection reads execute dual-read comparison with shared metrics', async () => {
    const repositories = await readFile(
      new URL('../../../src/infrastructure/collections/repositories.ts', import.meta.url),
      'utf8',
    );
    const editorQuery = await readFile(
      new URL('../../../src/infrastructure/collections/editor-query.ts', import.meta.url),
      'utf8',
    );
    const bootstrap = readApiCompositionSource(
      fileURLToPath(new URL('../../..', import.meta.url)),
    );
    assert.match(repositories, /dualReadCollectionPayload\(row, metrics\)/);
    assert.match(repositories, /dualReadNodePayload\(row, metrics\)/);
    assert.match(repositories, /'payload_json'/);
    assert.match(editorQuery, /dualReadCollectionPayload\(row, metrics\)/);
    assert.match(editorQuery, /dualReadNodePayload\(row, metrics\)/);
    assert.match(bootstrap, /createPostgresCollectionsUnitOfWork\([^;]*metrics/s);
    assert.match(bootstrap, /createPostgresCollectionsEditorReadUnitOfWork\([^;]*metrics/s);
    assert.match(bootstrap, /buildApiApp\([^;]*metrics/s);
    assert.match(bootstrap, /resource_authority_mismatch_total/);
    assert.match(bootstrap, /metricsLogger\.warn/);
  });
});
