import { SOCIAL_IDENTITY_MAX_LENGTH } from '../../commands/index.js';
import { closedTimelineSummary } from './closed-timeline-summary.js';
import {
  PUBLIC_ACTIVITY_CURSOR_COMPARATOR_VERSION, PUBLIC_ACTIVITY_CURSOR_PURPOSE, PUBLIC_ACTIVITY_CURSOR_TTL_MS,
  PublicActivityCursorError, type PublicActivityCursorAfter, type PublicActivityCursorKeyring,
} from './public-activity-cursor.js';

export const PUBLIC_ACTIVITY_PAGE_DEFAULT_LIMIT = 30;
export const PUBLIC_ACTIVITY_PAGE_MAX_LIMIT = 100;
const COLLECTION_TITLE_MAX_LENGTH = 512;
const PUBLICATION_SLUG = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/u;

export class PublicActivityNotFoundError extends Error {
  readonly code = 'resource_not_found' as const;
  constructor() {
    super('Public Profile was not found.');
    this.name = 'PublicActivityNotFoundError';
  }
}

export type PublicActivityKind = 'collection_change';
export interface PublicActivityQueryFact {
  readonly activityId: string;
  readonly sourceEventId: string;
  readonly kind: PublicActivityKind;
  readonly collectionId: string;
  readonly collectionTitle: string;
  readonly publicationSlug: string;
  readonly publishedAt: Date;
}
export interface PublicActivityPageReadInput {
  readonly actorProfileId: string;
  readonly limit: number;
  readonly after?: {
    readonly publishedAt: Date;
    readonly sourceEventId: string;
    readonly activityId: string;
  };
  readonly signal?: AbortSignal;
}
export type PublicActivityActorLookupResult =
  | { readonly found: false }
  | { readonly found: true; readonly actorProfileId: string };
export interface PublicActivityPageReadPort {
  resolveActor(handle: string, signal?: AbortSignal): Promise<PublicActivityActorLookupResult>;
  loadPage(input: PublicActivityPageReadInput): Promise<readonly PublicActivityQueryFact[]>;
}
export interface PublicActivityQueryInput {
  readonly handle: string;
  readonly limit?: number;
  readonly cursor?: string;
  readonly signal?: AbortSignal;
}
export interface PublicActivityItemDto {
  readonly activityId: string;
  readonly kind: PublicActivityKind;
  readonly collectionId: string;
  readonly collectionTitle: string | null;
  readonly publicationSlug: string | null;
  readonly publishedAt: string;
  readonly summary: string | null;
}
export interface PublicActivityQueryPage {
  readonly items: readonly PublicActivityItemDto[];
  readonly nextCursor: string | null;
}
export interface PublicActivityQueryPorts {
  readonly reads: PublicActivityPageReadPort;
  readonly cursors: PublicActivityCursorKeyring;
  readonly clock: { now(): Promise<Date> };
}

export async function queryCurrentPublicActivity(
  ports: PublicActivityQueryPorts,
  input: PublicActivityQueryInput,
): Promise<PublicActivityQueryPage> {
  const handle = canonicalizeHandle(input.handle);
  const actor = await ports.reads.resolveActor(handle, input.signal);
  if (!actor.found) throw new PublicActivityNotFoundError();
  const principalId = actor.actorProfileId;
  const now = await validClock(ports);
  let limit = normalizeLimit(input.limit);
  const filter = '';
  let after: PublicActivityCursorAfter | undefined;
  let issuedAt = now.toISOString();
  let expiresAt = new Date(now.getTime() + PUBLIC_ACTIVITY_CURSOR_TTL_MS).toISOString();
  if (input.cursor !== undefined) {
    const cursor = ports.cursors.activity.verify(input.cursor, now);
    if (cursor.principalId !== principalId || cursor.filter !== filter
      || (input.limit !== undefined && cursor.limit !== limit)
      || cursor.comparatorVersion !== PUBLIC_ACTIVITY_CURSOR_COMPARATOR_VERSION) {
      throw new PublicActivityCursorError();
    }
    limit = cursor.limit;
    after = cursor.after;
    issuedAt = cursor.issuedAt;
    expiresAt = cursor.expiresAt;
  }
  const rows = await ports.reads.loadPage({
    actorProfileId: principalId,
    limit,
    ...(after ? {
      after: {
        publishedAt: new Date(after.publishedAt),
        sourceEventId: after.sourceEventId,
        activityId: after.activityId,
      },
    } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  });
  if (rows.length > limit + 1) throw new Error('public Activity read port exceeded limit+1 contract');
  assertRows(rows);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const nextCursor = rows.length > limit && last ? ports.cursors.activity.seal({
    v: 1, purpose: PUBLIC_ACTIVITY_CURSOR_PURPOSE, principalId, filter, limit,
    comparatorVersion: PUBLIC_ACTIVITY_CURSOR_COMPARATOR_VERSION,
    after: {
      publishedAt: last.publishedAt.toISOString(),
      sourceEventId: last.sourceEventId,
      activityId: last.activityId,
    },
    issuedAt, expiresAt,
  }) : null;
  return Object.freeze({
    items: Object.freeze(page.map((row) => Object.freeze({
      activityId: row.activityId,
      kind: row.kind,
      collectionId: row.collectionId,
      collectionTitle: row.collectionTitle,
      publicationSlug: row.publicationSlug,
      publishedAt: row.publishedAt.toISOString(),
      summary: closedTimelineSummary(row.kind, true),
    }))),
    nextCursor,
  });
}

function canonicalizeHandle(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 64 || value.includes('%')) {
    throw new PublicActivityNotFoundError();
  }
  const handle = value.toLocaleLowerCase('und');
  if (!/^[a-z0-9._~-]{1,64}$/u.test(handle) || handle === '.' || handle === '..') {
    throw new PublicActivityNotFoundError();
  }
  return handle;
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined) return PUBLIC_ACTIVITY_PAGE_DEFAULT_LIMIT;
  if (!Number.isInteger(value) || value < 1 || value > PUBLIC_ACTIVITY_PAGE_MAX_LIMIT) {
    throw new TypeError('public Activity limit must be an integer from 1 to 100');
  }
  return value;
}

async function validClock(ports: PublicActivityQueryPorts): Promise<Date> {
  const now = await ports.clock.now();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new TypeError('invalid public Activity query clock');
  }
  return now;
}

function identity(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > SOCIAL_IDENTITY_MAX_LENGTH
    || value.trim() !== value) throw new TypeError('invalid public Activity identity');
  return value;
}

function assertRows(rows: readonly PublicActivityQueryFact[]): void {
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    identity(row.activityId); identity(row.sourceEventId); identity(row.collectionId);
    if (row.kind !== 'collection_change'
      || !(row.publishedAt instanceof Date) || !Number.isFinite(row.publishedAt.getTime())
      || typeof row.collectionTitle !== 'string' || row.collectionTitle.length < 1
      || row.collectionTitle.length > COLLECTION_TITLE_MAX_LENGTH
      || typeof row.publicationSlug !== 'string' || !PUBLICATION_SLUG.test(row.publicationSlug)) {
      throw new Error('invalid public Activity safe projection');
    }
    const previous = rows[index - 1];
    if (previous && !(previous.publishedAt > row.publishedAt
      || (previous.publishedAt.getTime() === row.publishedAt.getTime()
        && (previous.sourceEventId > row.sourceEventId
          || (previous.sourceEventId === row.sourceEventId && previous.activityId > row.activityId))))) {
      throw new Error('public Activity read port violated comparator');
    }
  }
}
