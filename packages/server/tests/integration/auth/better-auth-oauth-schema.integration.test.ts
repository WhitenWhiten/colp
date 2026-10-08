import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { createMigrator } from '../../../src/infrastructure/database/index.js';
import { createHistoricalMigrator } from '../../support/historical-migrations.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

const PREVIOUS_HEAD = '202609220100_collection_readable_replicas';
const OAUTH_MIGRATION = '202609230100_better_auth_oauth_provider_schema';
// Down-stepping from the mutable production head can never reach the OAuth
// expand guard: 202610101000_classification_credit_integrity refuses `down`
// unconditionally by design. Bound the window just above the OAuth expand (the
// T-03 subject backfill) so the same guard stays reachable, per the TQ-02
// fixed-historical-window policy used by the other migration suites.
const OAUTH_DOWN_WINDOW = '202609230200_accounts_subject_id_backfill';

const OAUTH_TABLES = [
  'auth_jwks',
  'auth_oauth_client',
  'auth_oauth_resource',
  'auth_oauth_client_resource',
  'auth_oauth_refresh_token',
  'auth_oauth_access_token',
  'auth_oauth_consent',
  'auth_oauth_client_assertion',
] as const;

/** Column order from T-01 compile-review.json `newTableColumns` (library create). */
const EXPECTED_COLUMNS: Record<string, readonly string[]> = {
  auth_jwks: ['id', 'publicKey', 'privateKey', 'createdAt', 'expiresAt', 'alg', 'crv'],
  auth_oauth_client: [
    'id', 'clientId', 'clientSecret', 'clientDiscoveryId', 'disabled', 'skipConsent',
    'enableEndSession', 'subjectType', 'scopes', 'clientCredentialsScopes', 'userId',
    'createdAt', 'updatedAt', 'name', 'uri', 'icon', 'contacts', 'tos', 'policy',
    'softwareId', 'softwareVersion', 'softwareStatement', 'redirectUris',
    'postLogoutRedirectUris', 'backchannelLogoutUri', 'backchannelLogoutSessionRequired',
    'tokenEndpointAuthMethod', 'applicationType', 'jwks', 'jwksUri', 'grantTypes',
    'responseTypes', 'requirePKCE', 'dpopBoundAccessTokens', 'referenceId', 'metadata',
  ],
  auth_oauth_resource: [
    'id', 'identifier', 'name', 'accessTokenTtl', 'refreshTokenTtl', 'signingAlgorithm',
    'signingKeyId', 'allowedScopes', 'customClaims', 'dpopBoundAccessTokensRequired',
    'disabled', 'createdAt', 'updatedAt', 'policyVersion', 'metadata',
  ],
  auth_oauth_client_resource: ['id', 'clientId', 'resourceId', 'metadata', 'createdAt'],
  auth_oauth_refresh_token: [
    'id', 'token', 'clientId', 'sessionId', 'userId', 'referenceId', 'authorizationCodeId',
    'resources', 'requestedUserInfoClaims', 'expiresAt', 'createdAt', 'revoked', 'rotatedAt',
    'rotationReplayResponse', 'rotationReplayExpiresAt', 'authTime', 'confirmation', 'scopes',
  ],
  auth_oauth_access_token: [
    'id', 'token', 'clientId', 'sessionId', 'userId', 'referenceId', 'authorizationCodeId',
    'resources', 'requestedUserInfoClaims', 'refreshId', 'expiresAt', 'createdAt', 'revoked',
    'confirmation', 'scopes',
  ],
  auth_oauth_consent: [
    'id', 'clientId', 'userId', 'referenceId', 'resources', 'requestedUserInfoClaims',
    'scopes', 'createdAt', 'updatedAt',
  ],
  auth_oauth_client_assertion: ['id', 'expiresAt'],
};

/** Kysely ADD COLUMN places issuer after the B1 1.6.29 layout (T-01 after-kysely SQL). */
const AUTH_ACCOUNTS_COLUMNS_AFTER_T02 = [
  'id', 'accountId', 'providerId', 'userId', 'accessToken', 'refreshToken', 'idToken',
  'accessTokenExpiresAt', 'refreshTokenExpiresAt', 'scope', 'password', 'createdAt',
  'updatedAt', 'issuer',
] as const;

describeWithPostgres('T-02 Better Auth 1.7 OAuth expand (real PostgreSQL)', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('t02_better_auth_oauth');
    const migrator = createMigrator(isolated.runtime.db, 'migrations', isolated.schema);
    const result = await migrator.migrateToLatest();
    if (result.error) throw result.error;
  }, 120_000);
  afterAll(async () => isolated?.close());

  test('empty database full chain: oauth tables, jwks, and auth_accounts.issuer', async () => {
    for (const table of OAUTH_TABLES) {
      assert.equal(await tablePresent(isolated, table), true, `missing ${table}`);
      const columns = await columnNames(isolated, table);
      assert.deepEqual(columns, EXPECTED_COLUMNS[table], `${table} column order must match T-01 oracle`);
    }

    assert.deepEqual(await columnNames(isolated, 'auth_accounts'), [...AUTH_ACCOUNTS_COLUMNS_AFTER_T02]);
    const issuer = await columnMeta(isolated, 'auth_accounts', 'issuer');
    assert.equal(issuer?.data_type, 'text');
    assert.equal(issuer?.is_nullable, 'NO');
    assert.equal(issuer?.column_default, null);

    const jwksCreated = await columnMeta(isolated, 'auth_jwks', 'createdAt');
    assert.equal(jwksCreated?.data_type, 'timestamp with time zone');
    assert.equal(jwksCreated?.is_nullable, 'NO');
    const redirectUris = await columnMeta(isolated, 'auth_oauth_client', 'redirectUris');
    assert.equal(redirectUris?.data_type, 'jsonb');
    assert.equal(redirectUris?.is_nullable, 'NO');
    const accessUserId = await columnMeta(isolated, 'auth_oauth_access_token', 'userId');
    assert.equal(accessUserId?.is_nullable, 'YES');
    const refreshRevoked = await columnMeta(isolated, 'auth_oauth_refresh_token', 'revoked');
    const accessRevoked = await columnMeta(isolated, 'auth_oauth_access_token', 'revoked');
    assert.equal(refreshRevoked?.data_type, 'timestamp with time zone');
    assert.equal(accessRevoked?.data_type, 'timestamp with time zone');
    const refreshUserId = await columnMeta(isolated, 'auth_oauth_refresh_token', 'userId');
    assert.equal(refreshUserId?.is_nullable, 'NO');
    const consentScopes = await columnMeta(isolated, 'auth_oauth_consent', 'scopes');
    assert.equal(consentScopes?.data_type, 'jsonb');
    assert.equal(consentScopes?.is_nullable, 'NO');

    // Password creation is wired as INSERT + UPDATE by T-05. Exercise an
    // OAuth-only account INSERT with a password so trigger functions must not
    // dereference the unassigned INSERT OLD record.
    await isolated.runtime.pool.query(
      `insert into "auth_users" ("id","name","email","emailVerified")
       values ('u-password-insert-regression','insert','password-insert@example.test',true)`,
    );
    await isolated.runtime.pool.query(
      `insert into "auth_accounts"
         ("id","accountId","providerId","userId","issuer","password","createdAt","updatedAt")
       values
         ('a-password-insert-regression','password-insert-subject','credential',
          'u-password-insert-regression','local:credential','hash',now(),now())`,
    );
    await isolated.runtime.pool.query(
      `delete from "auth_users" where "id" = 'u-password-insert-regression'`,
    );

    const passwordSecurityFunction = await isolated.runtime.pool.query<{ definition: string }>(
      `select pg_get_functiondef('commit_password_security_event()'::regprocedure) definition`,
    );
    assert.match(passwordSecurityFunction.rows[0]?.definition ?? '', /TG_OP\s*=\s*'UPDATE'/u);
    const passwordOauthFunction = await isolated.runtime.pool.query<{ definition: string }>(
      `select pg_get_functiondef('revoke_password_oauth_grants()'::regprocedure) definition`,
    );
    assert.match(passwordOauthFunction.rows[0]?.definition ?? '', /TG_OP\s*=\s*'UPDATE'/u);
    const securityTrigger = await isolated.runtime.pool.query<{ definition: string }>(
      `select pg_get_triggerdef(oid) definition from pg_trigger
       where tgname = 'auth_password_security_commit'`,
    );
    assert.match(securityTrigger.rows[0]?.definition ?? '', /AFTER INSERT OR UPDATE OF password/iu);
    const oauthTrigger = await isolated.runtime.pool.query<{ definition: string }>(
      `select pg_get_triggerdef(oid) definition from pg_trigger
       where tgname = 'auth_password_oauth_revoke'`,
    );
    assert.match(oauthTrigger.rows[0]?.definition ?? '', /AFTER INSERT OR UPDATE OF password/iu);
  });

  test('upgrades the previous head and backfills populated auth_accounts before NOT NULL', async () => {
    const upgrade = await createIsolatedPostgresRuntime('t02_oauth_upgrade');
    try {
      const migrator = createMigrator(upgrade.runtime.db, 'migrations', upgrade.schema);
      const previous = await migrator.migrateTo(PREVIOUS_HEAD);
      if (previous.error) throw previous.error;
      assert.equal(await tablePresent(upgrade, 'auth_accounts'), true);
      assert.equal(await hasColumn(upgrade, 'auth_accounts', 'issuer'), false);
      for (const table of OAUTH_TABLES) {
        assert.equal(await tablePresent(upgrade, table), false, `${table} must not exist before T-02`);
      }

      await upgrade.runtime.pool.query(
        `insert into "auth_users" ("id","name","email","emailVerified") values
          ('u-cred','c','c@example.test',true),
          ('u-google','g','g@example.test',true),
          ('u-github','h','h@example.test',true),
          ('u-custom','x','x@example.test',true)`,
      );
      await upgrade.runtime.pool.query(
        `insert into "auth_accounts" ("id","accountId","providerId","userId","createdAt","updatedAt") values
          ('a-cred','u-cred','credential','u-cred', now(), now()),
          ('a-google','google-sub-1','google','u-google', now(), now()),
          ('a-github','gh-1','github','u-github', now(), now()),
          ('a-custom','acct-x','team/github','u-custom', now(), now())`,
      );

      const latest = await migrator.migrateToLatest();
      if (latest.error) throw latest.error;
      assert.ok((latest.results ?? []).some((row) => row.migrationName === OAUTH_MIGRATION));
      for (const table of OAUTH_TABLES) {
        assert.equal(await tablePresent(upgrade, table), true, `${table} must exist after T-02`);
      }

      const issuers = await upgrade.runtime.pool.query<{ id: string; issuer: string }>(
        `select id, issuer from "auth_accounts" order by id`,
      );
      assert.deepEqual(issuers.rows, [
        { id: 'a-cred', issuer: 'local:credential' },
        { id: 'a-custom', issuer: 'local:oauth:team%2Fgithub' },
        { id: 'a-github', issuer: 'local:oauth:github' },
        { id: 'a-google', issuer: 'https://accounts.google.com' },
      ]);
      assert.equal((await columnMeta(upgrade, 'auth_accounts', 'issuer'))?.is_nullable, 'NO');
    } finally {
      await upgrade.close();
    }
  }, 120_000);

  test('constraints and indexes match the T-01 compileMigrations oracle', async () => {
    assert.equal(await hasUniqueIndex(isolated, 'auth_accounts', 'issuer, "accountId"'), true);
    const accountIndexes = await indexDefs(isolated, 'auth_accounts');
    assert.ok(accountIndexes.some((def) => def.includes('auth_accounts_issuer_accountId_uidx')));

    assert.equal(await hasUniqueIndex(isolated, 'auth_oauth_client', '"clientId"'), true);
    assert.equal(await hasUniqueIndex(isolated, 'auth_oauth_resource', 'identifier'), true);
    assert.equal(await hasUniqueIndex(isolated, 'auth_oauth_refresh_token', 'token'), true);
    assert.equal(await hasUniqueIndex(isolated, 'auth_oauth_access_token', 'token'), true);
    assert.equal(
      await hasUniqueIndex(isolated, 'auth_oauth_client_resource', '"clientId", "resourceId"'),
      true,
    );

    // T-09 (202609260500) drops the single-column clientId duplicate; the
    // ("clientId", "resourceId") unique index carries the clientId prefix.
    const clientResourceIndexes = await indexDefs(isolated, 'auth_oauth_client_resource');
    assert.ok(
      !clientResourceIndexes.some((def) => def.includes('auth_oauth_client_resource_clientId_idx')),
      'auth_oauth_client_resource_clientId_idx must be dropped by the T-09 cleanup',
    );

    for (const [table, index] of [
      ['auth_oauth_client', 'auth_oauth_client_userId_idx'],
      ['auth_oauth_client_resource', 'auth_oauth_client_resource_resourceId_idx'],
      ['auth_oauth_refresh_token', 'auth_oauth_refresh_token_clientId_idx'],
      ['auth_oauth_refresh_token', 'auth_oauth_refresh_token_sessionId_idx'],
      ['auth_oauth_refresh_token', 'auth_oauth_refresh_token_userId_idx'],
      ['auth_oauth_refresh_token', 'auth_oauth_refresh_token_authorizationCodeId_idx'],
      ['auth_oauth_access_token', 'auth_oauth_access_token_clientId_idx'],
      ['auth_oauth_access_token', 'auth_oauth_access_token_sessionId_idx'],
      ['auth_oauth_access_token', 'auth_oauth_access_token_userId_idx'],
      ['auth_oauth_access_token', 'auth_oauth_access_token_authorizationCodeId_idx'],
      ['auth_oauth_access_token', 'auth_oauth_access_token_refreshId_idx'],
      ['auth_oauth_consent', 'auth_oauth_consent_clientId_idx'],
      ['auth_oauth_consent', 'auth_oauth_consent_userId_idx'],
    ] as const) {
      const def = (await indexDefs(isolated, table)).find((candidate) => candidate.includes(index));
      assert.ok(def, `missing index ${index}`);
      assert.ok(!def.includes('UNIQUE'), `${index} must stay non-unique`);
    }

    assert.equal(await fkDeleteBehavior(isolated, 'auth_oauth_client', 'auth_oauth_client_userId_fkey'), 'c');
    assert.equal(await fkDeleteBehavior(isolated, 'auth_oauth_client_resource', 'auth_oauth_client_resource_clientId_fkey'), 'c');
    assert.equal(await fkDeleteBehavior(isolated, 'auth_oauth_client_resource', 'auth_oauth_client_resource_resourceId_fkey'), 'c');
    assert.equal(await fkDeleteBehavior(isolated, 'auth_oauth_refresh_token', 'auth_oauth_refresh_token_clientId_fkey'), 'c');
    assert.equal(await fkDeleteBehavior(isolated, 'auth_oauth_refresh_token', 'auth_oauth_refresh_token_sessionId_fkey'), 'n');
    assert.equal(await fkDeleteBehavior(isolated, 'auth_oauth_refresh_token', 'auth_oauth_refresh_token_userId_fkey'), 'c');
    assert.equal(await fkDeleteBehavior(isolated, 'auth_oauth_access_token', 'auth_oauth_access_token_clientId_fkey'), 'c');
    assert.equal(await fkDeleteBehavior(isolated, 'auth_oauth_access_token', 'auth_oauth_access_token_sessionId_fkey'), 'n');
    assert.equal(await fkDeleteBehavior(isolated, 'auth_oauth_access_token', 'auth_oauth_access_token_userId_fkey'), 'c');
    assert.equal(await fkDeleteBehavior(isolated, 'auth_oauth_access_token', 'auth_oauth_access_token_refreshId_fkey'), 'c');
    assert.equal(await fkDeleteBehavior(isolated, 'auth_oauth_consent', 'auth_oauth_consent_clientId_fkey'), 'c');
    assert.equal(await fkDeleteBehavior(isolated, 'auth_oauth_consent', 'auth_oauth_consent_userId_fkey'), 'c');
  });

  test('down with oauth rows refuses; empty oauth tables down while auth_accounts remain', async () => {
    const guarded = await createIsolatedPostgresRuntime('t02_oauth_down');
    try {
      const migrator = createHistoricalMigrator(guarded, OAUTH_DOWN_WINDOW);
      const latest = await migrator.migrateToLatest();
      if (latest.error) throw latest.error;

      await guarded.runtime.pool.query(
        `insert into "auth_jwks" ("id","publicKey","privateKey","createdAt")
         values ('jwks-1','pub','priv', now())`,
      );
      // Later lexical files (T-03 subject backfill) sit above T-02. Return
      // to the OAuth expand before exercising its down guard.
      const atOauth = await migrator.migrateTo(OAUTH_MIGRATION);
      if (atOauth.error) throw atOauth.error;
      const refused = await migrator.migrateDown();
      assert.ok(refused.error, 'oauth down must refuse with rows');
      assert.match(String(refused.error), /down refused/);
      assert.equal(await tablePresent(guarded, 'auth_jwks'), true);
      const kept = await guarded.runtime.pool.query<{ n: number }>(
        `select count(*)::int n from "auth_jwks"`,
      );
      assert.equal(kept.rows[0]?.n, 1);

      await guarded.runtime.pool.query(`delete from "auth_jwks"`);
      await guarded.runtime.pool.query(
        `insert into "auth_users" ("id","name","email","emailVerified")
         values ('u-keep','k','k@example.test',true)`,
      );
      await guarded.runtime.pool.query(
        `insert into "auth_accounts" ("id","accountId","providerId","userId","issuer","createdAt","updatedAt")
         values ('a-keep','u-keep','credential','u-keep','local:credential', now(), now())`,
      );
      const cleared = await migrator.migrateDown();
      if (cleared.error) throw cleared.error;
      for (const table of OAUTH_TABLES) {
        assert.equal(await tablePresent(guarded, table), false, `${table} must drop at zero oauth rows`);
      }
      assert.equal(await hasColumn(guarded, 'auth_accounts', 'issuer'), false);
      const remaining = await guarded.runtime.pool.query<{ n: number }>(
        `select count(*)::int n from "auth_accounts"`,
      );
      assert.equal(remaining.rows[0]?.n, 1, 'issuer down must not require empty auth_accounts');

      const forward = await migrator.migrateToLatest();
      if (forward.error) throw forward.error;
      for (const table of OAUTH_TABLES) {
        assert.equal(await tablePresent(guarded, table), true, `${table} must restore`);
      }
      assert.equal(await hasColumn(guarded, 'auth_accounts', 'issuer'), true);
    } finally {
      await guarded.close();
    }
  }, 120_000);
});

async function tablePresent(runtime: IsolatedPostgresRuntime, table: string): Promise<boolean> {
  return (await runtime.runtime.pool.query<{ present: boolean }>(
    `select to_regclass(current_schema() || '.' || $1) is not null present`, [table],
  )).rows[0]?.present ?? false;
}

async function columnNames(runtime: IsolatedPostgresRuntime, table: string): Promise<string[]> {
  const result = await runtime.runtime.pool.query<{ column_name: string }>(
    `select column_name from information_schema.columns
      where table_schema = current_schema() and table_name = $1
      order by ordinal_position`,
    [table],
  );
  return result.rows.map((row) => row.column_name);
}

async function hasColumn(runtime: IsolatedPostgresRuntime, table: string, column: string): Promise<boolean> {
  return (await columnNames(runtime, table)).includes(column);
}

async function columnMeta(
  runtime: IsolatedPostgresRuntime,
  table: string,
  column: string,
): Promise<{ data_type: string; is_nullable: string; column_default: string | null } | undefined> {
  const result = await runtime.runtime.pool.query<{
    data_type: string; is_nullable: string; column_default: string | null;
  }>(
    `select data_type, is_nullable, column_default from information_schema.columns
      where table_schema = current_schema() and table_name = $1 and column_name = $2`,
    [table, column],
  );
  return result.rows[0];
}

async function indexDefs(runtime: IsolatedPostgresRuntime, table: string): Promise<string[]> {
  const result = await runtime.runtime.pool.query<{ indexdef: string }>(
    `select indexdef from pg_indexes where schemaname = current_schema() and tablename = $1`,
    [table],
  );
  return result.rows.map((row) => row.indexdef);
}

async function hasUniqueIndex(runtime: IsolatedPostgresRuntime, table: string, column: string): Promise<boolean> {
  return (await indexDefs(runtime, table)).some((def) => def.includes('UNIQUE') && def.includes(`(${column})`));
}

async function fkDeleteBehavior(
  runtime: IsolatedPostgresRuntime,
  table: string,
  constraint: string,
): Promise<string> {
  const result = await runtime.runtime.pool.query<{ confdeltype: string }>(
    `select c.confdeltype from pg_constraint c
      join pg_class t on t.oid = c.conrelid
      join pg_namespace n on n.oid = t.relnamespace
     where n.nspname = current_schema() and t.relname = $1 and c.conname = $2`,
    [table, constraint],
  );
  assert.equal(result.rowCount, 1, `FK constraint ${constraint} on ${table} must exist`);
  return result.rows[0]?.confdeltype ?? '';
}
