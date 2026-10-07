import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  createMemoryProductCommandReceiptPort,
  executeMemoryTransaction,
  productCommandReceiptKey,
  type MemoryProductCommandReceipts,
} from '../../support/product-http-harness.js';
import type {
  ProductCommandBinding,
  ProductCommandResult,
} from '../../../src/modules/commands/index.js';

const binding: ProductCommandBinding = {
  principalId: 'principal-1',
  commandScope: 'collection:1',
  commandId: '123e4567-e89b-42d3-a456-426614174000',
};
const fingerprint = 'fingerprint-1';
const result: ProductCommandResult = {
  status: 201,
  body: Buffer.from('{"ok":true}'),
  stableHeaders: { location: '/api/v1/collections/1', etag: '"revision-1"' },
  mediaType: 'application/json',
  contractVersion: '1.0.0',
  targetIdentity: 'collection:1',
};

describe('shared Product HTTP memory harness parity', () => {
  test('models one receipt winner and an in-progress concurrent observer', async () => {
    const receipts: MemoryProductCommandReceipts = new Map();
    const port = createMemoryProductCommandReceiptPort(receipts);

    const claims = await Promise.all([
      port.claim(binding, fingerprint),
      port.claim(binding, fingerprint),
    ]);

    assert.deepEqual(claims, [
      { kind: 'claimed' },
      { kind: 'in_progress', retryAfterSeconds: 1 },
    ]);
  });

  test('preserves replay bytes and distinguishes reuse and expiry', async () => {
    const receipts: MemoryProductCommandReceipts = new Map();
    const port = createMemoryProductCommandReceiptPort(receipts);
    assert.deepEqual(await port.claim(binding, fingerprint), { kind: 'claimed' });
    await port.complete(binding, fingerprint, result);

    const replay = await port.claim(binding, fingerprint);
    assert.equal(replay.kind, 'replay');
    if (replay.kind === 'replay') {
      assert.deepEqual(Buffer.from(replay.result.body), Buffer.from(result.body));
      assert.deepEqual(replay.result.stableHeaders, result.stableHeaders);
      assert.notEqual(replay.result.body, result.body);
    }
    assert.deepEqual(await port.claim(binding, 'different'), { kind: 'reused' });

    const row = receipts.get(productCommandReceiptKey(binding));
    assert.ok(row);
    row.expired = true;
    assert.deepEqual(await port.claim(binding, fingerprint), {
      kind: 'expired',
      resultDigest: 'test-result-digest',
    });
  });

  test('commits receipt and business writes together and rolls both back on failure', async () => {
    const state: { receipts: MemoryProductCommandReceipts; writes: string[] } = {
      receipts: new Map(),
      writes: [],
    };

    await assert.rejects(executeMemoryTransaction(state, async (transaction) => {
      const port = createMemoryProductCommandReceiptPort(transaction.receipts);
      assert.deepEqual(await port.claim(binding, fingerprint), { kind: 'claimed' });
      transaction.writes.push('partial-write');
      throw new Error('forced rollback');
    }), /forced rollback/);
    assert.equal(state.receipts.size, 0);
    assert.deepEqual(state.writes, []);

    await executeMemoryTransaction(state, async (transaction) => {
      const port = createMemoryProductCommandReceiptPort(transaction.receipts);
      assert.deepEqual(await port.claim(binding, fingerprint), { kind: 'claimed' });
      transaction.writes.push('committed-write');
      await port.complete(binding, fingerprint, result);
    });
    assert.equal(state.receipts.size, 1);
    assert.deepEqual(state.writes, ['committed-write']);
  });
});
