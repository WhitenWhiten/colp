import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import type { Operation } from '@know-n/colp/types';
import {
  evaluateSyncNodeDelete,
  SyncNodeDeleteError,
  type TrustedSyncDeleteNode,
} from '../../../src/modules/sync/sync-node-delete.js';
import { syncNodeDeletePushRequest } from '../../fixtures/phase3/sync-node-delete.js';
import type { JsonObject } from '../../../src/modules/collections/index.js';
import type { DatabaseTransaction } from '../../../src/infrastructure/database/unit-of-work.js';
import {
  createPostgresSyncNodeTombstonePort,
  SyncNodeTombstonePersistenceError,
  MAX_TOMBSTONE_INSERT_BATCH,
  MAX_TOMBSTONE_APPEND_MEMBERS,
  type AppendSyncNodeTombstonesInput,
  type SyncNodeTombstoneMember,
} from '../../../src/infrastructure/sync/sync-node-tombstone-postgres.js';

function operation(input: Parameters<typeof syncNodeDeletePushRequest>[0] = {}): Operation {
  return syncNodeDeletePushRequest(input).operations[0]!;
}

function node(input: Partial<TrustedSyncDeleteNode> = {}): TrustedSyncDeleteNode {
  return {
    id: 'delete-node-1', collectionId: 'delete-collection-1', revision: 'delete-node-r1',
    kind: 'bookmark', isRoot: false, deleted: false, ...input,
  };
}

function expectCode(action: () => unknown, code: SyncNodeDeleteError['code']): void {
  assert.throws(action, (error: unknown) => error instanceof SyncNodeDeleteError && error.code === code);
}

describe('P3-15 canonical Node delete evaluator', () => {
  test('maps Bookmark, Separator, empty Folder and recursive Folder to closed canonical intents', () => {
    for (const kind of ['bookmark', 'separator', 'folder'] as const) {
      assert.deepEqual(evaluateSyncNodeDelete(operation(), node({ kind })), {
        collectionId: 'delete-collection-1', targetId: 'delete-node-1',
        expectedCurrentRevision: 'delete-node-r1', scope: 'single',
      });
    }
    assert.deepEqual(evaluateSyncNodeDelete(operation({ subtree: true }), node({ kind: 'folder' })), {
      collectionId: 'delete-collection-1', targetId: 'delete-node-1',
      expectedCurrentRevision: 'delete-node-r1', scope: 'subtree',
    });
  });

  test('rejects stale revisions, roots, tombstoned/mismatched targets and recursive non-Folders', () => {
    expectCode(() => evaluateSyncNodeDelete(operation({ baseRevision: 'stale-r1' }), node()), 'revision_conflict');
    expectCode(() => evaluateSyncNodeDelete(operation(), node({ isRoot: true, kind: 'folder' })), 'invalid_document');
    expectCode(() => evaluateSyncNodeDelete(operation(), node({ deleted: true })), 'resource_not_found');
    expectCode(() => evaluateSyncNodeDelete(operation(), node({ collectionId: 'other' })), 'resource_not_found');
    expectCode(() => evaluateSyncNodeDelete(operation({ subtree: true }), node()), 'invalid_document');
  });

  test('accepts only the COLP closed reason payload and enforces its byte budget', () => {
    assert.deepEqual(evaluateSyncNodeDelete(operation({ reason: 'user removed bookmark' }), node()).scope, 'single');
    expectCode(() => evaluateSyncNodeDelete({ ...operation(), payload: { descendants: ['forged'] } } as Operation,
      node()), 'invalid_document');
    expectCode(() => evaluateSyncNodeDelete(operation({ reason: 'x'.repeat(4_097) }), node()), 'payload_too_large');
    expectCode(() => evaluateSyncNodeDelete({ ...operation(), payload: [] } as unknown as Operation, node()),
      'invalid_document');
  });

  test('keeps update, move and later restore operations outside the delete evaluator', () => {
    expectCode(() => evaluateSyncNodeDelete({ ...operation(), type: 'move_node' } as Operation, node()),
      'unsupported_operation');
  });
});

function tombstoneMember(targetId: string, extensions: JsonObject = {}): SyncNodeTombstoneMember {
  return { targetId, kind: 'bookmark', deleteRevision: `delete-${targetId}-r1`, extensions };
}

function tombstoneAppendInput(members: readonly SyncNodeTombstoneMember[]): AppendSyncNodeTombstonesInput {
  return {
    collectionId: 'tombstone-collection',
    rootTargetId: members[0]?.targetId ?? 'tombstone-root',
    operationId: 'tombstone-operation',
    scope: members.length === 1 ? 'single' : 'subtree',
    deleteCommitOrdinal: 42n,
    deleteCursor: 'sync-delete-42',
    deletedAt: new Date('2026-07-25T00:00:00.000Z'),
    purgeAfter: new Date('2026-08-24T00:00:00.000Z'),
    members,
  };
}

function tombstoneTransactionHarness() {
  const batches: { rows: ReadonlyArray<Record<string, unknown>> }[] = [];
  const builder = {
    values(rows: ReadonlyArray<Record<string, unknown>>) {
      batches.push({ rows: rows.map((row) => ({ ...row })) });
      return builder;
    },
    async execute() { return { numInsertedOrUpdatedRows: BigInt(batches.at(-1)!.rows.length) }; },
  };
  const transaction = {
    insertInto(table: string) {
      assert.equal(table, 'sync_node_tombstones');
      return builder;
    },
  } as unknown as DatabaseTransaction;
  return { transaction, batches };
}

function expectTombstoneCode(action: Promise<void>, code: SyncNodeTombstonePersistenceError['code']): Promise<void> {
  return assert.rejects(action, (error: unknown) => error instanceof SyncNodeTombstonePersistenceError
    && error.code === code);
}

describe('FIX-M-009 tombstone append decouples per-member payload budgets from the subtree aggregate', () => {
  test('never applies the single-payload budget to the whole subtree extensions aggregate', async () => {
    const { transaction, batches } = tombstoneTransactionHarness();
    const members = Array.from({ length: 600 }, (_, index) => tombstoneMember(`member-${index}`, {
      'https://extensions.example/tag': { id: index, payload: 'x'.repeat(200) },
    }));
    const port = createPostgresSyncNodeTombstonePort(transaction);
    await port.append(tombstoneAppendInput(members));
    const rows = batches.flatMap((batch) => batch.rows);
    assert.equal(rows.length, members.length);
    // The aggregate extensions projection (~150 KB) far exceeds the 131072-byte
    // single-payload budget while every member stays far below it: the pre-fix
    // append threw payload_too_large and rolled the whole delete back.
    assert.deepEqual(batches.map((batch) => batch.rows.length), [
      MAX_TOMBSTONE_INSERT_BATCH, members.length - MAX_TOMBSTONE_INSERT_BATCH,
    ]);
    assert.equal(rows[0]!.operation_id, 'tombstone-operation');
    assert.equal(rows[0]!.delete_cursor, 'sync-delete-42');
    assert.equal(rows[0]!.delete_commit_ordinal, 42n);
    assert.deepEqual(rows[0]!.payload_json, {
      resourceType: 'node', targetId: 'member-0', collectionId: 'tombstone-collection',
      rootTargetId: 'member-0', kind: 'bookmark', scope: 'subtree',
      deleteRevision: 'delete-member-0-r1', operationId: 'tombstone-operation',
      deleteCommitOrdinal: '42', affectedCount: members.length,
      extensions: { 'https://extensions.example/tag': { id: 0, payload: 'x'.repeat(200) } },
    });
    for (const [index, member] of members.entries()) {
      const row = rows[index]!;
      assert.equal(row.target_id, member.targetId);
      assert.equal(row.affected_count, members.length);
      assert.deepEqual((row.payload_json as { extensions: unknown }).extensions, member.extensions);
    }
  });

  test('persists one large-but-legal extension member byte-identically', async () => {
    const { transaction, batches } = tombstoneTransactionHarness();
    const extensions = { 'https://extensions.example/large': { blob: 'x'.repeat(60_000) } };
    const port = createPostgresSyncNodeTombstonePort(transaction);
    await port.append(tombstoneAppendInput([tombstoneMember('large-member', extensions)]));
    assert.equal(batches.length, 1);
    assert.equal(batches[0]!.rows.length, 1);
    const row = batches[0]!.rows[0]!;
    assert.equal(row.scope, 'single');
    assert.deepEqual((row.payload_json as { extensions: unknown }).extensions, extensions);
  });

  test('still rejects one member whose wrapped tombstone exceeds the per-item budget', async () => {
    const { transaction, batches } = tombstoneTransactionHarness();
    const port = createPostgresSyncNodeTombstonePort(transaction);
    await expectTombstoneCode(port.append(tombstoneAppendInput([tombstoneMember('oversized-member', {
      'https://extensions.example/oversized': { blob: 'x'.repeat(140_000) },
    })])), 'payload_too_large');
    assert.equal(batches.length, 0);
  });

  test('rejects integrity failures before any write and caps the total append', async () => {
    const { transaction, batches } = tombstoneTransactionHarness();
    const port = createPostgresSyncNodeTombstonePort(transaction);
    await expectTombstoneCode(port.append(tombstoneAppendInput([
      tombstoneMember('duplicate-member'), tombstoneMember('duplicate-member'),
    ])), 'integrity_failure');
    await expectTombstoneCode(port.append(tombstoneAppendInput([])), 'integrity_failure');
    await expectTombstoneCode(port.append({ ...tombstoneAppendInput([tombstoneMember('ordinal-member')]),
      deleteCommitOrdinal: 0n }), 'integrity_failure');
    await expectTombstoneCode(port.append({ ...tombstoneAppendInput([tombstoneMember('purge-member')]),
      purgeAfter: new Date('2026-07-01T00:00:00.000Z') }), 'integrity_failure');
    await expectTombstoneCode(port.append(tombstoneAppendInput([tombstoneMember('non-json-member',
      { 'https://extensions.example/non-json': { value: 1n } } as unknown as JsonObject)])),
    'integrity_failure');
    const capped = Array.from({ length: MAX_TOMBSTONE_APPEND_MEMBERS + 1 },
      (_, index) => tombstoneMember(`capped-${index}`));
    await expectTombstoneCode(port.append(tombstoneAppendInput(capped)), 'integrity_failure');
    assert.equal(batches.length, 0);
  });

  test('propagates a mid-batch database failure instead of swallowing or truncating it', async () => {
    const writes: { rows: ReadonlyArray<Record<string, unknown>> }[] = [];
    let calls = 0;
    const failing = {
      insertInto(table: string) {
        assert.equal(table, 'sync_node_tombstones');
        return {
          values(rows: ReadonlyArray<Record<string, unknown>>) {
            writes.push({ rows: rows.map((row) => ({ ...row })) });
            return this;
          },
          async execute(): Promise<unknown> {
            calls += 1;
            if (calls === 2) throw new Error('simulated batch failure');
            return {};
          },
        };
      },
    } as unknown as DatabaseTransaction;
    const port = createPostgresSyncNodeTombstonePort(failing);
    await assert.rejects(port.append(tombstoneAppendInput(Array.from(
      { length: MAX_TOMBSTONE_INSERT_BATCH + 5 }, (_, index) => tombstoneMember(`fault-${index}`),
    ))), /simulated batch failure/u);
    assert.equal(writes.length, 2);
  });
});
