import { Readable, Transform } from 'node:stream';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { parseIJson } from '@know-n/colp/server';
import { ProductHttpError } from './product-error.js';
import { omitAutomationIdentityFields } from './product-actor.js';
import { parseSessionCookieField } from './session-cookie.js';

export interface ProductStrictIJsonLimits {
  readonly maxDepth: number;
  readonly maxMembers: number;
}

export interface ProductRouteConfig {
  readonly allowedQuery?: readonly string[];
  /** Query names that may repeat; all other duplicate names remain rejected. */
  readonly repeatableQuery?: readonly string[];
  /** Preserve legacy invalid_request unless a newer operation explicitly contracts invalid_query. */
  readonly duplicateQueryErrorCode?: 'invalid_request' | 'invalid_query';
  /** Stable error profile for malformed encoding and unsupported names. */
  readonly queryErrorCode?: 'invalid_request' | 'invalid_query';
  readonly acceptedMediaTypes?: readonly string[];
  readonly bodyLimitBytes?: number;
  /** Enables fatal-UTF-8 strict I-JSON parsing with bounded depth/member budgets. */
  readonly strictIJson?: ProductStrictIJsonLimits;
  readonly cacheControl?: 'private-no-store' | 'no-store' | 'private-revalidate' | 'public-revalidate';
  readonly rejectRequestBody?: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    readonly rawHeaderPairs: ReadonlyArray<readonly [string, string]>;
  }

  interface FastifyContextConfig {
    readonly productTransport?: ProductRouteConfig;
    /** Authenticate private bot routes before query/body admission reveals them. */
    readonly credentialAccess?: (request: FastifyRequest) => Promise<void>;
  }
}

const SINGLE_VALUE_HEADERS = new Set([
  'authorization',
  'content-type',
  'cookie',
  'host',
  'collection-protocol-version',
  'idempotency-key',
  'known-command-id',
  'origin',
  'x-csrf-token',
  'if-match',
  'if-content-match',
]);
const SINGLE_FIELD_LIST_HEADERS = new Set(['accept', 'if-none-match']);

const CACHE_CONTROL_VALUES: Record<NonNullable<ProductRouteConfig['cacheControl']>, string> = {
  'private-no-store': 'private, no-store',
  'no-store': 'no-store',
  'private-revalidate': 'private, no-cache, must-revalidate',
  'public-revalidate': 'public, no-cache, must-revalidate',
};

function rawHeaderPairs(request: FastifyRequest): ReadonlyArray<readonly [string, string]> {
  const rawHeaders = request.raw.rawHeaders;
  if (rawHeaders.length % 2 !== 0) {
    throw invalidRequest('Request headers could not be read safely.');
  }
  const pairs: Array<readonly [string, string]> = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    pairs.push([rawHeaders[index]!, rawHeaders[index + 1]!]);
  }
  return Object.freeze(pairs);
}

function enforceHeaderCardinality(pairs: ReadonlyArray<readonly [string, string]>): void {
  const counts = new Map<string, number>();
  for (const [rawName, value] of pairs) {
    const name = rawName.toLowerCase();
    if (!SINGLE_VALUE_HEADERS.has(name) && !SINGLE_FIELD_LIST_HEADERS.has(name)) continue;
    const count = (counts.get(name) ?? 0) + 1;
    counts.set(name, count);
    if (count > 1 || (SINGLE_VALUE_HEADERS.has(name) && value.includes(','))) {
      throw invalidRequest(`Header ${rawName} must occur exactly once when provided.`);
    }
  }
}

function invalidRequest(message: string): ProductHttpError {
  return new ProductHttpError({ statusCode: 400, code: 'invalid_request', message });
}

function invalidJson(): ProductHttpError {
  return new ProductHttpError({
    statusCode: 400,
    code: 'invalid_json',
    message: 'The JSON body is invalid.',
  });
}

const queryParseError = Symbol('queryParseError');

const repeatedQueryNames = Symbol('repeatedQueryNames');
const MAX_RAW_QUERY_BYTES = 8_192;
const MAX_RAW_QUERY_COMPONENT_BYTES = 8_192;
// Search q is checked before its value is percent-decoded; the route repeats this check against request.raw.url.
const SEARCH_Q_RAW_MAX_BYTES = 2_048;
type StrictQuery = Record<string, string | readonly string[]> & {
  [queryParseError]?: ProductHttpError;
  [repeatedQueryNames]?: ReadonlySet<string>;
};

function rejectedQuery(message: string): StrictQuery {
  const parsed = Object.create(null) as StrictQuery;
  Object.defineProperty(parsed, queryParseError, {
    value: new ProductHttpError({ statusCode: 400, code: 'invalid_query', message }),
  });
  return parsed;
}

function parseStrictQuery(query: string): StrictQuery {
  const parsed = Object.create(null) as StrictQuery;
  if (query === '') return parsed;
  if (Buffer.byteLength(query, 'utf8') > MAX_RAW_QUERY_BYTES) {
    return rejectedQuery('The query string is invalid.');
  }
  for (const entry of query.split('&')) {
    if (entry === '') return rejectedQuery('The query string is invalid.');
    const separator = entry.indexOf('=');
    const rawName = separator === -1 ? entry : entry.slice(0, separator);
    const rawValue = separator === -1 ? '' : entry.slice(separator + 1);
    if (Buffer.byteLength(rawName, 'utf8') > MAX_RAW_QUERY_COMPONENT_BYTES
      || Buffer.byteLength(rawValue, 'utf8') > MAX_RAW_QUERY_COMPONENT_BYTES) {
      return rejectedQuery('The query string is invalid.');
    }
    let name: string;
    let value: string;
    try {
      name = decodeURIComponent(rawName.replaceAll('+', ' '));
      if (name === 'q' && Buffer.byteLength(rawValue, 'utf8') > SEARCH_Q_RAW_MAX_BYTES) {
        return rejectedQuery('The query string is invalid.');
      }
      value = decodeURIComponent(rawValue.replaceAll('+', ' '));
    } catch {
      return rejectedQuery('The query string is invalid.');
    }
    if (name === '') return rejectedQuery('Query parameters must be named.');
    if (Object.hasOwn(parsed, name)) {
      const current = parsed[name];
      parsed[name] = Object.freeze([...(Array.isArray(current) ? current : [current as string]), value]);
      const repeated = new Set(parsed[repeatedQueryNames] ?? []);
      repeated.add(name);
      Object.defineProperty(parsed, repeatedQueryNames, { value: repeated, configurable: true });
      continue;
    }
    parsed[name] = value;
  }
  return parsed;
}

function hasRequestBody(request: FastifyRequest): boolean {
  const length = request.headers['content-length'];
  return request.headers['transfer-encoding'] !== undefined || (length !== undefined && length !== '0');
}

function isPlainObjectPayload(payload: unknown): payload is Record<string, unknown> {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return false;
  if (Buffer.isBuffer(payload) || payload instanceof Readable) return false;
  const prototype = Object.getPrototypeOf(payload);
  return prototype === Object.prototype || prototype === null;
}

export function installProductAdmission(
  app: FastifyInstance,
  options: { readonly exposeAutomationIdentity?: boolean } = {},
): void {
  const exposeAutomationIdentity = options.exposeAutomationIdentity === true;
  app.decorateRequest('rawHeaderPairs');

  // Controlled application/json parser. Without strictIJson this preserves the
  // legacy Fastify JSON.parse behavior; MCP opts into the COLP strict parser.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (request, body, done) => {
      const limits = request.routeOptions.config.productTransport?.strictIJson;
      try {
        if (!Buffer.isBuffer(body) || body.byteLength === 0) {
          throw invalidJson();
        }
        // MCP admission must happen before JSON parsing.  The route performs
        // its bounded request-budget admission on this raw, byte-limited
        // buffer, then invokes the strict parser only for an admitted call.
        // Returning the buffer here keeps malformed or deeply nested JSON
        // from consuming parser CPU while all connection slots are busy.
        const route = request.routeOptions.url;
        if (limits !== undefined && typeof route === 'string'
            && (route === '/collections/-/mcp' || route.endsWith('/collections/-/mcp'))) {
          done(null, body);
          return;
        }
        if (limits === undefined) {
          done(null, JSON.parse(body.toString('utf8')));
          return;
        }
        const source = new TextDecoder('utf-8', { fatal: true }).decode(body);
        done(null, parseIJson(source, limits));
      } catch {
        done(invalidJson(), undefined);
      }
    },
  );

  // RFC 7396 merge-patch body: same JSON parse rules as application/json.
  app.addContentTypeParser(
    'application/merge-patch+json',
    { parseAs: 'buffer' },
    (request, body, done) => {
      void request;
      if (!Buffer.isBuffer(body) || body.byteLength === 0) {
        done(
          new ProductHttpError({
            statusCode: 400,
            code: 'invalid_json',
            message: 'The JSON body is invalid.',
          }),
          undefined,
        );
        return;
      }
      try {
        const parsed: unknown = JSON.parse(body.toString('utf8'));
        done(null, parsed);
      } catch {
        done(
          new ProductHttpError({
            statusCode: 400,
            code: 'invalid_json',
            message: 'The JSON body is invalid.',
          }),
          undefined,
        );
      }
    },
  );

  app.addHook('onRequest', async (request) => {
    // Retired browser management URLs stay hidden even for malformed probes.
    const pathname = (request.raw.url ?? '').split('?', 1)[0]!;
    const credentialAccess = request.routeOptions.config.credentialAccess;
    const retired = /^\/api\/v1\/me\/(?:credentials|credential-parents)(?:\/|$)/.test(pathname);
    const privateCredentialPath = /^\/api\/v1\/(?:auth\/credential-children|me\/(?:credential-grants|credential-plans|credential-identity))(?:\/|$)/.test(pathname);
    const unavailableTokenRoute = pathname === '/api/v1/auth/key-token'
      && (request.method !== 'POST' || request.routeOptions.url !== pathname);
    if (retired || (privateCredentialPath && !credentialAccess) || unavailableTokenRoute) {
      throw new ProductHttpError({ statusCode: 404, code: 'resource_not_found', message: 'The requested resource was not found.' });
    }
    await request.routeOptions.config.credentialAccess?.(request);
    const queryError = (request.query as StrictQuery)[queryParseError];
    if (queryError !== undefined) {
      const code = request.routeOptions.config.productTransport?.queryErrorCode ?? 'invalid_query';
      if (code === 'invalid_request') throw invalidRequest('The query string is invalid.');
      throw queryError;
    }

    const repeated = (request.query as StrictQuery)[repeatedQueryNames];
    if (repeated !== undefined) {
      const allowed = new Set(request.routeOptions.config.productTransport?.repeatableQuery ?? []);
      if ([...repeated].some((name) => !allowed.has(name))) {
        const code = request.routeOptions.config.productTransport?.duplicateQueryErrorCode
          ?? 'invalid_request';
        throw new ProductHttpError({
          statusCode: 400,
          code,
          message: 'Query parameters must occur once unless the endpoint contract allows repetition.',
        });
      }
    }

    const pairs = rawHeaderPairs(request);
    enforceHeaderCardinality(pairs);
    const cookieHeader = request.headers.cookie;
    if (cookieHeader !== undefined && parseSessionCookieField(cookieHeader).kind === 'parse-error') {
      throw invalidRequest('The Cookie header is invalid.');
    }
    Object.defineProperty(request, 'rawHeaderPairs', { value: pairs, enumerable: true });

    const transport = request.routeOptions.config.productTransport;
    const limit = transport?.bodyLimitBytes;
    if (limit !== undefined) {
      if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('product bodyLimitBytes must be a positive safe integer');
      const contentLength = request.headers['content-length'];
      if (contentLength !== undefined && Number(contentLength) > limit) {
        throw new ProductHttpError({ statusCode: 413, code: 'payload_too_large', message: 'The request body is too large.' });
      }
    }

    if (transport?.rejectRequestBody && hasRequestBody(request)) {
      throw invalidRequest('This operation does not accept a request body.');
    }
    if (!hasRequestBody(request)) return;
    const contentType = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
    const accepted = transport?.acceptedMediaTypes ?? ['application/json'];
    if (contentType === undefined || !accepted.includes(contentType)) {
      throw new ProductHttpError({ statusCode: 415, code: 'unsupported_media_type', message: 'This media type is not supported.' });
    }
  });

  app.addHook('preParsing', async (request, _reply, payload) => {
    const limit = request.routeOptions.config.productTransport?.bodyLimitBytes;
    if (limit === undefined) return payload;
    let received = 0;
    const limiter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.byteLength;
        limiter.receivedEncodedLength = received;
        if (received > limit) {
          callback(new ProductHttpError({ statusCode: 413, code: 'payload_too_large', message: 'The request body is too large.' }));
          return;
        }
        callback(null, chunk);
      },
    }) as Transform & { receivedEncodedLength: number };
    limiter.receivedEncodedLength = 0;
    return payload.pipe(limiter);
  });

  app.addHook('preValidation', async (request) => {
    const allowedQuery = request.routeOptions.config.productTransport?.allowedQuery;
    if (allowedQuery === undefined) return;
    const query = request.query as Record<string, string | readonly string[]>;
    const allowed = new Set(allowedQuery);
    if (Object.keys(query).some((name) => !allowed.has(name))) {
      const code = request.routeOptions.config.productTransport?.queryErrorCode ?? 'invalid_query';
      throw new ProductHttpError({ statusCode: 400, code, message: 'The query contains an unsupported parameter.' });
    }
  });

  app.addHook('preSerialization', async (request, _reply, payload) => {
    // Auth-owned credential DTOs require credentialId; ordinary Product JSON must omit it.
    const routerPath = request.routeOptions.url;
    if (routerPath !== undefined && CREDENTIAL_DTO_ROUTES.has(routerPath)) return payload;
    if (!isPlainObjectPayload(payload)) return payload;
    return omitAutomationIdentityFields(payload, exposeAutomationIdentity);
  });

  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('X-Request-Id', request.id);
    const policy = request.routeOptions.config.productTransport?.cacheControl ?? 'private-no-store';
    if (!reply.hasHeader('Cache-Control')) reply.header('Cache-Control', CACHE_CONTROL_VALUES[policy]);
    return payload;
  });
}

export { parseStrictQuery };

// Only registered credential surfaces may expose their own credential identity.
// Never use request.url (including a not-found path) as disclosure authority.
const CREDENTIAL_DTO_ROUTES = new Set([
  '/api/v1/me/credential-identity', '/api/v1/me/credential-grants',
  '/api/v1/me/credential-grants/:grantId', '/api/v1/me/credential-grants/:grantId/revoke',
  '/api/v1/me/credential-grants/:grantId/authorize-plan', '/api/v1/me/credential-plans/:planKind/:planId',
  '/api/v1/auth/credential-children',
  '/api/v1/auth/credential-children/:credentialId', '/api/v1/auth/credential-children/:credentialId/rotate',
  '/api/v1/auth/credential-children/:credentialId/revoke',
]);
