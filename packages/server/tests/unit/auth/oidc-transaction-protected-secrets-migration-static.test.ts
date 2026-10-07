/**
 * Static contract for expand-only OIDC transaction protected-secret columns.
 */
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { describe, test } from 'vitest';

const MIGRATIONS_DIR = new URL('../../../migrations/', import.meta.url);
const PROTECTED_SECRETS_MIGRATION = '202607222100_oidc_transaction_protected_secrets.ts';
const IDENTITY_LIFECYCLE_MIGRATION = '202607221700_identity_lifecycle.ts';

const EXPAND_COLUMNS = [
  'state_hash',
  'nonce_hash',
  'pkce_verifier_ciphertext',
  'encryption_key_id',
  'encryption_key_version',
  'dual_read_status',
] as const;

const PLAINTEXT_COLUMNS = ['state', 'nonce', 'code_verifier'] as const;

describe('OIDC transaction protected secrets migration static contract', () => {
  test('expand migration adds protected columns without dropping plaintext secrets', async () => {
    const names = (await readdir(MIGRATIONS_DIR))
      .filter((name) => name.endsWith('.ts') && !name.endsWith('.d.ts'))
      .sort();
    assert.ok(
      names.includes(PROTECTED_SECRETS_MIGRATION),
      `missing ${PROTECTED_SECRETS_MIGRATION}`,
    );
    assert.ok(
      names.includes(IDENTITY_LIFECYCLE_MIGRATION),
      `missing baseline ${IDENTITY_LIFECYCLE_MIGRATION}`,
    );
    assert.ok(
      names.indexOf(PROTECTED_SECRETS_MIGRATION) > names.indexOf(IDENTITY_LIFECYCLE_MIGRATION),
      'protected secrets expand must sort after identity lifecycle',
    );

    const source = await readFile(new URL(PROTECTED_SECRETS_MIGRATION, MIGRATIONS_DIR), 'utf8');
    assert.match(source, /export async function up/);
    assert.match(source, /export async function down/);
    assert.match(source, /export const migration|export default migration/);
    assert.match(source, /oidc_login_transactions/);
    assert.match(source, /ADD COLUMN/i);
    assert.match(source, /DROP COLUMN/i);

    for (const column of EXPAND_COLUMNS) {
      assert.match(source, new RegExp(`\\b${column}\\b`), `missing expand column ${column}`);
    }

    // Expand-only: must not drop or rewrite plaintext secret columns.
    assert.doesNotMatch(source, /DROP COLUMN\s+(IF EXISTS\s+)?(state|nonce|code_verifier)\b/i);
    assert.doesNotMatch(source, /ALTER COLUMN\s+(state|nonce|code_verifier)\s+DROP NOT NULL/i);
    assert.doesNotMatch(source, /DROP TABLE\s+(IF EXISTS\s+)?oidc_login_transactions\b/i);

    // Ciphertext is binary; dual-read status constrained to known labels.
    assert.match(source, /pkce_verifier_ciphertext\s+bytea/i);
    assert.match(source, /'plaintext'\s*,\s*'dual'\s*,\s*'protected'|IN\s*\(\s*'plaintext'/i);
    assert.match(source, /CREATE UNIQUE INDEX\s+oidc_login_transactions_state_hash_unique/i);
    assert.match(source, /WHERE\s+state_hash\s+IS\s+NOT\s+NULL/i);

    // Baseline lifecycle still owns plaintext table create; expand must not recreate it.
    const lifecycle = await readFile(new URL(IDENTITY_LIFECYCLE_MIGRATION, MIGRATIONS_DIR), 'utf8');
    for (const column of PLAINTEXT_COLUMNS) {
      assert.match(lifecycle, new RegExp(`\\b${column}\\b`));
    }
    for (const column of EXPAND_COLUMNS) {
      assert.doesNotMatch(
        lifecycle,
        new RegExp(`\\b${column}\\b`),
        `lifecycle migration must not already define ${column}`,
      );
    }

    assert.doesNotMatch(
      source,
      /CREATE TABLE\s+(publications|sync_sessions|subscriptions|attachments)\b/i,
      'protected secrets migration must not create future-phase tables',
    );
  });

  test('down is rollback-safe for expand columns only', async () => {
    const source = await readFile(new URL(PROTECTED_SECRETS_MIGRATION, MIGRATIONS_DIR), 'utf8');
    const downMatch = source.match(/export async function down[\s\S]*?(?=export const migration|export default migration|$)/);
    assert.ok(downMatch, 'expected down function body');
    const down = downMatch[0];
    for (const column of EXPAND_COLUMNS) {
      assert.match(down, new RegExp(`DROP COLUMN IF EXISTS ${column}`));
    }
    assert.doesNotMatch(down, /DROP COLUMN IF EXISTS (state|nonce|code_verifier)\b/);
    assert.match(down, /DROP INDEX IF EXISTS oidc_login_transactions_state_hash_unique/);
  });
});
