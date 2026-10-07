/**
 * Task A4: transport-level Better Auth route contract.
 *
 * Mounts the allowlisted Better Auth endpoints through the A1 runtime bridge
 * (precise method routing + Fastify bridge — the runtime is injected through
 * AppDependencies; transport never imports infrastructure/auth) and then adds
 * the product contract layer on top of the mounted surface:
 *
 * 1. Origin pre-check (G1 §9): for every POST/PUT/PATCH/DELETE on a
 *    registered Better Auth endpoint, requireAllowedOrigin() runs BEFORE the
 *    bridge (global onRequest hooks run before route-level onRequest), so the
 *    Know-N check is the first line and BA's own Origin check stays the
 *    second — both mechanisms are kept, combined fail-closed.
 * 2. R9 response stripping (spike R9 / G1 §12.3): raw session `token` fields
 *    are removed recursively from every 2xx JSON body (sign-up/sign-in
 *    top-level token AND the nested get-session session.token), so no bearer
 *    credential ever leaves the allowlisted surface in a JSON body.
 * 3. Unified error classification (plan §7 A4 step 5): 4xx/5xx JSON bodies
 *    from the BA handler are translated to the stable product envelope
 *    (invalid_credentials / authentication_required / csrf_failed /
 *    rate_limited / verification_required / account_link_required /
 *    email_delivery_unavailable / invalid_request) with FIXED messages — the
 *    BA message, the email, an OTP or a raw token are never echoed, and
 *    unknown codes fail closed to invalid_request.
 *
 * The hook surface is scoped to the manifest's registered better-auth
 * entries only: unknown paths 404 and wrong methods 405 come from the real
 * Fastify router (product envelopes pass through untouched), and the legacy
 * OIDC / product session/me routes never enter this processing.
 *
 * C3: the OAuth authorization-code chain (POST /sign-in/oauth2 +
 * GET /oauth2/callback/:providerId) is flipped to registered here; the
 * callback-URL allowlist (Know-N origin + allowlisted returnTo) is enforced
 * inside the runtime mount before the bridge (the transport cannot read the
 * body before the bridge consumes the raw stream), with BA's own
 * trustedOrigins check as the second line. The explicit link endpoint
 * (POST /oauth2/link) is a product route owned by browser-auth-routes.ts.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { authManifestEntryFor, requireAuthManifestEntry } from './auth-route-manifest.js';
import { requireAllowedOrigin } from './origin-csrf.js';
import { productErrorEnvelope, translateBetterAuthError } from '../product-error.js';

export interface BetterAuthRoutesDependencies {
  /**
   * A1 runtime boundary (injected by the composition through
   * AppDependencies). Its mount registers ONLY the allowlisted endpoints
   * through the verified Fastify bridge.
   */
  readonly betterAuthRuntime: { readonly mount: (app: FastifyInstance) => void };
  /**
   * Exact origins for the pre-bridge Origin check: product origins plus
   * chrome-extension:// IDs from Better Auth trustedOrigins.
   */
  readonly allowedOrigins: readonly string[];
}

export function registerBetterAuthRoutes(
  app: FastifyInstance,
  deps: BetterAuthRoutesDependencies,
): void {
  // C3 registration guard: the OAuth start/callback entries must have been
  // flipped to registered (the manifest is the single source) before the
  // product contract applies to the authorization-code chain.
  const oauthStart = requireAuthManifestEntry('POST', '/api/v1/auth/sign-in/oauth2');
  const oauthCallback = requireAuthManifestEntry('GET', '/api/v1/auth/oauth2/callback/:providerId');
  if (oauthStart.status !== 'registered' || oauthCallback.status !== 'registered') {
    throw new Error('OAuth start/callback must be registered in the auth-route manifest before mounting (C3)');
  }

  // Allowlisted BA handler mount: exact method routes + bridge (A1 runtime).
  deps.betterAuthRuntime.mount(app);

  // First line of defense (G1 §9): Know-N Origin check before the bridge.
  app.addHook('onRequest', async (request, _reply) => {
    if (!isRegisteredBetterAuthEntry(request.method, request.url)) return;
    if (request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS') return;
    requireAllowedOrigin(request, deps.allowedOrigins);
  });

  // Product response contract: R9 token stripping + unified error envelopes.
  app.addHook('onSend', async (request, reply, payload) => {
    if (!isRegisteredBetterAuthEntry(request.method, request.url)) return payload;
    return processBetterAuthResponse(request, reply, payload);
  });
}

/**
 * Public MCP OAuth AS endpoints skip the browser Origin + product-envelope
 * contract: token/userinfo/jwks/authorize/register are RFC 6749/7591 clients,
 * not cookie POSTs. Consent (including GET /oauth2/consent-transaction) stays
 * in the browser contract: session required, not on this skip list.
 */
const OAUTH_ISSUER_PUBLIC_CONTRACT_PATHS = new Set([
  '/api/v1/auth/oauth2/authorize',
  '/api/v1/auth/oauth2/token',
  '/api/v1/auth/oauth2/userinfo',
  '/api/v1/auth/jwks',
  '/api/v1/auth/oauth2/public-client',
  '/api/v1/auth/oauth2/register',
]);

/** True only for the manifest's registered Better Auth endpoints. */
function isRegisteredBetterAuthEntry(method: string, rawUrl: string): boolean {
  const entry = authManifestEntryFor(method, rawUrl);
  return entry !== null
    && entry.scope === 'better-auth'
    && entry.status === 'registered'
    && !OAUTH_ISSUER_PUBLIC_CONTRACT_PATHS.has(entry.path);
}

/**
 * Rewrite a mounted Better Auth response payload:
 * - 2xx JSON object bodies: recursively strip raw `token` fields (R9);
 * - 4xx/5xx JSON bodies: translate to the unified product envelope;
 * - everything else (null bodies, non-JSON, product envelopes, redirects)
 *   passes through untouched.
 */
export function processBetterAuthResponse(
  request: FastifyRequest,
  reply: FastifyReply,
  payload: unknown,
): unknown {
  if (payload === undefined || payload === null) return payload;
  const text = typeof payload === 'string'
    ? payload
    : Buffer.isBuffer(payload)
      ? payload.toString('utf8')
      : null;
  if (text === null) return payload;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Non-JSON body (or empty): never rewrite.
    return payload;
  }

  const status = reply.statusCode;
  if (status >= 200 && status < 300) {
    if (parsed === null || typeof parsed !== 'object') return payload;
    return JSON.stringify(stripBetterAuthRawTokens(parsed));
  }
  if (status >= 400) {
    const retryAfterRaw = reply.getHeader('x-retry-after');
    const retryAfterSeconds = typeof retryAfterRaw === 'string' && /^\d+$/u.test(retryAfterRaw)
      ? Number(retryAfterRaw)
      : null;
    const translated = translateBetterAuthError(status, parsed, retryAfterSeconds);
    if (translated === null) return payload;
    // The BA status is NOT trusted for the wire status: every product code
    // carries its canonical status from the central table (G1 §10), so the
    // onSend rewrite must also correct the reply status (e.g. BA 422
    // USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL -> canonical 401
    // invalid_credentials).
    reply.statusCode = translated.statusCode;
    return JSON.stringify(productErrorEnvelope(request.id, translated));
  }
  return payload;
}

/**
 * R9: remove raw session `token` fields recursively from a parsed JSON value.
 * The browser cookie is the only credential carrier; no success body on the
 * allowlisted surface may expose the bearer token (spike §4.10/R9).
 */
export function stripBetterAuthRawTokens(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripBetterAuthRawTokens);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (key === 'token') continue;
      out[key] = stripBetterAuthRawTokens(item);
    }
    return out;
  }
  return value;
}
