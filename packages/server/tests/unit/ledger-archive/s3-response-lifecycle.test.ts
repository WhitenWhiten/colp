import assert from 'node:assert/strict';
import { PassThrough, Readable } from 'node:stream';
import { test } from 'vitest';
import { createS3LedgerArchiveReader } from '../../../src/infrastructure/ledger-archive/s3-object-store.js';
import { createLedgerArchiveColdReader } from '../../../src/infrastructure/ledger-archive/cold-reader.js';

const digest = 'a'.repeat(64);
const key = `ledger-archives/v1/operations/scope/1-2-${digest}.jsonl`;
const metadata = { 'ledger-archive-sha256': digest, 'ledger-archive-kms-key-id': 'kms:key', 'ledger-archive-schema': '1' };
function reader(body: Readable, override: object = {}) {
  return createS3LedgerArchiveReader({
    endpoint: 'https://example.invalid', region: 'auto', bucket: 'known-archive',
    readerCredential: { accessKeyId: 'fixture', secretAccessKey: 'fixture' },
    client: { async send() { return { ContentLength: 2, Metadata: metadata, Body: body, ...override }; } },
  });
}

test.each([
  { Metadata: {} },
  { Metadata: { ...metadata, 'ledger-archive-sha256': 'b'.repeat(64) } },
  { ContentLength: 20 },
])('rejected GET metadata or length releases the unconsumed response', async override => {
  const source = new PassThrough();
  await assert.rejects(reader(source, override).read({ key, byteCeiling: 10n }));
  assert.equal(source.destroyed, true);
});

test('unstarted reads close explicitly and react to cancellation before iteration', async () => {
  for (const cancel of [false, true]) {
    const source = new PassThrough();
    const controller = new AbortController();
    const object = await reader(source).read({ key, byteCeiling: 10n, signal: controller.signal });
    if (cancel) controller.abort();
    else { await object.close(); await object.close(); }
    assert.equal(source.destroyed, true);
  }
});

test('cold-reader manifest rejection closes a successfully acquired object', async () => {
  const source = new PassThrough();
  const objects = reader(source);
  const cold = createLedgerArchiveColdReader({ objects, byteCeiling: 10n,
    segments: { get: async () => ({ state: 'verified', legalHold: false, archiveSchemaVersion: 1,
      archiveObjectUri: objects.uriForKey(key), contentDigest: `sha256:${digest}`,
      archiveObjectEtag: `sha256:${digest}`, sourceBytes: 2n, kmsKeyId: 'different-key' }) } as never });
  await assert.rejects(cold.readRows('segment', () => undefined), /does not match/);
  assert.equal(source.destroyed, true);
});

test('consumer early return disposes the response body', async () => {
  const source = Readable.from([Buffer.from('a'), Buffer.from('b')]);
  const object = await reader(source).read({ key, byteCeiling: 10n });
  for await (const _chunk of object.body) break;
  assert.equal(source.destroyed, true);
  await object.close();
});
