import type { FastifyRequest } from 'fastify';
import type { AppConfig } from '../../bootstrap/config.js';
import type {
  CollectionsEditorReadUnitOfWork,
  AnnotationMutationUnitOfWork,
  AnnotationReadUnitOfWork,
  RelationMutationUnitOfWork,
  RelationReadUnitOfWork,
  CollectionsUnitOfWork,
  ProductCollectionMutationUnitOfWork,
  CollectionListBookmarkCountsPort,
  GetOwnedCollectionsPagePorts,
} from '../../modules/collections/index.js';
import { assertCanonicalCommandId } from '../../modules/commands/index.js';
import type { IdentityUnitOfWork } from '../../modules/identity/index.js';
import { ProductHttpError, type ProductFieldError } from '../product-error.js';

const STRONG_ENTITY_TAG = /^"[^"\r\n]+"$/;

export interface CollectionRoutesDeps {
  readonly config: AppConfig;
  readonly identityUnitOfWork: IdentityUnitOfWork;
  readonly collectionsUnitOfWork: CollectionsUnitOfWork;
  readonly productCollectionMutationUnitOfWork?: ProductCollectionMutationUnitOfWork;
  readonly collectionMetadataMutationsEnabled: boolean;
  readonly collectionsEditorReadUnitOfWork?: CollectionsEditorReadUnitOfWork;
  readonly annotationMutationUnitOfWork?: AnnotationMutationUnitOfWork;
  readonly annotationReadUnitOfWork?: AnnotationReadUnitOfWork;
  readonly relationMutationUnitOfWork?: RelationMutationUnitOfWork;
  readonly relationReadUnitOfWork?: RelationReadUnitOfWork;
  readonly ownedCollectionsQuery?: GetOwnedCollectionsPagePorts;
  readonly bookmarkCounts?: CollectionListBookmarkCountsPort;
}

export function requireProductCollectionMutationUnitOfWork(
  deps: CollectionRoutesDeps,
): ProductCollectionMutationUnitOfWork {
  if (!deps.productCollectionMutationUnitOfWork) {
    throw new Error('Product collection canonical mutation unit of work is not configured');
  }
  return deps.productCollectionMutationUnitOfWork;
}

export function readCollectionIdParam(request: FastifyRequest): string {
  const params = request.params as { collectionId?: string };
  const collectionId = params.collectionId;
  if (typeof collectionId !== 'string' || collectionId.trim().length === 0) {
    throw new ProductHttpError({
      statusCode: 400,
      code: 'invalid_request',
      message: 'collectionId path parameter is required.',
    });
  }
  return collectionId;
}

export function readNodeIdParam(request: FastifyRequest): string {
  const params = request.params as { nodeId?: string };
  const nodeId = params.nodeId;
  if (typeof nodeId !== 'string' || nodeId.trim().length === 0) {
    throw new ProductHttpError({
      statusCode: 400,
      code: 'invalid_request',
      message: 'nodeId path parameter is required.',
    });
  }
  return nodeId;
}

export function readKnownCommandId(request: FastifyRequest): string {
  const raw = request.headers['known-command-id'];
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new ProductHttpError({
      statusCode: 400,
      code: 'invalid_request',
      message: 'Known-Command-Id header is required.',
    });
  }
  try {
    return assertCanonicalCommandId(raw);
  } catch {
    throw new ProductHttpError({
      statusCode: 400,
      code: 'invalid_request',
      message: 'Known-Command-Id must be a canonical lowercase UUID v4.',
    });
  }
}

export function readRequiredIfMatch(request: FastifyRequest): string {
  const raw = request.headers['if-match'];
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new ProductHttpError({
      statusCode: 428,
      code: 'precondition_required',
      message: 'If-Match is required for this operation.',
      recovery: 'refresh_and_retry',
      precondition: 'resource',
    });
  }
  if (!STRONG_ENTITY_TAG.test(raw)) {
    throw new ProductHttpError({
      statusCode: 400,
      code: 'invalid_request',
      message: 'If-Match must be a single strong entity-tag.',
    });
  }
  return raw;
}

export function invalidDocument(
  message: string,
  fieldErrors: readonly ProductFieldError[] = [],
): ProductHttpError {
  return new ProductHttpError({
    statusCode: 422,
    code: 'invalid_document',
    message,
    recovery: 'user_action',
    fieldErrors,
  });
}
