import { SOCIAL_IDENTITY_MAX_LENGTH } from '../../commands/index.js';
import type { CollectionFollowStateResult } from './collection-follow-command.js';
import {
  FOLLOWED_COLLECTIONS_CURSOR_COMPARATOR_VERSION,
  FOLLOWED_COLLECTIONS_CURSOR_PURPOSE,
  FOLLOWED_COLLECTIONS_CURSOR_TTL_MS,
  FollowedCollectionsCursorError,
  type FollowedCollectionsCursorAfter,
  type FollowedCollectionsCursorKeyring,
} from './followed-collections-cursor.js';

const OPAQUE_ID = /^[A-Za-z0-9._~-]{1,128}$/u;
const KINDS = new Set(['bookmarks', 'reading_path', 'knowledge_collection', 'mixed']);

export const FOLLOWED_COLLECTIONS_PAGE_DEFAULT_LIMIT = 20;
export const FOLLOWED_COLLECTIONS_PAGE_MAX_LIMIT = 50;

export interface CollectionFollowStateReadInput {
  readonly actorProfileId: string;
  readonly actorSubjectId: string;
  readonly collectionId: string;
}

export interface CollectionFollowStateReadPort {
  readState(input: CollectionFollowStateReadInput): Promise<CollectionFollowStateResult | null>;
}

export interface FollowedCollectionOwner {
  readonly profileId: string;
  readonly handle: string;
  readonly displayName: string;
  readonly avatarUrl: string | null;
}

/**
 * `unavailable` = the follow row survives while the target cannot be opened
 * (soft-deleted, no longer public/unlisted, or the owner account is inactive).
 * Hard deletion cascades the follow row away, so it never surfaces here.
 * Privacy: an unavailable row must never carry a summary — the title and the
 * immutable publication slug were known at follow time, the summary may have
 * been rewritten after the collection went dark.
 */
export type FollowedCollectionAvailability = 'available' | 'unavailable';

export interface FollowedCollectionFact {
  readonly collectionId: string;
  readonly slug: string;
  readonly title: string;
  readonly summary: string | null;
  readonly kind: 'bookmarks' | 'reading_path' | 'knowledge_collection' | 'mixed';
  readonly owner: FollowedCollectionOwner;
  readonly updatedAt: Date;
  readonly followedAt: Date;
  readonly availability: FollowedCollectionAvailability;
}

export interface FollowedCollectionsReadInput {
  readonly followerProfileId: string;
  readonly limit: number;
  readonly after?: { readonly followedAt: Date; readonly collectionId: string };
  readonly signal?: AbortSignal;
}

export interface FollowedCollectionsReadPort {
  listFollowedCollections(input: FollowedCollectionsReadInput): Promise<readonly FollowedCollectionFact[]>;
}

export interface FollowedCollectionsQueryInput {
  readonly principalId: string;
  readonly limit?: number;
  readonly cursor?: string;
  readonly signal?: AbortSignal;
}

export interface FollowedCollectionsQueryPage {
  readonly items: readonly FollowedCollectionFact[];
  readonly nextCursor: string | null;
}

export interface FollowedCollectionsQueryPorts {
  readonly reads: FollowedCollectionsReadPort;
  readonly cursors: FollowedCollectionsCursorKeyring;
  readonly clock: { now(): Promise<Date> };
}

export interface CollectionFollowQueryPorts {
  readonly reads: CollectionFollowStateReadPort;
}

export interface CollectionFollowCombinedQueryPorts
  extends CollectionFollowQueryPorts, FollowedCollectionsQueryPorts {
  readonly reads: CollectionFollowStateReadPort & FollowedCollectionsReadPort;
}

export async function queryCollectionFollowState(
  ports: CollectionFollowQueryPorts,
  input: CollectionFollowStateReadInput,
): Promise<CollectionFollowStateResult | null> {
  const actorProfileId = identity(input.actorProfileId, 'Profile');
  const actorSubjectId = identity(input.actorSubjectId, 'Subject');
  if (typeof input.collectionId !== 'string' || !OPAQUE_ID.test(input.collectionId)) {
    throw new TypeError('invalid Collection identity');
  }
  return ports.reads.readState({
    actorProfileId,
    actorSubjectId,
    collectionId: input.collectionId,
  });
}

export async function queryFollowedCollections(
  ports: FollowedCollectionsQueryPorts,
  input: FollowedCollectionsQueryInput,
): Promise<FollowedCollectionsQueryPage> {
  const principalId = identity(input.principalId, 'Profile');
  const now = await validClock(ports);
  let limit = normalizeLimit(input.limit);
  let after: FollowedCollectionsCursorAfter | undefined;
  let issuedAt = now.toISOString();
  let expiresAt = new Date(now.getTime() + FOLLOWED_COLLECTIONS_CURSOR_TTL_MS).toISOString();
  if (input.cursor !== undefined) {
    const cursor = ports.cursors.followedCollections.verify(input.cursor, now);
    if (cursor.principalId !== principalId
      || cursor.purpose !== FOLLOWED_COLLECTIONS_CURSOR_PURPOSE
      || (input.limit !== undefined && cursor.limit !== limit)
      || cursor.comparatorVersion !== FOLLOWED_COLLECTIONS_CURSOR_COMPARATOR_VERSION) {
      throw new FollowedCollectionsCursorError();
    }
    limit = cursor.limit;
    after = cursor.after;
    issuedAt = cursor.issuedAt;
    expiresAt = cursor.expiresAt;
  }
  const rows = await ports.reads.listFollowedCollections({
    followerProfileId: principalId,
    limit,
    ...(after ? { after: { followedAt: new Date(after.followedAt), collectionId: after.collectionId } } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  });
  if (rows.length > limit + 1) throw new Error('Followed collections read port exceeded limit+1 contract');
  assertRows(rows);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const nextCursor = rows.length > limit && last
    ? ports.cursors.followedCollections.seal({
      v: 1,
      purpose: FOLLOWED_COLLECTIONS_CURSOR_PURPOSE,
      principalId,
      limit,
      comparatorVersion: FOLLOWED_COLLECTIONS_CURSOR_COMPARATOR_VERSION,
      after: { followedAt: last.followedAt.toISOString(), collectionId: last.collectionId },
      issuedAt,
      expiresAt,
    })
    : null;
  return Object.freeze({
    items: Object.freeze(page.map((row) => Object.freeze({
      collectionId: row.collectionId,
      slug: row.slug,
      title: row.title,
      summary: row.summary,
      kind: row.kind,
      owner: Object.freeze({ ...row.owner }),
      updatedAt: row.updatedAt,
      followedAt: row.followedAt,
      availability: row.availability,
    }))),
    nextCursor,
  });
}

function identity(value: string, label: string): string {
  if (typeof value !== 'string' || !value || value.trim() !== value
      || value.length > SOCIAL_IDENTITY_MAX_LENGTH) {
    throw new TypeError(`invalid ${label} identity`);
  }
  return value;
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined) return FOLLOWED_COLLECTIONS_PAGE_DEFAULT_LIMIT;
  if (!Number.isInteger(value) || value < 1 || value > FOLLOWED_COLLECTIONS_PAGE_MAX_LIMIT) {
    throw new TypeError('Followed collections limit must be an integer from 1 to 50');
  }
  return value;
}

async function validClock(ports: FollowedCollectionsQueryPorts): Promise<Date> {
  const now = await ports.clock.now();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new TypeError('invalid Followed collections query clock');
  }
  return now;
}

function assertRows(rows: readonly FollowedCollectionFact[]): void {
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    if (!OPAQUE_ID.test(row.collectionId) || typeof row.slug !== 'string' || !row.slug
      || typeof row.title !== 'string' || row.title.length < 1 || row.title.length > 200
      || (row.summary !== null && (typeof row.summary !== 'string' || row.summary.length > 2000))
      || (row.availability !== 'available' && row.availability !== 'unavailable')
      || (row.availability === 'unavailable' && row.summary !== null)
      || !KINDS.has(row.kind)
      || !(row.updatedAt instanceof Date) || !Number.isFinite(row.updatedAt.getTime())
      || !(row.followedAt instanceof Date) || !Number.isFinite(row.followedAt.getTime())
      || !identitySafe(row.owner.profileId)
      || !safeHandle(row.owner.handle)
      || typeof row.owner.displayName !== 'string'
      || row.owner.displayName.length < 1 || row.owner.displayName.length > 120
      || !safeAvatarUrl(row.owner.avatarUrl)) {
      throw new Error('invalid Followed Collection projection');
    }
    const previous = rows[index - 1];
    if (previous && !(previous.followedAt > row.followedAt
      || (previous.followedAt.getTime() === row.followedAt.getTime()
        && previous.collectionId > row.collectionId))) {
      throw new Error('Followed collections read port violated comparator');
    }
  }
}

function identitySafe(value: string): boolean {
  return typeof value === 'string' && !!value && value.trim() === value
    && value.length <= SOCIAL_IDENTITY_MAX_LENGTH;
}

function safeHandle(value: unknown): value is string {
  return typeof value === 'string' && value !== '.' && value !== '..'
    && /^[a-z0-9._~-]{1,64}$/u.test(value);
}

function safeAvatarUrl(value: unknown): value is string | null {
  if (value === null) return true;
  if (typeof value !== 'string') return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && parsed.username === '' && parsed.password === '';
  } catch {
    return false;
  }
}
