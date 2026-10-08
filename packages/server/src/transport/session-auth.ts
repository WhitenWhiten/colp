import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  authenticateSession,
  IdentityError,
  secretsMatch,
  type AuthenticatedSession,
  type IdentityUnitOfWork,
} from '../modules/identity/index.js';
import {
  BrowserSessionAuthenticationError,
  type BrowserSessionAuthority,
} from '../modules/auth/index.js';
import { ProductHttpError } from './product-error.js';
import { productErrorStatus } from './product-codes.js';
import { readSessionCookie } from './session-cookie.js';
import { requireAllowedOrigin, requireCsrfHeader } from './auth/origin-csrf.js';
import {
  hasAuthorizationHeader,
  hasCookieHeader,
  productBearerAuthorityOf,
  rejectMixedCarriers,
} from './product-actor.js';

declare module 'fastify' {
  interface FastifyInstance {
    /**
     * A3 BrowserSessionAuthority injected by the composition (buildApiApp).
     * Absent = legacy OIDC session authority still serves product routes
     * (Better Auth shadow mode / off; G1 §5-6). Never both.
     */
    readonly browserSessionAuthority?: BrowserSessionAuthority;
  }
}

export function authenticationRequired(): ProductHttpError {
  return new ProductHttpError({
    statusCode: 401,
    code: 'authentication_required',
    message: 'Authentication is required.',
    recovery: 'user_action',
  });
}

export function verificationRequired(): ProductHttpError {
  return new ProductHttpError({
    statusCode: productErrorStatus('verification_required'),
    code: 'verification_required',
    message: 'Email verification is required to complete this action.',
    recovery: 'user_action',
  });
}

/** Map BrowserSessionAuthenticationError to the product envelope (C-02). */
export function productErrorForBrowserSessionFailure(
  error: BrowserSessionAuthenticationError,
): ProductHttpError {
  if (error.code === 'verification_required') return verificationRequired();
  return authenticationRequired();
}

/** The authority decorated on the app, if the composition injected one. */
export function browserSessionAuthorityOf(request: FastifyRequest): BrowserSessionAuthority | null {
  const server = request.server as FastifyInstance;
  return server.browserSessionAuthority ?? null;
}

function browserSessionRequestOf(request: FastifyRequest): { readonly cookie?: string } {
  return { cookie: request.headers.cookie };
}

export type ProductAccess = 'read' | 'write';

export interface ProductActorDeps {
  readonly identityUnitOfWork: IdentityUnitOfWork;
  readonly allowedOrigins?: readonly string[];
  readonly csrfMatches?: (raw: string, expectedHash: string) => boolean;
}

export type ProductActor =
  | AuthenticatedSession
  | { readonly account: AuthenticatedSession['account'] };

/**
 * Shared Product admission: mixed Cookie+Authorization is rejected; bearer
 * (no Cookie) uses the product-audience JWT; Cookie uses the browser session.
 * Writes keep Origin+CSRF on the Cookie path only.
 */
export async function requireProductActor(
  request: FastifyRequest,
  deps: ProductActorDeps,
  options: { readonly access: ProductAccess; readonly touch: boolean },
): Promise<ProductActor> {
  rejectMixedCarriers(request);
  if (hasAuthorizationHeader(request) && !hasCookieHeader(request)) {
    const authority = productBearerAuthorityOf(request);
    if (!authority) throw authenticationRequired();
    const actor = options.access === 'write'
      ? await authority.requireWrite(request)
      : await authority.requireRead(request);
    return { account: actor.account };
  }
  const authenticated = await requireCookieSessionActor(request, deps.identityUnitOfWork, {
    touch: options.touch,
  });
  if (options.access === 'write') {
    requireAllowedOrigin(request, deps.allowedOrigins ?? []);
    requireCsrfHeader(
      request,
      authenticated.session.csrfTokenHash,
      deps.csrfMatches ?? secretsMatch,
    );
  }
  return authenticated;
}

/**
 * Read the browser session cookie, authenticate (optionally sliding idle),
 * return account + session. `touch` is required: a new GET must not silently
 * idle-slide (C-07). Heartbeat is GET `/api/v1/me` only. Product-audience
 * bearer with `product:read` is an alternative when Authorization is present
 * without Cookie.
 */
export async function requireSessionActor(
  request: FastifyRequest,
  identityUnitOfWork: IdentityUnitOfWork,
  options: { readonly touch: boolean },
): Promise<ProductActor> {
  return requireProductActor(request, { identityUnitOfWork }, { access: 'read', touch: options.touch });
}

/** Browser-cookie-only read admission for private surfaces that reject Product bearer tokens. */
export async function requireBrowserSessionActor(
  request: FastifyRequest,
  identityUnitOfWork: IdentityUnitOfWork,
  options: { readonly touch: boolean },
): Promise<AuthenticatedSession> {
  rejectMixedCarriers(request);
  return requireCookieSessionActor(request, identityUnitOfWork, options);
}

async function requireCookieSessionActor(
  request: FastifyRequest,
  identityUnitOfWork: IdentityUnitOfWork,
  options: { readonly touch: boolean },
): Promise<AuthenticatedSession> {
  const authority = browserSessionAuthorityOf(request);
  if (authority) {
    try {
      return await authority.requireMutationActor(browserSessionRequestOf(request), {
        touch: options.touch,
      });
    } catch (error: unknown) {
      if (error instanceof BrowserSessionAuthenticationError) {
        throw productErrorForBrowserSessionFailure(error);
      }
      throw error;
    }
  }
  const raw = readSessionCookie(request);
  if (!raw) throw authenticationRequired();
  try {
    return await identityUnitOfWork.execute((ports) =>
      authenticateSession(ports, raw, { touch: options.touch }));
  } catch (error: unknown) {
    if (error instanceof IdentityError) throw authenticationRequired();
    throw error;
  }
}

export async function optionalSessionActor(
  request: FastifyRequest,
  identityUnitOfWork: IdentityUnitOfWork | undefined,
  options?: { readonly bearer?: 'optional' | 'ignore' },
): Promise<ProductActor | null> {
  if (options?.bearer === 'ignore') {
    // Bearer-blind public surfaces (e.g. the slug public page) declare only
    // cookieAuth + anonymous in the contract: Authorization is not a credential
    // there, so neither a bad bearer nor a mixed carrier may change the outcome.
    const authority = browserSessionAuthorityOf(request);
    if (authority) {
      return authority.authenticate(browserSessionRequestOf(request), { touch: false });
    }
    if (!identityUnitOfWork) return null;
    const raw = readSessionCookie(request);
    if (!raw) return null;
    try {
      return await identityUnitOfWork.execute((ports) => authenticateSession(ports, raw, { touch: false }));
    } catch (error) {
      if (error instanceof IdentityError) return null;
      throw error;
    }
  }
  rejectMixedCarriers(request);
  if (hasAuthorizationHeader(request) && !hasCookieHeader(request)) {
    const authority = productBearerAuthorityOf(request);
    if (!authority) throw authenticationRequired();
    const actor = await authority.requireRead(request);
    return { account: actor.account };
  }
  const authority = browserSessionAuthorityOf(request);
  if (authority) {
    return authority.authenticate(browserSessionRequestOf(request), { touch: false });
  }
  if (!identityUnitOfWork) return null;
  const raw = readSessionCookie(request);
  if (!raw) return null;
  try {
    return await identityUnitOfWork.execute((ports) => authenticateSession(ports, raw, { touch: false }));
  } catch (error) {
    if (error instanceof IdentityError) return null;
    throw error;
  }
}
