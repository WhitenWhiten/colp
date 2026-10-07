import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../bootstrap/config.js';
import type { ProductSurfaceRateLimitPurpose } from '../infrastructure/rate-limit/index.js';
import type { AppDependencies } from './app-dependencies.js';
import { isPrometheusMetrics, type Metrics } from '../infrastructure/telemetry/index.js';
import {
  isProductSurfaceRateLimiter,
  type ProductAdmissionRateLimiter,
} from './http-security.js';
import { limiterCapabilityFromStates } from './limiter-readiness.js';

export function registerReadyRoutes(
  app: FastifyInstance,
  input: AppDependencies,
  resolved: {
    readonly readiness: NonNullable<AppDependencies['readiness']>;
    readonly security: AppConfig['httpSecurity'];
    readonly cacheReadiness: AppDependencies['cacheReadiness'];
    readonly cacheCapabilityReadiness: AppDependencies['cacheCapabilityReadiness'];
    readonly searchRateLimiter: AppDependencies['searchRateLimiter'];
    readonly exploreDirectoryRateLimiter: AppDependencies['exploreDirectoryRateLimiter'];
    readonly publicActivityRateLimiter: AppDependencies['publicActivityRateLimiter'];
    readonly syncColpRateLimiter: AppDependencies['syncColpRateLimiter'];
    readonly followRateLimiter: AppDependencies['followRateLimiter'];
    readonly collectionFollowRateLimiter: AppDependencies['collectionFollowRateLimiter'];
    readonly feedRateLimiter: AppDependencies['feedRateLimiter'];
    readonly notificationRateLimiter: AppDependencies['notificationRateLimiter'];
    readonly productRouteRateLimiters: readonly {
      readonly purpose: ProductSurfaceRateLimitPurpose;
      readonly limiter: ProductAdmissionRateLimiter | undefined;
    }[];
    readonly effectPageRateLimiter: AppDependencies['effectPageRateLimiter'];
    readonly mcpRateLimiter: AppDependencies['mcpRateLimiter'];
    readonly syncConflictsCapabilityReadiness: AppDependencies['syncConflictsCapabilityReadiness'];
    readonly metrics: Metrics;
  },
): void {
  const {
    readiness,
    security,
    cacheReadiness,
    cacheCapabilityReadiness,
    searchRateLimiter,
    exploreDirectoryRateLimiter,
    publicActivityRateLimiter,
    syncColpRateLimiter,
    followRateLimiter,
    collectionFollowRateLimiter,
    feedRateLimiter,
    notificationRateLimiter,
    productRouteRateLimiters,
    effectPageRateLimiter,
    mcpRateLimiter,
    syncConflictsCapabilityReadiness,
    metrics,
  } = resolved;
  const { config, syncAdmissionPolicy } = input;
  app.get('/health', {
    config: { productTransport: { allowedQuery: [], cacheControl: 'no-store' } },
  }, async () => ({ status: 'ok' }));
  app.get('/metrics', {
    config: { productTransport: { allowedQuery: [], cacheControl: 'no-store' } },
  }, async (_request, reply) => {
    if (!isPrometheusMetrics(metrics)) {
      return reply.code(503).send('metrics exporter unavailable\n');
    }
    return reply
      .type('text/plain; version=0.0.4; charset=utf-8')
      .send(metrics.renderPrometheus());
  });
  app.get('/ready', {
    config: { productTransport: { allowedQuery: [], cacheControl: 'no-store' } },
  }, async (_request, reply) => {
    try {
      await readiness.verifyReady();
      // T10: the cache only fails the main readiness when KNOWN_CACHE_REQUIRED
      // is true and the cache is not healthy. In every other case the cache
      // state never affects the main probe (and never liveness).
      if (cacheReadiness !== undefined && config.cache.redis.required) {
        const cacheState = await cacheReadiness();
        if (cacheState !== 'healthy') {
          app.log.warn({ cache: cacheState }, 'required cache readiness probe failed');
          return reply.code(503).send({ status: 'not-ready' });
        }
      }
      // FIX-M-006 / SEC-T-04: readiness still requires the explicit
      // TRUSTED_INGRESS declaration in production. Hop-count is not a green
      // production condition (loadHttpSecurity already refuses hops>0).
      if (config.nodeEnv === 'production' && !security.trustedIngressDeclared) {
        app.log.warn('readiness: production requires the explicit TRUSTED_INGRESS declaration');
        return reply.code(503).send({ status: 'not-ready' });
      }
      // FIX-M-006: readiness also verifies the shared Search rate-limit
      // store when the shared adapter is configured (Redis outage fails the
      // probe; the in-memory adapter is always healthy).
      if (security.searchRateLimit.shared.enabled && searchRateLimiter !== undefined) {
        const searchState = searchRateLimiter.readiness();
        if (searchState.status !== 'healthy') {
          app.log.warn({ searchRateLimit: searchState.reason }, 'shared search rate-limit readiness probe failed');
          return reply.code(503).send({ status: 'not-ready' });
        }
      }
      if (config.exploreDirectoryRateLimit.shared.enabled && exploreDirectoryRateLimiter !== undefined) {
        const exploreState = exploreDirectoryRateLimiter.readiness();
        if (exploreState.status !== 'healthy') {
          app.log.warn({ exploreDirectoryRateLimit: exploreState.reason }, 'shared explore/directory rate-limit readiness probe failed');
          return reply.code(503).send({ status: 'not-ready' });
        }
      }
      if (config.publicActivityRateLimit.shared.enabled && publicActivityRateLimiter !== undefined) {
        const activityState = publicActivityRateLimiter.readiness();
        if (activityState.status !== 'healthy') {
          app.log.warn({ publicActivityRateLimit: activityState.reason }, 'shared public Activity rate-limit readiness probe failed');
          return reply.code(503).send({ status: 'not-ready' });
        }
      }
      if (config.syncSession && config.syncRateLimit.shared.enabled
          && syncColpRateLimiter !== undefined) {
        const syncState = syncColpRateLimiter.readiness();
        if (syncState.status !== 'healthy') {
          app.log.warn({ syncRateLimit: syncState.reason }, 'shared sync COLP rate-limit readiness probe failed');
          return reply.code(503).send({ status: 'not-ready' });
        }
      }
      if (config.syncSession && config.syncRateLimit.shared.enabled
          && syncAdmissionPolicy !== undefined) {
        const admissionState = syncAdmissionPolicy.readiness();
        if (admissionState.status !== 'healthy') {
          app.log.warn({ syncAdmission: admissionState.reason }, 'shared sync admission readiness probe failed');
          return reply.code(503).send({ status: 'not-ready' });
        }
      }
      if (config.follow?.rateLimitShared.enabled && followRateLimiter !== undefined
          && isProductSurfaceRateLimiter(followRateLimiter)) {
        const followState = followRateLimiter.readiness();
        if (followState.status !== 'healthy') {
          app.log.warn({ followRateLimit: followState.reason }, 'shared follow rate-limit readiness probe failed');
          return reply.code(503).send({ status: 'not-ready' });
        }
      }
      if (config.collectionFollow.rateLimitShared.enabled && collectionFollowRateLimiter !== undefined
          && isProductSurfaceRateLimiter(collectionFollowRateLimiter)) {
        const collectionFollowState = collectionFollowRateLimiter.readiness();
        if (collectionFollowState.status !== 'healthy') {
          app.log.warn({ collectionFollowRateLimit: collectionFollowState.reason },
            'shared collection-follow rate-limit readiness probe failed');
          return reply.code(503).send({ status: 'not-ready' });
        }
      }
      if (config.feed?.rateLimitShared.enabled && feedRateLimiter !== undefined
          && isProductSurfaceRateLimiter(feedRateLimiter)) {
        const feedState = feedRateLimiter.readiness();
        if (feedState.status !== 'healthy') {
          app.log.warn({ feedRateLimit: feedState.reason }, 'shared feed rate-limit readiness probe failed');
          return reply.code(503).send({ status: 'not-ready' });
        }
      }
      if (config.notifications?.rateLimitShared.enabled && notificationRateLimiter !== undefined
          && isProductSurfaceRateLimiter(notificationRateLimiter)) {
        const notificationState = notificationRateLimiter.readiness();
        if (notificationState.status !== 'healthy') {
          app.log.warn({ notificationRateLimit: notificationState.reason }, 'shared notification rate-limit readiness probe failed');
          return reply.code(503).send({ status: 'not-ready' });
        }
      }
      if (config.productRouteRateLimitShared.enabled) {
        for (const { purpose, limiter } of productRouteRateLimiters) {
          if (limiter === undefined || !isProductSurfaceRateLimiter(limiter)) {
            app.log.warn({ productRouteRateLimit: purpose },
              'shared product-route rate-limit adapter is missing');
            return reply.code(503).send({ status: 'not-ready' });
          }
          const state = limiter.readiness();
          if (state.status !== 'healthy') {
            app.log.warn({ productRouteRateLimit: purpose, reason: state.reason },
              'shared product-route rate-limit readiness probe failed');
            return reply.code(503).send({ status: 'not-ready' });
          }
        }
      }
      if (config.syncEffectPageRateLimit.shared.enabled && effectPageRateLimiter !== undefined) {
        const effectPageState = effectPageRateLimiter.readiness();
        if (effectPageState.status !== 'healthy') {
          app.log.warn({ effectPageRateLimit: effectPageState.reason }, 'shared effect-page rate-limit readiness probe failed');
          return reply.code(503).send({ status: 'not-ready' });
        }
      }
      // FIX-M-018: readiness also verifies the shared MCP rate-limit store
      // when the shared adapter is configured (Redis outage fails the probe;
      // the in-memory adapter is always healthy).
      if (config.mcpRateLimit.enabled && mcpRateLimiter !== undefined) {
        const mcpState = mcpRateLimiter.readiness();
        if (mcpState.status !== 'healthy') {
          app.log.warn({ mcpRateLimit: mcpState.reason }, 'shared MCP rate-limit readiness probe failed');
          return reply.code(503).send({ status: 'not-ready' });
        }
      }
      return reply.send({ status: 'ready' });
    } catch (error: unknown) {
      app.log.warn({ err: error }, 'readiness probe failed');
      return reply.code(503).send({ status: 'not-ready' });
    }
  });
  app.get('/ready/features/limiter', {
    config: { productTransport: { allowedQuery: [], cacheControl: 'no-store' } },
  }, async (_request, reply) => {
    let sharedEnabled = false;
    let unhealthy = false;
    const mark = (enabled: boolean, ready?: { status: string }): void => {
      if (!enabled) return;
      sharedEnabled = true;
      if (ready === undefined || ready.status !== 'healthy') unhealthy = true;
    };
    mark(security.searchRateLimit.shared.enabled, searchRateLimiter?.readiness());
    mark(config.exploreDirectoryRateLimit.shared.enabled, exploreDirectoryRateLimiter?.readiness());
    mark(config.publicActivityRateLimit.shared.enabled, publicActivityRateLimiter?.readiness());
    mark(
      Boolean(config.syncSession && config.syncRateLimit.shared.enabled),
      syncColpRateLimiter?.readiness(),
    );
    mark(
      Boolean(config.syncSession && config.syncRateLimit.shared.enabled),
      syncAdmissionPolicy?.readiness(),
    );
    if (config.follow?.rateLimitShared.enabled && followRateLimiter !== undefined
        && isProductSurfaceRateLimiter(followRateLimiter)) {
      mark(true, followRateLimiter.readiness());
    } else if (config.follow?.rateLimitShared.enabled) {
      mark(true);
    }
    if (config.collectionFollow.rateLimitShared.enabled
        && collectionFollowRateLimiter !== undefined
        && isProductSurfaceRateLimiter(collectionFollowRateLimiter)) {
      mark(true, collectionFollowRateLimiter.readiness());
    } else if (config.collectionFollow.rateLimitShared.enabled) {
      mark(true);
    }
    if (config.feed?.rateLimitShared.enabled && feedRateLimiter !== undefined
        && isProductSurfaceRateLimiter(feedRateLimiter)) {
      mark(true, feedRateLimiter.readiness());
    } else if (config.feed?.rateLimitShared.enabled) {
      mark(true);
    }
    if (config.notifications?.rateLimitShared.enabled
        && notificationRateLimiter !== undefined
        && isProductSurfaceRateLimiter(notificationRateLimiter)) {
      mark(true, notificationRateLimiter.readiness());
    } else if (config.notifications?.rateLimitShared.enabled) {
      mark(true);
    }
    if (config.productRouteRateLimitShared.enabled) {
      for (const { limiter } of productRouteRateLimiters) {
        if (limiter === undefined || !isProductSurfaceRateLimiter(limiter)) {
          mark(true);
        } else {
          mark(true, limiter.readiness());
        }
      }
    }
    mark(config.syncEffectPageRateLimit.shared.enabled, effectPageRateLimiter?.readiness());
    mark(config.mcpRateLimit.enabled, mcpRateLimiter?.readiness());
    const result = limiterCapabilityFromStates(sharedEnabled, unhealthy);
    return reply.code(result.status === 'ready' ? 200 : 503).send(result);
  });
  if (cacheCapabilityReadiness) {
    app.get('/ready/features/cache', {
      config: { productTransport: { allowedQuery: [], cacheControl: 'no-store' } },
    }, async (_request, reply) => {
      const result = await cacheCapabilityReadiness().catch(() => ({
        capability: 'cache' as const, status: 'not-ready' as const,
        reason: 'dependency_unavailable' as const,
      }));
      return reply.code(result.status === 'ready' ? 200 : 503).send(result);
    });
  }
  // Reports is an optional capability, but its readiness surface is stable
  // even when all report flags are off.  Keep the payload deliberately
  // low-cardinality: callers get a capability state and fixed reason codes,
  // never report IDs, slugs, SQL errors, or secrets.
  app.get('/ready/features/reports', {
    config: { productTransport: { allowedQuery: [], cacheControl: 'no-store' } },
  }, async (_request, reply) => {
    return reply.code(200).send({
      capability: 'reports', status: 'disabled', enabled: false,
      reasons: Object.freeze(['disabled']),
    });
  });
  if (syncConflictsCapabilityReadiness) {
    app.get('/ready/features/sync-conflicts', {
      config: { productTransport: { allowedQuery: [], cacheControl: 'no-store' } },
    }, async (_request, reply) => {
      const result = await syncConflictsCapabilityReadiness().catch(() => ({
        capability: 'sync-conflicts' as const, status: 'not-ready' as const,
        reason: 'dependency_unavailable' as const, referencedVersions: Object.freeze([]),
      }));
      return reply.code(result.status === 'ready' ? 200 : 503).send(result);
    });
  }
}
