import type { FastifyRequest } from 'fastify';
import type { AuthenticatedSession, IdentityUnitOfWork } from '../modules/identity/index.js';
import { requireProductActor } from './session-auth.js';

export interface MutationActorDeps {
  readonly identityUnitOfWork: IdentityUnitOfWork;
  readonly allowedOrigins: readonly string[];
  readonly csrfMatches?: (raw: string, expectedHash: string) => boolean;
}

/**
 * Mutate admission: the shared Product actor with write access.
 * Cookie keeps idle-slide (`touch: true`) then Origin + CSRF.
 * Bearer requires `product:write` and never uses CSRF.
 * Returns the same `{ account, session? }` shape as `requireSessionActor`.
 */
export async function requireMutationActor(
  request: FastifyRequest,
  deps: MutationActorDeps,
): Promise<AuthenticatedSession | { readonly account: AuthenticatedSession['account'] }> {
  return requireProductActor(request, deps, { access: 'write', touch: true });
}
