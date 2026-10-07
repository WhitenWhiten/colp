import { afterAll, beforeAll } from 'vitest';
import {
  createPostgresOidcLoginTransactionRepository,
} from '../../../src/infrastructure/identity/index.js';
import {
  createUnitOfWork,
  runMigrations,
} from '../../../src/infrastructure/database/index.js';
import type { OidcLoginTransactionRepository } from '../../../src/modules/identity/index.js';
import { defineOidcLoginTransactionRepositoryContract } from '../../contracts/oidc-login-transaction-repository.contract.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

describeWithPostgres('PostgreSQL OIDC login transaction repository adapter', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('oidc_transaction_contract', { maxConnections: 4 });
    await runMigrations(isolated.runtime.db, 'latest');
  }, 180_000);

  afterAll(async () => isolated?.close());

  function createRepository(): OidcLoginTransactionRepository {
    return {
      insert: (transaction) => createUnitOfWork(isolated.runtime.db)
        .execute(({ transaction: databaseTransaction }) =>
          createPostgresOidcLoginTransactionRepository(databaseTransaction).insert(transaction)),
      consume: (browserState, now, stateDigest) => createUnitOfWork(isolated.runtime.db)
        .execute(({ transaction }) => createPostgresOidcLoginTransactionRepository(transaction)
          .consume(browserState, now, stateDigest)),
      findByState: (browserState, stateDigest) => createUnitOfWork(isolated.runtime.db)
        .execute(({ transaction }) => createPostgresOidcLoginTransactionRepository(transaction)
          .findByState(browserState, stateDigest)),
      deleteByState: (browserState, stateDigest) => createUnitOfWork(isolated.runtime.db)
        .execute(({ transaction }) => createPostgresOidcLoginTransactionRepository(transaction)
          .deleteByState(browserState, stateDigest)),
    };
  }

  defineOidcLoginTransactionRepositoryContract({
    name: 'shared OIDC transaction behavior',
    createRepository,
    reset: async () => {
      await isolated.runtime.db.deleteFrom('oidc_login_transactions').execute();
    },
  });
});
