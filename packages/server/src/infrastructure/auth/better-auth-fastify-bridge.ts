import type { betterAuth } from 'better-auth';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { canonicalizeSafeReturnTo } from '../../modules/identity/index.js';
import {
  BETTER_AUTH_ALLOWLIST,
  BETTER_AUTH_BROWSER_ALLOWLIST,
  type BetterAuthAllowlistEntry,
  type BetterAuthRuntimeConfig,
} from './better-auth-runtime-contract.js';
import {
  dcrCapacityUnavailableResponse,
  incrementAuthDcrMetric,
  type DcrRegistrationCapacityGuard,
} from './dcr-registration-capacity.js';
import { validateDcrPublicClientMetadata } from './dcr-public-client-policy.js';
import {
  dispatchBetterAuthWithLoopbackRedirectContext,
  redirectUriFromRequestBody,
} from './loopback-redirect-port.js';
import type { Metrics } from '../telemetry/index.js';

/**
 * Fastify-to-Fetch transport bridge for the allowlisted Better Auth surface.
 * Runtime construction remains in better-auth-runtime.ts; this module owns
 * byte-bounded request conversion, OAuth callback admission, and response
 * forwarding.
 */

const OAUTH_START_PATHS: readonly string[] = Object.freeze(['/sign-in/social', '/sign-in/oauth2']);
const OAUTH_CALLBACK_PATHS: ReadonlySet<string> = new Set([
  '/callback/:providerId',
  '/oauth2/callback/:providerId',
]);
/** Persisted callback values that fail the final check land here. Not reflected. */
const SAFE_CALLBACK_FALLBACK = '/';

const INVALID_CALLBACK_URL_BODY = Object.freeze({
  code: 'INVALID_CALLBACK_URL',
  message: 'Invalid callback URL',
});

function payloadTooLargeEnvelope(requestId: string): unknown {
  return {
    error: {
      code: 'payload_too_large',
      message: 'The request body is too large.',
      requestId,
      recovery: 'user_action',
      sameRequestRetrySafe: false,
      precondition: null,
      currentEtag: null,
      retryAfterSeconds: null,
      fieldErrors: [],
    },
  };
}
const BRIDGE_ACCEPTED_MEDIA_TYPES = Object.freeze([
  'application/json',
  'application/x-www-form-urlencoded',
]);

/**
 * Mount the allowlisted Better Auth endpoints through the verified bridge.
 * Exported so the C3 integration suite can mount the REAL allowlist logic
 * (including the OAuth-start callback-URL pre-check) with a test auth
 * instance that carries the controlled genericOAuth providers.
 */
export function mountBetterAuthAllowlist(
  app: FastifyInstance,
  auth: ReturnType<typeof betterAuth>,
  config: BetterAuthRuntimeConfig,
  dcrCapacityGuard?: DcrRegistrationCapacityGuard,
  metrics?: Metrics,
): void {
  if (config.oauthIssuer && dcrCapacityGuard === undefined) {
    throw new Error('OAuth issuer routes require the anonymous DCR capacity guard');
  }
  const allowlist = config.oauthIssuer ? BETTER_AUTH_ALLOWLIST : BETTER_AUTH_BROWSER_ALLOWLIST;
  for (const entry of allowlist) {
    const url = `${config.basePath}${entry.path}`;
    app.route({
      method: entry.method,
      url,
      config: {
        productTransport: {
          acceptedMediaTypes: BRIDGE_ACCEPTED_MEDIA_TYPES,
          cacheControl: 'no-store',
          bodyLimitBytes: config.bodyLimitBytes,
        },
      },
      onRequest: async (request, reply) => {
        // Route-level onRequest runs before Fastify consumes the body stream,
        // so `request.raw` is still intact. Buffer it here under the product
        // byte limit: these routes reply before Fastify reaches `preParsing`,
        // therefore the bridge itself must enforce the limit for chunked
        // requests as well as requests carrying Content-Length.
        //
        // C3 (callback-URL contract): the OAuth start body is parsed BEFORE
        // the bridge. A callback field whose canonical form is unsafe is
        // rejected with INVALID_CALLBACK_URL. Safe fields keep the original
        // bytes, so Content-Length still matches the buffer passed to Request.
        // Callback responses are checked again: a value persisted earlier can
        // still canonicalize to a `//` path.
        const bodyRead = await readBoundedBridgeBody(request, config.bodyLimitBytes);
        if (bodyRead.kind === 'too-large') {
          return reply.code(413).send(payloadTooLargeEnvelope(request.id));
        }
        const bodyOverride = bodyRead.kind === 'body' ? bodyRead.body : undefined;
        if (OAUTH_START_PATHS.includes(entry.path)
          && bodyOverride !== undefined
          && requestContentType(request) === 'application/json'
          && findInvalidCallbackUrl(bodyOverride, config.baseURL) !== null) {
          return reply.code(400).send(INVALID_CALLBACK_URL_BODY);
        }
        if (entry.path === '/oauth2/register') {
          const policyError = validateDcrPublicClientMetadata(
            bodyOverride,
            requestContentType(request),
          );
          if (policyError !== null) {
            return reply.code(400).send(policyError);
          }
        }
        const fetchRequest = fastifyRequestToFetchRequest(request, reply, bodyOverride);
        const continuationRedirectUri = bridgeBodyRedirectUri(
          entry,
          bodyOverride,
          requestContentType(request),
        );
        const dispatch = () => dispatchBetterAuthWithLoopbackRedirectContext(
          fetchRequest,
          (next) => auth.handler(next),
          continuationRedirectUri,
        );
        const response = entry.path !== '/oauth2/register'
          ? await dispatch()
          : await dispatchOauthRegister(auth, fetchRequest.headers, dispatch, dcrCapacityGuard!, metrics);
        const guarded = OAUTH_CALLBACK_PATHS.has(entry.path)
          ? guardOAuthCallbackLocation(response, config.baseURL)
          : response;
        await applyFetchResponse(reply, guarded);
        // The bridge already sent the response. Returning reply stops Fastify
        // from parsing the consumed body and calling reply.send again.
        return reply;
      },
      handler: async (_request, reply) => {
        // The bridge always replies from the route-level onRequest hook; this
        // fallback is unreachable but Fastify requires a handler per route.
        return reply.code(500).send({
          error: 'internal_error',
          message: 'The Better Auth bridge did not complete the request.',
        });
      },
    });
  }
}

async function dispatchOauthRegister(
  auth: ReturnType<typeof betterAuth>,
  headers: Headers,
  dispatch: () => Promise<Response>,
  dcrCapacityGuard: DcrRegistrationCapacityGuard,
  metrics: Metrics | undefined,
): Promise<Response> {
  const admission = await resolveDcrSessionAdmission(auth, headers);
  if (admission.kind === 'session-without-user') {
    incrementAuthDcrMetric(metrics, 'auth.dcr.admission.store_error');
    return dcrCapacityUnavailableResponse();
  }
  if (admission.kind === 'owned') {
    return dcrCapacityGuard.dispatchOwned(dispatch, admission.userId);
  }
  return dcrCapacityGuard.dispatch(dispatch);
}

type DcrSessionAdmission =
  | { readonly kind: 'anonymous' }
  | { readonly kind: 'owned'; readonly userId: string }
  | { readonly kind: 'session-without-user' };

async function resolveDcrSessionAdmission(
  auth: ReturnType<typeof betterAuth>,
  headers: Headers,
): Promise<DcrSessionAdmission> {
  try {
    const session = await auth.api.getSession({ headers });
    if (session == null) return { kind: 'anonymous' };
    const payload = session as {
      readonly user?: { readonly id?: unknown };
      readonly session?: { readonly userId?: unknown } | null;
      readonly userId?: unknown;
    };
    const hasSession = payload.session != null || payload.user != null
      || typeof payload.userId === 'string';
    if (!hasSession) return { kind: 'anonymous' };
    const userId = payload.user?.id ?? payload.session?.userId ?? payload.userId;
    if (typeof userId !== 'string' || userId.length === 0) {
      return { kind: 'session-without-user' };
    }
    return { kind: 'owned', userId };
  } catch {
    // A malformed/expired cookie is not authority to bypass anonymous DCR
    // capacity. Better Auth still receives the original request afterwards.
    return { kind: 'anonymous' };
  }
}

/**
 * Read every bridge request body with a bounded buffer. The route-level
 * bridge replies from `onRequest`, before Fastify's global `preParsing` body
 * limiter runs, so delegating a chunked raw stream to Better Auth would make
 * that configured limit bypassable.
 *
 * Returns 'none' for bodyless requests, 'body' with the exact wire bytes, or
 * 'too-large'. Media-type admission remains the product onRequest hook's job.
 */
async function readBoundedBridgeBody(
  request: FastifyRequest,
  limit: number,
): Promise<{ readonly kind: 'none' } | { readonly kind: 'body'; readonly body: Buffer } | { readonly kind: 'too-large' }> {
  const hasBody = request.headers['transfer-encoding'] !== undefined
    || (request.headers['content-length'] !== undefined && request.headers['content-length'] !== '0');
  if (!hasBody) return { kind: 'none' };
  const declaredLength = Number(request.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > limit) return { kind: 'too-large' };
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request.raw) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buffer.length;
    if (total > limit) return { kind: 'too-large' };
    chunks.push(buffer);
  }
  return { kind: 'body', body: Buffer.concat(chunks) };
}

function requestContentType(request: FastifyRequest): string {
  return (request.headers['content-type'] ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

function bridgeBodyRedirectUri(
  entry: BetterAuthAllowlistEntry,
  body: Buffer | undefined,
  contentType: string,
): string | undefined {
  if (body === undefined) return undefined;
  if (entry.path === '/oauth2/consent') {
    return redirectUriFromRequestBody(body, contentType, 'oauth-query');
  }
  if ((entry.path === '/oauth2/authorize' && entry.method === 'POST')
    || entry.path === '/oauth2/token') {
    return redirectUriFromRequestBody(body, contentType, 'direct');
  }
  return undefined;
}

/**
 * C3 callback-URL pre-check. Malformed JSON is left to Better Auth.
 * Returns the BA-style error body or null. Does not rewrite the buffer.
 */
function findInvalidCallbackUrl(body: Buffer, productOrigin: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  for (const field of ['callbackURL', 'errorCallbackURL', 'newUserCallbackURL'] as const) {
    const value = record[field];
    if (value === undefined) continue;
    if (canonicalizeSafeReturnTo(value, productOrigin) === null) return INVALID_CALLBACK_URL_BODY;
  }
  return null;
}

/**
 * Final check on a callback Location, including one Better Auth may echo from
 * an older stored callback. Unsafe values become `/` and are not reflected.
 * This does not observe Better Auth's own redirector; callers pass the
 * response the bridge is about to forward.
 */
function guardOAuthCallbackLocation(response: Response, productOrigin: string): Response {
  const location = response.headers.get('location');
  if (location === null) return response;
  const canonical = canonicalizeSafeReturnTo(location, productOrigin) ?? SAFE_CALLBACK_FALLBACK;
  if (canonical === location) return response;
  const headers = new Headers(response.headers);
  headers.set('location', canonical);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Convert a FastifyRequest into a Fetch Request (the bridge under test).
 * Body is forwarded as the raw IncomingMessage stream with `duplex: 'half'`;
 * Node 24 IncomingMessage has NO `.signal`, so an explicit AbortController is
 * wired to 'aborted' (client-initiated disconnect) plus a socket 'close'
 * fallback. Listeners remain until response finish (including body consumption)
 * and detach then; an unfinished response/socket close still aborts the work.
 *
 * `bodyOverride`: the allowlisted bridge buffers every incoming body under
 * its byte limit, then re-sends the exact same bytes to Better Auth.
 */
export function fastifyRequestToFetchRequest(request: FastifyRequest, reply: FastifyReply, bodyOverride?: Buffer): Request {
  const host = typeof request.headers.host === 'string' ? request.headers.host : 'localhost';
  const url = new URL(request.url, `http://${host}`);
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else {
      headers.append(key, value);
    }
  }
  const controller = new AbortController();
  const socket = request.raw.socket;
  const dispose = () => {
    request.raw.off('aborted', abort);
    socket?.off('close', abort);
    reply.raw.off('close', abort);
    reply.raw.off('finish', dispose);
  };
  const abort = () => { controller.abort(); dispose(); };
  request.raw.once('aborted', abort);
  socket?.once('close', abort);
  reply.raw.once('close', abort);
  reply.raw.once('finish', dispose);
  if (request.raw.aborted || socket?.destroyed) abort();
  const init: RequestInit = { method: request.method, headers, signal: controller.signal };
  // A bodyless POST must reach Better Auth WITHOUT a body: BA rejects any
  // request that carries a body stream without a media type (415), and its
  // own client signs out with a bodyless POST. Only attach the raw stream
  // when the incoming request actually has one (content-length > 0 or
  // transfer-encoding) — an empty stream would be seen as "has body" by BA.
  const hasBody = request.headers['transfer-encoding'] !== undefined
    || (request.headers['content-length'] !== undefined && request.headers['content-length'] !== '0');
  if (bodyOverride !== undefined) {
    init.body = bodyOverride as unknown as BodyInit;
    (init as RequestInit & { duplex?: 'half' }).duplex = 'half';
  } else if (request.method !== 'GET' && request.method !== 'HEAD' && hasBody) {
    init.body = request.raw as unknown as BodyInit;
    (init as RequestInit & { duplex?: 'half' }).duplex = 'half';
  }
  try { return new Request(url, init); }
  catch (error) { dispose(); throw error; }
}

/**
 * Apply a Fetch Response to a FastifyReply: status, headers (Set-Cookie
 * appended one-by-one via `getSetCookie()` to preserve order), empty body as
 * undefined. Bodies are read with `text()` — `arrayBuffer()` is unreliable for
 * better-call responses (spike §3.1).
 */
export async function applyFetchResponse(reply: FastifyReply, response: Response): Promise<void> {
  reply.code(response.status);
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() === 'set-cookie') return;
    reply.header(key, value);
  });
  for (const cookie of response.headers.getSetCookie()) {
    reply.raw.appendHeader('set-cookie', cookie);
  }
  const text = await response.text();
  reply.send(text.length > 0 ? Buffer.from(text) : undefined);
}
