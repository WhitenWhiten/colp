import type { FastifyInstance, FastifyReply } from 'fastify';
import { canonicalCommandFingerprint } from '../../modules/commands/index.js';
import {
  getCollectionCatalog,
  getReportCatalog,
  GovernanceCatalogError,
  parseCatalogPatch,
  updateCollectionCatalog,
  updateReportCatalog,
} from '../../modules/governance/index.js';
import { ReportsApplicationError } from '../../modules/reports/index.js';
import { httpCommandScopeV1 } from '../http-command-scope.js';
import { requireMutationActor } from '../mutation-actor.js';
import {
  mapCollectionMutationError,
  rethrowCollectionMutationError,
  sendProductCommandReceiptOutcome,
} from '../product-command-mapping.js';
import { ProductHttpError } from '../product-error.js';
import { productRouteMetadata } from '../product-route-manifest.js';
import { requireSessionActor } from '../session-auth.js';
import {
  readCollectionIdParam,
  readKnownCommandId,
  readRequiredIfMatch,
  requireProductCollectionMutationUnitOfWork,
  type CollectionRoutesDeps,
} from './collection-route-helpers.js';
import type { ReportRoutesDependencies } from './report-route-contract.js';
import { mapReportError, mutationActor, requireReportUnitOfWork, sendReportOutcome, sessionActor } from './report-route-helpers.js';

const COLLECTION_CATALOG = '/api/v1/collections/:collectionId/catalog';
const REPORT_CATALOG = '/api/v1/reports/:reportId/catalog';
const BODY_LIMIT = 32_768;

function featureOff(): never {
  throw new ProductHttpError({
    statusCode: 404,
    code: 'resource_not_found',
    message: 'The requested resource was not found.',
    recovery: 'none',
  });
}

function mapCatalogError(error: unknown): never {
  if (error instanceof GovernanceCatalogError) {
    throw new ProductHttpError({
      statusCode: 400,
      code: error.code,
      message: error.message,
    });
  }
  const mapped = mapCollectionMutationError(error);
  if (mapped) throw mapped;
  throw error;
}

function sendCatalog(reply: FastifyReply, catalog: {
  readonly tags: readonly string[];
  readonly language: string | null;
  readonly revision: string;
  readonly etag: string;
}): FastifyReply {
  return reply.code(200)
    .header('etag', catalog.etag)
    .header('cache-control', 'private, no-store')
    .send({ tags: [...catalog.tags], language: catalog.language, revision: catalog.revision });
}

export function registerCollectionCatalogRoutes(
  app: FastifyInstance,
  deps: CollectionRoutesDeps,
): void {
  const enabled = deps.config.contentGovernance.enabled;
  app.get(COLLECTION_CATALOG, {
    exposeHeadRoute: false,
    config: {
      ...productRouteMetadata('GET', COLLECTION_CATALOG),
      productTransport: {
        allowedQuery: [],
        cacheControl: 'private-no-store',
        rejectRequestBody: true,
      },
    },
  }, async (request, reply) => {
    if (!enabled) featureOff();
    const { account } = await requireSessionActor(request, deps.identityUnitOfWork, { touch: false });
    const collectionId = readCollectionIdParam(request);
    try {
      const catalog = await deps.collectionsUnitOfWork.execute((ports) =>
        getCollectionCatalog({
          collections: ports.collections,
          accessPolicy: ports.accessPolicyFacts,
        }, {
          actor: { principalId: account.id, subjectId: account.subjectId },
          collectionId,
        }));
      return sendCatalog(reply, catalog);
    } catch (error: unknown) {
      mapCatalogError(error);
    }
  });

  app.patch(COLLECTION_CATALOG, {
    config: {
      ...productRouteMetadata('PATCH', COLLECTION_CATALOG),
      productTransport: {
        allowedQuery: [],
        acceptedMediaTypes: ['application/merge-patch+json'],
        bodyLimitBytes: BODY_LIMIT,
        cacheControl: 'private-no-store',
      },
    },
  }, async (request, reply) => {
    if (!enabled) featureOff();
    const { account } = await requireMutationActor(request, {
      identityUnitOfWork: deps.identityUnitOfWork,
      allowedOrigins: deps.config.allowedOrigins,
    });
    const collectionId = readCollectionIdParam(request);
    const commandId = readKnownCommandId(request);
    const ifMatch = readRequiredIfMatch(request);
    let patch;
    try {
      patch = parseCatalogPatch(request.body);
    } catch (error: unknown) {
      mapCatalogError(error);
    }
    const routeIdentity = `/api/v1/collections/${collectionId}/catalog`;
    const fingerprint = canonicalCommandFingerprint({
      method: 'PATCH',
      route: routeIdentity,
      mediaType: 'application/merge-patch+json',
      body: patch,
      query: {},
      conditions: { ifMatch },
    });
    try {
      const outcome = await requireProductCollectionMutationUnitOfWork(deps).execute((ports) =>
        updateCollectionCatalog(ports, {
          actor: { principalId: account.id, subjectId: account.subjectId },
          collectionId,
          commandId,
          fingerprint,
          commandScope: httpCommandScopeV1('PATCH', routeIdentity),
          ifMatch,
          patch,
        }));
      if (outcome.kind !== 'updated') return sendProductCommandReceiptOutcome(reply, outcome);
      return sendCatalog(reply, outcome.catalog);
    } catch (error: unknown) {
      rethrowCollectionMutationError(error, 'collection-update');
    }
  });
}

export function registerReportCatalogRoutes(
  app: FastifyInstance,
  deps: ReportRoutesDependencies,
): void {
  const enabled = deps.config.contentGovernance.enabled;
  app.get(REPORT_CATALOG, {
    exposeHeadRoute: false,
    config: {
      ...productRouteMetadata('GET', REPORT_CATALOG),
      productTransport: {
        allowedQuery: [],
        cacheControl: 'private-no-store',
        rejectRequestBody: true,
      },
    },
  }, async (request, reply) => {
    if (!enabled || !deps.config.reports.enabled) featureOff();
    const actor = await sessionActor(request, deps);
    const params = request.params as { reportId?: string };
    const reportId = params.reportId;
    if (typeof reportId !== 'string' || reportId.length === 0) {
      throw new ProductHttpError({ statusCode: 400, code: 'invalid_request', message: 'reportId is required.' });
    }
    try {
      const catalog = await getReportCatalog(requireReportUnitOfWork(deps), { actor, reportId });
      return sendCatalog(reply, catalog);
    } catch (error: unknown) {
      if (error instanceof ReportsApplicationError) throw mapReportError(error);
      mapCatalogError(error);
    }
  });

  app.patch(REPORT_CATALOG, {
    config: {
      ...productRouteMetadata('PATCH', REPORT_CATALOG),
      productTransport: {
        allowedQuery: [],
        acceptedMediaTypes: ['application/merge-patch+json'],
        bodyLimitBytes: BODY_LIMIT,
        cacheControl: 'private-no-store',
      },
    },
  }, async (request, reply) => {
    if (!enabled || !deps.config.reports.enabled) featureOff();
    const actor = await mutationActor(request, deps);
    const params = request.params as { reportId?: string };
    const reportId = params.reportId;
    if (typeof reportId !== 'string' || reportId.length === 0) {
      throw new ProductHttpError({ statusCode: 400, code: 'invalid_request', message: 'reportId is required.' });
    }
    const commandId = readKnownCommandId(request);
    const ifMatch = readRequiredIfMatch(request);
    let patch;
    try {
      patch = parseCatalogPatch(request.body);
    } catch (error: unknown) {
      mapCatalogError(error);
    }
    const routeIdentity = `/api/v1/reports/${reportId}/catalog`;
    const fingerprint = canonicalCommandFingerprint({
      method: 'PATCH',
      route: routeIdentity,
      mediaType: 'application/merge-patch+json',
      body: patch,
      query: {},
      conditions: { ifMatch },
    });
    try {
      const outcome = await updateReportCatalog(requireReportUnitOfWork(deps), {
        actor,
        reportId,
        commandId,
        fingerprint,
        commandScope: httpCommandScopeV1('PATCH', routeIdentity),
        ifMatch,
        patch,
      });
      if (outcome.kind !== 'succeeded') return sendReportOutcome(reply, outcome);
      return sendCatalog(reply, outcome.value);
    } catch (error: unknown) {
      if (error instanceof ReportsApplicationError) throw mapReportError(error);
      mapCatalogError(error);
    }
  });
}
