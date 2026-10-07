import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ProductHttpError } from '../product-error.js';
import { productRouteMetadata } from '../product-route-manifest.js';
import { requireAllowedOrigin } from '../auth/origin-csrf.js';
import {
  consumeProductAdmission,
  rateLimitClientKey,
  type ProductAdmissionRateLimiter,
} from '../http-security.js';

/**
 * R15-13: first-party sink for web client errors and Core Web Vitals. The
 * browser beacons them here; each accepted event becomes one structured log
 * line (`msg: "client_event"`), so the existing log pipeline is the sink. No
 * Session, account id or concrete URL is read or written: events carry the
 * route template only. Admission reuses the shared per-IP public-object
 * limiter under its own key family, so it never shares a counter with
 * avatar/favicon reads.
 */
const CLIENT_EVENTS_ROUTE = '/api/v1/client-events';
export const CLIENT_EVENTS_RATE_LIMIT_FAMILY = 'client-events';

const RELEASE_PATTERN = /^[A-Za-z0-9._-]{1,64}$/u;
const ROUTE_PATTERN = /^\/[A-Za-z0-9/:*?._-]{0,199}$/u;
const ERROR_SOURCES = new Set(['window_error', 'unhandled_rejection', 'render_error', 'chunk_load_error']);
const VITAL_NAMES = new Set(['LCP', 'CLS', 'INP']);
const VITAL_RATINGS = new Set(['good', 'needs-improvement', 'poor']);
const MAX_EVENTS = 20;

export type ClientEvent =
  | {
      readonly kind: 'error';
      readonly source: string;
      readonly route: string;
      readonly message: string;
      readonly stack?: string;
    }
  | {
      readonly kind: 'vital';
      readonly name: string;
      readonly value: number;
      readonly rating: string;
      readonly route: string;
    };

export interface ClientEventBatch {
  readonly release: string;
  readonly events: readonly ClientEvent[];
}

export interface ClientEventRouteDependencies {
  readonly allowedOrigins: readonly string[];
  readonly rateLimiter: ProductAdmissionRateLimiter;
}

export function registerClientEventRoutes(
  app: FastifyInstance,
  dependencies: ClientEventRouteDependencies,
): void {
  app.post(CLIENT_EVENTS_ROUTE, {
    config: {
      ...productRouteMetadata('POST', CLIENT_EVENTS_ROUTE),
      productTransport: {
        allowedQuery: [],
        acceptedMediaTypes: ['application/json'],
        bodyLimitBytes: 65_536,
        cacheControl: 'private-no-store',
      },
    },
  }, async (request, reply) => {
    requireAllowedOrigin(request, dependencies.allowedOrigins);
    await admitClientEvents(dependencies.rateLimiter, request);
    const batch = parseClientEventBatch(request.body);
    const userAgent = typeof request.headers['user-agent'] === 'string'
      ? request.headers['user-agent'].slice(0, 256)
      : '';
    for (const event of batch.events) {
      const fields = { clientEvent: { ...event, release: batch.release, userAgent } };
      if (event.kind === 'error') request.log.warn(fields, 'client_event');
      else request.log.info(fields, 'client_event');
    }
    return reply.code(204).send();
  });
}

async function admitClientEvents(
  limiter: ProductAdmissionRateLimiter,
  request: FastifyRequest,
): Promise<void> {
  const decision = await consumeProductAdmission(
    limiter,
    rateLimitClientKey(request, CLIENT_EVENTS_RATE_LIMIT_FAMILY),
  );
  if (decision.kind === 'allowed') return;
  if (decision.kind === 'failed') {
    throw new ProductHttpError({
      statusCode: 503,
      code: 'feature_temporarily_unavailable',
      message: 'Client event admission is temporarily unavailable.',
      recovery: 'same_request',
      sameRequestRetrySafe: true,
    });
  }
  throw new ProductHttpError({
    statusCode: 429,
    code: 'rate_limited',
    message: 'Too many client events. Please try again later.',
    recovery: 'same_request',
    sameRequestRetrySafe: true,
    retryAfterSeconds: decision.retryAfterSeconds,
    headers: { 'Retry-After': String(decision.retryAfterSeconds) },
  });
}

export function parseClientEventBatch(body: unknown): ClientEventBatch {
  const record = plainObject(body, 'Client event batch is invalid.');
  exactKeys(record, ['release', 'events'], [], 'Client event batch has unknown or missing properties.');
  const { release, events } = record;
  if (typeof release !== 'string' || !RELEASE_PATTERN.test(release)) {
    throw invalidRequest('release is invalid.');
  }
  if (!Array.isArray(events) || events.length === 0 || events.length > MAX_EVENTS) {
    throw invalidRequest(`events must hold 1 to ${MAX_EVENTS} items.`);
  }
  return { release, events: events.map(parseClientEvent) };
}

function parseClientEvent(value: unknown): ClientEvent {
  const record = plainObject(value, 'Client event is invalid.');
  const route = record.route;
  if (typeof route !== 'string' || !ROUTE_PATTERN.test(route)) {
    throw invalidRequest('route must be a route template.');
  }
  if (record.kind === 'error') {
    exactKeys(record, ['kind', 'source', 'route', 'message'], ['stack'], 'Error event has unknown or missing properties.');
    const { source, message, stack } = record;
    if (typeof source !== 'string' || !ERROR_SOURCES.has(source)) throw invalidRequest('source is not in the closed set.');
    if (typeof message !== 'string' || message.length > 500) throw invalidRequest('message is invalid.');
    if (stack !== undefined && (typeof stack !== 'string' || stack.length > 4000)) throw invalidRequest('stack is invalid.');
    return { kind: 'error', source, route, message, ...(stack === undefined ? {} : { stack }) };
  }
  if (record.kind === 'vital') {
    exactKeys(record, ['kind', 'name', 'value', 'rating', 'route'], [], 'Vital event has unknown or missing properties.');
    const { name, value: metric, rating } = record;
    if (typeof name !== 'string' || !VITAL_NAMES.has(name)) throw invalidRequest('name is not in the closed set.');
    if (typeof metric !== 'number' || !Number.isFinite(metric) || metric < 0 || metric > 600_000) {
      throw invalidRequest('value is invalid.');
    }
    if (typeof rating !== 'string' || !VITAL_RATINGS.has(rating)) throw invalidRequest('rating is not in the closed set.');
    return { kind: 'vital', name, value: metric, rating, route };
  }
  throw invalidRequest('Client event kind is not in the closed set.');
}

function plainObject(value: unknown, message: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalidRequest(message);
  return value as Record<string, unknown>;
}

function exactKeys(
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  message: string,
): void {
  const keys = Object.keys(record);
  if (required.some((key) => !Object.hasOwn(record, key))
    || keys.some((key) => !required.includes(key) && !optional.includes(key))) {
    throw invalidRequest(message);
  }
}

function invalidRequest(message: string): ProductHttpError {
  return new ProductHttpError({ statusCode: 400, code: 'invalid_request', message });
}
