import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../../bootstrap/config.js';
import { canonicalCommandFingerprint, canonicalJson } from '../../modules/commands/index.js';
import type { IdentityUnitOfWork } from '../../modules/identity/index.js';
import { getReadingProgressItem, getReadingProgressPage, ReadingProgressError, ReadingProgressQueryError,
  READING_PROGRESS_PAGE_MAX_LIMIT, readingProgressCommandScope, readingProgressEtag, resetReadingProgress,
  upsertReadingProgress, type ReadingProgressErrorCode, type ReadingProgressReadUnitOfWork,
  type ReadingProgressResourceType, type ReadingProgressStatus, type ReadingProgressUnitOfWork } from '../../modules/reading-progress/index.js';
import { productErrorStatus } from '../product-codes.js';
import { readKnownCommandId, readRequiredIfMatch } from './collection-route-helpers.js';
import { sendProductCommandReceiptOutcome } from '../product-command-mapping.js';
import { ProductHttpError } from '../product-error.js';
import { productRouteMetadata } from '../product-route-manifest.js';
import { isAbortReason, productReadDeadlineMs, requestCancellation } from './publication-request-cancel.js';
import { requireSessionActor } from '../session-auth.js';
import { requireMutationActor } from '../mutation-actor.js';

const LIST = '/api/v1/reading-progress';
const ITEM = '/api/v1/reading-progress/:resourceType/:resourceId';
export interface ReadingProgressRoutesDeps { config: AppConfig; identityUnitOfWork: IdentityUnitOfWork;
  readingProgressReadUnitOfWork: ReadingProgressReadUnitOfWork; readingProgressUnitOfWork: ReadingProgressUnitOfWork }
export function registerReadingProgressRoutes(app: FastifyInstance, deps: ReadingProgressRoutesDeps) {
  app.get(LIST, { config: { ...productRouteMetadata('GET', LIST), productTransport: { allowedQuery: ['status','limit','cursor'], duplicateQueryErrorCode: 'invalid_query', cacheControl: 'private-no-store' } } }, async (request, reply) => {
    const cancellation = requestCancellation(request, reply, productReadDeadlineMs(deps.config.httpSecurity.requestTimeoutMs));
    try {
      const actor = await sessionActor(request, deps);
      const page = await deps.readingProgressReadUnitOfWork.execute((ports) => getReadingProgressPage(ports, { actor, ...parseListQuery(request.query as Record<string,string>) }), { signal: cancellation.signal });
      return reply.code(200).type('application/json; charset=utf-8').send(page);
    } catch (error) { throw mapReadingProgressError(error); }
    finally { cancellation.dispose(); }
  });
  app.get(ITEM, { config: { ...productRouteMetadata('GET', ITEM), productTransport: { allowedQuery: [], cacheControl: 'private-no-store' } } }, async (request, reply) => {
    const cancellation = requestCancellation(request, reply, productReadDeadlineMs(deps.config.httpSecurity.requestTimeoutMs));
    try {
      const actor = await sessionActor(request, deps); const target = params(request);
      const item = await deps.readingProgressReadUnitOfWork.execute((ports) => getReadingProgressItem(ports, { actor, ...target }), { signal: cancellation.signal });
      if (!item) throw notFound(); return reply.code(200).header('ETag', item.etag).type('application/json; charset=utf-8').send(item);
    } catch (error) { throw mapReadingProgressError(error); }
    finally { cancellation.dispose(); }
  });
  app.put(ITEM, { config: { ...productRouteMetadata('PUT', ITEM), productTransport: { allowedQuery: [], acceptedMediaTypes: ['application/json'], bodyLimitBytes: 256, cacheControl: 'private-no-store' } } }, async (request, reply) => {
    const cancellation = requestCancellation(request, reply, productReadDeadlineMs(deps.config.httpSecurity.requestTimeoutMs));
    try { return await putReadingProgress(request, reply, deps, cancellation.signal); }
    finally { cancellation.dispose(); }
  });
  app.delete(ITEM, { config: { ...productRouteMetadata('DELETE', ITEM), productTransport: { allowedQuery: [], acceptedMediaTypes: [], cacheControl: 'private-no-store' } } }, async (request, reply) => {
    const cancellation = requestCancellation(request, reply, productReadDeadlineMs(deps.config.httpSecurity.requestTimeoutMs));
    try { return await deleteReadingProgress(request, reply, deps, cancellation.signal); }
    finally { cancellation.dispose(); }
  });
}
async function putReadingProgress(request: FastifyRequest, reply: FastifyReply, deps: ReadingProgressRoutesDeps, signal: AbortSignal) {
    const actor = await mutationActor(request, deps); const target = params(request); const state = body(request.body);
    const expectedEtag = request.headers['if-match'] === undefined ? null : readRequiredIfMatch(request);
    const commandId = readKnownCommandId(request); const route = `/api/v1/reading-progress/${target.resourceType}/${target.resourceId}`;
    const fingerprint = canonicalCommandFingerprint({ method: 'PUT', route, mediaType: 'application/json', body: state, query: {}, conditions: { ifMatch: expectedEtag } });
    try { const outcome = await deps.readingProgressUnitOfWork.execute((ports) => upsertReadingProgress(ports, { actor,
        command: { commandId, fingerprint, commandScope: readingProgressCommandScope('upsert', target) }, target, state, concurrency: { expectedEtag } }), { signal });
      if (isReceipt(outcome)) return sendProductCommandReceiptOutcome(reply, outcome);
      if (outcome.kind !== 'upserted') throw new Error('Reading Progress PUT returned an invalid command outcome.');
      const record = outcome.readingProgress; const response = { status: record.status, progress: record.progress,
        completedAt: record.completedAt?.toISOString() ?? null, updatedAt: record.updatedAt.toISOString() };
      return reply.code(outcome.inserted ? 201 : 200).header('ETag', readingProgressEtag(record)).type('application/json').send(Buffer.from(canonicalJson(response)));
    } catch (error) { throw mapReadingProgressError(error); }
}
async function deleteReadingProgress(request: FastifyRequest, reply: FastifyReply, deps: ReadingProgressRoutesDeps, signal: AbortSignal) {
    const actor = await mutationActor(request, deps); const target = params(request); const expectedEtag = readRequiredIfMatch(request);
    const commandId = readKnownCommandId(request); const route = `/api/v1/reading-progress/${target.resourceType}/${target.resourceId}`;
    const fingerprint = canonicalCommandFingerprint({ method: 'DELETE', route, mediaType: '', body: null, query: {}, conditions: { ifMatch: expectedEtag } });
    try { const outcome = await deps.readingProgressUnitOfWork.execute((ports) => resetReadingProgress(ports, { actor,
        command: { commandId, fingerprint, commandScope: readingProgressCommandScope('reset', target) }, target, concurrency: { expectedEtag } }), { signal });
      if (isReceipt(outcome)) return sendProductCommandReceiptOutcome(reply, outcome); return reply.code(204).send();
    } catch (error) { throw mapReadingProgressError(error); }
}
async function sessionActor(request: FastifyRequest, deps: ReadingProgressRoutesDeps) { const { account } = await requireSessionActor(request, deps.identityUnitOfWork, { touch: false }); return { accountId: account.id, principalId: account.id, subjectId: account.subjectId }; }
async function mutationActor(request: FastifyRequest, deps: ReadingProgressRoutesDeps) { const { account } = await requireMutationActor(request, { identityUnitOfWork: deps.identityUnitOfWork, allowedOrigins: deps.config.allowedOrigins }); return { accountId: account.id, principalId: account.id, subjectId: account.subjectId }; }
function params(request: FastifyRequest) { const raw = request.params as { resourceType?: string; resourceId?: string }; if ((raw.resourceType !== 'collection' && raw.resourceType !== 'node') || !raw.resourceId || raw.resourceId !== raw.resourceId.trim()) throw invalidQuery(); return { resourceType: raw.resourceType as ReadingProgressResourceType, resourceId: raw.resourceId }; }
function parseListQuery(query: Record<string,string>) { let status: ReadingProgressStatus | undefined; if (query.status !== undefined) { if (!['not_started','in_progress','completed'].includes(query.status)) throw invalidQuery(); status = query.status as ReadingProgressStatus; }
  if (query.cursor !== undefined && (!query.cursor || query.cursor.length > 2048 || query.limit !== undefined)) throw invalidQuery(); let limit: number | undefined;
  if (query.limit !== undefined) { if (!/^[1-9][0-9]*$/u.test(query.limit) || Number(query.limit) > READING_PROGRESS_PAGE_MAX_LIMIT) throw invalidQuery(); limit = Number(query.limit); }
  return { ...(status ? { status } : {}), ...(limit ? { limit } : {}), ...(query.cursor ? { cursor: query.cursor } : {}) }; }
function body(value: unknown): { status: ReadingProgressStatus; progress: number } { if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidDocument(); const input = value as Record<string,unknown>; if (Object.keys(input).some((key) => key !== 'status' && key !== 'progress')) throw invalidDocument(); return { status: input.status as ReadingProgressStatus, progress: input.progress as number }; }
function isReceipt(outcome: { kind: string }): outcome is Extract<Awaited<ReturnType<typeof upsertReadingProgress>>, { kind: 'replay' | 'in_progress' | 'reused' | 'expired' }> { return ['replay','in_progress','reused','expired'].includes(outcome.kind); }
export function mapReadingProgressError(error: unknown): ProductHttpError {
  if (error instanceof ProductHttpError) return error;
  if (isAbortReason(error)) return new ProductHttpError({ statusCode: productErrorStatus('feature_temporarily_unavailable'), code: 'feature_temporarily_unavailable', message: 'The request was cancelled.', recovery: 'same_request' });
  if (error instanceof ReadingProgressQueryError) return READING_PROGRESS_QUERY_ERROR_MAP[error.code](error);
  if (error instanceof ReadingProgressError) return READING_PROGRESS_ERROR_MAP[error.code](error);
  throw error;
}
const READING_PROGRESS_QUERY_ERROR_MAP = {
  invalid_cursor: (error) => new ProductHttpError({ statusCode: productErrorStatus('invalid_cursor'), code: 'invalid_cursor', message: error.message, recovery: 'restart_from_first_page' }),
  invalid_reading_progress_query: (error) => new ProductHttpError({ statusCode: productErrorStatus('invalid_query'), code: 'invalid_query', message: error.message, recovery: 'user_action' }),
} as const satisfies Readonly<Record<ReadingProgressQueryError['code'], (error: ReadingProgressQueryError) => ProductHttpError>>;
const READING_PROGRESS_ERROR_MAP = {
  reading_progress_not_found: notFound,
  reading_progress_precondition_failed: (error) => new ProductHttpError({ statusCode: productErrorStatus('precondition_failed'), code: 'precondition_failed', message: error.message, recovery: 'refresh_and_retry', precondition: 'resource', currentEtag: error.currentEtag }),
  invalid_reading_progress_input: invalidDocument,
  invalid_reading_progress_target: invalidDocument,
  invalid_reading_progress_state: invalidDocument,
} as const satisfies Readonly<Record<ReadingProgressErrorCode, (error: ReadingProgressError) => ProductHttpError>>;
function invalidQuery() { return new ProductHttpError({ statusCode: productErrorStatus('invalid_query'), code: 'invalid_query', message: 'The Reading Progress query or target is invalid.', recovery: 'user_action' }); }
function invalidDocument() { return new ProductHttpError({ statusCode: productErrorStatus('invalid_document'), code: 'invalid_document', message: 'Reading Progress accepts only status and progress.', recovery: 'user_action' }); }
function notFound() { return new ProductHttpError({ statusCode: productErrorStatus('resource_not_found'), code: 'resource_not_found', message: 'Reading Progress was not found.', recovery: 'none' }); }
