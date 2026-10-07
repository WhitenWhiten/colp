import assert from 'node:assert/strict';
import { test } from 'vitest';
import { ONLINE_PERFORMANCE_INDEXES } from '../../../src/infrastructure/database/online-performance-indexes.js';

test('attachment command lookup has a permanent unique fact index contract', () => {
  const definition = ONLINE_PERFORMANCE_INDEXES.attachmentFinalize;
  assert.equal(definition.name, 'operation_lookup_facts_command_unique');
  assert.equal(definition.tableName, 'operation_lookup_facts');
  assert.match(definition.createConcurrentlySql, /CREATE UNIQUE INDEX CONCURRENTLY/iu);
  assert.match(
    definition.createConcurrentlySql,
    /ON operation_lookup_facts\s*\(\s*operation_type,\s*command_id\s*\)/iu,
  );
  assert.match(definition.createConcurrentlySql, /command_id IS NOT NULL/iu);
});
