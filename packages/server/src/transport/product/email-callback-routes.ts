import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  EmailCallbackRejectedError,
  type EmailCallbackFact,
  type EmailCallbackRateLimiter,
  type EmailCallbackReconciliationResult,
  type EmailCallbackVerifier,
} from '../../modules/email/index.js';
import { redactSensitiveText, type Metrics } from '../../infrastructure/telemetry/index.js';

export const EMAIL_CALLBACK_PATH = '/api/v1/email/callbacks/delivery';
export const EMAIL_CALLBACK_BODY_LIMIT_BYTES = 1_048_576;
const EMAIL_CALLBACK_REJECT_STATUS: Readonly<Record<string, number>> = Object.freeze({
  not_configured: 401,
  missing_signature_headers: 401,
  invalid_certificate_url: 403,
  expired_timestamp: 403,
  signature_mismatch: 403,
  // Deliberate fail-closed decision on the legacy MNS path: a push without a
  // Content-MD5 header leaves the body OUTSIDE the RSA signature, so it is
  // rejected here (403) before any reconciliation can run.
  missing_content_md5: 403,
  malformed_callback_body: 403,
  unknown_event_type: 403,
});

/**
 * P5-31 delivery-result callback ingress.
 *
 * n1 decision: `not_configured` stays mapped to 401 as DOCUMENTED
 * defense-in-depth. In the production composition the surface is disabled
 * (404) whenever the callback HMAC secret is null, so a not_configured
 * rejection is unreachable there; the mapping is kept so a mis-configured
 * composition that enables the surface without a secret still fails closed
 * with a 401 (never a 403/500) instead of silently accepting callbacks.
 *
 * Mounted in the API composition and DISABLED (404) whenever the email
 * feature is not configured. Every verified request is reconciled through the
 * P5-29 production repository (idempotent CAS replay) and answered with a
 * stable 202. Unverified requests (missing/invalid/expired signatures,
 * malformed bodies, unknown event types) are rejected with 401/403 and never
 * reach reconciliation, so a rejected callback has NO side effects. A VERIFIED
 * request whose reconciliation fails returns a stable 503
 * `{ error: 'callback_reconcile_error' }` (never raw provider/DB text),
 * increments `notifications.email_delivery.callback.reconcile_error`, and is
 * never retried by this surface (provider redelivery + idempotent CAS replay).
 *
 * Verification is delegated to the P5-28 adapter verifier (verifyCallback):
 * either the frozen EventBridge/controlled-sink HMAC envelope
 * (X-Known-DM-Signature/Timestamp/Nonce) or the legacy MNS HTTP push
 * signature chain. The EventBridge HTTP target must be configured to add the
 * X-Known-DM-* headers; SenderStatisticsDetailByParam remains the delivery
 * authority (gate doc 14.5).
 *
 * The body is parsed as raw bytes on a scoped Fastify instance so the
 * canonical body used for the HMAC envelope is byte-exact.
 */
export interface EmailCallbackRoutesDependencies {
  readonly enabled: boolean;
  readonly verifier?: EmailCallbackVerifier;
  readonly reconcile?: (fact: EmailCallbackFact) => Promise<EmailCallbackReconciliationResult>;
  readonly metrics?: Metrics;
  /** Verification clock (test seam); defaults to Date.now(). */
  readonly now?: () => Date;
  readonly bodyLimitBytes?: number;
  /**
   * FIX-L-061 optional trusted-IP ingress budget (KA-P5-SOC-16): consumed
   * BEFORE body decoding, signature verification and any certificate fetch,
   * so unauthenticated floods (including certificate-path rotation on the
   * MNS path) are bounded at the cheapest possible point. Denied -> fixed
   * 429 with Retry-After; limiter failure -> fail-closed 503 (never silent
   * unlimited admit). The production API composition always injects one
   * (shared Redis adapter in multi-replica deployments). A disabled surface
   * keeps answering 404 and never consumes limiter capacity.
   */
  readonly rateLimiter?: EmailCallbackRateLimiter;
}

export function mapEmailCallbackRejectionStatus(reason: string): number {
  return EMAIL_CALLBACK_REJECT_STATUS[reason] ?? 403;
}

export function registerEmailCallbackRoutes(app: FastifyInstance, deps: EmailCallbackRoutesDependencies): void {
  const bodyLimit = deps.bodyLimitBytes ?? EMAIL_CALLBACK_BODY_LIMIT_BYTES;
  if (!Number.isSafeInteger(bodyLimit) || bodyLimit < 1 || bodyLimit > 8 * 1024 * 1024) {
    throw new TypeError('email callback body limit must be within 1..8388608 bytes');
  }
  app.register(async (scope) => {
    // Fastify parses request bodies before the handler. Run the cheapest
    // trusted-IP admission in onRequest so rejected floods never get buffered
    // into memory by the scoped raw-byte parser.
    const preParseAdmitted = new WeakSet<FastifyRequest>();
    const admitIp = async (request: FastifyRequest, reply: FastifyReply): Promise<boolean> => {
      if (!deps.enabled || !deps.verifier || !deps.reconcile || !deps.rateLimiter) return true;
      const clientIp = typeof request.ip === 'string' && request.ip.length > 0 ? request.ip : 'unknown';
      const outcome = await deps.rateLimiter.consume({ policy: 'ip', facts: clientIp });
      if (outcome.kind === 'denied') {
        deps.metrics?.increment('notifications.email_delivery.callback.rate_limited');
        reply.header('retry-after', String(outcome.decision.retryAfterSeconds));
        reply.code(429).send({ error: 'rate_limited' });
        return false;
      }
      if (outcome.kind === 'failed') {
        deps.metrics?.increment('notifications.email_delivery.callback.rate_limit_failure');
        reply.code(503).send({ error: 'rate_limit_unavailable' });
        return false;
      }
      preParseAdmitted.add(request);
      return true;
    };
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit }, (_request, body, done) => {
      done(null, body);
    });
    scope.post(EMAIL_CALLBACK_PATH, {
      // The EventBridge/controlled-sink HMAC envelope is JSON; the legacy MNS
      // HTTP push is an &-separated text body. The product-admission gate must
      // accept both so the real MNS ingress reaches the verifier.
      config: {
        productTransport: {
          allowedQuery: [],
          cacheControl: 'no-store',
          acceptedMediaTypes: ['application/json', 'text/plain'],
          bodyLimitBytes: bodyLimit,
        },
      },
      onRequest: async (request, reply) => { await admitIp(request, reply); },
    }, async (request: FastifyRequest, reply: FastifyReply) => {
      if (!deps.enabled || !deps.verifier || !deps.reconcile) {
        return reply.code(404).send({ error: 'not_found' });
      }
      // FIX-L-061: the shared trusted-IP budget is consumed BEFORE any body
      // decode, signature verification or certificate fetch. `request.ip` only
      // honors X-Forwarded-For through the configured trusted-ingress
      // allowlist, never a spoofable forwarded header read directly. A denied
      // budget is a fixed 429 with Retry-After (quota facts only — no
      // signature/body PII); a limiter outage fails closed with 503 and must
      // never silently admit unlimited traffic.
      const rateLimiter = deps.rateLimiter;
      if (rateLimiter && !preParseAdmitted.has(request)) {
        const clientIp = typeof request.ip === 'string' && request.ip.length > 0 ? request.ip : 'unknown';
        const outcome = await rateLimiter.consume({ policy: 'ip', facts: clientIp });
        if (outcome.kind === 'denied') {
          deps.metrics?.increment('notifications.email_delivery.callback.rate_limited');
          reply.header('retry-after', String(outcome.decision.retryAfterSeconds));
          return reply.code(429).send({ error: 'rate_limited' });
        }
        if (outcome.kind === 'failed') {
          deps.metrics?.increment('notifications.email_delivery.callback.rate_limit_failure');
          return reply.code(503).send({ error: 'rate_limit_unavailable' });
        }
      }
      if (!Buffer.isBuffer(request.body)) throw new TypeError('email callback body is not buffered');
      let body: string;
      try {
        body = new TextDecoder('utf-8', { fatal: true }).decode(request.body);
      } catch {
        deps.metrics?.increment('notifications.email_delivery.callback.rejected');
        return reply.code(403).send({ error: 'callback_rejected' });
      }
      const headers = collectRawHeaders(request.raw.rawHeaders);
      let fact: EmailCallbackFact;
      try {
        fact = await deps.verifier.verifyCallback({
          method: 'POST',
          url: request.url,
          headers,
          body,
          now: deps.now?.(),
        });
      } catch (error) {
        if (error instanceof EmailCallbackRejectedError) {
          deps.metrics?.increment('notifications.email_delivery.callback.rejected');
          return reply.code(mapEmailCallbackRejectionStatus(error.reason)).send({ error: 'callback_rejected' });
        }
        throw error;
      }
      try {
        await deps.reconcile(fact);
      } catch (error) {
        // A verified callback that FAILS reconciliation is NOT a verification
        // rejection (callback.rejected stays untouched): it is an observability
        // event of its own. Reply with a stable 503 (provider retryable) and a
        // fixed, redacted error code - never the raw provider/DB text - and let
        // the provider redeliver; zero side-effect guarantee is preserved by
        // never retrying reconciliation here (reconciliation is idempotent CAS).
        deps.metrics?.increment('notifications.email_delivery.callback.reconcile_error');
        request.log.error({ error: redactSensitiveText(error) },
          'email callback reconciliation failed');
        return reply.code(503).send({ error: 'callback_reconcile_error' });
      }
      deps.metrics?.increment('notifications.email_delivery.callback.accepted');
      return reply.code(202).send({ accepted: true });
    });
  });
}

function collectRawHeaders(raw: readonly string[]): Readonly<Record<string, string>> {
  const headers: Record<string, string> = {};
  for (let index = 0; index < raw.length; index += 2) {
    const name = raw[index]!.toLowerCase();
    if (name in headers) continue; // first value wins (port contract)
    headers[name] = raw[index + 1] ?? '';
  }
  return headers;
}
