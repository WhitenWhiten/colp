import { randomUUID } from 'node:crypto';

export const INSIGHT_EVENT_TYPES = ['collection_view', 'preview_open', 'resource_open'] as const;
export type InsightEventType = (typeof INSIGHT_EVENT_TYPES)[number];

export const PUBLICATION_INSIGHT_RETENTION_DAYS = 90;
export const PUBLICATION_INSIGHT_PURGE_LIMIT = 5000;

export type InsightVisitor =
  | { readonly kind: 'anonymous'; readonly cookie: string }
  | { readonly kind: 'subject'; readonly subjectId: string };

export interface PublicationInsightCollectionFacts {
  readonly collectionId: string;
  readonly ownerSubjectId: string;
  readonly visibility: 'private' | 'protected' | 'public' | 'unlisted';
  readonly publicationSlug: string | null;
  readonly deletedAt: Date | null;
}

export interface PublicationInsightFactsPort {
  loadBySlug(slug: string): Promise<PublicationInsightCollectionFacts | null>;
  liveBookmarkExists(collectionId: string, nodeId: string): Promise<boolean>;
}

export interface PublicationInsightEventRecord {
  readonly id: string;
  readonly collectionId: string;
  readonly eventType: InsightEventType;
  readonly nodeId: string | null;
  readonly visitorHash: Uint8Array;
  readonly occurredAt: Date;
}

export interface PublicationInsightDailyIncrement {
  readonly collectionId: string;
  readonly eventType: InsightEventType;
  readonly nodeId: string | null;
  readonly occurredAt: Date;
}

export interface PublicationInsightPurgeCounts {
  readonly events: number;
  readonly daily: number;
}

export interface PublicationInsightStore {
  insertEvent(event: PublicationInsightEventRecord): Promise<void>;
  incrementDaily(input: PublicationInsightDailyIncrement): Promise<void>;
  /**
   * Bounded global retention delete. Worker-only; ingest must not call this
   * (it would hold the hot daily-count row across thousands of DELETEs).
   */
  purgeExpired(now: Date, limit?: number): Promise<PublicationInsightPurgeCounts>;
}

export interface VisitorHashPort {
  hashAnonymous(cookie: string): Uint8Array;
  hashSubject(subjectId: string): Uint8Array;
}

export interface RecordInsightEventPorts {
  readonly facts: PublicationInsightFactsPort;
  readonly store: PublicationInsightStore;
  readonly visitorHash: VisitorHashPort;
}

export interface RecordInsightEventInput {
  readonly slug: string;
  readonly eventType: InsightEventType;
  readonly nodeId?: string | null;
  readonly visitor: InsightVisitor;
  readonly occurredAt: Date;
}

export type RecordInsightEventResult =
  | { readonly kind: 'written' }
  | { readonly kind: 'skipped'; readonly reason: 'owner' | 'node' };

export class InsightConcealError extends Error {
  readonly code = 'conceal';
  constructor() {
    super('Publication insight target is not available.');
    this.name = 'InsightConcealError';
  }
}

export class InsightEventCardinalityError extends Error {
  readonly code = 'invalid_request';
  constructor(message: string) {
    super(message);
    this.name = 'InsightEventCardinalityError';
  }
}

export function isInsightEventType(value: string): value is InsightEventType {
  return (INSIGHT_EVENT_TYPES as readonly string[]).includes(value);
}

export function assertInsightEventCardinality(
  eventType: string,
  nodeId: string | null | undefined,
): asserts eventType is InsightEventType {
  if (!isInsightEventType(eventType)) {
    throw new InsightEventCardinalityError('Insight event type is not in the closed set.');
  }
  const hasNodeId = typeof nodeId === 'string';
  if (eventType === 'resource_open') {
    if (!hasNodeId || nodeId.length === 0) {
      throw new InsightEventCardinalityError('resource_open requires nodeId.');
    }
    return;
  }
  if (hasNodeId) {
    throw new InsightEventCardinalityError('collection_view and preview_open forbid nodeId.');
  }
}

export async function recordInsightEvent(
  ports: RecordInsightEventPorts,
  input: RecordInsightEventInput,
): Promise<RecordInsightEventResult> {
  assertInsightEventCardinality(input.eventType, input.nodeId);
  const facts = await ports.facts.loadBySlug(input.slug);
  if (!isPublishedLiveCollection(facts)) {
    throw new InsightConcealError();
  }
  if (input.visitor.kind === 'subject' && input.visitor.subjectId === facts.ownerSubjectId) {
    return Object.freeze({ kind: 'skipped', reason: 'owner' });
  }
  let nodeId: string | null = null;
  if (input.eventType === 'resource_open') {
    if (typeof input.nodeId !== 'string') {
      throw new InsightEventCardinalityError('resource_open requires nodeId.');
    }
    nodeId = input.nodeId;
    const live = await ports.facts.liveBookmarkExists(facts.collectionId, nodeId);
    if (!live) {
      return Object.freeze({ kind: 'skipped', reason: 'node' });
    }
  }
  const visitorHash = hashVisitor(ports.visitorHash, input.visitor);
  if (visitorHash.byteLength !== 32) {
    throw new Error('Visitor hash digest must be 32 bytes.');
  }
  const event: PublicationInsightEventRecord = {
    id: randomUUID(),
    collectionId: facts.collectionId,
    eventType: input.eventType,
    nodeId,
    visitorHash,
    occurredAt: input.occurredAt,
  };
  await ports.store.insertEvent(event);
  await ports.store.incrementDaily({
    collectionId: facts.collectionId,
    eventType: input.eventType,
    nodeId,
    occurredAt: input.occurredAt,
  });
  // Retention DELETE is worker-owned; ingest stays INSERT + UPSERT only.
  return Object.freeze({ kind: 'written' });
}

function isPublishedLiveCollection(
  facts: PublicationInsightCollectionFacts | null,
): facts is PublicationInsightCollectionFacts {
  if (facts === null || facts.deletedAt !== null) return false;
  if (facts.visibility !== 'public' && facts.visibility !== 'unlisted') return false;
  return typeof facts.publicationSlug === 'string' && facts.publicationSlug.length > 0;
}

function hashVisitor(port: VisitorHashPort, visitor: InsightVisitor): Uint8Array {
  return visitor.kind === 'anonymous'
    ? port.hashAnonymous(visitor.cookie)
    : port.hashSubject(visitor.subjectId);
}
