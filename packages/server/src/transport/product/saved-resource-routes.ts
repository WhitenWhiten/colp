import type { FastifyInstance, FastifyRequest } from 'fastify';
import { canonicalCommandFingerprint, canonicalJson } from '../../modules/commands/index.js';
import { saveResource, unsaveResource, getSavedResourcePage, SavedResourceError, SavedResourceQueryError,
  SAVED_RESOURCE_PAGE_MAX_LIMIT, savedResourceCommandScope, type SavedResourceErrorCode,
  type SavedResourceReadUnitOfWork, type SavedResourceType, type SavedResourceUnitOfWork } from '../../modules/reading-progress/index.js';
import type { IdentityUnitOfWork } from '../../modules/identity/index.js';
import type { AppConfig } from '../../bootstrap/config.js';
import { requireSessionActor } from '../session-auth.js';
import { requireMutationActor } from '../mutation-actor.js';
import { readKnownCommandId } from './collection-route-helpers.js';
import { sendProductCommandReceiptOutcome } from '../product-command-mapping.js';
import { ProductHttpError } from '../product-error.js';
import { productRouteMetadata } from '../product-route-manifest.js';
import { productErrorStatus } from '../product-codes.js';
import { isAbortReason, productReadDeadlineMs, requestCancellation } from './publication-request-cancel.js';

const LIST = '/api/v1/saved-resources'; const ITEM = '/api/v1/saved-resources/:resourceType/:resourceId';
export interface SavedResourceRoutesDeps { config: AppConfig; identityUnitOfWork: IdentityUnitOfWork;
  savedResourceReadUnitOfWork: SavedResourceReadUnitOfWork; savedResourceUnitOfWork: SavedResourceUnitOfWork }
export function registerSavedResourceRoutes(app: FastifyInstance, deps: SavedResourceRoutesDeps) {
  app.get(LIST, { config: { ...productRouteMetadata('GET', LIST), productTransport: { allowedQuery: [
    'resourceType','collectionId','createdAfter','createdBefore','limit','cursor'], duplicateQueryErrorCode: 'invalid_query', cacheControl: 'private-no-store' } } }, async (request, reply) => {
    const cancellation = requestCancellation(request, reply, productReadDeadlineMs(deps.config.httpSecurity.requestTimeoutMs));
    try {
      const { account } = await requireSessionActor(request, deps.identityUnitOfWork, { touch: false });
      const page = await deps.savedResourceReadUnitOfWork.execute((ports) => getSavedResourcePage(ports, {
        actor: { accountId: account.id, principalId: account.id, subjectId: account.subjectId }, ...parseQuery(request.query as Record<string,string>) }), { signal: cancellation.signal });
      return reply.code(200).type('application/json; charset=utf-8').send(page);
    } catch (error) { throw mapSavedResourceError(error); }
    finally { cancellation.dispose(); }
  });
  for (const action of ['PUT','DELETE'] as const) app.route({ method: action, url: ITEM, config: {
    ...productRouteMetadata(action, ITEM), productTransport: { allowedQuery: [], acceptedMediaTypes: [], cacheControl: 'private-no-store' } },
    handler: async (request, reply) => {
      const cancellation = requestCancellation(request, reply, productReadDeadlineMs(deps.config.httpSecurity.requestTimeoutMs));
      try { const { account } = await requireMutationActor(request, { identityUnitOfWork: deps.identityUnitOfWork, allowedOrigins: deps.config.allowedOrigins });
      const target = params(request); const commandId = readKnownCommandId(request); const route = `/api/v1/saved-resources/${target.resourceType}/${target.resourceId}`;
      const fingerprint = canonicalCommandFingerprint({ method: action, route, mediaType: '', body: null, query: {}, conditions: {} });
      const input = { actor: { principalId: account.id, subjectId: account.subjectId, accountId: account.id },
        command: { commandId, fingerprint, commandScope: savedResourceCommandScope(action === 'PUT' ? 'save' : 'unsave', target) }, target };
      try { const outcome = await deps.savedResourceUnitOfWork.execute((ports) => action === 'PUT' ? saveResource(ports, input) : unsaveResource(ports, input), { signal: cancellation.signal });
        if (outcome.kind === 'replay' || outcome.kind === 'in_progress' || outcome.kind === 'reused' || outcome.kind === 'expired') return sendProductCommandReceiptOutcome(reply, outcome);
        if (outcome.kind === 'unsaved') return reply.code(204).send();
        return reply.code(outcome.changed ? 201 : 200).type('application/json').send(Buffer.from(canonicalJson({
          resourceType: outcome.savedResource.resourceType, resourceId: outcome.savedResource.resourceId,
          savedAt: outcome.savedResource.savedAt.toISOString(), changed: outcome.changed }), 'utf8'));
      } catch (error) { throw mapSavedResourceError(error); } }
      finally { cancellation.dispose(); }
    } });
}
function parseQuery(query: Record<string,string>) { const resourceType = query.resourceType === undefined ? undefined : type(query.resourceType);
  if (query.collectionId !== undefined && (!query.collectionId || query.collectionId !== query.collectionId.trim())) throw invalidQuery();
  if (query.cursor !== undefined) { if (!query.cursor || query.cursor.length > 2048 || query.limit !== undefined) throw invalidQuery(); }
  let limit: number | undefined; if (query.limit !== undefined) { if (!/^[1-9][0-9]*$/u.test(query.limit) || Number(query.limit) > SAVED_RESOURCE_PAGE_MAX_LIMIT) throw invalidQuery(); limit = Number(query.limit); }
  for (const key of ['createdAfter','createdBefore'] as const) if (query[key] !== undefined && (!Number.isFinite(Date.parse(query[key])) || new Date(Date.parse(query[key])).toISOString() !== query[key])) throw invalidQuery();
  return { ...(resourceType ? { resourceType } : {}), ...(query.collectionId ? { collectionId: query.collectionId } : {}),
    ...(query.createdAfter ? { createdAfter: query.createdAfter } : {}), ...(query.createdBefore ? { createdBefore: query.createdBefore } : {}),
    ...(limit ? { limit } : {}), ...(query.cursor ? { cursor: query.cursor } : {}) };
}
function params(request: FastifyRequest) { const raw = request.params as { resourceType?: string; resourceId?: string };
  if (!raw.resourceId || raw.resourceId !== raw.resourceId.trim()) throw invalidQuery(); return { resourceType: type(raw.resourceType), resourceId: raw.resourceId }; }
function type(value: unknown): SavedResourceType { if (value !== 'collection' && value !== 'node') throw invalidQuery(); return value; }
export function mapSavedResourceError(error: unknown): ProductHttpError {
  if (error instanceof ProductHttpError) return error;
  if (isAbortReason(error)) return new ProductHttpError({ statusCode: productErrorStatus('feature_temporarily_unavailable'), code: 'feature_temporarily_unavailable', message: 'The request was cancelled.', recovery: 'same_request' });
  if (error instanceof SavedResourceQueryError) return SAVED_RESOURCE_QUERY_ERROR_MAP[error.code]();
  if (error instanceof SavedResourceError) return SAVED_RESOURCE_ERROR_MAP[error.code](error);
  throw error;
}
const SAVED_RESOURCE_QUERY_ERROR_MAP = {
  invalid_cursor: () => new ProductHttpError({ statusCode: productErrorStatus('invalid_cursor'), code: 'invalid_cursor',
    message: 'The Saved Resource cursor is invalid.', recovery: 'restart_from_first_page' }),
  invalid_saved_resource_query: invalidQuery,
} as const satisfies Readonly<Record<SavedResourceQueryError['code'], () => ProductHttpError>>;
const SAVED_RESOURCE_ERROR_MAP = {
  saved_resource_not_found: () => new ProductHttpError({ statusCode: productErrorStatus('resource_not_found'),
    code: 'resource_not_found', message: 'The requested resource was not found.', recovery: 'none' }),
  invalid_saved_resource_input: (error) => new ProductHttpError({ statusCode: productErrorStatus('invalid_document'),
    code: 'invalid_document', message: error.message }),
  invalid_saved_resource_target: (error) => new ProductHttpError({ statusCode: productErrorStatus('invalid_document'),
    code: 'invalid_document', message: error.message }),
} as const satisfies Readonly<Record<SavedResourceErrorCode, (error: SavedResourceError) => ProductHttpError>>;
function invalidQuery() { return new ProductHttpError({ statusCode: productErrorStatus('invalid_query'), code: 'invalid_query', message: 'The Saved Resource query is invalid.' }); }
