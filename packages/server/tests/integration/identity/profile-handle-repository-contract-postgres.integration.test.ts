import { afterAll, beforeAll } from 'vitest';
import { createPostgresProfileHandleRepository } from '../../../src/infrastructure/identity/index.js';
import {
  createUnitOfWork,
  runMigrations,
} from '../../../src/infrastructure/database/index.js';
import type { ProfileHandleRepository } from '../../../src/modules/identity/index.js';
import {
  defineProfileHandleRepositoryContract,
  PROFILE_HANDLE_CONTRACT_ACCOUNTS,
} from '../../contracts/profile-handle-repository.contract.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

describeWithPostgres('PostgreSQL profile-handle repository adapter', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('profile_handle_contract', { maxConnections: 4 });
    await runMigrations(isolated.runtime.db, 'latest');
  }, 180_000);

  afterAll(async () => isolated?.close());

  function createRepository(): ProfileHandleRepository {
    return {
      findByHandle: (handle) => createUnitOfWork(isolated.runtime.db)
        .execute(({ transaction }) => createPostgresProfileHandleRepository(transaction).findByHandle(handle)),
      findByAccountId: (accountId) => createUnitOfWork(isolated.runtime.db)
        .execute(({ transaction }) => createPostgresProfileHandleRepository(transaction)
          .findByAccountId(accountId)),
      insert: (handle) => createUnitOfWork(isolated.runtime.db)
        .execute(({ transaction }) => createPostgresProfileHandleRepository(transaction).insert(handle)),
      tryInsert: (handle) => createUnitOfWork(isolated.runtime.db)
        .execute(({ transaction }) => createPostgresProfileHandleRepository(transaction).tryInsert(handle)),
      deleteByAccountId: (accountId) => createUnitOfWork(isolated.runtime.db)
        .execute(({ transaction }) => createPostgresProfileHandleRepository(transaction)
          .deleteByAccountId(accountId)),
      deleteByHandle: (handle) => createUnitOfWork(isolated.runtime.db)
        .execute(({ transaction }) => createPostgresProfileHandleRepository(transaction).deleteByHandle(handle)),
    };
  }

  defineProfileHandleRepositoryContract({
    name: 'shared profile-handle behavior',
    createRepository,
    reset: async () => {
      await isolated.runtime.db.deleteFrom('profile_handles').execute();
      await isolated.runtime.db.deleteFrom('accounts').execute();
      await isolated.runtime.db.insertInto('accounts').values(
        PROFILE_HANDLE_CONTRACT_ACCOUNTS.map((id, index) => ({
          id,
          subject_id: `contract-handle-subject-${index}`,
          status: 'active' as const,
          email: null,
          security_epoch: 0n,
          created_at: CREATED_AT,
          deleted_at: null,
        })),
      ).execute();
    },
  });
});

const CREATED_AT = new Date('2026-08-30T10:30:00.000Z');
