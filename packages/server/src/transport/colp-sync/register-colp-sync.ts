import type { FastifyInstance } from 'fastify';
import {
  createSyncServerTelemetry,
  syncDurationBucket,
  type SyncTelemetryEndpoint,
  type Metrics,
} from '../../infrastructure/telemetry/index.js';
import { registerSyncSessionRoutes } from './sync-session-routes.js';
import { registerSyncSnapshotRoutes } from './sync-snapshot-routes.js';
import { registerSyncPushRoutes } from './sync-push-routes.js';
import { registerSyncConflictRoutes } from './sync-conflict-routes.js';
import { registerSyncPullRoutes } from './sync-pull-routes.js';
import { registerSyncEffectPageRoutes } from './sync-effect-page-routes.js';
import { registerSyncAckRoutes } from './sync-ack-routes.js';
import { registerSyncRetireRoutes } from './sync-retire-routes.js';
import { registerExtensionCollectionRoutes } from './extension-collection-routes.js';
import { registerSyncFaviconHelperRoutes } from './sync-favicon-helper-routes.js';
import { createSyncTransportSecurity } from './sync-transport-security.js';
import type { SyncAdmissionPolicy } from '../../infrastructure/rate-limit/index.js';
import type { AppDependencies } from '../app.js';

function withAdmission<T extends { readonly admission?: SyncAdmissionPolicy }>(
  routes: T,
  admission: SyncAdmissionPolicy | undefined,
): T {
  if (admission === undefined || routes.admission !== undefined) return routes;
  return { ...routes, admission };
}

export function installSyncTelemetry(
  app: FastifyInstance,
  metrics: Metrics,
  routes: Pick<AppDependencies, 'syncSessionRoutes' | 'syncSnapshotRoutes' | 'syncPushRoutes'
    | 'syncConflictRoutes' | 'syncPullRoutes' | 'syncAckRoutes' | 'syncRetireRoutes'>,
): void {
  const telemetry = createSyncServerTelemetry({ metrics, logger: app.log });
  const started = new WeakMap<object, number>();
  app.addHook('onRequest', async (request) => {
    if (syncTelemetryEndpoint(request.url, routes) !== undefined) started.set(request, performance.now());
  });
  app.addHook('onResponse', async (request, reply) => {
    const endpoint = syncTelemetryEndpoint(request.url, routes);
    const start = started.get(request);
    if (endpoint === undefined || start === undefined) return;
    const durationMs = Math.max(0, performance.now() - start);
    const status = reply.statusCode;
    const outcome = request.raw.aborted ? 'abort'
      : status === 408 ? 'timeout'
        : status >= 500 ? 'internal'
          : status >= 400 ? 'problem' : 'success';
    const problem = status === 401 ? 'authentication_required'
      : status === 403 ? 'authorization_denied'
        : status === 429 ? 'rate_limited'
          : status >= 500 ? 'internal_error' : 'none';
    telemetry.record({ endpoint, outcome, problem, bucket: syncDurationBucket(durationMs), durationMs });
  });
}

function syncTelemetryEndpoint(
  rawUrl: string,
  routes: Pick<AppDependencies, 'syncSessionRoutes' | 'syncSnapshotRoutes' | 'syncPushRoutes'
    | 'syncConflictRoutes' | 'syncPullRoutes' | 'syncAckRoutes' | 'syncRetireRoutes'>,
): SyncTelemetryEndpoint | undefined {
  const path = rawUrl.split('?', 1)[0] ?? '';
  if (routes.syncSessionRoutes && path === '/.well-known/collection-protocol') return 'manifest';
  if (path === routes.syncSessionRoutes?.path) return 'session';
  if (path === routes.syncSnapshotRoutes?.path) return 'snapshot';
  if (path === routes.syncPushRoutes?.path) return 'push';
  if (routes.syncConflictRoutes && matchesConflictPath(routes.syncConflictRoutes.pathTemplate, path)) return 'conflict';
  if (path === routes.syncPullRoutes?.path) return 'pull';
  if (path === routes.syncAckRoutes?.path) return 'ack';
  if (path === routes.syncRetireRoutes?.path) return 'retire';
  return undefined;
}

export function matchesConflictPath(template: string, requestPath: string): boolean {
  const [prefix, suffix] = template.split('{conflictId}');
  return prefix !== undefined && suffix !== undefined && requestPath.startsWith(prefix)
    && requestPath.endsWith(suffix) && requestPath.length > prefix.length + suffix.length;
}

export function matchesEffectPagePath(template: string, requestPath: string): boolean {
  const expression = template.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
    .replace('\\{effectId\\}', '[A-Za-z0-9._~-]+')
    .replace('\\{pageNumber\\}', '[1-9][0-9]*');
  return new RegExp(`^${expression}$`, 'u').test(requestPath);
}

export function registerColpSync(app: FastifyInstance, deps: AppDependencies): void {
  const {
    config,
    syncColpRateLimiter,
    followRateLimiter,
    collectionFollowRateLimiter,
    feedRateLimiter,
    notificationRateLimiter,
    effectPageRateLimiter,
    syncAdmissionPolicy,
    syncSessionRoutes,
    syncSnapshotRoutes,
    syncPushRoutes,
    syncConflictRoutes,
    syncPullRoutes,
    syncEffectPageRoutes,
    syncAckRoutes,
    syncRetireRoutes,
    extensionCollectionRoutes,
  } = deps;
  if ((config.syncSession || extensionCollectionRoutes) && config.syncRateLimit.shared.enabled && syncColpRateLimiter === undefined) {
    throw new Error(
      'buildApiApp requires an injected syncColpRateLimiter when SYNC_RATE_LIMIT_SHARED=true (production composition must inject the Redis adapter)',
    );
  }
  if ((config.syncSession || extensionCollectionRoutes) && config.syncRateLimit.shared.enabled && syncAdmissionPolicy === undefined) {
    throw new Error(
      'buildApiApp requires an injected syncAdmissionPolicy when SYNC_RATE_LIMIT_SHARED=true (production composition must inject the Redis adapter)',
    );
  }
  if (config.follow?.rateLimitShared.enabled && followRateLimiter === undefined) {
    throw new Error(
      'buildApiApp requires an injected followRateLimiter when FOLLOW_RATE_LIMIT_SHARED=true (production composition must inject the Redis adapter)',
    );
  }
  if (config.collectionFollow.rateLimitShared.enabled && collectionFollowRateLimiter === undefined) {
    throw new Error(
      'buildApiApp requires an injected collectionFollowRateLimiter when COLLECTION_FOLLOW_RATE_LIMIT_SHARED=true (production composition must inject the Redis adapter)',
    );
  }
  if (config.feed?.rateLimitShared.enabled && feedRateLimiter === undefined) {
    throw new Error(
      'buildApiApp requires an injected feedRateLimiter when FEED_RATE_LIMIT_SHARED=true (production composition must inject the Redis adapter)',
    );
  }
  if (config.notifications?.rateLimitShared.enabled && notificationRateLimiter === undefined) {
    throw new Error(
      'buildApiApp requires an injected notificationRateLimiter when NOTIFICATION_RATE_LIMIT_SHARED=true (production composition must inject the Redis adapter)',
    );
  }
  if (config.syncEffectPageRateLimit.shared.enabled
      && (config.syncSession !== undefined || syncEffectPageRoutes !== undefined)
      && effectPageRateLimiter === undefined
      && syncEffectPageRoutes?.rateLimiter === undefined) {
    throw new Error(
      'buildApiApp requires an injected effectPageRateLimiter when SYNC_EFFECT_PAGE_RATE_LIMIT_SHARED=true (production composition must inject the Redis adapter)',
    );
  }
  if ((config.syncSession === undefined) !== (syncSessionRoutes === undefined)) {
    throw new TypeError('Sync Session config and route dependencies must be enabled together');
  }
  if (config.syncSession && syncSessionRoutes
      && (config.syncSession.path !== syncSessionRoutes.path
        || config.syncSession.allowedOrigins.join('\0') !== syncSessionRoutes.allowedOrigins.join('\0'))) {
    throw new TypeError('Sync Session route dependencies must match the advertised configuration');
  }
  if (syncSessionRoutes) registerSyncSessionRoutes(app, withAdmission(syncSessionRoutes, syncAdmissionPolicy));
  if ((config.syncSession === undefined) !== (syncSnapshotRoutes === undefined)) {
    throw new TypeError('Sync Snapshot config and route dependencies must be enabled together');
  }
  if (config.syncSession && syncSnapshotRoutes
      && (config.syncSession.snapshot.path !== syncSnapshotRoutes.path
        || config.syncSession.allowedOrigins.join('\0') !== syncSnapshotRoutes.allowedOrigins.join('\0'))) {
    throw new TypeError('Sync Snapshot route dependencies must match the advertised configuration');
  }
  if (syncSnapshotRoutes) registerSyncSnapshotRoutes(app, withAdmission(syncSnapshotRoutes, syncAdmissionPolicy));
  if ((config.syncSession === undefined) !== (syncPushRoutes === undefined)) {
    throw new TypeError('Sync Push config and route dependencies must be enabled together');
  }
  if (config.syncSession && syncPushRoutes
      && (config.syncSession.push.path !== syncPushRoutes.path
        || config.syncSession.push.maxBatchOperations !== syncPushRoutes.maxBatchOperations
        || config.syncSession.allowedOrigins.join('\0') !== syncPushRoutes.allowedOrigins.join('\0'))) {
    throw new TypeError('Sync Push route dependencies must match the advertised configuration');
  }
  if (syncPushRoutes) registerSyncPushRoutes(app, withAdmission(syncPushRoutes, syncAdmissionPolicy));
  if ((config.syncSession === undefined) !== (syncConflictRoutes === undefined)) {
    throw new TypeError('Sync Conflict config and route dependencies must be enabled together');
  }
  if (config.syncSession && syncConflictRoutes
      && (config.syncSession.conflict.path !== syncConflictRoutes.pathTemplate
        || config.syncSession.allowedOrigins.join('\0') !== syncConflictRoutes.allowedOrigins.join('\0'))) {
    throw new TypeError('Sync Conflict route dependencies must match the advertised configuration');
  }
  if (syncConflictRoutes) registerSyncConflictRoutes(app, withAdmission(syncConflictRoutes, syncAdmissionPolicy));
  if ((config.syncSession === undefined) !== (syncPullRoutes === undefined)) {
    throw new TypeError('Sync Pull config and route dependencies must be enabled together');
  }
  if (config.syncSession && syncPullRoutes
      && (config.syncSession.pull.path !== syncPullRoutes.path
        || config.syncSession.allowedOrigins.join('\0') !== syncPullRoutes.allowedOrigins.join('\0'))) {
    throw new TypeError('Sync Pull route dependencies must match the advertised configuration');
  }
  if (syncPullRoutes) registerSyncPullRoutes(app, withAdmission(syncPullRoutes, syncAdmissionPolicy));
  if (syncEffectPageRoutes) {
    registerSyncEffectPageRoutes(app, {
      ...withAdmission(syncEffectPageRoutes, syncAdmissionPolicy),
      ...(syncEffectPageRoutes.rateLimiter === undefined && effectPageRateLimiter !== undefined
        ? { rateLimiter: effectPageRateLimiter }
        : {}),
    });
  }
  if ((config.syncSession === undefined) !== (syncAckRoutes === undefined)) {
    throw new TypeError('Sync Ack config and route dependencies must be enabled together');
  }
  if (config.syncSession && syncAckRoutes
      && (config.syncSession.ack.path !== syncAckRoutes.path
        || config.syncSession.allowedOrigins.join('\0') !== syncAckRoutes.allowedOrigins.join('\0'))) {
    throw new TypeError('Sync Ack route dependencies must match the advertised configuration');
  }
  if (syncAckRoutes) registerSyncAckRoutes(app, withAdmission(syncAckRoutes, syncAdmissionPolicy));
  if ((config.syncSession === undefined) !== (syncRetireRoutes === undefined)) {
    throw new TypeError('Sync retire config and route dependencies must be enabled together');
  }
  if (config.syncSession && syncRetireRoutes
      && (config.syncSession.retire.path !== syncRetireRoutes.path
        || config.syncSession.allowedOrigins.join('\0') !== syncRetireRoutes.allowedOrigins.join('\0'))) {
    throw new TypeError('Sync retire route dependencies must match the advertised configuration');
  }
  if (syncRetireRoutes) registerSyncRetireRoutes(app, withAdmission(syncRetireRoutes, syncAdmissionPolicy));
  const extensionTransportSecurity = createSyncTransportSecurity({
    allowInsecureLoopback: config.syncSession?.allowInsecureLoopback ?? false,
    trustedIngress: config.httpSecurity.trustedIngress,
  });
  if (extensionCollectionRoutes) registerExtensionCollectionRoutes(app, {
    ...withAdmission(extensionCollectionRoutes, syncAdmissionPolicy),
    transportSecurity: extensionTransportSecurity,
  });
  // FO-04: the four extension favicon helper operations under /colp/v0.1/sync.
  // They reuse the original COLP extension credential authority and are gated
  // by the same KNOWN_FEATURE_FAVICON_POLICY flag as the Product favicon
  // policy/source surface (off => 404). Registered after RegisterProductSurfaces
  // so the shared favicon image body parsers already exist on the app.
  registerSyncFaviconHelperRoutes(app, {
    enabled: config.faviconPolicy.enabled,
    ...(extensionCollectionRoutes ? { extensionCollectionRoutes } : {}),
    ...(deps.identityUnitOfWork ? { identityUnitOfWork: deps.identityUnitOfWork } : {}),
    ...(deps.collectionsUnitOfWork ? { collectionsUnitOfWork: deps.collectionsUnitOfWork } : {}),
    ...(deps.faviconStore ? { faviconStore: deps.faviconStore } : {}),
    productOrigin: config.productOrigin,
    // SYNC-Q-014: never mint a route-local limiter here. Shared mode stays
    // fail-closed (the composition must inject the Redis adapter); without the
    // shared limiter the helper simply runs without local rate limiting, like
    // every other COLP-sync route.
    ...(config.productRouteRateLimitShared.enabled
      ? { rateLimiter: deps.faviconPolicyRateLimiter ?? failMissingSharedFaviconLimit() }
      : deps.faviconPolicyRateLimiter === undefined
        ? {}
        : { rateLimiter: deps.faviconPolicyRateLimiter }),
    timeoutMs: config.faviconPolicy.timeoutMs,
    ...(deps.metrics ? { metrics: deps.metrics } : {}),
    transportSecurity: extensionTransportSecurity,
  });
}

function failMissingSharedFaviconLimit(): never {
  throw new Error(
    'buildApiApp requires an injected faviconPolicyRateLimiter when PRODUCT_ROUTE_RATE_LIMIT_SHARED=true (production composition must inject the Redis adapter)',
  );
}
