import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'vitest';
import type {
  OidcLoginTransaction,
  OidcLoginTransactionRepository,
} from '../../src/modules/identity/index.js';

const CREATED_AT = new Date('2026-08-30T08:00:00.000Z');
const EXPIRES_AT = new Date('2026-08-30T08:05:00.000Z');

export interface OidcLoginTransactionRepositoryContractOptions {
  readonly name: string;
  readonly createRepository: () => OidcLoginTransactionRepository | Promise<OidcLoginTransactionRepository>;
  readonly reset?: () => void | Promise<void>;
}

function loginTransaction(
  stateHash: string,
  overrides: Partial<OidcLoginTransaction> = {},
): OidcLoginTransaction {
  return {
    state: overrides.state ?? 'raw-browser-state-must-not-be-stored',
    nonce: overrides.nonce ?? 'raw-browser-nonce-must-not-be-stored',
    codeVerifier: overrides.codeVerifier ?? 'raw-pkce-verifier-must-not-be-stored',
    returnTo: overrides.returnTo ?? '/contract-return',
    createdAt: overrides.createdAt ?? CREATED_AT,
    expiresAt: overrides.expiresAt ?? EXPIRES_AT,
    consumedAt: overrides.consumedAt ?? null,
    codeChallengeMethod: 'S256',
    stateHash,
    nonceHash: overrides.nonceHash ?? `nonce-${stateHash}`,
    pkceVerifierCiphertext: overrides.pkceVerifierCiphertext ?? Buffer.from(`ciphertext-${stateHash}`),
    encryptionKeyId: overrides.encryptionKeyId ?? 'contract-key',
    encryptionKeyVersion: overrides.encryptionKeyVersion ?? 7,
  };
}

function persistedShape(transaction: OidcLoginTransaction): OidcLoginTransaction {
  return {
    ...transaction,
    state: transaction.stateHash,
    nonce: '',
    codeVerifier: '',
    createdAt: new Date(transaction.createdAt),
    expiresAt: new Date(transaction.expiresAt),
    consumedAt: transaction.consumedAt === null ? null : new Date(transaction.consumedAt),
    pkceVerifierCiphertext: Buffer.from(transaction.pkceVerifierCiphertext),
  };
}

/** Registers persistence and one-shot-consumption semantics for every adapter. */
export function defineOidcLoginTransactionRepositoryContract(
  options: OidcLoginTransactionRepositoryContractOptions,
): void {
  describe(options.name, () => {
    beforeEach(async () => options.reset?.());

    test('persists only protected fields and looks up exclusively by state digest', async () => {
      const repository = await options.createRepository();
      const transaction = loginTransaction('contract-state-round-trip');
      await repository.insert(transaction);

      assert.deepEqual(
        await repository.findByState('untrusted-browser-state', transaction.stateHash),
        persistedShape(transaction),
      );
      assert.equal(await repository.findByState(transaction.state, 'contract-state-missing'), null);
    });

    test('takes a persistence snapshot instead of retaining caller-owned mutable values', async () => {
      const repository = await options.createRepository();
      const ciphertext = Buffer.from('contract-ciphertext-snapshot');
      const createdAt = new Date(CREATED_AT);
      const transaction = loginTransaction('contract-state-snapshot', {
        createdAt,
        pkceVerifierCiphertext: ciphertext,
      });
      const expected = persistedShape(transaction);
      await repository.insert(transaction);

      ciphertext.fill(0);
      createdAt.setUTCFullYear(2035);

      assert.deepEqual(
        await repository.findByState('ignored-browser-state', transaction.stateHash),
        expected,
      );
    });

    test('allows exactly one consumer and records its timestamp', async () => {
      const repository = await options.createRepository();
      const transaction = loginTransaction('contract-state-consume');
      const consumedAt = new Date('2026-08-30T08:01:00.000Z');
      await repository.insert(transaction);

      const outcomes = await Promise.all([
        repository.consume('browser-state-a', consumedAt, transaction.stateHash),
        repository.consume('browser-state-b', consumedAt, transaction.stateHash),
      ]);

      assert.equal(outcomes.filter((outcome) => outcome !== null).length, 1);
      assert.deepEqual(outcomes.find((outcome) => outcome !== null), {
        ...persistedShape(transaction),
        consumedAt,
      });
      assert.equal(
        await repository.consume('browser-state-c', consumedAt, transaction.stateHash),
        null,
      );
      assert.equal(
        (await repository.findByState('browser-state-d', transaction.stateHash))?.consumedAt?.getTime(),
        consumedAt.getTime(),
      );
    });

    test('rejects consumption at the expiry boundary without marking the row consumed', async () => {
      const repository = await options.createRepository();
      const transaction = loginTransaction('contract-state-expired');
      await repository.insert(transaction);

      assert.equal(
        await repository.consume('ignored-browser-state', transaction.expiresAt, transaction.stateHash),
        null,
      );
      assert.equal(
        (await repository.findByState('ignored-browser-state', transaction.stateHash))?.consumedAt,
        null,
      );
    });

    test('rejects duplicate state digests and preserves the first transaction', async () => {
      const repository = await options.createRepository();
      const winner = loginTransaction('contract-state-duplicate');
      await repository.insert(winner);

      await assert.rejects(() => repository.insert(loginTransaction(winner.stateHash, {
        returnTo: '/loser',
      })));
      assert.deepEqual(
        await repository.findByState('ignored-browser-state', winner.stateHash),
        persistedShape(winner),
      );
    });

    test('deletes by digest exactly once', async () => {
      const repository = await options.createRepository();
      const transaction = loginTransaction('contract-state-delete');
      await repository.insert(transaction);

      assert.equal(await repository.deleteByState('browser-state-a', transaction.stateHash), true);
      assert.equal(await repository.deleteByState('browser-state-b', transaction.stateHash), false);
      assert.equal(await repository.findByState('browser-state-c', transaction.stateHash), null);
    });
  });
}
