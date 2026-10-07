import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  ANNOTATION_PAGE_MAX_LIMIT,
  AnnotationCreateError,
  AnnotationDeleteError,
  AnnotationProductReadError,
  AnnotationUpdateError,
  createAnnotation,
  deleteAnnotation,
  getProductAnnotation,
  getProductAnnotationPage,
  getProductCollectionNotes,
  updateAnnotation,
  toProductAnnotationView,
  type AnnotationCreateErrorCode,
  type AnnotationDeleteErrorCode,
  type AnnotationUpdateErrorCode,
  type CreateAnnotationResult,
  type DeleteAnnotationResult,
  type ProductAnnotationCreateInput,
  type ProductAnnotationMergePatch,
  type UpdateAnnotationResult,
} from '../../modules/collections/index.js';
import { canonicalCommandFingerprint, canonicalJson } from '../../modules/commands/index.js';
import {
  readCollectionIdParam,
  readKnownCommandId,
  readRequiredIfMatch,
  type CollectionRoutesDeps,
} from './collection-route-helpers.js';
import { httpCommandScopeV1 } from '../http-command-scope.js';
import { sendProductCommandReceiptOutcome } from '../product-command-mapping.js';
import { ProductHttpError } from '../product-error.js';
import { productRouteMetadata } from '../product-route-manifest.js';
import { requireSessionActor } from '../session-auth.js';
import { requireMutationActor } from '../mutation-actor.js';
import { productErrorStatus } from '../product-codes.js';
import { extensionProductAllowedOrigins } from '../extension-product-origins.js';
import { bindAnnotationSession } from './annotation-session-binding.js';

const COLLECTION_ROUTE = '/api/v1/collections/:collectionId/annotations';
const ITEM_ROUTE = '/api/v1/collections/:collectionId/annotations/:annotationId';
const ANNOTATION_BODY_LIMIT_BYTES = 128 * 1024;

export function registerAnnotationRoutes(app: FastifyInstance, deps: CollectionRoutesDeps): void {
  if (!deps.annotationReadUnitOfWork || !deps.annotationMutationUnitOfWork) return;
  app.get(COLLECTION_ROUTE, { config: {
    ...productRouteMetadata('GET', COLLECTION_ROUTE),
    productTransport: { allowedQuery: ['resourceType', 'resourceId', 'limit', 'cursor', 'collectionNotes', 'knownRevision'],
      duplicateQueryErrorCode: 'invalid_query', cacheControl: 'private-no-store' },
  } }, async (request, reply) => {
    const actor = await requireSessionActor(request, deps.identityUnitOfWork, { touch: false });
    bindAnnotationSession(request, reply, actor);
    const { account } = actor;
    const collectionId = readCollectionIdParam(request);
    try {
      const raw = request.query as Record<string, string>;
      if (raw.collectionNotes !== undefined) {
        if (raw.collectionNotes !== 'true' || raw.resourceType !== 'collection' || raw.resourceId !== collectionId
          || Object.keys(raw).some(key => !['resourceType', 'resourceId', 'collectionNotes', 'knownRevision', 'cursor'].includes(key))
          || raw.cursor !== undefined && (raw.knownRevision !== undefined || raw.cursor.length === 0 || raw.cursor.length > 2048)
          || raw.knownRevision !== undefined && (!raw.knownRevision || raw.knownRevision.length > 512)) throw invalidQuery();
        const page = await deps.annotationReadUnitOfWork!.execute(ports => getProductCollectionNotes(ports, { collectionId,
          actor: { principalId: account.id, subjectId: account.subjectId }, cursor: raw.cursor, knownRevision: raw.knownRevision }));
        return reply.code(200).type('application/json; charset=utf-8').send(page);
      }
      const query = parseSubjectPaging(raw);
      const page = await deps.annotationReadUnitOfWork!.execute((ports) => getProductAnnotationPage(ports, {
        collectionId, ...query, actor: { principalId: account.id, subjectId: account.subjectId },
      }));
      return reply.code(200).type('application/json; charset=utf-8').send(page);
    } catch (error) { throw mapAnnotationError(error); }
  });

  app.post(COLLECTION_ROUTE, { config: {
    ...productRouteMetadata('POST', COLLECTION_ROUTE),
    productTransport: { allowedQuery: ['resourceType', 'resourceId'], duplicateQueryErrorCode: 'invalid_query',
      acceptedMediaTypes: ['application/json'], bodyLimitBytes: ANNOTATION_BODY_LIMIT_BYTES,
      cacheControl: 'private-no-store' },
  } }, async (request, reply) => {
    const actor = await mutationActor(request, deps);
    bindAnnotationSession(request, reply, actor);
    const { account } = actor;
    const collectionId = readCollectionIdParam(request);
    const subject = parseSubject(request.query as Record<string, string>);
    const commandId = readKnownCommandId(request);
    const body = parseCreateBody(request.body);
    const route = `/api/v1/collections/${collectionId}/annotations`;
    const fingerprint = canonicalCommandFingerprint({ method: 'POST', route, mediaType: 'application/json',
      body, query: { resourceId: subject.resourceId, resourceType: subject.resourceType }, conditions: {} });
    try {
      const creator = await loadCreator(deps, account.id);
      const outcome = await deps.annotationMutationUnitOfWork!.execute((ports) => createAnnotation(ports, {
        actor: { principalId: account.id, subjectId: account.subjectId, principalType: 'account', creator },
        command: { commandId, fingerprint, commandScope: httpCommandScopeV1('POST', route) },
        collectionId, annotation: { ...body, subject: { type: subject.resourceType, id: subject.resourceId } },
        ...(request.headers['known-annotation-session'] !== undefined ? { privateNoteSingleton: true } : {}),
      }));
      return sendCreate(reply, outcome);
    } catch (error) { throw mapAnnotationError(error); }
  });

  app.get(ITEM_ROUTE, { config: {
    ...productRouteMetadata('GET', ITEM_ROUTE), productTransport: { allowedQuery: [], cacheControl: 'private-no-store' },
  } }, async (request, reply) => {
    const actor = await requireSessionActor(request, deps.identityUnitOfWork, { touch: false });
    bindAnnotationSession(request, reply, actor);
    const { account } = actor;
    const collectionId = readCollectionIdParam(request);
    const annotationId = readAnnotationId(request);
    try {
      const view = await deps.annotationReadUnitOfWork!.execute((ports) => getProductAnnotation(ports, {
        collectionId, annotationId, actor: { principalId: account.id, subjectId: account.subjectId },
      }));
      return reply.code(200).header('ETag', `"${view.revision}"`)
        .type('application/json; charset=utf-8').send(view);
    } catch (error) { throw mapAnnotationError(error); }
  });

  app.patch(ITEM_ROUTE, { config: {
    ...productRouteMetadata('PATCH', ITEM_ROUTE), productTransport: { allowedQuery: [],
      acceptedMediaTypes: ['application/merge-patch+json'], bodyLimitBytes: ANNOTATION_BODY_LIMIT_BYTES,
      cacheControl: 'private-no-store' },
  } }, async (request, reply) => {
    const actor = await mutationActor(request, deps);
    bindAnnotationSession(request, reply, actor);
    const { account } = actor;
    const collectionId = readCollectionIdParam(request);
    const annotationId = readAnnotationId(request);
    const commandId = readKnownCommandId(request);
    const ifMatch = readRequiredIfMatch(request);
    const patch = parsePatchBody(request.body);
    const route = `/api/v1/collections/${collectionId}/annotations/${annotationId}`;
    const fingerprint = canonicalCommandFingerprint({ method: 'PATCH', route,
      mediaType: 'application/merge-patch+json', body: patch, query: {}, conditions: { ifMatch } });
    try {
      const outcome = await deps.annotationMutationUnitOfWork!.execute((ports) => updateAnnotation(ports, {
        actor: { principalId: account.id, subjectId: account.subjectId, principalType: 'account' },
        command: { commandId, fingerprint, commandScope: httpCommandScopeV1('PATCH', route) },
        collectionId, annotationId, precondition: ifMatchEvidence(ifMatch), patch,
      }));
      return sendUpdate(reply, outcome);
    } catch (error) { throw mapAnnotationError(error); }
  });

  app.delete(ITEM_ROUTE, { config: {
    ...productRouteMetadata('DELETE', ITEM_ROUTE), productTransport: { allowedQuery: [], acceptedMediaTypes: [],
      cacheControl: 'private-no-store' },
  } }, async (request, reply) => {
    const actor = await mutationActor(request, deps);
    bindAnnotationSession(request, reply, actor);
    const { account } = actor;
    const collectionId = readCollectionIdParam(request);
    const annotationId = readAnnotationId(request);
    const commandId = readKnownCommandId(request);
    const ifMatch = readRequiredIfMatch(request);
    const route = `/api/v1/collections/${collectionId}/annotations/${annotationId}`;
    const fingerprint = canonicalCommandFingerprint({ method: 'DELETE', route, mediaType: '', body: null,
      query: {}, conditions: { ifMatch } });
    try {
      const outcome = await deps.annotationMutationUnitOfWork!.execute((ports) => deleteAnnotation(ports, {
        actor: { principalId: account.id, subjectId: account.subjectId, principalType: 'account' },
        command: { commandId, fingerprint, commandScope: httpCommandScopeV1('DELETE', route) },
        collectionId, annotationId, precondition: ifMatchEvidence(ifMatch),
      }));
      return sendDelete(reply, outcome);
    } catch (error) { throw mapAnnotationError(error); }
  });
}

async function mutationActor(request: FastifyRequest, deps: CollectionRoutesDeps) {
  return requireMutationActor(request, {
    identityUnitOfWork: deps.identityUnitOfWork,
    allowedOrigins: extensionProductAllowedOrigins(deps.config),
  });
}

async function loadCreator(deps: CollectionRoutesDeps, accountId: string) {
  return deps.identityUnitOfWork.execute(async (ports) => {
    const [profile, handle] = await Promise.all([
      ports.profiles.findByAccountId(accountId), ports.handles.findByAccountId(accountId),
    ]);
    if (!profile || !handle) throw new ProductHttpError({ statusCode: productErrorStatus('invalid_document'), code: 'invalid_document',
      message: 'A public Profile handle is required before creating an Annotation.', recovery: 'user_action' });
    return Object.freeze({ id: `${deps.config.productOrigin}/profiles/${encodeURIComponent(handle.handle)}`,
      name: profile.displayName || handle.handle });
  });
}

function parseSubject(query: Record<string, string | undefined>) {
  if (Object.keys(query).some((key) => key !== 'resourceType' && key !== 'resourceId')) throw invalidQuery();
  const resourceType = query.resourceType;
  const resourceId = query.resourceId;
  if ((resourceType !== 'collection' && resourceType !== 'node') || typeof resourceId !== 'string'
    || resourceId.length === 0 || resourceId !== resourceId.trim()) throw invalidQuery();
  return { resourceType, resourceId } as const;
}

function parseSubjectPaging(query: Record<string, string>) {
  const allowed = new Set(['resourceType', 'resourceId', 'limit', 'cursor']);
  if (Object.keys(query).some((key) => !allowed.has(key))) throw invalidQuery();
  const subject = parseSubject({ resourceType: query.resourceType, resourceId: query.resourceId });
  if (query.cursor !== undefined && query.limit !== undefined) throw invalidQuery();
  if (query.cursor !== undefined) {
    if (query.cursor.length === 0 || query.cursor.length > 2048) throw invalidCursor();
    return { ...subject, cursor: query.cursor };
  }
  if (query.limit === undefined) return subject;
  if (!/^[1-9][0-9]*$/u.test(query.limit)) throw invalidQuery();
  const limit = Number(query.limit);
  if (!Number.isInteger(limit) || limit > ANNOTATION_PAGE_MAX_LIMIT) throw invalidQuery();
  return { ...subject, limit };
}

function parseCreateBody(value: unknown): Omit<ProductAnnotationCreateInput, 'subject'> {
  const record = closedObject(value, new Set(['type', 'format', 'value', 'visibility', 'extensions']));
  if (!Object.hasOwn(record, 'type') || !Object.hasOwn(record, 'value')
    || !Object.hasOwn(record, 'visibility')) {
    throw invalidDocument('type, value, and visibility are required.');
  }
  return record as unknown as Omit<ProductAnnotationCreateInput, 'subject'>;
}

function parsePatchBody(value: unknown): ProductAnnotationMergePatch {
  return closedObject(value, new Set(['format', 'value', 'visibility', 'extensions'])) as ProductAnnotationMergePatch;
}

function closedObject(value: unknown, keys: ReadonlySet<string>): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidDocument('A JSON object is required.');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !keys.has(key))) throw invalidDocument('The document contains an unsupported property.');
  return record;
}

function readAnnotationId(request: FastifyRequest): string {
  const id = (request.params as { annotationId?: string }).annotationId;
  if (typeof id !== 'string' || id.trim().length === 0) throw invalidDocument('annotationId is required.');
  return id;
}

function ifMatchEvidence(entityTag: string) {
  return { kind: 'single-strong-if-match' as const, entityTag, expectedRevision: entityTag.slice(1, -1) };
}

function sendCreate(reply: FastifyReply, outcome: CreateAnnotationResult) {
  if (outcome.kind !== 'created') return sendProductCommandReceiptOutcome(reply, outcome);
  return reply.code(201).header('Location', `/api/v1/collections/${outcome.annotation.collectionId}/annotations/${outcome.annotation.id}`)
    .header('ETag', `"${outcome.annotation.revision}"`).type('application/json')
    .send(Buffer.from(canonicalJson(toProductAnnotationView(outcome.annotation)), 'utf8'));
}
function sendUpdate(reply: FastifyReply, outcome: UpdateAnnotationResult) {
  if (outcome.kind !== 'updated') return sendProductCommandReceiptOutcome(reply, outcome);
  return reply.code(200)
    .header('Location', `/api/v1/collections/${outcome.annotation.collectionId}/annotations/${outcome.annotation.id}`)
    .header('ETag', `"${outcome.annotation.revision}"`).type('application/json')
    .send(Buffer.from(canonicalJson(toProductAnnotationView(outcome.annotation)), 'utf8'));
}
function sendDelete(reply: FastifyReply, outcome: DeleteAnnotationResult) {
  if (outcome.kind !== 'deleted') return sendProductCommandReceiptOutcome(reply, outcome);
  return reply.code(200)
    .header('Location', `/api/v1/collections/${outcome.receipt.collectionId}/annotations/${outcome.receipt.targetId}`)
    .header('ETag', `"${outcome.receipt.deleteRevision}"`).type('application/json')
    .send(Buffer.from(JSON.stringify({ receipt: outcome.receipt, fence: outcome.fence }), 'utf8'));
}

type AnnotationMutationError = AnnotationCreateError | AnnotationUpdateError | AnnotationDeleteError;
type AnnotationMutationErrorCode =
  | AnnotationCreateErrorCode
  | AnnotationUpdateErrorCode
  | AnnotationDeleteErrorCode;

const ANNOTATION_READ_ERROR_MAP = {
  invalid_cursor: invalidCursor,
  invalid_annotation_query: invalidQuery,
  annotation_not_found: notFound,
} as const satisfies Readonly<Record<AnnotationProductReadError['code'], () => ProductHttpError>>;

const ANNOTATION_MUTATION_ERROR_MAP = {
  annotation_not_found: notFound,
  invalid_annotation_subject: notFound,
  annotation_precondition_required: preconditionRequired,
  annotation_precondition_failed: (error) => new ProductHttpError({ statusCode: productErrorStatus('precondition_failed'),
    code: 'precondition_failed', message: 'The Annotation changed before this operation.',
    recovery: 'refresh_and_retry', precondition: 'resource',
    currentEtag: 'currentEtag' in error && typeof error.currentEtag === 'string'
      ? error.currentEtag : null }),
  invalid_annotation_precondition: (error) => new ProductHttpError({ statusCode: productErrorStatus('invalid_request'),
    code: 'invalid_request', message: error.message }),
  insufficient_annotation_permission: () => new ProductHttpError({ statusCode: productErrorStatus('insufficient_permission'),
    code: 'insufficient_permission', message: 'You do not have permission to perform this action.', recovery: 'user_action' }),
  annotation_value_too_large: (error) => new ProductHttpError({ statusCode: productErrorStatus('payload_too_large'), code: 'payload_too_large', message: error.message }),
  annotation_json_too_deep: (error) => new ProductHttpError({ statusCode: productErrorStatus('payload_too_large'), code: 'payload_too_large', message: error.message }),
  annotation_json_too_many_members: (error) => new ProductHttpError({ statusCode: productErrorStatus('payload_too_large'), code: 'payload_too_large', message: error.message }),
  annotation_candidate_too_large: (error) => new ProductHttpError({ statusCode: productErrorStatus('payload_too_large'), code: 'payload_too_large', message: error.message }),
  invalid_annotation_input: (error) => invalidDocument(error.message),
  invalid_annotation_document: (error) => invalidDocument(error.message),
  invalid_annotation_patch: (error) => invalidDocument(error.message),
  annotation_visibility_too_broad: (error) => invalidDocument(error.message),
  untrusted_annotation_creator: (error) => invalidDocument(error.message),
  untrusted_ai_provenance: (error) => invalidDocument(error.message),
  reserved_annotation_type: (error) => invalidDocument(error.message),
  untrusted_annotation_context: (error) => invalidDocument(error.message),
  annotation_subject_limit_reached: (error) => invalidDocument(error.message),
  annotation_note_already_exists: (error) => new ProductHttpError({ statusCode: 409, code: 'mutation_conflict',
    message: error.message, recovery: 'refresh_and_retry' }),
} as const satisfies Readonly<Record<AnnotationMutationErrorCode,
  (error: AnnotationMutationError) => ProductHttpError>>;

export function mapAnnotationError(error: unknown): ProductHttpError {
  if (error instanceof ProductHttpError) return error;
  if (error instanceof AnnotationProductReadError) return ANNOTATION_READ_ERROR_MAP[error.code]();
  if (error instanceof AnnotationCreateError || error instanceof AnnotationUpdateError
    || error instanceof AnnotationDeleteError) {
    return ANNOTATION_MUTATION_ERROR_MAP[error.code](error);
  }
  throw error;
}

function invalidQuery() { return new ProductHttpError({ statusCode: productErrorStatus('invalid_query'), code: 'invalid_query', message: 'The Annotation query is invalid.' }); }
function invalidCursor() { return new ProductHttpError({ statusCode: productErrorStatus('invalid_cursor'), code: 'invalid_cursor', message: 'The Annotation cursor is invalid.', recovery: 'restart_from_first_page' }); }
function invalidDocument(message: string) { return new ProductHttpError({ statusCode: productErrorStatus('invalid_document'), code: 'invalid_document', message, recovery: 'user_action' }); }
function notFound() { return new ProductHttpError({ statusCode: productErrorStatus('resource_not_found'), code: 'resource_not_found', message: 'The requested resource was not found.', recovery: 'none' }); }
function preconditionRequired() { return new ProductHttpError({ statusCode: productErrorStatus('precondition_required'), code: 'precondition_required', message: 'If-Match is required.', recovery: 'refresh_and_retry', precondition: 'resource' }); }
