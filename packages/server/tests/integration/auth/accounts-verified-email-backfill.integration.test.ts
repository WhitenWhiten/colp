/**
 * S-03 backfill: verified BA users with a mapping and a null product email
 * receive the normalized auth_users.email. Unique conflicts are skipped.
 */
import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { up as backfillVerifiedEmails } from '../../../migrations/202609100100_accounts_verified_email_backfill.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

describeWithPostgres('accounts verified email backfill', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('s03_email_backfill', {
      maxConnections: 4,
      applicationName: 'known-s03-email-backfill',
    });
    await runMigrations(isolated.runtime.db, 'latest');
  }, 120_000);

  afterAll(async () => isolated?.close());

  test('fills null product email for verified mapped users and skips unique conflicts', async () => {
    await isolated.runtime.pool.query(`delete from auth_user_account_map`);
    await isolated.runtime.pool.query(`delete from profile_handles`);
    await isolated.runtime.pool.query(`delete from profiles`);
    await isolated.runtime.pool.query(`delete from accounts`);
    await isolated.runtime.pool.query(`delete from "auth_users"`);

    await isolated.runtime.pool.query(
      `insert into "auth_users" ("id","name","email","emailVerified") values
        ('ba-fill', 'Fill', 'Fill@example.test', true),
        ('ba-skip', 'Skip', 'taken@example.test', true),
        ('ba-unverified', 'Unverified', 'open@example.test', false)`,
    );
    await isolated.runtime.pool.query(
      `insert into accounts (id, subject_id, status, email) values
        ('acct-fill', 'subj-fill', 'active', null),
        ('acct-holder', 'subj-holder', 'active', 'taken@example.test'),
        ('acct-skip', 'subj-skip', 'active', null),
        ('acct-unverified', 'subj-unverified', 'active', null)`,
    );
    await isolated.runtime.pool.query(
      `insert into profiles (account_id, display_name) values
        ('acct-fill', 'Fill'), ('acct-holder', 'Holder'),
        ('acct-skip', 'Skip'), ('acct-unverified', 'Unverified')`,
    );
    await isolated.runtime.pool.query(
      `insert into profile_handles (handle, account_id) values
        ('h-fill', 'acct-fill'), ('h-holder', 'acct-holder'),
        ('h-skip', 'acct-skip'), ('h-unverified', 'acct-unverified')`,
    );
    await isolated.runtime.pool.query(
      `insert into auth_user_account_map (auth_user_id, account_id) values
        ('ba-fill', 'acct-fill'),
        ('ba-skip', 'acct-skip'),
        ('ba-unverified', 'acct-unverified')`,
    );

    await backfillVerifiedEmails(isolated.runtime.db);

    const filled = await isolated.runtime.pool.query<{ email: string | null }>(
      `select email from accounts where id = 'acct-fill'`,
    );
    assert.equal(filled.rows[0]?.email, 'fill@example.test');

    const skipped = await isolated.runtime.pool.query<{ email: string | null }>(
      `select email from accounts where id = 'acct-skip'`,
    );
    assert.equal(skipped.rows[0]?.email, null, 'must not steal accounts_email_unique');

    const holder = await isolated.runtime.pool.query<{ email: string | null }>(
      `select email from accounts where id = 'acct-holder'`,
    );
    assert.equal(holder.rows[0]?.email, 'taken@example.test');

    const unverified = await isolated.runtime.pool.query<{ email: string | null }>(
      `select email from accounts where id = 'acct-unverified'`,
    );
    assert.equal(unverified.rows[0]?.email, null, 'unverified occupancy must stay null');
  });
});
