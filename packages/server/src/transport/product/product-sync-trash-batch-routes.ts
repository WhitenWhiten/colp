import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { canonicalCommandFingerprint, canonicalJson } from '../../modules/commands/index.js';
import {
  PRODUCT_SYNC_TRASH_EMPTY_CONFIRMATION,
  PRODUCT_SYNC_TRASH_EMPTY_LIMIT,
  PRODUCT_SYNC_TRASH_RESTORE_BATCH_LIMIT,
  type ProductSyncCommandOutcome,
} from '../../modules/sync/index.js';
import { readKnownCommandId } from './collection-route-helpers.js';
import { sendProductCommandReceiptOutcome } from '../product-command-mapping.js';
import { ProductHttpError } from '../product-error.js';
import { productRouteMetadata } from '../product-route-manifest.js';
import { requireMutationActor } from '../mutation-actor.js';
import type { ProductSyncTrashRoutesDeps } from './product-sync-trash-routes.js';

const BATCH = '/api/v1/sync/trash/restore-batch';
const SUBTREE = '/api/v1/sync/trash/:deletionId/restore-subtree';
const EMPTY = '/api/v1/sync/trash/empty';
const DELETION_ID = /^[A-Za-z0-9._~-]{1,512}$/u;
const COLLECTION_ID = /^[A-Za-z0-9._~-]{1,128}$/u;
const REVISION = /^[A-Za-z0-9._~-]{1,128}$/u;
const STRONG = /^"([A-Za-z0-9._~-]{1,128})"$/u;

export function registerProductSyncTrashBatchRoutes(
  app: FastifyInstance, deps: ProductSyncTrashRoutesDeps,
): void {
  app.post(BATCH, { config: { ...productRouteMetadata('POST', BATCH), productTransport: {
    allowedQuery: [], acceptedMediaTypes: ['application/json'], bodyLimitBytes: 65_536,
    cacheControl: 'private-no-store' as const } } }, async (request, reply) => {
    const { account } = await requireMutationActor(request, {
      identityUnitOfWork: deps.identityUnitOfWork, allowedOrigins: deps.config.allowedOrigins,
    });
    const body = restoreBatchBody(request.body);
    const commandId = readKnownCommandId(request);
    const fingerprint = canonicalCommandFingerprint({
      method: 'POST', route: BATCH, resource: body.collectionId,
      mediaType: 'application/json', conditions: {}, body,
    });
    try {
      const outcome = await deps.unitOfWork.execute((ports) => ports.restoreTrashBatch({
        accountId: account.id, subjectId: account.subjectId, collectionId: body.collectionId,
        items: body.items, commandId, fingerprint,
      }));
      return sendOutcome(reply, outcome);
    } catch (error) { throw mapMutationError(error); }
  });

  app.post(SUBTREE, { config: { ...productRouteMetadata('POST', SUBTREE), productTransport: {
    allowedQuery: [], acceptedMediaTypes: [], cacheControl: 'private-no-store' as const } } },
  async (request, reply) => {
    const { account } = await requireMutationActor(request, {
      identityUnitOfWork: deps.identityUnitOfWork, allowedOrigins: deps.config.allowedOrigins,
    });
    const deletionId = deletionPath(request);
    const expectedRevision = strongRevision(request);
    const commandId = readKnownCommandId(request);
    const fingerprint = canonicalCommandFingerprint({
      method: 'POST', route: `/api/v1/sync/trash/${deletionId}/restore-subtree`, resource: deletionId,
      mediaType: '', conditions: { ifMatch: `"${expectedRevision}"` }, body: null,
    });
    try {
      const outcome = await deps.unitOfWork.execute((ports) => ports.restoreTrashSubtree({
        accountId: account.id, subjectId: account.subjectId, deletionId, expectedRevision, commandId, fingerprint,
      }));
      return sendOutcome(reply, outcome);
    } catch (error) { throw mapMutationError(error); }
  });

  app.post(EMPTY, { config: { ...productRouteMetadata('POST', EMPTY), productTransport: {
    allowedQuery: [], acceptedMediaTypes: ['application/json'], bodyLimitBytes: 4_096,
    cacheControl: 'private-no-store' as const } } }, async (request, reply) => {
    const { account } = await requireMutationActor(request, {
      identityUnitOfWork: deps.identityUnitOfWork, allowedOrigins: deps.config.allowedOrigins,
    });
    const body = emptyBody(request.body);
    const commandId = readKnownCommandId(request);
    const fingerprint = canonicalCommandFingerprint({
      method: 'POST', route: EMPTY, resource: body.collectionId,
      mediaType: 'application/json', conditions: {}, body,
    });
    try {
      const outcome = await deps.unitOfWork.execute((ports) => ports.emptyTrash({
        accountId: account.id, subjectId: account.subjectId, collectionId: body.collectionId,
        expectedCount: body.expectedCount, confirmation: body.confirmation, commandId, fingerprint,
      }));
      return sendOutcome(reply, outcome);
    } catch (error) { throw mapMutationError(error); }
  });
}

function restoreBatchBody(value: unknown): {
  readonly collectionId: string;
  readonly items: readonly { readonly deletionId: string; readonly expectedRevision: string }[];
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidDocument();
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => key !== 'collectionId' && key !== 'items')) throw invalidDocument();
  if (typeof body.collectionId !== 'string' || !COLLECTION_ID.test(body.collectionId)) throw invalidDocument();
  if (!Array.isArray(body.items) || body.items.length < 1
      || body.items.length > PRODUCT_SYNC_TRASH_RESTORE_BATCH_LIMIT) {
    throw invalidDocument();
  }
  const seen = new Set<string>();
  const items = body.items.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw invalidDocument();
    const row = item as Record<string, unknown>;
    if (Object.keys(row).some((key) => key !== 'deletionId' && key !== 'expectedRevision')) throw invalidDocument();
    if (typeof row.deletionId !== 'string' || !DELETION_ID.test(row.deletionId)
        || typeof row.expectedRevision !== 'string' || !REVISION.test(row.expectedRevision)) {
      throw invalidDocument();
    }
    if (seen.has(row.deletionId)) throw invalidDocument();
    seen.add(row.deletionId);
    return { deletionId: row.deletionId, expectedRevision: row.expectedRevision };
  });
  return { collectionId: body.collectionId, items };
}

function emptyBody(value: unknown): {
  readonly collectionId: string; readonly expectedCount: number; readonly confirmation: string;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidDocument();
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => key !== 'collectionId' && key !== 'expectedCount' && key !== 'confirmation')) {
    throw invalidDocument();
  }
  if (typeof body.collectionId !== 'string' || !COLLECTION_ID.test(body.collectionId)
      || !Number.isInteger(body.expectedCount) || (body.expectedCount as number) < 1
      || (body.expectedCount as number) > PRODUCT_SYNC_TRASH_EMPTY_LIMIT
      || body.confirmation !== PRODUCT_SYNC_TRASH_EMPTY_CONFIRMATION) {
    throw invalidDocument();
  }
  return {
    collectionId: body.collectionId, expectedCount: body.expectedCount as number,
    confirmation: body.confirmation,
  };
}

function sendOutcome(
  reply: FastifyReply, outcome: ProductSyncCommandOutcome<unknown>,
) {
  if (outcome.kind !== 'committed') return sendProductCommandReceiptOutcome(reply, outcome);
  return reply.code(200).type('application/json; charset=utf-8')
    .send(Buffer.from(canonicalJson(outcome.result), 'utf8'));
}

function deletionPath(request: FastifyRequest): string {
  const value = (request.params as Record<string, unknown>).deletionId;
  if (typeof value !== 'string' || !DELETION_ID.test(value)) {
    throw new ProductHttpError({ statusCode: 400, code: 'invalid_query', message: 'The Sync Center query is invalid.' });
  }
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

function mapMutationError(error: unknown): unknown {
  const value = codeOf(error);
  if (value === 'resource_not_found') {
    return new ProductHttpError({ statusCode: 404, code: 'resource_not_found',
      message: 'The requested Sync resource was not found.', recovery: 'none' });
  }
  if (value === 'resource_purged') {
    return new ProductHttpError({ statusCode: 410, code: 'resource_purged',
      message: 'The deleted Node is no longer restorable.', recovery: 'none' });
  }
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

function invalidDocument() {
  return new ProductHttpError({ statusCode: 422, code: 'invalid_document',
    message: 'The Sync Trash command document is invalid.' });
}
