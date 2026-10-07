import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Client-disconnect/timeout cancellation for Publication reads (FIX-L-015).
 *
 * Aborts when the request socket closes (client disconnect or the server-level
 * `requestTimeout` destroying the socket) so the cache reader and the origin
 * PostgreSQL query can stop early. The controller is a plain client
 * cancellation: `dispose()` must run when the handler settles so a completed
 * response never trips the listener.
 */
export function requestCancellation(
  request: FastifyRequest,
  reply: FastifyReply,
  deadlineMs?: number,
): {
  signal: AbortSignal;
  dispose(): void;
} {
  const controller = new AbortController();
  const abort = (): void => controller.abort(new DOMException('Client disconnected', 'AbortError'));
  const deadline = deadlineMs !== undefined && deadlineMs > 0
    ? setTimeout(() => controller.abort(new DOMException('Handler deadline exceeded', 'AbortError')), deadlineMs)
    : undefined;
  deadline?.unref?.();
  request.raw.once('aborted', abort);
  request.raw.socket?.once('close', abort);
  reply.raw.once('close', abort);
  return {
    signal: controller.signal,
    dispose(): void {
      if (deadline) clearTimeout(deadline);
      request.raw.off('aborted', abort);
      request.raw.socket?.off('close', abort);
      reply.raw.off('close', abort);
    },
  };
}

/** Fastify's socket requestTimeout does not cancel a handler. These reads install their own deadline. */
export function productReadDeadlineMs(requestTimeoutMs: number): number {
  return requestTimeoutMs > 0 ? requestTimeoutMs : 30_000;
}

export function isAbortReason(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/**
 * A cache abort means the client disconnected (or the server request timeout
 * fired) while the read was in flight: the response is undeliverable and the
 * cancellation is not a server failure, so never fabricate a 5xx.
 */
export function abortPublicationRead(reply: FastifyReply): FastifyReply {
  if (!reply.raw.headersSent) reply.hijack();
  reply.raw.destroy();
  return reply;
}
