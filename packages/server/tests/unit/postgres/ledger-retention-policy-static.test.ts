import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'vitest';

const sourceUrl = new URL(
  '../../../src/infrastructure/database/ledger-retention-policy.ts', import.meta.url,
);
const authorityUrl = new URL(
  '../../../src/infrastructure/database/ledger-append-authority.ts', import.meta.url,
);

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

  // Know-N's `scripts/ledger-retention-policy.ts` catalog CLI and ADR 0023 are
  // not shipped with this package (tests/EXTRACTION.md), so their contracts
  // are not asserted here. The deletion-authority invariant above is the
  // runtime part and stays.
});
