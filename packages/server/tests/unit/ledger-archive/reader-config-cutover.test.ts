import assert from 'node:assert/strict';
import { test } from 'vitest';

import { loadLedgerArchiveReaderRuntimeConfig } from '../../../src/bootstrap/config-ledger-archive-reader.js';
import { createLedgerArchiveObjectReader } from '../../../src/bootstrap/ledger-archive-reader-composition.js';

test('production cutover reader config neither requires nor loads writer credentials', () => {
  const environment = {
    LEDGER_ARCHIVE_READ_ENABLED: 'true', LEDGER_ARCHIVE_STORE: 's3',
    LEDGER_ARCHIVE_S3_ENDPOINT: 'https://objects.example.test',
    LEDGER_ARCHIVE_S3_REGION: 'auto', LEDGER_ARCHIVE_BUCKET: 'archive',
    LEDGER_ARCHIVE_S3_READER_ACCESS_KEY_ID: 'reader-id',
    LEDGER_ARCHIVE_S3_READER_SECRET_ACCESS_KEY: 'reader-secret',
  };
  const config = loadLedgerArchiveReaderRuntimeConfig(environment, 'production');
  assert.equal(config.storage?.kind, 's3');
  assert.doesNotThrow(() => createLedgerArchiveObjectReader(config));
  assert.equal('writerCredential' in config.storage!, false);
});

test('production cutover reader refuses filesystem configuration', () => {
  assert.throws(() => loadLedgerArchiveReaderRuntimeConfig({
    LEDGER_ARCHIVE_READ_ENABLED: 'true', LEDGER_ARCHIVE_STORE: 'filesystem',
    LEDGER_ARCHIVE_FILESYSTEM_ROOT: '/tmp/archive', LEDGER_ARCHIVE_KMS_KEY_ID: 'kms:key',
  }, 'production'), /forbidden in production/u);
});
