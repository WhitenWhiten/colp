import { test, expect } from 'vitest';
import { createIsolatedPostgresRuntime } from '../../support/postgres-test-runtime.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { createPostgresAccountDeletionStore } from '../../../src/infrastructure/auth/account-deletion-postgres.js';
import { sql } from 'kysely';

test('AUTH-03: deletion phases roll back together and approved retry is idempotent', async () => {
  const isolated = await createIsolatedPostgresRuntime('atomic_account_deletion');
  try {
    const { db, pool } = isolated.runtime;
    await runMigrations(db, 'latest');
    await pool.query("insert into accounts(id,subject_id,status,email) values ('acct','subject','active','atomic@example.test')");
    await pool.query(`insert into auth_users(id,name,email,"emailVerified") values ('usr','Atomic','atomic@example.test',true)`);
    await pool.query(`insert into auth_accounts(id,"accountId","providerId","userId",issuer,password,"createdAt","updatedAt") values ('cred','usr','credential','usr','credential','hash',now(),now())`);
    await pool.query("insert into auth_user_account_map(auth_user_id,account_id) values ('usr','acct')");
    await pool.query(`insert into auth_sessions(id,token,"expiresAt","userId","createdAt","updatedAt") values ('sess','token',now()+interval '1 day','usr',now(),now())`);
    await pool.query(`insert into auth_verifications(id,identifier,value,"expiresAt") values ('trust','hashed-trust','usr',now()+interval '1 day')`);
    for (const phase of ['accounts', 'auth_verifications', 'auth_users', 'commit'] as const) {
      const store = createPostgresAccountDeletionStore(db, {
        faultInjector: {
          async beforeCallback(tx) {
            if (phase === 'commit') return;
            await sql`create function pg_temp.reject_delete_phase() returns trigger language plpgsql as $$ begin raise exception 'injected phase failure'; end $$`.execute(tx);
            await sql.raw(`create trigger fail_phase before ${phase === 'accounts' ? 'update' : 'delete'} on ${phase} for each row execute function pg_temp.reject_delete_phase()`).execute(tx);
          },
          afterCallbackBeforeCommit() { if (phase === 'commit') throw new Error('injected commit failure'); },
        },
      });
      await expect(store.complete('acct', 'usr')).rejects.toThrow();
      const account = await db.selectFrom('accounts').selectAll().where('id','=','acct').executeTakeFirstOrThrow();
      expect(account.status).toBe('active');
      expect(BigInt(account.security_epoch)).toBe(0n);
      expect(account.email).toBe('atomic@example.test');
      expect((await db.selectFrom('auth_accounts').select('id').execute()).length).toBe(1);
      expect((await db.selectFrom('auth_sessions').select('id').execute()).length).toBe(1);
      expect((await db.selectFrom('auth_verifications').select('id').execute()).length).toBe(1);
    }
    const store = createPostgresAccountDeletionStore(db);
    await store.complete('acct','usr');
    await store.complete('acct','usr');
    const account = await db.selectFrom('accounts').selectAll().where('id','=','acct').executeTakeFirstOrThrow();
    expect(account.status).toBe('deleted'); expect(account.email).toBe(null); expect(BigInt(account.security_epoch)).toBe(1n);
    for (const table of ['auth_users','auth_accounts','auth_sessions','auth_verifications'] as const) {
      expect((await db.selectFrom(table).select('id').execute()).length).toBe(0);
    }
  } finally { await isolated.close(); }
},120000);
