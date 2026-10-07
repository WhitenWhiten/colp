import assert from 'node:assert/strict';
import { test } from 'vitest';

import {
  loadLedgerArchiveReaderRuntimeConfig,
  sanitizeLedgerArchiveReaderRuntimeConfig,
} from '../../../src/bootstrap/config-ledger-archive-reader.js';
import { composeLedgerArchiveColdReaders } from '../../../src/bootstrap/ledger-archive-reader-composition.js';

test('archive reader defaults off and never resolves writer credentials', () => {
  const config = loadLedgerArchiveReaderRuntimeConfig({
    LEDGER_ARCHIVE_S3_WRITER_ACCESS_KEY_ID: 'writer-access-must-not-enter-reader',
    LEDGER_ARCHIVE_S3_WRITER_SECRET_ACCESS_KEY: 'writer-secret-must-not-enter-reader',
  }, 'production');
  assert.equal(config.enabled, false);
  assert.equal(config.storage, null);
  assert.equal(stringifyConfig(config).includes('writer-secret-must-not-enter-reader'), false);
  assert.equal(composeLedgerArchiveColdReaders({ config }), undefined);
});

test('production API reader needs only reader credentials and sanitization excludes secrets and endpoint', () => {
  const env = {
    LEDGER_ARCHIVE_READ_ENABLED: 'true',
    LEDGER_ARCHIVE_STORE: 's3',
    LEDGER_ARCHIVE_S3_ENDPOINT: 'https://archive.example.test',
    LEDGER_ARCHIVE_S3_REGION: 'auto',
    LEDGER_ARCHIVE_BUCKET: 'known-private-archive',
    LEDGER_ARCHIVE_S3_READER_ACCESS_KEY_ID: 'reader-access',
    LEDGER_ARCHIVE_S3_READER_SECRET_ACCESS_KEY: 'reader-secret',
    LEDGER_ARCHIVE_S3_WRITER_ACCESS_KEY_ID: 'ignored-writer-access',
    LEDGER_ARCHIVE_S3_WRITER_SECRET_ACCESS_KEY: 'ignored-writer-secret',
  } satisfies NodeJS.ProcessEnv;
  const config = loadLedgerArchiveReaderRuntimeConfig(env, 'production');
  assert.deepEqual(config.storage, {
    kind: 's3', endpoint: env.LEDGER_ARCHIVE_S3_ENDPOINT, region: 'auto',
    bucket: env.LEDGER_ARCHIVE_BUCKET,
    readerCredential: { accessKeyId: 'reader-access', secretAccessKey: 'reader-secret' },
  });
  const serializedConfig = stringifyConfig(config);
  assert.equal(serializedConfig.includes('ignored-writer'), false);
  const sanitized = JSON.stringify(sanitizeLedgerArchiveReaderRuntimeConfig(config));
  for (const sensitive of [env.LEDGER_ARCHIVE_S3_ENDPOINT, 'reader-access', 'reader-secret',
    'ignored-writer-access', 'ignored-writer-secret']) {
    assert.equal(sanitized.includes(sensitive), false);
  }
});

test('reader config fails closed on production filesystem, insecure S3, and unbounded ceilings', () => {
  assert.throws(() => loadLedgerArchiveReaderRuntimeConfig({
    LEDGER_ARCHIVE_READ_ENABLED: 'true', LEDGER_ARCHIVE_STORE: 'filesystem',
    LEDGER_ARCHIVE_FILESYSTEM_ROOT: '/tmp/archive', LEDGER_ARCHIVE_KMS_KEY_ID: 'dev:key',
  }, 'production'), /filesystem is forbidden/u);
  assert.throws(() => loadLedgerArchiveReaderRuntimeConfig({
    ...readerS3Env(), LEDGER_ARCHIVE_S3_ENDPOINT: 'http://archive.example.test',
  }, 'production'), /must use https/u);
  assert.throws(() => loadLedgerArchiveReaderRuntimeConfig({
    ...readerS3Env(), LEDGER_ARCHIVE_READ_MAX_CACHED_SEGMENTS: '17',
  }, 'production'), /must be <= 16/u);
  assert.throws(() => loadLedgerArchiveReaderRuntimeConfig({
    ...readerS3Env(), LEDGER_ARCHIVE_READ_MAX_CACHED_BYTES: String(256n * 1024n * 1024n),
  }, 'production'), /must be <=/u);
  assert.throws(() => loadLedgerArchiveReaderRuntimeConfig({
    ...readerS3Env(), LEDGER_ARCHIVE_READ_BYTE_CEILING: String(2n * 1024n * 1024n * 1024n + 1n),
  }, 'production'), /must be <=/u);
});

test('enabled composition requires a database and configured storage', () => {
  const config = loadLedgerArchiveReaderRuntimeConfig(readerS3Env(), 'production');
  assert.throws(() => composeLedgerArchiveColdReaders({ config }), /database_required/u);
  assert.throws(() => composeLedgerArchiveColdReaders({
    config: { ...config, storage: null }, database: { db: {} } as never,
  }), /storage_required/u);
});

test('reader cache defaults to a 64MiB shared budget and maps legacy aliases strictly', () => {
  const defaults = loadLedgerArchiveReaderRuntimeConfig({}, 'development');
  assert.equal(defaults.maxCachedBytes, 64n * 1024n * 1024n);
  assert.equal(defaults.maxBytesPerSegment, 16n * 1024n * 1024n);
  assert.equal(defaults.maxConcurrentLoads, 2);
  assert.deepEqual(defaults.deprecations, []);
  const aliased = loadLedgerArchiveReaderRuntimeConfig({
    LEDGER_ARCHIVE_READ_MAX_MATERIALIZED_BYTES: String(256n * 1024n * 1024n),
    LEDGER_ARCHIVE_READ_MAX_CACHED_SEGMENTS: '8',
  }, 'development');
  assert.equal(aliased.maxBytesPerSegment, 16n * 1024n * 1024n);
  assert.equal(aliased.maxCachedBytes, 64n * 1024n * 1024n);
  assert.ok(aliased.deprecations.includes('LEDGER_ARCHIVE_READ_MAX_MATERIALIZED_BYTES'));
  assert.ok(aliased.deprecations.includes('LEDGER_ARCHIVE_READ_MAX_CACHED_SEGMENTS'));
});

function readerS3Env(): NodeJS.ProcessEnv {
  return {
    LEDGER_ARCHIVE_READ_ENABLED: 'true',
    LEDGER_ARCHIVE_STORE: 's3',
    LEDGER_ARCHIVE_S3_ENDPOINT: 'https://archive.example.test',
    LEDGER_ARCHIVE_S3_REGION: 'auto',
    LEDGER_ARCHIVE_BUCKET: 'known-private-archive',
    LEDGER_ARCHIVE_S3_READER_ACCESS_KEY_ID: 'reader-access',
    LEDGER_ARCHIVE_S3_READER_SECRET_ACCESS_KEY: 'reader-secret',
  };
}

function stringifyConfig(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => typeof item === 'bigint' ? item.toString() : item);
}
