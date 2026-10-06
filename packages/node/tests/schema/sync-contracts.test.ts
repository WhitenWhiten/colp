import { describe, expect, it } from 'vitest';

import { createValidatorRegistry } from '../../src/schema/index.js';

const timestamp = '2026-07-16T07:00:00Z';
const replica = {
  replicaId: 'replica-1',
  name: 'Test replica',
  kind: 'server',
  adapter: { profile: 'test-v1', version: '1.0.0' },
  capabilities: {
    read: true,
    write: true,
    events: true,
    separator: true,
    alias: true,
    annotations: 'native',
    maxBatchOperations: 10,
  },
};

describe('Sync wire contracts', () => {
  const registry = createValidatorRegistry();

  it('supports a constrained instance-scoped create_collection bootstrap Session', () => {
    const request = {
      protocolVersion: '0.1',
      replica,
      scope: 'instance',
      purpose: 'create_collection',
      clientTime: timestamp,
    };

    expect(registry.validate('syncSessionRequest', request).valid).toBe(true);
    expect(
      registry.validate('syncSessionRequest', {
        ...request,
        collection: {
          collectionId: 'collection-1',
          lastCursor: null,
          lastRevision: null,
          bootstrapMode: 'upload',
        },
      }).valid,
    ).toBe(false);
  });

  it('allows create_collection only as sequence 1 without a client-selected collectionId', () => {
    const operation = {
      opId: 'op-create',
      replicaId: 'replica-1',
      sequence: 1,
      type: 'create_collection',
      baseRevision: null,
      occurredAt: timestamp,
      payload: {
        collection: { kind: 'bookmarks', title: 'Imported', visibility: 'private' },
        root: { title: 'Imported', folderRole: 'root' },
      },
    };

    expect(registry.validate('operation', operation).valid).toBe(true);
    expect(registry.validate('operation', { ...operation, sequence: 2 }).valid).toBe(false);
    expect(
      registry.validate('operation', { ...operation, collectionId: 'client-selected' }).valid,
    ).toBe(false);
    expect(
      registry.validate('syncPush', {
        sessionId: 'session-1',
        batchId: 'batch-1',
        atomic: true,
        operations: [operation],
      }).valid,
    ).toBe(true);
    expect(
      registry.validate('syncPush', {
        sessionId: 'session-1',
        batchId: 'batch-1',
        atomic: false,
        operations: [operation],
      }).valid,
    ).toBe(false);
  });

  it('accepts typed node content updates and rejects JSON Pointer or move fields', () => {
    const operation = {
      opId: 'op-update',
      replicaId: 'replica-1',
      sequence: 7,
      collectionId: 'collection-1',
      type: 'update_node_content',
      targetId: 'node-1',
      baseRevision: 'r-1',
      occurredAt: timestamp,
      payload: {
        base: { title: 'Before', tags: ['old'] },
        value: { title: 'After', tags: ['new'] },
      },
    };

    expect(registry.validate('operation', operation).valid).toBe(true);
    expect(
      registry.validate('operation', {
        ...operation,
        payload: { changes: [{ path: '/title', base: 'Before', value: 'After' }] },
      }).valid,
    ).toBe(false);
    expect(
      registry.validate('operation', {
        ...operation,
        payload: { base: { parentId: 'root-1' }, value: { parentId: 'root-2' } },
      }).valid,
    ).toBe(false);
  });

  it('separates cursor-free HTTP Deletion Receipts from Sync Tombstones', () => {
    const receipt = {
      resourceType: 'node',
      targetId: 'node-1',
      collectionId: 'collection-1',
      scope: 'single',
      deletedAt: timestamp,
      deleteRevision: 'r-delete',
      operationId: 'op-delete',
      affectedCount: 1,
      purgeAfter: '2026-08-16T07:00:00Z',
    };

    expect(registry.validate('deletionReceipt', receipt).valid).toBe(true);
    expect(registry.validate('deletionReceipt', { ...receipt, deleteCursor: 'sync-2' }).valid).toBe(
      false,
    );
    expect(registry.validate('syncTombstone', receipt).valid).toBe(false);
    expect(registry.validate('syncTombstone', { ...receipt, deleteCursor: 'sync-2' }).valid).toBe(
      true,
    );
  });

  it('enforces terminal and deferred Operation Result cursor semantics', () => {
    const common = { opId: 'op-1', sequence: 1, warnings: [] };

    expect(
      registry.validate('operationResult', {
        ...common,
        status: 'applied',
        revision: 'r-2',
        cursor: 'sync-2',
      }).valid,
    ).toBe(true);
    expect(
      registry.validate('operationResult', {
        ...common,
        status: 'applied',
        revision: 'r-2',
        cursor: 'sync-2',
        code: 'not_applicable',
      }).valid,
    ).toBe(false);
    expect(
      registry.validate('operationResult', {
        ...common,
        status: 'applied',
        revision: 'r-2',
        cursor: 'sync-2',
        conflictId: 'conflict-1',
      }).valid,
    ).toBe(false);
    expect(registry.validate('operationResult', { ...common, status: 'applied' }).valid).toBe(false);
    expect(
      registry.validate('operationResult', {
        ...common,
        status: 'conflicted',
        conflictId: 'conflict-1',
        cursor: 'sync-2',
      }).valid,
    ).toBe(true);
    expect(
      registry.validate('operationResult', {
        ...common,
        status: 'rejected',
        code: 'invalid_update',
        cursor: 'sync-2',
      }).valid,
    ).toBe(false);
    expect(
      registry.validate('operationResult', {
        ...common,
        status: 'deferred',
        code: 'dependency_pending',
      }).valid,
    ).toBe(true);
    expect(registry.validate('operationResult', { ...common, status: 'duplicate' }).valid).toBe(false);
  });
});
