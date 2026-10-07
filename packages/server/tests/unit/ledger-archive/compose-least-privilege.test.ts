import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';

import {
  loadLedgerArchiveRuntimeConfig,
  sanitizeLedgerArchiveRuntimeConfig,
} from '../../../src/bootstrap/config-ledger-archive.js';
import {
  loadLedgerArchiveReaderRuntimeConfig,
  sanitizeLedgerArchiveReaderRuntimeConfig,
} from '../../../src/bootstrap/config-ledger-archive-reader.js';

const COMPOSE = new URL('../../../../devops/docker-compose.yml', import.meta.url);

test('compose isolates writer credentials on the worker anchor', async () => {
  const compose = await readFile(COMPOSE, 'utf8');
  const reader = section(compose, 'x-ledger-archive-reader:', 'x-ledger-archive-worker:');
  const worker = section(compose, 'x-ledger-archive-worker:', 'services:');
  const backend = section(compose, 'x-backend-env:', 'x-ledger-archive-reader:');
  assert.match(reader, /LEDGER_ARCHIVE_READ_ENABLED: "\$\{LEDGER_ARCHIVE_READ_ENABLED:-false\}"/u);
  assert.match(worker, /LEDGER_ARCHIVE_WORKER_ENABLED: "\$\{LEDGER_ARCHIVE_WORKER_ENABLED:-false\}"/u);
  assert.doesNotMatch(reader, /WRITER/u);
  assert.doesNotMatch(backend, /LEDGER_ARCHIVE_/u);
  assert.match(worker, /LEDGER_ARCHIVE_S3_WRITER_ACCESS_KEY_ID/u);
  assert.match(worker, /LEDGER_ARCHIVE_SPOOL_DIR/u);
  assert.match(compose, /<<: \[\*backend-env, \*ledger-archive-reader\]/u);
  assert.match(compose, /<<: \[\*backend-env, \*ledger-archive-reader, \*ledger-archive-worker\]/u);
  assert.match(compose, /ledger_archive_spool:\/var\/lib\/known\/ledger-archive-spool/u);
});

test('four runtime shapes keep API reader-only and reject shared production credentials', async () => {
  const disabledReader = loadLedgerArchiveReaderRuntimeConfig({}, 'production');
  const disabledWorker = loadLedgerArchiveRuntimeConfig({}, 'production');
  assert.equal(disabledReader.enabled, false);
  assert.equal(disabledWorker.enabled, false);

  const readerOnly = loadLedgerArchiveReaderRuntimeConfig(readerS3(), 'production');
  assert.equal(readerOnly.enabled, true);
  assert.equal(readerOnly.storage && 'writerCredential' in readerOnly.storage, false);
  const workerOff = loadLedgerArchiveRuntimeConfig({
    ...readerS3(), LEDGER_ARCHIVE_WORKER_ENABLED: 'false',
  }, 'production');
  assert.equal(workerOff.enabled, false);
  assert.equal(workerOff.storage, null);

  const workerOnly = loadLedgerArchiveRuntimeConfig(workerS3(), 'production');
  assert.equal(workerOnly.enabled, true);
  assert.equal(workerOnly.storage?.kind, 's3');

  const bothReader = loadLedgerArchiveReaderRuntimeConfig({
    ...readerS3(), ...workerS3(), LEDGER_ARCHIVE_READ_ENABLED: 'true',
  }, 'production');
  const bothWorker = loadLedgerArchiveRuntimeConfig({
    ...readerS3(), ...workerS3(), LEDGER_ARCHIVE_READ_ENABLED: 'true',
  }, 'production');
  assert.equal(bothReader.enabled, true);
  assert.equal(bothWorker.enabled, true);
  assert.throws(() => loadLedgerArchiveRuntimeConfig({
    ...workerS3(),
    LEDGER_ARCHIVE_S3_WRITER_ACCESS_KEY_ID: workerS3().LEDGER_ARCHIVE_S3_READER_ACCESS_KEY_ID,
  }, 'production'), /credentials must be distinct/u);

  const sanitized = JSON.stringify({
    reader: sanitizeLedgerArchiveReaderRuntimeConfig(bothReader),
    worker: sanitizeLedgerArchiveRuntimeConfig(bothWorker),
  });
  for (const secret of [
    'reader-access-ok', 'reader-secret-ok', 'writer-access-ok', 'writer-secret-ok',
    'account.r2.cloudflarestorage.com',
  ]) assert.equal(sanitized.includes(secret), false);
});

test('archive credentials accept Docker secret files and reject inline plus file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'known-archive-secret-'));
  const access = join(root, 'access');
  const secret = join(root, 'secret');
  await writeFile(access, 'file-reader-access\n');
  await writeFile(secret, 'file-reader-secret\n');
  const config = loadLedgerArchiveReaderRuntimeConfig({
    LEDGER_ARCHIVE_READ_ENABLED: 'true',
    LEDGER_ARCHIVE_STORE: 's3',
    LEDGER_ARCHIVE_S3_ENDPOINT: 'https://account.r2.cloudflarestorage.com',
    LEDGER_ARCHIVE_S3_REGION: 'auto',
    LEDGER_ARCHIVE_BUCKET: 'known-private-archive',
    LEDGER_ARCHIVE_S3_READER_ACCESS_KEY_ID_FILE: access,
    LEDGER_ARCHIVE_S3_READER_SECRET_ACCESS_KEY_FILE: secret,
  }, 'production');
  assert.deepEqual(config.storage && 'readerCredential' in config.storage
    ? config.storage.readerCredential : undefined, {
    accessKeyId: 'file-reader-access',
    secretAccessKey: 'file-reader-secret',
  });
  assert.throws(() => loadLedgerArchiveReaderRuntimeConfig({
    ...readerS3(),
    LEDGER_ARCHIVE_S3_READER_ACCESS_KEY_ID_FILE: access,
  }, 'production'), /cannot both be set/u);
});

function section(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + 1);
  assert.ok(from >= 0 && to > from, `missing ${start} .. ${end}`);
  return source.slice(from, to);
}

function readerS3(): NodeJS.ProcessEnv & Record<string, string> {
  return {
    LEDGER_ARCHIVE_READ_ENABLED: 'true',
    LEDGER_ARCHIVE_STORE: 's3',
    LEDGER_ARCHIVE_S3_ENDPOINT: 'https://account.r2.cloudflarestorage.com',
    LEDGER_ARCHIVE_S3_REGION: 'auto',
    LEDGER_ARCHIVE_BUCKET: 'known-private-archive',
    LEDGER_ARCHIVE_S3_READER_ACCESS_KEY_ID: 'reader-access-ok',
    LEDGER_ARCHIVE_S3_READER_SECRET_ACCESS_KEY: 'reader-secret-ok',
  };
}

function workerS3(): NodeJS.ProcessEnv & Record<string, string> {
  return {
    LEDGER_ARCHIVE_WORKER_ENABLED: 'true',
    LEDGER_ARCHIVE_STORE: 's3',
    LEDGER_ARCHIVE_SPOOL_DIR: '/var/lib/known/ledger-archive-spool',
    LEDGER_ARCHIVE_KMS_KEY_ID: 'kms:known:ledger-archive-v1',
    LEDGER_ARCHIVE_S3_ENDPOINT: 'https://account.r2.cloudflarestorage.com',
    LEDGER_ARCHIVE_S3_REGION: 'auto',
    LEDGER_ARCHIVE_BUCKET: 'known-private-archive',
    LEDGER_ARCHIVE_S3_READER_ACCESS_KEY_ID: 'reader-access-ok',
    LEDGER_ARCHIVE_S3_READER_SECRET_ACCESS_KEY: 'reader-secret-ok',
    LEDGER_ARCHIVE_S3_WRITER_ACCESS_KEY_ID: 'writer-access-ok',
    LEDGER_ARCHIVE_S3_WRITER_SECRET_ACCESS_KEY: 'writer-secret-ok',
  };
}
