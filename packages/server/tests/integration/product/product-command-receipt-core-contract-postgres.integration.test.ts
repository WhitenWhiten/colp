import { afterAll, beforeAll } from 'vitest';
import {
  createPostgresProductCommandReceiptPort,
  createUnitOfWork,
  runMigrations,
} from '../../../src/infrastructure/database/index.js';
import type { ProductCommandReceiptPort } from '../../../src/modules/commands/index.js';
import { defineProductCommandReceiptCoreContract } from '../../contracts/product-command-receipt-core.contract.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

describeWithPostgres('PostgreSQL product-command receipt core adapter', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('command_receipt_contract', { maxConnections: 4 });
    await runMigrations(isolated.runtime.db, 'latest');
  }, 180_000);

  afterAll(async () => isolated?.close());

  function createPort(): ProductCommandReceiptPort {
    return {
      claim: (binding, fingerprint) => createUnitOfWork(isolated.runtime.db)
        .execute(({ transaction }) => createPostgresProductCommandReceiptPort(transaction)
          .claim(binding, fingerprint)),
      complete: (binding, fingerprint, result) => createUnitOfWork(isolated.runtime.db)
        .execute(({ transaction }) => createPostgresProductCommandReceiptPort(transaction)
          .complete(binding, fingerprint, result)),
      purgeExpired: (options) => createUnitOfWork(isolated.runtime.db)
        .execute(({ transaction }) => createPostgresProductCommandReceiptPort(transaction)
          .purgeExpired(options)),
      deletePrincipalReceipts: (principalId) => createUnitOfWork(isolated.runtime.db)
        .execute(({ transaction }) => createPostgresProductCommandReceiptPort(transaction)
          .deletePrincipalReceipts(principalId)),
    };
  }

  defineProductCommandReceiptCoreContract({
    name: 'shared product-command receipt behavior',
    createPort,
    reset: async () => {
      await isolated.runtime.db.deleteFrom('product_command_receipts').execute();
    },
  });
});
