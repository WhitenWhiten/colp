/**
 * Task B2 integration tests: controlled legacy OIDC account import over REAL
 * PostgreSQL (migrations through the current head, dedicated isolated
 * schema). The production port implementation (createPostgresLegacyImportPorts
 * from the CLI script) and the CLI entrypoint itself are exercised.
 *
 * 假阴性防护: dry-run runs first, then apply, repeated apply, and rollback
 * verification; fixtures are seeded in randomized order to prove the outcome
 * never depends on database row order; the ADR §15 validation queries are
 * asserted against the real database (never just "did not throw").
 *
 * 假阳性防护: after apply the suite queries auth_accounts / auth_sessions /
 * auth_verifications and asserts ZERO rows (no password credential, no
 * browser session, no proof rows for legacy OIDC users); a same-email
 * two-subject fixture proves no merge; a pre-existing auth user holding the
 * candidate email proves no implicit adoption; the archive is asserted to
 * contain only the seeded issuer/subject facts (no token-like content) and
 * the schema-level secret-column query returns nothing.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, test } from 'vitest';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import {
  createPostgresLegacyImportPorts,
  exitCodeForReport,
  parseLegacyImportCliArgs,
  runLegacyImportCli,
  LEGACY_IMPORT_EXIT,
} from '../../../scripts/migrate-legacy-oidc-to-better-auth.js';
import {
  DEFAULT_LEGACY_IMPORT_OPTIONS,
  LEGACY_IMPORT_MIGRATION_SOURCE,
  deriveLegacyAuthUserId,
  runLegacyAccountImport,
  type LegacyImportOptions,
  type LegacyImportReport,
} from '../../../src/modules/auth/application/legacy-account-import.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

const ISSUER = 'https://accounts.example.com';

describeWithPostgres('B2 legacy OIDC account import PostgreSQL persistence', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('b2_legacy_account_import', {
      maxConnections: 10,
      applicationName: 'known-b2-legacy-account-import-test',
    });
    await runMigrations(isolated.runtime.db, 'latest');
  }, 120_000);

  afterAll(async () => {
    await isolated?.close();
  });

  beforeEach(async () => {
    await isolated.runtime.pool.query(`delete from auth_user_account_map`);
    await isolated.runtime.pool.query(`delete from legacy_oidc_identity_archive`);
    await isolated.runtime.pool.query(`delete from account_identities`);
    await isolated.runtime.pool.query(`delete from profile_handles`);
    await isolated.runtime.pool.query(`delete from profiles`);
    await isolated.runtime.pool.query(`delete from accounts`);
    await isolated.runtime.pool.query(`delete from "auth_accounts"`);
    await isolated.runtime.pool.query(`delete from "auth_sessions"`);
    await isolated.runtime.pool.query(`delete from "auth_verifications"`);
    await isolated.runtime.pool.query(`delete from "auth_users"`);
  });

  function ports(
    options: { readonly faultInjector?: NonNullable<Parameters<typeof createPostgresLegacyImportPorts>[1]>['faultInjector'] } = {},
  ) {
    return createPostgresLegacyImportPorts(isolated.runtime, options);
  }

  function run(
    mode: 'dry-run' | 'apply',
    options: Partial<LegacyImportOptions> = {},
  ): Promise<LegacyImportReport> {
    return runLegacyAccountImport(
      ports(),
      { ...DEFAULT_LEGACY_IMPORT_OPTIONS, ...options },
      { mode },
    );
  }

  async function tableCount(table: string): Promise<number> {
    const result = await isolated.runtime.pool.query<{ n: number }>(
      `select count(*)::int n from ${table}`,
    );
    return result.rows[0]?.n ?? 0;
  }

  async function queryCount(sqlText: string, params: unknown[] = []): Promise<number> {
    const result = await isolated.runtime.pool.query<{ n: number }>(sqlText, params);
    return result.rows[0]?.n ?? 0;
  }

  interface SeedAccountInput {
    readonly id: string;
    readonly email: string | null;
    readonly status?: 'active' | 'disabled' | 'deleted';
    readonly displayName?: string;
    readonly handle: string;
    readonly identity?: { readonly issuer: string; readonly subject: string };
  }

  /** Seeds a business account with profile + handle (+ optional OIDC identity). */
  async function seedAccount(input: SeedAccountInput): Promise<void> {
    await isolated.runtime.pool.query(
      `insert into accounts(id, subject_id, status, email) values ($1, $2, $3, $4)`,
      [input.id, `subj-${input.id}`, input.status ?? 'active', input.email],
    );
    await isolated.runtime.pool.query(
      `insert into profiles(account_id, display_name) values ($1, $2)`,
      [input.id, input.displayName ?? `Profile ${input.id}`],
    );
    await isolated.runtime.pool.query(
      `insert into profile_handles(handle, account_id) values ($1, $2)`,
      [input.handle, input.id],
    );
    if (input.identity) {
      // The OIDC handle invariant trigger requires the handle BEFORE the
      // identity row (same ordering as the A2 suite).
      await isolated.runtime.pool.query(
        `insert into account_identities(id, account_id, issuer, subject) values ($1, $2, $3, $4)`,
        [`identity-${input.id}`, input.id, input.identity.issuer, input.identity.subject],
      );
    }
  }

  /** 15 demo-like accounts mirroring seed/demo/data.sql (distinct emails + identities + handles). */
  async function seedDemoAccounts(count = 15): Promise<string[]> {
    const ids: string[] = [];
    for (let index = 1; index <= count; index += 1) {
      const number = String(index).padStart(2, '0');
      const id = `acc-u${number}`;
      ids.push(id);
      await seedAccount({
        id,
        email: `user${number}@example.test`,
        displayName: `User ${number}`,
        handle: `handle-${number}`,
        identity: { issuer: ISSUER, subject: `sub-u${number}` },
      });
    }
    return ids;
  }

  function shuffled<T>(values: readonly T[]): T[] {
    return [...values].sort(() => (Math.random() < 0.5 ? -1 : 1));
  }

  test('dry-run reports the plan and writes nothing', async () => {
    await seedDemoAccounts(15);
    const report = await run('dry-run');
    assert.equal(report.outcome, 'ok');
    assert.equal(report.counts.accountsScanned, 15);
    assert.equal(report.counts.migratable, 15);
    assert.equal(await tableCount('"auth_users"'), 0);
    assert.equal(await tableCount('auth_user_account_map'), 0);
    assert.equal(await tableCount('legacy_oidc_identity_archive'), 0);
  });

  test('apply imports 15+ demo-like accounts with user/mapping/archive and NO credentials, sessions or verification rows', async () => {
    await seedDemoAccounts(15);
    const accountsBefore = await isolated.runtime.pool.query(
      `select id, subject_id, status, email from accounts order by id`,
    );
    const report = await run('apply');
    assert.equal(report.outcome, 'ok');
    assert.equal(report.counts.imported, 15);
    assert.equal(report.counts.authUsersCreated, 15);
    assert.equal(report.counts.mappingsCreated, 15);
    assert.equal(report.counts.archiveRowsCreated, 15);
    assert.equal(report.validationAfter!.orphanAuthUserIds.length, 0);
    assert.equal(report.validationAfter!.orphanMappingAuthUserIds.length, 0);
    assert.equal(report.validationAfter!.duplicateAccountMappings.length, 0);
    assert.equal(report.validationAfter!.activeAccountsWithoutCoverage.length, 0);
    assert.equal(report.validationAfter!.archiveSecretColumns.length, 0);

    // 假阳性防护: the import must never mint credentials, sessions or proofs.
    assert.equal(await tableCount('"auth_accounts"'), 0, 'no password credential may be created');
    assert.equal(await tableCount('"auth_sessions"'), 0, 'no browser session may be created');
    assert.equal(await tableCount('"auth_verifications"'), 0, 'no verification/proof row may be created');

    // Legacy business tables are read-only inputs: they must be untouched.
    const accountsAfter = await isolated.runtime.pool.query(
      `select id, subject_id, status, email from accounts order by id`,
    );
    assert.deepEqual(accountsAfter.rows, accountsBefore.rows, 'accounts must not be modified by the import');
    assert.equal(await tableCount('account_identities'), 15, 'legacy identity rows must be preserved');

    // Every auth user carries the deterministic id, display name, the product
    // email and emailVerified=false (G0: no local proof conversion).
    for (let index = 1; index <= 15; index += 1) {
      const number = String(index).padStart(2, '0');
      const accountId = `acc-u${number}`;
      const user = await isolated.runtime.pool.query<{
        id: string; email: string; emailVerified: boolean; name: string;
      }>(`select id, email, "emailVerified", name from "auth_users" where id = $1`, [
        deriveLegacyAuthUserId(accountId),
      ]);
      assert.equal(user.rows.length, 1, `auth user for ${accountId} must exist`);
      assert.equal(user.rows[0]!.email, `user${number}@example.test`);
      assert.equal(user.rows[0]!.name, `User ${number}`);
      assert.equal(user.rows[0]!.emailVerified, false, 'emailVerified must stay false on import');
      const mapping = await queryCount(
        `select count(*)::int n from auth_user_account_map where auth_user_id = $1 and account_id = $2`,
        [deriveLegacyAuthUserId(accountId), accountId],
      );
      assert.equal(mapping, 1, `mapping for ${accountId} must exist`);
    }

    // Archive rows carry exactly the seeded issuer/subject facts and the
    // migration source; no token-like value may appear in any text column.
    const archiveRows = await isolated.runtime.pool.query<{
      issuer: string; subject: string; account_id: string; migration_source: string; email_verified_claim: boolean;
    }>(`select issuer, subject, account_id, migration_source, email_verified_claim from legacy_oidc_identity_archive`);
    assert.equal(archiveRows.rows.length, 15);
    for (const row of archiveRows.rows) {
      assert.equal(row.issuer, ISSUER);
      assert.match(row.subject, /^sub-u\d\d$/u);
      assert.equal(row.migration_source, LEGACY_IMPORT_MIGRATION_SOURCE);
      assert.equal(row.email_verified_claim, false);
      assert.doesNotMatch(JSON.stringify(row), /token|secret|code|refresh/i, 'archive must never hold secret-like content');
    }
  });

  test('active accounts without email are skipped, reported and flagged by validation', async () => {
    await seedDemoAccounts(15);
    await seedAccount({ id: 'acc-noemail', email: null, handle: 'handle-noemail' });
    const dryRun = await run('dry-run');
    assert.equal(dryRun.counts.skippedMissingEmail, 1);
    assert.equal(dryRun.counts.migratable, 15);

    const report = await run('apply');
    assert.equal(report.outcome, 'incomplete');
    assert.deepEqual(report.validationAfter!.activeAccountsWithoutCoverage, ['acc-noemail']);
    assert.equal(report.counts.imported, 15);
    assert.equal(await queryCount(`select count(*)::int n from "auth_users" where id = $1`, [deriveLegacyAuthUserId('acc-noemail')]), 0);
  });

  test('disabled and deleted accounts are skipped with their status and never imported', async () => {
    await seedDemoAccounts(15);
    await seedAccount({ id: 'acc-disabled', email: 'disabled@example.test', handle: 'handle-disabled', status: 'disabled' });
    await seedAccount({ id: 'acc-deleted', email: 'deleted@example.test', handle: 'handle-deleted', status: 'deleted' });
    const dryRun = await run('dry-run');
    assert.equal(dryRun.counts.skippedInactive, 2);
    assert.deepEqual(dryRun.skipped.map((s) => [s.accountId, s.reason]), [
      ['acc-deleted', 'inactive'],
      ['acc-disabled', 'inactive'],
    ]);
    assert.match(dryRun.skipped[1]!.detail, /status=disabled/);

    const report = await run('apply');
    assert.equal(report.outcome, 'ok', 'inactive accounts are not covered by the active-account validation query');
    assert.equal(report.counts.imported, 15);
    for (const id of ['acc-disabled', 'acc-deleted']) {
      assert.equal(await queryCount(`select count(*)::int n from "auth_users" where id = $1`, [deriveLegacyAuthUserId(id)]), 0);
      assert.equal(await queryCount(`select count(*)::int n from auth_user_account_map where account_id = $1`, [id]), 0);
    }
  });

  test('an email already held by another auth user rejects the batch by default and never merges under quarantine', async () => {
    await seedDemoAccounts(15);
    await seedAccount({ id: 'acc-dup', email: 'dup@example.test', handle: 'handle-dup', identity: { issuer: ISSUER, subject: 'sub-dup' } });
    // A Better Auth user that already owns the candidate email (e.g. created
    // by an earlier signup flow): the import must NEVER adopt or merge.
    await isolated.runtime.pool.query(
      `insert into "auth_users" ("id", "name", "email", "emailVerified") values ('external-owner', 'External', $1, true)`,
      ['dup@example.test'],
    );

    const rejected = await run('apply');
    assert.equal(rejected.outcome, 'rejected');
    assert.equal(rejected.counts.conflicts, 1);
    assert.equal(rejected.counts.imported, 0, 'fail-closed: the whole batch must stop before any write');
    assert.equal(await tableCount('"auth_users"'), 1, 'only the pre-existing auth user may exist');
    assert.equal(await tableCount('auth_user_account_map'), 0);
    assert.equal(await tableCount('legacy_oidc_identity_archive'), 0);
    assert.equal(rejected.conflicts[0]!.reason, 'duplicate_email');

    const quarantined = await run('apply', { quarantine: true });
    assert.equal(
      quarantined.outcome,
      'failed',
      'the pre-existing unmapped auth user is a hard ADR §15 orphan violation even under quarantine',
    );
    assert.equal(quarantined.counts.quarantined, 1);
    assert.equal(quarantined.counts.imported, 15, 'only the non-conflicting accounts are imported');
    assert.deepEqual(quarantined.validationAfter!.orphanAuthUserIds, ['external-owner']);
    assert.equal(await queryCount(`select count(*)::int n from auth_user_account_map where account_id = 'acc-dup'`), 0, 'the conflicting account stays unmapped');
    assert.equal(await queryCount(`select count(*)::int n from auth_user_account_map where auth_user_id = 'external-owner'`), 0, 'the pre-existing auth user must never be attached');
  });

  test('the same email with two OIDC subjects never merges into one auth user', async () => {
    // accounts.email has a case-sensitive unique index, so the fixture uses
    // case-variant spellings of the SAME email for two accounts with two
    // different OIDC subjects; a buggy merge would collapse them.
    await seedAccount({ id: 'acc-sub-a', email: 'shared@example.test', handle: 'handle-sub-a', identity: { issuer: ISSUER, subject: 'sub-a' } });
    await seedAccount({ id: 'acc-sub-b', email: 'Shared@example.test', handle: 'handle-sub-b', identity: { issuer: ISSUER, subject: 'sub-b' } });
    const report = await run('apply');
    assert.equal(report.outcome, 'ok');
    assert.equal(report.counts.imported, 2);
    assert.equal(await tableCount('"auth_users"'), 2, 'two subjects must produce two distinct auth users');
    assert.equal(await tableCount('auth_user_account_map'), 2);
    assert.equal(await tableCount('legacy_oidc_identity_archive'), 2);
    const duplicates = await isolated.runtime.pool.query<{ n: number }>(
      `select count(*)::int n from auth_user_account_map group by account_id having count(*) > 1`,
    );
    assert.equal(duplicates.rows.length, 0, 'no account may receive two mappings');
    const users = await isolated.runtime.pool.query<{ email: string }>(`select email from "auth_users" order by email`);
    assert.deepEqual(users.rows.map((row) => row.email), ['Shared@example.test', 'shared@example.test']);
  });

  test('an (issuer, subject) pair already archived for another account is a conflict and never overwrites', async () => {
    await seedDemoAccounts(15);
    await seedAccount({ id: 'acc-y', email: 'y@example.test', handle: 'handle-y', identity: { issuer: ISSUER, subject: 'sub-y' } });
    // The archive FK references accounts(id), so the owner account must exist
    // first; a disabled account is skipped by the import and never counted.
    await seedAccount({ id: 'acct-other', email: 'other@example.test', status: 'disabled', handle: 'handle-other' });
    // Directly seeded archive row owned by a DIFFERENT account (mirrors the
    // A2 fixture pattern): the pair is taken.
    await isolated.runtime.pool.query(
      `insert into legacy_oidc_identity_archive(issuer, subject, account_id, migration_source, email_verified_claim)
       values ($1, $2, $3, $4, true)`,
      [ISSUER, 'sub-y', 'acct-other', 'legacy-oidc-import-v1'],
    );

    const rejected = await run('apply');
    assert.equal(rejected.outcome, 'rejected');
    assert.equal(rejected.counts.conflicts, 1);
    assert.equal(rejected.conflicts[0]!.reason, 'duplicate_subject');
    assert.equal(await tableCount('legacy_oidc_identity_archive'), 1, 'nothing may be written on rejection');

    const quarantined = await run('apply', { quarantine: true });
    assert.equal(quarantined.outcome, 'incomplete');
    assert.equal(quarantined.counts.imported, 15);
    const archive = await isolated.runtime.pool.query<{ account_id: string }>(
      `select account_id from legacy_oidc_identity_archive where issuer = $1 and subject = $2`,
      [ISSUER, 'sub-y'],
    );
    assert.equal(archive.rows[0]!.account_id, 'acct-other', 'the existing archive row must stay untouched');
    assert.equal(await queryCount(`select count(*)::int n from auth_user_account_map where account_id = 'acc-y'`), 0);
  });

  test('repeated apply is idempotent: no duplicate users, mappings or archive rows', async () => {
    await seedDemoAccounts(15);
    const first = await run('apply');
    assert.equal(first.outcome, 'ok');
    const second = await run('apply');
    assert.equal(second.outcome, 'ok');
    assert.equal(second.counts.imported, 0);
    assert.equal(second.counts.alreadyImported, 15);
    assert.equal(second.counts.authUsersCreated, 0);
    assert.equal(second.counts.mappingsCreated, 0);
    assert.equal(second.counts.archiveRowsCreated, 0);
    assert.equal(await tableCount('"auth_users"'), 15);
    assert.equal(await tableCount('auth_user_account_map'), 15);
    assert.equal(await tableCount('legacy_oidc_identity_archive'), 15);
  });

  test('a mid-batch failure stops the batch, rolls back the failing account, and a re-run resumes', async () => {
    await seedDemoAccounts(15);
    let failuresRemaining = 1;
    let calls = 0;
    const report = await runLegacyAccountImport(
      ports({
        faultInjector: {
          afterCallbackBeforeCommit: async () => {
            calls += 1;
            if (failuresRemaining > 0 && calls === 6) {
              failuresRemaining = 0;
              throw new Error('injected partial-run failure');
            }
          },
        },
      }),
      DEFAULT_LEGACY_IMPORT_OPTIONS,
      { mode: 'apply' },
    );
    assert.equal(report.outcome, 'failed');
    assert.equal(report.counts.imported, 5, 'accounts 1..5 committed before the failure');
    assert.equal(report.counts.failed, 1);
    assert.equal(await tableCount('"auth_users"'), 5);
    assert.equal(await tableCount('auth_user_account_map'), 5);
    assert.equal(await tableCount('legacy_oidc_identity_archive'), 5);

    const resumed = await run('apply');
    assert.equal(resumed.outcome, 'ok');
    assert.equal(resumed.counts.imported, 10, 'the remaining accounts are imported on resume');
    assert.equal(resumed.counts.alreadyImported, 5);
    assert.equal(await tableCount('"auth_users"'), 15);
    assert.equal(await tableCount('auth_user_account_map'), 15);
    assert.equal(await tableCount('legacy_oidc_identity_archive'), 15);
    assert.equal(await tableCount('"auth_accounts"'), 0);
    assert.equal(await tableCount('"auth_sessions"'), 0);
  });

  test('a failing account transaction leaves zero half-written rows (rollback)', async () => {
    await seedDemoAccounts(3);
    const report = await runLegacyAccountImport(
      ports({
        faultInjector: {
          afterCallbackBeforeCommit: async () => {
            throw new Error('injected rollback');
          },
        },
      }),
      DEFAULT_LEGACY_IMPORT_OPTIONS,
      { mode: 'apply' },
    );
    assert.equal(report.outcome, 'failed');
    assert.equal(await tableCount('"auth_users"'), 0, 'the auth user must roll back with the transaction');
    assert.equal(await tableCount('auth_user_account_map'), 0);
    assert.equal(await tableCount('legacy_oidc_identity_archive'), 0);
  });

  test('randomized fixture insertion order does not change the outcome', async () => {
    const ids = Array.from({ length: 15 }, (_, index) => `acc-u${String(index + 1).padStart(2, '0')}`);

    async function runShuffled(): Promise<LegacyImportReport> {
      for (const id of shuffled(ids)) {
        const number = id.slice(-2);
        await seedAccount({
          id,
          email: `user${number}@example.test`,
          displayName: `User ${number}`,
          handle: `handle-${number}`,
          identity: { issuer: ISSUER, subject: `sub-u${number}` },
        });
      }
      return run('apply');
    }

    const first = await runShuffled();
    assert.equal(first.outcome, 'ok');

    await isolated.runtime.pool.query(`delete from auth_user_account_map`);
    await isolated.runtime.pool.query(`delete from legacy_oidc_identity_archive`);
    await isolated.runtime.pool.query(`delete from account_identities`);
    await isolated.runtime.pool.query(`delete from profile_handles`);
    await isolated.runtime.pool.query(`delete from profiles`);
    await isolated.runtime.pool.query(`delete from accounts`);
    await isolated.runtime.pool.query(`delete from "auth_users"`);

    const second = await runShuffled();
    assert.equal(second.outcome, 'ok');
    assert.equal(second.counts.accountsScanned, first.counts.accountsScanned);
    assert.equal(second.counts.imported, first.counts.imported);
    assert.deepEqual(second.imported, first.imported);
    assert.equal(await tableCount('"auth_users"'), 15);
    assert.equal(await tableCount('auth_user_account_map'), 15);
    assert.equal(await tableCount('legacy_oidc_identity_archive'), 15);
  });

  test('CLI writes an append-only digest ledger, is idempotent, and maps exit codes', async () => {
    await seedDemoAccounts(15);
    const ledgerDir = await mkdtemp(join(tmpdir(), 'b2-legacy-import-ledger-'));
    const ledgerPath = join(ledgerDir, 'ledger.json');

    const dryRunCode = await runLegacyImportCli(['--dry-run', `--ledger=${ledgerPath}`], { DATABASE_URL: isolated.databaseUrl });
    assert.equal(dryRunCode, LEGACY_IMPORT_EXIT.OK);
    await assert.rejects(() => readFile(ledgerPath, 'utf8'), /ENOENT/u, 'dry-run must not write the ledger');

    const applyCode = await runLegacyImportCli([`--ledger=${ledgerPath}`], { DATABASE_URL: isolated.databaseUrl });
    assert.equal(applyCode, LEGACY_IMPORT_EXIT.OK);
    const firstEntries: LegacyImportReport[] = JSON.parse(await readFile(ledgerPath, 'utf8'));
    assert.equal(firstEntries.length, 1);
    assert.equal(firstEntries[0]!.mode, 'apply');
    assert.equal(firstEntries[0]!.outcome, 'ok');
    assert.equal(firstEntries[0]!.counts.imported, 15);
    assert.match(firstEntries[0]!.digest, /^[0-9a-f]{64}$/u);

    const repeatCode = await runLegacyImportCli([`--ledger=${ledgerPath}`], { DATABASE_URL: isolated.databaseUrl });
    assert.equal(repeatCode, LEGACY_IMPORT_EXIT.OK);
    const secondEntries: LegacyImportReport[] = JSON.parse(await readFile(ledgerPath, 'utf8'));
    assert.equal(secondEntries.length, 2, 'apply appends a new ledger entry');
    assert.equal(secondEntries[1]!.counts.imported, 0, 're-run is idempotent');

    // A conflict (email held by an external auth user) rejects by default and
    // is quarantined with --quarantine.
    await seedAccount({ id: 'acc-cli-dup', email: 'cli-dup@example.test', handle: 'handle-cli-dup', identity: { issuer: ISSUER, subject: 'sub-cli-dup' } });
    await isolated.runtime.pool.query(
      `insert into "auth_users" ("id", "name", "email", "emailVerified") values ('cli-owner', 'Cli', $1, true)`,
      ['cli-dup@example.test'],
    );
    const rejectedCode = await runLegacyImportCli([`--ledger=${ledgerPath}`], { DATABASE_URL: isolated.databaseUrl });
    assert.equal(rejectedCode, LEGACY_IMPORT_EXIT.REJECTED);
    const quarantineCode = await runLegacyImportCli(['--quarantine', `--ledger=${ledgerPath}`], { DATABASE_URL: isolated.databaseUrl });
    // The pre-existing cli-owner auth user has no mapping: ADR §15 query 1
    // flags it as an orphan hard violation, so even the quarantine run exits
    // 3 (failed) instead of 1 (incomplete).
    assert.equal(quarantineCode, LEGACY_IMPORT_EXIT.FAILED);
  });

  test('exitCodeForReport and argument parsing are fail-closed', () => {
    const base: LegacyImportReport = {
      runId: 'run-1',
      mode: 'apply',
      options: DEFAULT_LEGACY_IMPORT_OPTIONS,
      startedAt: '2026-09-05T00:00:00.000Z',
      finishedAt: '2026-09-05T00:00:01.000Z',
      outcome: 'ok',
      counts: {
        accountsScanned: 0, migratable: 0, imported: 0, alreadyImported: 0,
        skippedMissingEmail: 0, skippedInactive: 0, conflicts: 0, quarantined: 0,
        failed: 0, authUsersCreated: 0, mappingsCreated: 0, archiveRowsCreated: 0,
      },
      skipped: [], conflicts: [], imported: [], failed: [],
      validationBefore: null, validationAfter: null, digest: 'x'.repeat(64),
    };
    assert.equal(exitCodeForReport({ ...base, outcome: 'ok' }), 0);
    assert.equal(exitCodeForReport({ ...base, outcome: 'incomplete' }), 1);
    assert.equal(exitCodeForReport({ ...base, outcome: 'rejected' }), 2);
    assert.equal(exitCodeForReport({ ...base, outcome: 'failed' }), 3);
    assert.throws(() => parseLegacyImportCliArgs(['--unknown-flag']), /unknown argument/);
    assert.throws(() => parseLegacyImportCliArgs(['--email-verified-claim=maybe']), /expects true or false/);
    assert.throws(() => parseLegacyImportCliArgs(['--migration-source=']), /1\.\.128 characters/);
    assert.equal(parseLegacyImportCliArgs(['--dry-run', '--quarantine', '--email-verified-claim=true', '--no-ledger']).dryRun, true);
    assert.equal(parseLegacyImportCliArgs(['--email-verified-claim=true']).emailVerifiedClaim, true);
  });
});
