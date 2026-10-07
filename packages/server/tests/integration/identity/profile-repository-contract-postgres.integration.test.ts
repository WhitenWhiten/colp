import { afterAll, beforeAll } from 'vitest';
import { createPostgresProfileRepository } from '../../../src/infrastructure/identity/index.js';
import {
  createUnitOfWork,
  runMigrations,
} from '../../../src/infrastructure/database/index.js';
import type { ProfileRepository } from '../../../src/modules/identity/index.js';
import {
  defineProfileRepositoryContract,
  PROFILE_REPOSITORY_CONTRACT_ACCOUNT_ID,
} from '../../contracts/profile-repository.contract.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

describeWithPostgres('PostgreSQL profile repository adapter', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('profile_repository_contract', { maxConnections: 4 });
    await runMigrations(isolated.runtime.db, 'latest');
  }, 180_000);

  afterAll(async () => isolated?.close());

  function createRepository(): ProfileRepository {
    return {
      findByAccountId: (accountId) => createUnitOfWork(isolated.runtime.db)
        .execute(({ transaction }) => createPostgresProfileRepository(transaction).findByAccountId(accountId)),
      insert: (profile) => createUnitOfWork(isolated.runtime.db)
        .execute(({ transaction }) => createPostgresProfileRepository(transaction).insert(profile)),
      update: (profile) => createUnitOfWork(isolated.runtime.db)
        .execute(({ transaction }) => createPostgresProfileRepository(transaction).update(profile)),
    };
  }

  defineProfileRepositoryContract({
    name: 'shared profile behavior',
    createRepository,
    reset: async () => {
      await isolated.runtime.db.deleteFrom('profiles').execute();
      await isolated.runtime.db.deleteFrom('accounts').execute();
      await isolated.runtime.db.insertInto('accounts').values({
        id: PROFILE_REPOSITORY_CONTRACT_ACCOUNT_ID,
        subject_id: 'contract-profile-subject',
        status: 'active',
        email: null,
        security_epoch: 0n,
        created_at: new Date('2026-08-30T10:00:00.000Z'),
        deleted_at: null,
      }).execute();
    },
  });
});
