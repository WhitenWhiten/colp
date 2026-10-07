/**
 * In-memory OIDC login-transaction helpers for unit harnesses.
 * Lookup matches protected state digests only (contracted schema).
 *
 * @deprecated Legacy OIDC test seam (Task E1/F1 quarantine; plan §11 Task E1
 *   and §12 Task F1). New tests must NOT use this surface: sessions are
 *   minted through `tests/support/better-auth-test-factory.ts` and the
 *   product session flows run against the Better Auth test factory. This
 *   module is retained ONLY for the legacy OIDC negative/isolation suites
 *   (browser-auth-transport, oidc-provider, legacy-oidc-deprecation,
 *   auth-runtime-isolation, test-oidc-authorize-route) and for the legacy
 *   memory identity ports that those suites still drive, plus the shared
 *   adapter contract that prevents this fake from drifting from PostgreSQL.
 */
import type { OidcLoginTransaction } from '../../src/modules/identity/index.js';

function snapshotOidc(transaction: OidcLoginTransaction): OidcLoginTransaction {
  return {
    // Match the persistence adapter: browser secrets never survive insertion.
    state: transaction.stateHash,
    nonce: '',
    codeVerifier: '',
    returnTo: transaction.returnTo,
    createdAt: new Date(transaction.createdAt),
    expiresAt: new Date(transaction.expiresAt),
    consumedAt: transaction.consumedAt === null ? null : new Date(transaction.consumedAt),
    codeChallengeMethod: transaction.codeChallengeMethod,
    stateHash: transaction.stateHash,
    nonceHash: transaction.nonceHash,
    pkceVerifierCiphertext: Buffer.from(transaction.pkceVerifierCiphertext),
    encryptionKeyId: transaction.encryptionKeyId,
    encryptionKeyVersion: transaction.encryptionKeyVersion,
  };
}

export function findMemoryOidc(
  store: Map<string, OidcLoginTransaction>,
  _browserState: string,
  stateDigest: string,
): OidcLoginTransaction | null {
  for (const tx of store.values()) {
    if (tx.stateHash === stateDigest) {
      return snapshotOidc(tx);
    }
  }
  return null;
}

export function createMemoryOidcLoginTransactionRepository(
  store: Map<string, OidcLoginTransaction>,
) {
  return {
    async insert(tx: OidcLoginTransaction): Promise<void> {
      if (store.has(tx.stateHash)) {
        throw new Error('OIDC login transaction state digest already exists');
      }
      store.set(tx.stateHash, snapshotOidc(tx));
    },
    async consume(
      browserState: string,
      now: Date,
      stateDigest: string,
    ): Promise<OidcLoginTransaction | null> {
      const tx = findMemoryOidc(store, browserState, stateDigest);
      if (!tx || tx.consumedAt || tx.expiresAt.getTime() <= now.getTime()) return null;
      const consumed = snapshotOidc({ ...tx, consumedAt: now });
      store.set(tx.stateHash, consumed);
      return snapshotOidc(consumed);
    },
    async findByState(
      browserState: string,
      stateDigest: string,
    ): Promise<OidcLoginTransaction | null> {
      return findMemoryOidc(store, browserState, stateDigest);
    },
    async deleteByState(
      browserState: string,
      stateDigest: string,
    ): Promise<boolean> {
      const tx = findMemoryOidc(store, browserState, stateDigest);
      if (!tx) return false;
      return store.delete(tx.stateHash);
    },
  };
}
