import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'vitest';
import { LEDGER_CAPACITY_TARGETS } from '../../../src/infrastructure/database/ledger-capacity.js';
import { ledgerAuthorityRegistryDigest } from '../../../src/infrastructure/ledger-archive/ledger-authority-registry.js';

const sourceUrl = new URL(
  '../../../src/infrastructure/database/ledger-retention-policy.ts', import.meta.url,
);
const authorityUrl = new URL(
  '../../../src/infrastructure/database/ledger-append-authority.ts', import.meta.url,
);
const databaseIndexUrl = new URL('../../../src/infrastructure/database/index.ts', import.meta.url);
const cliUrl = new URL('../../../scripts/ledger-retention-policy.ts', import.meta.url);
const decisionUrl = new URL('../../../docs/adr/0023-ledger-retention-policy.md', import.meta.url);
const packageUrl = new URL('../../../package.json', import.meta.url);

describe('ledger retention policy static contract', () => {
  test('policy owns the complete named eligibility-gate vocabulary', async () => {
    const [source, authority] = await Promise.all([
      readFile(sourceUrl, 'utf8'), readFile(authorityUrl, 'utf8'),
    ]);
    for (const gate of [
      'terminal', 'protocol_watermark', 'no_fk_or_live_reference', 'archive_verified',
      'restore_test_passed', 'legal_hold_clear', 'pitr_backup_aligned',
      'reader_cutover_complete', 'explicit_deletion_approval',
    ]) assert.match(source, new RegExp(`'${gate}'`, 'u'));
    assert.match(authority, /sourceDeletionAuthorized: false/g);
    assert.doesNotMatch(authority, /sourceDeletionAuthorized: true/u);
  });

  test('CLI is catalog-only and package exposes the evidence command', async () => {
    const [cli, databaseIndex, packageSource] = await Promise.all([
      readFile(cliUrl, 'utf8'), readFile(databaseIndexUrl, 'utf8'), readFile(packageUrl, 'utf8'),
    ]);
    assert.doesNotMatch(cli, /\bpg\b|DATABASE_URL|DELETE\s+FROM|TRUNCATE|fetch\s*\(/iu);
    assert.match(databaseIndex, /LEDGER_RETENTION_POLICIES/u);
    assert.match(databaseIndex, /validateLedgerRetentionPolicies/u);
    const packageJson = JSON.parse(packageSource) as { scripts: Record<string, string> };
    assert.equal(packageJson.scripts['db:ledger-retention-policy'],
      'node --import tsx scripts/ledger-retention-policy.ts');
  });

  test('decision record separates capacity alarms from deletion approval', async () => {
    const decision = await readFile(decisionUrl, 'utf8');
    for (const target of LEDGER_CAPACITY_TARGETS) {
      assert.match(decision, new RegExp(`\`${target.tableName}\``, 'u'), target.tableName);
    }
    assert.match(decision, new RegExp(ledgerAuthorityRegistryDigest(), 'u'));
    assert.match(decision, /archive control plane/iu);
    assert.match(decision, /source deletion.*false/iu);
  });
});
