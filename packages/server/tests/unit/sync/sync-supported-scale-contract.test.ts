import { admitCanonicalTreeChange } from '../../../src/infrastructure/collections/canonical-tree-capacity.js';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'vitest';
import {
  SYNC_SUPPORTED_TREE_CAPACITY,
} from '../../../src/infrastructure/sync/sync-tree-capacity-admission.js';
import {
  SNAPSHOT_TREE_CAPACITY,
} from '../../../src/modules/collections/index.js';

/**
 * T-10 supported-scale contract.
 *
 * These assertions lock the "one source of truth" property: the write-side
 * admission limit and the Snapshot materialization limit must be the same
 * numbers, and the page budget must never be presented as proof that an
 * aggregate-sized tree is supported.
 */
const backendRoot = resolve(import.meta.dirname, '../../..');

test('T-10 admission and Snapshot materialization share one aggregate limit', async () => {
  assert.equal(SYNC_SUPPORTED_TREE_CAPACITY, SNAPSHOT_TREE_CAPACITY);
  assert.equal(SNAPSHOT_TREE_CAPACITY.maxNodes, 10_000);
  assert.equal(SNAPSHOT_TREE_CAPACITY.maxAggregateBytes, 2 * 1024 * 1024);

  const materializer = await readFile(
    resolve(backendRoot, 'src/infrastructure/sync/sync-bootstrap-snapshot-postgres.ts'), 'utf8');
  // The materializer must derive its caps rather than declare its own numbers.
  assert.match(materializer,
    /const DEFAULT_MAX_SNAPSHOT_NODES: number = SNAPSHOT_TREE_CAPACITY\.maxNodes;/u);
  assert.match(materializer,
    /const DEFAULT_MAX_SNAPSHOT_BYTES: number = SNAPSHOT_TREE_CAPACITY\.maxAggregateBytes;/u);
  assert.equal(/DEFAULT_MAX_SNAPSHOT_NODES = 10_000/u.test(materializer), false);
  assert.equal(/DEFAULT_MAX_SNAPSHOT_BYTES = 2 \* 1024 \* 1024/u.test(materializer), false);
});

test('canonical capacity admits UTF-8 boundary and shrinking legacy oversized trees', () => {
  const limit = SNAPSHOT_TREE_CAPACITY.maxAggregateBytes;
  for (const bytes of [limit - 1, limit]) assert.doesNotThrow(() => admitCanonicalTreeChange({ nodes: 1, bytes: 1 }, { nodes: 1, bytes }));
  assert.throws(() => admitCanonicalTreeChange({ nodes: 1, bytes: limit }, { nodes: 1, bytes: limit + 1 }));
  assert.doesNotThrow(() => admitCanonicalTreeChange({ nodes: 1, bytes: limit + 10 }, { nodes: 1, bytes: limit + 1 }));
  assert.throws(() => admitCanonicalTreeChange({ nodes: 10_000, bytes: 1 }, { nodes: 10_001, bytes: 1 }));
});

test('T-10 page budget is not an aggregate proof and stays below the tree cap', async () => {
  const doc = await readFile(resolve(backendRoot, 'docs/sync-supported-scale.md'), 'utf8');
  assert.match(doc, /不能用“已经分页”证明大库可用/u);
  assert.match(doc, /10,000/u);
  assert.match(doc, /2 MiB/u);
  // The published contract must state the unsupported cases explicitly instead
  // of leaving them to an internal runbook.
  assert.match(doc, /## 5\. 明确不支持 \/ 未测量/u);
  assert.match(doc, /Queue backlog \| \*\*不设上限\*\*/u);
});
