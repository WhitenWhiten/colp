import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { describe, test } from 'vitest';

const MIGRATIONS_DIR = new URL('../../../migrations/', import.meta.url);

/** Frozen B1 four-file list — must stay contiguous with C4 MFA; T-02 must not splice. */
const B1_MIGRATION_FILES = [
  '202609050900_better_auth_schema.ts',
  '202609050910_better_auth_account_mapping.ts',
  '202609050920_known_auth_session_metadata.ts',
  '202609050930_legacy_oidc_identity_archive.ts',
] as const;
const C4_MFA_MIGRATION_FILE = '202609051000_better_auth_mfa_schema.ts' as const;
const PREVIOUS_DISK_HEAD = '202609220100_collection_readable_replicas.ts';
const OAUTH_MIGRATION_FILES = [
  '202609230100_better_auth_oauth_provider_schema.ts',
] as const;

const FORBIDDEN_LEGACY_TABLES = ['accounts', 'sessions', 'account_identities'] as const;
const B1_FOUR_TABLES = ['auth_users', 'auth_accounts', 'auth_sessions', 'auth_verifications'] as const;
const ISSUER_WHITELIST_TABLE = 'auth_accounts';
const ISSUER_WHITELIST_COLUMN = 'issuer';

const OAUTH_TABLES = [
  'auth_jwks',
  'auth_oauth_client',
  'auth_oauth_resource',
  'auth_oauth_client_resource',
  'auth_oauth_access_token',
  'auth_oauth_refresh_token',
  'auth_oauth_consent',
  'auth_oauth_client_assertion',
] as const;

const ALTER_OR_DROP_TABLE = /\b(?:ALTER|DROP)\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/gi;

describe('T-02 Better Auth 1.7 OAuth expand migration static contract', () => {
  test('lands after the B1+MFA contiguous chain and after the previous disk head', async () => {
    const names = await readdir(MIGRATIONS_DIR);
    const tsFiles = names.filter((name) => name.endsWith('.ts')).sort();
    const b1Chain = [...B1_MIGRATION_FILES, C4_MFA_MIGRATION_FILE];
    const start = tsFiles.indexOf(B1_MIGRATION_FILES[0]!);
    assert.ok(start >= 0, 'missing B1 expand migration head');
    assert.deepEqual(tsFiles.slice(start, start + b1Chain.length), b1Chain);

    const previous = tsFiles.indexOf(PREVIOUS_DISK_HEAD);
    assert.ok(previous >= 0, `missing previous disk head ${PREVIOUS_DISK_HEAD}`);
    for (const file of OAUTH_MIGRATION_FILES) {
      assert.ok(names.includes(file), `missing T-02 migration ${file}`);
      assert.ok(tsFiles.indexOf(file) > previous, `${file} must sort after ${PREVIOUS_DISK_HEAD}`);
      assert.ok(tsFiles.indexOf(file) > start + b1Chain.length - 1, `${file} must not splice into B1+MFA`);
    }
    assert.deepEqual(
      tsFiles.slice(previous + 1, previous + 1 + OAUTH_MIGRATION_FILES.length),
      [...OAUTH_MIGRATION_FILES],
      'T-02 must sit immediately after the previous disk head (later backfills may follow)',
    );

    // Know-N's frozen decision contract JSON is not shipped here; B1_MIGRATION_FILES
    // is the in-package frozen list (tests/EXTRACTION.md).
  });

  test('exports up/down and refuses destructive down while rows remain', async () => {
    for (const file of OAUTH_MIGRATION_FILES) {
      const source = await readFile(new URL(file, MIGRATIONS_DIR), 'utf8');
      assert.match(source, /export async function up/);
      assert.match(source, /export async function down/);
      assert.match(source, /export const migration/);
      assert.match(source, /down refused/);
      assert.match(source, /RAISE EXCEPTION/);
      assert.match(source, /count\(\*\)/);
    }
  });

  test('never drops or alters legacy or B1 tables except the 1.7 auth_accounts.issuer add', async () => {
    const sources = await Promise.all(
      OAUTH_MIGRATION_FILES.map(async (file) => readFile(new URL(file, MIGRATIONS_DIR), 'utf8')),
    );
    const all = sources.join('\n');

    for (const table of FORBIDDEN_LEGACY_TABLES) {
      assert.doesNotMatch(all, new RegExp(`DROP\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?["\`]?${table}\\b`, 'i'));
      assert.doesNotMatch(all, new RegExp(`ALTER\\s+TABLE\\s+["\`]?${table}\\b`, 'i'));
    }

    for (const source of sources) {
      for (const match of source.matchAll(ALTER_OR_DROP_TABLE)) {
        const table = (match[1] ?? match[2] ?? '').replaceAll('"', '');
        const statement = match[0] ?? '';
        const after = source.slice(match.index ?? 0, (match.index ?? 0) + 400);
        if ((FORBIDDEN_LEGACY_TABLES as readonly string[]).includes(table)) {
          assert.fail(`${statement} must never target legacy ${table}`);
        }
        if (!(B1_FOUR_TABLES as readonly string[]).includes(table)) continue;
        if (table !== ISSUER_WHITELIST_TABLE) {
          assert.fail(`T-02 must not ${statement} (only ${ISSUER_WHITELIST_TABLE}.${ISSUER_WHITELIST_COLUMN} is whitelisted)`);
        }
        assert.match(
          after,
          new RegExp(`["']?${ISSUER_WHITELIST_COLUMN}["']?`, 'i'),
          `auth_accounts ALTER/DROP must mention only the ${ISSUER_WHITELIST_COLUMN} column`,
        );
        assert.doesNotMatch(statement, /DROP\s+TABLE/i, 'T-02 must never DROP TABLE auth_accounts');
      }
    }
  });

  test('transcribes the T-01 issuer backfill and P2 oauth table names', async () => {
    const source = await readFile(new URL(OAUTH_MIGRATION_FILES[0]!, MIGRATIONS_DIR), 'utf8');
    assert.match(source, /ADD COLUMN "issuer"/);
    assert.match(source, /local:credential/);
    assert.match(source, /local:oauth:/);
    assert.match(source, /https:\/\/accounts\.google\.com/);
    assert.match(source, /auth_accounts_issuer_accountId_uidx/);
    assert.match(source, /SET NOT NULL/);
    for (const table of OAUTH_TABLES) {
      assert.ok(source.includes(`CREATE TABLE "${table}"`), `must create ${table}`);
    }
    assert.doesNotMatch(source, /CREATE TABLE (auth_users|auth_sessions|auth_verifications)\b/);
    assert.doesNotMatch(source, /npx auth migrate|auth generate/);
  });
});
