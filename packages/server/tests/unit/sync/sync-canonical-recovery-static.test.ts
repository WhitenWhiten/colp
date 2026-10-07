import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'vitest';

describe('P3-32 non-Sync canonical mutation convergence', () => {
  test('Product and Publisher Node writers force active replicas through Snapshot recovery', async () => {
    const [adapter, product, publisher] = await Promise.all([
      readFile(new URL('../../../src/infrastructure/collections/canonical-mutation-postgres-ports.ts', import.meta.url), 'utf8'),
      readFile(new URL('../../../src/infrastructure/collections/canonical-product-unit-of-work.ts', import.meta.url), 'utf8'),
      readFile(new URL('../../../src/infrastructure/publisher/canonical-unit-of-work.ts', import.meta.url), 'utf8'),
    ]);
    assert.match(adapter, /invalidateSyncReplicasOnNodeMutation/u);
    assert.match(adapter, /status:\s*'recovery_required'/u);
    assert.match(adapter, /where\('status',\s*'=',\s*'active'\)/u);
    assert.match(product, /invalidateSyncReplicasOnNodeMutation:\s*true/u);
    assert.match(publisher, /invalidateSyncReplicasOnNodeMutation:\s*true/u);
  });

  test('MCP changes.commit and classify-inbox accept writers force active replicas through Snapshot recovery', async () => {
    const [mcpWritePorts, classifyAccept] = await Promise.all([
      readFile(new URL('../../../src/bootstrap/mcp-write-postgres-ports.ts', import.meta.url), 'utf8'),
      readFile(new URL('../../../src/infrastructure/collections/classify-inbox-accept-postgres.ts', import.meta.url), 'utf8'),
    ]);
    // Both write paths have no Replica/Sequence identity, so their Operations
    // cannot reach a replica through the incremental Push/Pull protocol; the
    // only honest delivery is the forced Snapshot recovery below.
    assert.match(mcpWritePorts, /invalidateSyncReplicasOnNodeMutation:\s*true/u);
    assert.match(classifyAccept, /createClassificationCanonicalPorts\(transaction, options\)/u);
    const classificationPorts = await readFile(new URL('../../../src/infrastructure/collections/classification-canonical-ports.ts', import.meta.url), 'utf8');
    assert.match(classificationPorts, /invalidateSyncReplicasOnNodeMutation:\s*true/u);
    // T-10 / ADR-0027: the invalidating UPDATE touches `sync_replicas`, so the
    // Collection-first entry points must take the replica rows before the
    // Collection row.
    assert.match(mcpWritePorts, /lockCollectionForReplicaInvalidation/u);
    assert.match(classificationPorts, /lockCollectionForReplicaInvalidation/u);
  });

  test('readiness binds COLP 0.2 advertisement to effect migration authority', async () => {
    const runtime = await readFile(new URL('../../../src/infrastructure/database/runtime.ts', import.meta.url), 'utf8');
    for (const authority of [
      '202607252700_sync_operation_effects',
      'sync_collection_effect_cutovers',
      'sync_operation_effects',
      'sync_operation_effect_pages',
      'sync_operation_effect_operation_fk',
    ]) assert.match(runtime, new RegExp(authority, 'u'));
  });
});
