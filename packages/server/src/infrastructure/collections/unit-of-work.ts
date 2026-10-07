import { sql, type Kysely } from 'kysely';
import {
  CollectionAuthorizationError,
  CollectionChildrenCursorError,
  CollectionChildrenCursorExpiredError,
  CollectionChildrenInputError,
  CollectionPreconditionError,
  CollectionsError,
  EditorAuthorizationError,
  EditorCursorError,
  EditorInputError,
  NodeConflictError,
  SnapshotExpiredError,
  type CollectionChildrenReadUnitOfWork,
  type CollectionsEditorReadUnitOfWork,
  type CollectionsUnitOfWork,
  type CollectionsWritePorts,
  type GetCollectionEditorPagePorts,
  type ListCollectionChildrenPorts,
  type ProductEditorCursorSignerPort,
} from '../../modules/collections/index.js';
import { createPostgresAccessPolicyFactsPort } from '../access-policy/index.js';
import { accountRestrictPublicationExistsSql } from '../governance/collection-control-sql.js';
import { DatabaseOperationError } from '../database/errors.js';
import type { DatabaseSchema } from '../database/runtime.js';
import type { Metrics } from '../telemetry/index.js';
import {
  createUnitOfWork,
  type TransactionIsolationLevel,
  type UnitOfWorkOptions,
} from '../database/unit-of-work.js';
import { createPostgresCollectionEditorSnapshotPort } from './editor-query.js';
import { createPostgresCollectionChildrenPorts } from './collection-children-query.js';
import { createPostgresBookmarkIconReadPort } from './bookmark-icon-postgres.js';
import { createPostgresLinkPreviewReadPort } from './link-preview-read-postgres.js';
import { createPostgresFaviconSourceModeReadPort } from './favicon-source-postgres.js';
import {
  createPostgresCollectionWritePort,
  createPostgresCollectionsClock,
  createPostgresCollectionsWritePorts,
} from './repositories.js';
import type { CollectionChildrenCursorSignerPort } from '../../modules/collections/index.js';

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
  /** LP-04: attach `previewImage` (KNOWN_FEATURE_LINK_PREVIEW); off → null on every bookmark. */
  readonly linkPreviews?: boolean;
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
            ...(options.linkPreviews === true ? { linkPreviews: createPostgresLinkPreviewReadPort(transaction) } : {}),
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

export interface PostgresCollectionChildrenReadUnitOfWorkOptions {
  readonly cursorSigner: CollectionChildrenCursorSignerPort;
  readonly faultInjector?: UnitOfWorkOptions['faultInjector'];
  readonly metrics?: Metrics;
  readonly productOrigin?: string;
  readonly cancelBackend?: UnitOfWorkOptions['cancelBackend'];
  /** LP-04: attach `previewImage` (KNOWN_FEATURE_LINK_PREVIEW); off → null on every bookmark. */
  readonly linkPreviews?: boolean;
}

/**
 * FO-05 children read UoW: each page uses a new REPEATABLE READ transaction so
 * the cursor continuation rechecks current visibility and the content
 * revision fence, exactly like the Product Editor read path.
 */
export function createPostgresCollectionChildrenReadUnitOfWork(
  db: Kysely<DatabaseSchema>,
  options: PostgresCollectionChildrenReadUnitOfWorkOptions,
): CollectionChildrenReadUnitOfWork {
  return {
    async execute<Result>(
      work: (ports: ListCollectionChildrenPorts) => Promise<Result>,
      execution: { readonly signal?: AbortSignal } = {},
    ): Promise<Result> {
      try {
        return await createUnitOfWork(db, {
          isolationLevel: 'repeatable read',
          faultInjector: options.faultInjector,
          signal: execution.signal,
          cancelBackend: options.cancelBackend,
        }).execute(({ transaction }) => {
          const collections = createPostgresCollectionWritePort(transaction, options.metrics);
          const ports: ListCollectionChildrenPorts = {
            collections: {
              lockForShare: (collectionId) => collections.lockForShare(collectionId),
            },
            children: createPostgresCollectionChildrenPorts(transaction),
            publicControls: {
              async isCollectionHiddenPublic(collectionId) {
                const result = await sql<{ hidden: boolean }>`
                  select (
                    exists (
                      select 1 from moderation_actions ma
                       where ma.target_kind = 'collection'
                         and ma.target_id = ${collectionId}
                         and ma.state = 'active'
                         and ma.action = 'hide_public'
                    ) or exists (
                      select 1 from collections c
                      join accounts oa on oa.subject_id = c.owner_subject_id
                      where c.id = ${collectionId}
                        and ${sql.raw(accountRestrictPublicationExistsSql('oa.id'))}
                    )
                  ) as hidden
                `.execute(transaction);
                return result.rows[0]?.hidden === true;
              },
            },
            accessPolicy: createPostgresAccessPolicyFactsPort(transaction),
            clock: createPostgresCollectionsClock(transaction),
            cursorSigner: options.cursorSigner,
            bookmarkIcons: createPostgresBookmarkIconReadPort(transaction),
            faviconSources: createPostgresFaviconSourceModeReadPort(transaction),
            ...(options.linkPreviews === true ? { linkPreviews: createPostgresLinkPreviewReadPort(transaction) } : {}),
            ...(options.productOrigin === undefined ? {} : { productOrigin: options.productOrigin }),
          };
          return work(ports);
        });
      } catch (error: unknown) {
        const domainError = extractChildrenDomainError(error);
        if (domainError) throw domainError;
        throw error;
      }
    },
  };
}

function extractChildrenDomainError(error: unknown): Error | null {
  if (
    error instanceof CollectionChildrenInputError
    || error instanceof CollectionChildrenCursorError
    || error instanceof CollectionChildrenCursorExpiredError
    || error instanceof SnapshotExpiredError
    || error instanceof CollectionAuthorizationError
    || error instanceof CollectionsError
  ) {
    return error;
  }
  if (error instanceof DatabaseOperationError && error.cause instanceof Error) {
    return extractChildrenDomainError(error.cause);
  }
  if (typeof error === 'object' && error !== null && 'cause' in error) {
    return extractChildrenDomainError((error as { cause: unknown }).cause);
  }
  return null;
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
