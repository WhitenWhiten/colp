import { createHash } from 'node:crypto';
import { observeBestEffort } from '../async/best-effort.js';
import { createHardenedEgressFetch, HardenedEgressError } from '../egress/index.js';
import type { Metrics } from '../telemetry/index.js';
import type { DatabaseRuntime } from '../database/index.js';
import { readBackendPid, withPostgresAbort } from '../database/index.js';
import {
  defineClosedPayloadValidator,
  type EventPayloadRegistration,
  type PayloadValidator,
} from './envelope.js';
import {
  OutboxDeliveryError,
  type OutboxHandlerContext,
  type OutboxRoute,
} from './router.js';
import type { IndexNowPublisher } from './indexnow.js';

export const PUBLICATION_CACHE_PURGE_EVENT_TYPE = 'publication.cache_purge.requested';
export const PUBLICATION_CACHE_PURGE_EVENT_VERSION_N_MINUS_1 = 1 as const;
export const PUBLICATION_CACHE_PURGE_EVENT_VERSION = 2 as const;
export const PUBLICATION_CACHE_PURGE_HANDLER_NAME = 'publication_cache_purge';

const nonEmptyString = (value: unknown): boolean =>
  typeof value === 'string' && value.length > 0;
const positiveInt = (value: unknown): boolean =>
  typeof value === 'number' && Number.isInteger(value) && value > 0;
const publicationVisibility = (value: unknown): boolean =>
  value === 'private' || value === 'protected' || value === 'public' || value === 'unlisted';

export const validatePublicationCachePurgeV1: PayloadValidator = defineClosedPayloadValidator({
  collectionId: nonEmptyString,
  publicationSlug: nonEmptyString,
});

export const validatePublicationCachePurgeV2: PayloadValidator = defineClosedPayloadValidator({
  collectionId: nonEmptyString,
  contentRevision: nonEmptyString,
  policyRevision: nonEmptyString,
  publicationSlug: nonEmptyString,
  sourceEventType: nonEmptyString,
  sourceEventVersion: positiveInt,
  visibility: publicationVisibility,
});

export interface PublicationCachePurgeRequest {
  readonly eventId: string;
  readonly idempotencyKey: string;
  readonly collectionId: string;
  readonly publicationSlug: string;
  readonly visibility: 'private' | 'protected' | 'public' | 'unlisted' | null;
  readonly contentRevision: string | null;
  readonly policyRevision: string | null;
  readonly sourceEventType: string | null;
  readonly sourceEventVersion: number | null;
  /**
   * Event version observed by the delivery route. Optional so harnesses that
   * construct requests directly stay valid; populated by requestFromContext.
   * Used only for low-cardinality logging (never for routing or payloads).
   */
  readonly eventVersion?: number;
  readonly urls: readonly string[];
  readonly surrogateKeys: readonly string[];
  readonly signal: AbortSignal;
}

/**
 * How a publication cache purge provider was wired. Used only for honest readiness
 * classification — never for routing decisions.
 * - 'fetch': the generic configured HTTP gateway adapter
 * - 'injected': an explicit provider passed by the caller
 * - 'stub': the test-mode no-op that must never be reported as durable
 * Undefined (absent discriminator) counts as durable for backwards compatibility with
 * injected bare `{ async purge() {} }` providers.
 */
export type PublicationCachePurgeProviderKind = 'fetch' | 'injected' | 'stub';

/** Vendor-neutral CDN boundary. Implementations must honor signal and idempotencyKey. */
export interface PublicationCachePurgeProvider {
  purge(request: PublicationCachePurgeRequest): Promise<void>;
  /** Optional readiness discriminator; undefined/injected/fetch count as durable. */
  readonly kind?: PublicationCachePurgeProviderKind;
}

/** Frozen test-mode no-op purge provider, labeled so readiness never reports it durable. */
export function createNoopPublicationCachePurgeProvider(): PublicationCachePurgeProvider {
  return Object.freeze({ kind: 'stub' as const, async purge() {} });
}

export type PublicationCachePurgeFailureKind = 'retryable' | 'permanent';

export class PublicationCachePurgeProviderError extends Error {
  constructor(
    readonly failureKind: PublicationCachePurgeFailureKind,
    message: string,
    options: { readonly statusCode?: number; readonly cause?: unknown } = {},
  ) {
    super(message, options);
    this.name = 'PublicationCachePurgeProviderError';
    this.statusCode = options.statusCode;
  }

  readonly statusCode: number | undefined;
}

export type PublicationCachePurgeFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

const defaultPublicationCachePurgeFetch: PublicationCachePurgeFetch = createHardenedEgressFetch({
  label: 'publication cache purge',
});

export interface FetchPublicationCachePurgeProviderOptions {
  readonly endpoint: string;
  readonly bearerToken?: string;
  readonly fetch?: PublicationCachePurgeFetch;
}

/** Generic JSON gateway adapter; deployments can put any CDN-specific integration behind it. */
export class FetchPublicationCachePurgeProvider implements PublicationCachePurgeProvider {
  private readonly fetchImplementation: PublicationCachePurgeFetch;
  readonly kind = 'fetch' as const;

  constructor(private readonly options: FetchPublicationCachePurgeProviderOptions) {
    this.fetchImplementation = options.fetch ?? defaultPublicationCachePurgeFetch;
  }

  async purge(request: PublicationCachePurgeRequest): Promise<void> {
    // Own the outbound lifecycle without aborting the caller's signal or other work.
    const controller = new AbortController();
    const abortFromCaller = (): void => controller.abort(request.signal.reason);
    if (request.signal.aborted) abortFromCaller();
    else request.signal.addEventListener('abort', abortFromCaller, { once: true });
    let response: Response | undefined;
    try {
      try {
        controller.signal.throwIfAborted();
        response = await this.fetchImplementation(this.options.endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': request.idempotencyKey,
            ...(this.options.bearerToken
              ? { authorization: `Bearer ${this.options.bearerToken}` }
              : {}),
          },
          body: JSON.stringify({
            collectionId: request.collectionId,
            publicationSlug: request.publicationSlug,
            visibility: request.visibility,
            contentRevision: request.contentRevision,
            policyRevision: request.policyRevision,
            sourceEventType: request.sourceEventType,
            sourceEventVersion: request.sourceEventVersion,
            urls: request.urls,
            surrogateKeys: request.surrogateKeys,
          }),
          signal: controller.signal,
        });
        controller.signal.throwIfAborted();
      } catch (error: unknown) {
        if (error instanceof HardenedEgressError) {
          throw new PublicationCachePurgeProviderError(
            'permanent',
            'publication cache purge target is not allowed',
            { cause: error },
          );
        }
        throw new PublicationCachePurgeProviderError(
          'retryable',
          request.signal.aborted ? 'publication cache purge timed out or was cancelled' : 'publication cache purge network failure',
          { cause: error },
        );
      }
      if (response.ok) return;
      const retryable = response.status === 408 || response.status === 425
        || response.status === 429 || response.status >= 500;
      throw new PublicationCachePurgeProviderError(
        retryable ? 'retryable' : 'permanent',
        `publication cache purge provider returned HTTP ${response.status}`,
        { statusCode: response.status },
      );
    } finally {
      // Status is authoritative; never buffer a body we do not use, and never
      // wait indefinitely for an injected stream's cancellation acknowledgement.
      // The owned abort also tears down the production node:https request/agent.
      if (response?.body) observeBestEffort(response.body.cancel(),
        'The owned abort tears down the connection; a late stream cancellation rejection cannot change the provider status.');
      request.signal.removeEventListener('abort', abortFromCaller);
      controller.abort();
    }
  }
}

export function publicationCachePurgeIdempotencyKey(eventId: string): string {
  const digest = createHash('sha256')
    .update('known:publication-cache-purge:v1\0', 'utf8')
    .update(eventId, 'utf8')
    .digest('base64url');
  return `publication-purge-v1-${digest}`;
}

export function publicationCachePurgeEnvelopeRegistrations(): readonly EventPayloadRegistration[] {
  return Object.freeze([
    {
      eventType: PUBLICATION_CACHE_PURGE_EVENT_TYPE,
      eventVersion: PUBLICATION_CACHE_PURGE_EVENT_VERSION_N_MINUS_1,
      validatePayload: validatePublicationCachePurgeV1,
    },
    {
      eventType: PUBLICATION_CACHE_PURGE_EVENT_TYPE,
      eventVersion: PUBLICATION_CACHE_PURGE_EVENT_VERSION,
      validatePayload: validatePublicationCachePurgeV2,
    },
  ]);
}

export interface CreatePublicationCachePurgeRoutesOptions {
  readonly provider: PublicationCachePurgeProvider;
  readonly publicationOrigin: string;
  readonly productOrigin: string;
  readonly timeoutMs: number;
  readonly metrics?: Metrics;
  /** Optional best-effort IndexNow side effect; invoked only after provider success. */
  readonly indexNowPublisher?: IndexNowPublisher;
  /** Current canonical public handle for the collection owner; no new outbox route/event fields. */
  readonly resolvePublicProfileHandle?: (
    collectionId: string,
    signal: AbortSignal,
  ) => Promise<string | null>;
  /** Existing identity-domain canonical handle authority; required before a handle enters a purge URL. */
  readonly isCanonicalPublicProfileHandle?: (value: string) => boolean;
}

export function createPostgresPublicationPublicProfileHandleResolver(
  runtime: Pick<DatabaseRuntime, 'pool' | 'cancelBackend'>,
): NonNullable<CreatePublicationCachePurgeRoutesOptions['resolvePublicProfileHandle']> {
  return async (collectionId, signal) => {
    const client = await runtime.pool.connect();
    try {
      const pid = await readBackendPid(client, signal);
      const cancel = async (): Promise<void> => {
        if (pid !== undefined) await runtime.cancelBackend(pid);
      };
      const result = await withPostgresAbort(
        client.query<{ handle: string }>(
          `select lower(h.handle) as handle
             from collections c
             join accounts a on a.subject_id = c.owner_subject_id
             join profiles p on p.account_id = a.id
             join profile_handles h on h.account_id = a.id
            where c.id = $1
              and a.status = 'active'
              and a.deleted_at is null
            limit 1`,
          [collectionId],
        ),
        signal,
        cancel,
      );
      const handle = result.rows[0]?.handle;
      return typeof handle === 'string' ? handle : null;
    } finally {
      client.release();
    }
  };
}

async function requestFromContext(
  context: OutboxHandlerContext,
  options: CreatePublicationCachePurgeRoutesOptions,
  signal: AbortSignal,
): Promise<PublicationCachePurgeRequest> {
  const payload = context.envelope.payload as Record<string, unknown>;
  const collectionId = payload.collectionId as string;
  const publicationSlug = payload.publicationSlug as string;
  const encodedCollectionId = encodeURIComponent(collectionId);
  const encodedSlug = encodeURIComponent(publicationSlug);
  const resolvedHandle = await options.resolvePublicProfileHandle?.(collectionId, signal) ?? null;
  const publicProfileHandle = resolvedHandle !== null
      && options.isCanonicalPublicProfileHandle?.(resolvedHandle) === true
    ? resolvedHandle
    : null;
  return Object.freeze({
    eventId: context.envelope.event_id,
    idempotencyKey: publicationCachePurgeIdempotencyKey(context.envelope.event_id),
    collectionId,
    publicationSlug,
    visibility: (payload.visibility as PublicationCachePurgeRequest['visibility']) ?? null,
    contentRevision: (payload.contentRevision as string | undefined) ?? null,
    policyRevision: (payload.policyRevision as string | undefined) ?? null,
    sourceEventType: (payload.sourceEventType as string | undefined) ?? null,
    sourceEventVersion: (payload.sourceEventVersion as number | undefined) ?? null,
    eventVersion: context.envelope.event_version,
    urls: Object.freeze([
      `${options.publicationOrigin}/colp/v0.1/directory`,
      `${options.publicationOrigin}/colp/v0.1/collections/${encodedCollectionId}`,
      `${options.publicationOrigin}/colp/v0.1/collections/${encodedCollectionId}/snapshot`,
      `${options.productOrigin}/api/v1/collections/${encodedSlug}`,
      `${options.productOrigin}/c/${encodedSlug}`,
      `${options.productOrigin}/share/${encodedSlug}`,
      `${options.productOrigin}/path/${encodedSlug}`,
      `${options.productOrigin}/graph/${encodedSlug}`,
      ...(publicProfileHandle === null
        ? []
        : [`${options.productOrigin}/u/${encodeURIComponent(publicProfileHandle)}`]),
      // The injected /explore document lists the newest public collections.
      `${options.productOrigin}/explore`,
      `${options.productOrigin}/sitemap-collections.xml`,
      `${options.productOrigin}/sitemap-profiles.xml`,
    ]),
    surrogateKeys: Object.freeze([
      'known-publication-directory',
      `known-publication-collection-${collectionId}`,
      `known-publication-slug-${publicationSlug}`,
    ]),
    signal,
  });
}

async function invokeProvider(
  context: OutboxHandlerContext,
  options: CreatePublicationCachePurgeRoutesOptions,
): Promise<PublicationCachePurgeRequest> {
  const controller = new AbortController();
  const abortFromWorker = () => controller.abort(context.signal.reason);
  if (context.signal.aborted) abortFromWorker();
  else context.signal.addEventListener('abort', abortFromWorker, { once: true });
  const timeout = setTimeout(() => {
    const error = new PublicationCachePurgeProviderError(
      'retryable',
      `publication cache purge exceeded ${options.timeoutMs}ms timeout`,
    );
    controller.abort(error);
  }, options.timeoutMs);
  timeout.unref();
  const started = performance.now();
  try {
    // Providers must honor AbortSignal. If one does not, the outer worker deadline keeps
    // the unresolved call capacity-accounted instead of launching overlapping retries.
    const request = await requestFromContext(context, options, controller.signal);
    await options.provider.purge(request);
    if (controller.signal.aborted) {
      throw new PublicationCachePurgeProviderError('retryable', 'publication cache purge timed out or was cancelled');
    }
    options.metrics?.increment('publication.cache_purge.succeeded');
    return request;
  } catch (error: unknown) {
    options.metrics?.increment('publication.cache_purge.failure');
    const failureKind = error instanceof PublicationCachePurgeProviderError
      ? error.failureKind
      : 'retryable';
    options.metrics?.increment(`publication.cache_purge.${failureKind}_failure`);
    throw new OutboxDeliveryError(
      failureKind,
      error instanceof Error ? error.message : 'publication cache purge provider failed',
      { cause: error },
    );
  } finally {
    clearTimeout(timeout);
    context.signal.removeEventListener('abort', abortFromWorker);
    options.metrics?.observe('publication.cache_purge.latency_ms', performance.now() - started);
  }
}

export function createPublicationCachePurgeRoutes(
  options: CreatePublicationCachePurgeRoutesOptions,
): readonly OutboxRoute[] {
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1) {
    throw new RangeError('publication cache purge timeoutMs must be a positive integer');
  }
  return publicationCachePurgeEnvelopeRegistrations().map((registration) => ({
    handlerName: PUBLICATION_CACHE_PURGE_HANDLER_NAME,
    handlerMode: 'delivery_each_event' as const,
    eventType: registration.eventType,
    eventVersion: registration.eventVersion,
    sideEffectDurability: 'durable' as const,
    routeClass: 'publication_cache_purge' as const,
    async handle(context: OutboxHandlerContext): Promise<void> {
      if (!registration.validatePayload(context.envelope.payload)) {
        throw new OutboxDeliveryError(
          'permanent',
          `closed payload rejected for ${registration.eventType}@${registration.eventVersion}`,
        );
      }
      const request = await invokeProvider(context, options);
      options.indexNowPublisher?.notifyPublicationSlug(request.publicationSlug);
    },
  }));
}
