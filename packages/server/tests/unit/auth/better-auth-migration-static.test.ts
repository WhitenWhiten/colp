import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { describe, test } from 'vitest';

const MIGRATIONS_DIR = new URL('../../../migrations/', import.meta.url);
const CONTRACT_URL = new URL(
  '../../../../docs/decisions/better-auth/better-auth-migration-contract.json',
  import.meta.url,
);

const NEW_MIGRATION_FILES = [
  '202609050900_better_auth_schema.ts',
  '202609050910_better_auth_account_mapping.ts',
  '202609050920_known_auth_session_metadata.ts',
  '202609050930_legacy_oidc_identity_archive.ts',
] as const;

/** C4 additive MFA expand migration (newest entry of the chain; outside the frozen G1 contract). */
const C4_MFA_MIGRATION_FILE = '202609051000_better_auth_mfa_schema.ts' as const;

/** T-09 redundant-index cleanup (2026-08-27 performance audit, IDX-08). */
const T09_CLEANUP_MIGRATION_FILE = '202609260500_drop_redundant_indexes.ts' as const;

/** Legacy business tables that B1 must never DROP/ALTER (ADR §13 down rule). */
const FORBIDDEN_LEGACY_TABLES = ['accounts', 'sessions', 'account_identities'] as const;

describe('B1 Better Auth expand migration static contract', () => {
  test('commits the four frozen expand migrations plus the C4 MFA expand as a contiguous chain', async () => {
    const names = await readdir(MIGRATIONS_DIR);
    for (const file of [...NEW_MIGRATION_FILES, C4_MFA_MIGRATION_FILE]) {
      assert.ok(names.includes(file), `missing expand migration file ${file}`);
    }

    // The four B1 migrations are a contiguous G1 tail; C4 MFA is the next
    // filename after 202609050930 so MFA lands additively on the B1 head.
    // Later product migrations may follow; they must not splice into this chain.
    const tsFiles = names.filter((name) => name.endsWith('.ts')).sort();
    const chain = [...NEW_MIGRATION_FILES, C4_MFA_MIGRATION_FILE];
    const start = tsFiles.indexOf(NEW_MIGRATION_FILES[0]!);
    assert.ok(start >= 0, 'missing B1 expand migration head');
    assert.deepEqual(tsFiles.slice(start, start + chain.length), chain);

    // The filenames must match the frozen G1 contract (migrationPlan.expandMigrations).
    const contract = JSON.parse(await readFile(CONTRACT_URL, 'utf8')) as {
      migrationPlan: { expandMigrations: readonly string[] };
    };
    assert.deepEqual(contract.migrationPlan.expandMigrations, [...NEW_MIGRATION_FILES]);
  });

  test('never drops or alters legacy accounts/sessions/account_identities', async () => {
    const sources = await Promise.all(
      [...NEW_MIGRATION_FILES, C4_MFA_MIGRATION_FILE]
        .map(async (file) => readFile(new URL(file, MIGRATIONS_DIR), 'utf8')),
    );
    const all = sources.join('\n');

    for (const table of FORBIDDEN_LEGACY_TABLES) {
      assert.doesNotMatch(all, new RegExp(`DROP\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?["\`]?${table}\\b`, 'i'),
        `B1 must never DROP TABLE ${table}`);
      assert.doesNotMatch(all, new RegExp(`ALTER\\s+TABLE\\s+["\`]?${table}\\b`, 'i'),
        `B1 must never ALTER TABLE ${table}`);
    }

    // Any DROP statement in the four files may only target the new auth tables
    // and their indexes — never the forbidden legacy tables (quoted or not).
    const dropPattern = /\bDROP\s+(?:TABLE|INDEX)\s+(?:IF\s+EXISTS\s+)?(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/gi;
    const droppedIdentifiers: string[] = [];
    for (const source of sources) {
      for (const match of source.matchAll(dropPattern)) {
        droppedIdentifiers.push((match[1] ?? match[2] ?? '').toLowerCase());
      }
    }
    assert.ok(droppedIdentifiers.length > 0, 'B1 down migrations must drop their own tables/indexes');
    for (const identifier of droppedIdentifiers) {
      assert.ok(
        !(FORBIDDEN_LEGACY_TABLES as readonly string[]).includes(identifier),
        `B1 down must not drop legacy table ${identifier}`,
      );
    }
  });

  test('keeps each table in its own migration with a data-refusing down', async () => {
    const sources = new Map(
      await Promise.all(
        [...NEW_MIGRATION_FILES, C4_MFA_MIGRATION_FILE].map(async (file) => [
          file,
          await readFile(new URL(file, MIGRATIONS_DIR), 'utf8'),
        ] as const),
      ),
    );
    for (const [file, source] of sources) {
      assert.match(source, /export async function up/);
      assert.match(source, /export async function down/);
      assert.match(source, /export const migration/);
      // Every down refuses destructive drops while rows remain, with counts.
      assert.match(source, /down refused/);
      assert.match(source, /RAISE EXCEPTION/);
      assert.match(source, /count\(\*\)/);
    }

    const schema = sources.get(NEW_MIGRATION_FILES[0]) as string;
    for (const table of ['"auth_users"', '"auth_accounts"', '"auth_sessions"', '"auth_verifications"']) {
      assert.ok(schema.includes(`CREATE TABLE ${table}`), `better_auth_schema must create ${table}`);
    }
    assert.ok(schema.includes('"email" text NOT NULL UNIQUE'), 'auth_users.email must stay UNIQUE');
    assert.ok(schema.includes('"token" text NOT NULL UNIQUE'), 'auth_sessions.token must stay UNIQUE');
    assert.ok(schema.includes('"emailVerified" boolean NOT NULL'), 'auth_users.emailVerified NOT NULL');
    assert.ok(
      schema.includes('REFERENCES "auth_users" ("id") ON DELETE CASCADE'),
      'auth_sessions/auth_accounts must cascade from auth_users (spike artifact)',
    );
    assert.ok(
      schema.includes('CONSTRAINT auth_accounts_provider_account_unique UNIQUE ("providerId", "accountId")'),
      'B1 must close the G0 R5 gap: UNIQUE(providerId, accountId)',
    );
    assert.ok(schema.includes('auth_accounts_provider_account_idx'), 'B1 must add the provider composite index');
    for (const index of ['auth_sessions_userId_idx', 'auth_accounts_userId_idx', 'auth_verifications_identifier_idx']) {
      assert.ok(schema.includes(index), `missing generated index ${index}`);
    }
    // auth_verifications.identifier stays index-only (library contract, spike §4.2).
    assert.doesNotMatch(schema, /CREATE UNIQUE INDEX auth_verifications_identifier_idx/);

    const mapping = sources.get(NEW_MIGRATION_FILES[1]) as string;
    assert.ok(mapping.includes('CREATE TABLE auth_user_account_map'));
    assert.ok(mapping.includes('auth_user_id text PRIMARY KEY'), 'one auth user maps to at most one account');
    assert.ok(mapping.includes('auth_user_account_map_account_id_unique'), 'account UNIQUE (bidirectional 1:1)');
    assert.ok(mapping.includes('auth_user_account_map_auth_user_fk'));
    assert.ok(mapping.includes('auth_user_account_map_account_fk'));
    assert.ok(mapping.includes('ON DELETE CASCADE'));
    assert.ok(mapping.includes('ON DELETE RESTRICT'));

    const metadata = sources.get(NEW_MIGRATION_FILES[2]) as string;
    assert.ok(metadata.includes('CREATE TABLE known_auth_session_metadata'));
    for (const column of [
      'auth_session_id text PRIMARY KEY',
      'session_token_hash text NOT NULL',
      'account_id text NOT NULL',
      'idle_expires_at timestamptz NOT NULL',
      'absolute_expires_at timestamptz NOT NULL',
      'security_epoch bigint NOT NULL',
      'csrf_token_hash text NOT NULL',
      'predecessor_session_id text',
      'revoked_at timestamptz',
    ]) assert.ok(metadata.includes(column), `known_auth_session_metadata missing ${column}`);
    assert.ok(
      metadata.includes('known_auth_session_metadata_predecessor_session_id_unique'),
      'predecessor CAS partial unique index',
    );
    assert.ok(metadata.includes('WHERE predecessor_session_id IS NOT NULL'), 'predecessor index must be partial');
    assert.ok(metadata.includes('idle_expires_at <= absolute_expires_at'), 'idle must never exceed absolute');
    assert.ok(metadata.includes('security_epoch >= 0'));
    assert.ok(metadata.includes('ON DELETE SET NULL'), 'predecessor FK mirrors sessions.rotated_from_session_id');

    const archive = sources.get(NEW_MIGRATION_FILES[3]) as string;
    assert.ok(archive.includes('CREATE TABLE legacy_oidc_identity_archive'));

    const mfa = sources.get(C4_MFA_MIGRATION_FILE) as string;
    assert.ok(mfa.includes('CREATE TABLE "auth_two_factor"'), 'C4 MFA migration must create auth_two_factor');
    for (const column of [
      '"id" text PRIMARY KEY',
      '"secret" text NOT NULL',
      '"backupCodes" text NOT NULL',
      '"userId" text NOT NULL',
      'REFERENCES "auth_users" ("id") ON DELETE CASCADE',
      '"verified" boolean NOT NULL DEFAULT true',
      '"failedVerificationCount" integer NOT NULL DEFAULT 0',
      '"lockedUntil" timestamptz',
      '"createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP',
      '"updatedAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP',
    ]) assert.ok(mfa.includes(column), `auth_two_factor missing ${column}`);
    assert.ok(mfa.includes('CREATE INDEX "auth_two_factor_userId_idx"'), 'auth_two_factor userId lookup index');
    assert.ok(
      mfa.includes('ALTER TABLE "auth_users"\n    ADD COLUMN "twoFactorEnabled" boolean NOT NULL DEFAULT false'),
      'auth_users.twoFactorEnabled must be ADD-only with DEFAULT false (additive)',
    );
    // Additive contract: the MFA up creates ONLY auth_two_factor (plus the
    // one ADD COLUMN) and never touches the B1 tables or legacy tables.
    assert.doesNotMatch(mfa, /CREATE TABLE auth_(users|accounts|sessions|verifications)\b/);
    assert.doesNotMatch(mfa, /CREATE TABLE (auth_user_account_map|known_auth_session_metadata|legacy_oidc_identity_archive)\b/);
    assert.doesNotMatch(mfa, /ALTER TABLE ("?accounts|sessions|account_identities)"?\b/i);
    // The down is the only destructive part and targets only its own objects.
    assert.ok(mfa.includes('DROP COLUMN IF EXISTS "twoFactorEnabled"'), 'down drops only the added column');
    assert.ok(mfa.includes('DROP TABLE IF EXISTS "auth_two_factor"'), 'down drops only auth_two_factor');
    for (const column of [
      'issuer text NOT NULL',
      'subject text NOT NULL',
      'account_id text NOT NULL',
      'migration_source text NOT NULL',
      'email_verified_claim boolean NOT NULL',
      'migrated_at timestamptz NOT NULL DEFAULT now()',
      "retention_until timestamptz NOT NULL DEFAULT 'infinity'",
    ]) assert.ok(archive.includes(column), `legacy_oidc_identity_archive missing ${column}`);
    assert.ok(archive.includes('legacy_oidc_identity_archive_issuer_subject_unique'));

    // ADR §15 validation query 5, statically: the archive table definition may
    // not contain any token/secret/code/refresh column.
    const createTableBody = archive.match(/CREATE TABLE legacy_oidc_identity_archive\s*\(([\s\S]*?)\)\s*`/);
    assert.ok(createTableBody, 'archive CREATE TABLE must be extractable');
    assert.doesNotMatch(
      createTableBody[1],
      /(token|secret|code|refresh)/i,
      'legacy_oidc_identity_archive must not persist any token/secret/code/refresh column',
    );
  });

  test('T-09 cleanup drops only the two prefix-duplicate auth indexes and restores them on down', async () => {
    const source = await readFile(new URL(T09_CLEANUP_MIGRATION_FILE, MIGRATIONS_DIR), 'utf8');

    // Index-only cleanup: no table or constraint statement may appear, so the
    // frozen B1 tables (and the legacy tables) stay untouched by construction.
    assert.doesNotMatch(source, /DROP\s+TABLE/i);
    assert.doesNotMatch(source, /ALTER\s+TABLE/i);
    assert.doesNotMatch(source, /CREATE\s+TABLE/i);

    // The two auth drops are exactly the prefix duplicates: the provider
    // composite duplicates the R5 UNIQUE constraint's implicit index, and the
    // single-column identifier index duplicates the 202609260300 composite.
    assert.match(source, /DROP INDEX IF EXISTS auth_accounts_provider_account_idx/);
    assert.match(source, /DROP INDEX IF EXISTS auth_verifications_identifier_idx/);
    assert.doesNotMatch(source, /DROP INDEX IF EXISTS "?auth_verifications_identifier_created_idx/);
    assert.doesNotMatch(source, /DROP INDEX IF EXISTS "?auth_sessions_userId_idx/);
    assert.doesNotMatch(source, /DROP INDEX IF EXISTS "?auth_accounts_userId_idx/);

    // The developer-only down restores both originals verbatim (B1 shapes).
    assert.match(source, /CREATE INDEX auth_verifications_identifier_idx\s+ON "auth_verifications" \("identifier"\)/);
    assert.match(source, /CREATE INDEX auth_accounts_provider_account_idx\s+ON "auth_accounts" \("providerId", "accountId"\)/);
    assert.doesNotMatch(source, /CREATE UNIQUE INDEX/i);
  });

  test('keeps table ownership within the four files (no table created in the wrong migration)', async () => {
    const sources = await Promise.all(
      [...NEW_MIGRATION_FILES, C4_MFA_MIGRATION_FILE]
        .map(async (file) => readFile(new URL(file, MIGRATIONS_DIR), 'utf8')),
    );
    const [schema, mapping, metadata, archive] = sources;
    for (const foreign of ['auth_user_account_map', 'known_auth_session_metadata', 'legacy_oidc_identity_archive']) {
      assert.doesNotMatch(schema, new RegExp(`CREATE TABLE\\s+${foreign}\\b`), `900 must not create ${foreign}`);
    }
    for (const foreign of ['"auth_users"', '"auth_accounts"', '"auth_sessions"', '"auth_verifications"',
      'known_auth_session_metadata', 'legacy_oidc_identity_archive']) {
      assert.doesNotMatch(mapping, new RegExp(`CREATE TABLE\\s+${foreign.replaceAll('"', '')}\\b`),
        `910 must not create ${foreign}`);
    }
    for (const foreign of ['auth_user_account_map', 'legacy_oidc_identity_archive']) {
      assert.doesNotMatch(metadata, new RegExp(`CREATE TABLE\\s+${foreign}\\b`), `920 must not create ${foreign}`);
    }
    for (const foreign of ['auth_user_account_map', 'known_auth_session_metadata']) {
      assert.doesNotMatch(archive, new RegExp(`CREATE TABLE\\s+${foreign}\\b`), `930 must not create ${foreign}`);
    }

    // The C4 MFA migration owns ONLY auth_two_factor + the twoFactorEnabled
    // ADD COLUMN; it must not create any other table.
    const mfa = sources[4];
    for (const foreign of ['"auth_users"', '"auth_accounts"', '"auth_sessions"', '"auth_verifications"',
      'auth_user_account_map', 'known_auth_session_metadata', 'legacy_oidc_identity_archive']) {
      assert.doesNotMatch(mfa, new RegExp(`CREATE TABLE\\s+${foreign.replaceAll('"', '')}\\b`),
        `1000 must not create ${foreign}`);
    }
  });
});
