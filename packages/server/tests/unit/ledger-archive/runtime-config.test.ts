import assert from 'node:assert/strict';
import { test } from 'vitest';

import {
  loadLedgerArchiveRuntimeConfig,
  sanitizeLedgerArchiveRuntimeConfig,
} from '../../../src/bootstrap/config-ledger-archive.js';
import { composeLedgerArchiveWorker } from '../../../src/bootstrap/ledger-archive-worker-composition.js';

test('archive worker defaults off without resolving storage credentials', () => {
  const config = loadLedgerArchiveRuntimeConfig({}, 'production');
  assert.equal(config.enabled, false);
  assert.equal(config.storage, null);
});

test('production archive config requires S3/R2 and distinct reader/writer credentials', () => {
  assert.throws(() => loadLedgerArchiveRuntimeConfig({
    LEDGER_ARCHIVE_WORKER_ENABLED: 'true',
    LEDGER_ARCHIVE_STORE: 'filesystem',
    LEDGER_ARCHIVE_SPOOL_DIR: '/var/spool/known-archive',
    LEDGER_ARCHIVE_FILESYSTEM_ROOT: '/var/lib/known-archive',
    LEDGER_ARCHIVE_KMS_KEY_ID: 'kms:archive',
  }, 'production'), /filesystem is forbidden/u);

  const base = s3Env();
  assert.throws(() => loadLedgerArchiveRuntimeConfig({
    ...base,
    LEDGER_ARCHIVE_S3_WRITER_ACCESS_KEY_ID: base.LEDGER_ARCHIVE_S3_READER_ACCESS_KEY_ID,
  }, 'production'), /credentials must be distinct/u);
  assert.throws(() => loadLedgerArchiveRuntimeConfig({
    ...base,
    LEDGER_ARCHIVE_S3_WRITER_SECRET_ACCESS_KEY: undefined,
  }, 'production'), /LEDGER_ARCHIVE_S3_WRITER_SECRET_ACCESS_KEY is required/u);
});

test('sanitized archive capacity excludes endpoint, KMS and both credentials', () => {
  const env = s3Env();
  const sanitized = sanitizeLedgerArchiveRuntimeConfig(loadLedgerArchiveRuntimeConfig(env, 'production'));
  const serialized = JSON.stringify(sanitized);
  assert.deepEqual({
    enabled: sanitized.enabled,
    storageKind: sanitized.storageKind,
    bucket: sanitized.bucket,
    concurrency: sanitized.concurrency,
  }, { enabled: true, storageKind: 's3', bucket: 'known-private-archive', concurrency: 1 });
  for (const secret of [
    env.LEDGER_ARCHIVE_S3_ENDPOINT,
    env.LEDGER_ARCHIVE_KMS_KEY_ID,
    env.LEDGER_ARCHIVE_S3_READER_ACCESS_KEY_ID,
    env.LEDGER_ARCHIVE_S3_READER_SECRET_ACCESS_KEY,
    env.LEDGER_ARCHIVE_S3_WRITER_ACCESS_KEY_ID,
    env.LEDGER_ARCHIVE_S3_WRITER_SECRET_ACCESS_KEY,
  ]) assert.equal(serialized.includes(secret), false);
});

test('enabled composition uses the per-segment production resolver without scope env', () => {
  const config = loadLedgerArchiveRuntimeConfig({
    LEDGER_ARCHIVE_WORKER_ENABLED: 'true',
    LEDGER_ARCHIVE_STORE: 'filesystem',
    LEDGER_ARCHIVE_FILESYSTEM_ROOT: '/tmp/known-archive-objects',
    LEDGER_ARCHIVE_SPOOL_DIR: '/tmp/known-archive-spool',
    LEDGER_ARCHIVE_KMS_KEY_ID: 'dev:key',
  }, 'test');
  assert.ok(composeLedgerArchiveWorker({ config, database: { db: {} } as never }));
});

function s3Env(): NodeJS.ProcessEnv & Record<string, string> {
  return {
    LEDGER_ARCHIVE_WORKER_ENABLED: 'true',
    LEDGER_ARCHIVE_STORE: 'r2',
    LEDGER_ARCHIVE_SPOOL_DIR: '/var/spool/known-archive',
    LEDGER_ARCHIVE_KMS_KEY_ID: 'kms:archive-prod',
    LEDGER_ARCHIVE_S3_ENDPOINT: 'https://account.r2.cloudflarestorage.com',
    LEDGER_ARCHIVE_S3_REGION: 'auto',
    LEDGER_ARCHIVE_BUCKET: 'known-private-archive',
    LEDGER_ARCHIVE_S3_READER_ACCESS_KEY_ID: 'reader-access',
    LEDGER_ARCHIVE_S3_READER_SECRET_ACCESS_KEY: 'reader-secret',
    LEDGER_ARCHIVE_S3_WRITER_ACCESS_KEY_ID: 'writer-access',
    LEDGER_ARCHIVE_S3_WRITER_SECRET_ACCESS_KEY: 'writer-secret',
  };
}
