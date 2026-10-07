/**
 * P4A-I11 delivery-origin transport route (thin).
 *
 * This file owns ONLY the HTTP wiring for the session-free, R2-RO,
 * DB-read-only isolated delivery host: the pure policies, the production I10
 * capability verifier, and the narrow module object-store port are all
 * injected. It never imports infrastructure or bootstrap code (import
 * boundaries), holds no Known session/DB credential/R2 RW secret, never redirects to R2 URLs, never
 * renders inline, never writes to shared caches, and never forwards
 * Cookie/Authorization/Referer upstream (the RO object store only ever emits
 * its own signed S3 headers).
 *
 * All denial responses are zero-body: 404 (existence-hidden, matching the I10
 * admission policy), 429 (fixed request-level quota exhaustion, FIX-L-049),
 * 405/416 from the method/range policy and 503 for upstream/limiter outages;
 * an object above the delivery budget is zero-body 403. A client abort is an
 * expected cancellation (the upstream stream is destroyed through the
 * AbortSignal) and is never surfaced as a service error.
 */
import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  DELIVERY_CONTENT_TYPE,
  DELIVERY_UPSTREAM_TIMEOUT_DEFAULT_MS,
  deliveryMethodAllowed,
  deliveryReadByteCeiling,
  deliveryResponseByteCeiling,
  deliverySecurityHeaders,
  deliveryUpstreamStatus,
  evaluateIfNoneMatch,
  evaluateIfRange,
  formatContentDisposition,
  formatContentRange,
  formatUnsatisfiableContentRange,
  parseSingleByteRange,
  verifyOwnerDeliveryCapability,
  type DeliveryGenerationResolver,
  type DeliveryRequestLimiter,
  type DeliveryRequestLogEntry,
  type DeliveryRequestRateLimitOutcome,
  type DeliveryUpstreamFailureClass,
  type GenerationHeadOutcome,
  type GenerationObjectStorePort,
  type GenerationReadOutcome,
} from '../modules/attachments/index.js';

export interface DeliveryRouteDependencies {
  /** Exact audience the host is bound to: the configured production delivery
   * origin, or a function returning the dynamically-bound test origin. */
  readonly expectedAudience: string | (() => string);
  /** Resolved I10 capability HMAC secret (never a secret reference). */
  readonly capabilitySecret: string | Uint8Array;
  /** Narrow RO object store (I06 RO adapter / fixture). */
  readonly objectStore: GenerationObjectStorePort;
  /** Resolves the exact generation handle from the capability claims only. */
  readonly resolveGeneration: DeliveryGenerationResolver;
  /** Deployment single-PUT ceiling; bounds the per-response byte budget. */
  readonly singlePutMaxBytes: number;
  readonly clock?: () => Date;
  readonly upstreamTimeoutMs?: number;
  /** Optional fixed-class request log (never tokens/keys/URLs). */
  readonly requestLog?: DeliveryRequestLogEntry[];
  /**
   * FIX-L-049 optional request-level limiter: a trusted-IP low-cost bucket
   * (before capability verification, so invalid floods are bounded) and a
   * token-digest bucket (after verification, before DB/R2, so a leaked
   * capability replay is bounded). GET/HEAD share the token budget; Range
   * never opens a separate bucket. Denied -> fixed zero-body 429 with
   * Retry-After; limiter failure -> zero-body 503 (never unlimited admit);
   * invalid/expired capabilities keep the 404 concealment policy. Absent
   * limiter means the route performs no request-level limiting (the
   * production host composition always injects one).
   */
  readonly requestLimiter?: DeliveryRequestLimiter;
}

interface DeliveryRouteParams {
  token?: string;
}

interface DeliveryRouteQuery {
  filename?: string;
}

function applySecurityHeaders(reply: FastifyReply): void {
  for (const [name, value] of Object.entries(deliverySecurityHeaders())) {
    reply.header(name, value);
  }
}

function requestEntryBase(request: FastifyRequest): Omit<DeliveryRequestLogEntry, 'status' | 'byteCount'> {
  const headers = request.headers;
  return {
    receivedCookies: headers.cookie !== undefined,
    receivedAuthorization: headers.authorization !== undefined,
    receivedReferer: headers.referer !== undefined,
    setCookies: false,
    range: typeof headers.range === 'string' ? headers.range : undefined,
  };
}

/**
 * The delivery request log is diagnostics-only ("fixed class; never tokens/keys/
 * URLs"). Every terminal outcome appends an entry -- including anonymous 404/405,
 * unsatisfiable-range 416 and limiter 429/503 denials -- and the production
 * composition supplies no requestLog, so the array lives for the process
 * lifetime. Retain only the most recent entries so unauthenticated traffic cannot
 * grow it without bound.
 */
export const DELIVERY_REQUEST_LOG_LIMIT = 256;

function recordDeliveryRequestLog(
  log: DeliveryRequestLogEntry[] | undefined,
  entry: DeliveryRequestLogEntry,
): void {
  if (log === undefined) return;
  if (log.length >= DELIVERY_REQUEST_LOG_LIMIT) log.shift();
  log.push(entry);
}

function deny(
  reply: FastifyReply,
  status: 404 | 403 | 405 | 416 | 429 | 503,
  base: Omit<DeliveryRequestLogEntry, 'status' | 'byteCount'>,
  log: DeliveryRequestLogEntry[] | undefined,
  allowHeader?: string,
): FastifyReply {
  if (allowHeader !== undefined) reply.header('allow', allowHeader);
  recordDeliveryRequestLog(log, { ...base, status, byteCount: 0 });
  return reply.code(status).send();
}

function upstreamDeny(
  reply: FastifyReply,
  outcomeClass: DeliveryUpstreamFailureClass,
  base: Omit<DeliveryRequestLogEntry, 'status' | 'byteCount'>,
  log: DeliveryRequestLogEntry[] | undefined,
): FastifyReply {
  return deny(reply, deliveryUpstreamStatus({ class: outcomeClass }), base, log);
}

/**
 * FIX-L-049 fixed request-limit denial: quota exhaustion is a FIXED zero-body
 * 429 (with the standard Retry-After window hint, never capability material);
 * a limiter outage fails closed to the zero-body 503 — it must never silently
 * admit unlimited traffic. Both keep the fixed security-header set.
 */
function limitDeny(
  reply: FastifyReply,
  outcome: DeliveryRequestRateLimitOutcome,
  base: Omit<DeliveryRequestLogEntry, 'status' | 'byteCount'>,
  log: DeliveryRequestLogEntry[] | undefined,
): FastifyReply {
  if (outcome.kind === 'denied') {
    reply.header('retry-after', String(outcome.decision.retryAfterSeconds));
    return deny(reply, 429, base, log);
  }
  return deny(reply, 503, base, log);
}

/**
 * Re-yields the primed first chunk followed by the rest of the upstream
 * stream. Keeps the upstream iterator alive across the priming read so no
 * bytes are lost and no body is ever abandoned.
 */
async function* continueAfterFirst(
  first: IteratorResult<Uint8Array>,
  rest: AsyncIterator<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  if (!first.done) yield first.value;
  while (true) {
    const next = await rest.next();
    if (next.done) return;
    yield next.value;
  }
}

export function registerDeliveryRoutes(app: FastifyInstance, deps: DeliveryRouteDependencies): void {
  const clock = deps.clock ?? (() => new Date());
  const upstreamTimeoutMs = deps.upstreamTimeoutMs ?? DELIVERY_UPSTREAM_TIMEOUT_DEFAULT_MS;
  const ceiling = deliveryResponseByteCeiling(deps.singlePutMaxBytes);
  const log = deps.requestLog;

  app.route({
    method: ['GET', 'HEAD'],
    url: '/d/:token',
    handler: async (request, reply) => {
      applySecurityHeaders(reply);
      const base = requestEntryBase(request);
      if (!deliveryMethodAllowed(request.method)) {
        return deny(reply, 405, base, log, 'GET, HEAD');
      }

      const params = request.params as DeliveryRouteParams;
      const token = params?.token ?? '';
      const query = request.query as DeliveryRouteQuery;
      const filename = query?.filename ?? null;

      // FIX-L-049 trusted-IP low-cost bucket BEFORE capability verification:
      // a flood of invalid/expired tokens is bounded here (the cheapest
      // check) so it can never burn unbounded verification CPU. The subject
      // is either the direct peer or the forwarded client resolved through
      // the delivery host's exact trusted-ingress IP/CIDR allowlist. An
      // untrusted peer can never influence this value with a forwarded
      // header; over-budget is the fixed 429.
      if (deps.requestLimiter !== undefined) {
        const ipOutcome = await deps.requestLimiter.consume({
          policy: 'ip',
          facts: request.ip || 'unknown',
        });
        if (ipOutcome.kind !== 'allowed') {
          return limitDeny(reply, ipOutcome, base, log);
        }
      }

      const expectedAudience = typeof deps.expectedAudience === 'string'
        ? deps.expectedAudience
        : deps.expectedAudience();
      const verification = verifyOwnerDeliveryCapability({
        token,
        secret: deps.capabilitySecret,
        expectedAudience,
        now: clock(),
      });
      if (verification.outcome !== 'valid') {
        // Existence-hidden: invalid/expired/tampered/wrong-audience tokens are
        // indistinguishable from a missing object. Zero body, no redirect.
        return deny(reply, 404, base, log);
      }
      const claims = verification.claims;

      // FIX-L-049 token-digest bucket BEFORE DB/R2: a leaked capability can
      // be replayed inside its TTL; the digest bucket bounds the replay to a
      // fixed cost (GET and HEAD SHARE this budget; Range never opens a
      // separate bucket). The raw token only exists inside the limiter's
      // HMAC input — never in a key, log or error.
      if (deps.requestLimiter !== undefined) {
        const tokenOutcome = await deps.requestLimiter.consume({
          policy: 'token',
          facts: token,
        });
        if (tokenOutcome.kind !== 'allowed') {
          return limitDeny(reply, tokenOutcome, base, log);
        }
      }

      const resolved = await deps.resolveGeneration({
        blobId: claims.blobId,
        generationId: claims.generationId,
      });
      if (!resolved.found) return deny(reply, 404, base, log);

      // Upstream abort wiring: a client disconnect destroys the RO stream; a
      // hard timeout bounds any hanging R2 HEAD/GET. Fastify's reply.raw
      // 'close' is not enough on Node fetch abort after getReader() — also
      // listen to the incoming request abort/socket teardown (same pattern as
      // the Better Auth adapter).
      const controller = new AbortController();
      const raw = reply.raw;
      const onClientDisconnect = (): void => {
        if (!raw.writableFinished) controller.abort();
      };
      const detachAbortListeners = (): void => {
        raw.removeListener('close', onClientDisconnect);
        request.raw.removeListener('aborted', onClientDisconnect);
        request.raw.socket?.removeListener('close', onClientDisconnect);
      };
      raw.on('close', onClientDisconnect);
      request.raw.on('aborted', onClientDisconnect);
      request.raw.socket?.once('close', onClientDisconnect);
      const signal = AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(upstreamTimeoutMs),
      ]);

      let head: GenerationHeadOutcome;
      try {
        head = await deps.objectStore.headExact(resolved.handle, { signal });
      } catch {
        detachAbortListeners();
        return deny(reply, 503, base, log);
      }
      if (head.class !== 'ok') {
        detachAbortListeners();
        return upstreamDeny(reply, head.class, base, log);
      }
      const identity = head.identity;

      if (identity.size > ceiling) {
        // Object exists but exceeds the delivery byte budget: fail closed.
        detachAbortListeners();
        return deny(reply, 403, base, log);
      }

      const ifNoneMatchHeader = typeof request.headers['if-none-match'] === 'string'
        ? request.headers['if-none-match']
        : undefined;
      if (evaluateIfNoneMatch(ifNoneMatchHeader, identity.etag)) {
        reply.header('etag', identity.etag);
        recordDeliveryRequestLog(log, { ...base, status: 304, byteCount: 0 });
        detachAbortListeners();
        return reply.code(304).send();
      }

      const rangeHeader = typeof request.headers.range === 'string' ? request.headers.range : undefined;
      // FIX-L-047 If-Range: a Range header is honored ONLY when no If-Range
      // was sent or the If-Range validator is a strong entity-tag matching the
      // CURRENT representation ETag. A stale, weak, date-form, or invalid
      // If-Range means the Range header is ignored and the full 200
      // representation is served — never a 206 spliced from a different object
      // version. HEAD shares this decision, so its headers always mirror GET.
      const ifRangeHeader = typeof request.headers['if-range'] === 'string'
        ? request.headers['if-range']
        : undefined;
      const honorRange = ifRangeHeader === undefined || evaluateIfRange(ifRangeHeader, identity.etag);
      const range = honorRange
        ? parseSingleByteRange(rangeHeader, identity.size)
        : { kind: 'none' as const };
      if (range.kind === 'unsatisfiable') {
        reply.header('content-range', formatUnsatisfiableContentRange(identity.size));
        detachAbortListeners();
        return deny(reply, 416, base, log);
      }

      const isHead = request.method === 'HEAD';
      const status = range.kind === 'single' ? 206 : 200;
      const bodyLength = range.kind === 'single' ? range.end - range.start + 1 : identity.size;
      const readCeiling = deliveryReadByteCeiling(ceiling, identity.size, range);

      // HEAD must mirror the GET headers without a body: the exact-key HEAD
      // above already supplied size/etag, so no upstream GET (and no
      // unconsumed body stream) is issued for a HEAD request.
      let read: GenerationReadOutcome | undefined;
      let okRead: Extract<GenerationReadOutcome, { readonly class: 'ok' }> | undefined;
      if (!isHead) {
        try {
          read = await deps.objectStore.readBounded(resolved.handle, {
            expectedEtag: identity.etag,
            byteCeiling: readCeiling,
            signal,
            range: range.kind === 'single' ? { start: range.start, end: range.end } : undefined,
          });
        } catch {
          detachAbortListeners();
          return deny(reply, 503, base, log);
        }
        if (read.class !== 'ok') {
          detachAbortListeners();
          if (read.class === 'overflow') return deny(reply, 403, base, log);
          return upstreamDeny(reply, read.class, base, log);
        }
        okRead = read;
      }

      if (isHead) {
        reply.code(status);
        reply.header('content-type', DELIVERY_CONTENT_TYPE);
        reply.header('content-disposition', formatContentDisposition(filename));
        reply.header('etag', identity.etag);
        reply.header('accept-ranges', 'bytes');
        reply.header('content-length', String(bodyLength));
        if (range.kind === 'single') {
          reply.header('content-range', formatContentRange(range, identity.size));
        }
        recordDeliveryRequestLog(log, { ...base, status, byteCount: bodyLength });
        detachAbortListeners();
        return reply.send();
      }

      // Prime the first upstream chunk BEFORE committing the representation:
      // an upstream interruption/timeout that surfaces before the first byte
      // is a zero-body 503, never a 500 from a pre-flush stream error.
      // `okRead` is guaranteed here: this path is only reached for non-HEAD
      // after a successful readBounded.
      let iterator: AsyncIterator<Uint8Array>;
      let first: IteratorResult<Uint8Array>;
      try {
        iterator = okRead!.stream[Symbol.asyncIterator]();
        first = await iterator.next();
      } catch {
        detachAbortListeners();
        return deny(reply, 503, base, log);
      }

      reply.code(status);
      reply.header('content-type', DELIVERY_CONTENT_TYPE);
      reply.header('content-disposition', formatContentDisposition(filename));
      reply.header('etag', identity.etag);
      reply.header('accept-ranges', 'bytes');
      reply.header('content-length', String(bodyLength));
      if (range.kind === 'single') {
        reply.header('content-range', formatContentRange(range, identity.size));
      }

      if (first.done) {
        // Zero-byte representation: headers are the whole answer.
        recordDeliveryRequestLog(log, { ...base, status, byteCount: 0 });
        detachAbortListeners();
        return reply.send();
      }

      // Stream with Node backpressure; the upstream body is destroyed when the
      // client disconnects (the AbortSignal above) or on upstream overflow.
      const nodeStream = Readable.from(continueAfterFirst(first, iterator));
      const abortOutbound = (): void => {
        void iterator.return?.();
        if (!nodeStream.destroyed) nodeStream.destroy();
      };
      if (signal.aborted) abortOutbound();
      else signal.addEventListener('abort', abortOutbound, { once: true });
      let byteCount = 0;
      let terminalRecorded = false;
      const finishLog = (): void => {
        detachAbortListeners();
      };
      const recordTerminal = (): void => {
        if (terminalRecorded) return;
        terminalRecorded = true;
        recordDeliveryRequestLog(log, { ...base, status, byteCount });
        finishLog();
      };
      nodeStream.on('data', (chunk: Uint8Array) => {
        byteCount += chunk.byteLength;
      });
      nodeStream.on('end', recordTerminal);
      nodeStream.on('error', () => {
        // Mid-stream upstream failure: headers are already sent, so the
        // connection is simply closed. Never a service error.
        // `raw.writableFinished` is false exactly when the transfer was
        // interrupted (upstream failure) rather than completed.
        if (!raw.writableFinished) recordTerminal();
      });
      nodeStream.on('close', () => {
        // A client disconnect tears the reply payload down without 'end' or
        // 'error' (fastify destroys the stream); the fixed-class request log
        // still records the cancelled delivery (partial byte count).
        if (!raw.writableFinished) recordTerminal();
      });
      return reply.send(nodeStream);
    },
  });

  // Every other method on a delivery URL is denied 405 with an explicit
  // allowlist; unknown paths stay 404 (empty body, security headers).
  app.route({
    method: ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    url: '/d/:token',
    handler: async (request, reply) => {
      applySecurityHeaders(reply);
      return deny(reply, 405, requestEntryBase(request), log, 'GET, HEAD');
    },
  });

  app.setNotFoundHandler((request, reply) => {
    applySecurityHeaders(reply);
    return deny(reply, 404, requestEntryBase(request), log);
  });

  // Framework-level errors (e.g. a request body over the 1-byte limit -> 413)
  // must still carry the fixed security headers and stay zero-body.
  app.setErrorHandler((error, _request, reply) => {
    applySecurityHeaders(reply);
    const candidate = (error as { statusCode?: unknown }).statusCode;
    const status = typeof candidate === 'number' && candidate >= 400 ? candidate : 500;
    return reply.code(status).send();
  });
}
