import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'vitest';
import type { Operation } from '@know-n/colp/types';
import { mapSyncNodeCreateOperation } from '../../../src/modules/sync/sync-node-create.js';

describe('T-05 system Recovered create contract', () => {
  test('R-01: mapSyncNodeCreateOperation accepts the system Recovered document', () => {
    const operation = {
      opId: 'op-system-rec', replicaId: 'replica-system', sequence: 1, type: 'create_node',
      collectionId: 'collection-1', baseRevision: null, occurredAt: '2026-09-10T00:00:00.000Z',
      dependencies: [], payload: {
        parentId: 'mount-1',
        node: { kind: 'folder', title: 'Recovered', folderRole: 'recovered' },
      },
    } satisfies Operation;
    const mapped = mapSyncNodeCreateOperation(operation, { managedBookmarkWrites: false });
    assert.equal(mapped.folderRole, 'recovered');
    assert.equal(mapped.parentId, 'mount-1');
    assert.equal(mapped.operationId, 'op-system-rec');
    assert.equal(mapped.replicaId, 'replica-system');
    assert.equal(mapped.sequence, 1);
  });

  test('system create uses canonical mutation and does not Product-invalidate replicas', async () => {
    const source = await readFile(new URL(
      '../../../src/infrastructure/sync/postgres/sync-recovered-create-postgres.ts', import.meta.url), 'utf8');
    assert.match(source, /mapSyncNodeCreateOperation/);
    assert.match(source, /syncCanonicalMutationInput/);
    assert.match(source, /createCanonicalMutationApplication/);
    assert.match(source, /persistAuthoritativeOperationEffect/);
    assert.doesNotMatch(source, /invalidateSyncReplicasOnNodeMutation/);
    assert.doesNotMatch(source, /INSERT INTO nodes/i);
  });
});
