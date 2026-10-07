import type { FastifyReply, FastifyRequest } from 'fastify';
import { CreditError } from '../../modules/identity/index.js';
import { ProductHttpError, productErrorEnvelope } from '../product-error.js';

export type CreditHttpCode = 'invalid_cursor' | 'cursor_expired' | 'credits_busy' | 'credits_reconciling' | 'credits_unavailable';

export class CreditHttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: CreditHttpCode,
    message: string,
    readonly recovery: 'same_request' | 'restart_from_first_page' | 'user_action' = 'user_action',
    readonly sameRequestRetrySafe = false,
  ) { super(message); this.name = 'CreditHttpError'; }
}

/** Extends only the credit surface; the frozen base Product error enum is unchanged. */
export function sendCreditError(request: FastifyRequest, reply: FastifyReply, failure: CreditError): FastifyReply {
  const needsContext = ['credit_price_changed', 'credit_limit_exceeded', 'insufficient_credits'].includes(failure.code);
  const code = needsContext && !failure.creditContext ? 'credits_unavailable' : failure.code;
  const status = code === 'billing_consent_required' ? 422 : code.startsWith('credits_') ? 503 : 409;
  const retry = status === 503;
  const envelope = productErrorEnvelope(request.id, new ProductHttpError({
    statusCode: status, code: 'feature_temporarily_unavailable',
    message: retry ? 'Credits could not be confirmed. Retry the same request.' : 'Classification credit consent could not be accepted.',
    recovery: retry ? 'same_request' : 'user_action', sameRequestRetrySafe: retry,
    retryAfterSeconds: retry ? 1 : null,
  }));
  if (retry) reply.header('Retry-After', '1');
  return reply.code(status).header('Cache-Control', 'private, no-store').header('X-Request-Id', request.id)
    .type('application/json; charset=utf-8').send({ error: { ...envelope.error, code,
      ...(needsContext && failure.creditContext ? { creditContext: failure.creditContext } : {}) } });
}

export function sendCreditHttpError(request: FastifyRequest, reply: FastifyReply, failure: CreditHttpError): FastifyReply {
  const envelope = productErrorEnvelope(request.id, new ProductHttpError({
    statusCode: failure.statusCode, code: 'feature_temporarily_unavailable', message: failure.message,
    recovery: failure.recovery, sameRequestRetrySafe: failure.sameRequestRetrySafe,
    retryAfterSeconds: failure.sameRequestRetrySafe ? 1 : null,
  }));
  const body = { error: { ...envelope.error, code: failure.code } };
  if (failure.sameRequestRetrySafe) reply.header('Retry-After', '1');
  return reply.code(failure.statusCode).header('Cache-Control', 'private, no-store')
    .header('X-Request-Id', request.id).type('application/json; charset=utf-8').send(body);
}
