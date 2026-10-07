import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Relation } from '@know-n/colp/types';
import { RELATION_PAGE_MAX_LIMIT, RelationCreateError, RelationDeleteError, RelationProductReadError,
  RelationUpdateError, createRelation, deleteRelation, getProductRelation, getProductRelationPage,
  toProductRelationView, updateRelation, type CreateRelationResult, type DeleteRelationResult,
  type ProductRelationCreateInput, type ProductRelationMergePatch, type RelationCreateErrorCode,
  type RelationDeleteErrorCode, type RelationUpdateErrorCode, type UpdateRelationResult } from '../../modules/collections/index.js';
import { canonicalCommandFingerprint, canonicalJson } from '../../modules/commands/index.js';
import { readCollectionIdParam, readKnownCommandId, readRequiredIfMatch, type CollectionRoutesDeps } from './collection-route-helpers.js';
import { httpCommandScopeV1 } from '../http-command-scope.js';
import { sendProductCommandReceiptOutcome } from '../product-command-mapping.js';
import { ProductHttpError } from '../product-error.js';
import { productRouteMetadata } from '../product-route-manifest.js';
import { requireSessionActor } from '../session-auth.js';
import { requireMutationActor } from '../mutation-actor.js';
import { productErrorStatus } from '../product-codes.js';

const COLLECTION_ROUTE = '/api/v1/collections/:collectionId/relations';
const ITEM_ROUTE = '/api/v1/collections/:collectionId/relations/:relationId';
const BODY_LIMIT = 128 * 1024;
const types = new Set<Relation['type']>(['related', 'precedes', 'follows', 'supports', 'contradicts',
  'duplicate_of', 'derived_from', 'mentions', 'custom']);
const visibilities = new Set<Relation['visibility']>(['private', 'protected', 'unlisted', 'public']);

export function registerRelationRoutes(app: FastifyInstance, deps: CollectionRoutesDeps): void {
  if (!deps.relationReadUnitOfWork || !deps.relationMutationUnitOfWork) return;
  app.get(COLLECTION_ROUTE, { config: { ...productRouteMetadata('GET', COLLECTION_ROUTE), productTransport: {
    allowedQuery: ['nodeId', 'direction', 'type', 'visibility', 'limit', 'cursor'],
    duplicateQueryErrorCode: 'invalid_query', cacheControl: 'private-no-store' } } }, async (request, reply) => {
    const { account } = await requireSessionActor(request, deps.identityUnitOfWork, { touch: false });
    try { const page = await deps.relationReadUnitOfWork!.execute((ports) => getProductRelationPage(ports, {
      collectionId: readCollectionIdParam(request), actor: { principalId: account.id, subjectId: account.subjectId },
      ...parseList(request.query as Record<string, string>),
    })); return reply.code(200).type('application/json; charset=utf-8').send(page); }
    catch (error) { throw mapRelationError(error); }
  });
  app.post(COLLECTION_ROUTE, { config: { ...productRouteMetadata('POST', COLLECTION_ROUTE), productTransport: {
    allowedQuery: [], acceptedMediaTypes: ['application/json'], bodyLimitBytes: BODY_LIMIT,
    cacheControl: 'private-no-store' } } }, async (request, reply) => {
    const { account } = await mutationActor(request, deps); const collectionId = readCollectionIdParam(request);
    const commandId = readKnownCommandId(request); const body = createBody(request.body);
    const route = `/api/v1/collections/${collectionId}/relations`;
    const fingerprint = canonicalCommandFingerprint({ method: 'POST', route, mediaType: 'application/json', body,
      query: {}, conditions: {} });
    try { return sendCreate(reply, await deps.relationMutationUnitOfWork!.execute((ports) => createRelation(ports, {
      actor: { principalId: account.id, subjectId: account.subjectId, principalType: 'account' },
      command: { commandId, fingerprint, commandScope: httpCommandScopeV1('POST', route) }, collectionId, relation: body,
    }))); } catch (error) { throw mapRelationError(error); }
  });
  app.get(ITEM_ROUTE, { config: { ...productRouteMetadata('GET', ITEM_ROUTE), productTransport: {
    allowedQuery: [], cacheControl: 'private-no-store' } } }, async (request, reply) => {
    const { account } = await requireSessionActor(request, deps.identityUnitOfWork, { touch: false });
    try { const view = await deps.relationReadUnitOfWork!.execute((ports) => getProductRelation(ports, {
      collectionId: readCollectionIdParam(request), relationId: relationId(request),
      actor: { principalId: account.id, subjectId: account.subjectId },
    })); return reply.code(200).header('ETag', `"${view.revision}"`).type('application/json; charset=utf-8').send(view); }
    catch (error) { throw mapRelationError(error); }
  });
  app.patch(ITEM_ROUTE, { config: { ...productRouteMetadata('PATCH', ITEM_ROUTE), productTransport: {
    allowedQuery: [], acceptedMediaTypes: ['application/merge-patch+json'], bodyLimitBytes: BODY_LIMIT,
    cacheControl: 'private-no-store' } } }, async (request, reply) => {
    const { account } = await mutationActor(request, deps); const collectionId = readCollectionIdParam(request);
    const id = relationId(request); const commandId = readKnownCommandId(request); const ifMatch = readRequiredIfMatch(request);
    const patch = patchBody(request.body); const route = `/api/v1/collections/${collectionId}/relations/${id}`;
    const fingerprint = canonicalCommandFingerprint({ method: 'PATCH', route, mediaType: 'application/merge-patch+json',
      body: patch, query: {}, conditions: { ifMatch } });
    try { return sendUpdate(reply, await deps.relationMutationUnitOfWork!.execute((ports) => updateRelation(ports, {
      actor: { principalId: account.id, subjectId: account.subjectId, principalType: 'account' },
      command: { commandId, fingerprint, commandScope: httpCommandScopeV1('PATCH', route) }, collectionId,
      relationId: id, precondition: evidence(ifMatch), patch,
    }))); } catch (error) { throw mapRelationError(error); }
  });
  app.delete(ITEM_ROUTE, { config: { ...productRouteMetadata('DELETE', ITEM_ROUTE), productTransport: {
    allowedQuery: [], acceptedMediaTypes: [], cacheControl: 'private-no-store' } } }, async (request, reply) => {
    const { account } = await mutationActor(request, deps); const collectionId = readCollectionIdParam(request);
    const id = relationId(request); const commandId = readKnownCommandId(request); const ifMatch = readRequiredIfMatch(request);
    const route = `/api/v1/collections/${collectionId}/relations/${id}`;
    const fingerprint = canonicalCommandFingerprint({ method: 'DELETE', route, mediaType: '', body: null,
      query: {}, conditions: { ifMatch } });
    try { return sendDelete(reply, await deps.relationMutationUnitOfWork!.execute((ports) => deleteRelation(ports, {
      actor: { principalId: account.id, subjectId: account.subjectId, principalType: 'account' },
      command: { commandId, fingerprint, commandScope: httpCommandScopeV1('DELETE', route) }, collectionId,
      relationId: id, precondition: evidence(ifMatch),
    }))); } catch (error) { throw mapRelationError(error); }
  });
}

async function mutationActor(request: FastifyRequest, deps: CollectionRoutesDeps) {
  return requireMutationActor(request, {
    identityUnitOfWork: deps.identityUnitOfWork,
    allowedOrigins: deps.config.allowedOrigins,
  });
}
function parseList(query: Record<string, string>) {
  if (!query.nodeId || query.nodeId !== query.nodeId.trim() || !['incoming', 'outgoing', 'both'].includes(query.direction ?? '')) throw invalidQuery();
  const parsed = { nodeId: query.nodeId, direction: query.direction as 'incoming' | 'outgoing' | 'both',
    types: enumList(query.type, types), visibilities: enumList(query.visibility, visibilities) };
  if (query.cursor !== undefined) { if (!query.cursor || query.cursor.length > 2048 || query.limit !== undefined) throw invalidQuery(); return { ...parsed, cursor: query.cursor }; }
  if (query.limit === undefined) return parsed;
  if (!/^[1-9][0-9]*$/u.test(query.limit) || Number(query.limit) > RELATION_PAGE_MAX_LIMIT) throw invalidQuery();
  return { ...parsed, limit: Number(query.limit) };
}
function enumList<T extends string>(raw: string | undefined, allowed: ReadonlySet<T>): readonly T[] {
  if (raw === undefined) return []; if (!raw) throw invalidQuery(); const values = raw.split(',');
  if (new Set(values).size !== values.length || values.some((value) => !allowed.has(value as T))) throw invalidQuery();
  return values.sort((a, b) => a.localeCompare(b, 'en')) as T[];
}
function createBody(value: unknown): ProductRelationCreateInput { const row = closed(value, new Set(['fromNodeId', 'toNodeId', 'type', 'label', 'visibility', 'extensions']));
  for (const key of ['fromNodeId', 'toNodeId', 'type', 'visibility']) if (!Object.hasOwn(row, key)) throw invalidDocument(`${key} is required.`);
  return row as unknown as ProductRelationCreateInput; }
function patchBody(value: unknown) { return closed(value, new Set(['type', 'label', 'visibility', 'extensions'])) as ProductRelationMergePatch; }
function closed(value: unknown, keys: ReadonlySet<string>) { if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidDocument('A JSON object is required.');
  const row = value as Record<string, unknown>; if (Object.keys(row).some((key) => !keys.has(key))) throw invalidDocument('Unsupported property.'); return row; }
function relationId(request: FastifyRequest) { const id = (request.params as { relationId?: string }).relationId; if (!id || id !== id.trim()) throw invalidDocument('relationId is required.'); return id; }
function evidence(entityTag: string) { return { kind: 'single-strong-if-match' as const, entityTag, expectedRevision: entityTag.slice(1, -1) }; }
function sendCreate(reply: FastifyReply, outcome: CreateRelationResult) { if (outcome.kind !== 'created') return sendProductCommandReceiptOutcome(reply, outcome);
  return reply.code(201).header('Location', `/api/v1/collections/${outcome.relation.collectionId}/relations/${outcome.relation.id}`)
    .header('ETag', `"${outcome.relation.revision}"`).type('application/json').send(Buffer.from(canonicalJson(toProductRelationView(outcome.relation)), 'utf8')); }
function sendUpdate(reply: FastifyReply, outcome: UpdateRelationResult) { if (outcome.kind !== 'updated') return sendProductCommandReceiptOutcome(reply, outcome);
  return reply.code(200).header('Location', `/api/v1/collections/${outcome.relation.collectionId}/relations/${outcome.relation.id}`)
    .header('ETag', `"${outcome.relation.revision}"`).type('application/json').send(Buffer.from(canonicalJson(toProductRelationView(outcome.relation)), 'utf8')); }
function sendDelete(reply: FastifyReply, outcome: DeleteRelationResult) { if (outcome.kind !== 'deleted') return sendProductCommandReceiptOutcome(reply, outcome);
  return reply.code(200).header('Location', `/api/v1/collections/${outcome.receipt.collectionId}/relations/${outcome.receipt.targetId}`)
    .header('ETag', `"${outcome.receipt.deleteRevision}"`).type('application/json').send({ receipt: outcome.receipt, fence: outcome.fence }); }
type RelationMutationError = RelationCreateError | RelationUpdateError | RelationDeleteError;
type RelationMutationErrorCode =
  | RelationCreateErrorCode
  | RelationUpdateErrorCode
  | RelationDeleteErrorCode;

const RELATION_READ_ERROR_MAP = {
  invalid_cursor: invalidCursor,
  invalid_relation_query: invalidQuery,
  relation_not_found: notFound,
} as const satisfies Readonly<Record<RelationProductReadError['code'], () => ProductHttpError>>;

const RELATION_MUTATION_ERROR_MAP = {
  relation_not_found: notFound,
  invalid_relation_endpoint: notFound,
  relation_precondition_required: (error) => new ProductHttpError({ statusCode: productErrorStatus('precondition_required'), code: 'precondition_required', message: 'If-Match is required.', recovery: 'refresh_and_retry', precondition: 'resource' }),
  relation_precondition_failed: (error) => new ProductHttpError({ statusCode: productErrorStatus('precondition_failed'), code: 'precondition_failed', message: 'The Relation changed before this operation.', recovery: 'refresh_and_retry', precondition: 'resource', currentEtag: 'currentEtag' in error && typeof error.currentEtag === 'string' ? error.currentEtag : null }),
  relation_already_exists: (error) => new ProductHttpError({ statusCode: productErrorStatus('mutation_conflict'), code: 'mutation_conflict', message: error.message }),
  insufficient_relation_permission: () => new ProductHttpError({ statusCode: productErrorStatus('insufficient_permission'), code: 'insufficient_permission', message: 'You do not have permission.', recovery: 'user_action' }),
  relation_label_too_large: (error) => new ProductHttpError({ statusCode: productErrorStatus('payload_too_large'), code: 'payload_too_large', message: error.message }),
  relation_json_too_deep: (error) => new ProductHttpError({ statusCode: productErrorStatus('payload_too_large'), code: 'payload_too_large', message: error.message }),
  relation_json_too_many_members: (error) => new ProductHttpError({ statusCode: productErrorStatus('payload_too_large'), code: 'payload_too_large', message: error.message }),
  relation_candidate_too_large: (error) => new ProductHttpError({ statusCode: productErrorStatus('payload_too_large'), code: 'payload_too_large', message: error.message }),
  invalid_relation_input: (error) => invalidDocument(error.message),
  invalid_relation_patch: (error) => invalidDocument(error.message),
  invalid_relation_document: (error) => invalidDocument(error.message),
  invalid_relation_precondition: (error) => invalidDocument(error.message),
  untrusted_relation_identity: (error) => invalidDocument(error.message),
  relation_self_forbidden: (error) => invalidDocument(error.message),
  relation_visibility_too_broad: (error) => invalidDocument(error.message),
} as const satisfies Readonly<Record<RelationMutationErrorCode,
  (error: RelationMutationError) => ProductHttpError>>;

export function mapRelationError(error: unknown): ProductHttpError {
  if (error instanceof ProductHttpError) return error;
  if (error instanceof RelationProductReadError) return RELATION_READ_ERROR_MAP[error.code]();
  if (error instanceof RelationCreateError || error instanceof RelationUpdateError || error instanceof RelationDeleteError) {
    return RELATION_MUTATION_ERROR_MAP[error.code](error);
  }
  throw error;
}
function invalidQuery() { return new ProductHttpError({ statusCode: productErrorStatus('invalid_query'), code: 'invalid_query', message: 'The Relation query is invalid.' }); }
function invalidCursor() { return new ProductHttpError({ statusCode: productErrorStatus('invalid_cursor'), code: 'invalid_cursor', message: 'The Relation cursor is invalid.', recovery: 'restart_from_first_page' }); }
function invalidDocument(message: string) { return new ProductHttpError({ statusCode: productErrorStatus('invalid_document'), code: 'invalid_document', message, recovery: 'user_action' }); }
function notFound() { return new ProductHttpError({ statusCode: productErrorStatus('resource_not_found'), code: 'resource_not_found', message: 'The requested resource was not found.', recovery: 'none' }); }
