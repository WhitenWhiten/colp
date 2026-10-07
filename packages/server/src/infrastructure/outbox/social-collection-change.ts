import { randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import { assertClosedJsonObject, CanonicalMutationInvariantError } from '../../modules/collections/index.js';
import { databaseNow } from '../database/time.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import type { VersionedEventEnvelope } from './envelope.js';

export const SOCIAL_COLLECTION_CHANGE_EVENT_TYPE = 'social.collection-change' as const;
export const SOCIAL_COLLECTION_CHANGE_EVENT_VERSION = 2 as const;
export const SOCIAL_COLLECTION_CHANGE_HANDLER_NAME = 'social.publish-collection-change' as const;
export const SOCIAL_COLLECTION_CHANGE_HANDLER_MODE = 'projection_latest_only' as const;
export const SOCIAL_PUBLIC_ACTIVITY_HANDLER_NAME = 'social.publish-public-activity' as const;
export const SOCIAL_PUBLIC_ACTIVITY_HANDLER_MODE = 'delivery_each_event' as const;
const CANONICAL_OPAQUE_ID = /^[A-Za-z0-9_-]{21}[AQgw]$/u;

export type SocialProducerDiscoverability = 'public_candidate' | 'remove';

export interface SocialCollectionChangeFacts {
  readonly collectionId: string;
  readonly ownerProfileId: string;
  readonly contentRevision: string;
  readonly policyRevision: string;
  readonly commitOrdinal: bigint;
  readonly visibility: 'private' | 'protected' | 'public' | 'unlisted';
  readonly publicationSlug: string | null;
  readonly publishedAt: Date | null;
  readonly deletedAt: Date | null;
}

export interface SocialCollectionChangePayload {
  readonly collectionId: string;
  readonly ownerProfileId: string;
  readonly publicationRevision: string;
  readonly discoverabilityRecheckKey: string;
  readonly producerDiscoverability: SocialProducerDiscoverability;
}

export interface RoutedSocialCollectionChange {
  readonly eventType: typeof SOCIAL_COLLECTION_CHANGE_EVENT_TYPE;
  readonly eventVersion: typeof SOCIAL_COLLECTION_CHANGE_EVENT_VERSION;
  readonly handlerName: typeof SOCIAL_COLLECTION_CHANGE_HANDLER_NAME;
  readonly handlerMode: typeof SOCIAL_COLLECTION_CHANGE_HANDLER_MODE;
  readonly aggregateType: 'collection';
  readonly aggregateId: string;
  readonly aggregateScope: string;
  readonly aggregateRevision: string;
  readonly commitOrdinal: bigint;
  readonly payload: SocialCollectionChangePayload;
}

export type SocialCollectionChangeRouteFaultPhase =
  | 'before_map'
  | 'after_map'
  | 'before_append'
  | 'after_append';

export interface SocialCollectionChangeRouteFaultInjector {
  beforeMap?(): void | Promise<void>;
  afterMap?(route: RoutedSocialCollectionChange): void | Promise<void>;
  beforeAppend?(route: RoutedSocialCollectionChange): void | Promise<void>;
  afterAppend?(route: RoutedSocialCollectionChange): void | Promise<void>;
}

export interface AppendSocialCollectionChangeOptions {
  readonly outboxIdGenerator?: () => string;
  readonly faultInjector?: SocialCollectionChangeRouteFaultInjector;
  readonly occurredAt?: Date;
}

function invalid(message: string): never {
  throw new CanonicalMutationInvariantError(
    'invalid_canonical_mutation',
    `social collection change ${message}`,
  );
}

function requireFact(value: string, name: string): string {
  if (typeof value !== 'string' || value.length < 1) invalid(`${name} is missing`);
  return value;
}

function requireCanonicalOpaqueId(value: string, name: string): string {
  if (typeof value !== 'string' || !CANONICAL_OPAQUE_ID.test(value)) {
    invalid(`${name} must be a canonical 16-byte base64url identity`);
  }
  return value;
}

/** P5-08 explicit, closed mapper. It receives facts only, never source event content. */
export function mapSocialCollectionChange(
  facts: SocialCollectionChangeFacts,
): RoutedSocialCollectionChange {
  const collectionId = requireCanonicalOpaqueId(facts.collectionId, 'collectionId');
  const ownerProfileId = requireCanonicalOpaqueId(facts.ownerProfileId, 'ownerProfileId');
  const contentRevision = requireFact(facts.contentRevision, 'contentRevision');
  const policyRevision = requireFact(facts.policyRevision, 'policyRevision');
  if (typeof facts.commitOrdinal !== 'bigint' || facts.commitOrdinal <= 0n) {
    invalid('commitOrdinal must be positive');
  }
  if (!['private', 'protected', 'public', 'unlisted'].includes(facts.visibility)) {
    invalid('visibility is invalid');
  }
  const publicationRevision = `${contentRevision}.${policyRevision}`;
  const producerDiscoverability: SocialProducerDiscoverability = facts.deletedAt === null
    && facts.publishedAt !== null
    && facts.publicationSlug !== null
    && facts.visibility === 'public'
    ? 'public_candidate'
    : 'remove';
  const payload = Object.freeze({
    collectionId,
    ownerProfileId,
    publicationRevision,
    discoverabilityRecheckKey: `publication.collection:${collectionId}`,
    producerDiscoverability,
  });
  if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > 2_048) {
    invalid('payload exceeds 2048 UTF-8 bytes');
  }
  return Object.freeze({
    eventType: SOCIAL_COLLECTION_CHANGE_EVENT_TYPE,
    eventVersion: SOCIAL_COLLECTION_CHANGE_EVENT_VERSION,
    handlerName: SOCIAL_COLLECTION_CHANGE_HANDLER_NAME,
    handlerMode: SOCIAL_COLLECTION_CHANGE_HANDLER_MODE,
    aggregateType: 'collection' as const,
    aggregateId: collectionId,
    aggregateScope: collectionId,
    aggregateRevision: publicationRevision,
    commitOrdinal: facts.commitOrdinal,
    payload,
  });
}

export function mapSocialCollectionChangeEnvelope(
  domainEventId: string,
  occurredAt: Date,
  routed: RoutedSocialCollectionChange,
): VersionedEventEnvelope {
  const eventId = requireCanonicalOpaqueId(domainEventId, 'domainEventId');
  if (!(occurredAt instanceof Date) || !Number.isFinite(occurredAt.getTime())) {
    invalid('occurredAt is invalid');
  }
  const payload: unknown = routed.payload;
  try {
    assertClosedJsonObject(payload, 'social.collection-change payload');
  } catch {
    invalid('payload must be a closed JSON object');
  }
  return Object.freeze({
    event_id: eventId,
    event_type: routed.eventType,
    event_version: routed.eventVersion,
    aggregate_identity: Object.freeze({
      aggregate_type: routed.aggregateType,
      aggregate_id: routed.aggregateId,
      aggregate_scope: routed.aggregateScope,
    }),
    aggregate_revision: routed.aggregateRevision,
    commit_ordinal: routed.commitOrdinal.toString(),
    occurred_at: occurredAt.toISOString(),
    payload,
  });
}

interface CollectionRouteRow {
  id: string;
  owner_profile_id: string | null;
  owner_account_status: 'active' | 'disabled' | 'deleted' | null;
  profile_exists: boolean;
  visibility: SocialCollectionChangeFacts['visibility'];
  publication_slug: string | null;
  published_at: Date | null;
  content_revision: string;
  policy_revision: string;
  commit_ordinal: bigint | string;
  deleted_at: Date | null;
}

function generateOutboxId(): string {
  return randomBytes(16).toString('base64url');
}

/** Appends the handler-specific row inside the caller's canonical transaction. */
export async function appendSocialCollectionChangeOutbox(
  transaction: DatabaseTransaction,
  domainEventId: string,
  collectionId: string,
  commitOrdinal: bigint,
  options: AppendSocialCollectionChangeOptions = {},
): Promise<void> {
  requireCanonicalOpaqueId(domainEventId, 'domainEventId');
  requireCanonicalOpaqueId(collectionId, 'collectionId');
  if (commitOrdinal <= 0n) invalid('commitOrdinal must be positive');
  await options.faultInjector?.beforeMap?.();

  const row = await transaction.selectFrom('collections')
    .leftJoin('accounts', 'accounts.subject_id', 'collections.owner_subject_id')
    .leftJoin('profiles', 'profiles.account_id', 'accounts.id')
    .select([
      'collections.id',
      'accounts.id as owner_profile_id',
      'accounts.status as owner_account_status',
      sql<boolean>`profiles.account_id is not null`.as('profile_exists'),
      'collections.visibility',
      'collections.publication_slug',
      'collections.published_at',
      'collections.content_revision',
      'collections.policy_revision',
      'collections.commit_ordinal',
      'collections.deleted_at',
    ])
    .where('collections.id', '=', collectionId)
    .executeTakeFirst() as CollectionRouteRow | undefined;
  if (!row) invalid('authoritative Collection facts are missing');
  if (row.owner_profile_id === null || !row.profile_exists) {
    invalid('stable owner Profile identity is missing');
  }
  const authoritativeCommitOrdinal = BigInt(row.commit_ordinal);
  if (authoritativeCommitOrdinal !== commitOrdinal) {
    invalid('commitOrdinal does not match authoritative Collection facts');
  }
  const routed = mapSocialCollectionChange({
    collectionId: row.id,
    ownerProfileId: row.owner_profile_id,
    contentRevision: row.content_revision,
    policyRevision: row.policy_revision,
    commitOrdinal: authoritativeCommitOrdinal,
    visibility: row.owner_account_status === 'active' ? row.visibility : 'private',
    publicationSlug: row.publication_slug,
    publishedAt: row.published_at,
    deletedAt: row.deleted_at,
  });
  await options.faultInjector?.afterMap?.(routed);
  await options.faultInjector?.beforeAppend?.(routed);

  const occurredAt = options.occurredAt ?? await databaseNow(transaction);
  const envelope = mapSocialCollectionChangeEnvelope(domainEventId, occurredAt, routed);
  const nextOutboxId = options.outboxIdGenerator ?? generateOutboxId;

  await insertCollectionChangeHandlerRow(transaction, {
    outboxId: nextOutboxId(),
    domainEventId,
    envelope,
    occurredAt,
    handlerName: routed.handlerName,
    handlerMode: routed.handlerMode,
  });
  await insertCollectionChangeHandlerRow(transaction, {
    outboxId: nextOutboxId(),
    domainEventId,
    envelope,
    occurredAt,
    handlerName: SOCIAL_PUBLIC_ACTIVITY_HANDLER_NAME,
    handlerMode: SOCIAL_PUBLIC_ACTIVITY_HANDLER_MODE,
  });
  await options.faultInjector?.afterAppend?.(routed);
}

async function insertCollectionChangeHandlerRow(
  transaction: DatabaseTransaction,
  input: {
    readonly outboxId: string;
    readonly domainEventId: string;
    readonly envelope: VersionedEventEnvelope;
    readonly occurredAt: Date;
    readonly handlerName: string;
    readonly handlerMode: 'projection_latest_only' | 'delivery_each_event';
  },
): Promise<void> {
  await transaction.insertInto('resource_id_ledger').values({
    resource_id: input.outboxId,
    resource_type: 'outbox',
  }).execute();
  await transaction.insertInto('outbox_events').values({
    outbox_id: input.outboxId,
    domain_event_id: input.domainEventId,
    event_type: input.envelope.event_type,
    event_version: input.envelope.event_version,
    handler_name: input.handlerName,
    handler_mode: input.handlerMode,
    aggregate_type: input.envelope.aggregate_identity.aggregate_type,
    aggregate_id: input.envelope.aggregate_identity.aggregate_id,
    aggregate_scope: input.envelope.aggregate_identity.aggregate_scope,
    aggregate_revision: input.envelope.aggregate_revision,
    commit_ordinal: BigInt(input.envelope.commit_ordinal!),
    occurred_at: input.occurredAt,
    payload_json: { ...input.envelope.payload },
    state: 'pending',
    attempt_count: 0,
    available_at: input.occurredAt,
    locked_until: null,
    lease_generation: 0n,
    completed_at: null,
    last_error: null,
    dead_lettered_at: null,
  }).execute();
}
