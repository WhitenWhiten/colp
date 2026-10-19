import type { Kysely } from 'kysely';
import {
  IdentityError,
  createOidcTransactionSecrets,
  createSessionRotationSecrets,
  generateSessionTokenRaw,
  type IdentityPorts,
  type IdentityUnitOfWork,
  type OidcTransactionSecretsConfig,
  type OidcTransactionSecretsPort,
  type SessionRotationSecretsPort,
} from '../../modules/identity/index.js';
import { DatabaseOperationError } from '../database/errors.js';
import type { DatabaseSchema } from '../database/runtime.js';
import {
  createUnitOfWork,
  type TransactionIsolationLevel,
  type UnitOfWorkOptions,
} from '../database/unit-of-work.js';
import { createPostgresIdentityPorts } from './repositories.js';
type ReportSourceInvalidationOutboxPort = { append(transaction: import('../database/unit-of-work.js').DatabaseTransaction, input: { readonly domainEventId: string; readonly collectionId: string; readonly sourceEventType: string; readonly sourceEventVersion: number; readonly contentRevision: string; readonly policyRevision: string; readonly commitOrdinal: bigint }): Promise<void> };

export interface PostgresIdentityUnitOfWorkOptions {
  readonly isolationLevel?: TransactionIsolationLevel;
  readonly faultInjector?: UnitOfWorkOptions['faultInjector'];
  /**
   * OIDC login-transaction secret protection keys.
   * Production composition must supply config-backed material. Tests that
   * exercise the legacy OIDC flow must inject `createTestOidcTransactionSecrets()`
   * explicitly; omitting the option fails closed when the port is used.
   */
  readonly oidcTransactionSecrets?: OidcTransactionSecretsPort | OidcTransactionSecretsConfig;
  /** Stable server-held keying material used to make legacy rotation race-safe. */
  readonly sessionRotationSecrets?: SessionRotationSecretsPort | string;
  readonly reportSourceInvalidation?: ReportSourceInvalidationOutboxPort;
}

/**
 * Identity module Unit of Work over PostgreSQL.
 * Each execute() opens one transaction and binds all identity ports to it.
 * Domain IdentityError values are re-surfaced (not left as generic database_failure).
 */
export function createPostgresIdentityUnitOfWork(
  db: Kysely<DatabaseSchema>,
  options: PostgresIdentityUnitOfWorkOptions = {},
): IdentityUnitOfWork {
  const unitOfWork = createUnitOfWork(db, {
    isolationLevel: options.isolationLevel,
    faultInjector: options.faultInjector,
  });
  const oidcTransactionSecrets = resolveOidcTransactionSecrets(options.oidcTransactionSecrets);
  const sessionRotationSecrets = resolveSessionRotationSecrets(
    options.sessionRotationSecrets,
    options.oidcTransactionSecrets,
  );

  return {
    async execute<Result>(work: (ports: IdentityPorts) => Promise<Result>): Promise<Result> {
      try {
        return await unitOfWork.execute(({ transaction }) => {
          const ports = createPostgresIdentityPorts(
            transaction,
            oidcTransactionSecrets,
            sessionRotationSecrets,
            { ...(options.reportSourceInvalidation === undefined ? {} : { reportSourceInvalidation: options.reportSourceInvalidation }) },
          );
          return work(ports);
        });
      } catch (error: unknown) {
        const identityError = extractIdentityError(error);
        if (identityError) throw identityError;
        throw error;
      }
    },
  };
}

function resolveSessionRotationSecrets(
  value: PostgresIdentityUnitOfWorkOptions['sessionRotationSecrets'],
  oidcValue: PostgresIdentityUnitOfWorkOptions['oidcTransactionSecrets'],
): SessionRotationSecretsPort {
  if (typeof value === 'string') return createSessionRotationSecrets(value);
  if (value) return value;
  if (oidcValue && typeof (oidcValue as OidcTransactionSecretsConfig).hmacSecret === 'string') {
    return createSessionRotationSecrets((oidcValue as OidcTransactionSecretsConfig).hmacSecret);
  }
  return createSessionRotationSecrets(generateSessionTokenRaw());
}

/**
 * Fail-closed placeholder for compositions that omit legacy OIDC secret
 * material (Better Auth mode deliberately omits it). Constructing the unit of
 * work is always safe: non-OIDC identity work never touches this port. Any
 * actual OIDC transaction use throws a configuration error rather than
 * silently accepting or producing data under an implicit fixed test key.
 */
function createUnconfiguredOidcTransactionSecrets(): OidcTransactionSecretsPort {
  const configurationError = (): never => {
    throw new Error(
      'oidcTransactionSecrets is required: the legacy OIDC login transaction flow was composed without secret material',
    );
  };
  return Object.freeze({
    digestState: configurationError,
    digestNonce: configurationError,
    verifyStateDigest: configurationError,
    verifyNonceDigest: configurationError,
    encryptPkceVerifier: configurationError,
    decryptPkceVerifier: configurationError,
  });
}

function resolveOidcTransactionSecrets(
  value: PostgresIdentityUnitOfWorkOptions['oidcTransactionSecrets'],
): OidcTransactionSecretsPort {
  if (!value) return createUnconfiguredOidcTransactionSecrets();
  if (typeof (value as OidcTransactionSecretsPort).digestState === 'function') {
    return value as OidcTransactionSecretsPort;
  }
  return createOidcTransactionSecrets(value as OidcTransactionSecretsConfig);
}

function extractIdentityError(error: unknown): IdentityError | null {
  if (error instanceof IdentityError) return error;
  if (error instanceof DatabaseOperationError && error.cause instanceof IdentityError) {
    return error.cause;
  }
  if (typeof error === 'object' && error !== null && 'cause' in error) {
    return extractIdentityError((error as { cause: unknown }).cause);
  }
  return null;
}
