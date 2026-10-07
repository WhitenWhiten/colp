import type { FastifyInstance } from 'fastify';
import {
  CollectionsError,
  EDITOR_PAGE_MAX_LIMIT,
  EditorAuthorizationError,
  EditorCursorError,
  EditorInputError,
  SnapshotExpiredError,
  getCollectionEditorPage,
  type EditorPage,
} from '../../modules/collections/index.js';
import {
  readCollectionIdParam,
  type CollectionRoutesDeps,
} from './collection-route-helpers.js';
import {
  mapAuthorizationOutcome,
  mapCollectionsError,
} from '../product-command-mapping.js';
import { ProductHttpError } from '../product-error.js';
import { productRouteMetadata } from '../product-route-manifest.js';
import { requireSessionActor } from '../session-auth.js';

const EDITOR_ROUTE = '/api/v1/collections/:collectionId/editor';

export function registerEditorRoutes(
  app: FastifyInstance,
  deps: CollectionRoutesDeps,
): void {
  if (!deps.collectionsEditorReadUnitOfWork) return;

  const editorRead = deps.collectionsEditorReadUnitOfWork;
  app.get(EDITOR_ROUTE, {
    config: {
      ...productRouteMetadata('GET', EDITOR_ROUTE),
      productTransport: {
        allowedQuery: ['limit', 'cursor'],
        cacheControl: 'private-no-store',
      },
    },
  }, async (request, reply) => {
    // Session required; GET has no CSRF requirement.
    const actor = await requireSessionActor(
      request,
      deps.identityUnitOfWork,
      { touch: false },
    );
    const { account } = actor;
    if ('session' in actor) reply.header('Known-Editor-Session', actor.session.id);

    const collectionId = readCollectionIdParam(request);
    const paging = parseEditorPagingQuery(request.query as Record<string, string>);

    let page: EditorPage;
    try {
      page = await editorRead.execute((ports) =>
        getCollectionEditorPage(ports, {
          collectionId,
          actor: {
            principalId: account.id,
            subjectId: account.subjectId,
          },
          limit: paging.limit,
          cursor: paging.cursor,
        }));
    } catch (error: unknown) {
      if (error instanceof ProductHttpError) throw error;
      throw mapEditorError(error);
    }

    return reply
      .code(200)
      .type('application/json; charset=utf-8')
      .send(page);
  });
}

/**
 * Enforces mutual exclusion: cursor present -> limit must be omitted.
 * limit alone defaults in the application when omitted entirely.
 */
function parseEditorPagingQuery(query: Record<string, string>): {
  readonly limit?: number;
  readonly cursor?: string;
} {
  const hasLimit = Object.hasOwn(query, 'limit');
  const hasCursor = Object.hasOwn(query, 'cursor');

  if (hasLimit && hasCursor) {
    throw new ProductHttpError({
      statusCode: 400,
      code: 'invalid_query',
      message: 'limit and cursor are mutually exclusive.',
    });
  }

  if (hasCursor) {
    const cursor = query.cursor;
    if (typeof cursor !== 'string' || cursor.length < 1) {
      throw new ProductHttpError({
        statusCode: 400,
        code: 'invalid_cursor',
        message: 'The editor cursor is invalid.',
        recovery: 'restart_from_first_page',
      });
    }
    return { cursor };
  }

  if (hasLimit) {
    const raw = query.limit;
    if (typeof raw !== 'string' || !/^[1-9][0-9]*$/.test(raw)) {
      throw new ProductHttpError({
        statusCode: 400,
        code: 'invalid_query',
        message: 'limit must be a positive integer.',
      });
    }
    const limit = Number(raw);
    if (!Number.isInteger(limit) || limit < 1 || limit > EDITOR_PAGE_MAX_LIMIT) {
      throw new ProductHttpError({
        statusCode: 400,
        code: 'invalid_query',
        message: `limit must be an integer between 1 and ${EDITOR_PAGE_MAX_LIMIT}.`,
      });
    }
    return { limit };
  }

  return {};
}

function mapEditorError(error: unknown): ProductHttpError {
  if (error instanceof EditorCursorError) {
    return new ProductHttpError({
      statusCode: 400,
      code: 'invalid_cursor',
      message: 'The editor cursor is invalid.',
      recovery: 'restart_from_first_page',
    });
  }
  if (error instanceof SnapshotExpiredError) {
    return new ProductHttpError({
      statusCode: 409,
      code: 'snapshot_expired',
      message: 'The editor snapshot has expired.',
      recovery: 'restart_from_first_page',
    });
  }
  if (error instanceof EditorAuthorizationError) {
    return mapAuthorizationOutcome(error.outcome);
  }
  if (error instanceof EditorInputError) {
    return new ProductHttpError({
      statusCode: 400,
      code: 'invalid_query',
      message: clampMessage(error.message, 512) || 'The query is invalid.',
    });
  }
  if (error instanceof CollectionsError) {
    return mapCollectionsError(error);
  }
  throw error;
}

function clampMessage(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, max);
}
