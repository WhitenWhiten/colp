import { afterAll, beforeAll } from 'vitest';
import { createPostgresAccountRepository } from '../../../src/infrastructure/identity/index.js';
import {
  createUnitOfWork,
  runMigrations,
} from '../../../src/infrastructure/database/index.js';
import type { AccountRepository } from '../../../src/modules/identity/index.js';
import { defineAccountRepositoryContract } from '../../contracts/account-repository.contract.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

describeWithPostgres('PostgreSQL account repository adapter', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('account_repository_contract', { maxConnections: 4 });
    await runMigrations(isolated.runtime.db, 'latest');
  }, 180_000);

  afterAll(async () => isolated?.close());

  function createRepository(): AccountRepository {
    return {
      findById: (id) => createUnitOfWork(isolated.runtime.db)
        .execute(({ transaction }) => createPostgresAccountRepository(transaction).findById(id)),
      findBySubjectId: (subjectId) => createUnitOfWork(isolated.runtime.db)
        .execute(({ transaction }) => createPostgresAccountRepository(transaction).findBySubjectId(subjectId)),
      findByEmail: (email) => createUnitOfWork(isolated.runtime.db)
        .execute(({ transaction }) => createPostgresAccountRepository(transaction).findByEmail(email)),
      insert: (account) => createUnitOfWork(isolated.runtime.db)
        .execute(({ transaction }) => createPostgresAccountRepository(transaction).insert(account)),
      bumpSecurityEpoch: (accountId) => createUnitOfWork(isolated.runtime.db)
        .execute(({ transaction }) => createPostgresAccountRepository(transaction)
          .bumpSecurityEpoch(accountId)),
      updateEmail: (accountId, email) => createUnitOfWork(isolated.runtime.db)
        .execute(({ transaction }) => createPostgresAccountRepository(transaction).updateEmail(accountId, email)),
      markDeleted: (accountId, deletedAt) => createUnitOfWork(isolated.runtime.db)
        .execute(({ transaction }) => createPostgresAccountRepository(transaction)
          .markDeleted(accountId, deletedAt)),
    };
  }

  defineAccountRepositoryContract({
    name: 'shared account behavior',
    createRepository,
    reset: async () => {
      await isolated.runtime.db.deleteFrom('accounts').execute();
    },
  });
});
