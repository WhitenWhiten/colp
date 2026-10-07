import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { createPostgresExtensionIdentityBindingPort } from '../../../src/infrastructure/identity/index.js';
import {
  ExtensionAuthError,
  generateOpaqueId,
} from '../../../src/modules/identity/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

const ISSUER = 'https://known.example';
const OTHER_ISSUER = 'https://other.example';

async function seedAccount(
  isolated: IsolatedPostgresRuntime,
  input: { readonly accountId: string; readonly subjectId: string; readonly handle: string },
): Promise<void> {
  await isolated.runtime.pool.query(
    `insert into accounts(id, subject_id, status) values ($1, $2, 'active')`,
    [input.accountId, input.subjectId],
  );
  await isolated.runtime.pool.query(
    `insert into profiles(account_id, display_name) values ($1, $2)`,
    [input.accountId, input.handle],
  );
  await isolated.runtime.pool.query(
    `insert into profile_handles(handle, account_id) values ($1, $2)`,
    [input.handle, input.accountId],
  );
}

describeWithPostgres('ensureExtensionAccountIdentity postgres adapter (ORG-P0-b)', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('ensure_ext_ident', {
      maxConnections: 12,
      applicationName: 'known-ensure-ext-ident',
    });
    await runMigrations(isolated.runtime.db, 'latest');
  }, 120_000);

  afterAll(async () => isolated?.close());

  test('empty insert writes issuer/subject and reuses the same row', async () => {
    const accountId = generateOpaqueId();
    const subjectId = `sub-${generateOpaqueId()}`;
    await seedAccount(isolated, { accountId, subjectId, handle: `h_${accountId.slice(0, 12).toLowerCase()}` });
    const port = createPostgresExtensionIdentityBindingPort(isolated.runtime.db);
    const first = await port.ensure({ accountId, subjectId, issuer: ISSUER });
    assert.deepEqual(first, { issuer: ISSUER, subject: subjectId });
    const second = await port.ensure({ accountId, subjectId, issuer: ISSUER });
    assert.deepEqual(second, first);
    const rows = await isolated.runtime.pool.query<{ n: number }>(
      `select count(*)::int n from account_identities where account_id = $1`,
      [accountId],
    );
    assert.equal(rows.rows[0]?.n, 1);
  });

  test('reuses an existing account_identities row even when the caller passes a different issuer/subject', async () => {
    const accountId = generateOpaqueId();
    const subjectId = `sub-${generateOpaqueId()}`;
    await seedAccount(isolated, { accountId, subjectId, handle: `r_${accountId.slice(0, 12).toLowerCase()}` });
    const port = createPostgresExtensionIdentityBindingPort(isolated.runtime.db);
    const original = await port.ensure({ accountId, subjectId, issuer: ISSUER });
    const reused = await port.ensure({
      accountId,
      subjectId: `other-${subjectId}`,
      issuer: OTHER_ISSUER,
    });
    assert.deepEqual(reused, original);
    const rows = await isolated.runtime.pool.query<{ issuer: string; subject: string }>(
      `select issuer, subject from account_identities where account_id = $1`,
      [accountId],
    );
    assert.equal(rows.rows.length, 1);
    assert.equal(rows.rows[0]?.issuer, ISSUER);
    assert.equal(rows.rows[0]?.subject, subjectId);
  });

  test('issuer/subject owned by another account is invalid_token', async () => {
    const accountA = generateOpaqueId();
    const accountB = generateOpaqueId();
    const subjectA = `sub-${generateOpaqueId()}`;
    const subjectB = `sub-${generateOpaqueId()}`;
    await seedAccount(isolated, { accountId: accountA, subjectId: subjectA, handle: `a_${accountA.slice(0, 12).toLowerCase()}` });
    await seedAccount(isolated, { accountId: accountB, subjectId: subjectB, handle: `b_${accountB.slice(0, 12).toLowerCase()}` });
    const port = createPostgresExtensionIdentityBindingPort(isolated.runtime.db);
    await port.ensure({ accountId: accountA, subjectId: subjectA, issuer: ISSUER });
    await assert.rejects(
      () => port.ensure({ accountId: accountB, subjectId: subjectA, issuer: ISSUER }),
      (error: unknown) => error instanceof ExtensionAuthError && error.reason === 'invalid_token',
    );
  });

  test('concurrent first insert for the same account converges on one row', async () => {
    const accountId = generateOpaqueId();
    const subjectId = `sub-${generateOpaqueId()}`;
    await seedAccount(isolated, { accountId, subjectId, handle: `c_${accountId.slice(0, 12).toLowerCase()}` });
    const port = createPostgresExtensionIdentityBindingPort(isolated.runtime.db);
    const results = await Promise.all([
      port.ensure({ accountId, subjectId, issuer: ISSUER }),
      port.ensure({ accountId, subjectId, issuer: ISSUER }),
    ]);
    assert.deepEqual(results[0], { issuer: ISSUER, subject: subjectId });
    assert.deepEqual(results[1], { issuer: ISSUER, subject: subjectId });
    const rows = await isolated.runtime.pool.query<{ n: number }>(
      `select count(*)::int n from account_identities where account_id = $1`,
      [accountId],
    );
    assert.equal(rows.rows[0]?.n, 1);
  });
});
