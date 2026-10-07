import type { Pool } from 'pg';
import {
  defineClosedPayloadValidator,
  type EventPayloadRegistration,
} from './envelope.js';
import {
  OutboxDeliveryError,
  type OutboxHandlerContext,
  type OutboxRoute,
} from './router.js';
import {
  PublicationCachePurgeProviderError,
  type PublicationCachePurgeProvider,
} from './publication-cache-purge.js';
import {
  GOVERNANCE_BOOKMARK_CONTROL_EVENT_TYPE,
  GOVERNANCE_BOOKMARK_CONTROL_EVENT_VERSION,
  GOVERNANCE_BOOKMARK_CONTROL_HANDLER_NAME,
  GOVERNANCE_COLLECTION_CONTROL_EVENT_TYPE,
  GOVERNANCE_COLLECTION_CONTROL_EVENT_VERSION,
  GOVERNANCE_COLLECTION_CONTROL_HANDLER_NAME,
  GOVERNANCE_DIGEST_CONTROL_EVENT_TYPE,
  GOVERNANCE_DIGEST_CONTROL_EVENT_VERSION,
  GOVERNANCE_ACCOUNT_CONTROL_EVENT_TYPE,
  GOVERNANCE_ACCOUNT_CONTROL_EVENT_VERSION,
} from '../governance/postgres-moderation-outbox.js';

const nonEmpty = (value: unknown): boolean => typeof value === 'string' && value.length > 0;
const optionalSlug = (value: unknown): boolean => value === null || nonEmpty(value);
const action = (value: unknown): boolean => value === 'delist' || value === 'hide_public';
const accountAction = (value: unknown): boolean =>
  value === 'restrict_interaction' || value === 'restrict_publication';
const state = (value: unknown): boolean => value === 'active' || value === 'revoked';

export const validateGovernanceCollectionControlV1 = defineClosedPayloadValidator({
  collectionId: nonEmpty,
  actionId: nonEmpty,
  action,
  state,
  publicationSlug: optionalSlug,
});

export const validateGovernanceBookmarkControlV1 = defineClosedPayloadValidator({
  collectionId: nonEmpty,
  nodeId: nonEmpty,
  actionId: nonEmpty,
  action,
  state,
  publicationSlug: optionalSlug,
  faviconObjectId: optionalSlug,
});

export const validateGovernanceDigestControlV1 = defineClosedPayloadValidator({
  seriesId: nonEmpty,
  editionId: optionalSlug,
  actionId: nonEmpty,
  action,
  state,
  seriesSlug: optionalSlug,
});

export const validateGovernanceAccountControlV1 = defineClosedPayloadValidator({
  accountId: nonEmpty,
  actionId: nonEmpty,
  action: accountAction,
  state,
  handle: optionalSlug,
  avatarObjectId: optionalSlug,
});

export function governanceCollectionControlEnvelopeRegistrations(): readonly EventPayloadRegistration[] {
  return Object.freeze([
    {
      eventType: GOVERNANCE_COLLECTION_CONTROL_EVENT_TYPE,
      eventVersion: GOVERNANCE_COLLECTION_CONTROL_EVENT_VERSION,
      validatePayload: validateGovernanceCollectionControlV1,
    },
    {
      eventType: GOVERNANCE_DIGEST_CONTROL_EVENT_TYPE,
      eventVersion: GOVERNANCE_DIGEST_CONTROL_EVENT_VERSION,
      validatePayload: validateGovernanceDigestControlV1,
    },
    {
      eventType: GOVERNANCE_ACCOUNT_CONTROL_EVENT_TYPE,
      eventVersion: GOVERNANCE_ACCOUNT_CONTROL_EVENT_VERSION,
      validatePayload: validateGovernanceAccountControlV1,
    },
  ]);
}

export function governanceBookmarkControlEnvelopeRegistrations(): readonly EventPayloadRegistration[] {
  return Object.freeze([
    {
      eventType: GOVERNANCE_BOOKMARK_CONTROL_EVENT_TYPE,
      eventVersion: GOVERNANCE_BOOKMARK_CONTROL_EVENT_VERSION,
      validatePayload: validateGovernanceBookmarkControlV1,
    },
  ]);
}

function collectionControlPurgeUrls(input: {
  readonly productOrigin: string;
  readonly publicationOrigin: string;
  readonly collectionId: string;
  readonly publicationSlug: string | null;
}): string[] {
  const encodedId = encodeURIComponent(input.collectionId);
  const slug = input.publicationSlug;
  return [
    `${input.productOrigin}/api/v1/collections/${encodedId}`,
    `${input.productOrigin}/colp/v0.1/collections/${encodedId}`,
    `${input.productOrigin}/colp/v0.1/directory`,
    `${input.productOrigin}/api/v1/explore/collections`,
    `${input.productOrigin}/api/v1/search`,
    `${input.productOrigin}/sitemap-collections.xml`,
    ...(slug ? [
      `${input.publicationOrigin}/c/${encodeURIComponent(slug)}`,
      `${input.productOrigin}/share/${encodeURIComponent(slug)}`,
      `${input.productOrigin}/path/${encodeURIComponent(slug)}`,
      `${input.productOrigin}/graph/${encodeURIComponent(slug)}`,
      `${input.productOrigin}/api/v1/collections/${encodeURIComponent(slug)}`,
    ] : []),
  ];
}

function accountControlPurgeUrls(input: {
  readonly productOrigin: string;
  readonly handle: string | null;
  readonly avatarObjectId: string | null;
}): string[] {
  const handle = input.handle;
  return [
    `${input.productOrigin}/api/v1/explore/collections`,
    `${input.productOrigin}/api/v1/search`,
    `${input.productOrigin}/sitemap-profiles.xml`,
    ...(handle ? [
      `${input.productOrigin}/api/v1/profiles/${encodeURIComponent(handle)}`,
      `${input.productOrigin}/api/v1/profiles/${encodeURIComponent(handle)}/activity`,
      `${input.productOrigin}/u/${encodeURIComponent(handle)}`,
      `${input.productOrigin}/profile/${encodeURIComponent(handle)}`,
    ] : []),
    ...(input.avatarObjectId
      ? [`${input.productOrigin}/api/v1/avatar/${encodeURIComponent(input.avatarObjectId)}`]
      : []),
  ];
}

function digestControlPurgeUrls(input: {
  readonly productOrigin: string;
  readonly seriesId: string;
  readonly editionId: string | null;
  readonly seriesSlug: string | null;
}): string[] {
  const slug = input.seriesSlug;
  const encodedSlug = slug ? encodeURIComponent(slug) : null;
  const edition = input.editionId ? encodeURIComponent(input.editionId) : null;
  return [
    `${input.productOrigin}/api/v1/public-reports`,
    `${input.productOrigin}/reports`,
    `${input.productOrigin}/sitemap-reports.xml`,
    ...(encodedSlug ? [
      `${input.productOrigin}/api/v1/public-reports/${encodedSlug}`,
      `${input.productOrigin}/api/v1/public-reports/${encodedSlug}/issues`,
      `${input.productOrigin}/reports/${encodedSlug}`,
      ...(edition ? [
        `${input.productOrigin}/api/v1/public-reports/${encodedSlug}/issues/${edition}`,
        `${input.productOrigin}/reports/${encodedSlug}/issues/${edition}`,
      ] : []),
    ] : []),
  ];
}

export function createGovernanceCollectionControlRoute(input: {
  readonly provider: PublicationCachePurgeProvider;
  readonly publicationOrigin: string;
  readonly productOrigin: string;
  readonly pool?: Pool;
}): OutboxRoute {
  void input.pool;
  return Object.freeze({
    handlerName: GOVERNANCE_COLLECTION_CONTROL_HANDLER_NAME,
    handlerMode: 'delivery_each_event' as const,
    eventType: GOVERNANCE_COLLECTION_CONTROL_EVENT_TYPE,
    eventVersion: GOVERNANCE_COLLECTION_CONTROL_EVENT_VERSION,
    sideEffectDurability: 'durable' as const,
    routeClass: 'publication_cache_purge' as const,
    async handle(context: OutboxHandlerContext): Promise<void> {
      const payload = context.envelope.payload as {
        readonly collectionId: string;
        readonly publicationSlug: string | null;
      };
      const slug = payload.publicationSlug;
      const urls = collectionControlPurgeUrls({
        productOrigin: input.productOrigin,
        publicationOrigin: input.publicationOrigin,
        collectionId: payload.collectionId,
        publicationSlug: slug,
      });
      try {
        await input.provider.purge({
          eventId: context.envelope.event_id,
          idempotencyKey: `governance-purge-v1-${context.envelope.event_id}`,
          collectionId: payload.collectionId,
          publicationSlug: slug ?? payload.collectionId,
          visibility: null,
          contentRevision: null,
          policyRevision: null,
          sourceEventType: GOVERNANCE_COLLECTION_CONTROL_EVENT_TYPE,
          sourceEventVersion: GOVERNANCE_COLLECTION_CONTROL_EVENT_VERSION,
          urls,
          surrogateKeys: [`collection:${payload.collectionId}`],
          signal: context.signal,
        });
      } catch (error: unknown) {
        if (error instanceof PublicationCachePurgeProviderError) {
          throw new OutboxDeliveryError(error.failureKind, error.message, { cause: error });
        }
        throw new OutboxDeliveryError(
          'retryable',
          error instanceof Error ? error.message : 'governance cache purge failed',
          { cause: error },
        );
      }
    },
  });
}

export function createGovernanceDigestControlRoute(input: {
  readonly provider: PublicationCachePurgeProvider;
  readonly publicationOrigin: string;
  readonly productOrigin: string;
  readonly pool?: Pool;
}): OutboxRoute {
  void input.pool;
  void input.publicationOrigin;
  return Object.freeze({
    handlerName: GOVERNANCE_COLLECTION_CONTROL_HANDLER_NAME,
    handlerMode: 'delivery_each_event' as const,
    eventType: GOVERNANCE_DIGEST_CONTROL_EVENT_TYPE,
    eventVersion: GOVERNANCE_DIGEST_CONTROL_EVENT_VERSION,
    sideEffectDurability: 'durable' as const,
    routeClass: 'publication_cache_purge' as const,
    async handle(context: OutboxHandlerContext): Promise<void> {
      const payload = context.envelope.payload as {
        readonly seriesId: string;
        readonly editionId: string | null;
        readonly seriesSlug: string | null;
      };
      const urls = digestControlPurgeUrls({
        productOrigin: input.productOrigin,
        seriesId: payload.seriesId,
        editionId: payload.editionId,
        seriesSlug: payload.seriesSlug,
      });
      try {
        await input.provider.purge({
          eventId: context.envelope.event_id,
          idempotencyKey: `governance-digest-purge-v1-${context.envelope.event_id}`,
          collectionId: payload.seriesId,
          publicationSlug: payload.seriesSlug ?? payload.seriesId,
          visibility: null,
          contentRevision: null,
          policyRevision: null,
          sourceEventType: GOVERNANCE_DIGEST_CONTROL_EVENT_TYPE,
          sourceEventVersion: GOVERNANCE_DIGEST_CONTROL_EVENT_VERSION,
          urls,
          surrogateKeys: [`digest:${payload.seriesId}`],
          signal: context.signal,
        });
      } catch (error: unknown) {
        if (error instanceof PublicationCachePurgeProviderError) {
          throw new OutboxDeliveryError(error.failureKind, error.message, { cause: error });
        }
        throw new OutboxDeliveryError(
          'retryable',
          error instanceof Error ? error.message : 'governance digest cache purge failed',
          { cause: error },
        );
      }
    },
  });
}

export function createGovernanceAccountControlRoute(input: {
  readonly provider: PublicationCachePurgeProvider;
  readonly publicationOrigin: string;
  readonly productOrigin: string;
  readonly pool?: Pool;
}): OutboxRoute {
  void input.pool;
  void input.publicationOrigin;
  return Object.freeze({
    handlerName: GOVERNANCE_COLLECTION_CONTROL_HANDLER_NAME,
    handlerMode: 'delivery_each_event' as const,
    eventType: GOVERNANCE_ACCOUNT_CONTROL_EVENT_TYPE,
    eventVersion: GOVERNANCE_ACCOUNT_CONTROL_EVENT_VERSION,
    sideEffectDurability: 'durable' as const,
    routeClass: 'publication_cache_purge' as const,
    async handle(context: OutboxHandlerContext): Promise<void> {
      const payload = context.envelope.payload as {
        readonly accountId: string;
        readonly handle: string | null;
        readonly avatarObjectId: string | null;
      };
      const urls = accountControlPurgeUrls({
        productOrigin: input.productOrigin,
        handle: payload.handle,
        avatarObjectId: payload.avatarObjectId,
      });
      try {
        await input.provider.purge({
          eventId: context.envelope.event_id,
          idempotencyKey: `governance-account-purge-v1-${context.envelope.event_id}`,
          collectionId: payload.accountId,
          publicationSlug: payload.handle ?? payload.accountId,
          visibility: null,
          contentRevision: null,
          policyRevision: null,
          sourceEventType: GOVERNANCE_ACCOUNT_CONTROL_EVENT_TYPE,
          sourceEventVersion: GOVERNANCE_ACCOUNT_CONTROL_EVENT_VERSION,
          urls,
          surrogateKeys: [`account:${payload.accountId}`],
          signal: context.signal,
        });
      } catch (error: unknown) {
        if (error instanceof PublicationCachePurgeProviderError) {
          throw new OutboxDeliveryError(error.failureKind, error.message, { cause: error });
        }
        throw new OutboxDeliveryError(
          'retryable',
          error instanceof Error ? error.message : 'governance account cache purge failed',
          { cause: error },
        );
      }
    },
  });
}

export function createGovernanceCollectionControlRoutes(input: {
  readonly provider: PublicationCachePurgeProvider | undefined;
  readonly publicationOrigin: string;
  readonly productOrigin: string;
  readonly pool?: Pool;
}): readonly OutboxRoute[] {
  if (input.provider === undefined) return Object.freeze([]);
  const shared = {
    provider: input.provider,
    publicationOrigin: input.publicationOrigin,
    productOrigin: input.productOrigin,
    ...(input.pool === undefined ? {} : { pool: input.pool }),
  };
  return Object.freeze([
    createGovernanceCollectionControlRoute(shared),
    createGovernanceDigestControlRoute(shared),
    createGovernanceAccountControlRoute(shared),
  ]);
}

export function createGovernanceBookmarkControlRoute(input: {
  readonly provider: PublicationCachePurgeProvider;
  readonly publicationOrigin: string;
  readonly productOrigin: string;
  readonly pool?: Pool;
}): OutboxRoute {
  void input.pool;
  return Object.freeze({
    handlerName: GOVERNANCE_BOOKMARK_CONTROL_HANDLER_NAME,
    handlerMode: 'delivery_each_event' as const,
    eventType: GOVERNANCE_BOOKMARK_CONTROL_EVENT_TYPE,
    eventVersion: GOVERNANCE_BOOKMARK_CONTROL_EVENT_VERSION,
    sideEffectDurability: 'durable' as const,
    routeClass: 'publication_cache_purge' as const,
    async handle(context: OutboxHandlerContext): Promise<void> {
      const payload = context.envelope.payload as {
        readonly collectionId: string;
        readonly publicationSlug: string | null;
        readonly faviconObjectId: string | null;
      };
      const urls = [
        ...collectionControlPurgeUrls({
          productOrigin: input.productOrigin,
          publicationOrigin: input.publicationOrigin,
          collectionId: payload.collectionId,
          publicationSlug: payload.publicationSlug,
        }),
        ...(payload.faviconObjectId
          ? [`${input.productOrigin}/api/v1/favicon/${encodeURIComponent(payload.faviconObjectId)}`]
          : []),
      ];
      try {
        await input.provider.purge({
          eventId: context.envelope.event_id,
          idempotencyKey: `governance-bookmark-purge-v1-${context.envelope.event_id}`,
          collectionId: payload.collectionId,
          publicationSlug: payload.publicationSlug ?? payload.collectionId,
          visibility: null,
          contentRevision: null,
          policyRevision: null,
          sourceEventType: GOVERNANCE_BOOKMARK_CONTROL_EVENT_TYPE,
          sourceEventVersion: GOVERNANCE_BOOKMARK_CONTROL_EVENT_VERSION,
          urls,
          surrogateKeys: [`collection:${payload.collectionId}`],
          signal: context.signal,
        });
      } catch (error: unknown) {
        if (error instanceof PublicationCachePurgeProviderError) {
          throw new OutboxDeliveryError(error.failureKind, error.message, { cause: error });
        }
        throw new OutboxDeliveryError(
          'retryable',
          error instanceof Error ? error.message : 'governance bookmark cache purge failed',
          { cause: error },
        );
      }
    },
  });
}

export function createGovernanceBookmarkControlRoutes(input: {
  readonly provider: PublicationCachePurgeProvider | undefined;
  readonly publicationOrigin: string;
  readonly productOrigin: string;
  readonly pool?: Pool;
}): readonly OutboxRoute[] {
  if (input.provider === undefined) return Object.freeze([]);
  return Object.freeze([createGovernanceBookmarkControlRoute({
    provider: input.provider,
    publicationOrigin: input.publicationOrigin,
    productOrigin: input.productOrigin,
    ...(input.pool === undefined ? {} : { pool: input.pool }),
  })]);
}
