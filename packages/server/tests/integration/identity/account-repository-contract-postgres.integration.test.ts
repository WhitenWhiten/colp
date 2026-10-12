import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
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

  test('findUsername reads the mapped Better Auth username', async () => {
    const pool = isolated.runtime.pool;
    const read = (accountId: string) => createUnitOfWork(isolated.runtime.db)
      .execute(({ transaction }) => createPostgresAccountRepository(transaction).findUsername?.(accountId));
    await pool.query(`insert into accounts(id, subject_id, status, email, security_epoch, created_at)
      values ('acct-named','subject-named','active',null,0,current_timestamp),
             ('acct-unnamed','subject-unnamed','active',null,0,current_timestamp)`);
    await pool.query(`insert into "auth_users" ("id","name","email","emailVerified","username")
      values ('auth-named','Whiten','whiten@users.invalid',false,'whiten'),
             ('auth-unnamed','Email only','email@example.test',true,null)`);
    await pool.query(`insert into auth_user_account_map(auth_user_id, account_id)
      values ('auth-named','acct-named'),('auth-unnamed','acct-unnamed')`);
    try {
      assert.equal(await read('acct-named'), 'whiten');
      assert.equal(await read('acct-unnamed'), null);
      assert.equal(await read('acct-missing'), null);
    } finally {
      await pool.query(`delete from auth_user_account_map where account_id in ('acct-named','acct-unnamed')`);
      await pool.query(`delete from "auth_users" where id in ('auth-named','auth-unnamed')`);
      await pool.query(`delete from accounts where id in ('acct-named','acct-unnamed')`);
    }
  });
});
