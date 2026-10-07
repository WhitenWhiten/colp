import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, truncate } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, test } from 'vitest';

import {
  createFilesystemLedgerArchiveObjectStore,
} from '../../../src/infrastructure/ledger-archive/filesystem-object-store.js';
import { LedgerArchiveObjectStoreError } from '../../../src/infrastructure/ledger-archive/object-store.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

test('filesystem adapter performs real create-only, bounded, content-addressed I/O', async () => {
  const root = await mkdtemp(join(tmpdir(), 'known-ledger-archive-'));
  roots.push(root);
  const store = createFilesystemLedgerArchiveObjectStore({ rootDirectory: root, kmsKeyId: 'dev:key' });
  const bytes = Buffer.from('immutable archive\n');
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const key = `ledger-archives/v1/operations/scope/1-2-${digest.slice(7)}.jsonl`;
  const identity = await store.putCreateOnly({
    key, body: chunks(bytes), byteLength: BigInt(bytes.byteLength), sha256: digest, kmsKeyId: 'dev:key',
  });
  assert.equal(identity.sha256, digest);
  const read = await store.read({ key, byteCeiling: 1_000n });
  assert.deepEqual(Buffer.concat(await collect(read.body)), bytes);
  await assert.rejects(
    () => store.putCreateOnly({ key, body: chunks(bytes), byteLength: BigInt(bytes.byteLength), sha256: digest, kmsKeyId: 'dev:key' }),
    (error: unknown) => error instanceof LedgerArchiveObjectStoreError && error.failureClass === 'already_exists',
  );
  await assert.rejects(() => store.read({ key, byteCeiling: 1n }),
    (error: unknown) => error instanceof LedgerArchiveObjectStoreError && error.failureClass === 'overflow');
});

test('filesystem adapter detects truncated bytes and declared digest mismatch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'known-ledger-archive-'));
  roots.push(root);
  const store = createFilesystemLedgerArchiveObjectStore({ rootDirectory: root, kmsKeyId: 'dev:key' });
  const bytes = Buffer.from('abc');
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const key = `ledger-archives/v1/audit/scope/1-3-${digest.slice(7)}.jsonl`;
  await assert.rejects(() => store.putCreateOnly({
    key, body: chunks(bytes), byteLength: 2n, sha256: digest, kmsKeyId: 'dev:key',
  }), (error: unknown) => error instanceof LedgerArchiveObjectStoreError
      && error.stableCode === 'archive_content_binding_mismatch');
  await store.putCreateOnly({ key, body: chunks(bytes), byteLength: 3n, sha256: digest, kmsKeyId: 'dev:key' });
  const objectPath = join(root, ...key.split('/'));
  assert.deepEqual(await readFile(objectPath), bytes);
  await truncate(objectPath, 1);
  await assert.rejects(() => store.read({ key, byteCeiling: 10n }),
    (error: unknown) => error instanceof LedgerArchiveObjectStoreError && error.stableCode === 'archive_content_address_mismatch');
});

async function* chunks(value: Uint8Array): AsyncGenerator<Uint8Array> { yield value; }
async function collect(body: AsyncIterable<Uint8Array>): Promise<Buffer[]> {
  const result: Buffer[] = [];
  for await (const chunk of body) result.push(Buffer.from(chunk));
  return result;
}
