import type { VersionedEventEnvelope } from './envelope.js';

export type OutboxHandlerMode = 'projection_latest_only' | 'delivery_each_event';

/**
 * Explicit side-effect durability capability for an outbox route.
 * Never inferred from handlerName, class names, or module paths.
 * - durable: handle() commits a durable projection/side effect before returning
 * - transient: in-memory / no-op / harness-only; must not permanently complete events in production
 */
export type SideEffectDurability = 'durable' | 'transient';

export interface OutboxHandlerContext {
  readonly envelope: VersionedEventEnvelope;
  readonly idempotencyKey: string;
  readonly signal: AbortSignal;
  /** Current claim ownership fence. Durable handlers must bind their final write to it. */
  readonly attempt?: {
    readonly outboxId: string;
    readonly leaseGeneration: string;
  };
}

export interface OutboxRoute {
  readonly handlerName: string;
  readonly handlerMode: OutboxHandlerMode;
  readonly eventType: string;
  readonly eventVersion: number;
  /**
   * Explicit durability of the side effect performed by handle().
   * Production composition and the worker refuse permanent completion for transient routes
   * unless a harness explicitly opts in.
   */
  readonly sideEffectDurability: SideEffectDurability;
  /** Static, low-cardinality route class used for readiness and metrics. */
  readonly routeClass?: 'projection' | 'publication_cache_purge' | 'report_public_surface_purge';
  /** Invoked only after the claim transaction commits; external I/O never holds repository locks. */
  handle(context: OutboxHandlerContext): Promise<void>;
}

export type OutboxDeliveryFailureKind = 'retryable' | 'permanent';

/** Explicit handler failure classification consumed by the generic worker. */
export class OutboxDeliveryError extends Error {
  constructor(
    readonly failureKind: OutboxDeliveryFailureKind,
    message: string,
    options: { readonly cause?: unknown } = {},
  ) {
    super(message, options);
    this.name = 'OutboxDeliveryError';
  }
}

/**
 * Normal outbox control flow: the handler finished a bounded slice and asks the worker
 * to release the lease back to pending without treating delivery as failed.
 * Not an OutboxDeliveryError — does not call fail(), is not subject to maxAttempts,
 * and must not write last_error.
 */
export class OutboxContinuationRequested extends Error {
  constructor(message = 'outbox continuation requested') {
    super(message);
    this.name = 'OutboxContinuationRequested';
  }
}

export interface RoutableOutboxDelivery {
  readonly handlerName: string;
  readonly handlerMode: OutboxHandlerMode;
  readonly eventType: string;
  readonly eventVersion: number;
}

/**
 * Honest publication cache purge readiness classification.
 * The outbox worker overlays the actual provider state onto the route-level default, so a
 * test-mode no-op purge provider ('stubbed') is never reported as durable.
 */
export type PublicationCachePurgeReadinessState = 'durable' | 'stubbed' | 'missing';

export interface PublicationCachePurgeReadiness {
  readonly configured: boolean;
  readonly routeCount: number;
  readonly durableCount: number;
  readonly allDurable: boolean;
  /**
   * Durability classification of the publication cache purge pipeline. At this route-level
   * inspection it is the route-declared default ('missing' with no routes, else 'durable');
   * the outbox worker overlays the actual provider state so the honest value is reported.
   */
  readonly state: PublicationCachePurgeReadinessState;
}

export interface OutboxRouteDurabilityInspection {
  readonly routeCount: number;
  readonly durableCount: number;
  readonly transientCount: number;
  readonly allDurable: boolean;
  readonly publicationCachePurge: PublicationCachePurgeReadiness;
  readonly reportPublicSurfacePurge: PublicationCachePurgeReadiness;
}

export class UnknownOutboxRouteError extends Error {
  constructor(delivery: RoutableOutboxDelivery) {
    super(`unknown outbox route: ${delivery.handlerName}/${delivery.eventType}@${delivery.eventVersion}`);
    this.name = 'UnknownOutboxRouteError';
  }
}

/** Thrown when production composition wires a transient projection side effect. */
export class TransientProjectionCompositionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransientProjectionCompositionError';
  }
}

/**
 * Thrown when a worker would permanently complete an outbox row after a transient side effect.
 * Becomes a retryable/dead-letter failure so the event remains available for replay.
 */
export class TransientSideEffectCompletionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransientSideEffectCompletionError';
  }
}

export function inspectOutboxRouteDurability(
  routes: Iterable<Pick<OutboxRoute, 'sideEffectDurability' | 'routeClass'>>,
): OutboxRouteDurabilityInspection {
  let routeCount = 0;
  let durableCount = 0;
  let transientCount = 0;
  let publicationCachePurgeRouteCount = 0;
  let publicationCachePurgeDurableCount = 0;
  let reportPublicSurfacePurgeRouteCount = 0;
  let reportPublicSurfacePurgeDurableCount = 0;
  for (const route of routes) {
    routeCount += 1;
    if (route.sideEffectDurability === 'durable') durableCount += 1;
    else transientCount += 1;
    if (route.routeClass === 'publication_cache_purge') {
      publicationCachePurgeRouteCount += 1;
      if (route.sideEffectDurability === 'durable') publicationCachePurgeDurableCount += 1;
    }
    if (route.routeClass === 'report_public_surface_purge') {
      reportPublicSurfacePurgeRouteCount += 1;
      if (route.sideEffectDurability === 'durable') reportPublicSurfacePurgeDurableCount += 1;
    }
  }
  return Object.freeze({
    routeCount,
    durableCount,
    transientCount,
    allDurable: transientCount === 0,
    publicationCachePurge: Object.freeze({
      configured: publicationCachePurgeRouteCount > 0,
      routeCount: publicationCachePurgeRouteCount,
      durableCount: publicationCachePurgeDurableCount,
      allDurable: publicationCachePurgeRouteCount > 0
        && publicationCachePurgeDurableCount === publicationCachePurgeRouteCount,
      // Route-level default; the outbox worker overlays the actual provider state.
      state: publicationCachePurgeRouteCount === 0 ? 'missing' : 'durable',
    }),
    reportPublicSurfacePurge: Object.freeze({
      configured: reportPublicSurfacePurgeRouteCount > 0,
      routeCount: reportPublicSurfacePurgeRouteCount,
      durableCount: reportPublicSurfacePurgeDurableCount,
      allDurable: reportPublicSurfacePurgeRouteCount > 0
        && reportPublicSurfacePurgeDurableCount === reportPublicSurfacePurgeRouteCount,
      state: reportPublicSurfacePurgeRouteCount === 0 ? 'missing' : 'durable',
    }),
  });
}

/**
 * Production composition guard: refuse any transient projection/side-effect routes.
 * Call at worker bootstrap before start() so miswired memory sinks fail closed.
 */
export function assertProductionOutboxRouteDurability(
  routes: Iterable<Pick<OutboxRoute, 'sideEffectDurability'>>,
): OutboxRouteDurabilityInspection {
  const inspection = inspectOutboxRouteDurability(routes);
  if (inspection.transientCount > 0) {
    throw new TransientProjectionCompositionError(
      `production worker refuses ${inspection.transientCount} transient outbox side-effect route(s); `
      + 'wire a durable projection sink (sideEffectDurability: "durable") before starting. '
      + 'In-memory/no-op sinks permanently complete events without a durable write.',
    );
  }
  return inspection;
}

export class OutboxRouter {
  private readonly routes: ReadonlyMap<string, OutboxRoute>;

  constructor(routes: readonly OutboxRoute[]) {
    const index = new Map<string, OutboxRoute>();
    for (const route of routes) {
      if (route.sideEffectDurability !== 'durable' && route.sideEffectDurability !== 'transient') {
        throw new TypeError(
          `outbox route ${route.handlerName}/${route.eventType}@${route.eventVersion} `
          + 'must declare sideEffectDurability as "durable" or "transient"',
        );
      }
      const key = this.key(route.handlerName, route.eventType, route.eventVersion);
      if (index.has(key)) throw new TypeError(`duplicate outbox route: ${key}`);
      index.set(key, Object.freeze({ ...route }));
    }
    this.routes = index;
  }

  resolve(delivery: RoutableOutboxDelivery): OutboxRoute {
    const route = this.routes.get(
      this.key(delivery.handlerName, delivery.eventType, delivery.eventVersion),
    );
    if (!route || route.handlerMode !== delivery.handlerMode) {
      throw new UnknownOutboxRouteError(delivery);
    }
    return route;
  }

  /** Returns whether at least one statically configured route is available. */
  get isEmpty(): boolean {
    return this.routes.size === 0;
  }

  /** Snapshot of configured routes for durability inspection / readiness telemetry. */
  listRoutes(): readonly OutboxRoute[] {
    return Object.freeze([...this.routes.values()]);
  }

  durabilityInspection(): OutboxRouteDurabilityInspection {
    return inspectOutboxRouteDurability(this.routes.values());
  }

  private key(handlerName: string, eventType: string, eventVersion: number): string {
    return `${handlerName}\u0000${eventType}\u0000${eventVersion}`;
  }
}
