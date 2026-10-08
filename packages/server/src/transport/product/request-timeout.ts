import type { FastifyRequest } from 'fastify';
import { ProductHttpError } from '../product-error.js';
import { productErrorStatus } from '../product-codes.js';

const FAVICON_TIMEOUT_MESSAGE = 'Favicon policy is temporarily unavailable.';

function unavailable(message: string): ProductHttpError {
  return new ProductHttpError({
    statusCode: productErrorStatus('feature_temporarily_unavailable'),
    code: 'feature_temporarily_unavailable',
    message,
    recovery: 'same_request',
    sameRequestRetrySafe: true,
    retryAfterSeconds: 1,
    headers: { 'Retry-After': '1' },
  });
}

/**
 * Bound a route's wait, abort the work's signal so a unit of work can
 * `pg_cancel_backend`, then surface the timeout as 503.
 */
export async function withCancellation<T>(
  request: FastifyRequest,
  timeoutMs: number,
  work: (signal: AbortSignal) => Promise<T>,
  timeoutMessage: string = FAVICON_TIMEOUT_MESSAGE,
): Promise<T> {
  const timeoutError = () => unavailable(timeoutMessage);
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(timeoutError());
  }, timeoutMs);
  timeout.unref?.();
  const abort = () => controller.abort(timeoutError());
  request.raw.once('aborted', abort);
  request.raw.socket.once('close', abort);
  try {
    const result = await work(controller.signal);
    if (timedOut || controller.signal.aborted) throw timeoutError();
    return result;
  } finally {
    clearTimeout(timeout);
    request.raw.off('aborted', abort);
    request.raw.socket.off('close', abort);
  }
}
