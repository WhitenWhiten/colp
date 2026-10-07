import type { FastifyInstance, FastifyReply } from 'fastify';
import { canonicalCommandFingerprint } from '../../modules/commands/index.js';
import {
  getCatalogPreferences,
  GovernanceCatalogError,
  parseCatalogPreferencesPatch,
  updateCatalogPreferences,
  type CatalogPreferencesPorts,
  type CatalogPreferencesStore,
} from '../../modules/governance/index.js';
import { strongEntityTag } from '../../modules/collections/index.js';
import { httpCommandScopeV1 } from '../http-command-scope.js';
import { requireMutationActor } from '../mutation-actor.js';
import {
  mapCollectionMutationError,
  mapProductDatabaseError,
  sendProductCommandReceiptOutcome,
} from '../product-command-mapping.js';
import { DatabaseOperationError } from '../../infrastructure/database/errors.js';
import { ProductHttpError } from '../product-error.js';
import { productRouteMetadata } from '../product-route-manifest.js';
import { requireSessionActor } from '../session-auth.js';
import { readKnownCommandId, readRequiredIfMatch } from './collection-route-helpers.js';
import type { IdentityUnitOfWork } from '../../modules/identity/index.js';
import type { AppConfig } from '../../bootstrap/config.js';

const ROUTE = '/api/v1/me/catalog-preferences';
const BODY_LIMIT = 262_144;

export interface CatalogPreferencesRoutesDeps {
  readonly config: AppConfig;
  readonly identityUnitOfWork: IdentityUnitOfWork;
  readonly queryStore: CatalogPreferencesStore;
  readonly commandUnitOfWork: {
    execute<Result>(work: (ports: CatalogPreferencesPorts) => Promise<Result>): Promise<Result>;
  };
}

function featureOff(): never {
  throw new ProductHttpError({
    statusCode: 404,
    code: 'resource_not_found',
    message: 'The requested resource was not found.',
    recovery: 'none',
  });
}

function mapError(error: unknown): never {
  if (error instanceof GovernanceCatalogError) {
    throw new ProductHttpError({ statusCode: 400, code: error.code, message: error.message });
  }
  if (error instanceof DatabaseOperationError) throw mapProductDatabaseError(error);
  const mapped = mapCollectionMutationError(error);
  if (mapped) throw mapped;
  throw error;
}

function sendView(reply: FastifyReply, view: {
  readonly hiddenOwnerAccountIds: readonly string[];
  readonly hiddenTags: readonly string[];
  readonly hiddenTitleKeywords: readonly string[];
  readonly preferredLanguages: readonly string[];
  readonly revision: string;
  readonly updatedAt: string;
}): FastifyReply {
  return reply.code(200)
    .header('etag', strongEntityTag(view.revision))
    .header('cache-control', 'private, no-store')
    .send({
      hiddenOwnerAccountIds: [...view.hiddenOwnerAccountIds],
      hiddenTags: [...view.hiddenTags],
      hiddenTitleKeywords: [...view.hiddenTitleKeywords],
      preferredLanguages: [...view.preferredLanguages],
      revision: view.revision,
      updatedAt: view.updatedAt,
    });
}

export function registerCatalogPreferenceRoutes(
  app: FastifyInstance,
  deps: CatalogPreferencesRoutesDeps,
): void {
  const enabled = deps.config.contentGovernance.enabled;
  app.get(ROUTE, {
    exposeHeadRoute: false,
    config: {
      ...productRouteMetadata('GET', ROUTE),
      productTransport: {
        allowedQuery: [],
        cacheControl: 'private-no-store',
        rejectRequestBody: true,
      },
    },
  }, async (request, reply) => {
    if (!enabled) featureOff();
    const { account } = await requireSessionActor(request, deps.identityUnitOfWork, { touch: false });
    const view = await getCatalogPreferences(deps.queryStore, {
      principalId: account.id,
      accountId: account.id,
      createdAt: account.createdAt,
    });
    return sendView(reply, view);
  });

  app.patch(ROUTE, {
    config: {
      ...productRouteMetadata('PATCH', ROUTE),
      productTransport: {
        allowedQuery: [],
        acceptedMediaTypes: ['application/json'],
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
    const commandId = readKnownCommandId(request);
    const ifMatch = readRequiredIfMatch(request);
    let patch;
    try {
      patch = parseCatalogPreferencesPatch(request.body);
    } catch (error: unknown) {
      mapError(error);
    }
    const fingerprint = canonicalCommandFingerprint({
      method: 'PATCH',
      route: ROUTE,
      mediaType: 'application/json',
      body: patch,
      query: {},
      conditions: { ifMatch },
    });
    try {
      const outcome = await deps.commandUnitOfWork.execute((ports) =>
        updateCatalogPreferences(ports, {
          actor: {
            principalId: account.id,
            accountId: account.id,
            createdAt: account.createdAt,
          },
          commandId,
          fingerprint,
          commandScope: httpCommandScopeV1('PATCH', ROUTE),
          ifMatch,
          patch,
        }));
      if (outcome.kind !== 'updated') return sendProductCommandReceiptOutcome(reply, outcome);
      return sendView(reply, outcome.preferences);
    } catch (error: unknown) {
      mapError(error);
    }
  });
}
