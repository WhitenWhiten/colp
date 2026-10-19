import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { Kysely } from 'kysely';
import type { DatabaseSchema, DatabaseTransaction } from '../../../src/infrastructure/database/index.js';
import { createPostgresIdentityUnitOfWork } from '../../../src/infrastructure/identity/index.js';
import {
  ExtensionAuthError,
  IdentityError,
  createTestOidcTransactionSecrets,
  type IdentityPorts,
} from '../../../src/modules/identity/index.js';

/**
 * Minimal Kysely transaction harness: the identity unit of work only needs a
 * transaction object it can hand to port factories. No port method is invoked
 * by construction, so this is enough to prove composition-time behavior.
 */
function fakeDatabase(): Kysely<DatabaseSchema> {
  const transaction = { marker: 'fake-transaction' } as unknown as DatabaseTransaction;
  const builder = {
    setIsolationLevel() {
      return builder;
    },
    async execute<Result>(callback: (value: DatabaseTransaction) => Promise<Result>): Promise<Result> {
      return callback(transaction);
    },
  };
  return { transaction: () => builder } as unknown as Kysely<DatabaseSchema>;
}

test('identity unit of work composes without OIDC secrets and non-OIDC work succeeds', async () => {
  const unitOfWork = createPostgresIdentityUnitOfWork(fakeDatabase());

  const result = await unitOfWork.execute(async () => 'non-oidc-work');

  assert.equal(result, 'non-oidc-work');
});

test('using the OIDC secrets port without injected secrets fails closed with a configuration error', async () => {
  const unitOfWork = createPostgresIdentityUnitOfWork(fakeDatabase());

  await assert.rejects(
    () => unitOfWork.execute(async (ports) => ports.oidcTransactionSecrets.digestState('browser-state')),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /oidcTransactionSecrets is required/u);
      assert.equal(error instanceof ExtensionAuthError, false, 'configuration failure is not an auth failure');
      assert.equal(error instanceof IdentityError, false, 'configuration failure is not a domain identity error');
      assert.notEqual((error as { code?: unknown }).code, 'invalid_token');
      return true;
    },
  );
});

test('no implicit fixed key is used for any OIDC transaction secret operation', async () => {
  const unitOfWork = createPostgresIdentityUnitOfWork(fakeDatabase());
  const operations: Array<[string, (ports: IdentityPorts) => unknown]> = [
    ['digestState', (ports) => ports.oidcTransactionSecrets.digestState('state')],
    ['digestNonce', (ports) => ports.oidcTransactionSecrets.digestNonce('nonce')],
    ['verifyStateDigest', (ports) => ports.oidcTransactionSecrets.verifyStateDigest('state', 'digest')],
    ['verifyNonceDigest', (ports) => ports.oidcTransactionSecrets.verifyNonceDigest('nonce', 'digest')],
    ['encryptPkceVerifier', (ports) => ports.oidcTransactionSecrets.encryptPkceVerifier('verifier')],
    ['decryptPkceVerifier', (ports) => ports.oidcTransactionSecrets.decryptPkceVerifier(Buffer.alloc(32), 'id', 1)],
  ];
  for (const [name, operation] of operations) {
    await assert.rejects(
      () => unitOfWork.execute(async (ports) => operation(ports)),
      new RegExp('oidcTransactionSecrets is required', 'u'),
      `${name} must fail closed`,
    );
  }
});

test('explicitly injected test secrets work for OIDC transaction operations', async () => {
  const secrets = createTestOidcTransactionSecrets();
  const unitOfWork = createPostgresIdentityUnitOfWork(fakeDatabase(), {
    oidcTransactionSecrets: secrets,
  });

  const result = await unitOfWork.execute(async (ports) => {
    const digest = ports.oidcTransactionSecrets.digestState('browser-state');
    const encrypted = ports.oidcTransactionSecrets.encryptPkceVerifier('code-verifier-value');
    const decrypted = ports.oidcTransactionSecrets.decryptPkceVerifier(
      encrypted.ciphertext,
      encrypted.keyId,
      encrypted.keyVersion,
    );
    return {
      digest,
      expectedDigest: secrets.digestState('browser-state'),
      decrypted,
      verified: ports.oidcTransactionSecrets.verifyStateDigest('browser-state', digest),
    };
  });

  assert.equal(result.digest, result.expectedDigest);
  assert.equal(result.decrypted, 'code-verifier-value');
  assert.equal(result.verified, true);
});

test('explicit config-backed secrets are still accepted', async () => {
  const config = {
    hmacSecret: 'explicit-config-hmac-secret',
    encryptionKeys: [{ id: 'explicit-key', version: 1, key: Buffer.alloc(32, 9) }],
  };
  const unitOfWork = createPostgresIdentityUnitOfWork(fakeDatabase(), {
    oidcTransactionSecrets: config,
  });

  const encrypted = await unitOfWork.execute(async (ports) =>
    ports.oidcTransactionSecrets.encryptPkceVerifier('config-verifier'));
  const decrypted = await unitOfWork.execute(async (ports) =>
    ports.oidcTransactionSecrets.decryptPkceVerifier(
      encrypted.ciphertext,
      encrypted.keyId,
      encrypted.keyVersion,
    ));

  assert.equal(encrypted.keyId, 'explicit-key');
  assert.equal(decrypted, 'config-verifier');
});
