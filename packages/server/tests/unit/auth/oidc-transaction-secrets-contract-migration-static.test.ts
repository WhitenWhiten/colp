/**
 * Static contract for OIDC transaction protected-secrets contract migration.
 * Contract drops plaintext secret columns and requires protected material.
 */
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { describe, test } from 'vitest';

const MIGRATIONS_DIR = new URL('../../../migrations/', import.meta.url);
const EXPAND_MIGRATION = '202607222100_oidc_transaction_protected_secrets.ts';
const CONTRACT_MIGRATION = '202607222200_oidc_transaction_secrets_contract.ts';

const PLAINTEXT_SECRET_COLUMNS = ['state', 'nonce', 'code_verifier'] as const;
const REQUIRED_PROTECTED_COLUMNS = [
  'state_hash',
  'nonce_hash',
  'pkce_verifier_ciphertext',
  'encryption_key_id',
  'encryption_key_version',
] as const;

describe('OIDC transaction secrets contract migration static contract', () => {
  test('contract migration drops plaintext secrets after expand and requires protected columns', async () => {
    const names = (await readdir(MIGRATIONS_DIR))
      .filter((name) => name.endsWith('.ts') && !name.endsWith('.d.ts'))
      .sort();
    assert.ok(names.includes(EXPAND_MIGRATION), `missing ${EXPAND_MIGRATION}`);
    assert.ok(names.includes(CONTRACT_MIGRATION), `missing ${CONTRACT_MIGRATION}`);
    assert.ok(
      names.indexOf(CONTRACT_MIGRATION) > names.indexOf(EXPAND_MIGRATION),
      'contract must sort after expand',
    );

    const source = await readFile(new URL(CONTRACT_MIGRATION, MIGRATIONS_DIR), 'utf8');
    assert.match(source, /export async function up/);
    assert.match(source, /export async function down/);
    assert.match(source, /export const migration|export default migration/);
    assert.match(source, /oidc_login_transactions/);

    // Active legacy callbacks must block contract; only expired rows may be deleted.
    assert.match(source, /expires_at\s*>\s*current_timestamp/i);
    assert.match(source, /RAISE EXCEPTION/i);
    assert.match(source, /DELETE FROM oidc_login_transactions/i);
    assert.match(source, /expires_at\s*<=\s*current_timestamp/i);
    assert.match(source, /state_hash IS NULL/i);
    assert.match(source, /nonce_hash IS NULL/i);
    assert.match(source, /pkce_verifier_ciphertext IS NULL/i);

    for (const column of PLAINTEXT_SECRET_COLUMNS) {
      assert.match(
        source,
        new RegExp(`DROP COLUMN IF EXISTS ${column}`, 'i'),
        `contract must drop plaintext column ${column}`,
      );
    }
    assert.match(source, /DROP COLUMN IF EXISTS dual_read_status/i);

    for (const column of REQUIRED_PROTECTED_COLUMNS) {
      assert.match(
        source,
        new RegExp(`ALTER COLUMN ${column} SET NOT NULL`, 'i'),
        `contract must require ${column}`,
      );
    }

    assert.match(source, /PRIMARY KEY\s*\(\s*state_hash\s*\)/i);
    assert.match(source, /DROP INDEX IF EXISTS oidc_login_transactions_state_hash_unique/i);

    // Expand must remain expand-only (does not drop plaintext).
    const expand = await readFile(new URL(EXPAND_MIGRATION, MIGRATIONS_DIR), 'utf8');
    assert.doesNotMatch(expand, /DROP COLUMN\s+(IF EXISTS\s+)?(state|nonce|code_verifier)\b/i);

    assert.doesNotMatch(
      source,
      /CREATE TABLE\s+(publications|sync_sessions|subscriptions|attachments)\b/i,
      'contract migration must not create future-phase tables',
    );
  });

  test('down restores expand-window plaintext columns and nullable protected fields', async () => {
    const source = await readFile(new URL(CONTRACT_MIGRATION, MIGRATIONS_DIR), 'utf8');
    const downMatch = source.match(
      /export async function down[\s\S]*?(?=export const migration|export default migration|$)/,
    );
    assert.ok(downMatch, 'expected down function body');
    const down = downMatch[0];

    for (const column of PLAINTEXT_SECRET_COLUMNS) {
      assert.match(down, new RegExp(`ADD COLUMN ${column}\\b`, 'i'));
    }
    assert.match(down, /ADD COLUMN dual_read_status\b/i);
    assert.match(down, /ALTER COLUMN state_hash DROP NOT NULL/i);
    assert.match(down, /PRIMARY KEY\s*\(\s*state\s*\)/i);
    assert.match(down, /CREATE UNIQUE INDEX oidc_login_transactions_state_hash_unique/i);
  });
});
