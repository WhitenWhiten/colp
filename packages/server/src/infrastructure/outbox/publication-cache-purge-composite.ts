/**
 * T09 composite publication cache purge provider (plan §4.4 / §6.4 T09).
 *
 * Composes the Redis epoch invalidator with the existing CDN purge provider so
 * Redis epoch invalidation and CDN purge share one `publication.cache_purge.requested`
 * delivery. Order per purge:
 *
 *   1. rotate the collection epochs ({pub:collectionId} and {pub:publicationSlug},
 *      the latter because T06 slug lookups are scoped by the slug);
 *   2. rotate the global Directory epoch ({publication-directory}) when the
 *      event changes the Directory public representation (decision table below);
 *   3. call the CDN provider with the event-scoped idempotency key when a CDN
 *      provider is configured; an unconfigured CDN is an explicit no-side-effect
 *      success, never an error.
 *
 * Directory rotation decision table (pinned by tests):
 *
 *   sourceEventType      | rotates Directory | rationale
 *   ---------------------|-------------------|------------------------------------------
 *   collection.created   | yes               | new collection may appear in the Directory
 *   collection.updated   | yes               | metadata/slug/visibility/ordering changes
 *   collection.deleted   | yes               | membership removal
 *   node.created         | yes               | nodeCount changes
 *   node.deleted         | yes               | nodeCount changes
 *   node.moved           | yes               | source/target nodeCount changes
 *   node.updated         | no                | content revision only; Directory shows no
 *                          |                  | node content (nodeCount/collection metadata
 *                          |                  | and collection updated_at are unchanged)
 *   annotation.*         | no                | annotations are not part of the Directory
 *   relation.*           | no                | relations are not part of the Directory
 *   V1 (no source fields)| yes               | conservative default: cannot judge, and a
 *                          |                  | stale Directory is worse than an extra miss
 *   unknown event type   | yes               | conservative default, same reasoning
 *
 * Additionally, ANY event whose visibility becomes private/protected rotates the
 * Directory (permission revocation must hide/remove the collection from the
 * public Directory listing).
 *
 * Failure semantics:
 * - The composite succeeds only when both ends succeed or the CDN is explicitly
 *   unconfigured. A retryable failure on either end propagates as a retryable
 *   `PublicationCachePurgeProviderError` so the Outbox route does not ack; a
 *   permanent failure (CDN 4xx, unkeyable scope) keeps the existing
 *   terminal/dead-letter classification.
 * - Redis failure is never swallowed, and a successful Redis rotation never
 *   skips the CDN retry: the whole purge fails, the event is retried, and both
 *   ends re-run safely (Redis INCR again is allowed; CDN sees the same event id).
 * - Metrics: `cache.epoch.rotation_total` (recorded by the invalidator) and
 *   `cache.outbox_invalidation.failure` (one per failed purge). Logs contain
 *   only event version, domain, outcome and duration.
 *
 * The request carries no occurred_at timestamp, so a real invalidation-age
 * observation (`cache.outbox_invalidation_age_ms`) is not produced here; the
 * worker's existing queue-age metric covers delivery lag.
 */
import type { Metrics } from '../telemetry/index.js';
import {
  PublicationCachePurgeProviderError,
  type PublicationCachePurgeProvider,
  type PublicationCachePurgeProviderKind,
  type PublicationCachePurgeRequest,
} from './publication-cache-purge.js';
import { RedisPublicationCacheInvalidator } from './redis-publication-invalidator.js';

/** Structural logger: only fixed low-cardinality bindings are ever emitted. */
export interface PublicationCachePurgeLogger {
  info(bindings: object, message: string): void;
  error(bindings: object, message: string): void;
}

/** The failure counter emitted by the composite for one failed purge delivery. */
export const CACHE_OUTBOX_INVALIDATION_FAILURE_METRIC = 'cache.outbox_invalidation.failure';

/**
 * Explicit Directory rotation mapping for every real Phase 1 source event type.
 * `true` = the event changes the Directory public representation; `false` = a
 * plain content update that must not rotate the global Directory.
 */
export const PUBLICATION_DIRECTORY_ROTATION_BY_SOURCE_EVENT_TYPE: Readonly<Record<string, boolean>> =
  Object.freeze({
    'collection.created': true,
    'collection.updated': true,
    'collection.deleted': true,
    'node.restored': true,
    'node.created': true,
    'node.deleted': true,
    'node.moved': true,
    'node.updated': false,
    'annotation.created': false,
    'annotation.updated': false,
    'annotation.deleted': false,
    'relation.created': false,
    'relation.updated': false,
    'relation.deleted': false,
  });

export type PublicationDirectoryRotationDecisionInput = Pick<
  PublicationCachePurgeRequest,
  'sourceEventType' | 'visibility'
>;

/**
 * Decides whether a purge event must rotate the global Directory epoch.
 * V1 (no source fields) and unknown event types use the conservative default
 * (rotate). Known content-only events rotate only when visibility becomes
 * private/protected (permission revocation always hides the collection).
 */
export function shouldRotatePublicationDirectory(
  input: PublicationDirectoryRotationDecisionInput,
): boolean {
  const sourceEventType = input.sourceEventType;
  if (sourceEventType === null) return true; // V1 conservative default
  const mapped = PUBLICATION_DIRECTORY_ROTATION_BY_SOURCE_EVENT_TYPE[sourceEventType];
  if (mapped === undefined) return true; // unknown event type: conservative default
  if (mapped) return true;
  return input.visibility === 'private' || input.visibility === 'protected';
}

export interface CompositePublicationCachePurgeProviderOptions {
  /** Redis epoch invalidator; its failures are propagated (never swallowed). */
  readonly invalidator: RedisPublicationCacheInvalidator;
  /** Optional CDN provider. Omitted means explicitly unconfigured (no-side-effect success). */
  readonly cdn?: PublicationCachePurgeProvider;
  readonly metrics?: Metrics;
  readonly logger?: PublicationCachePurgeLogger;
}

export class CompositePublicationCachePurgeProvider implements PublicationCachePurgeProvider {
  readonly kind: PublicationCachePurgeProviderKind = 'injected';
  /** True when a CDN provider was explicitly wired; used for honest readiness. */
  readonly cdnConfigured: boolean;
  private readonly invalidator: RedisPublicationCacheInvalidator;
  private readonly cdn: PublicationCachePurgeProvider | undefined;
  private readonly metrics: Metrics | undefined;
  private readonly logger: PublicationCachePurgeLogger | undefined;

  constructor(options: CompositePublicationCachePurgeProviderOptions) {
    this.invalidator = options.invalidator;
    this.cdn = options.cdn;
    this.cdnConfigured = options.cdn !== undefined;
    this.metrics = options.metrics;
    this.logger = options.logger;
  }

  async purge(request: PublicationCachePurgeRequest): Promise<void> {
    const started = performance.now();
    let domain: 'publication' | 'publication+directory' = 'publication';
    try {
      await this.invalidator.rotateCollection(request);
      if (shouldRotatePublicationDirectory(request)) {
        domain = 'publication+directory';
        await this.invalidator.rotateDirectory(request.signal);
      }
      if (this.cdn !== undefined) {
        await this.cdn.purge(request);
      }
      this.logger?.info({
        eventVersion: request.eventVersion ?? null,
        domain,
        outcome: 'succeeded',
        durationMs: performance.now() - started,
      }, 'publication cache purge succeeded');
    } catch (error) {
      this.metrics?.increment(CACHE_OUTBOX_INVALIDATION_FAILURE_METRIC, 1);
      const failureKind = error instanceof PublicationCachePurgeProviderError
        ? error.failureKind
        : 'retryable';
      this.logger?.error({
        eventVersion: request.eventVersion ?? null,
        domain,
        outcome: 'failed',
        failureKind,
        durationMs: performance.now() - started,
      }, 'publication cache purge failed');
      if (error instanceof PublicationCachePurgeProviderError) throw error;
      throw new PublicationCachePurgeProviderError(
        'retryable',
        'publication cache purge failed',
        { cause: error },
      );
    }
  }
}

