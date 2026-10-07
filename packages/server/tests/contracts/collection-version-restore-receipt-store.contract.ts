import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'vitest';
import {
  COLLECTION_VERSION_RESTORE_RECEIPT_FIFO_LIMIT,
  CollectionVersionRestoreReceiptConflictError,
  type CollectionVersionRestoreReceiptRow,
  type CollectionVersionRestoreReceiptStore,
} from '../../src/modules/collections/index.js';

const ACCOUNT = 'contract-account';
const COLLECTION = 'contract-collection';
const OTHER_COLLECTION = 'contract-other-collection';
const CREATED_AT = new Date('2026-08-24T08:00:00.000Z');

export interface CollectionVersionRestoreReceiptStoreContractOptions {
  readonly name: string;
  readonly createStore: () => CollectionVersionRestoreReceiptStore | Promise<CollectionVersionRestoreReceiptStore>;
  readonly reset?: () => void | Promise<void>;
}

function receiptRow(
  commandId: string,
  overrides: Partial<CollectionVersionRestoreReceiptRow> = {},
): CollectionVersionRestoreReceiptRow {
  const versionId = overrides.versionId ?? 'contract-version';
  return {
    commandId,
    versionId,
    collectionId: overrides.collectionId ?? COLLECTION,
    accountId: overrides.accountId ?? ACCOUNT,
    innerCommands: overrides.innerCommands ?? {
      updateCommandIds: ['update-command'],
      moveCommandIds: ['move-command'],
      deleteCommandIds: ['delete-command'],
    },
    result: overrides.result ?? {
      versionId,
      noop: false,
      updatedNodeIds: ['updated-node'],
      movedNodeIds: ['moved-node'],
      deletedNodeIds: ['deleted-node'],
      preRestoreVersionId: 'pre-restore-version',
    },
    createdAt: overrides.createdAt ?? CREATED_AT,
  };
}

/**
 * Registers the same observable store contract for every adapter. Keeping the
 * assertions here prevents test doubles and PostgreSQL implementations from
 * acquiring independent, manually maintained semantics.
 */
export function defineCollectionVersionRestoreReceiptStoreContract(
  options: CollectionVersionRestoreReceiptStoreContractOptions,
): void {
  describe(options.name, () => {
    beforeEach(async () => options.reset?.());

    test('round-trips the complete receipt and scopes reads by account', async () => {
      const store = await options.createStore();
      const row = receiptRow('contract-round-trip');

      await store.persist(row);

      assert.deepEqual(await store.getByCommandId(ACCOUNT, row.commandId), row);
      assert.equal(await store.getByCommandId('contract-other-account', row.commandId), null);
      assert.equal(await store.getByCommandId(ACCOUNT, 'contract-missing'), null);
    });

    test('rejects command-id reuse without replacing the winner', async () => {
      const store = await options.createStore();
      const winner = receiptRow('contract-duplicate');
      await store.persist(winner);

      await assert.rejects(
        () => store.persist(receiptRow(winner.commandId, {
          accountId: 'contract-other-account',
          collectionId: OTHER_COLLECTION,
          versionId: 'contract-loser-version',
        })),
        (error: unknown) => error instanceof CollectionVersionRestoreReceiptConflictError,
      );

      assert.deepEqual(await store.getByCommandId(ACCOUNT, winner.commandId), winner);
      assert.equal(await store.getByCommandId('contract-other-account', winner.commandId), null);
    });

    test('trims the oldest receipt per collection without touching another collection', async () => {
      const store = await options.createStore();
      const unrelated = receiptRow('contract-unrelated', {
        collectionId: OTHER_COLLECTION,
        createdAt: new Date('2026-08-24T06:00:00.000Z'),
      });
      const oldest = receiptRow('contract-fifo-oldest', {
        createdAt: new Date('2026-08-24T07:00:00.000Z'),
      });
      await store.persist(unrelated);
      await store.persist(oldest);

      for (let index = 0; index < COLLECTION_VERSION_RESTORE_RECEIPT_FIFO_LIMIT; index += 1) {
        await store.persist(receiptRow(`contract-fifo-${String(index).padStart(3, '0')}`, {
          createdAt: new Date(CREATED_AT.getTime() + index * 1_000),
        }));
      }

      assert.equal(await store.getByCommandId(ACCOUNT, oldest.commandId), null);
      assert.deepEqual(await store.getByCommandId(ACCOUNT, unrelated.commandId), unrelated);
      assert.equal(
        (await store.getByCommandId(ACCOUNT, 'contract-fifo-049'))?.commandId,
        'contract-fifo-049',
      );
    });

    test('uses command id as the deterministic FIFO tie-breaker', async () => {
      const store = await options.createStore();
      for (let index = COLLECTION_VERSION_RESTORE_RECEIPT_FIFO_LIMIT; index >= 0; index -= 1) {
        await store.persist(receiptRow(`contract-tie-${String(index).padStart(3, '0')}`));
      }

      assert.equal(await store.getByCommandId(ACCOUNT, 'contract-tie-000'), null);
      assert.equal(
        (await store.getByCommandId(ACCOUNT, 'contract-tie-050'))?.commandId,
        'contract-tie-050',
      );
    });
  });
}
