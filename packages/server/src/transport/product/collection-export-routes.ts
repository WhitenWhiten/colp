import type { FastifyInstance } from 'fastify';
import type { IdentityUnitOfWork } from '../../modules/identity/index.js';
import {
  ExportCollectionError,
  renderCollectionExport,
  type CollectionExportReadPort,
} from '../../modules/collections/application/export-collection.js';
import { ProductHttpError } from '../product-error.js';
import { requireSessionActor } from '../session-auth.js';

const ROUTE = '/api/v1/collections/:collectionId/export';
const OPAQUE_ID = /^[A-Za-z0-9._~-]{1,128}$/u;

export interface CollectionExportRouteDependencies {
  readonly identityUnitOfWork: IdentityUnitOfWork;
  readonly origin: string;
  readonly reads: CollectionExportReadPort;
}

export function registerCollectionExportRoutes(
  app: FastifyInstance,
  deps: CollectionExportRouteDependencies,
): void {
  app.get(ROUTE, {
    config: {
      productTransport: {
        allowedQuery: ['format'],
        rejectRequestBody: true,
        cacheControl: 'private-no-store',
      },
    },
  }, async (request, reply) => {
    const { account } = await requireSessionActor(request, deps.identityUnitOfWork, { touch: false });
    const collectionId = (request.params as { collectionId?: unknown }).collectionId;
    if (typeof collectionId !== 'string' || !OPAQUE_ID.test(collectionId)) throw notFound();
    const format = readFormat(request.query);
    const source = await deps.reads.loadForPrincipal({
      collectionId,
      subjectId: account.subjectId,
    });
    if (source === null) throw notFound();
    let rendered;
    try {
      rendered = renderCollectionExport(source, {
        principalId: account.id,
        origin: deps.origin,
        format,
      });
    } catch (error: unknown) {
      if (error instanceof ExportCollectionError && error.code === 'not_found') throw notFound();
      throw new ProductHttpError({
        statusCode: 500,
        code: 'internal_error',
        message: 'The request could not be completed.',
      });
    }
    return reply
      .code(200)
      .header('content-disposition', `attachment; filename="${rendered.filename}"`)
      .header('x-content-type-options', 'nosniff')
      .type(rendered.contentType)
      .send(rendered.body);
  });
}

function readFormat(query: unknown): 'html' | 'json' {
  if (typeof query !== 'object' || query === null) {
    throw invalidQuery('format must be html or json');
  }
  const format = (query as { format?: unknown }).format;
  if (format === 'html' || format === 'json') return format;
  throw invalidQuery('format must be html or json');
}

function notFound(): ProductHttpError {
  return new ProductHttpError({
    statusCode: 404,
    code: 'resource_not_found',
    message: 'Collection was not found.',
    recovery: 'none',
  });
}

function invalidQuery(message: string): ProductHttpError {
  return new ProductHttpError({
    statusCode: 400,
    code: 'invalid_query',
    message,
    recovery: 'same_request',
  });
}
