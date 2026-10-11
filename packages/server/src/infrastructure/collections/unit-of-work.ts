import type { Kysely } from 'kysely';
import {
  CollectionAuthorizationError,
  CollectionPreconditionError,
  CollectionsError,
  EditorAuthorizationError,
  EditorCursorError,
  EditorInputError,
  NodeConflictError,
  SnapshotExpiredError,
  type CollectionsEditorReadUnitOfWork,
  type CollectionsUnitOfWork,
  type CollectionsWritePorts,
  type GetCollectionEditorPagePorts,
  type ProductEditorCursorSignerPort,
} from '../../modules/collections/index.js';
import { createPostgresAccessPolicyFactsPort } from '../access-policy/index.js';
import { DatabaseOperationError } from '../database/errors.js';
import type { DatabaseSchema } from '../database/runtime.js';
import type { Metrics } from '../telemetry/index.js';
import {
  createUnitOfWork,
  type TransactionIsolationLevel,
  type UnitOfWorkOptions,
} from '../database/unit-of-work.js';
import { createPostgresCollectionEditorSnapshotPort } from './editor-query.js';
import { createPostgresBookmarkIconReadPort } from './bookmark-icon-postgres.js';
import {
  createPostgresCollectionWritePort,
  createPostgresCollectionsClock,
  createPostgresCollectionsWritePorts,
} from './repositories.js';

export interface PostgresCollectionsUnitOfWorkOptions {
  readonly isolationLevel?: TransactionIsolationLevel;
  readonly faultInjector?: UnitOfWorkOptions['faultInjector'];
  readonly metrics?: Metrics;
  readonly cancelBackend?: UnitOfWorkOptions['cancelBackend'];
}

/**
 * Collections module Unit of Work over PostgreSQL.
 * Each execute() opens one transaction and binds write ports (collection + node mutations).
 * Domain CollectionsError / auth / precondition / node conflict values are re-surfaced.
 */
export function createPostgresCollectionsUnitOfWork(
  db: Kysely<DatabaseSchema>,
  options: PostgresCollectionsUnitOfWorkOptions = {},
): CollectionsUnitOfWork {
  return {
    async execute<Result>(
      work: (ports: CollectionsWritePorts) => Promise<Result>,
      execution: { readonly signal?: AbortSignal } = {},
    ): Promise<Result> {
      try {
        return await createUnitOfWork(db, {
          isolationLevel: options.isolationLevel,
          faultInjector: options.faultInjector,
          signal: execution.signal,
          cancelBackend: options.cancelBackend,
        }).execute(({ transaction }) => {
          const ports = createPostgresCollectionsWritePorts(transaction, options.metrics);
          return work(ports);
        });
      } catch (error: unknown) {
        const domainError = extractCollectionsWriteError(error);
        if (domainError) throw domainError;
        throw error;
      }
    },
  };
}

export interface PostgresCollectionsEditorReadUnitOfWorkOptions {
  readonly cursorSigner: ProductEditorCursorSignerPort;
  /** Absolute first-page cursor TTL (defaults to 15 minutes in the application). */
  readonly cursorTtlMs?: number;
  readonly faultInjector?: UnitOfWorkOptions['faultInjector'];
  readonly metrics?: Metrics;
  readonly productOrigin?: string;
}

/**
 * Editor read UoW: each page uses a new REPEATABLE READ transaction (ADR-0004).
 * Domain editor errors are re-surfaced through DatabaseOperationError wrapping.
 */
export function createPostgresCollectionsEditorReadUnitOfWork(
  db: Kysely<DatabaseSchema>,
  options: PostgresCollectionsEditorReadUnitOfWorkOptions,
): CollectionsEditorReadUnitOfWork {
  const unitOfWork = createUnitOfWork(db, {
    isolationLevel: 'repeatable read',
    faultInjector: options.faultInjector,
  });

  return {
    async execute<Result>(
      work: (ports: GetCollectionEditorPagePorts) => Promise<Result>,
    ): Promise<Result> {
      try {
        return await unitOfWork.execute(({ transaction }) => {
          const collections = createPostgresCollectionWritePort(transaction, options.metrics);
          const ports: GetCollectionEditorPagePorts = {
            collections: {
              lockForShare: (collectionId) => collections.lockForShare(collectionId),
            },
            loadSnapshot: createPostgresCollectionEditorSnapshotPort(
              transaction,
              options.metrics,
            ),
            accessPolicy: createPostgresAccessPolicyFactsPort(transaction),
            clock: createPostgresCollectionsClock(transaction),
            cursorSigner: options.cursorSigner,
            cursorTtlMs: options.cursorTtlMs,
            bookmarkIcons: createPostgresBookmarkIconReadPort(transaction),
            ...(options.productOrigin === undefined ? {} : { productOrigin: options.productOrigin }),
          };
          return work(ports);
        });
      } catch (error: unknown) {
        const domainError = extractEditorDomainError(error);
        if (domainError) throw domainError;
        throw error;
      }
    },
  };
}

function extractCollectionsWriteError(error: unknown): Error | null {
  if (
    error instanceof CollectionsError
    || error instanceof CollectionAuthorizationError
    || error instanceof CollectionPreconditionError
    || error instanceof NodeConflictError
  ) {
    return error;
  }
  if (error instanceof DatabaseOperationError && error.cause instanceof Error) {
    return extractCollectionsWriteError(error.cause);
  }
  if (typeof error === 'object' && error !== null && 'cause' in error) {
    return extractCollectionsWriteError((error as { cause: unknown }).cause);
  }
  return null;
}

function extractEditorDomainError(error: unknown): Error | null {
  if (
    error instanceof EditorCursorError
    || error instanceof SnapshotExpiredError
    || error instanceof EditorAuthorizationError
    || error instanceof EditorInputError
    || error instanceof CollectionsError
  ) {
    return error;
  }
  if (error instanceof DatabaseOperationError && error.cause instanceof Error) {
    return extractEditorDomainError(error.cause);
  }
  if (typeof error === 'object' && error !== null && 'cause' in error) {
    return extractEditorDomainError((error as { cause: unknown }).cause);
  }
  return null;
}
