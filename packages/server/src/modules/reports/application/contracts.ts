import type { DigestEdition, DigestMember, DigestSeries, ReportSourceFacts } from '../domain/index.js';
import type { ProductCommandReceiptPort, ProductCommandResult } from '../../commands/index.js';

/** Shared revision/ETag seam. Reports never implement token or ETag algorithms. */
export interface RevisionTokenPort {
  readonly next: () => string;
  readonly etag: (revision: string) => string;
  readonly matches: (revision: string, ifMatch: string) => boolean;
}

export function createRevisionTokenPort(deps: {
  readonly next: () => string;
  readonly etag: (revision: string) => string;
}): RevisionTokenPort {
  return Object.freeze({
    next: deps.next,
    etag: deps.etag,
    matches: (revision: string, ifMatch: string) => ifMatch === deps.etag(revision),
  });
}

/** Adapter boundary for Collection/publication facts; implementations batch-read facts. */
export interface ReportSourceReadPort {
  /** True only when at least one published source exists and every source permits indexing. */
  readonly publishedSourcesIndexableBySeriesIds?: (seriesIds: readonly string[]) => Promise<ReadonlyMap<string, boolean>>;
  readonly get: (collectionId: string) => Promise<ReportSourceFacts | null>;
  readonly getMany: (collectionIds: readonly string[]) => Promise<readonly ReportSourceFacts[]>;
  /**
   * Authorize a source read for a report actor in the same transaction.
   *
   * Public projection deliberately uses `get/getMany` so it can inspect and
   * fail closed on sources which are no longer public.  Mutations that attach
   * an existing Collection must use this actor-bound seam instead of treating
   * a successful metadata lookup as proof of access.  Implementations may
   * return a concealment verdict rather than revealing whether a private
   * source exists.
   */
  readonly getForActor?: (
    collectionId: string,
    actor: Pick<ReportActor, 'subjectId'>,
  ) => Promise<ReportSourceReadResult>;
}
export type ReportSourceReadVerdict = 'public' | 'authorized' | 'not_public' | 'not_found' | 'dependency_unavailable';
export interface ReportSourceReadResult { readonly verdict: ReportSourceReadVerdict; readonly facts?: ReportSourceFacts; }

export interface ReportSeriesReadPort {
  readonly findById: (seriesId: string) => Promise<DigestSeries | null>;
  readonly findBySlug: (slug: string) => Promise<DigestSeries | null>;
  readonly list?: (seriesId: string) => Promise<readonly DigestSeries[]>;
}

export interface ReportEditionPageAfter {
  readonly publishedAt: string;
  readonly editionOrdinal: number;
  readonly id: string;
}

export interface ReportEditionReadPort {
  readonly findById: (editionId: string) => Promise<DigestEdition | null>;
  readonly listBySeries?: (seriesId: string, limit?: number) => Promise<readonly DigestEdition[]>;
  /** Batch projection used by the public directory; avoids one query per series. */
  readonly listBySeriesIds?: (seriesIds: readonly string[], limitPerSeries?: number) => Promise<ReadonlyMap<string, readonly DigestEdition[]>>;
  readonly listPublishedBySeries?: (seriesId: string, limit: number,
    after?: ReportEditionPageAfter) => Promise<readonly DigestEdition[]>;
  readonly listPublishedBySeriesIds?: (seriesIds: readonly string[],
    limitPerSeries: number) => Promise<ReadonlyMap<string, readonly DigestEdition[]>>;
  /** Opaque revision of published Edition, source, and moderation facts for cursor fencing. */
  readonly publicProjectionRevision?: (seriesId: string) => Promise<string>;
}

export type ReportCommandScope =
  | 'reports.series.create'
  | 'reports.series.update'
  | 'reports.series.archive'
  | 'reports.edition.attach'
  | 'reports.edition.update'
  | 'reports.edition.publish'
  | 'reports.edition.withdraw'
  | 'reports.edition.detach'
  | 'reports.follow'
  | 'reports.member.upsert'
  | 'reports.member.revoke'
  | 'reports.schedule.upsert'
  | 'reports.schedule.delete';

export interface ReportActor { readonly principalId: string; readonly subjectId: string; readonly profileId?: string; }
export interface ReportClock { readonly now: () => Date | Promise<Date>; }
export interface ReportIdPort {
  readonly nextResourceId: (type: 'digest_series' | 'digest_edition') => string;
  readonly nextEventId: () => string;
  readonly nextOutboxId: () => string;
}
export interface ReportSeriesWritePort {
  readonly insert: (value: DigestSeries) => Promise<void>;
  readonly lockById: (id: string) => Promise<DigestSeries | null>;
  readonly update: (id: string, patch: Partial<DigestSeries>) => Promise<DigestSeries>;
  readonly nextEditionOrdinal: (id: string) => Promise<number>;
  readonly disableSchedule?: (id: string) => Promise<void>;
  readonly list?: (id: string) => Promise<readonly DigestSeries[]>;
  /** Read-only directory enumeration; implementations may omit when unsupported. */
  readonly listAll?: (limit?: number) => Promise<readonly DigestSeries[]>;
  readonly listPublicDirectory?: (limit: number, after?: { readonly id: string; readonly updatedAt: string },
    language?: string | null) => Promise<readonly DigestSeries[]>;
}
export interface ReportEditionWritePort {
  readonly insert: (value: DigestEdition) => Promise<void>;
  readonly lockById: (id: string) => Promise<DigestEdition | null>;
  readonly update: (id: string, patch: Partial<DigestEdition>) => Promise<DigestEdition>;
  readonly findByIssueKey?: (seriesId: string, issueKey: string) => Promise<DigestEdition | null>;
  readonly findById?: (editionId: string) => Promise<DigestEdition | null>;
  readonly listBySeries?: (seriesId: string, limit?: number) => Promise<readonly DigestEdition[]>;
  readonly listBySeriesIds?: (seriesIds: readonly string[], limitPerSeries?: number) => Promise<ReadonlyMap<string, readonly DigestEdition[]>>;
  readonly listPublishedBySeries?: (seriesId: string, limit: number,
    after?: ReportEditionPageAfter) => Promise<readonly DigestEdition[]>;
  readonly listPublishedBySeriesIds?: (seriesIds: readonly string[],
    limitPerSeries: number) => Promise<ReadonlyMap<string, readonly DigestEdition[]>>;
  readonly publicProjectionRevision?: (seriesId: string) => Promise<string>;
}
export interface ReportMemberWritePort {
  readonly ensureOwner: (value: DigestMember) => Promise<void>;
  readonly get: (seriesId: string, subjectId: string) => Promise<DigestMember | null>;
  /** Active Identity subject check used before granting a report membership. */
  readonly isActiveSubject?: (subjectId: string) => Promise<boolean>;
  readonly list?: (seriesId: string, limit?: number) => Promise<readonly DigestMember[]>;
  readonly upsert?: (value: DigestMember) => Promise<DigestMember>;
  readonly revoke?: (seriesId: string, subjectId: string) => Promise<void>;
}
export interface ReportFollowWritePort {
  readonly lockActiveProfile: (profileId: string) => Promise<boolean>;
  readonly upsert: (seriesId: string, profileId: string, now: Date) => Promise<{ changed: boolean; followedAt: Date }>;
  readonly remove: (seriesId: string, profileId: string, now: Date) => Promise<{ changed: boolean; followedAt: Date | null }>;
  readonly countActive?: (seriesId: string) => Promise<number>;
  /** Batch active-follower counts keyed by series id; directory pages use this instead of N+1 countActive calls. */
  readonly countActiveBySeriesIds?: (seriesIds: readonly string[]) => Promise<ReadonlyMap<string, number>>;
  /** Read seams used by private follow state and keyset list/timeline queries. */
  readonly readState?: (seriesId: string, profileId: string) => Promise<{ readonly following: boolean; readonly followedAt: Date | null }>;
  readonly listOwned?: (subjectId: string, limit: number, after?: { readonly updatedAt: Date; readonly seriesId: string }) => Promise<readonly DigestSeries[]>;
  readonly listFollowed?: (profileId: string, limit: number, after?: { readonly followedAt: Date; readonly seriesId: string }) => Promise<readonly (DigestSeries & { readonly followedAt: Date; readonly hiddenPublic?: boolean })[]>;
  /**
   * Followed timeline keyset.  The ordinal is part of the comparator because
   * two editions may share the same publication instant; `id` is the final
   * deterministic tie-breaker.
   */
  readonly listFollowedIssues?: (
    profileId: string,
    limit: number,
    after?: { readonly publishedAt: Date; readonly editionOrdinal: number; readonly editionId: string },
  ) => Promise<readonly (DigestEdition & {
    /** Series-level hide_public in force: the row stays listed as a tombstone. */
    readonly series: DigestSeries & { readonly hiddenPublic?: boolean };
    /** Edition-level hide_public in force on this row. */
    readonly editionHiddenPublic?: boolean;
    /** Internal source fence; never copy this field into an API DTO. */
    readonly sourceFence?: ReportIssueSourceFence;
  })[]>;
}

/** Current source facts carried only inside the timeline read seam. */
export type ReportIssueSourceFence = Pick<ReportSourceFacts,
  'visibility' | 'publishedAt' | 'publicationSlug' | 'hasRoot' | 'allowSearchIndexing'
  | 'ownerAccountActive' | 'deleted' | 'seedExcluded' | 'contentRevision' | 'policyRevision' | 'updatedAt'
  | 'hiddenPublic'>;
export interface DigestControlDecision {
  readonly hidePublic: boolean;
  readonly delisted: boolean;
}
export interface DigestControlPort {
  readonly seriesControls: (
    seriesIds: readonly string[],
  ) => Promise<ReadonlyMap<string, DigestControlDecision>>;
  readonly editionControls: (
    editionIds: readonly string[],
  ) => Promise<ReadonlyMap<string, DigestControlDecision>>;
}
export interface ReportScheduleWritePort {
  readonly get: (seriesId: string) => Promise<import('../domain/types.js').DigestSchedule | null>;
  readonly upsert: (value: import('../domain/types.js').DigestSchedule) => Promise<import('../domain/types.js').DigestSchedule>;
  readonly disable: (seriesId: string, resourceRevision?: string) => Promise<void>;
}
export interface ReportRunLedgerPort {
  readonly upsertOccurrence: (value: Omit<import('../domain/types.js').DigestRun, 'id'> & { readonly scheduleRevision: string }) => Promise<import('../domain/types.js').DigestRun>;
  readonly claimDue: (now: Date, owner: string, leaseMs: number, limit: number) => Promise<readonly import('../domain/types.js').DigestRun[]>;
  readonly complete: (run: import('../domain/types.js').DigestRun, owner: string) => Promise<'succeeded'|'lease_lost'>;
  readonly retry: (run: import('../domain/types.js').DigestRun, owner: string, errorClass: string, nextAttemptAt: Date) => Promise<'retryable'|'lease_lost'>;
}
export interface ReportAuditEvent {
  readonly eventId?: string; readonly seriesId?: string; readonly editionId?: string;
  readonly principalId: string; readonly principalType: string; readonly action: string;
  readonly changed: Readonly<Record<string, unknown>>; readonly occurredAt: Date;
  readonly details?: Readonly<Record<string, unknown>>;
}
export interface ReportAuditPort { readonly append: (event: ReportAuditEvent) => Promise<void>; }
export type ReportOutboxEventType = 'reports.series.changed@1' | 'reports.edition.changed@1' | 'reports.source.invalidated@1' | 'reports.public_surface_purge.requested@1';
export interface ReportOutboxEvent {
  readonly outboxId: string; readonly eventId: string; readonly eventType: ReportOutboxEventType; readonly eventVersion: 1;
  readonly handlerName: string; readonly handlerMode: 'projection_latest_only' | 'delivery_each_event'; readonly occurredAt: Date;
  readonly payload: Readonly<Record<string, unknown>>;
}
export interface ReportOutboxPort { readonly append: (event: ReportOutboxEvent) => Promise<void>; }
const OUTBOX_KEYS: Record<ReportOutboxEventType, readonly string[]> = {
  'reports.series.changed@1': ['contentRevision', 'policyRevision', 'resourceRevision', 'seriesId', 'state', 'visibility'],
  'reports.edition.changed@1': ['editionId', 'resourceRevision', 'seriesId', 'state'],
  'reports.source.invalidated@1': ['collectionId', 'contentRevision', 'policyRevision', 'sourceEventType', 'sourceEventVersion'],
  'reports.public_surface_purge.requested@1': ['revision', 'seriesId', 'slug', 'surfaces'],
};
export function validateReportOutboxEvent(event: ReportOutboxEvent): ReportOutboxEvent {
  if (event.eventVersion !== 1 || !Object.prototype.hasOwnProperty.call(OUTBOX_KEYS, event.eventType)
    || event.handlerMode === undefined || typeof event.payload !== 'object' || event.payload === null
    || Array.isArray(event.payload)) throw new Error('invalid report outbox envelope');
  const keys = Object.keys(event.payload).sort(); const expected = [...OUTBOX_KEYS[event.eventType]].sort();
  if (keys.length !== expected.length || keys.some((key, i) => key !== expected[i])) throw new Error('report outbox payload must be closed');
  const expectedRoute = event.eventType === 'reports.source.invalidated@1'
    ? ['reports_source_invalidation', 'projection_latest_only']
    : event.eventType === 'reports.public_surface_purge.requested@1'
      ? ['reports_public_surface_purge', 'delivery_each_event']
      : ['reports_projection', 'projection_latest_only'];
  if (event.handlerName !== expectedRoute[0] || event.handlerMode !== expectedRoute[1]) {
    throw new Error('invalid report outbox route binding');
  }
  const values = event.payload as Record<string, unknown>;
  if (!isBoundedJsonValue(values)) throw new Error('report outbox payload must be bounded JSON');
  for (const key of keys) {
    if (values[key] === undefined || typeof values[key] === 'function' || values[key] instanceof Date) {
      throw new Error('report outbox payload must contain JSON values');
    }
  }
  return event;
}

function isBoundedJsonValue(value: unknown, depth = 0, budget = { remaining: 256 }): boolean {
  if (depth > 8 || budget.remaining-- <= 0) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value) && Number.isSafeInteger(value);
  if (Array.isArray(value)) return value.length <= 32 && value.every((item) => isBoundedJsonValue(item, depth + 1, budget));
  if (typeof value !== 'object' || value instanceof Date
    || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const entries = Object.entries(value as Record<string, unknown>);
  return entries.length <= 64 && entries.every(([key, item]) => key.length <= 128
    && isBoundedJsonValue(item, depth + 1, budget));
}
export function reportSourceInvalidatedEvent(ids: ReportIdPort, input: { collectionId: string; sourceEventType: string; sourceEventVersion: number; contentRevision: string; policyRevision: string; occurredAt: Date }): ReportOutboxEvent {
  const event: ReportOutboxEvent = { outboxId: ids.nextOutboxId(), eventId: ids.nextEventId(), eventType: 'reports.source.invalidated@1', eventVersion: 1, handlerName: 'reports_source_invalidation', handlerMode: 'projection_latest_only', occurredAt: input.occurredAt, payload: { collectionId: input.collectionId, sourceEventType: input.sourceEventType, sourceEventVersion: input.sourceEventVersion, contentRevision: input.contentRevision, policyRevision: input.policyRevision } };
  return validateReportOutboxEvent(event);
}
export function reportPublicSurfacePurgeEvent(ids: ReportIdPort, input: { seriesId: string; slug: string; revision: string; surfaces: readonly ('html'|'json'|'sitemap'|'og')[]; occurredAt: Date }): ReportOutboxEvent {
  if (!input.surfaces.length || input.surfaces.length > 4 || input.surfaces.some((surface, i, all) => !['html', 'json', 'sitemap', 'og'].includes(surface) || all.indexOf(surface) !== i)) throw new Error('invalid purge surfaces');
  const event: ReportOutboxEvent = { outboxId: ids.nextOutboxId(), eventId: ids.nextEventId(), eventType: 'reports.public_surface_purge.requested@1', eventVersion: 1, handlerName: 'reports_public_surface_purge', handlerMode: 'delivery_each_event', occurredAt: input.occurredAt, payload: { seriesId: input.seriesId, slug: input.slug, revision: input.revision, surfaces: [...input.surfaces] } };
  return validateReportOutboxEvent(event);
}
/** Public curator facts resolved for the anonymous report projection. The
    shape mirrors the identity-owned Profile discoverability projection; the
    internal owner subject never crosses into this DTO. */
export interface ReportOwnerProfileFacts {
  readonly profileId: string;
  readonly handle: string;
  readonly displayName: string;
  readonly avatarUrl: string | null;
}

export interface ReportOwnerProfileReadPort {
  readonly findManyByOwnerSubjectIds: (
    ownerSubjectIds: readonly string[],
  ) => Promise<ReadonlyMap<string, ReportOwnerProfileFacts>>;
}

export interface ReportTransactionPorts {
  readonly subscriptionExit?: { lockAccount(accountId:string):Promise<void>; unfollow(input:{accountId:string;subjectId:string;source:{sourceType:'digest_series';sourceId:string};previewId?:string}):Promise<void> };
  readonly receipts: ProductCommandReceiptPort; readonly series: ReportSeriesWritePort; readonly editions: ReportEditionWritePort;
  readonly members: ReportMemberWritePort; readonly follows?: ReportFollowWritePort; readonly source: ReportSourceReadPort;
  /** Official digest hide/delist decisions consumed by public/follower reads. */
  readonly digestControl?: DigestControlPort;
  /** Identity-owned owner projection for public report surfaces. */
  readonly ownerProfiles?: ReportOwnerProfileReadPort;
  readonly revision: RevisionTokenPort; readonly audit: ReportAuditPort; readonly outbox: ReportOutboxPort;
  readonly ids: ReportIdPort; readonly clock: ReportClock;
  /** True only when a deployed cache/CDN purge consumer is wired. */
  readonly publicSurfacePurgeEnabled?: boolean;
  readonly schedules?: ReportScheduleWritePort;
  readonly runs?: ReportRunLedgerPort;
}
export interface ReportUnitOfWork { readonly execute: <T>(callback: (ports: ReportTransactionPorts) => Promise<T>, options?: {isolationLevel?: 'read committed'|'repeatable read'}) => Promise<T>; }

/**
 * Credential-grant-scoped publish authority: produces a reports unit of work
 * whose transaction holds the grant row locks for the publish lifetime. Owned
 * by the reports facade so the auth application layer never imports reports.
 */
export type ReportPublishGuard = {
  reportsUnitOfWorkFor(input: {
    readonly seriesId: string;
    readonly editionId: string;
    readonly accountId: string;
    readonly credentialId: string;
    readonly scopes: readonly string[];
  }): ReportUnitOfWork;
};
export type ReportsTransactionPort = ReportTransactionPorts;
export type ReportTransactionPort = ReportTransactionPorts;
export type ReportReceiptPort = ProductCommandReceiptPort;
export type ReportAuditEventPort = ReportAuditPort;
export type ReportOutboxEventPort = ReportOutboxPort;
export type ReportMutationResult<T> =
  | { readonly kind: 'succeeded'; readonly value: T; readonly response?: ProductCommandResult }
  | { readonly kind: 'replay'; readonly result: ProductCommandResult }
  | { readonly kind: 'in_progress'; readonly retryAfterSeconds: number }
  | { readonly kind: 'reused' }
  | { readonly kind: 'expired'; readonly resultDigest: string | null };
