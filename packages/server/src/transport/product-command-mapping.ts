import type { FastifyReply } from 'fastify';
import { DatabaseOperationError } from '../infrastructure/database/errors.js';
import {
  CollectionAuthorizationError,
  CollectionPreconditionError,
  CollectionsError,
  DeleteSubtreeLimitError,
  NodeConflictError,
  SnapshotTreeCapacityError,
} from '../modules/collections/index.js';
import {
  ProductHttpError,
  type ProductFieldError,
} from './product-error.js';

export type ProductCommandReceiptOutcome =
  | {
      readonly kind: 'replay';
      readonly status: number;
      readonly body: Uint8Array;
      readonly stableHeaders: Readonly<Record<string, string>>;
      readonly mediaType: string;
    }
  | { readonly kind: 'in_progress'; readonly retryAfterSeconds: number }
  | { readonly kind: 'reused' }
  | { readonly kind: 'expired' };

export type CollectionMutationErrorProfile =
  | 'collection-create'
  | 'collection-update'
  | 'node-create'
  | 'node-update-or-move'
  | 'node-delete';

/** Sends only command-receipt outcomes shared by every mutation endpoint. */
export function sendProductCommandReceiptOutcome(
  reply: FastifyReply,
  outcome: ProductCommandReceiptOutcome,
): FastifyReply {
  switch (outcome.kind) {
    case 'replay': {
      for (const [name, value] of Object.entries(outcome.stableHeaders)) {
        reply.header(name, value);
      }
      const stableContentType = Object.entries(outcome.stableHeaders)
        .find(([name]) => name.toLowerCase() === 'content-type')?.[1];
      return reply
        .code(outcome.status)
        .type(stableContentType ?? outcome.mediaType)
        .send(Buffer.from(outcome.body));
    }
    case 'in_progress':
      throw new ProductHttpError({
        statusCode: 409,
        code: 'command_in_progress',
        message: 'A command with this id is still in progress.',
        recovery: 'same_request',
        sameRequestRetrySafe: true,
        retryAfterSeconds: outcome.retryAfterSeconds,
        headers: { 'Retry-After': String(outcome.retryAfterSeconds) },
      });
    case 'reused':
      throw new ProductHttpError({
        statusCode: 409,
        code: 'command_id_reused',
        message: 'This command id was already used with a different request.',
        recovery: 'user_action',
      });
    case 'expired':
      throw new ProductHttpError({
        statusCode: 410,
        code: 'command_result_expired',
        message: 'The stored result for this command has expired.',
        recovery: 'user_action',
      });
  }
}

export function mapCollectionMutationError(error: unknown): ProductHttpError | null {
  if (error instanceof ProductHttpError) return error;
  if (error instanceof CollectionAuthorizationError) {
    return mapAuthorizationOutcome(error.outcome);
  }
  if (error instanceof CollectionPreconditionError) {
    return new ProductHttpError({
      statusCode: 412,
      code: 'precondition_failed',
      message: clampMessage(error.message, 512)
        || 'The resource ETag does not match the current representation.',
      recovery: 'refresh_and_retry',
      precondition: error.precondition,
      currentEtag: error.currentEtag,
    });
  }
  if (error instanceof NodeConflictError) return mapNodeConflictError(error);
  if (error instanceof DeleteSubtreeLimitError || error instanceof SnapshotTreeCapacityError) {
    return new ProductHttpError({
      statusCode: 413,
      code: error.code,
      message: error.message,
    });
  }
  if (error instanceof CollectionsError) return mapCollectionsError(error);
  return null;
}

export function rethrowCollectionMutationError(
  error: unknown,
  profile: CollectionMutationErrorProfile,
): never {
  if (profile === 'collection-update' && isPublicationSlugConflict(error)) {
    throw new ProductHttpError({
      statusCode: 409,
      code: 'publication_slug_conflict',
      message: 'This publication slug is already in use. Choose another slug.',
      recovery: 'user_action',
    });
  }
  const mapped = errorAllowedByProfile(error, profile)
    ? mapCollectionMutationError(error)
    : null;
  throw mapped ?? error;
}

function isPublicationSlugConflict(error: unknown): boolean {
  return error instanceof DatabaseOperationError
    && error.kind === 'unique_violation'
    && error.constraint === 'collections_publication_slug_unique';
}

function errorAllowedByProfile(
  error: unknown,
  profile: CollectionMutationErrorProfile,
): boolean {
  if (error instanceof ProductHttpError || error instanceof CollectionsError) return true;
  if (profile === 'collection-create') return false;
  if (error instanceof CollectionAuthorizationError) return true;
  if (profile === 'collection-update') {
    return error instanceof CollectionPreconditionError;
  }
  if (error instanceof NodeConflictError) return true;
  if (error instanceof SnapshotTreeCapacityError) return true;
  if (profile === 'node-create') return false;
  if (error instanceof CollectionPreconditionError) return true;
  return profile === 'node-delete' && error instanceof DeleteSubtreeLimitError;
}

export function mapAuthorizationOutcome(
  outcome: 'conceal' | 'deny',
): ProductHttpError {
  if (outcome === 'conceal') {
    return new ProductHttpError({
      statusCode: 404,
      code: 'resource_not_found',
      message: 'The requested resource was not found.',
      recovery: 'none',
    });
  }
  return new ProductHttpError({
    statusCode: 403,
    code: 'insufficient_permission',
    message: 'You do not have permission to perform this action.',
    recovery: 'user_action',
  });
}

export function mapProductDatabaseError(error: DatabaseOperationError): ProductHttpError {
  if (
    error.kind === 'serialization_failure'
    || error.kind === 'deadlock'
    || error.kind === 'lock_timeout'
    || error.kind === 'unavailable'
  ) {
    return new ProductHttpError({
      statusCode: 503,
      code: 'feature_temporarily_unavailable',
      message: 'The service is temporarily unavailable. Please retry the request.',
      recovery: 'same_request',
      sameRequestRetrySafe: true,
      retryAfterSeconds: 1,
      headers: { 'Retry-After': '1' },
    });
  }
  return new ProductHttpError({
    statusCode: 500,
    code: 'internal_error',
    message: 'The request could not be completed.',
    recovery: 'same_request',
  });
}

export function mapCollectionsError(error: CollectionsError): ProductHttpError {
  if (
    error.code === 'invalid_node_input'
    && /If-Content-Match is not allowed/i.test(error.message)
  ) {
    return new ProductHttpError({
      statusCode: 400,
      code: 'invalid_request',
      message: clampMessage(error.message, 512)
        || 'If-Content-Match is not allowed on non-recursive delete.',
    });
  }
  if (
    error.code === 'invalid_node_input'
    && /If-Content-Match is required/i.test(error.message)
  ) {
    return new ProductHttpError({
      statusCode: 428,
      code: 'precondition_required',
      message: clampMessage(error.message, 512)
        || 'If-Content-Match is required when recursive=true.',
      recovery: 'refresh_and_retry',
      precondition: 'content',
    });
  }

  return invalidDocument(
    clampMessage(error.message, 512) || 'The request document is invalid.',
    fieldErrorsForCollectionsError(error),
  );
}

function mapNodeConflictError(error: NodeConflictError): ProductHttpError {
  const mapping = {
    root_immutable: ['Root nodes are immutable through Product Node operations.', 'none'],
    folder_not_empty: ['Folder has live children; set recursive=true to delete the subtree.', 'user_action'],
    revision_conflict: ['A parent children revision no longer matches the expected base.', 'refresh_and_retry'],
    position_context_stale: ['Position anchors are no longer valid for this parent.', 'refresh_and_retry'],
  } as const;
  const [fallback, recovery] = mapping[error.code];
  return new ProductHttpError({
    statusCode: 409,
    code: error.code,
    message: clampMessage(error.message, 512) || fallback,
    recovery,
  });
}

function fieldErrorsForCollectionsError(error: CollectionsError): ProductFieldError[] {
  const message = clampMessage(error.message, 256) || 'Invalid value.';
  if (/publicationSlug/u.test(error.message)) {
    return [{ path: '/publicationSlug', code: error.code, message }];
  }
  switch (error.code) {
    case 'invalid_collection_title':
      return [{ path: '/title', code: error.code, message }];
    case 'invalid_collection_summary':
      return [{ path: '/summary', code: error.code, message }];
    case 'invalid_collection_kind':
      return [{ path: '/kind', code: error.code, message }];
    case 'invalid_node_title':
      return [{ path: '/title', code: error.code, message }];
    case 'invalid_node_url':
      return [{ path: '/url', code: error.code, message }];
    case 'invalid_node_description':
      return [{ path: '/description', code: error.code, message }];
    case 'invalid_node_tags':
      return [{ path: '/tags', code: error.code, message }];
    case 'invalid_node_visibility':
      return [{ path: '/visibility', code: error.code, message }];
    case 'invalid_node_kind':
      return [{ path: '/kind', code: error.code, message }];
    case 'invalid_node_parent':
      return [{
        path: /newParent|source parent|descendant|cycle/i.test(error.message)
          ? '/newParentId'
          : '/parentId',
        code: error.code,
        message,
      }];
    case 'invalid_node_anchor':
      return [{ path: '/afterId', code: error.code, message }];
    case 'invalid_node_delete':
      return [{ path: '/recursive', code: error.code, message }];
    default:
      return [];
  }
}

function invalidDocument(
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

function clampMessage(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}
