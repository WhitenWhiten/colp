import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  CollectionsError,
  assertValidNodeDescription,
  assertValidNodeKind,
  assertValidNodeTags,
  assertValidNodeTitle,
  assertValidNodeVisibility,
  createCollectionNode,
  deleteCollectionNode,
  moveCollectionNode,
  updateCollectionNode,
  type CreateCollectionNodeResult,
  type DeleteCollectionNodeResult,
  type MoveCollectionNodeResult,
  type NodeCreateInput,
  type NodeMergePatch,
  type UpdateCollectionNodeResult,
} from '../../modules/collections/index.js';
import { canonicalCommandFingerprint } from '../../modules/commands/index.js';
import {
  invalidDocument,
  readCollectionIdParam,
  readKnownCommandId,
  readNodeIdParam,
  readRequiredIfMatch,
  requireProductCollectionMutationUnitOfWork,
  type CollectionRoutesDeps,
} from './collection-route-helpers.js';
import { ProductHttpError } from '../product-error.js';
import {
  mapCollectionsError,
  rethrowCollectionMutationError,
  sendProductCommandReceiptOutcome,
} from '../product-command-mapping.js';
import { requireMutationActor } from '../mutation-actor.js';
import { productRouteMetadata } from '../product-route-manifest.js';
import { httpCommandScopeV1 } from '../http-command-scope.js';

const NODES_ROUTE = '/api/v1/collections/:collectionId/nodes';
const NODE_RESOURCE_ROUTE = '/api/v1/collections/:collectionId/nodes/:nodeId';
const NODE_MOVE_ROUTE = '/api/v1/collections/:collectionId/nodes/:nodeId/move';
/** Node create/update body budget (128 KiB). */
const NODE_BODY_LIMIT_BYTES = 128 * 1024;
/** Move body is ids + revision tokens only (8 KiB). */
const MOVE_BODY_LIMIT_BYTES = 8 * 1024;
/** Strong entity-tag per Product EntityTag schema (weak tags / * / lists rejected). */
const STRONG_ENTITY_TAG = /^"[^"\r\n]+"$/;

export function registerNodeRoutes(
  app: FastifyInstance,
  deps: CollectionRoutesDeps,
): void {
  app.post(NODES_ROUTE, {
    config: {
      ...productRouteMetadata('POST', NODES_ROUTE),
      productTransport: {
        allowedQuery: [],
        acceptedMediaTypes: ['application/json'],
        bodyLimitBytes: NODE_BODY_LIMIT_BYTES,
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
    const createRequest = parseCreateNodeRequest(request.body);

    const routeIdentity = `/api/v1/collections/${collectionId}/nodes`;
    const commandScope = httpCommandScopeV1('POST', routeIdentity);
    const fingerprint = canonicalCommandFingerprint({
      method: 'POST',
      route: routeIdentity,
      mediaType: 'application/json',
      body: createRequest,
      query: {},
      conditions: {},
    });

    let outcome: CreateCollectionNodeResult;
    try {
      const unitOfWork = requireProductCollectionMutationUnitOfWork(deps);
      outcome = await unitOfWork.execute((ports) =>
        createCollectionNode(ports, {
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
          parentId: createRequest.parentId,
          afterId: createRequest.afterId,
          beforeId: createRequest.beforeId,
          node: createRequest.node,
        }));
    } catch (error: unknown) {
      rethrowCollectionMutationError(error, 'node-create');
    }

    return sendCreateCollectionNodeResult(reply, outcome);
  });

  app.patch(NODE_RESOURCE_ROUTE, {
    config: {
      ...productRouteMetadata('PATCH', NODE_RESOURCE_ROUTE),
      productTransport: {
        allowedQuery: [],
        acceptedMediaTypes: ['application/merge-patch+json'],
        bodyLimitBytes: NODE_BODY_LIMIT_BYTES,
        cacheControl: 'private-no-store',
      },
    },
  }, async (request, reply) => {
    const { account } = await requireMutationActor(request, {
      identityUnitOfWork: deps.identityUnitOfWork,
      allowedOrigins: deps.config.allowedOrigins,
    });

    const collectionId = readCollectionIdParam(request);
    const nodeId = readNodeIdParam(request);
    const commandId = readKnownCommandId(request);
    const ifMatch = readRequiredIfMatch(request);
    const patch = parseNodeMergePatch(request.body);

    const routeIdentity = `/api/v1/collections/${collectionId}/nodes/${nodeId}`;
    const commandScope = httpCommandScopeV1('PATCH', routeIdentity);
    const fingerprint = canonicalCommandFingerprint({
      method: 'PATCH',
      route: routeIdentity,
      mediaType: 'application/merge-patch+json',
      body: patch,
      query: {},
      conditions: { ifMatch },
    });

    let outcome: UpdateCollectionNodeResult;
    try {
      const unitOfWork = requireProductCollectionMutationUnitOfWork(deps);
      outcome = await unitOfWork.execute((ports) =>
        updateCollectionNode(ports, {
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
          nodeId,
          ifMatch,
          patch,
        }));
    } catch (error: unknown) {
      rethrowCollectionMutationError(error, 'node-update-or-move');
    }

    return sendUpdateCollectionNodeResult(reply, outcome);
  });

  app.post(NODE_MOVE_ROUTE, {
    config: {
      ...productRouteMetadata('POST', NODE_MOVE_ROUTE),
      productTransport: {
        allowedQuery: [],
        acceptedMediaTypes: ['application/json'],
        bodyLimitBytes: MOVE_BODY_LIMIT_BYTES,
        cacheControl: 'private-no-store',
      },
    },
  }, async (request, reply) => {
    const { account } = await requireMutationActor(request, {
      identityUnitOfWork: deps.identityUnitOfWork,
      allowedOrigins: deps.config.allowedOrigins,
    });

    const collectionId = readCollectionIdParam(request);
    const nodeId = readNodeIdParam(request);
    const commandId = readKnownCommandId(request);
    const ifMatch = readRequiredIfMatch(request);
    const moveRequest = parseMoveNodeRequest(request.body);

    const routeIdentity = `/api/v1/collections/${collectionId}/nodes/${nodeId}/move`;
    const commandScope = httpCommandScopeV1('POST', routeIdentity);
    const fingerprint = canonicalCommandFingerprint({
      method: 'POST',
      route: routeIdentity,
      mediaType: 'application/json',
      body: moveRequest,
      query: {},
      conditions: { ifMatch },
    });

    let outcome: MoveCollectionNodeResult;
    try {
      const unitOfWork = requireProductCollectionMutationUnitOfWork(deps);
      outcome = await unitOfWork.execute((ports) =>
        moveCollectionNode(ports, {
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
          nodeId,
          ifMatch,
          newParentId: moveRequest.newParentId,
          afterId: moveRequest.afterId,
          beforeId: moveRequest.beforeId,
          baseSourceParentRevision: moveRequest.baseSourceParentRevision,
          baseTargetParentRevision: moveRequest.baseTargetParentRevision,
        }));
    } catch (error: unknown) {
      rethrowCollectionMutationError(error, 'node-update-or-move');
    }

    return sendMoveCollectionNodeResult(reply, outcome);
  });

  app.delete(NODE_RESOURCE_ROUTE, {
    config: {
      ...productRouteMetadata('DELETE', NODE_RESOURCE_ROUTE),
      productTransport: {
        allowedQuery: ['recursive'],
        // No body: empty accepted list rejects any payload as unsupported media type.
        acceptedMediaTypes: [],
        cacheControl: 'private-no-store',
      },
    },
  }, async (request, reply) => {
    const { account } = await requireMutationActor(request, {
      identityUnitOfWork: deps.identityUnitOfWork,
      allowedOrigins: deps.config.allowedOrigins,
    });

    const collectionId = readCollectionIdParam(request);
    const nodeId = readNodeIdParam(request);
    const commandId = readKnownCommandId(request);
    const ifMatch = readRequiredIfMatch(request);
    const recursive = parseRecursiveQuery(request.query as Record<string, string>);
    const ifContentMatch = readOptionalIfContentMatch(request, recursive);

    const routeIdentity = `/api/v1/collections/${collectionId}/nodes/${nodeId}`;
    const commandScope = httpCommandScopeV1('DELETE', routeIdentity);
    const fingerprint = canonicalCommandFingerprint({
      method: 'DELETE',
      route: routeIdentity,
      mediaType: '',
      body: null,
      query: { recursive: recursive ? 'true' : 'false' },
      conditions: {
        ifMatch,
        ...(ifContentMatch !== null ? { ifContentMatch } : {}),
      },
    });

    let outcome: DeleteCollectionNodeResult;
    try {
      const unitOfWork = requireProductCollectionMutationUnitOfWork(deps);
      outcome = await unitOfWork.execute((ports) =>
        deleteCollectionNode(ports, {
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
          nodeId,
          ifMatch,
          recursive,
          ifContentMatch,
        }));
    } catch (error: unknown) {
      rethrowCollectionMutationError(error, 'node-delete');
    }

    return sendDeleteCollectionNodeResult(reply, outcome);
  });
}

function parseRecursiveQuery(query: Record<string, string>): boolean {
  if (!Object.hasOwn(query, 'recursive')) {
    return false;
  }
  const raw = query.recursive;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new ProductHttpError({
    statusCode: 400,
    code: 'invalid_query',
    message: 'recursive must be true or false when provided.',
  });
}

/**
 * If-Content-Match is required exactly when recursive=true (428 content when missing).
 * Present on non-recursive delete → 400 invalid_request (never silently ignored).
 */
function readOptionalIfContentMatch(
  request: FastifyRequest,
  recursive: boolean,
): string | null {
  const raw = request.headers['if-content-match'];
  const value = typeof raw === 'string' && raw.length > 0 ? raw : null;

  if (recursive) {
    if (value === null) {
      throw new ProductHttpError({
        statusCode: 428,
        code: 'precondition_required',
        message: 'If-Content-Match is required when recursive=true.',
        recovery: 'refresh_and_retry',
        precondition: 'content',
      });
    }
    if (!STRONG_ENTITY_TAG.test(value)) {
      throw new ProductHttpError({
        statusCode: 400,
        code: 'invalid_request',
        message: 'If-Content-Match must be a single strong entity-tag.',
      });
    }
    return value;
  }

  if (value !== null) {
    throw new ProductHttpError({
      statusCode: 400,
      code: 'invalid_request',
      message: 'If-Content-Match is not allowed on non-recursive delete.',
    });
  }
  return null;
}

interface MoveNodeRequestBody {
  readonly newParentId: string;
  readonly afterId: string | null;
  readonly beforeId: string | null;
  readonly baseSourceParentRevision: string;
  readonly baseTargetParentRevision: string;
}

function parseMoveNodeRequest(body: unknown): MoveNodeRequestBody {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw invalidDocument('Request body must be a JSON object.');
  }

  const record = body as Record<string, unknown>;
  const allowed = new Set([
    'newParentId',
    'afterId',
    'beforeId',
    'baseSourceParentRevision',
    'baseTargetParentRevision',
  ]);
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

  for (const required of [
    'newParentId',
    'afterId',
    'beforeId',
    'baseSourceParentRevision',
    'baseTargetParentRevision',
  ] as const) {
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

  if (typeof record.newParentId !== 'string' || record.newParentId.trim().length === 0) {
    throw invalidDocument('Property "newParentId" must be a non-empty string.', [
      { path: '/newParentId', code: 'invalid_type', message: 'newParentId must be a string.' },
    ]);
  }
  if (record.afterId !== null && typeof record.afterId !== 'string') {
    throw invalidDocument('Property "afterId" must be a string or null.', [
      { path: '/afterId', code: 'invalid_type', message: 'afterId must be a string or null.' },
    ]);
  }
  if (record.beforeId !== null && typeof record.beforeId !== 'string') {
    throw invalidDocument('Property "beforeId" must be a string or null.', [
      { path: '/beforeId', code: 'invalid_type', message: 'beforeId must be a string or null.' },
    ]);
  }
  if (
    typeof record.baseSourceParentRevision !== 'string'
    || record.baseSourceParentRevision.trim().length === 0
  ) {
    throw invalidDocument(
      'Property "baseSourceParentRevision" must be a non-empty string.',
      [
        {
          path: '/baseSourceParentRevision',
          code: 'invalid_type',
          message: 'baseSourceParentRevision must be a string.',
        },
      ],
    );
  }
  if (
    typeof record.baseTargetParentRevision !== 'string'
    || record.baseTargetParentRevision.trim().length === 0
  ) {
    throw invalidDocument(
      'Property "baseTargetParentRevision" must be a non-empty string.',
      [
        {
          path: '/baseTargetParentRevision',
          code: 'invalid_type',
          message: 'baseTargetParentRevision must be a string.',
        },
      ],
    );
  }

  return {
    newParentId: record.newParentId,
    afterId: record.afterId as string | null,
    beforeId: record.beforeId as string | null,
    baseSourceParentRevision: record.baseSourceParentRevision,
    baseTargetParentRevision: record.baseTargetParentRevision,
  };
}

interface CreateNodeRequestBody {
  readonly parentId: string;
  readonly afterId: string | null;
  readonly beforeId: string | null;
  readonly node: NodeCreateInput;
}

function parseCreateNodeRequest(body: unknown): CreateNodeRequestBody {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw invalidDocument('Request body must be a JSON object.');
  }

  const record = body as Record<string, unknown>;
  const allowed = new Set(['parentId', 'afterId', 'beforeId', 'node']);
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

  for (const required of ['parentId', 'afterId', 'beforeId', 'node'] as const) {
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

  if (typeof record.parentId !== 'string' || record.parentId.trim().length === 0) {
    throw invalidDocument('Property "parentId" must be a non-empty string.', [
      { path: '/parentId', code: 'invalid_type', message: 'parentId must be a string.' },
    ]);
  }
  if (record.afterId !== null && typeof record.afterId !== 'string') {
    throw invalidDocument('Property "afterId" must be a string or null.', [
      { path: '/afterId', code: 'invalid_type', message: 'afterId must be a string or null.' },
    ]);
  }
  if (record.beforeId !== null && typeof record.beforeId !== 'string') {
    throw invalidDocument('Property "beforeId" must be a string or null.', [
      { path: '/beforeId', code: 'invalid_type', message: 'beforeId must be a string or null.' },
    ]);
  }

  let node: NodeCreateInput;
  try {
    node = parseNodeCreate(record.node);
  } catch (error: unknown) {
    if (error instanceof CollectionsError) throw mapCollectionsError(error);
    throw error;
  }

  return {
    parentId: record.parentId,
    afterId: record.afterId as string | null,
    beforeId: record.beforeId as string | null,
    node,
  };
}

function parseNodeCreate(node: unknown): NodeCreateInput {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    throw invalidDocument('Property "node" must be a JSON object.', [
      { path: '/node', code: 'invalid_type', message: 'node must be an object.' },
    ]);
  }

  const record = node as Record<string, unknown>;
  if (typeof record.kind !== 'string') {
    throw invalidDocument('Property "node.kind" must be a string.', [
      { path: '/node/kind', code: 'invalid_type', message: 'kind must be a string.' },
    ]);
  }
  const kind = assertValidNodeKind(record.kind);

  if (kind === 'folder') {
    const allowed = new Set(['kind', 'title', 'description', 'tags', 'visibility']);
    for (const key of Object.keys(record)) {
      if (!allowed.has(key)) {
        throw invalidDocument('Folder create contains unsupported properties.', [
          {
            path: `/node/${key}`,
            code: 'additional_property',
            message: `Property "${key}" is not allowed.`,
          },
        ]);
      }
    }
    for (const required of ['kind', 'title', 'description', 'tags', 'visibility'] as const) {
      if (!Object.hasOwn(record, required)) {
        throw invalidDocument(`Missing required property "node.${required}".`, [
          {
            path: `/node/${required}`,
            code: 'required',
            message: `"${required}" is required.`,
          },
        ]);
      }
    }
    if (typeof record.title !== 'string') {
      throw invalidDocument('Property "node.title" must be a string.', [
        { path: '/node/title', code: 'invalid_type', message: 'title must be a string.' },
      ]);
    }
    if (record.description !== null && typeof record.description !== 'string') {
      throw invalidDocument('Property "node.description" must be a string or null.', [
        {
          path: '/node/description',
          code: 'invalid_type',
          message: 'description must be a string or null.',
        },
      ]);
    }
    if (!Array.isArray(record.tags)) {
      throw invalidDocument('Property "node.tags" must be an array.', [
        { path: '/node/tags', code: 'invalid_type', message: 'tags must be an array.' },
      ]);
    }
    if (typeof record.visibility !== 'string') {
      throw invalidDocument('Property "node.visibility" must be a string.', [
        {
          path: '/node/visibility',
          code: 'invalid_type',
          message: 'visibility must be a string.',
        },
      ]);
    }
    return {
      kind: 'folder',
      title: assertValidNodeTitle(record.title),
      description: assertValidNodeDescription(record.description as string | null),
      tags: assertValidNodeTags(record.tags as readonly string[]),
      visibility: assertValidNodeVisibility(record.visibility),
    };
  }

  const allowed = new Set(['kind', 'title', 'url', 'description', 'tags', 'visibility']);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw invalidDocument('Bookmark create contains unsupported properties.', [
        {
          path: `/node/${key}`,
          code: 'additional_property',
          message: `Property "${key}" is not allowed.`,
        },
      ]);
    }
  }
  for (const required of ['kind', 'title', 'url', 'description', 'tags', 'visibility'] as const) {
    if (!Object.hasOwn(record, required)) {
      throw invalidDocument(`Missing required property "node.${required}".`, [
        {
          path: `/node/${required}`,
          code: 'required',
          message: `"${required}" is required.`,
        },
      ]);
    }
  }
  if (typeof record.title !== 'string') {
    throw invalidDocument('Property "node.title" must be a string.', [
      { path: '/node/title', code: 'invalid_type', message: 'title must be a string.' },
    ]);
  }
  if (typeof record.url !== 'string') {
    throw invalidDocument('Property "node.url" must be a string.', [
      { path: '/node/url', code: 'invalid_type', message: 'url must be a string.' },
    ]);
  }
  if (record.description !== null && typeof record.description !== 'string') {
    throw invalidDocument('Property "node.description" must be a string or null.', [
      {
        path: '/node/description',
        code: 'invalid_type',
        message: 'description must be a string or null.',
      },
    ]);
  }
  if (!Array.isArray(record.tags)) {
    throw invalidDocument('Property "node.tags" must be an array.', [
      { path: '/node/tags', code: 'invalid_type', message: 'tags must be an array.' },
    ]);
  }
  if (typeof record.visibility !== 'string') {
    throw invalidDocument('Property "node.visibility" must be a string.', [
      {
        path: '/node/visibility',
        code: 'invalid_type',
        message: 'visibility must be a string.',
      },
    ]);
  }
  return {
    kind: 'bookmark',
    title: assertValidNodeTitle(record.title),
    url: record.url,
    description: assertValidNodeDescription(record.description as string | null),
    tags: assertValidNodeTags(record.tags as readonly string[]),
    visibility: assertValidNodeVisibility(record.visibility),
  };
}

function parseNodeMergePatch(body: unknown): NodeMergePatch {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw invalidDocument('Request body must be a JSON object.');
  }

  const record = body as Record<string, unknown>;
  const allowed = new Set(['title', 'url', 'description', 'tags', 'visibility']);
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
  const hasUrl = Object.hasOwn(record, 'url');
  const hasDescription = Object.hasOwn(record, 'description');
  const hasTags = Object.hasOwn(record, 'tags');
  const hasVisibility = Object.hasOwn(record, 'visibility');
  if (!hasTitle && !hasUrl && !hasDescription && !hasTags && !hasVisibility) {
    throw invalidDocument(
      'Merge patch must include at least one of title, url, description, tags, visibility.',
      [
        {
          path: '',
          code: 'min_properties',
          message: 'At least one property is required.',
        },
      ],
    );
  }

  const patch: {
    title?: string;
    url?: string;
    description?: string | null;
    tags?: readonly string[] | null;
    visibility?: ReturnType<typeof assertValidNodeVisibility> | null;
  } = {};

  try {
    if (hasTitle) {
      if (typeof record.title !== 'string') {
        throw invalidDocument('Property "title" must be a non-null string.', [
          { path: '/title', code: 'invalid_type', message: 'title must be a string.' },
        ]);
      }
      patch.title = assertValidNodeTitle(record.title);
    }
    if (hasUrl) {
      if (typeof record.url !== 'string') {
        throw invalidDocument('Property "url" must be a non-null string.', [
          { path: '/url', code: 'invalid_type', message: 'url must be a string.' },
        ]);
      }
      patch.url = record.url;
    }
    if (hasDescription) {
      if (record.description !== null && typeof record.description !== 'string') {
        throw invalidDocument('Property "description" must be a string or null.', [
          {
            path: '/description',
            code: 'invalid_type',
            message: 'description must be a string or null.',
          },
        ]);
      }
      patch.description = assertValidNodeDescription(record.description as string | null);
    }
    if (hasTags) {
      if (record.tags === null) {
        patch.tags = null;
      } else if (Array.isArray(record.tags)) {
        patch.tags = assertValidNodeTags(record.tags as readonly string[]);
      } else {
        throw invalidDocument('Property "tags" must be an array or null.', [
          { path: '/tags', code: 'invalid_type', message: 'tags must be an array or null.' },
        ]);
      }
    }
    if (hasVisibility) {
      if (record.visibility === null) {
        patch.visibility = null;
      } else if (typeof record.visibility === 'string') {
        patch.visibility = assertValidNodeVisibility(record.visibility);
      } else {
        throw invalidDocument('Property "visibility" must be a string or null.', [
          {
            path: '/visibility',
            code: 'invalid_type',
            message: 'visibility must be a string or null.',
          },
        ]);
      }
    }
  } catch (error: unknown) {
    if (error instanceof ProductHttpError) throw error;
    if (error instanceof CollectionsError) throw mapCollectionsError(error);
    throw error;
  }

  return patch;
}

function sendCreateCollectionNodeResult(
  reply: FastifyReply,
  outcome: CreateCollectionNodeResult,
): FastifyReply {
  if (outcome.kind !== 'created') {
    return sendProductCommandReceiptOutcome(reply, outcome);
  }
  return reply
    .code(201)
    .header(
      'Location',
      `/api/v1/collections/${outcome.node.collectionId}/nodes/${outcome.node.id}`,
    )
    .header('ETag', outcome.node.etag)
    .type('application/json; charset=utf-8')
    .send({ node: outcome.node, parent: outcome.parent, fence: outcome.fence });
}

function sendUpdateCollectionNodeResult(
  reply: FastifyReply,
  outcome: UpdateCollectionNodeResult,
): FastifyReply {
  if (outcome.kind !== 'updated') {
    return sendProductCommandReceiptOutcome(reply, outcome);
  }
  return reply
    .code(200)
    .header('ETag', outcome.node.etag)
    .type('application/json; charset=utf-8')
    .send({ node: outcome.node, fence: outcome.fence });
}

function sendMoveCollectionNodeResult(
  reply: FastifyReply,
  outcome: MoveCollectionNodeResult,
): FastifyReply {
  if (outcome.kind !== 'moved') {
    return sendProductCommandReceiptOutcome(reply, outcome);
  }
  return reply
    .code(200)
    .header('ETag', outcome.node.etag)
    .type('application/json; charset=utf-8')
    .send({
      node: outcome.node,
      sourceParent: outcome.sourceParent,
      targetParent: outcome.targetParent,
      fence: outcome.fence,
    });
}

function sendDeleteCollectionNodeResult(
  reply: FastifyReply,
  outcome: DeleteCollectionNodeResult,
): FastifyReply {
  if (outcome.kind !== 'deleted') {
    return sendProductCommandReceiptOutcome(reply, outcome);
  }
  // Success has no deleted-resource ETag (docs: Deletion Result only).
  return reply
    .code(200)
    .type('application/json; charset=utf-8')
    .send({ receipt: outcome.receipt, parent: outcome.parent, fence: outcome.fence });
}
