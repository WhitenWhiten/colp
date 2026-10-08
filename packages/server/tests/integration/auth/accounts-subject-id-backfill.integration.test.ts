/**
 * T-03 / ADR D3 backfill: mapped accounts receive
 * `accounts.subject_id := auth_user_account_map.auth_user_id`.
 * Unmapped rows stay byte-identical. A real conflicting subject_id
 * fail-closes the whole statement (no partial apply). Re-entry is a no-op.
 */
import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { up as backfillSubjectIds } from '../../../migrations/202609230200_accounts_subject_id_backfill.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

const ACCOUNT_COLUMNS = [
  'id',
  'subject_id',
  'status',
  'email',
  'security_epoch',
  'created_at',
  'deleted_at',
] as const;

type AccountRow = {
  readonly id: string;
  readonly subject_id: string;
  readonly status: string;
  readonly email: string | null;
  readonly security_epoch: string;
  readonly created_at: Date;
  readonly deleted_at: Date | null;
};

describeWithPostgres('accounts subject_id backfill', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('t03_subject_backfill', {
      maxConnections: 4,
      applicationName: 'known-t03-subject-backfill',
    });
    await runMigrations(isolated.runtime.db, 'latest');
  }, 120_000);

  afterAll(async () => isolated?.close());

  test('aligns mapped subject_id, leaves unmapped columns byte-identical, and is idempotent', async () => {
    await resetIdentityTables();
    await seedAuthUser('ba-mapped', 'Mapped', 'mapped@example.test');
    await seedAccount('acct-mapped', 'subj-mapped', 'active', 'mapped@example.test');
    await seedAccount('acct-unmapped', 'subj-unmapped', 'active', 'unmapped@example.test');
    await seedMapping('ba-mapped', 'acct-mapped');

    const beforeMapped = await selectAccount('acct-mapped');
    const beforeUnmapped = await selectAccount('acct-unmapped');
    assert.equal(beforeMapped.subject_id, 'subj-mapped');
    assert.equal(beforeUnmapped.subject_id, 'subj-unmapped');

    await backfillSubjectIds(isolated.runtime.db);

    const afterMapped = await selectAccount('acct-mapped');
    assert.equal(afterMapped.subject_id, 'ba-mapped');
    assertAccountColumnsEqual(afterMapped, { ...beforeMapped, subject_id: 'ba-mapped' });

    const afterUnmapped = await selectAccount('acct-unmapped');
    assertAccountColumnsEqual(afterUnmapped, beforeUnmapped);

    await backfillSubjectIds(isolated.runtime.db);
    assertAccountColumnsEqual(await selectAccount('acct-mapped'), afterMapped);
    assertAccountColumnsEqual(await selectAccount('acct-unmapped'), afterUnmapped);
  });

  test('collision on a pre-inserted conflicting subject_id fail-closes and applies nothing', async () => {
    await resetIdentityTables();
    await seedAuthUser('ba-mapped', 'Mapped', 'mapped@example.test');
    await seedAuthUser('ba-collide', 'Collide', 'collide@example.test');
    await seedAccount('acct-mapped', 'subj-mapped', 'active', 'mapped@example.test');
    await seedAccount('acct-unmapped', 'subj-unmapped', 'disabled', null);
    await seedAccount('acct-collide', 'subj-collide', 'active', 'collide@example.test');
    await seedAccount('acct-holder', 'ba-collide', 'active', 'holder@example.test');
    await seedMapping('ba-mapped', 'acct-mapped');
    await seedMapping('ba-collide', 'acct-collide');

    const beforeMapped = await selectAccount('acct-mapped');
    const beforeUnmapped = await selectAccount('acct-unmapped');
    const beforeCollide = await selectAccount('acct-collide');
    const beforeHolder = await selectAccount('acct-holder');

    await assert.rejects(
      () => backfillSubjectIds(isolated.runtime.db),
      (error: unknown) => {
        assert.match(String(error), /accounts_subject_id_backfill refused/);
        return true;
      },
    );

    assertAccountColumnsEqual(await selectAccount('acct-mapped'), beforeMapped);
    assertAccountColumnsEqual(await selectAccount('acct-unmapped'), beforeUnmapped);
    assertAccountColumnsEqual(await selectAccount('acct-collide'), beforeCollide);
    assertAccountColumnsEqual(await selectAccount('acct-holder'), beforeHolder);
  });

  async function resetIdentityTables(): Promise<void> {
    await isolated.runtime.pool.query(`delete from auth_user_account_map`);
    await isolated.runtime.pool.query(`delete from profile_handles`);
    await isolated.runtime.pool.query(`delete from profiles`);
    await isolated.runtime.pool.query(`delete from accounts`);
    await isolated.runtime.pool.query(`delete from "auth_users"`);
  }

  async function seedAuthUser(id: string, name: string, email: string): Promise<void> {
    await isolated.runtime.pool.query(
      `insert into "auth_users" ("id","name","email","emailVerified") values ($1, $2, $3, true)`,
      [id, name, email],
    );
  }

  async function seedAccount(
    id: string,
    subjectId: string,
    status: string,
    email: string | null,
  ): Promise<void> {
    await isolated.runtime.pool.query(
      `insert into accounts (id, subject_id, status, email) values ($1, $2, $3, $4)`,
      [id, subjectId, status, email],
    );
  }

  async function seedMapping(authUserId: string, accountId: string): Promise<void> {
    await isolated.runtime.pool.query(
      `insert into auth_user_account_map (auth_user_id, account_id) values ($1, $2)`,
      [authUserId, accountId],
    );
  }

  async function selectAccount(id: string): Promise<AccountRow> {
    const result = await isolated.runtime.pool.query<AccountRow>(
      `select id, subject_id, status, email, security_epoch, created_at, deleted_at
         from accounts where id = $1`,
      [id],
    );
    assert.equal(result.rows.length, 1, `expected one accounts row for ${id}`);
    return result.rows[0]!;
  }
});

function assertAccountColumnsEqual(actual: AccountRow, expected: AccountRow): void {
  for (const column of ACCOUNT_COLUMNS) {
    const left = normalizeAccountCell(actual[column]);
    const right = normalizeAccountCell(expected[column]);
    assert.deepEqual(left, right, `accounts.${column} must stay aligned`);
  }
}

function normalizeAccountCell(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  return value;
}
