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
import { registerProductSyncTrashBatchRoutes } from './product-sync-trash-batch-routes.js';

const LIST = '/api/v1/sync/trash';
const ITEM = '/api/v1/sync/trash/:deletionId';
const RESTORE = '/api/v1/sync/trash/:deletionId/restore';
const DELETION_ID = /^[A-Za-z0-9._~-]{1,512}$/u;
const COLLECTION_ID = /^[A-Za-z0-9._~-]{1,128}$/u;
const STRONG = /^"([A-Za-z0-9._~-]{1,128})"$/u;

export interface ProductSyncTrashRoutesDeps {
  readonly config: AppConfig;
  readonly identityUnitOfWork: IdentityUnitOfWork;
  readonly unitOfWork: ProductSyncCenterUnitOfWork;
}

export function registerProductSyncTrashRoutes(app: FastifyInstance, deps: ProductSyncTrashRoutesDeps): void {
  registerProductSyncTrashBatchRoutes(app, deps);
  app.get(LIST, { config: { ...productRouteMetadata('GET', LIST), productTransport: {
    allowedQuery: ['collectionId', 'limit', 'cursor'], duplicateQueryErrorCode: 'invalid_query' as const,
    cacheControl: 'private-no-store' as const } } }, async (request, reply) => {
    const { account } = await requireSessionActor(request, deps.identityUnitOfWork, { touch: false });
    const query = request.query as Record<string, string>;
    const collectionId = query.collectionId;
    if (typeof collectionId !== 'string' || !COLLECTION_ID.test(collectionId)) throw invalidQuery();
    let limit = 20;
    if (query.cursor !== undefined && (query.limit !== undefined || query.cursor.length < 1 || query.cursor.length > 2048)) {
      throw invalidQuery();
    }
    if (query.limit !== undefined) {
      if (!/^[1-9][0-9]*$/u.test(query.limit) || Number(query.limit) > 100) throw invalidQuery();
      limit = Number(query.limit);
    }
    try {
      return reply.code(200).type('application/json; charset=utf-8').send(await deps.unitOfWork.execute((ports) =>
        ports.listTrash({
          accountId: account.id, subjectId: account.subjectId, collectionId,
          limit, ...(query.cursor ? { cursor: query.cursor } : {}),
        })));
    } catch (error) { throw mapReadError(error); }
  });

  app.get(ITEM, { config: { ...productRouteMetadata('GET', ITEM), productTransport: {
    allowedQuery: [], duplicateQueryErrorCode: 'invalid_query' as const,
    cacheControl: 'private-no-store' as const } } }, async (request, reply) => {
    const { account } = await requireSessionActor(request, deps.identityUnitOfWork, { touch: false });
    const deletionId = deletionPath(request);
    try {
      const detail = await deps.unitOfWork.execute((ports) =>
        ports.getTrashDetail({ accountId: account.id, subjectId: account.subjectId, deletionId }));
      return reply.code(200).header('ETag', detail.etag).type('application/json; charset=utf-8').send(detail);
    } catch (error) { throw mapReadError(error); }
  });

  app.post(RESTORE, { config: { ...productRouteMetadata('POST', RESTORE), productTransport: {
    allowedQuery: [], acceptedMediaTypes: [], cacheControl: 'private-no-store' as const } } },
  async (request, reply) => {
    const { account } = await requireMutationActor(request, {
      identityUnitOfWork: deps.identityUnitOfWork, allowedOrigins: deps.config.allowedOrigins,
    });
    const deletionId = deletionPath(request);
    const expectedRevision = strongRevision(request);
    const commandId = readKnownCommandId(request);
    const fingerprint = canonicalCommandFingerprint({
      method: 'POST', route: `/api/v1/sync/trash/${deletionId}/restore`, resource: deletionId,
      mediaType: '', conditions: { ifMatch: `"${expectedRevision}"` }, body: null,
    });
    try {
      const outcome = await deps.unitOfWork.execute((ports) => ports.restoreTrash({
        accountId: account.id, subjectId: account.subjectId, deletionId, expectedRevision, commandId, fingerprint,
      }));
      return sendOutcome(reply, outcome);
    } catch (error) { throw mapMutationError(error); }
  });
}

function sendOutcome(
  reply: Parameters<typeof sendProductCommandReceiptOutcome>[0],
  outcome: ProductSyncCommandOutcome<unknown>,
) {
  if (outcome.kind !== 'committed') return sendProductCommandReceiptOutcome(reply, outcome);
  const etag = typeof outcome.result === 'object' && outcome.result !== null
    ? (outcome.result as { etag?: unknown }).etag : undefined;
  if (typeof etag === 'string') reply.header('ETag', etag);
  return reply.code(200).type('application/json; charset=utf-8')
    .send(Buffer.from(canonicalJson(outcome.result), 'utf8'));
}

function deletionPath(request: FastifyRequest): string {
  const value = (request.params as Record<string, unknown>).deletionId;
  if (typeof value !== 'string' || !DELETION_ID.test(value)) throw invalidQuery();
  return value;
}

function strongRevision(request: FastifyRequest): string {
  const raw = request.headers['if-match'];
  if (raw === undefined) {
    throw new ProductHttpError({ statusCode: 428, code: 'precondition_required',
      message: 'If-Match is required.', recovery: 'refresh_and_retry', precondition: 'resource' });
  }
  const match = typeof raw === 'string' ? STRONG.exec(raw) : null;
  if (!match) {
    throw new ProductHttpError({ statusCode: 400, code: 'invalid_request',
      message: 'If-Match must be one strong entity-tag.' });
  }
  return match[1]!;
}

function codeOf(error: unknown): unknown {
  return typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
}

function mapReadError(error: unknown): unknown {
  const value = codeOf(error);
  if (value === 'invalid_cursor') {
    return new ProductHttpError({ statusCode: 400, code: 'invalid_cursor',
      message: 'The Sync Trash cursor is invalid.', recovery: 'restart_from_first_page' });
  }
  if (value === 'resource_purged') return purged();
  if (value === 'resource_not_found') return notFound();
  return error;
}

function mapMutationError(error: unknown): unknown {
  const value = codeOf(error);
  if (value === 'resource_not_found') return notFound();
  if (value === 'resource_purged') return purged();
  if (value === 'precondition_failed') {
    return new ProductHttpError({ statusCode: 412, code: 'precondition_failed',
      message: 'The Sync resource revision changed.', recovery: 'refresh_and_retry', precondition: 'resource' });
  }
  if (value === 'invalid_request') {
    return new ProductHttpError({ statusCode: 422, code: 'invalid_request',
      message: 'The restore request is invalid.' });
  }
  if (value === 'command_id_reused' || value === 'idempotency_key_reused') {
    return new ProductHttpError({ statusCode: 409, code: 'command_id_reused',
      message: 'This command id was already used with a different request.', recovery: 'user_action' });
  }
  if (value === 'command_in_progress' || value === 'idempotency_in_progress') {
    return new ProductHttpError({ statusCode: 409, code: 'command_in_progress',
      message: 'This command is still in progress.', recovery: 'same_request', sameRequestRetrySafe: true,
      retryAfterSeconds: 1, headers: { 'Retry-After': '1' } });
  }
  return error;
}

function notFound() {
  return new ProductHttpError({ statusCode: 404, code: 'resource_not_found',
    message: 'The requested Sync resource was not found.', recovery: 'none' });
}
function purged() {
  return new ProductHttpError({ statusCode: 410, code: 'resource_purged',
    message: 'The deleted Node is no longer restorable.', recovery: 'none' });
}
function invalidQuery() {
  return new ProductHttpError({ statusCode: 400, code: 'invalid_query', message: 'The Sync Center query is invalid.' });
}
