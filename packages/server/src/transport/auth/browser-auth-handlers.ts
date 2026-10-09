import { AVATAR_READ_TIMEOUT_MS } from '../../modules/identity/index.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { BrowserSessionAuthenticationError } from '../../modules/auth/index.js';
import {
  authenticateSession,
  bootstrapBrowserSession,
  getAccountWithProfile,
  revokeSession,
  secretsMatch,
  updateProfileSettingsWithReceipt,
  uploadAvatar,
  prepareAvatarUpload,
  assertAvatarImage,
  AVATAR_ALLOWED_CONTENT_TYPES,
  AVATAR_MAX_BYTES,
  type IdentityPorts,
  type UpdateProfileSettingsCommandResult,
  type UploadAvatarResult,
} from '../../modules/identity/index.js';
import { IdentityError } from '../../modules/identity/index.js';
import {
  requireAllowedOrigin,
  requireCsrfHeader,
} from './origin-csrf.js';
import { authenticationRequired, requireSessionActor } from '../session-auth.js';
import { requireMutationActor } from '../mutation-actor.js';
import {
  hasAuthorizationHeader,
  hasCookieHeader,
  productBearerAuthorityOf,
  rejectMixedCarriers,
} from '../product-actor.js';
import { productRouteMetadata } from '../product-route-manifest.js';
import { readKnownCommandId } from '../product/collection-route-helpers.js';
import { sendProductCommandReceiptOutcome } from '../product-command-mapping.js';
import { ProductHttpError } from '../product-error.js';
import {
  admitPublicObjectGet,
  createPublicObjectRateLimiter,
} from '../product/public-object-rate-limit.js';
import { productErrorStatus } from '../product-codes.js';
import {
  clearSessionCookie,
  readSessionCookie,
  setSessionCookie,
} from '../session-cookie.js';
import type { BrowserAuthDeps } from './browser-auth-deps.js';
import {
  linkingUnavailable,
  mapAccountDeletionError,
  mapAccountLinkingError,
  mapAccountRecoveryError,
  mapBrowserSessionFailure,
  mapProfileSettingsError,
  missingAccountHandle,
  parseDeleteAccountBody,
  parseLinkStartBody,
  parseOtpResetBody,
  parseProfileSettingsBody,
  parseRecoveryRequestEmail,
  parseRevokeSessionByIdBody,
  parseUnlinkBody,
  sessionInventoryUnavailable,
  toMeView,
  toUtc,
} from './browser-auth-mapping.js';

export function registerAccountLinkingRoutes(app: FastifyInstance, deps: BrowserAuthDeps): void {

  // --- C3 explicit account linking (plan §9 C3 steps 4-5; facade-gated) ---
  // The product link surface replaces the BA-mounted /oauth2/link: the route
  // runs the A3 current-session check + Origin/CSRF + a re-auth proof before
  // the OAuth state/PKCE flow starts, and forwards the state cookie(s) the
  // callback requires. Unlink refuses when it would remove the last recovery
  // method.
  if (deps.accountLinking) {
    const linking = deps.accountLinking;
    app.post('/api/v1/auth/oauth2/link', {
      config: {
        productTransport: {
          allowedQuery: [],
          acceptedMediaTypes: ['application/json'],
          bodyLimitBytes: 4096,
          cacheControl: 'no-store',
        },
      },
    }, async (request, reply) => {
      rejectMixedCarriers(request);
      const authority = deps.browserSessionAuthority;
      if (!authority) {
        throw linkingUnavailable();
      }
      const actor = await authority.requireMutationActor(
        { cookie: request.headers.cookie },
        { touch: true },
      ).catch(mapBrowserSessionFailure);
      requireAllowedOrigin(request, deps.config.allowedOrigins);
      requireCsrfHeader(request, actor.session.csrfTokenHash, secretsMatch);
      const body = parseLinkStartBody(request.body);
      let result;
      try {
        result = await linking.beginProviderLink({
          cookie: request.headers.cookie,
          providerId: body.providerId,
          callbackURL: body.callbackURL,
          ...(body.errorCallbackURL === undefined ? {} : { errorCallbackURL: body.errorCallbackURL }),
          reauth: body.reauth,
        });
      } catch (error) {
        throw mapAccountLinkingError(error);
      }
      // Forward the OAuth state cookie(s) exactly as Better Auth issued them
      // (the callback resolves the state-bound callback URL from them).
      for (const cookieValue of result.stateCookies) {
        reply.raw.appendHeader('set-cookie', cookieValue);
      }
      return reply.code(200).send({ url: result.url, redirect: true });
    });

    app.get('/api/v1/auth/linked-accounts', {
      config: {
        productTransport: {
          allowedQuery: [],
          cacheControl: 'private-no-store',
        },
      },
    }, async (request, reply) => {
      rejectMixedCarriers(request);
      const authority = deps.browserSessionAuthority;
      if (!authority) {
        throw linkingUnavailable();
      }
      await authority.requireMutationActor(
        { cookie: request.headers.cookie },
        { touch: false },
      ).catch(mapBrowserSessionFailure);
      let listed;
      try {
        listed = await linking.listLinkedProviders({ cookie: request.headers.cookie });
      } catch (error) {
        throw mapAccountLinkingError(error);
      }
      // Product linking GET (not a frozen OpenAPI BA path): social rows only
      // plus whether a credential exists. Never include the password hash or
      // the credential accountId in `accounts`.
      return reply.code(200).send({ accounts: listed.accounts, hasPassword: listed.hasPassword });
    });

    app.post('/api/v1/auth/unlink-account', {
      config: {
        productTransport: {
          allowedQuery: [],
          acceptedMediaTypes: ['application/json'],
          bodyLimitBytes: 4096,
          cacheControl: 'no-store',
        },
      },
    }, async (request, reply) => {
      rejectMixedCarriers(request);
      const authority = deps.browserSessionAuthority;
      if (!authority) {
        throw linkingUnavailable();
      }
      const actor = await authority.requireMutationActor(
        { cookie: request.headers.cookie },
        { touch: true },
      ).catch(mapBrowserSessionFailure);
      requireAllowedOrigin(request, deps.config.allowedOrigins);
      requireCsrfHeader(request, actor.session.csrfTokenHash, secretsMatch);
      const body = parseUnlinkBody(request.body);
      try {
        await linking.unlinkProvider({
          cookie: request.headers.cookie,
          providerId: body.providerId,
          accountId: body.accountId,
          reauth: body.reauth,
        });
      } catch (error) {
        throw mapAccountLinkingError(error);
      }
      return reply.code(200).send({ status: true });
    });
  }
}

export function registerAccountDeletionRoutes(app: FastifyInstance, deps: BrowserAuthDeps): void {

  // --- P10 account deletion (session + Origin/CSRF + reauth + typed DELETE) ---
  if (deps.accountDeletion) {
    const deletion = deps.accountDeletion;
    app.post('/api/v1/auth/account/delete', {
      config: {
        productTransport: {
          allowedQuery: [],
          acceptedMediaTypes: ['application/json'],
          bodyLimitBytes: 4096,
          cacheControl: 'no-store',
        },
      },
    }, async (request, reply) => {
      rejectMixedCarriers(request);
      const authority = deps.browserSessionAuthority;
      if (!authority) {
        throw linkingUnavailable();
      }
      const actor = await authority.requireMutationActor(
        { cookie: request.headers.cookie },
        { touch: true },
      ).catch(mapBrowserSessionFailure);
      requireAllowedOrigin(request, deps.config.allowedOrigins);
      requireCsrfHeader(request, actor.session.csrfTokenHash, secretsMatch);
      const body = parseDeleteAccountBody(request.body);
      try {
        await deletion.deleteAccount({
          cookie: request.headers.cookie,
          confirmation: body.confirmation,
          reauth: body.reauth,
        });
      } catch (error) {
        throw mapAccountDeletionError(error);
      }
      clearSessionCookie(reply);
      return reply.code(200).send({ status: true });
    });
  }
}

export function registerAccountRecoveryRoutes(app: FastifyInstance, deps: BrowserAuthDeps): void {

  // --- C3 account recovery (plan §9 C3 step 6; facade-gated) ---
  // Recovery goes through a verified-email OTP / password-reset proof only;
  // a provider email claim can never reset or adopt an account. Both routes
  // are unauthenticated POSTs (the user lost their session) — the Origin
  // admission is the CSRF line.
  if (deps.accountRecovery) {
    const recovery = deps.accountRecovery;
    app.post('/api/v1/auth/recovery/password-reset', {
      config: {
        productTransport: {
          allowedQuery: [],
          acceptedMediaTypes: ['application/json'],
          bodyLimitBytes: 2048,
          cacheControl: 'no-store',
        },
      },
    }, async (request, reply) => {
      requireAllowedOrigin(request, deps.config.allowedOrigins);
      const body = parseRecoveryRequestEmail(request.body);
      try {
        await recovery.requestPasswordRecovery({ email: body.email });
      } catch (error) {
        throw mapAccountRecoveryError(error);
      }
      // Non-enumerating success shape — identical for known and unknown
      // emails (delivery only happens for existing users).
      return reply.code(200).send({ status: true });
    });

    app.post('/api/v1/auth/recovery/otp-reset', {
      config: {
        productTransport: {
          allowedQuery: [],
          acceptedMediaTypes: ['application/json'],
          bodyLimitBytes: 4096,
          cacheControl: 'no-store',
        },
      },
    }, async (request, reply) => {
      requireAllowedOrigin(request, deps.config.allowedOrigins);
      const body = parseOtpResetBody(request.body);
      try {
        await recovery.recoverWithVerifiedEmailOtp({
          email: body.email,
          otp: body.otp,
          newPassword: body.newPassword,
        });
      } catch (error) {
        throw mapAccountRecoveryError(error);
      }
      return reply.code(200).send({ status: true });
    });
  }
}

export function registerSessionInventoryRoutes(app: FastifyInstance, deps: BrowserAuthDeps): void {

  // --- P4 product session inventory (list by id; revoke-other loads the
  // token server-side). GET is session-gated like /me (no CSRF). POST
  // requires Origin + CSRF. The BA `/revoke-session` body-token path is
  // never used from product JSON (R9).
  app.get('/api/v1/auth/sessions', {
    config: {
      productTransport: {
        allowedQuery: [],
        cacheControl: 'private-no-store',
      },
    },
  }, async (request, reply) => {
    rejectMixedCarriers(request);
    const authority = deps.browserSessionAuthority;
    if (!authority) {
      throw sessionInventoryUnavailable();
    }
    const actor = await authority.requireMutationActor(
      { cookie: request.headers.cookie },
      { touch: false },
    ).catch(mapBrowserSessionFailure);
    const listed = await authority.listLiveSessions({
      accountId: actor.account.id,
      currentAuthSessionId: actor.session.id,
    });
    const sessions = listed.map((item) => ({
      id: item.id,
      createdAt: toUtc(item.createdAt),
      updatedAt: toUtc(item.updatedAt),
      current: item.current,
    }));
    return reply.code(200).send({ sessions });
  });

  app.post('/api/v1/auth/sessions/revoke', {
    config: {
      productTransport: {
        allowedQuery: [],
        acceptedMediaTypes: ['application/json'],
        bodyLimitBytes: 2048,
        cacheControl: 'no-store',
      },
    },
  }, async (request, reply) => {
    rejectMixedCarriers(request);
    const authority = deps.browserSessionAuthority;
    if (!authority) {
      throw sessionInventoryUnavailable();
    }
    const actor = await authority.requireMutationActor(
      { cookie: request.headers.cookie },
      { touch: false },
    ).catch(mapBrowserSessionFailure);
    requireAllowedOrigin(request, deps.config.allowedOrigins);
    requireCsrfHeader(request, actor.session.csrfTokenHash, secretsMatch);
    const body = parseRevokeSessionByIdBody(request.body);
    const result = await authority.revokeSessionById({
      request: { cookie: request.headers.cookie },
      sessionId: body.sessionId,
      accountId: actor.account.id,
      currentAuthSessionId: actor.session.id,
    });
    if (result.kind === 'not_found') {
      throw new ProductHttpError({
        statusCode: productErrorStatus('resource_not_found'),
        code: 'resource_not_found',
        message: 'The requested resource was not found.',
        recovery: 'none',
      });
    }
    if (result.kind === 'current') {
      clearSessionCookie(reply);
    }
    return reply.code(200).send({ status: true });
  });
}

export function registerSessionMeRoutes(app: FastifyInstance, deps: BrowserAuthDeps): void {
  const uow = deps.identityUnitOfWork;

  app.get('/api/v1/session', {
    config: {
      ...productRouteMetadata('GET', '/api/v1/session'),
      productTransport: {
        allowedQuery: [],
        cacheControl: 'private-no-store',
      },
    },
  }, async (request, reply) => {
    rejectMixedCarriers(request);
    const authority = deps.browserSessionAuthority;
    if (authority) {
      // Session bootstrap is a stateful operation when it rotates a mature
      // cookie.  A top-level cross-site navigation may carry SameSite=Lax
      // cookies but has no CSRF proof, so only an exact allowed Origin may
      // authorize rotation.  Requests with no Origin remain readable, but
      // cannot mint/revoke a successor session.
      const origin = request.headers.origin;
      const originAllowsRotation = typeof origin === 'string'
        && origin.length > 0
        && origin !== 'null'
        && deps.config.allowedOrigins.includes(origin);
      if (origin !== undefined && !originAllowsRotation) {
        requireAllowedOrigin(request, deps.config.allowedOrigins);
      }
      // A3: bootstrap through the BrowserSessionAuthority (BA session +
      // metadata idle/absolute/epoch/revoked + purpose-separated CSRF).
      // Rotation is CAS single-winner; the winner's successor cookie is
      // Set-Cookie'd only when rotated (losers converge to the same value).
      const result = await authority.bootstrap(
        { cookie: request.headers.cookie },
        { allowRotation: originAllowsRotation },
      );
      if (!result.authenticated) {
        // C-02: occupancy is not a product actor and must not look like
        // a missing cookie. Product bootstrap must not trust BA get-session.
        return reply.code(200).send(
          result.verificationRequired === true
            ? { authenticated: false, verificationRequired: true }
            : { authenticated: false },
        );
      }
      if (result.rotated && result.rotatedCookieValue) {
        setSessionCookie(reply, result.rotatedCookieValue, result.absoluteExpiresAt);
      }
      return reply.code(200).send({
        authenticated: true,
        idleExpiresAt: toUtc(result.idleExpiresAt),
        absoluteExpiresAt: toUtc(result.absoluteExpiresAt),
        csrfToken: result.csrfToken,
      });
    }
    const raw = readSessionCookie(request);
    if (!raw) {
      return reply.code(200).send({ authenticated: false });
    }
    try {
      // Login is a browser redirect (no JSON body). getSession is the bootstrap
      // that returns session-bound csrfToken. CSRF is derived from the session
      // cookie secret (hash at rest only), so below the rotation age threshold
      // we re-issue CSRF without minting a new session. At/above threshold we
      // CAS single-winner rotate and Set-Cookie only when rotated.
      const rebound = await uow.execute((ports) =>
        bootstrapBrowserSession(ports, raw));
      if (rebound.rotated) {
        setSessionCookie(reply, rebound.rawSessionToken, rebound.session.absoluteExpiresAt);
      }
      return reply.code(200).send({
        authenticated: true,
        idleExpiresAt: toUtc(rebound.session.idleExpiresAt),
        absoluteExpiresAt: toUtc(rebound.session.absoluteExpiresAt),
        csrfToken: rebound.rawCsrfToken,
      });
    } catch (error: unknown) {
      if (error instanceof IdentityError) {
        return reply.code(200).send({ authenticated: false });
      }
      throw error;
    }
  });

  app.delete('/api/v1/session', {
    config: {
      ...productRouteMetadata('DELETE', '/api/v1/session'),
      productTransport: {
        allowedQuery: [],
        cacheControl: 'no-store',
      },
    },
  }, async (request, reply) => {
    rejectMixedCarriers(request);
    const authority = deps.browserSessionAuthority;
    if (authority) {
      // A3: authenticate for the CSRF admission, then revoke. An already
      // invalid/expired/revoked session keeps logout idempotent (204 + clear).
      let csrfTokenHash: string;
      try {
        const actor = await authority.requireMutationActor(
          { cookie: request.headers.cookie },
          { touch: false },
        );
        csrfTokenHash = actor.session.csrfTokenHash;
      } catch (error: unknown) {
        if (error instanceof BrowserSessionAuthenticationError) {
          clearSessionCookie(reply);
          return reply.code(204).send();
        }
        throw error;
      }

      requireAllowedOrigin(request, deps.config.allowedOrigins);
      requireCsrfHeader(request, csrfTokenHash, secretsMatch);

      await authority.signOut({ cookie: request.headers.cookie });
      clearSessionCookie(reply);
      return reply.code(204).send();
    }
    const raw = readSessionCookie(request);
    if (!raw) {
      clearSessionCookie(reply);
      return reply.code(204).send();
    }

    // Authenticate inside UoW; Origin/CSRF must stay outside so ProductHttpError
    // is not swallowed by classifyDatabaseError → 500 internal_error.
    let sessionId: string;
    let csrfTokenHash: string;
    try {
      const auth = await uow.execute((ports) =>
        authenticateSession(ports, raw, { touch: false }));
      sessionId = auth.session.id;
      csrfTokenHash = auth.session.csrfTokenHash;
    } catch (error: unknown) {
      if (error instanceof IdentityError) {
        // Already invalid/expired/revoked: logout is idempotent.
        clearSessionCookie(reply);
        return reply.code(204).send();
      }
      throw error;
    }

    requireAllowedOrigin(request, deps.config.allowedOrigins);
    requireCsrfHeader(request, csrfTokenHash, secretsMatch);

    try {
      await uow.execute((ports) => revokeSession(ports, sessionId));
    } catch (error: unknown) {
      if (error instanceof IdentityError) {
        clearSessionCookie(reply);
        return reply.code(204).send();
      }
      throw error;
    }
    clearSessionCookie(reply);
    return reply.code(204).send();
  });

  app.get('/api/v1/me', {
    config: {
      ...productRouteMetadata('GET', '/api/v1/me'),
      productTransport: {
        allowedQuery: [],
        cacheControl: 'private-no-store',
      },
    },
  }, async (request, reply) => {
    const { account } = await requireSessionActor(request, uow, { touch: true });
    const me = await uow.execute((ports) =>
      getAccountWithProfile(ports, account.id),
    ).catch((error: unknown) => {
      if (error instanceof IdentityError) throw authenticationRequired();
      throw error;
    });
    if (!me) throw authenticationRequired();
    if (!me.handle) throw missingAccountHandle();
    return reply.code(200).send(toMeView(me));
  });

  app.patch('/api/v1/me', {
    config: {
      ...productRouteMetadata('PATCH', '/api/v1/me'),
      productTransport: {
        allowedQuery: [],
        acceptedMediaTypes: ['application/json'],
        bodyLimitBytes: 4096,
        cacheControl: 'private-no-store',
      },
    },
  }, async (request, reply) => {
    await requireMutationActor(request, {
      identityUnitOfWork: uow,
      allowedOrigins: deps.config.allowedOrigins,
    });
    return completePatchMe(request, reply, deps, (ports) => readmitMeAccountId(request, deps, ports));
  });
}

export function registerAvatarRoutes(app: FastifyInstance, deps: BrowserAuthDeps): void {
  const uow = deps.identityUnitOfWork;
  if (deps.config.productRouteRateLimitShared.enabled && deps.publicObjectRateLimiter === undefined) {
    throw new Error(
      'Avatar routes require an injected public-object limiter when PRODUCT_ROUTE_RATE_LIMIT_SHARED=true',
    );
  }
  const publicObjectRateLimiter =
    deps.publicObjectRateLimiter ?? createPublicObjectRateLimiter();
  const avatarMissing = (): never => {
    throw new ProductHttpError({
      statusCode: 404,
      code: 'resource_not_found',
      message: 'Avatar was not found.',
      recovery: 'none',
    });
  };

  for (const type of AVATAR_ALLOWED_CONTENT_TYPES) {
    app.addContentTypeParser(type, { parseAs: 'buffer' }, (_request, body, done) => {
      if (!Buffer.isBuffer(body)) {
        done(new ProductHttpError({
          statusCode: 400,
          code: 'invalid_request',
          message: 'Avatar body must be a buffer.',
          recovery: 'user_action',
        }), undefined);
        return;
      }
      done(null, body);
    });
  }

  app.post('/api/v1/me/avatar', {
    config: {
      ...productRouteMetadata('POST', '/api/v1/me/avatar'),
      productTransport: {
        allowedQuery: [],
        acceptedMediaTypes: [...AVATAR_ALLOWED_CONTENT_TYPES],
        bodyLimitBytes: AVATAR_MAX_BYTES,
        cacheControl: 'private-no-store',
      },
    },
  }, async (request, reply) => {
    await requireMutationActor(request, {
      identityUnitOfWork: uow,
      allowedOrigins: deps.config.allowedOrigins,
    });
    const commandId = readKnownCommandId(request);
    if (!deps.avatarStore) {
      throw new ProductHttpError({
        statusCode: 503,
        code: 'feature_temporarily_unavailable',
        message: 'Avatar upload is not available on this deployment.',
        recovery: 'none',
      });
    }
    const avatarStore = deps.avatarStore;
    const avatarBody = request.body;
    if (!Buffer.isBuffer(avatarBody)) {
      throw new ProductHttpError({
        statusCode: 400,
        code: 'invalid_request',
        message: 'Avatar body must be a buffer.',
        recovery: 'user_action',
      });
    }
    const contentType = (request.headers['content-type'] ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? '';
    let result: UploadAvatarResult;
    try {
      const preparingAccountId = await uow.execute(ports => readmitMeAccountId(request, deps, ports));
      const preparedAvatarId = await prepareAvatarUpload(avatarStore, {
        accountId: preparingAccountId, body: avatarBody, contentType,
        productOrigin: deps.config.productOrigin, commandId,
      });
      result = await uow.execute(async (ports) => {
        const accountId = await readmitMeAccountId(request, deps, ports);
        return uploadAvatar(
          ports,
          {
            accountId,
            preparedAvatarId,
            body: avatarBody,
            contentType,
            productOrigin: deps.config.productOrigin,
            commandId,
          },
        );
      });
    } catch (error: unknown) {
      if (error instanceof IdentityError) throw mapProfileSettingsError(error);
      throw error;
    }
    return sendAvatarUploadResult(reply, result);
  });

  app.get('/api/v1/avatar/:avatarId', {
    config: {
      ...productRouteMetadata('GET', '/api/v1/avatar/{avatarId}'),
      productTransport: {
        allowedQuery: [],
        cacheControl: 'public-revalidate',
      },
    },
  }, async (request, reply) => {
    await admitPublicObjectGet(publicObjectRateLimiter, request);
    const avatarId = (request.params as { avatarId?: string }).avatarId ?? '';
    if (!avatarId || !/^[a-f0-9-]{36}$/iu.test(avatarId)) avatarMissing();
    if (deps.avatarPublicAccess && await deps.avatarPublicAccess.isPublicationRestricted(avatarId)) {
      avatarMissing();
    }
    if (deps.avatarStore === undefined) return avatarMissing();
    const controller = new AbortController();
    const disconnected = () => { if (!reply.raw.writableFinished) controller.abort(); };
    reply.raw.on('close', disconnected);
    request.raw.on('aborted', disconnected);
    request.raw.socket?.once('close', disconnected);
    let stored;
    try {
      if (request.raw.aborted || request.raw.socket?.destroyed) controller.abort();
      stored = await deps.avatarStore.get(avatarId, {
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(AVATAR_READ_TIMEOUT_MS)]),
      });
    } finally {
      reply.raw.removeListener('close', disconnected);
      request.raw.removeListener('aborted', disconnected);
      request.raw.socket?.removeListener('close', disconnected);
    }
    if (stored === null) return avatarMissing();
    // Defense-in-depth (avatar audit #2): never trust the Content-Type read
    // back from the object store. Re-run upload image validation.
    try {
      assertAvatarImage(stored.body, stored.contentType);
    } catch (error: unknown) {
      if (error instanceof IdentityError) return avatarMissing();
      throw error;
    }
    return reply
      .header('content-type', stored.contentType)
      // Publication restriction can be revoked independently of the object
      // bytes. An immutable one-year response lets shared caches continue to
      // serve an avatar after restrict_publication is applied.
      .header('cache-control', 'public, max-age=30, must-revalidate')
      .header('x-content-type-options', 'nosniff')
      .header('Cross-Origin-Resource-Policy', 'cross-origin')
      .send(stored.body);
  });
}


async function readmitMeAccountId(
  request: FastifyRequest,
  deps: BrowserAuthDeps,
  ports: IdentityPorts,
): Promise<string> {
  if (hasAuthorizationHeader(request) && !hasCookieHeader(request)) {
    const authority = productBearerAuthorityOf(request);
    if (!authority) throw authenticationRequired();
    return (await authority.requireWrite(request)).account.id;
  }
  if (deps.browserSessionAuthority) {
    const current = await deps.browserSessionAuthority.authenticate(
      { cookie: request.headers.cookie },
      { touch: false },
    );
    if (!current) throw authenticationRequired();
    return current.account.id;
  }
  const raw = readSessionCookie(request);
  if (!raw) throw authenticationRequired();
  try {
    const current = await authenticateSession(ports, raw, { touch: false });
    return current.account.id;
  } catch (error: unknown) {
    if (error instanceof IdentityError) throw authenticationRequired();
    throw error;
  }
}

function sendAvatarUploadResult(reply: FastifyReply, result: UploadAvatarResult): FastifyReply {
  if (result.kind === 'created') {
    return reply.code(200).send(toMeView(result));
  }
  if (result.kind === 'replay') {
    for (const [name, value] of Object.entries(result.result.stableHeaders)) {
      reply.header(name, value);
    }
    return reply.code(result.result.status).send(Buffer.from(result.result.body));
  }
  if (result.kind === 'in_progress') {
    throw new ProductHttpError({
      statusCode: 429,
      code: 'rate_limited',
      message: 'This avatar upload command is still in progress. Please retry the request.',
      recovery: 'same_request',
      sameRequestRetrySafe: true,
      retryAfterSeconds: result.retryAfterSeconds,
      headers: { 'Retry-After': String(result.retryAfterSeconds) },
    });
  }
  if (result.kind === 'reused') {
    throw new ProductHttpError({
      statusCode: 409,
      code: 'command_id_reused',
      message: 'This command id was already used with a different avatar upload.',
      recovery: 'user_action',
    });
  }
  throw new ProductHttpError({
    statusCode: 410,
    code: 'command_result_expired',
    message: 'The stored result for this avatar upload command has expired.',
    recovery: 'user_action',
  });
}

async function completePatchMe(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: BrowserAuthDeps,
  reauthenticate: (ports: IdentityPorts) => Promise<string>,
): Promise<FastifyReply> {
  const commandId = readKnownCommandId(request);
  const body = parseProfileSettingsBody(request.body);
  let outcome: UpdateProfileSettingsCommandResult;
  try {
    outcome = await deps.identityUnitOfWork.execute(async (ports) => {
      const accountId = await reauthenticate(ports);
      return updateProfileSettingsWithReceipt(ports, {
        accountId,
        commandId,
        handle: body.handle,
        displayName: body.displayName,
        productOrigin: deps.config.productOrigin,
        ...(body.avatarUrl === undefined ? {} : { avatarUrl: body.avatarUrl }),
        ...(body.about === undefined ? {} : { about: body.about }),
      });
    });
  } catch (error: unknown) {
    if (error instanceof IdentityError) throw mapProfileSettingsError(error);
    throw error;
  }
  return sendProfileSettingsCommandOutcome(reply, outcome);
}

function sendProfileSettingsCommandOutcome(
  reply: FastifyReply,
  outcome: UpdateProfileSettingsCommandResult,
): FastifyReply {
  if (outcome.kind === 'updated' || outcome.kind === 'replay') {
    return sendProductCommandReceiptOutcome(reply, {
      kind: 'replay',
      status: outcome.result.status,
      body: outcome.result.body,
      stableHeaders: outcome.result.stableHeaders,
      mediaType: outcome.result.mediaType,
    });
  }
  return sendProductCommandReceiptOutcome(reply, outcome);
}

export function registerProductBrowserAuthRoutes(app: FastifyInstance, deps: BrowserAuthDeps): void {
  registerAccountLinkingRoutes(app, deps);
  registerAccountDeletionRoutes(app, deps);
  registerAccountRecoveryRoutes(app, deps);
  registerSessionInventoryRoutes(app, deps);
  registerSessionMeRoutes(app, deps);
  registerAvatarRoutes(app, deps);
}
