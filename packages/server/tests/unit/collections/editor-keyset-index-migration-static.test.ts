import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'vitest';
import { ONLINE_PERFORMANCE_INDEXES } from '../../../src/infrastructure/database/online-performance-indexes.js';

const editorQueryUrl = new URL(
  '../../../src/infrastructure/collections/editor-query.ts',
  import.meta.url,
);

describe('live Editor keyset index static contract', () => {
  test('online manifest and production query use the same comparator and predicate', async () => {
    const definition = ONLINE_PERFORMANCE_INDEXES.nodesLiveEditorKeyset;
    const query = await readFile(editorQueryUrl, 'utf8');

    assert.equal(definition.name, 'nodes_live_editor_keyset_idx');
    assert.equal(definition.tableName, 'nodes');
    assert.match(definition.createConcurrentlySql, /CREATE INDEX CONCURRENTLY/i);
    assert.match(
      definition.createConcurrentlySql,
      /ON nodes\s*\(\s*collection_id,\s*\(COALESCE\(parent_id, ''::text\) COLLATE "C"\),\s*\(COALESCE\(position_token, ''::text\) COLLATE "C"\),\s*\(id COLLATE "C"\)/is,
    );
    assert.match(definition.createConcurrentlySql, /WHERE deleted_at IS NULL AND NOT is_root/i);
    assert.doesNotMatch(definition.createConcurrentlySql, /enable_(seqscan|sort|indexscan)/i);

    assert.match(query, /COALESCE\(parent_id, ''::text\) COLLATE "C"/i);
    assert.match(query, /COALESCE\(position_token, ''::text\) COLLATE "C"/i);
    assert.match(query, /id COLLATE "C"/i);
    assert.match(query, /NOT is_root/);
    assert.match(query, /\.where\('deleted_at', 'is', null\)/);
    assert.match(query, /\$\{editorParentKey\},\s*\$\{editorPositionKey\},\s*\$\{editorNodeIdKey\}/s);
    assert.match(query, /\.orderBy\(editorParentKey\)\s*\.orderBy\(editorPositionKey\)\s*\.orderBy\(editorNodeIdKey\)/s);
    assert.doesNotMatch(query, /CASE WHEN (parent_id|position_token) IS NULL/i);
  });
});
