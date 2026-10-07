/**
 * P4A-I11 production isolated-origin delivery host.
 *
 * Composition entrypoint for the session-free, R2-RO, DB-read-only delivery
 * process (plan §6 I11, §9: isolated production host + Chromium). It owns:
 *
 *  - the narrow RO object store: when `objectStore` is not injected it is
 *    composed from the attachments config using ONLY the R2 RO secret
 *    reference (`r2.roSecretRef`) through `createR2ReadOnlyGenerationStore`
 *    — the delivery process structurally holds no R2 RW secret and no write
 *    path;
 *  - the I10 capability HMAC secret, resolved from
 *    `deliveryCapabilitySecretRef` by the caller-provided resolver;
 *  - the FIX-L-049 request-level limiter: a bounded in-memory adapter by
 *    default (single-instance); multi-replica deployments inject the shared
 *    Redis adapter (or rely on WAF/CDN edge control). The route checks a
 *    trusted-IP bucket before verification and a token-digest bucket before
 *    DB/R2 (over-budget -> fixed 429, limiter outage -> 503, invalid/expired
 *    capabilities keep the 404 concealment policy);
 *  - a dedicated Fastify instance listening on a SEPARATE origin (distinct
 *    host/port from the Known application origin), registering the thin
 *    delivery route from `transport/delivery-route.ts` and, when
 *    `readinessPath` is configured, a fixed readiness probe (`/-/ready` or
 *    equivalent) that never exposes capability material;
 *  - the pure delivery policies (filename/range/budget/cache/security
 *    headers/method allowlist/If-None-Match) applied by the route.
 *
 * The host holds NO Known session, NO R2 RW secret, and only ever resolves
 * exact generations through the caller-provided DB-read-only generation
 * resolver; it only consumes the I10 short-term capability and reads the
 * exact generation via the RO path. There is deliberately no public API
 * exposure: only `/d/:token` (GET/HEAD) and the fixed readiness probe exist.
 */
import Fastify from 'fastify';
import type { AddressInfo } from 'node:net';
import type { AttachmentsFeatureConfig } from '../modules/attachments/index.js';
import {
  createGenerationObjectStoreAdapter,
  createR2ReadOnlyGenerationStore,
  type R2Credential,
} from '../infrastructure/object-storage/index.js';
import { deliverySecurityHeaders } from '../modules/attachments/index.js';
import type {
  DeliveryGenerationResolver,
  DeliveryRequestLimiter,
  DeliveryRequestLogEntry,
  GenerationObjectStorePort,
} from '../modules/attachments/index.js';
import { createMemoryDeliveryRequestLimiter } from '../infrastructure/rate-limit/index.js';
import { registerDeliveryRoutes } from '../transport/delivery-route.js';

export interface DeliveryHost {
  /** Actual bound origin (e.g. `http://127.0.0.2:<port>` in tests). */
  readonly origin: string;
  /**
   * The ACTUAL listening origin (`http://<bind-host>:<port>`) once started,
   * regardless of the fixed audience. Production operators use this for
   * local probes; the capability audience stays `config.isolatedDeliveryOrigin`.
   */
  readonly boundOrigin: string;
  /** Fixed-class request log; never tokens/keys/URLs. */
  readonly requestLog: DeliveryRequestLogEntry[];
  start(): Promise<string>;
  close(): Promise<void>;
}

/**
 * Secret resolver for the delivery composition. The R2 ref must resolve to a
 * structured credential pair; the capability ref must resolve to a raw
 * HMAC key. Only the R2 RO ref is ever consulted.
 */
export type DeliverySecretValue = string | Uint8Array | R2Credential;
export type DeliverySecretResolver = (ref: string) => Promise<DeliverySecretValue>;

function isR2Credential(value: DeliverySecretValue): value is R2Credential {
  return typeof value === 'object' && value !== null && 'accessKeyId' in value && 'secretAccessKey' in value;
}

export interface DeliveryHostCompositionOptions {
  readonly config: AttachmentsFeatureConfig;
  readonly resolveGeneration: DeliveryGenerationResolver;
  /** Injected object store (tests/fixtures); otherwise composed RO-only. */
  readonly objectStore?: GenerationObjectStorePort;
  /** Injected capability secret; otherwise resolved from the secret ref. */
  readonly capabilitySecret?: string | Uint8Array;
  /** Required when `objectStore`/`capabilitySecret` are not injected. */
  readonly resolveSecret?: DeliverySecretResolver;
  /** Fixed audience (production https origin); otherwise the bound origin. */
  readonly audienceOrigin?: string;
  /**
   * Optional fixed readiness probe path (e.g. `/-/ready`). When set, a GET
   * route returning 200 `ok` is registered; it exposes no capability
   * material, object keys or secrets. Default: no readiness route.
   */
  readonly readinessPath?: string;
  readonly clock?: () => Date;
  readonly hostname?: string;
  readonly port?: number;
  /**
   * Socket peers allowed to contribute forwarded addresses to `request.ip`.
   * Entries are exact IPs/CIDRs parsed by `parseTrustedIngress`; an empty or
   * omitted list is peer-only. Never pass a hop count or a blanket `true`.
   */
  readonly trustedIngress?: readonly string[];
  readonly upstreamTimeoutMs?: number;
  readonly requestLog?: DeliveryRequestLogEntry[];
  /**
   * FIX-L-049 injected request-level limiter (trusted-IP + token-digest
   * buckets). Defaults to a bounded in-memory adapter (per-process budgets:
   * single-instance deployments and tests). Multi-replica delivery
   * deployments MUST inject the shared Redis adapter (or rely on WAF/CDN
   * edge control) so replicas share one quota. When injected, the caller
   * owns the adapter's lifecycle (`close()`); the host closes only the
   * default in-memory adapter it created.
   */
  readonly requestLimiter?: DeliveryRequestLimiter;
  /**
   * Fastify connection close policy. Production drain keeps this unset
   * (`false`) so `close()` waits for in-flight deliveries. Unit tests that
   * abort a client mid-stream must pass `true` so `host.close()` cannot hang
   * on a Fastify request that already lost its client.
   */
  readonly forceCloseConnections?: boolean | 'idle';
}

async function composeReadOnlyObjectStore(
  config: AttachmentsFeatureConfig,
  resolveSecret: DeliverySecretResolver,
): Promise<GenerationObjectStorePort> {
  const roValue = await resolveSecret(config.r2.roSecretRef);
  if (!isR2Credential(roValue)) throw new Error('delivery_r2_ro_secret_invalid');
  const store = createR2ReadOnlyGenerationStore({
    endpoint: config.r2.endpoint,
    region: config.r2.region,
    bucket: config.r2.bucket,
    livePrefix: config.r2.livePrefix,
    probePrefix: config.r2.probePrefix,
    roCredential: roValue,
    grantTtlSeconds: config.grantTtlSeconds,
    singlePutMaxBytes: config.singlePutMaxBytes,
  });
  return createGenerationObjectStoreAdapter(store);
}

export async function composeDeliveryHost(
  options: DeliveryHostCompositionOptions,
): Promise<DeliveryHost> {
  let objectStore = options.objectStore;
  let capabilitySecret = options.capabilitySecret;
  let ownedStore: GenerationObjectStorePort | undefined;
  let requestLimiter = options.requestLimiter;
  let ownedLimiter: DeliveryRequestLimiter | undefined;

  if (requestLimiter === undefined) {
    // FIX-L-049 default: the isolated host ALWAYS limits actual GET/HEAD.
    // The bounded in-memory adapter is the single-instance default; the
    // shared Redis adapter is injected by multi-replica compositions.
    requestLimiter = createMemoryDeliveryRequestLimiter();
    ownedLimiter = requestLimiter;
  }

  if (objectStore === undefined || capabilitySecret === undefined) {
    if (options.resolveSecret === undefined) {
      throw new Error('delivery_composition_secret_resolver_required');
    }
    if (objectStore === undefined) {
      objectStore = await composeReadOnlyObjectStore(options.config, options.resolveSecret);
      ownedStore = objectStore;
    }
    if (capabilitySecret === undefined) {
      const secretValue = await options.resolveSecret(options.config.deliveryCapabilitySecretRef);
      if (typeof secretValue === 'string' || secretValue instanceof Uint8Array) {
        capabilitySecret = secretValue;
      } else {
        throw new Error('delivery_capability_secret_invalid');
      }
    }
  }

  const hostname = options.hostname ?? '0.0.0.0';
  const port = options.port ?? 0;
  const requestLog = options.requestLog ?? [];
  let originValue = options.audienceOrigin ?? '';
  let boundOriginValue = '';
  const app = Fastify({
    logger: false,
    bodyLimit: 1, // Fastify requires an integer > 0; any request body fails closed (413).
    // The capability token is a route param; raise the default 100-char param
    // cap so valid I10 tokens (~<600 chars) are accepted while still bounding
    // absurdly long URLs (anything longer just fails verification -> 404).
    routerOptions: { maxParamLength: 1024 },
    // Only an explicitly allowlisted CDN/LB socket peer may contribute
    // X-Forwarded-For to request.ip. Empty/omitted is direct peer-only, so a
    // publicly reachable origin cannot accept a client-spoofed header.
    trustProxy: options.trustedIngress !== undefined && options.trustedIngress.length > 0
      ? [...options.trustedIngress]
      : false,
    genReqId: () => 'delivery',
    // Fastify framework-level responses that never reach a route handler
    // (invalid URL component -> 400, token over maxParamLength -> 414) must
    // still carry the fixed security headers and stay zero-body: the default
    // handlers echo the raw request path back and bypass every route-level
    // header (V4A-05 — a capability URL is a bearer secret, so the path is
    // never echoed and never logged).
    frameworkErrors: (error, _request, reply) => {
      // The Fastify typed reply pipeline collapses for this hook and
      // `reply.header()` only buffers into the reply map (flushed by
      // `send()`), so the framework-level error response is written directly:
      // fixed status, the FIXED security-header set, zero body — the raw
      // request path (a potential capability URL) is never echoed back and
      // never logged (V4A-05).
      const candidate = (error as { statusCode?: unknown }).statusCode;
      reply.raw.statusCode = typeof candidate === 'number' && candidate >= 400 ? candidate : 400;
      reply.raw.setHeader('content-length', '0');
      for (const [name, value] of Object.entries(deliverySecurityHeaders())) {
        reply.raw.setHeader(name, value);
      }
      reply.raw.end();
    },
    // Graceful drain contract: never force-close ACTIVE delivery streams on
    // close. Fastify 5 defaults forceCloseConnections to 'idle', which (with
    // no serverFactory) falls through to closeAllConnections() and would
    // destroy in-flight downloads mid-stream. With `false`, `close()` waits
    // for active requests to finish naturally; the host.close() below first
    // closes only IDLE keep-alive connections so a drain is bounded by the
    // shutdown timeout instead of hanging on idle sockets.
    forceCloseConnections: options.forceCloseConnections ?? false,
  });
  registerDeliveryRoutes(app, {
    expectedAudience: options.audienceOrigin ?? (() => originValue),
    capabilitySecret,
    objectStore,
    resolveGeneration: options.resolveGeneration,
    singlePutMaxBytes: options.config.singlePutMaxBytes,
    clock: options.clock,
    upstreamTimeoutMs: options.upstreamTimeoutMs,
    requestLog,
    requestLimiter,
  });

  // Fixed readiness probe (never capability material): a stable 200 the
  // orchestrator/tests poll once the host is listening. Only registered when
  // the composition explicitly opts in, so existing callers are unchanged.
  if (options.readinessPath !== undefined) {
    assertValidDeliveryReadinessPath(options.readinessPath);
    app.get(options.readinessPath, async (_request, reply) => {
      return reply.code(200).type('text/plain').send('ok');
    });
  }

  const host: DeliveryHost = {
    requestLog,
    get boundOrigin() {
      return boundOriginValue;
    },
    get origin() {
      return originValue;
    },
    async start() {
      await app.listen({ host: hostname, port });
      const address = app.server.address() as AddressInfo;
      boundOriginValue = `http://${hostname}:${address.port}`;
      if (options.audienceOrigin === undefined) {
        originValue = boundOriginValue;
      }
      return originValue;
    },
    async close() {
      // Close idle keep-alive connections first (Node 18.2+); ACTIVE delivery
      // streams stay open so `close()` below can wait for them to finish
      // naturally (bounded by the caller's shutdown timeout).
      app.server.closeIdleConnections?.();
      await app.close();
      await ownedStore?.close?.();
      // Only the default in-memory limiter is owned here; an injected shared
      // adapter is closed by its composing process.
      await ownedLimiter?.close();
    },
  };
  return host;
}

/**
 * Validates an opt-in readiness probe path: a single-segment-style absolute
 * path (no query/fragment, no capability-route shadowing). Rejects malformed
 * paths fail-closed BEFORE any route registration.
 */
export function assertValidDeliveryReadinessPath(path: string): void {
  if (typeof path !== 'string' || path.length === 0 || path.length > 128 || !path.startsWith('/')) {
    throw new Error('delivery_readiness_path_invalid');
  }
  if (!/^[A-Za-z0-9._~/-]+$/u.test(path)) {
    throw new Error('delivery_readiness_path_invalid');
  }
  if (path.includes('?') || path.includes('#')) {
    throw new Error('delivery_readiness_path_invalid');
  }
  if (path === '/d' || path.startsWith('/d/')) {
    throw new Error('delivery_readiness_path_must_not_shadow_capability_route');
  }
}

/**
 * Full production composition: resolves the R2 RO credential and the I10
 * capability HMAC secret from their refs, composes the RO-only object store,
 * and starts the session-free, R2-RO, DB-read-only delivery host. Fails
 * closed if any required secret cannot be resolved.
 */
export async function composeProductionDeliveryHost(
  options: DeliveryHostCompositionOptions,
): Promise<DeliveryHost> {
  if (options.resolveSecret === undefined) throw new Error('delivery_composition_secret_resolver_required');
  // Production binds the capability audience to the configured https origin
  // (the externally-reachable delivery origin), never to the local bind.
  return composeDeliveryHost({
    ...options,
    audienceOrigin: options.audienceOrigin ?? options.config.isolatedDeliveryOrigin,
  });
}
