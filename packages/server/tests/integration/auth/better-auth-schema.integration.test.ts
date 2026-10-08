import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { createMigrator } from '../../../src/infrastructure/database/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';
import { productionMigrationNamesFromInclusive } from '../../../scripts/lexical-migration-head.mjs';

const PREVIOUS_STABLE_MIGRATION = '202609040100_seed_versions';
const NEW_MIGRATIONS = [
  '202609050900_better_auth_schema',
  '202609050910_better_auth_account_mapping',
  '202609050920_known_auth_session_metadata',
  '202609050930_legacy_oidc_identity_archive',
  '202609051000_better_auth_mfa_schema',
] as const;

const AFTER_MFA_MIGRATIONS = productionMigrationNamesFromInclusive('202609060100_identity_profile_about');

const BA_TABLES = ['auth_users', 'auth_accounts', 'auth_sessions', 'auth_verifications'] as const;
const KNOWN_TABLES = ['auth_user_account_map', 'known_auth_session_metadata', 'legacy_oidc_identity_archive', 'auth_two_factor'] as const;

/** Exact column order transcribed from artifacts/compile-migration.sql (spike §4.2). */
const EXPECTED_COLUMNS: Record<string, readonly string[]> = {
  auth_users: ['id', 'name', 'email', 'emailVerified', 'image', 'createdAt', 'updatedAt', 'twoFactorEnabled', 'username'],
  auth_sessions: [
    'id', 'expiresAt', 'token', 'createdAt', 'updatedAt', 'ipAddress', 'userAgent', 'userId',
    'tokenLookupHash',
  ],
  auth_accounts: [
    'id', 'accountId', 'providerId', 'userId', 'accessToken', 'refreshToken', 'idToken',
    'accessTokenExpiresAt', 'refreshTokenExpiresAt', 'scope', 'password', 'createdAt', 'updatedAt',
    'issuer',
  ],
  auth_verifications: ['id', 'identifier', 'value', 'expiresAt', 'createdAt', 'updatedAt'],
  auth_user_account_map: ['auth_user_id', 'account_id', 'created_at'],
  known_auth_session_metadata: [
    'auth_session_id', 'session_token_hash', 'account_id', 'idle_expires_at', 'absolute_expires_at',
    'security_epoch', 'csrf_token_hash', 'predecessor_session_id', 'last_seen_at', 'revoked_at', 'created_at',
  ],
  legacy_oidc_identity_archive: [
    'id', 'issuer', 'subject', 'account_id', 'migration_source', 'email_verified_claim', 'migrated_at', 'retention_until',
  ],
  auth_two_factor: [
    'id', 'secret', 'backupCodes', 'userId', 'verified', 'failedVerificationCount', 'lockedUntil', 'createdAt', 'updatedAt',
  ],
};

describeWithPostgres('B1 Better Auth expand migrations (real PostgreSQL)', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('b1_better_auth_schema');
    const migrator = createMigrator(isolated.runtime.db, 'migrations', isolated.schema);
    // Empty-database full chain: B1 expands plus later production migrations.
    const result = await migrator.migrateToLatest();
    if (result.error) throw result.error;
  }, 120_000);
  afterAll(async () => isolated?.close());

  test('empty database full chain: reviewed library columns plus additive product protection columns', async () => {
    for (const table of [...BA_TABLES, ...KNOWN_TABLES]) {
      assert.equal(await tablePresent(isolated, table), true, `missing table ${table}`);
      const columns = await isolated.runtime.pool.query<{ column_name: string }>(
        `select column_name from information_schema.columns
          where table_schema = current_schema() and table_name = $1
          order by ordinal_position`,
        [table],
      );
      assert.deepEqual(
        columns.rows.map((row) => row.column_name),
        EXPECTED_COLUMNS[table],
        `column layout of ${table} must match the reviewed library shape plus product expansions`,
      );
    }

    // Critical types/nullability from the spike artifact.
    const authUsers = await isolated.runtime.pool.query<{
      column_name: string; data_type: string; is_nullable: string;
    }>(
      `select column_name, data_type, is_nullable from information_schema.columns
        where table_schema = current_schema() and table_name = 'auth_users'`,
    );
    const byName = new Map(authUsers.rows.map((row) => [row.column_name, row]));
    assert.equal(byName.get('emailVerified')?.data_type, 'boolean');
    assert.equal(byName.get('emailVerified')?.is_nullable, 'NO');
    assert.equal(byName.get('image')?.is_nullable, 'YES');
    assert.equal(byName.get('createdAt')?.data_type, 'timestamp with time zone');
    // C4 additive MFA column: boolean NOT NULL with DEFAULT false (MFA off).
    assert.equal(byName.get('twoFactorEnabled')?.data_type, 'boolean');
    assert.equal(byName.get('twoFactorEnabled')?.is_nullable, 'NO');

    const sessions = await isolated.runtime.pool.query<{ column_name: string; data_type: string; is_nullable: string }>(
      `select column_name, data_type, is_nullable from information_schema.columns
        where table_schema = current_schema() and table_name = 'auth_sessions'`,
    );
    const sessionByName = new Map(sessions.rows.map((row) => [row.column_name, row]));
    assert.equal(sessionByName.get('expiresAt')?.data_type, 'timestamp with time zone');
    assert.equal(sessionByName.get('expiresAt')?.is_nullable, 'NO');
    assert.equal(sessionByName.get('updatedAt')?.is_nullable, 'NO');
    assert.equal(sessionByName.get('tokenLookupHash')?.data_type, 'text');
    assert.equal(sessionByName.get('tokenLookupHash')?.is_nullable, 'YES');
  });

  test('upgrades the historical B1 head and repeats its up/down at zero rows', async () => {
    const upgrade = await createIsolatedPostgresRuntime('b1_better_auth_upgrade');
    try {
      const migrator = createMigrator(upgrade.runtime.db, 'migrations', upgrade.schema);
      const previous = await migrator.migrateTo(PREVIOUS_STABLE_MIGRATION);
      if (previous.error) throw previous.error;

      const countBefore = await migrationCount(upgrade);
      for (const table of [...BA_TABLES, ...KNOWN_TABLES]) {
        assert.equal(await tablePresent(upgrade, table), false, `${table} must not exist before B1`);
      }

      const latest = await migrator.migrateTo(NEW_MIGRATIONS[4]);
      if (latest.error) throw latest.error;
      assert.equal(
        await migrationCount(upgrade),
        countBefore + NEW_MIGRATIONS.length,
        'B1 alone is the reversible delta from its previous head',
      );
      const applied = await upgrade.runtime.pool.query<{ name: string }>(
        `select name from kysely_migration order by name`,
      );
      const names = applied.rows.map((row) => row.name);
      for (const migration of NEW_MIGRATIONS) assert.ok(names.includes(migration), `missing ${migration}`);
      for (const table of [...BA_TABLES, ...KNOWN_TABLES]) {
        assert.equal(await tablePresent(upgrade, table), true, `${table} must exist after B1`);
      }

      // Exercise B1 reversibility, not later expand-only/financial migrations.
      // The full current upgrade remains covered by the suite setup and timestamp test.
      const down = await migrator.migrateTo(PREVIOUS_STABLE_MIGRATION);
      if (down.error) throw down.error;
      for (const table of [...BA_TABLES, ...KNOWN_TABLES]) {
        assert.equal(await tablePresent(upgrade, table), false, `${table} must be removed by down at zero rows`);
      }
      const forward = await migrator.migrateTo(NEW_MIGRATIONS[4]);
      if (forward.error) throw forward.error;
      for (const table of [...BA_TABLES, ...KNOWN_TABLES]) {
        assert.equal(await tablePresent(upgrade, table), true, `${table} must be recreated by forward`);
      }
    } finally {
      await upgrade.close();
    }
  }, 120_000);

  test('migrateToLatest recovers when kysely_migration timestamps invert name order', async () => {
    const inverted = await createIsolatedPostgresRuntime('b1_timestamp_order');
    try {
      const migrator = createMigrator(inverted.runtime.db, 'migrations', inverted.schema);
      const previous = await migrator.migrateTo(PREVIOUS_STABLE_MIGRATION);
      if (previous.error) throw previous.error;

      // Reproduce the Kysely 0.29 trap: executed rows sorted by timestamp no
      // longer match file-name order (WSL2/NTP clock step or same-ms inserts).
      await inverted.runtime.pool.query(`
        UPDATE kysely_migration AS m
        SET timestamp = o.ts
        FROM (
          SELECT name,
                 to_char(
                   TIMESTAMPTZ '2099-01-01 00:00:00+00'
                   - (row_number() OVER (ORDER BY name COLLATE "C") * INTERVAL '1 millisecond'),
                   'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
                 ) AS ts
          FROM kysely_migration
        ) AS o
        WHERE m.name = o.name
      `);

      const latest = await migrator.migrateToLatest();
      if (latest.error) throw latest.error;
      const applied = await inverted.runtime.pool.query<{ name: string }>(
        `select name from kysely_migration order by name`,
      );
      const names = applied.rows.map((row) => row.name);
      for (const migration of NEW_MIGRATIONS) {
        assert.ok(names.includes(migration), `missing ${migration} after timestamp-order recovery`);
      }
      for (const table of [...BA_TABLES, ...KNOWN_TABLES]) {
        assert.equal(await tablePresent(inverted, table), true, `${table} must exist after recovery`);
      }
    } finally {
      await inverted.close();
    }
  }, 120_000);

  test('constraints verified through information_schema and pg_indexes', async () => {
    // BA default uniques (spike §4.2): auth_users.email, auth_sessions.token.
    assert.equal(await hasUniqueIndex(isolated, 'auth_users', 'email'), true, 'auth_users.email unique');
    assert.equal(await hasUniqueIndex(isolated, 'auth_sessions', 'token'), true, 'auth_sessions.token unique');
    assert.equal(
      await hasUniqueIndex(isolated, 'auth_sessions', '"tokenLookupHash"'),
      true,
      'auth_sessions.tokenLookupHash has a partial unique lookup index',
    );

    // B1 R5 gap fix: UNIQUE (providerId, accountId) + named composite index.
    assert.equal(
      await hasUniqueIndex(isolated, 'auth_accounts', '"providerId", "accountId"'),
      true,
      'auth_accounts UNIQUE(providerId, accountId)',
    );
    const accountIndexes = await indexDefs(isolated, 'auth_accounts');
    // T-09 (202609260500) drops the named composite duplicate; the UNIQUE
    // constraint's implicit index carries the (providerId, accountId) path.
    assert.ok(
      !accountIndexes.some((def) => def.includes('auth_accounts_provider_account_idx')),
      'auth_accounts_provider_account_idx must be dropped by the T-09 cleanup',
    );

    // Generated non-unique indexes from the artifact. T-09 (202609260500)
    // replaces the single-column identifier index with the composite
    // ("identifier", "createdAt" DESC) newest-row index from 202609260300.
    for (const [table, index] of [
      ['auth_sessions', 'auth_sessions_userId_idx'],
      ['auth_accounts', 'auth_accounts_userId_idx'],
      ['auth_verifications', 'auth_verifications_identifier_created_idx'],
    ] as const) {
      const defs = await indexDefs(isolated, table);
      const def = defs.find((candidate) => candidate.includes(index));
      assert.ok(def, `missing index ${index} on ${table}`);
      assert.ok(!def.includes('UNIQUE'), `${index} must stay non-unique`);
    }
    const verificationIndexes = await indexDefs(isolated, 'auth_verifications');
    assert.ok(
      !verificationIndexes.some((def) => def.includes('auth_verifications_identifier_idx')),
      'auth_verifications_identifier_idx must be dropped by the T-09 cleanup',
    );
    // auth_verifications.identifier must not gain a UNIQUE constraint (library contract).
    assert.equal(
      await hasUniqueIndex(isolated, 'auth_verifications', 'identifier'),
      false,
      'auth_verifications.identifier must stay index-only',
    );

    // Mapping bidirectional 1:1.
    assert.equal(await hasUniqueIndex(isolated, 'auth_user_account_map', 'auth_user_id'), true);
    assert.equal(await hasUniqueIndex(isolated, 'auth_user_account_map', 'account_id'), true);

    // Metadata predecessor CAS partial unique index + account lookup index.
    const metadataIndexes = await indexDefs(isolated, 'known_auth_session_metadata');
    assert.ok(
      metadataIndexes.some((def) =>
        def.includes('CREATE UNIQUE INDEX known_auth_session_metadata_predecessor_session_id_unique')
        // pg_indexes renders the partial predicate without quotes for an
        // all-lowercase identifier; accept either rendering.
        && /WHERE \("?predecessor_session_id"? IS NOT NULL\)/.test(def)),
      'predecessor single-winner partial unique index',
    );
    assert.ok(
      metadataIndexes.some((def) => def.includes('CREATE INDEX known_auth_session_metadata_account_id_idx')),
      'metadata account lookup index',
    );

    // FK delete behaviors (pg_constraint confdeltype: c=CASCADE, r=RESTRICT, n=SET NULL).
    assert.equal(await fkDeleteBehavior(isolated, 'auth_sessions', 'auth_sessions_userId_fkey'), 'c');
    assert.equal(await fkDeleteBehavior(isolated, 'auth_accounts', 'auth_accounts_userId_fkey'), 'c');
    assert.equal(await fkDeleteBehavior(isolated, 'auth_user_account_map', 'auth_user_account_map_auth_user_fk'), 'c');
    assert.equal(await fkDeleteBehavior(isolated, 'auth_user_account_map', 'auth_user_account_map_account_fk'), 'r');
    assert.equal(
      await fkDeleteBehavior(isolated, 'known_auth_session_metadata', 'known_auth_session_metadata_auth_session_fk'),
      'c',
    );
    assert.equal(
      await fkDeleteBehavior(isolated, 'known_auth_session_metadata', 'known_auth_session_metadata_account_fk'),
      'r',
    );
    assert.equal(
      await fkDeleteBehavior(isolated, 'known_auth_session_metadata', 'known_auth_session_metadata_predecessor_fk'),
      'n',
    );
    assert.equal(
      await fkDeleteBehavior(isolated, 'legacy_oidc_identity_archive', 'legacy_oidc_identity_archive_account_fk'),
      'r',
    );
    // C4 MFA: the twoFactor row cascades from the auth user; its userId
    // lookup index exists and stays non-unique.
    assert.equal(await fkDeleteBehavior(isolated, 'auth_two_factor', 'auth_two_factor_userId_fkey'), 'c');
    const twoFactorIndexes = await indexDefs(isolated, 'auth_two_factor');
    const userIdIdx = twoFactorIndexes.find((def) => def.includes('auth_two_factor_userId_idx'));
    assert.ok(userIdIdx, 'auth_two_factor userId lookup index');
    assert.ok(!userIdIdx?.includes('UNIQUE'), 'auth_two_factor userId index must stay non-unique');

    // ADR §15 validation query 5: the archive has no token/secret/code/refresh column.
    const archiveColumns = await isolated.runtime.pool.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = current_schema() and table_name = 'legacy_oidc_identity_archive'
          and column_name ~* '(token|secret|code|refresh)'`,
    );
    assert.deepEqual(archiveColumns.rows, [], 'archive must not expose any token/secret/code/refresh column');
  });

  test('unique, CAS single-winner, cascade and restrict behave on real rows', async () => {
    await isolated.runtime.pool.query(
      `insert into accounts(id, subject_id, status) values ('acct-1','subj-1','active'), ('acct-2','subj-2','active')`,
    );
    await isolated.runtime.pool.query(
      `insert into "auth_users" ("id","name","email","emailVerified")
       values ('user-1','u1','u1@example.com',true), ('user-2','u2','u2@example.com',true)`,
    );
    await isolated.runtime.pool.query(
      `insert into "auth_sessions" ("id","expiresAt","token","updatedAt","userId")
       values ('sess-1', now() + interval '1 day', 'tok-1', now(), 'user-1'),
              ('sess-2', now() + interval '1 day', 'tok-2', now(), 'user-1')`,
    );
    await isolated.runtime.pool.query(
      `insert into "auth_accounts" ("id","accountId","providerId","userId","issuer","createdAt","updatedAt")
       values ('auth-acct-1','google-1','google','user-1','local:oauth:google', now(), now())`,
    );
    await isolated.runtime.pool.query(
      `insert into auth_user_account_map(auth_user_id, account_id) values ('user-1','acct-1')`,
    );
    await isolated.runtime.pool.query(
      `insert into known_auth_session_metadata
         (auth_session_id, session_token_hash, account_id, idle_expires_at, absolute_expires_at,
          security_epoch, csrf_token_hash, predecessor_session_id)
       values ('sess-1','hash-1','acct-1', now() + interval '1 day', now() + interval '2 days', 0, 'csrf-1', null),
              ('sess-2','hash-2','acct-1', now() + interval '1 day', now() + interval '2 days', 0, 'csrf-2', 'sess-1')`,
    );

    // Duplicate provider account pair must fail (R5 gap fix).
    await expectPgError(isolated,
      `insert into "auth_accounts" ("id","accountId","providerId","userId","issuer","createdAt","updatedAt")
       values ('auth-acct-2','google-1','google','user-2','local:oauth:google', now(), now())`,
      '23505', 'duplicate (providerId, accountId) must be rejected');

    // Duplicate bidirectional mapping must fail.
    await expectPgError(isolated,
      `insert into auth_user_account_map(auth_user_id, account_id) values ('user-2','acct-1')`,
      '23505', 'second mapping for the same account must be rejected');

    // Predecessor CAS: a second successor for sess-1 must fail (single winner).
    await isolated.runtime.pool.query(
      `insert into "auth_sessions" ("id","expiresAt","token","updatedAt","userId")
       values ('sess-3', now() + interval '1 day', 'tok-3', now(), 'user-1')`,
    );
    await expectPgError(isolated,
      `insert into known_auth_session_metadata
         (auth_session_id, session_token_hash, account_id, idle_expires_at, absolute_expires_at,
          security_epoch, csrf_token_hash, predecessor_session_id)
       values ('sess-3','hash-3','acct-1', now() + interval '1 day', now() + interval '2 days', 0, 'csrf-3', 'sess-1')`,
      '23505', 'predecessor CAS must allow only one successor');

    // Duplicate session token hash must fail.
    await expectPgError(isolated,
      `insert into known_auth_session_metadata
         (auth_session_id, session_token_hash, account_id, idle_expires_at, absolute_expires_at,
          security_epoch, csrf_token_hash, predecessor_session_id)
       values ('sess-3','hash-2','acct-1', now() + interval '1 day', now() + interval '2 days', 0, 'csrf-3', null)`,
      '23505', 'session_token_hash must be unique');

    // Bad epoch / bad idle-absolute ordering must fail closed.
    await expectPgError(isolated,
      `insert into known_auth_session_metadata
         (auth_session_id, session_token_hash, account_id, idle_expires_at, absolute_expires_at,
          security_epoch, csrf_token_hash, predecessor_session_id)
       values ('sess-3','hash-3b','acct-1', now() + interval '1 day', now() + interval '2 days', -1, 'csrf-3', null)`,
      '23514', 'negative security_epoch must be rejected');
    await expectPgError(isolated,
      `insert into known_auth_session_metadata
         (auth_session_id, session_token_hash, account_id, idle_expires_at, absolute_expires_at,
          security_epoch, csrf_token_hash, predecessor_session_id)
       values ('sess-3','hash-3c','acct-1', now() + interval '2 days', now() + interval '1 day', 0, 'csrf-3', null)`,
      '23514', 'idle_expires_at > absolute_expires_at must be rejected');
    await expectPgError(isolated,
      `insert into auth_user_account_map(auth_user_id, account_id) values ('user-2', null)`,
      '23502', 'null account_id must be rejected');

    // RESTRICT: deleting the mapped business account must fail closed.
    await expectPgError(isolated,
      `delete from accounts where id = 'acct-1'`,
      '23503', 'deleting a mapped account must be restricted');

    // CASCADE: deleting the auth user removes its sessions, provider accounts,
    // mapping and metadata (library + B1 FK behavior).
    await isolated.runtime.pool.query(`delete from "auth_users" where id = 'user-1'`);
    for (const [table, expected] of [
      ['"auth_sessions"', 0],
      ['"auth_accounts"', 0],
      ['auth_user_account_map', 0],
      ['known_auth_session_metadata', 0],
    ] as const) {
      const count = await isolated.runtime.pool.query<{ count: number }>(
        `select count(*)::int count from ${table}`,
      );
      assert.equal(count.rows[0]?.count, expected, `${table} cascade from auth_users`);
    }

    // Archive: accepts only evidence facts, defaults to permanent retention.
    await isolated.runtime.pool.query(
      `insert into legacy_oidc_identity_archive
         (issuer, subject, account_id, migration_source, email_verified_claim)
       values ('https://issuer.example','subj-9','acct-2','legacy-oidc-import-v1',true)`,
    );
    // node-pg parses the PostgreSQL timestamptz special value 'infinity' as
    // the JavaScript Infinity, so the permanent-retention default is asserted
    // against Infinity rather than the SQL literal string.
    const archiveRow = await isolated.runtime.pool.query<{
      retention_until: number; email_verified_claim: boolean;
    }>(`select retention_until, email_verified_claim from legacy_oidc_identity_archive where subject = 'subj-9'`);
    assert.equal(archiveRow.rows[0]?.email_verified_claim, true);
    assert.equal(archiveRow.rows[0]?.retention_until, Infinity, 'archive retention defaults to permanent');
  });

  test('down with rows refuses and preserves data; zero-row down then works', async () => {
    const guarded = await createIsolatedPostgresRuntime('b1_better_auth_guard');
    try {
      const migrator = createMigrator(guarded.runtime.db, 'migrations', guarded.schema);
      const latest = await migrator.migrateTo(NEW_MIGRATIONS[4]);
      if (latest.error) throw latest.error;

      await guarded.runtime.pool.query(
        `insert into accounts(id, subject_id, status) values ('acct-1','subj-1','active')`,
      );
      await guarded.runtime.pool.query(
        `insert into "auth_users" ("id","name","email","emailVerified")
         values ('user-1','u1','u1@example.com',true)`,
      );
      await guarded.runtime.pool.query(
        `insert into "auth_sessions" ("id","expiresAt","token","updatedAt","userId")
         values ('sess-1', now() + interval '1 day', 'tok-1', now(), 'user-1')`,
      );
      await guarded.runtime.pool.query(
        `insert into "auth_accounts" ("id","accountId","providerId","userId","createdAt","updatedAt")
         values ('auth-acct-1','google-1','google','user-1', now(), now())`,
      );
      await guarded.runtime.pool.query(
        `insert into "auth_verifications" ("id","identifier","value","expiresAt","createdAt","updatedAt")
         values ('ver-1','id-1','val-1', now() + interval '1 hour', now(), now())`,
      );
      await guarded.runtime.pool.query(
        `insert into auth_user_account_map(auth_user_id, account_id) values ('user-1','acct-1')`,
      );
      await guarded.runtime.pool.query(
        `insert into known_auth_session_metadata
           (auth_session_id, session_token_hash, account_id, idle_expires_at, absolute_expires_at,
            security_epoch, csrf_token_hash)
         values ('sess-1','hash-1','acct-1', now() + interval '1 day', now() + interval '2 days', 0, 'csrf-1')`,
      );
      await guarded.runtime.pool.query(
        `insert into legacy_oidc_identity_archive
           (issuer, subject, account_id, migration_source, email_verified_claim)
         values ('https://issuer.example','subj-9','acct-1','legacy-oidc-import-v1',true)`,
      );

      // Start at the historical B1 head so the MFA guard is the next down.
      // Future irreversible migrations must not mask the behavior under test.
      await guarded.runtime.pool.query(
        `insert into "auth_two_factor" ("id","secret","backupCodes","userId")
         values ('tf-1','encrypted-secret','encrypted-codes','user-1')`,
      );
      await guarded.runtime.pool.query(
        `update "auth_users" set "twoFactorEnabled" = true where id = 'user-1'`,
      );
      {
        const mfaDown = await migrator.migrateDown();
        const mfaError = mfaDown?.error;
        assert.ok(mfaError, 'better_auth_mfa_schema down must refuse with rows');
        assert.match(String(mfaError), /down refused/);
        assert.equal(await tablePresent(guarded, 'auth_two_factor'), true, 'auth_two_factor must survive refused down');
        await guarded.runtime.pool.query(`delete from "auth_two_factor"`);
        await guarded.runtime.pool.query(`update "auth_users" set "twoFactorEnabled" = false where id = 'user-1'`);
        const cleared = await migrator.migrateDown();
        if (cleared.error) throw cleared.error;
        assert.equal(await tablePresent(guarded, 'auth_two_factor'), false, 'auth_two_factor must be dropped at zero rows');
      }

      // Each of the five downs refuses while its own table has rows, then
      // succeeds at zero rows — exercised one migration at a time in reverse
      // dependency order (1000 -> 930 -> 920 -> 910 -> 900).
      const refuseThenClean = async (table: string, remaining: readonly string[]): Promise<void> => {
        const down = await migrator.migrateDown();
        assert.ok(down.error, `${table} down must refuse with rows`);
        assert.match(String(down.error), /down refused/, `${table} down must report a guard refusal`);
        assert.equal(await tablePresent(guarded, table), true, `${table} must survive refused down`);
        await guarded.runtime.pool.query(`delete from ${table}`);
        for (const other of remaining) {
          assert.equal(await tablePresent(guarded, other), true, `${other} must still exist`);
        }
        const cleared = await migrator.migrateDown();
        if (cleared.error) throw cleared.error;
        assert.equal(await tablePresent(guarded, table), false, `${table} must be dropped at zero rows`);
      };

      await refuseThenClean('legacy_oidc_identity_archive', ['auth_user_account_map', 'known_auth_session_metadata']);
      await refuseThenClean('known_auth_session_metadata', ['auth_user_account_map', '"auth_sessions"']);
      await refuseThenClean('auth_user_account_map', ['"auth_users"', '"auth_sessions"']);
      {
        // 900 guards all four BA tables as one unit (per-table counts in the
        // refusal message), so the destructive drop is all-or-nothing.
        const down = await migrator.migrateDown();
        assert.ok(down.error, 'better_auth_schema down must refuse with rows');
        assert.match(String(down.error), /down refused/);
        for (const table of BA_TABLES) {
          assert.equal(await tablePresent(guarded, table), true, `${table} must survive refused down`);
        }
        await guarded.runtime.pool.query(`delete from "auth_verifications"`);
        await guarded.runtime.pool.query(`delete from "auth_sessions"`);
        await guarded.runtime.pool.query(`delete from "auth_accounts"`);
        await guarded.runtime.pool.query(`delete from "auth_users"`);
        await guarded.runtime.pool.query(`delete from accounts where id = 'acct-1'`);
        const cleared = await migrator.migrateDown();
        if (cleared.error) throw cleared.error;
        for (const table of BA_TABLES) {
          assert.equal(await tablePresent(guarded, table), false, `${table} must be dropped at zero rows`);
        }
      }

      // Forward recovery restores the full head.
      const forward = await migrator.migrateTo(NEW_MIGRATIONS[4]);
      if (forward.error) throw forward.error;
      for (const table of [...BA_TABLES, ...KNOWN_TABLES]) {
        assert.equal(await tablePresent(guarded, table), true, `${table} must be restored by forward`);
      }
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

async function migrationCount(runtime: IsolatedPostgresRuntime): Promise<number> {
  return (await runtime.runtime.pool.query<{ count: number }>(
    `select count(*)::int count from kysely_migration`,
  )).rows[0]?.count ?? 0;
}

async function indexDefs(runtime: IsolatedPostgresRuntime, table: string): Promise<string[]> {
  const result = await runtime.runtime.pool.query<{ indexdef: string }>(
    `select indexdef from pg_indexes
      where schemaname = current_schema() and tablename = $1`,
    [table],
  );
  return result.rows.map((row) => row.indexdef);
}

async function hasUniqueIndex(runtime: IsolatedPostgresRuntime, table: string, column: string): Promise<boolean> {
  const defs = await indexDefs(runtime, table);
  return defs.some((def) => def.includes('UNIQUE') && def.includes(`(${column})`));
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

async function expectPgError(
  runtime: IsolatedPostgresRuntime,
  sqlText: string,
  code: string,
  reason: string,
): Promise<void> {
  await assert.rejects(
    () => runtime.runtime.pool.query(sqlText),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, code, `${reason} (expected SQLSTATE ${code})`);
      return true;
    },
  );
}
