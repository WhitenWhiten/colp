import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'vitest';
import type {
  ProductCommandBinding,
  ProductCommandReceiptPort,
  ProductCommandResult,
} from '../../src/modules/commands/index.js';

const COMMAND_A = '5de3947e-6271-4fdf-a946-d22e58a99c2a';
const COMMAND_B = 'a1b2c3d4-e5f6-4789-a012-3456789abcde';
const COMMAND_C = '11111111-2222-4333-8444-555555555555';
const FINGERPRINT_A = 'a'.repeat(64);
const FINGERPRINT_B = 'b'.repeat(64);

export interface ProductCommandReceiptCoreContractOptions {
  readonly name: string;
  readonly createPort: () => ProductCommandReceiptPort | Promise<ProductCommandReceiptPort>;
  readonly reset?: () => void | Promise<void>;
}

function binding(
  commandId: string,
  overrides: Partial<ProductCommandBinding> = {},
): ProductCommandBinding {
  return {
    principalId: 'contract-receipt-principal-a',
    commandScope: 'collection:contract-receipt',
    commandId,
    ...overrides,
  };
}

function result(overrides: Partial<ProductCommandResult> = {}): ProductCommandResult {
  return {
    status: 201,
    body: Buffer.from('{"ok":true}'),
    stableHeaders: {
      ETag: '"contract-r1"',
      'Content-Type': 'application/json',
      'X-Request-Id': 'dynamic-request-id',
      Date: 'Sun, 30 Aug 2026 09:00:00 GMT',
    },
    mediaType: 'application/json',
    contractVersion: '1.0.0',
    targetIdentity: 'collection:contract-receipt',
    ...overrides,
  };
}

function expectedReplay(source: ProductCommandResult): ProductCommandResult {
  return {
    ...source,
    body: Buffer.from(source.body),
    stableHeaders: {
      etag: '"contract-r1"',
      'content-type': 'application/json',
    },
  };
}

/**
 * Core admission/replay contract shared by memory fakes and PostgreSQL.
 * Retention compaction remains in the dedicated PostgreSQL evidence suite.
 */
export function defineProductCommandReceiptCoreContract(
  options: ProductCommandReceiptCoreContractOptions,
): void {
  describe(options.name, () => {
    beforeEach(async () => options.reset?.());

    test('rejects non-canonical command ids before creating a claim', async () => {
      const port = await options.createPort();
      await assert.rejects(
        () => port.claim(binding('NOT-A-CANONICAL-UUID'), FINGERPRINT_A),
        /canonical lowercase UUID v4/,
      );
      assert.deepEqual(await port.claim(binding(COMMAND_A), FINGERPRINT_A), { kind: 'claimed' });
    });

    test('moves claimed commands through in-progress, completion, and replay', async () => {
      const port = await options.createPort();
      const command = binding(COMMAND_A);
      const completed = result();

      assert.deepEqual(await port.claim(command, FINGERPRINT_A), { kind: 'claimed' });
      assert.deepEqual(await port.claim(command, FINGERPRINT_A), {
        kind: 'in_progress',
        retryAfterSeconds: 1,
      });
      await port.complete(command, FINGERPRINT_A, completed);
      assert.deepEqual(await port.claim(command, FINGERPRINT_A), {
        kind: 'replay',
        result: expectedReplay(completed),
      });
      assert.deepEqual(await port.claim(command, FINGERPRINT_B), { kind: 'reused' });
      await assert.rejects(() => port.complete(command, FINGERPRINT_A, completed));
    });

    test('allows only one concurrent initial claim', async () => {
      const port = await options.createPort();
      const command = binding(COMMAND_B);
      const outcomes = await Promise.all([
        port.claim(command, FINGERPRINT_A),
        port.claim(command, FINGERPRINT_A),
      ]);

      assert.equal(outcomes.filter((outcome) => outcome.kind === 'claimed').length, 1);
      assert.equal(outcomes.filter((outcome) => outcome.kind === 'in_progress').length, 1);
    });

    test('does not retain caller-owned result bytes or expose stored replay bytes', async () => {
      const port = await options.createPort();
      const command = binding(COMMAND_A);
      const body = Buffer.from('{"snapshot":true}');
      const completed = result({ body });
      const expected = expectedReplay(completed);
      await port.claim(command, FINGERPRINT_A);
      await port.complete(command, FINGERPRINT_A, completed);

      body.fill(0);
      const first = await port.claim(command, FINGERPRINT_A);
      assert.equal(first.kind, 'replay');
      if (first.kind !== 'replay') return;
      assert.deepEqual(first.result, expected);
      first.result.body.fill(1);

      assert.deepEqual(await port.claim(command, FINGERPRINT_A), {
        kind: 'replay',
        result: expected,
      });
    });

    test('failed completion leaves the original claim in progress', async () => {
      const port = await options.createPort();
      const command = binding(COMMAND_A);
      await port.claim(command, FINGERPRINT_A);

      await assert.rejects(() => port.complete(command, FINGERPRINT_B, result()));
      assert.deepEqual(await port.claim(command, FINGERPRINT_A), {
        kind: 'in_progress',
        retryAfterSeconds: 1,
      });
    });

    test('deletes only receipts owned by the selected principal', async () => {
      const port = await options.createPort();
      const ownedA = binding(COMMAND_A);
      const ownedB = binding(COMMAND_B);
      const retained = binding(COMMAND_C, { principalId: 'contract-receipt-principal-b' });
      await port.claim(ownedA, FINGERPRINT_A);
      await port.claim(ownedB, FINGERPRINT_A);
      await port.claim(retained, FINGERPRINT_A);

      assert.equal(await port.deletePrincipalReceipts(ownedA.principalId), 2);
      assert.equal(await port.deletePrincipalReceipts(ownedA.principalId), 0);
      assert.deepEqual(await port.claim(retained, FINGERPRINT_A), {
        kind: 'in_progress',
        retryAfterSeconds: 1,
      });
    });
  });
}
