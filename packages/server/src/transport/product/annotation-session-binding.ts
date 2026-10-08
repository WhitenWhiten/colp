import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ProductActor } from '../session-auth.js';
import { ProductHttpError } from '../product-error.js';

/** Prevent an Extension command from being admitted after its browser cookie changes account. */
export function bindAnnotationSession(request: FastifyRequest, reply: FastifyReply, actor: ProductActor): void {
  const expected = request.headers['known-annotation-session'];
  const extension = typeof request.headers.origin === 'string'
    && /^chrome-extension:\/\/[a-p]{32}$/u.test(request.headers.origin);
  if ((extension || expected !== undefined) && (typeof expected !== 'string' || !expected || expected.length > 256
    || !('session' in actor) || actor.session.id !== expected)) {
    throw new ProductHttpError({ statusCode: 401, code: 'authentication_required',
      message: 'The browser session changed.', recovery: 'user_action' });
  }
  if ('session' in actor) reply.header('Known-Annotation-Session', actor.session.id);
}
