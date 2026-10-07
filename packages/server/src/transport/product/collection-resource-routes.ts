import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  CollectionsError,
  assertValidCollectionKind,
  assertValidCollectionSummary,
  assertValidCollectionTitle,
  createOwnedCollectionCanonical,
  updateCollectionMetadataCanonical,
  type CollectionMetadataMergePatch,
  type CreateOwnedCollectionResult,
  type UpdateCollectionMetadataResult,
} from '../../modules/collections/index.js';
import { canonicalCommandFingerprint } from '../../modules/commands/index.js';
import {
  invalidDocument,
  readCollectionIdParam,
  readKnownCommandId,
  readRequiredIfMatch,
  requireProductCollectionMutationUnitOfWork,
  type CollectionRoutesDeps,
} from './collection-route-helpers.js';
import { httpCommandScopeV1 } from '../http-command-scope.js';
import {
  mapCollectionsError,
  rethrowCollectionMutationError,
  sendProductCommandReceiptOutcome,
} from '../product-command-mapping.js';
import { productRouteMetadata } from '../product-route-manifest.js';
import { requireMutationActor } from '../mutation-actor.js';

const CREATE_COLLECTIONS_ROUTE = '/api/v1/collections';
const COLLECTION_RESOURCE_ROUTE = '/api/v1/collections/:collectionId';
const BODY_LIMIT_BYTES = 16 * 1024;

interface CreateCollectionBody {
  readonly kind: string;
  readonly title: string;
  readonly summary: string | null;
}

export function registerCollectionResourceRoutes(
  app: FastifyInstance,
  deps: CollectionRoutesDeps,
): void {
  if (!deps.collectionMetadataMutationsEnabled) return;

  app.post(CREATE_COLLECTIONS_ROUTE, {
    config: {
      ...productRouteMetadata('POST', CREATE_COLLECTIONS_ROUTE),
      productTransport: {
        allowedQuery: [],
        acceptedMediaTypes: ['application/json'],
        bodyLimitBytes: BODY_LIMIT_BYTES,
        cacheControl: 'private-no-store',
      },
    },
  }, async (request, reply) => {
    // Session auth (identity UoW) before Origin/CSRF so ProductHttpError is not
    // swallowed by classifyDatabaseError when checks run outside transactions.
    const { account } = await requireMutationActor(request, {
      identityUnitOfWork: deps.identityUnitOfWork,
      allowedOrigins: deps.config.allowedOrigins,
    });

    const commandId = readKnownCommandId(request);
    const body = parseCreateCollectionRequest(request.body);

    const fingerprint = canonicalCommandFingerprint({
      method: 'POST',
      route: CREATE_COLLECTIONS_ROUTE,
      mediaType: 'application/json',
      body: {
        kind: body.kind,
        title: body.title,
        summary: body.summary,
      },
      query: {},
      conditions: {},
    });

    let outcome: CreateOwnedCollectionResult;
    try {
      const unitOfWork = requireProductCollectionMutationUnitOfWork(deps);
      outcome = await unitOfWork.execute((ports) =>
        createOwnedCollectionCanonical(ports, {
          actor: {
            principalId: account.id,
            principalType: 'account',
            subjectId: account.subjectId,
          },
          command: {
            commandId,
            fingerprint,
            commandScope: httpCommandScopeV1('POST', CREATE_COLLECTIONS_ROUTE),
          },
          title: body.title,
          summary: body.summary,
          kind: body.kind,
        }));
    } catch (error: unknown) {
      rethrowCollectionMutationError(error, 'collection-create');
    }

    return sendCreateOwnedCollectionResult(reply, outcome);
  });

  app.patch(COLLECTION_RESOURCE_ROUTE, {
    config: {
      ...productRouteMetadata('PATCH', COLLECTION_RESOURCE_ROUTE),
      productTransport: {
        allowedQuery: [],
        acceptedMediaTypes: ['application/merge-patch+json'],
        bodyLimitBytes: BODY_LIMIT_BYTES,
        cacheControl: 'private-no-store',
      },
    },
  }, async (request, reply) => {
    const { account } = await requireMutationActor(request, {
      identityUnitOfWork: deps.identityUnitOfWork,
      allowedOrigins: deps.config.allowedOrigins,
    });

    const collectionId = readCollectionIdParam(request);
    const commandId = readKnownCommandId(request);
    const ifMatch = readRequiredIfMatch(request);
    const patch = parseCollectionMergePatch(request.body);

    const routeIdentity = `/api/v1/collections/${collectionId}`;
    const commandScope = httpCommandScopeV1('PATCH', routeIdentity);
    const fingerprint = canonicalCommandFingerprint({
      method: 'PATCH',
      route: routeIdentity,
      mediaType: 'application/merge-patch+json',
      body: patch,
      query: {},
      conditions: { ifMatch },
    });

    let outcome: UpdateCollectionMetadataResult;
    try {
      const unitOfWork = requireProductCollectionMutationUnitOfWork(deps);
      outcome = await unitOfWork.execute((ports) =>
        updateCollectionMetadataCanonical(ports, {
          actor: {
            principalId: account.id,
            principalType: 'account',
            subjectId: account.subjectId,
          },
          command: {
            commandId,
            fingerprint,
            commandScope,
          },
          collectionId,
          ifMatch,
          patch,
          productOrigin: deps.config.productOrigin,
        }));
    } catch (error: unknown) {
      rethrowCollectionMutationError(error, 'collection-update');
    }

    return sendUpdateCollectionMetadataResult(reply, outcome);
  });
}

function parseCollectionMergePatch(body: unknown): CollectionMetadataMergePatch {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw invalidDocument('Request body must be a JSON object.');
  }

  const record = body as Record<string, unknown>;
  const allowed = new Set(['title', 'summary', 'visibility', 'publicationSlug', 'allowSearchIndexing']);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw invalidDocument('Request body contains unsupported properties.', [
        {
          path: `/${key}`,
          code: 'additional_property',
          message: `Property "${key}" is not allowed.`,
        },
      ]);
    }
  }

  const hasTitle = Object.hasOwn(record, 'title');
  const hasSummary = Object.hasOwn(record, 'summary');
  const hasVisibility = Object.hasOwn(record, 'visibility');
  const hasPublicationSlug = Object.hasOwn(record, 'publicationSlug');
  const hasAllowSearchIndexing = Object.hasOwn(record, 'allowSearchIndexing');
  if (!hasTitle && !hasSummary && !hasVisibility && !hasPublicationSlug && !hasAllowSearchIndexing) {
    throw invalidDocument('Merge patch must include at least one supported property.', [
      {
        path: '',
        code: 'min_properties',
        message: 'At least one property is required.',
      },
    ]);
  }

  const patch: {
    title?: string;
    summary?: string | null;
    visibility?: 'private' | 'public' | 'unlisted';
    publicationSlug?: string;
    allowSearchIndexing?: boolean;
  } = {};

  if (hasTitle) {
    if (typeof record.title !== 'string') {
      throw invalidDocument('Property "title" must be a non-null string.', [
        {
          path: '/title',
          code: 'invalid_type',
          message: 'title must be a string.',
        },
      ]);
    }
  }
  if (hasSummary) {
    if (record.summary !== null && typeof record.summary !== 'string') {
      throw invalidDocument('Property "summary" must be a string or null.', [
        {
          path: '/summary',
          code: 'invalid_type',
          message: 'summary must be a string or null.',
        },
      ]);
    }
  }
  if (hasVisibility && !['private', 'public', 'unlisted'].includes(String(record.visibility))) {
    throw invalidDocument('Property "visibility" must be private, public, or unlisted.', [
      { path: '/visibility', code: 'invalid_value', message: 'visibility is not publishable.' },
    ]);
  }
  if (hasPublicationSlug && (typeof record.publicationSlug !== 'string'
    || !/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/u.test(record.publicationSlug))) {
    throw invalidDocument('Property "publicationSlug" must be a canonical lowercase slug.', [
      { path: '/publicationSlug', code: 'invalid_value', message: 'publicationSlug is invalid.' },
    ]);
  }
  if (hasAllowSearchIndexing && typeof record.allowSearchIndexing !== 'boolean') {
    throw invalidDocument('Property "allowSearchIndexing" must be a boolean.', [
      { path: '/allowSearchIndexing', code: 'invalid_type', message: 'allowSearchIndexing must be a boolean.' },
    ]);
  }

  try {
    if (hasTitle) {
      patch.title = assertValidCollectionTitle(record.title as string);
    }
    if (hasSummary) {
      patch.summary = assertValidCollectionSummary(record.summary as string | null);
    }
    if (hasVisibility) patch.visibility = record.visibility as 'private' | 'public' | 'unlisted';
    if (hasPublicationSlug) patch.publicationSlug = record.publicationSlug as string;
    if (hasAllowSearchIndexing) patch.allowSearchIndexing = record.allowSearchIndexing as boolean;
  } catch (error: unknown) {
    if (error instanceof CollectionsError) throw mapCollectionsError(error);
    throw error;
  }

  return patch;
}

function sendUpdateCollectionMetadataResult(
  reply: FastifyReply,
  outcome: UpdateCollectionMetadataResult,
): FastifyReply {
  if (outcome.kind !== 'updated') {
    return sendProductCommandReceiptOutcome(reply, outcome);
  }
  for (const [name, value] of Object.entries(outcome.stableHeaders)) {
    reply.header(name, value);
  }
  return reply
    .code(200)
    .header('ETag', outcome.collection.etag)
    .type(outcome.stableHeaders['content-type'] ?? outcome.mediaType)
    .send(Buffer.from(outcome.body));
}

function parseCreateCollectionRequest(body: unknown): CreateCollectionBody {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw invalidDocument('Request body must be a JSON object.');
  }

  const record = body as Record<string, unknown>;
  const allowed = new Set(['kind', 'title', 'summary']);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw invalidDocument('Request body contains unsupported properties.', [
        {
          path: `/${key}`,
          code: 'additional_property',
          message: `Property "${key}" is not allowed.`,
        },
      ]);
    }
  }

  for (const required of ['kind', 'title', 'summary'] as const) {
    if (!Object.hasOwn(record, required)) {
      throw invalidDocument(`Missing required property "${required}".`, [
        {
          path: `/${required}`,
          code: 'required',
          message: `"${required}" is required.`,
        },
      ]);
    }
  }

  if (typeof record.kind !== 'string') {
    throw invalidDocument('Property "kind" must be a string.', [
      { path: '/kind', code: 'invalid_type', message: 'kind must be a string.' },
    ]);
  }
  if (typeof record.title !== 'string') {
    throw invalidDocument('Property "title" must be a string.', [
      { path: '/title', code: 'invalid_type', message: 'title must be a string.' },
    ]);
  }
  if (record.summary !== null && typeof record.summary !== 'string') {
    throw invalidDocument('Property "summary" must be a string or null.', [
      {
        path: '/summary',
        code: 'invalid_type',
        message: 'summary must be a string or null.',
      },
    ]);
  }

  try {
    return {
      kind: assertValidCollectionKind(record.kind),
      title: assertValidCollectionTitle(record.title),
      summary: assertValidCollectionSummary(record.summary),
    };
  } catch (error: unknown) {
    if (error instanceof CollectionsError) throw mapCollectionsError(error);
    throw error;
  }
}

function sendCreateOwnedCollectionResult(
  reply: FastifyReply,
  outcome: CreateOwnedCollectionResult,
): FastifyReply {
  if (outcome.kind !== 'created') {
    return sendProductCommandReceiptOutcome(reply, outcome);
  }
  return reply
    .code(201)
    .header('Location', `/api/v1/collections/${outcome.collection.id}`)
    .header('ETag', outcome.collection.etag)
    .type('application/json; charset=utf-8')
    .send({ collection: outcome.collection, root: outcome.root });
}
