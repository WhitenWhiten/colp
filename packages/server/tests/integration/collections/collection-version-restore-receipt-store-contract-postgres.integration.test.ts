import { afterAll, beforeAll } from 'vitest';
import {
  createPostgresCollectionVersionRestoreReceiptStore,
} from '../../../src/infrastructure/collections/index.js';
import {
  createUnitOfWork,
  runMigrations,
} from '../../../src/infrastructure/database/index.js';
import type { CollectionVersionRestoreReceiptStore } from '../../../src/modules/collections/index.js';
import { defineCollectionVersionRestoreReceiptStoreContract } from '../../contracts/collection-version-restore-receipt-store.contract.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

describeWithPostgres('PostgreSQL collection version restore receipt adapter', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('restore_receipt_contract', { maxConnections: 4 });
    await runMigrations(isolated.runtime.db, 'latest');
  }, 180_000);

  afterAll(async () => isolated?.close());

  function createStore(): CollectionVersionRestoreReceiptStore {
    return {
      getByCommandId: (accountId, commandId) => createUnitOfWork(isolated.runtime.db)
        .execute(({ transaction }) => createPostgresCollectionVersionRestoreReceiptStore(transaction)
          .getByCommandId(accountId, commandId)),
      persist: (row) => createUnitOfWork(isolated.runtime.db)
        .execute(({ transaction }) => createPostgresCollectionVersionRestoreReceiptStore(transaction)
          .persist(row)),
    };
  }

  defineCollectionVersionRestoreReceiptStoreContract({
    name: 'shared receipt-store behavior',
    createStore,
    reset: async () => {
      await isolated.runtime.db.deleteFrom('collection_version_restore_receipts').execute();
    },
  });
});
