import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, open, readdir, readFile, rm, stat, truncate, type FileHandle } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, test, vi } from 'vitest';

import {
  createFilesystemLedgerArchiveObjectStore,
} from '../../../src/infrastructure/ledger-archive/filesystem-object-store.js';
import { LedgerArchiveObjectStoreError } from '../../../src/infrastructure/ledger-archive/object-store.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

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

type FileHandleWrite = (
  this: FileHandle, buffer: Uint8Array, offset?: number | null, length?: number | null, position?: number | null,
) => Promise<{ bytesWritten: number; buffer: Uint8Array }>;

/** Every real FileHandle shares this prototype, so the store's own spool handle is intercepted. */
async function fileHandleWritePrototype(root: string): Promise<{ write: FileHandleWrite }> {
  const handle = await open(join(root, 'prototype-probe'), 'w');
  try {
    return Object.getPrototypeOf(handle) as { write: FileHandleWrite };
  } finally {
    await handle.close();
    await rm(join(root, 'prototype-probe'));
  }
}

async function archiveFixture(text: string) {
  const root = await mkdtemp(join(tmpdir(), 'known-ledger-archive-'));
  roots.push(root);
  const store = createFilesystemLedgerArchiveObjectStore({ rootDirectory: root, kmsKeyId: 'dev:key' });
  const bytes = Buffer.from(text);
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const key = `ledger-archives/v1/operations/scope/1-2-${digest.slice(7)}.jsonl`;
  const objectPath = join(root, ...key.split('/'));
  // Two chunks also prove that every chunk continues at the real file position.
  const split = Math.floor(bytes.byteLength / 2);
  const put = () => store.putCreateOnly({
    key, body: chunks(bytes.subarray(0, split), bytes.subarray(split)),
    byteLength: BigInt(bytes.byteLength), sha256: digest, kmsKeyId: 'dev:key',
  });
  return { root, store, bytes, digest, key, objectPath, put };
}

test('filesystem adapter completes short FileHandle writes before publishing the content address', async () => {
  const fixture = await archiveFixture('immutable ledger record\n');
  const prototype = await fileHandleWritePrototype(fixture.root);
  const original = prototype.write;
  const requests: number[] = [];
  vi.spyOn(prototype, 'write').mockImplementation(function shortWrite(this: FileHandle, buffer, offset, length, position) {
    const start = typeof offset === 'number' ? offset : 0;
    const requested = typeof length === 'number' ? length : buffer.byteLength - start;
    requests.push(requested);
    // A legal partial result: at most two bytes are stored per call.
    return original.call(this, buffer, start, Math.min(2, requested), position);
  } as FileHandleWrite);

  const identity = await fixture.put();

  assert.equal(identity.sha256, fixture.digest);
  assert.equal(identity.byteLength, BigInt(fixture.bytes.byteLength));
  assert.deepEqual(await readFile(fixture.objectPath), fixture.bytes);
  assert.ok(requests.length > 2, 'the remaining suffix of each chunk must be written again');
  assert.deepEqual(await readdir(dirname(fixture.objectPath)), [fixture.key.split('/').at(-1)]);
});

test('filesystem adapter rejects a zero-progress write without installing or poisoning the final key', async () => {
  const fixture = await archiveFixture('immutable ledger record\n');
  const prototype = await fileHandleWritePrototype(fixture.root);
  const spy = vi.spyOn(prototype, 'write').mockImplementation(async function noProgress(buffer) {
    return { bytesWritten: 0, buffer };
  } as FileHandleWrite);

  await assert.rejects(fixture.put(), (error: unknown) => error instanceof LedgerArchiveObjectStoreError
    && error.stableCode === 'archive_filesystem_write_failed');
  await assert.rejects(stat(fixture.objectPath), { code: 'ENOENT' });
  assert.deepEqual(await readdir(dirname(fixture.objectPath)), [], 'the private spool is removed');

  spy.mockRestore();
  const identity = await fixture.put();
  assert.equal(identity.sha256, fixture.digest);
  assert.deepEqual(await readFile(fixture.objectPath), fixture.bytes);
});

test('filesystem adapter cleans a non-empty spool when progress stops after partial writes', async () => {
  const fixture = await archiveFixture('immutable ledger record\n');
  const prototype = await fileHandleWritePrototype(fixture.root);
  const original = prototype.write;
  let calls = 0;
  vi.spyOn(prototype, 'write').mockImplementation(function partialThenStall(this: FileHandle, buffer, offset, length, position) {
    calls += 1;
    if (calls > 2) return Promise.resolve({ bytesWritten: 0, buffer });
    const start = typeof offset === 'number' ? offset : 0;
    const requested = typeof length === 'number' ? length : buffer.byteLength - start;
    return original.call(this, buffer, start, Math.min(3, requested), position);
  } as FileHandleWrite);

  await assert.rejects(fixture.put(), (error: unknown) => error instanceof LedgerArchiveObjectStoreError
    && error.stableCode === 'archive_filesystem_write_failed');
  assert.equal(calls, 3, 'two partial writes landed before progress stopped');
  await assert.rejects(stat(fixture.objectPath), { code: 'ENOENT' });
  assert.deepEqual(await readdir(dirname(fixture.objectPath)), [], 'the partially written spool is removed');
});

async function* chunks(...values: Uint8Array[]): AsyncGenerator<Uint8Array> { for (const value of values) yield value; }
async function collect(body: AsyncIterable<Uint8Array>): Promise<Buffer[]> {
  const result: Buffer[] = [];
  for await (const chunk of body) result.push(Buffer.from(chunk));
  return result;
}
