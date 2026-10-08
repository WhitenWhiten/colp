import type { FastifyReply, FastifyRequest } from 'fastify';
import { observeBestEffort } from '../../infrastructure/async/best-effort.js';
import {
  AccountCredentialCommandError,
  AccountCredentialCursorError,
  AccountCredentialInputError,
  type AccountCredentialCommandOutcome,
} from '../../modules/auth/index.js';
import type { PostgresAccountCredentialUnitOfWork } from '../../infrastructure/auth/account-credentials-postgres.js';
import type { AccountCredentialCursorCodec } from '../../modules/auth/index.js';
import type { ProductAdmissionRateLimiter } from '../http-security.js';
import { consumeProductAdmission } from '../http-security.js';
import { sendProductCommandReceiptOutcome } from '../product-command-mapping.js';
import { ProductHttpError } from '../product-error.js';
import { productErrorStatus } from '../product-codes.js';

const STRONG_ENTITY_TAG = /^"[^"\r\n]+"$/;

export interface AccountCredentialRouteDependencies {
  readonly enabled: boolean;
  readonly unitOfWork: PostgresAccountCredentialUnitOfWork;
  readonly cursors: AccountCredentialCursorCodec | null;
  readonly rateLimiter: ProductAdmissionRateLimiter;
  readonly timeoutMs: number;
}

export function readOptionalIfMatch(request: FastifyRequest): string | undefined {
  const raw = request.headers['if-match'];
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  if (!STRONG_ENTITY_TAG.test(raw)) {
    throw new ProductHttpError({
      statusCode: 400,
      code: 'invalid_request',
      message: 'If-Match must be a single strong entity-tag.',
    });
  }
  return raw;
}

export function sendIssued(
  reply: FastifyReply,
  outcome: AccountCredentialCommandOutcome<unknown>,
  status: number,
): FastifyReply {
  if (outcome.kind !== 'succeeded') return sendProductCommandReceiptOutcome(reply, outcome);
  reply.header('ETag', outcome.etag);
  return reply.code(status).type('application/json; charset=utf-8').send(outcome.body);
}

export function sendRevoked(
  reply: FastifyReply,
  outcome: AccountCredentialCommandOutcome<unknown>,
): FastifyReply {
  if (outcome.kind !== 'succeeded') return sendProductCommandReceiptOutcome(reply, outcome);
  reply.header('ETag', outcome.etag);
  return reply.code(200).type('application/json; charset=utf-8').send(outcome.body);
}

export function sendCredential(reply: FastifyReply, body: unknown, etag: string): FastifyReply {
  reply.header('ETag', etag);
  return reply.code(200).type('application/json; charset=utf-8').send(body);
}

export async function admit(limiter: ProductAdmissionRateLimiter, key: string): Promise<void> {
  const decision = await consumeProductAdmission(limiter, key);
  if (decision.kind === 'failed') throw unavailable();
  if (decision.kind === 'denied') {
    throw new ProductHttpError({
      statusCode: 429,
      code: 'rate_limited',
      message: 'Too many credential requests.',
      recovery: 'same_request',
      sameRequestRetrySafe: true,
      retryAfterSeconds: decision.retryAfterSeconds,
      headers: { 'Retry-After': String(decision.retryAfterSeconds) },
    });
  }
}

export function mapAccountCredentialError(error: unknown): ProductHttpError {
  if (error instanceof ProductHttpError) return error;
  if (error instanceof AccountCredentialInputError) {
    return new ProductHttpError({
      statusCode: productErrorStatus(error.code),
      code: error.code,
      message: error.message,
      recovery: error.code === 'invalid_cursor' ? 'restart_from_first_page' : 'user_action',
    });
  }
  if (error instanceof AccountCredentialCursorError) {
    if (error.code === 'snapshot_expired') {
      return new ProductHttpError({
        statusCode: 409,
        code: 'snapshot_expired',
        message: error.message,
        recovery: 'restart_from_first_page',
      });
    }
    return new ProductHttpError({
      statusCode: 400,
      code: 'invalid_cursor',
      message: error.message,
      recovery: 'restart_from_first_page',
    });
  }
  if (error instanceof AccountCredentialCommandError) {
    if (error.code === 'precondition_required') {
      return new ProductHttpError({
        statusCode: 428,
        code: 'precondition_required',
        message: error.message,
        recovery: 'refresh_and_retry',
        precondition: 'resource',
      });
    }
    if (error.code === 'precondition_failed') {
      return new ProductHttpError({
        statusCode: 412,
        code: 'precondition_failed',
        message: error.message,
        recovery: 'refresh_and_retry',
        precondition: 'resource',
        currentEtag: error.currentEtag,
      });
    }
    if (error.code === 'rate_limited') {
      const retryAfterSeconds = error.retryAfterSeconds ?? 1;
      return new ProductHttpError({
        statusCode: 429,
        code: 'rate_limited',
        message: error.message,
        recovery: 'same_request',
        sameRequestRetrySafe: true,
        retryAfterSeconds,
        headers: { 'Retry-After': String(retryAfterSeconds) },
      });
    }
    return new ProductHttpError({
      statusCode: productErrorStatus(error.code),
      code: error.code,
      message: error.message,
      recovery: error.code === 'resource_not_found' ? 'none' : 'user_action',
    });
  }
  return unavailable();
}

export async function withTimeout<T>(request: FastifyRequest, timeoutMs: number, work: () => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let rejectAbort!: (error: Error) => void;
  const cancellation = new Promise<never>((_, reject) => { rejectAbort = reject; });
  observeBestEffort(cancellation, 'credential route cancellation');
  const timeout = setTimeout(() => { controller.abort(); rejectAbort(unavailable()); }, timeoutMs);
  timeout.unref?.();
  const abort = () => { controller.abort(); rejectAbort(unavailable()); };
  request.raw.once('aborted', abort);
  request.raw.socket.once('close', abort);
  try { return await Promise.race([work(), cancellation]); }
  finally {
    clearTimeout(timeout);
    request.raw.off('aborted', abort);
    request.raw.socket.off('close', abort);
  }
}

function notFound(): ProductHttpError {
  return new ProductHttpError({
    statusCode: 404,
    code: 'resource_not_found',
    message: 'The requested resource was not found.',
    recovery: 'none',
  });
}

function unavailable(): ProductHttpError {
  return new ProductHttpError({
    statusCode: productErrorStatus('feature_temporarily_unavailable'),
    code: 'feature_temporarily_unavailable',
    message: 'Account credentials are temporarily unavailable.',
    recovery: 'same_request',
    sameRequestRetrySafe: true,
    retryAfterSeconds: 1,
    headers: { 'Retry-After': '1' },
  });
}

export { notFound as accountCredentialNotFound };
