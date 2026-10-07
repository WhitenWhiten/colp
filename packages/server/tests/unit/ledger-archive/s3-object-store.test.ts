import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { test } from 'vitest';

import {
  createS3LedgerArchiveObjectStore,
  type S3CommandClient,
} from '../../../src/infrastructure/ledger-archive/s3-object-store.js';
import { LedgerArchiveObjectStoreError } from '../../../src/infrastructure/ledger-archive/object-store.js';

test('S3 adapter sends create-only PUT, encryption metadata, HEAD, and bounded GET', async () => {
  const bytes = Buffer.from('archive');
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const commands: unknown[] = [];
  const writer: S3CommandClient = { async send(command) { commands.push(command); return { ETag: '"provider"' }; } };
  const reader: S3CommandClient = { async send(command) {
    commands.push(command);
    const common = {
      ContentLength: bytes.byteLength, ETag: '"provider"',
      Metadata: {
        'ledger-archive-sha256': digest.slice(7), 'ledger-archive-kms-key-id': 'kms:key',
        'ledger-archive-schema': '1',
      },
    };
    return command instanceof GetObjectCommand ? { ...common, Body: chunks(bytes) } : common;
  } };
  const store = createS3LedgerArchiveObjectStore({
    endpoint: 'https://example.invalid', region: 'auto', bucket: 'known-archive',
    readerCredential: { accessKeyId: 'reader', secretAccessKey: 'reader-secret' },
    writerCredential: { accessKeyId: 'writer', secretAccessKey: 'writer-secret' },
    writerClient: writer, client: reader, kmsKeyId: 'kms:key', serverSideEncryption: 'aws:kms',
  });
  const key = `ledger-archives/v1/operations/scope/1-2-${digest.slice(7)}.jsonl`;
  await store.putCreateOnly({ key, body: chunks(bytes), byteLength: 7n, sha256: digest, kmsKeyId: 'kms:key' });
  const put = commands[0] as PutObjectCommand;
  assert.ok(put instanceof PutObjectCommand);
  assert.equal(put.input.IfNoneMatch, '*');
  assert.equal(put.input.ServerSideEncryption, 'aws:kms');
  assert.equal(put.input.Metadata?.['ledger-archive-sha256'], digest.slice(7));
  assert.ok((await store.head(key)) && commands[1] instanceof HeadObjectCommand);
  const object = await store.read({ key, byteCeiling: 10n });
  assert.ok(commands[2] instanceof GetObjectCommand);
  assert.deepEqual(Buffer.concat(await collect(object.body)), bytes);
});

test('S3 adapter classifies create conflict and missing/corrupt HEAD stably', async () => {
  const precondition: S3CommandClient = { async send() {
    throw Object.assign(new Error('precondition'), { $metadata: { httpStatusCode: 412 } });
  } };
  const options = {
    endpoint: 'https://example.invalid', region: 'auto', bucket: 'known-archive',
    readerCredential: { accessKeyId: 'reader', secretAccessKey: 'reader-secret' },
    writerCredential: { accessKeyId: 'writer', secretAccessKey: 'writer-secret' },
    writerClient: precondition, client: precondition,
  };
  const store = createS3LedgerArchiveObjectStore(options);
  const emptyDigest = `sha256:${createHash('sha256').update(Buffer.alloc(0)).digest('hex')}`;
  const key = `ledger-archives/v1/a/b/0-1-${emptyDigest.slice(7)}.jsonl`;
  await assert.rejects(() => store.putCreateOnly({
    key, body: chunks(Buffer.alloc(0)), byteLength: 0n,
    sha256: emptyDigest, kmsKeyId: 'kms:key',
  }), (error: unknown) => error instanceof LedgerArchiveObjectStoreError && error.failureClass === 'already_exists');
  const corrupt = createS3LedgerArchiveObjectStore({
    ...options,
    client: { async send() { return { ContentLength: 1, Metadata: {} }; } },
  });
  await assert.rejects(() => corrupt.head(key),
    (error: unknown) => error instanceof LedgerArchiveObjectStoreError && error.stableCode === 'archive_head_binding_missing');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => corrupt.head(key, controller.signal),
    (error: unknown) => error instanceof LedgerArchiveObjectStoreError && error.failureClass === 'aborted');
});

async function* chunks(value: Uint8Array): AsyncGenerator<Uint8Array> { yield value; }
async function collect(body: AsyncIterable<Uint8Array>): Promise<Buffer[]> {
  const result: Buffer[] = [];
  for await (const chunk of body) result.push(Buffer.from(chunk));
  return result;
}
