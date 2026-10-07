import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../../bootstrap/config.js';
import { canonicalJson } from '../../modules/commands/index.js';
import {
  SEARCH_DEFAULT_TIMEOUT_MS,
  SEARCH_MAX_TIMEOUT_MS,
  SearchQueryError,
  type SearchPrincipal,
  type SearchQueryInput,
  type SearchQueryResult,
  type SearchResourceType,
} from '../../modules/search/index.js';
import type { IdentityUnitOfWork } from '../../modules/identity/index.js';
import { optionalSessionActor, authenticationRequired } from '../session-auth.js';
import { readSessionCookie } from '../session-cookie.js';
import { ProductHttpError } from '../product-error.js';
import { productErrorStatus } from '../product-codes.js';
import { productRouteMetadata } from '../product-route-manifest.js';
import { negotiatePublicationRead } from './publication-read-negotiation.js';
import type { SearchRateLimiter, SearchRateLimitSubject } from '../../infrastructure/rate-limit/index.js';

const SEARCH_CURSOR_MAX_LENGTH = 4_096;

export const SEARCH_PRODUCT_CONTRACT_VERSION = '1.7.0';
export const SEARCH_PRODUCT_MEDIA_TYPE = 'application/json';
export const SEARCH_RAW_QUERY_MAX_BYTES = 2_048;
export const SEARCH_QUERY_MAX_CODE_POINTS = 512;
export const SEARCH_QUERY_MAX_TOKENS = 64;
export const SEARCH_QUERY_MAX_COMBINING_MARKS = 64;
export const SEARCH_QUERY_MAX_WILDCARD_COMPLEXITY = 16;
export const SEARCH_QUERY_MAX_OPERATOR_COMPLEXITY = 32;
export const SEARCH_RAW_URL_QUERY_MAX_BYTES = 8_192;
export const SEARCH_TYPE_FILTER_MAX_CARDINALITY = 4;
export const SEARCH_SINGLE_PARAMETER_MAX_CARDINALITY = 1;

const ROUTE = '/api/v1/search';
// Anonymous Search may be stored by shared caches, but publication.cache_purge never
// covers /api/v1/search: with no invalidation channel, the SWR extension would keep
// serving revoked title/snippet summaries for its full 60s window after a
// public->private change, indexing opt-out, or deletion. must-revalidate forces
// origin revalidation once max-age expires, bounding revocation to the 30s
// cache-plan baseline. Restoring SWR requires a query-scoped epoch/purge contract
// first. Error responses carry no freshness and are never stored by shared caches;
// empty 200 results follow the same anonymous policy.
//
// Origin revalidation, including If-None-Match, still runs candidate SQL, current
// authority, ancestor CTE, admission, and timeout. Anonymous ETag/304 only omits
// the body after that fresh execution (FIX-L-025). Do not add a pre-SQL ETag cache:
// there is no Search purge/epoch channel, and OpenAPI requires the current
// authority projection before 304. Authenticated Search is private, no-store:
// omit ETag and never 304; no-store forbids reuse so hashing cannot save origin work.
const ANONYMOUS_CACHE = 'public, max-age=30, must-revalidate';
const GOVERNED_ANONYMOUS_CACHE = 'public, max-age=0, must-revalidate';
const PRIVATE_CACHE = 'private, no-store';
const ALL_TYPES = Object.freeze(['collection', 'node', 'profile', 'annotation'] as const);
const CONTROL = /[\p{Cc}\p{Cf}]/u;
const COMBINING = /\p{M}/u;
const WILDCARD_LIKE = /[*?%_\\]/gu;
const OPERATOR_LIKE = /["':()&|!<>]/gu;

export interface SearchProductQuery {
  execute(input: SearchQueryInput): Promise<SearchQueryResult>;
}

export interface SearchRoutesDependencies {
  readonly query: SearchProductQuery;
  readonly identityUnitOfWork?: IdentityUnitOfWork;
  readonly config?: AppConfig;
  readonly contentGovernanceEnabled?: boolean;
  /**
   * Search admission limiter (FIX-M-006). Required whenever Search routes
   * are registered. The anonymous family keys on the TRUSTED client IP
   * (Fastify `request.ip`, i.e. after trusted-ingress proxy resolution)
   * with an INDEPENDENT budget; the account family keys on the account id.
   * Shared Redis adapter in multi-replica production; memory limiter when
   * shared is off.
   */
  readonly rateLimiter: SearchRateLimiter;
  readonly timeoutMs?: number;
}

export function registerSearchRoutes(app: FastifyInstance, dependencies: SearchRoutesDependencies): void {
  const timeoutMs = dependencies.timeoutMs ?? SEARCH_DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > SEARCH_MAX_TIMEOUT_MS) {
    throw new TypeError('Search route timeout is outside the application budget.');
  }
  const routeOptions = {
    config: {
      productTransport: {
        allowedQuery: ['q', 'type', 'cursor', 'limit'],
        repeatableQuery: ['type'],
        duplicateQueryErrorCode: 'invalid_query',
        cacheControl: 'private-no-store',
      },
    },
    onRequest: async (request: FastifyRequest) => {
      validateRawSearchUrl(request.raw.url ?? request.url);
    },
  } as const;
  app.get(ROUTE, {
    ...routeOptions,
    exposeHeadRoute: false,
    config: { ...productRouteMetadata('GET', ROUTE), ...routeOptions.config },
  }, async (request, reply) => searchHandler(request, reply, dependencies, timeoutMs));
  app.head(ROUTE, {
    ...routeOptions,
    config: { ...productRouteMetadata('HEAD', ROUTE), ...routeOptions.config },
  }, async (request, reply) => searchHandler(request, reply, dependencies, timeoutMs));
}

async function searchHandler(request: FastifyRequest, reply: FastifyReply,
  dependencies: SearchRoutesDependencies, timeoutMs: number): Promise<FastifyReply> {
  mergeReplyVary(reply, ['Accept', 'Cookie', 'Authorization']);
  negotiateAccept(request.headers.accept);
  const input = parseSearchQuery(request.query as Record<string, string | readonly string[]>);
  const { principal } = await resolvePrincipal(request, dependencies.identityUnitOfWork);
  // FIX-M-006: Search admission runs AFTER principal resolution so the
  // anonymous family keys on the trusted client IP and the account family on
  // the account id — the two identity strategies never share a counter and
  // the anonymous budget stays independent from the auth parameters. Denied
  // (429) and fail-closed (503) responses never leak the quota state of
  // other principals.
  await admitSearchRateLimit(dependencies.rateLimiter, request, principal);
  const cancellation = requestCancellation(request, reply, timeoutMs);
  try {
    const result = await dependencies.query.execute({
      principal, query: input.query, types: input.types,
      ...(input.pageSize === undefined ? {} : { pageSize: input.pageSize }),
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }), timeoutMs,
      signal: cancellation.signal,
    });
    assertSearchProjection(result, principal, input.query, input.types);
    const representation = mapRepresentation(result);
    const bytes = Buffer.from(canonicalJson(representation), 'utf8');
    reply.header('X-Content-Type-Options', 'nosniff');
    // FIX-L-025 / P-05: 304 is a body elision after a fresh origin search, not a
    // DB skip. Candidate SQL, authority recheck, ancestor work, admission, and
    // timeout always run. There is no pre-SQL ETag cache. Anonymous responses
    // may set ETag and 304 after that execution. Account principals are
    // private, no-store: skip createSearchEtag hashing, omit ETag, and never 304
    // (including If-None-Match: *). Parse If-None-Match only when emitting ETag.
    if (principal.kind === 'anonymous') {
      const etag = createSearchEtag(bytes, result, principal);
      reply.header(
        'Cache-Control',
        dependencies.contentGovernanceEnabled ? GOVERNED_ANONYMOUS_CACHE : ANONYMOUS_CACHE,
      ).header('ETag', etag);
      const ifNoneMatch = singleHeader(request.headers['if-none-match']);
      if (ifNoneMatch !== undefined && ifNoneMatchMatches(ifNoneMatch, etag)) {
        return reply.code(304).send();
      }
    } else {
      reply.header('Cache-Control', PRIVATE_CACHE);
    }
    reply.code(200).type('application/json; charset=utf-8').header('Content-Length', String(bytes.byteLength));
    return request.method === 'HEAD' ? reply.send() : reply.send(bytes);
  } catch (error) {
    throw mapSearchError(error, cancellation.signal);
  } finally {
    cancellation.dispose();
  }
}

async function resolvePrincipal(request: FastifyRequest,
  identityUnitOfWork: IdentityUnitOfWork | undefined): Promise<{
  principal: SearchPrincipal; accountCreatedAt?: Date;
}> {
  const rawSession = readSessionCookie(request);
  const namedSessionCookies = (request.headers.cookie ?? '').match(/(?:^|;)\s*__Host-known_session=/gu) ?? [];
  if (namedSessionCookies.length > 1) throw invalidRequest('The Session cookie must occur once.');
  const hasNamedSessionCookie = namedSessionCookies.length === 1;
  const authenticated = await optionalSessionActor(request, identityUnitOfWork);
  if (authenticated === null) {
    if (rawSession !== null || hasNamedSessionCookie) throw authenticationRequired();
    return { principal: { kind: 'anonymous' } };
  }
  return {
    principal: { kind: 'account', accountId: authenticated.account.id, principalId: authenticated.account.id,
      subjectId: authenticated.account.subjectId, securityEpoch: authenticated.account.securityEpoch.toString() },
    accountCreatedAt: authenticated.account.createdAt,
  };
}

/**
 * Search admission: consumes one unit of the subject's family budget and
 * maps the outcome to the fail-closed HTTP contract (429 quota facts, 503
 * without fabricated quota facts on shared-store failure).
 */
async function admitSearchRateLimit(
  limiter: SearchRateLimiter | undefined,
  request: FastifyRequest,
  principal: SearchPrincipal,
): Promise<void> {
  if (limiter === undefined) {
    throw new Error('Search rate limiter is required whenever those routes are registered');
  }
  const subject: SearchRateLimitSubject = principal.kind === 'anonymous'
    ? { family: 'anonymous', subject: trustedClientIp(request) }
    : { family: 'account', subject: principal.accountId };
  const outcome = await limiter.consume(subject);
  if (outcome.kind === 'allowed') return;
  if (outcome.kind === 'denied') {
    throw new ProductHttpError({ statusCode: productErrorStatus('rate_limited'), code: 'rate_limited',
      message: 'Too many Search requests. Please try again later.', recovery: 'same_request',
      sameRequestRetrySafe: true, retryAfterSeconds: outcome.decision.retryAfterSeconds,
      headers: {
        'Retry-After': String(outcome.decision.retryAfterSeconds),
        'RateLimit-Policy': limiter.policy[subject.family],
      } });
  }
  // Shared-store failure: explicit fail-closed response. A 503 never
  // fabricates quota facts (no Retry-After / RateLimit-Policy) — a Search
  // admission outage must never silently admit unlimited traffic.
  throw new ProductHttpError({ statusCode: productErrorStatus('feature_temporarily_unavailable'),
    code: 'feature_temporarily_unavailable',
    message: 'Rate limiting service is temporarily unavailable. Please try again later.',
    recovery: 'same_request', sameRequestRetrySafe: true });
}

/**
 * Trusted client IP: Fastify's `request.ip`, which only honors
 * X-Forwarded-For entries from socket peers inside the configured trusted
 * ingress allowlist (FIX-M-006). Never read spoofable forwarded headers
 * directly.
 */
function trustedClientIp(request: FastifyRequest): string {
  const ip = typeof request.ip === 'string' && request.ip.length > 0 ? request.ip : 'unknown';
  return ip;
}

function parseSearchQuery(query: Record<string, string | readonly string[]>): {
  query: string; types: readonly SearchResourceType[]; pageSize?: number; cursor?: string;
} {
  if (typeof query.q !== 'string') throw invalidQuery();
  const normalized = validateDecodedSearchQuery(query.q);
  const rawTypes = query.type === undefined ? ALL_TYPES
    : typeof query.type === 'string' ? [query.type] : query.type;
  if (rawTypes.length === 0 || rawTypes.length > SEARCH_TYPE_FILTER_MAX_CARDINALITY
    || rawTypes.some((type) => !(ALL_TYPES as readonly string[]).includes(type))
    || new Set(rawTypes).size !== rawTypes.length) throw invalidQuery();
  const selected = new Set(rawTypes);
  const types = Object.freeze(ALL_TYPES.filter((type) => selected.has(type)));
  let pageSize: number | undefined;
  if (query.limit !== undefined) {
    if (typeof query.limit !== 'string' || !/^[1-9][0-9]*$/u.test(query.limit)) throw invalidQuery();
    pageSize = Number(query.limit);
    if (!Number.isSafeInteger(pageSize) || pageSize > 100) throw invalidQuery();
  }
  let cursor: string | undefined;
  if (query.cursor !== undefined) {
    if (typeof query.cursor !== 'string' || query.cursor.length === 0
      || query.cursor.length > SEARCH_CURSOR_MAX_LENGTH
      || pageSize !== undefined) throw invalidCursor();
    cursor = query.cursor;
  }
  return { query: normalized, types, ...(pageSize === undefined ? {} : { pageSize }),
    ...(cursor === undefined ? {} : { cursor }) };
}

export function validateRawSearchUrl(rawUrl: string): void {
  const marker = rawUrl.indexOf('?');
  if (marker < 0) return;
  const rawQuery = rawUrl.slice(marker + 1).split('#', 1)[0] ?? '';
  if (Buffer.byteLength(rawQuery, 'utf8') > SEARCH_RAW_URL_QUERY_MAX_BYTES) throw invalidQuery();
  for (const entry of rawQuery.split('&')) {
    const separator = entry.indexOf('=');
    const rawName = separator < 0 ? entry : entry.slice(0, separator);
    const rawValue = separator < 0 ? '' : entry.slice(separator + 1);
    if (/%(?![0-9A-Fa-f]{2})/u.test(rawName) || /%(?![0-9A-Fa-f]{2})/u.test(rawValue)) throw invalidQuery();
    if (Buffer.byteLength(rawValue, 'utf8') > SEARCH_RAW_QUERY_MAX_BYTES) throw invalidQuery();
    if (rawName === 'q') {
      try { decodeURIComponent(rawValue.replaceAll('+', ' ')); } catch { throw invalidQuery(); }
    }
  }
}

function validateDecodedSearchQuery(value: string): string {
  const before = [...value];
  if (before.length === 0 || before.length > SEARCH_QUERY_MAX_CODE_POINTS || CONTROL.test(value)) throw invalidQuery();
  let combining = 0;
  let combiningRun = 0;
  for (const point of before) {
    if (COMBINING.test(point)) {
      combining += 1;
      combiningRun += 1;
      if (combining > SEARCH_QUERY_MAX_COMBINING_MARKS || combiningRun > SEARCH_QUERY_MAX_COMBINING_MARKS) {
        throw invalidQuery();
      }
    } else combiningRun = 0;
  }
  const normalized = value.normalize('NFKC').toLocaleLowerCase('und').replace(/\s+/gu, ' ').trim()
    .replace(/(?<=\p{Script=Han}) (?=\p{Script=Han})/gu, '');
  if (normalized.length === 0 || [...normalized].length > SEARCH_QUERY_MAX_CODE_POINTS || CONTROL.test(normalized)) {
    throw invalidQuery();
  }
  if (normalized.split(' ').filter(Boolean).length > SEARCH_QUERY_MAX_TOKENS
    || (normalized.match(WILDCARD_LIKE) ?? []).length > SEARCH_QUERY_MAX_WILDCARD_COMPLEXITY
    || (normalized.match(OPERATOR_LIKE) ?? []).length > SEARCH_QUERY_MAX_OPERATOR_COMPLEXITY) throw invalidQuery();
  return normalized;
}

function mapRepresentation(result: SearchQueryResult) {
  return { query: result.normalizedQuery, types: result.types, items: result.items, page: result.page,
    consistency: result.consistency };
}

function assertSearchProjection(result: SearchQueryResult, principal: SearchPrincipal,
  query: string, types: readonly SearchResourceType[]): void {
  const cacheMatches = principal.kind === 'anonymous'
    ? result.cache.class === 'shared-public' && result.cache.partition.length > 0
    : result.cache.class === 'private-no-store' && result.cache.partition === null;
  if (!cacheMatches || result.normalizedQuery !== query
    || canonicalJson(result.types) !== canonicalJson(types)) {
    throw new ProductHttpError({ statusCode: productErrorStatus('internal_error'), code: 'internal_error',
      message: 'The Search request could not be completed.', recovery: 'same_request' });
  }
}

export function createSearchEtag(bytes: Uint8Array, result: SearchQueryResult, principal: SearchPrincipal): string {
  // FIX-L-025: the ETag deliberately hashes the ACTUAL response bytes
  // (including page.nextCursor) plus the principal projection — the cursor is
  // NOT excluded from the hash, so a 304 always stands for the exact bytes a
  // fresh request would return. Response stability comes from the query layer:
  // first pages with more pages reuse their signed cursor within the hard TTL
  // (SEARCH_FIRST_PAGE_CACHE_TTL_MS); after the TTL, or when the data or the
  // authority epoch changes, a new cursor/ETag is generated and stale
  // validators answer 200.
  // The Search HTTP route hashes ETag only for anonymous shared-cache
  // validators. A matching If-None-Match still follows a fresh origin search
  // (candidate SQL, authority recheck, timeout); 304 only elides the body.
  // Account (private, no-store) responses omit ETag and never 304.
  const projection = principal.kind === 'anonymous' ? { kind: 'anonymous', partition: result.cache.partition }
    : { kind: 'account', accountId: principal.accountId, principalId: principal.principalId,
      subjectId: principal.subjectId, securityEpoch: principal.securityEpoch };
  const digest = createHash('sha256').update(`known-product-search\n${SEARCH_PRODUCT_CONTRACT_VERSION}\n`)
    .update(canonicalJson(projection)).update('\n').update(bytes).digest('base64url');
  return `"sha256-${digest}"`;
}

function requestCancellation(request: FastifyRequest, reply: FastifyReply, timeoutMs: number): {
  signal: AbortSignal; dispose(): void;
} {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new SearchQueryError('search_timeout')), timeoutMs);
  timeout.unref?.();
  const abort = () => controller.abort(new SearchQueryError('search_aborted'));
  const close = () => { if (!reply.raw.writableEnded) abort(); };
  request.raw.once('aborted', abort);
  reply.raw.once('close', close);
  return { signal: controller.signal, dispose() { clearTimeout(timeout); request.raw.off('aborted', abort);
    reply.raw.off('close', close); } };
}

export function mapSearchError(error: unknown, signal: AbortSignal): ProductHttpError | unknown {
  if (error instanceof ProductHttpError) return error;
  if (error instanceof SearchQueryError) return SEARCH_QUERY_ERROR_MAP[error.code](error);
  const code = errorCode(error);
  const signalCode = errorCode(signal.reason);
  if (code === 'search_timeout' || signalCode === 'search_timeout' || code === '57014') {
    return unavailable('feature_temporarily_unavailable', 'The Search request timed out.');
  }
  if (code === 'search_aborted' || signalCode === 'search_aborted') {
    return unavailable('feature_temporarily_unavailable', 'The Search request was cancelled.');
  }
  if (['08000', '08001', '08003', '08006', '53300', '57P01', '57P02', '57P03',
    'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE'].includes(code ?? '')) {
    return unavailable('feature_temporarily_unavailable', 'Search is temporarily unavailable.');
  }
  return new ProductHttpError({ statusCode: productErrorStatus('internal_error'), code: 'internal_error',
    message: 'The Search request could not be completed.', recovery: 'same_request' });
}
const SEARCH_QUERY_ERROR_MAP = {
  invalid_cursor: (error) => invalidCursor(),
  invalid_search_query: (error) => invalidQuery(),
  search_timeout: (error) => unavailable('feature_temporarily_unavailable', 'The Search request timed out.'),
  search_aborted: (error) => unavailable('feature_temporarily_unavailable', 'The Search request was cancelled.'),
} as const satisfies Readonly<Record<SearchQueryError['code'], (error: SearchQueryError) => ProductHttpError>>;

function errorCode(error: unknown, depth = 0): string | undefined {
  if (depth >= 4 || typeof error !== 'object' || error === null) return undefined;
  if ('code' in error && typeof (error as { code?: unknown }).code === 'string') {
    return (error as { code: string }).code;
  }
  return 'cause' in error ? errorCode((error as { cause?: unknown }).cause, depth + 1) : undefined;
}

function unavailable(code: 'feature_temporarily_unavailable', message: string) {
  return new ProductHttpError({ statusCode: productErrorStatus('feature_temporarily_unavailable'), code, message, recovery: 'same_request',
    sameRequestRetrySafe: true, retryAfterSeconds: 1, headers: { 'Retry-After': '1' } });
}

function negotiateAccept(value: string | readonly string[] | undefined): void {
  const accept = singleHeader(value);
  if (accept !== undefined && accept.trim() === '') throw notAcceptable();
  if (!negotiatePublicationRead({ accept, protocolVersion: undefined,
    mediaType: SEARCH_PRODUCT_MEDIA_TYPE, version: SEARCH_PRODUCT_CONTRACT_VERSION })) throw notAcceptable();
}

function ifNoneMatchMatches(value: string, current: string): boolean {
  if (value.trim() === '*') return true;
  if (value.includes('*')) throw invalidRequest('If-None-Match is invalid.');
  const validators = splitEntityTagList(value);
  if (validators === null) throw invalidRequest('If-None-Match is invalid.');
  const normalizedCurrent = current.replace(/^W\//u, '');
  return validators.some((validator) => validator.replace(/^W\//u, '') === normalizedCurrent);
}

function splitEntityTagList(value: string): readonly string[] | null {
  const values: string[] = [];
  let start = 0;
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) === 0x22) quoted = !quoted;
    if (value.charCodeAt(index) === 0x2c && !quoted) { values.push(value.slice(start, index).trim()); start = index + 1; }
  }
  if (quoted) return null;
  values.push(value.slice(start).trim());
  return values.length > 0 && values.every((item) => /^(?:W\/)?"[\x21\x23-\x7E\u0080-\uFFFF]*"$/u.test(item))
    ? values : null;
}

function singleHeader(value: string | readonly string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw invalidRequest('The request header must occur once.');
  return value;
}

function mergeReplyVary(reply: FastifyReply, additions: readonly string[]): void {
  const current = reply.getHeader('Vary');
  const fields = new Map<string, string>();
  const append = (value: string) => value.split(',').map((part) => part.trim()).filter(Boolean)
    .forEach((field) => fields.set(field.toLowerCase(), fields.get(field.toLowerCase()) ?? field));
  if (Array.isArray(current)) current.forEach(append); else if (current !== undefined) append(String(current));
  additions.forEach(append);
  reply.header('Vary', fields.has('*') ? '*' : [...fields.values()].join(', '));
}

function invalidQuery() { return new ProductHttpError({ statusCode: productErrorStatus('invalid_query'), code: 'invalid_query',
  message: 'The Search query is invalid.', recovery: 'user_action' }); }
function invalidCursor() { return new ProductHttpError({ statusCode: productErrorStatus('invalid_cursor'), code: 'invalid_cursor',
  message: 'The Search cursor is invalid.', recovery: 'restart_from_first_page' }); }
function invalidRequest(message: string) { return new ProductHttpError({ statusCode: productErrorStatus('invalid_request'),
  code: 'invalid_request', message, recovery: 'user_action' }); }
function notAcceptable() { return new ProductHttpError({ statusCode: productErrorStatus('not_acceptable'), code: 'not_acceptable',
  message: 'No acceptable Search representation is available.', recovery: 'user_action' }); }
