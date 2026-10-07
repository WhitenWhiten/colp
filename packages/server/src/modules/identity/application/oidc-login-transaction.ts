/**
 * LEGACY OIDC login transaction use cases — DEPRECATED SOURCE (Task F1
 * quarantine). Retained for audit and the legacy migration window; source
 * retention is NOT runtime enablement. Superseded by Better Auth
 * (docs/development/known-backend/better-auth/better-auth-migration-development-plan.md
 * §12 Task F1; G1 ADR §11). Ownership: Better Auth migration lane F — new
 * code reaches this surface only through
 * `src/infrastructure/auth/legacy-oidc-boundary.ts`. Keep behavior unchanged.
 *
 * @deprecated Legacy OIDC login transaction flow.
 */
import {
  IdentityError,
  OIDC_LOGIN_TRANSACTION_TTL_MS,
  assertNonEmpty,
  assertSafeRelativeReturnTo,
  generateOidcStateMaterial,
  generatePkceCodeVerifier,
  materializeOidcLoginTransactionForUse,
} from '../domain/index.js';
import type { OidcLoginTransaction } from '../domain/types.js';
import type { IdentityPorts } from './ports.js';

/**
 * @deprecated Legacy OIDC login transaction input (Task F1 quarantine).
 */
export interface CreateOidcLoginTransactionInput {
  readonly returnTo: string;
  readonly state?: string;
  readonly nonce?: string;
  readonly codeVerifier?: string;
  readonly ttlMs?: number;
}

/**
 * @deprecated Legacy OIDC login transaction result (Task F1 quarantine).
 */
export interface CreateOidcLoginTransactionResult {
  /**
   * In-memory view for authorize-redirect construction.
   * Includes browser state/nonce/verifier secrets; the persisted row does not.
   */
  readonly transaction: OidcLoginTransaction;
  /** Echoed for PKCE authorize redirect construction; treat as secret. */
  readonly codeVerifier: string;
}

/**
 * Persists a one-time OIDC login transaction with protected secrets at rest.
 *
 * Rows store keyed digests for state/nonce and AEAD ciphertext for the PKCE
 * verifier only. Raw browser secrets are never written. Never log state, nonce,
 * or code_verifier.
 *
 * @deprecated Legacy OIDC login transaction (Task F1 quarantine).
 */
export async function createOidcLoginTransaction(
  ports: IdentityPorts,
  input: CreateOidcLoginTransactionInput,
): Promise<CreateOidcLoginTransactionResult> {
  const returnTo = assertSafeRelativeReturnTo(input.returnTo);
  const browserState = input.state ?? generateOidcStateMaterial();
  const browserNonce = input.nonce ?? generateOidcStateMaterial();
  const codeVerifier = input.codeVerifier ?? generatePkceCodeVerifier();
  assertNonEmpty(browserState, 'state');
  assertNonEmpty(browserNonce, 'nonce');
  assertNonEmpty(codeVerifier, 'codeVerifier');

  const ttlMs = input.ttlMs ?? OIDC_LOGIN_TRANSACTION_TTL_MS;
  if (ttlMs <= 0) {
    throw new IdentityError('invalid_identity_input', 'OIDC transaction TTL must be positive');
  }

  const secrets = ports.oidcTransactionSecrets;
  const stateHash = secrets.digestState(browserState);
  const nonceHash = secrets.digestNonce(browserNonce);
  const encrypted = secrets.encryptPkceVerifier(codeVerifier);

  const now = await ports.clock.now();
  // Persist protected material only (stateHash is the storage identity).
  const persisted: OidcLoginTransaction = {
    state: stateHash,
    nonce: '',
    codeVerifier: '',
    returnTo,
    createdAt: now,
    expiresAt: new Date(now.getTime() + ttlMs),
    consumedAt: null,
    codeChallengeMethod: 'S256',
    stateHash,
    nonceHash,
    pkceVerifierCiphertext: encrypted.ciphertext,
    encryptionKeyId: encrypted.keyId,
    encryptionKeyVersion: encrypted.keyVersion,
  };
  await ports.oidcLoginTransactions.insert(persisted);

  // Return browser secrets for authorize URL construction only (not re-read from DB as plaintext).
  const forRedirect: OidcLoginTransaction = {
    ...persisted,
    state: browserState,
    nonce: browserNonce,
    codeVerifier,
  };
  return { transaction: forRedirect, codeVerifier };
}

/**
 * Atomically consumes an OIDC login transaction once.
 * Lookup is by state digest only (contracted schema has no plaintext state).
 * Concurrent consumers: only one succeeds; others get transaction_consumed.
 * Materializes decrypted PKCE verifier for the callback; nonce stays hashed.
 *
 * @deprecated Legacy OIDC login transaction (Task F1 quarantine).
 */
export async function consumeOidcLoginTransaction(
  ports: IdentityPorts,
  browserState: string,
): Promise<OidcLoginTransaction> {
  assertNonEmpty(browserState, 'state');
  const now = await ports.clock.now();
  const stateDigest = ports.oidcTransactionSecrets.digestState(browserState);
  const consumed = await ports.oidcLoginTransactions.consume(browserState, now, stateDigest);
  if (consumed) {
    return materializeOidcLoginTransactionForUse(
      consumed,
      browserState,
      ports.oidcTransactionSecrets,
    );
  }

  const existing = await ports.oidcLoginTransactions.findByState(browserState, stateDigest);
  if (!existing) {
    throw new IdentityError('transaction_not_found', 'OIDC login transaction was not found');
  }
  if (existing.consumedAt !== null) {
    throw new IdentityError('transaction_consumed', 'OIDC login transaction was already consumed');
  }
  if (now.getTime() >= existing.expiresAt.getTime()) {
    throw new IdentityError('transaction_expired', 'OIDC login transaction has expired');
  }
  throw new IdentityError('transaction_consumed', 'OIDC login transaction could not be consumed');
}
