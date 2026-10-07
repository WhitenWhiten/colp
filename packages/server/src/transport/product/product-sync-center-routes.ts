import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppConfig } from '../../bootstrap/config.js';
import { canonicalCommandFingerprint, canonicalJson } from '../../modules/commands/index.js';
import type { IdentityUnitOfWork } from '../../modules/identity/index.js';
import type { ProductSyncCenterUnitOfWork, ProductSyncCommandOutcome } from '../../modules/sync/index.js';
import { readKnownCommandId } from './collection-route-helpers.js';
import { sendProductCommandReceiptOutcome } from '../product-command-mapping.js';
import { ProductHttpError } from '../product-error.js';
import { productRouteMetadata } from '../product-route-manifest.js';
import { requireSessionActor } from '../session-auth.js';
import { requireMutationActor } from '../mutation-actor.js';
import { registerProductSyncTrashRoutes } from './product-sync-trash-routes.js';

const STATUS = '/api/v1/sync/status'; const CONFLICTS = '/api/v1/sync/conflicts';
const RESOLUTION = '/api/v1/sync/conflicts/:conflictId/resolution'; const REPLICA = '/api/v1/sync/replicas/:replicaId';
const OPAQUE = /^[A-Za-z0-9._~-]{1,128}$/u; const STRONG = /^"([A-Za-z0-9._~-]{1,128})"$/u;
export interface ProductSyncCenterRoutesDeps { readonly config: AppConfig; readonly identityUnitOfWork: IdentityUnitOfWork;
  readonly unitOfWork: ProductSyncCenterUnitOfWork }

export function registerProductSyncCenterRoutes(app: FastifyInstance, deps: ProductSyncCenterRoutesDeps): void {
  app.get(STATUS, { config: { ...productRouteMetadata('GET', STATUS), productTransport: { allowedQuery: [],
    duplicateQueryErrorCode: 'invalid_query' as const, cacheControl: 'private-no-store' as const } } }, async (request, reply) => {
    const { account } = await requireSessionActor(request, deps.identityUnitOfWork, { touch: false });
    return reply.code(200).type('application/json; charset=utf-8').send(await deps.unitOfWork.execute((ports) =>
      ports.getStatus({ accountId: account.id })));
  });
  app.get(CONFLICTS, { config: { ...productRouteMetadata('GET', CONFLICTS), productTransport: { allowedQuery: ['limit','cursor'],
    duplicateQueryErrorCode: 'invalid_query' as const, cacheControl: 'private-no-store' as const } } }, async (request, reply) => {
    const { account } = await requireSessionActor(request, deps.identityUnitOfWork, { touch: false });
    const query = request.query as Record<string,string>; let limit = 20;
    if (query.cursor !== undefined && (query.limit !== undefined || query.cursor.length < 1 || query.cursor.length > 2048)) throw invalidQuery();
    if (query.limit !== undefined) { if (!/^[1-9][0-9]*$/u.test(query.limit) || Number(query.limit) > 100) throw invalidQuery(); limit = Number(query.limit); }
    try { return reply.code(200).type('application/json; charset=utf-8').send(await deps.unitOfWork.execute((ports) =>
      ports.getConflicts({ accountId: account.id, limit, ...(query.cursor ? { cursor: query.cursor } : {}) })));
    } catch (error) { if (code(error) === 'invalid_cursor') throw new ProductHttpError({ statusCode: 400, code: 'invalid_cursor',
      message: 'The Sync Conflict cursor is invalid.', recovery: 'restart_from_first_page' }); throw error; }
  });
  app.post(RESOLUTION, { config: { ...productRouteMetadata('POST', RESOLUTION), productTransport: { allowedQuery: [],
    acceptedMediaTypes: ['application/json'], bodyLimitBytes: 16_384, cacheControl: 'private-no-store' as const } } }, async (request, reply) => {
    const { account } = await mutationActor(request, deps); const conflictId = pathId(request, 'conflictId');
    const expectedRevision = strongRevision(request); const commandId = readKnownCommandId(request); const body = resolutionBody(request.body);
    const fingerprint = canonicalCommandFingerprint({ method: 'POST', route: `/api/v1/sync/conflicts/${conflictId}/resolution`,
      resource: conflictId, mediaType: 'application/json', conditions: { ifMatch: `"${expectedRevision}"` }, body });
    try { const outcome = await deps.unitOfWork.execute((ports) => ports.resolveConflict({ accountId: account.id,
      subjectId: account.subjectId, conflictId, expectedRevision, commandId, fingerprint, ...body }));
      return sendOutcome(reply, outcome); } catch (error) { throw mapMutationError(error); }
  });
  app.delete(REPLICA, { config: { ...productRouteMetadata('DELETE', REPLICA), productTransport: { allowedQuery: [],
    acceptedMediaTypes: [], cacheControl: 'private-no-store' as const } } }, async (request, reply) => {
    const { account } = await mutationActor(request, deps); const replicaId = pathId(request, 'replicaId');
    const expectedLifecycleRevision = strongRevision(request); const commandId = readKnownCommandId(request);
    const fingerprint = canonicalCommandFingerprint({ method: 'DELETE', route: `/api/v1/sync/replicas/${replicaId}`,
      resource: replicaId, mediaType: '', conditions: { ifMatch: `"${expectedLifecycleRevision}"` }, body: null });
    try { return sendOutcome(reply, await deps.unitOfWork.execute((ports) => ports.retireReplica({ accountId: account.id,
      replicaId, expectedLifecycleRevision, commandId, fingerprint }))); } catch (error) { throw mapMutationError(error); }
  });
  registerProductSyncTrashRoutes(app, deps);
}

async function mutationActor(request: FastifyRequest, deps: ProductSyncCenterRoutesDeps) {
  return requireMutationActor(request, {
    identityUnitOfWork: deps.identityUnitOfWork,
    allowedOrigins: deps.config.allowedOrigins,
  });
}
function sendOutcome(reply: Parameters<typeof sendProductCommandReceiptOutcome>[0], outcome: ProductSyncCommandOutcome<unknown>) {
  if (outcome.kind !== 'committed') return sendProductCommandReceiptOutcome(reply, outcome);
  const etag = typeof outcome.result === 'object' && outcome.result !== null
    ? (outcome.result as { etag?: unknown }).etag : undefined;
  if (typeof etag === 'string') reply.header('ETag', etag);
  return reply.code(200).type('application/json; charset=utf-8').send(Buffer.from(canonicalJson(outcome.result), 'utf8'));
}
function pathId(request: FastifyRequest, name: string): string { const value = (request.params as Record<string,unknown>)[name];
  if (typeof value !== 'string' || !OPAQUE.test(value)) throw invalidQuery(); return value; }
function strongRevision(request: FastifyRequest): string { const raw = request.headers['if-match'];
  if (raw === undefined) throw new ProductHttpError({ statusCode: 428, code: 'precondition_required', message: 'If-Match is required.',
    recovery: 'refresh_and_retry', precondition: 'resource' }); const match = typeof raw === 'string' ? STRONG.exec(raw) : null;
  if (!match) throw new ProductHttpError({ statusCode: 400, code: 'invalid_request', message: 'If-Match must be one strong entity-tag.' }); return match[1]!; }
function resolutionBody(value: unknown) { if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidDocument();
  const body = value as Record<string,unknown>; const allowed = body.resolution === 'custom' ? ['resolution','value'] : ['resolution'];
  if (Object.keys(body).some((key) => !allowed.includes(key)) || !['server','incoming','custom','both'].includes(String(body.resolution))
    || (body.resolution === 'custom') !== Object.hasOwn(body, 'value')) throw invalidDocument();
  return { resolution: body.resolution as 'server'|'incoming'|'custom'|'both', ...(body.resolution === 'custom' ? { value: body.value } : {}) };
}
function code(error: unknown): unknown { return typeof error === 'object' && error !== null ? (error as {code?:unknown}).code : undefined; }
function mapMutationError(error: unknown): unknown { const value = code(error);
  if (value === 'resource_not_found') return new ProductHttpError({ statusCode: 404, code: 'resource_not_found',
    message: 'The requested Sync resource was not found.', recovery: 'none' });
  if (value === 'precondition_failed' || value === 'stale_replica') return new ProductHttpError({ statusCode: 412,
    code: 'precondition_failed', message: 'The Sync resource revision changed.', recovery: 'refresh_and_retry', precondition: 'resource' });
  if (value === 'unsupported_operation') return new ProductHttpError({ statusCode: 422, code: 'invalid_document',
    message: 'This resolution is not allowed for the Conflict.', recovery: 'user_action' });
  if (value === 'invalid_document') return invalidDocument();
  if (value === 'idempotency_key_reused') return new ProductHttpError({ statusCode: 409, code: 'command_id_reused',
    message: 'This command id was already used with a different request.', recovery: 'user_action' });
  if (value === 'idempotency_in_progress') return new ProductHttpError({ statusCode: 409, code: 'command_in_progress',
    message: 'This command is still in progress.', recovery: 'same_request', sameRequestRetrySafe: true,
    retryAfterSeconds: 1, headers: { 'Retry-After': '1' } });
  return error; }
function invalidQuery() { return new ProductHttpError({ statusCode: 400, code: 'invalid_query', message: 'The Sync Center query is invalid.' }); }
function invalidDocument() { return new ProductHttpError({ statusCode: 422, code: 'invalid_document', message: 'The resolution document is invalid.' }); }
