import type { AppConfig } from './config.js';
import type { DatabaseRuntime } from '../infrastructure/database/index.js';
import { createHardenedEgressFetch } from '../infrastructure/egress/index.js';
import type { Metrics } from '../infrastructure/telemetry/index.js';
import {
  createPostgresPublicationPublicProfileHandleResolver,
  createPublicationCachePurgeRoutes,
  createNoopPublicationCachePurgeProvider,
  FetchPublicationCachePurgeProvider,
  type IndexNowPublisher,
  type OutboxRoute,
  type PublicationCachePurgeProvider,
} from '../infrastructure/outbox/index.js';
import { isCanonicalPublicProfileHandle } from '../modules/identity/index.js';

export function resolvePublicationCachePurgeProvider(
  config: AppConfig,
  injected?: PublicationCachePurgeProvider,
): PublicationCachePurgeProvider | undefined {
  if (injected) return injected;
  const configured = config.publication.cachePurge;
  if (configured) return new FetchPublicationCachePurgeProvider({
    endpoint: configured.endpoint,
    ...(configured.bearerToken ? { bearerToken: configured.bearerToken } : {}),
    fetch: createHardenedEgressFetch({ label: 'publication cache purge' }),
  });
  // Test stacks ack through an explicitly classified no-op; production remains absent.
  return config.nodeEnv === 'test' ? createNoopPublicationCachePurgeProvider() : undefined;
}

/** Wires all targets onto the existing publication.cache_purge.requested routes. */
export function composePublicationCachePurgeRoutes(input: {
  readonly provider: PublicationCachePurgeProvider | undefined;
  readonly config: AppConfig;
  readonly database: DatabaseRuntime | undefined;
  readonly handlerTimeoutMs: number;
  readonly metrics: Metrics;
  readonly indexNowPublisher?: IndexNowPublisher;
}): readonly OutboxRoute[] {
  if (input.provider === undefined) return Object.freeze([]);
  return createPublicationCachePurgeRoutes({
    provider: input.provider,
    publicationOrigin: input.config.publication.origin,
    productOrigin: input.config.productOrigin,
    timeoutMs: input.config.publication.cachePurge?.timeoutMs
      ?? Math.min(5_000, input.handlerTimeoutMs),
    metrics: input.metrics,
    ...(input.indexNowPublisher === undefined ? {} : {
      indexNowPublisher: input.indexNowPublisher,
    }),
    ...(input.database === undefined ? {} : {
      resolvePublicProfileHandle: createPostgresPublicationPublicProfileHandleResolver(input.database),
      isCanonicalPublicProfileHandle,
    }),
  });
}
