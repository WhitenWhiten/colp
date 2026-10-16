import type { FastifyInstance } from 'fastify';
import { changeFolderShare, readFolderShare, FolderShareError } from '../../modules/publication/application/folder-shares.js';
import { canonicalCommandFingerprint } from '../../modules/commands/index.js';
import { ProductHttpError } from '../product-error.js';
import { productRouteMetadata } from '../product-route-manifest.js';
import { requireMutationActor } from '../mutation-actor.js';
import { requireSessionActor } from '../session-auth.js';
import { sendProductCommandReceiptOutcome } from '../product-command-mapping.js';
import { httpCommandScopeV1 } from '../http-command-scope.js';
import { readCollectionIdParam, readNodeIdParam, readKnownCommandId, type CollectionRoutesDeps } from './collection-route-helpers.js';

const ROUTE = '/api/v1/collections/:collectionId/nodes/:nodeId/share';
export function registerFolderShareRoutes(app: FastifyInstance, deps: CollectionRoutesDeps): void {
  for (const method of ['GET', 'PUT', 'DELETE'] as const) app.route({ method, url: ROUTE,
    config: { ...productRouteMetadata(method, ROUTE), productTransport: {
      allowedQuery: [], cacheControl: 'private-no-store',
      ...(method === 'PUT' ? { acceptedMediaTypes: ['application/json'], bodyLimitBytes: 1024 } : {}),
    } },
    async handler(request, reply) {
      const { account } = method === 'GET'
        ? await requireSessionActor(request, deps.identityUnitOfWork, { touch: false })
        : await requireMutationActor(request, { identityUnitOfWork: deps.identityUnitOfWork, allowedOrigins: deps.config.allowedOrigins });
      const collectionId = readCollectionIdParam(request), nodeId = readNodeIdParam(request);
      const commandId = method === 'GET' ? undefined : readKnownCommandId(request);
      if (method === 'PUT' && (request.body === null || typeof request.body !== 'object'
        || Array.isArray(request.body) || Object.keys(request.body).length > 0)) {
        throw new ProductHttpError({ statusCode: 422, code: 'invalid_document', message: 'Share accepts an empty object.' });
      }
      if (!deps.folderShares) throw new ProductHttpError({ statusCode: 503, code: 'feature_temporarily_unavailable', message: 'Folder sharing is unavailable. Try again later.' });
      try {
        if (method === 'GET') return reply.send(await deps.folderShares.execute(ports => readFolderShare(ports, { collectionId, nodeId, ownerSubjectId: account.subjectId })));
        const route = `/api/v1/collections/${collectionId}/nodes/${nodeId}/share`;
        const outcome = await deps.folderShares.execute(ports => changeFolderShare(ports, { collectionId, nodeId,
          ownerSubjectId: account.subjectId, action: method === 'PUT' ? 'share' : 'revoke',
          binding: { principalId: account.id, commandId: commandId!, commandScope: httpCommandScopeV1(method, route) },
          fingerprint: canonicalCommandFingerprint({ method, route, mediaType: method === 'PUT' ? 'application/json' : '', body: request.body }),
        }));
        return sendProductCommandReceiptOutcome(reply, outcome.kind === 'replay' ? { kind: 'replay', ...outcome.result } : outcome);
      } catch (error) {
        if (error instanceof FolderShareError) throw new ProductHttpError({ code: error.code,
          statusCode: error.code === 'resource_not_found' ? 404 : error.code === 'publication_slug_conflict' ? 409 : 422, message: error.message });
        throw error;
      }
    },
  });
}
