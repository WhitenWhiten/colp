import assert from 'node:assert/strict';
import { test } from 'vitest';

import {
  encodeLedgerArchiveV1,
  LedgerArchiveFormatError,
  verifyLedgerArchiveV1,
} from '../../../src/infrastructure/ledger-archive/canonical-format.js';

const header = {
  ledgerFamily: 'operations', sourceRelation: 'public.operations', sourceScope: 'global',
  lowerInclusive: 10n, upperExclusive: 20n,
};

async function encode(signal?: AbortSignal) {
  const chunks: Uint8Array[] = [];
  const rows = (async function* () {
    yield { key: 10n, value: { z: 1, a: 'first', large: 42n } };
    yield { key: 13n, value: { at: new Date('2026-01-02T03:04:05.000Z'), ok: true } };
  })();
  const summary = await encodeLedgerArchiveV1(header, rows, async (chunk) => {
    chunks.push(chunk);
  }, { byteCeiling: 10_000n, ...(signal === undefined ? {} : { signal }) });
  return { body: Buffer.concat(chunks), summary };
}

test('archive v1 encoding is deterministic and verifies rows without whole-segment buffering', async () => {
  const first = await encode();
  const second = await encode();
  assert.deepEqual(first, second);
  const keys: bigint[] = [];
  const verified = await verifyLedgerArchiveV1(singleByteChunks(first.body), {
    ...header, rowCount: 2n, contentDigest: first.summary.contentDigest,
  }, { byteCeiling: BigInt(first.body.byteLength), maxLineBytes: 1024, onRow: ({ key }) => keys.push(key) });
  assert.deepEqual(keys, [10n, 13n]);
  assert.equal(verified.byteLength, BigInt(first.body.byteLength));
});

test('archive encoding and verification fail closed on ceilings, abort, and truncation', async () => {
  await assert.rejects(
    () => encodeLedgerArchiveV1(header, (async function* () { yield { key: 10n, value: 'x' }; })(), async () => {}, { byteCeiling: 5n }),
    (error: unknown) => error instanceof LedgerArchiveFormatError && error.stableCode === 'archive_byte_ceiling',
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => encode(controller.signal),
    (error: unknown) => error instanceof LedgerArchiveFormatError && error.stableCode === 'archive_aborted');
  const encoded = await encode();
  await assert.rejects(
    () => verifyLedgerArchiveV1(singleByteChunks(encoded.body.subarray(0, -3)), header, { byteCeiling: 10_000n }),
    (error: unknown) => error instanceof LedgerArchiveFormatError && error.stableCode === 'archive_truncated',
  );
});

async function* singleByteChunks(body: Uint8Array): AsyncGenerator<Uint8Array> {
  for (const byte of body) yield Uint8Array.of(byte);
}
