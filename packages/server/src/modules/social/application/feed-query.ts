import { SOCIAL_IDENTITY_MAX_LENGTH } from '../../commands/index.js';
import { closedTimelineSummary } from './closed-timeline-summary.js';
import {
  FEED_CURSOR_COMPARATOR_VERSION, FEED_CURSOR_PURPOSE, FEED_CURSOR_TTL_MS,
  FeedCursorError, type FeedCursorAfter, type FeedCursorKeyring,
} from './feed-cursor.js';

export const FEED_PAGE_DEFAULT_LIMIT = 30;
export const FEED_PAGE_MAX_LIMIT = 100;
const COLLECTION_TITLE_MAX_LENGTH = 512;
export type FeedKind = 'collection_change' | 'follow_activity';
export interface FeedProfileSummary { readonly profileId: string; readonly handle: string;
  readonly displayName: string; readonly avatarUrl: string | null; }
export interface FeedQueryFact {
  readonly feedItemId: string; readonly sourceEventId: string; readonly kind: FeedKind;
  readonly actor: FeedProfileSummary; readonly collectionId: string | null; readonly publishedAt: Date;
  readonly collectionTitle: string | null; readonly publicationSlug: string | null;
  readonly hiddenPublic: boolean;
  readonly summary: string | null;
}
export interface FeedPageReadInput {
  readonly principalId: string; readonly kind?: FeedKind; readonly limit: number;
  readonly after?: { readonly publishedAt: Date; readonly sourceEventId: string; readonly feedItemId: string };
  readonly signal?: AbortSignal;
}
export interface FeedPageReadPort { loadPage(input: FeedPageReadInput): Promise<readonly FeedQueryFact[]>; }
export interface FeedQueryInput { readonly principalId: string; readonly kind?: string; readonly limit?: number;
  readonly cursor?: string; readonly signal?: AbortSignal; }
export interface FeedItemDto { readonly feedItemId: string; readonly kind: FeedKind;
  readonly actor: FeedProfileSummary; readonly collectionId: string | null; readonly publishedAt: string;
  readonly collectionTitle: string | null; readonly publicationSlug: string | null;
  readonly summary: string | null;
  readonly hiddenPublic?: boolean; }
export interface FeedQueryPage { readonly items: readonly FeedItemDto[]; readonly nextCursor: string | null; }
export interface FeedQueryPorts { readonly reads: FeedPageReadPort; readonly cursors: FeedCursorKeyring;
  readonly clock: { now(): Promise<Date> }; }

export async function queryCurrentFeed(ports: FeedQueryPorts, input: FeedQueryInput): Promise<FeedQueryPage> {
  const principalId = identity(input.principalId); const now = await validClock(ports);
  const requestedFilter = normalizeKind(input.kind); let limit = normalizeLimit(input.limit);
  let filter = requestedFilter ?? ''; let after: FeedCursorAfter | undefined;
  let issuedAt = now.toISOString(); let expiresAt = new Date(now.getTime() + FEED_CURSOR_TTL_MS).toISOString();
  if (input.cursor !== undefined) {
    const cursor = ports.cursors.feed.verify(input.cursor, now);
    if (cursor.principalId !== principalId || cursor.filter !== filter
      || (input.limit !== undefined && cursor.limit !== limit)
      || cursor.comparatorVersion !== FEED_CURSOR_COMPARATOR_VERSION) throw new FeedCursorError();
    limit = cursor.limit; filter = cursor.filter; after = cursor.after;
    issuedAt = cursor.issuedAt; expiresAt = cursor.expiresAt;
  }
  const rows = await ports.reads.loadPage({ principalId, limit,
    ...(filter ? { kind: filter as FeedKind } : {}),
    ...(after ? { after: { publishedAt: new Date(after.publishedAt),
      sourceEventId: after.sourceEventId, feedItemId: after.feedItemId } } : {}),
    ...(input.signal ? { signal: input.signal } : {}) });
  if (rows.length > limit + 1) throw new Error('Feed read port exceeded limit+1 contract');
  assertRows(rows);
  const page = rows.slice(0, limit); const last = page.at(-1);
  const nextCursor = rows.length > limit && last ? ports.cursors.feed.seal({
    v: 1, purpose: FEED_CURSOR_PURPOSE, principalId, filter, limit,
    comparatorVersion: FEED_CURSOR_COMPARATOR_VERSION,
    after: { publishedAt: last.publishedAt.toISOString(), sourceEventId: last.sourceEventId,
      feedItemId: last.feedItemId }, issuedAt, expiresAt,
  }) : null;
  return Object.freeze({ items: Object.freeze(page.map((row) => {
    // #21: a hide_public collection keeps its Feed row as a tombstone — the
    // actor and timestamps stay real, the collection locators are replaced.
    const hidden = row.hiddenPublic && row.kind !== 'follow_activity';
    const collectionTitle = row.kind === 'follow_activity' ? null : hidden ? 'Collection hidden' : row.collectionTitle;
    const publicationSlug = row.kind === 'follow_activity' || hidden ? null : row.publicationSlug;
    return Object.freeze({
      feedItemId: row.feedItemId, kind: row.kind, actor: Object.freeze({ ...row.actor }),
      collectionId: row.collectionId, publishedAt: row.publishedAt.toISOString(),
      collectionTitle, publicationSlug, ...(hidden ? { hiddenPublic: true } : {}),
      summary: closedTimelineSummary(row.kind, collectionTitle !== null && publicationSlug !== null),
    });
  })), nextCursor });
}

function normalizeLimit(value: number | undefined): number { if (value === undefined) return FEED_PAGE_DEFAULT_LIMIT;
  if (!Number.isInteger(value) || value < 1 || value > FEED_PAGE_MAX_LIMIT) {
    throw new TypeError('Feed limit must be an integer from 1 to 100');
  } return value; }
function normalizeKind(value: string | undefined): FeedKind | undefined { if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new TypeError('invalid Feed kind');
  const normalized = value.trim().toLowerCase();
  if (normalized !== 'collection_change' && normalized !== 'follow_activity') throw new TypeError('invalid Feed kind');
  return normalized; }
function identity(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > SOCIAL_IDENTITY_MAX_LENGTH
    || value.trim() !== value) throw new TypeError('invalid Profile identity');
  return value;
}
async function validClock(ports: FeedQueryPorts): Promise<Date> {
  const now = await ports.clock.now();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new TypeError('invalid Feed query clock');
  }
  return now;
}
function assertRows(rows: readonly FeedQueryFact[]): void { for (let index = 0; index < rows.length; index += 1) {
  const row = rows[index]!; identity(row.feedItemId); identity(row.sourceEventId); identity(row.actor.profileId);
  if (!['collection_change', 'follow_activity'].includes(row.kind)
    || (row.collectionId !== null && !identity(row.collectionId))
    || !(row.publishedAt instanceof Date) || !Number.isFinite(row.publishedAt.getTime())
    || !/^[a-z0-9._~-]{1,64}$/u.test(row.actor.handle) || row.actor.handle === '.' || row.actor.handle === '..'
    || typeof row.actor.displayName !== 'string' || row.actor.displayName.length < 1
    || row.actor.displayName.length > 120 || !safeAvatar(row.actor.avatarUrl)
    || typeof row.hiddenPublic !== 'boolean'
    || !nullableTitle(row.collectionTitle) || !nullableSlug(row.publicationSlug)
    || !nullableSummary(row.summary)
    || (row.kind === 'follow_activity' && (row.collectionTitle !== null
      || row.publicationSlug !== null))) {
    throw new Error('invalid Feed safe projection');
  }
  const previous = rows[index - 1];
  if (previous && !(previous.publishedAt > row.publishedAt
    || (previous.publishedAt.getTime() === row.publishedAt.getTime()
      && (previous.sourceEventId > row.sourceEventId
        || (previous.sourceEventId === row.sourceEventId && previous.feedItemId > row.feedItemId))))) {
    throw new Error('Feed read port violated comparator');
  }
} }
function safeAvatar(value: unknown): value is string | null { if (value === null) return true;
  if (typeof value !== 'string') return false; try { const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password; } catch { return false; } }
function nullableTitle(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && value.length >= 1
    && value.length <= COLLECTION_TITLE_MAX_LENGTH);
}
function nullableSlug(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/u.test(value));
}
function nullableSummary(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && value.length >= 1 && value.length <= 200);
}
