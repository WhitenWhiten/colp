import { createHash } from 'node:crypto';
import {
  assessSharedExposureScope,
  assertSharedExposureScopeIneligible,
  type SharedExposureFactsPort,
} from '../modules/exposure/index.js';
import {
  getPublicProfileFacts,
  isCanonicalPublicProfileHandle,
  type PublicProfileFactsReadPort,
} from '../modules/identity/index.js';
import {
  PublicationDirectoryAnchorNotFoundError,
  PUBLIC_PROFILE_CURSOR_TTL_MS,
  type PublicationCursorKeyring,
  type PublicationDirectoryReadPort,
  type PublicationDirectoryRecord,
} from '../modules/publication/index.js';
import type { ProfileSitemapCandidateReadPort } from '../infrastructure/publication/index.js';

export { PUBLIC_PROFILE_CURSOR_TTL_MS };

export const PUBLIC_PROFILE_COLLECTION_DEFAULT_LIMIT = 20;
export const PUBLIC_PROFILE_COLLECTION_MAX_LIMIT = 100;
export const PUBLIC_PROFILE_COLLECTION_SORT = 'updatedAt DESC, id ASC' as const;

export interface ProfileSitemapRecord {
  readonly canonicalHandle: string;
  readonly updatedAt: string;
}

export function composeProfileSitemapQuery(ports: {
  readonly candidates: ProfileSitemapCandidateReadPort;
}) {
  return Object.freeze({
    async listIndexable(signal?: AbortSignal): Promise<readonly ProfileSitemapRecord[]> {
      const candidates = await ports.candidates.listCandidates(signal);
      const records: ProfileSitemapRecord[] = [];
      for (const candidate of candidates) {
        throwIfProfileSitemapAborted(signal);
        if (!isCanonicalPublicProfileHandle(candidate.canonicalHandle)) {
          throw new Error('Profile sitemap canonical handle is invalid');
        }
        records.push(Object.freeze({
          canonicalHandle: candidate.canonicalHandle,
          updatedAt: candidate.updatedAt,
        }));
      }
      return Object.freeze(records);
    },
  });
}

function throwIfProfileSitemapAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason;
}

export interface PublicProfileProjectionPorts {
  readonly profiles: PublicProfileFactsReadPort;
  /** Publication-owned authorization projection; always called as anonymous. */
  readonly collections: PublicationDirectoryReadPort;
  readonly cursors: PublicationCursorKeyring;
  /**
   * P4A-R06: the Profile projection depends on the exposure-eligibility gate
   * through the approved facts port (logical facts only); deny-by-default
   * means a private Attachment can never be advertised through a profile.
   */
  readonly sharedExposure: SharedExposureFactsPort;
  readonly accountControl?: {
    accountControl(accountId: string): Promise<{ readonly restrictPublication: boolean }>;
  };
}

export interface PublicProfileProjectionInput {
  readonly handle: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface PublicProfileProjection {
  readonly profile: Readonly<{
    profileId: string;
    handle: string;
    displayName: string;
    avatarUrl: string | null;
    about: string;
  }>;
  readonly collections: readonly Readonly<{
    id: string;
    slug: string;
    title: string;
    summary: string | null;
    kind: 'bookmarks' | 'reading_path' | 'knowledge_collection' | 'mixed';
    updatedAt: string;
  }>[];
  readonly page: Readonly<{
    cursor: string | null;
    hasMore: boolean;
  }>;
}

export class PublicProfileNotFoundError extends Error {
  readonly code = 'resource_not_found';
  constructor() {
    super('Public Profile was not found.');
    this.name = 'PublicProfileNotFoundError';
  }
}

export class PublicProfileCursorError extends Error {
  readonly code = 'invalid_cursor';
  constructor() {
    super('Public Profile cursor is invalid.');
    this.name = 'PublicProfileCursorError';
  }
}

export function composePublicProfileProjection(ports: PublicProfileProjectionPorts) {
  return Object.freeze({
    get: (input: PublicProfileProjectionInput) => getPublicProfileProjection(ports, input),
  });
}

export async function getPublicProfileProjection(
  ports: PublicProfileProjectionPorts,
  input: PublicProfileProjectionInput,
): Promise<PublicProfileProjection> {
  const handle = canonicalizeHandle(input.handle);
  const limit = input.limit ?? PUBLIC_PROFILE_COLLECTION_DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > PUBLIC_PROFILE_COLLECTION_MAX_LIMIT) {
    throw new RangeError('Public Profile collection limit must be between 1 and 100');
  }

  const cursorContext = Object.freeze({
    handle,
    limit,
    sort: PUBLIC_PROFILE_COLLECTION_SORT,
    comparatorVersion: 'public-profile-collections-v1',
  });
  let after;
  if (input.cursor !== undefined) {
    const verification = ports.cursors.profile.verify(input.cursor, cursorContext);
    if (!verification.valid) throw new PublicProfileCursorError();
    after = decodePosition(verification.nextPosition);
  }

  const facts = await getPublicProfileFacts(ports.profiles, handle);
  if (facts === null || facts.handle !== handle) throw new PublicProfileNotFoundError();
  if (ports.accountControl
    && (await ports.accountControl.accountControl(facts.profileId)).restrictPublication) {
    throw new PublicProfileNotFoundError();
  }

  let records: readonly PublicationDirectoryRecord[];
  try {
    records = await ports.collections.loadPage({
      principal: 'anonymous',
      filter: Object.freeze({ creator: facts.ownerSubjectId }),
      limit,
      ...(after ? { after } : {}),
    });
  } catch (error) {
    if (error instanceof PublicationDirectoryAnchorNotFoundError) throw new PublicProfileCursorError();
    throw error;
  }
  if (records.length > limit + 1) throw new Error('Publication Profile collection port exceeded its bounded page');
  for (const record of records) {
    if (record.ownerSubjectId !== facts.ownerSubjectId
        || record.visibility !== 'public'
        || record.protectedAuthorized) {
      throw new Error('Publication Profile collection port returned a non-public record');
    }
  }
  // Profile cards have no attachment candidates, regardless of collection history.
  for (const record of records) {
    const exposure = await assessSharedExposureScope(ports.sharedExposure, {
      collectionId: record.id, blobIds: [],
    });
    assertSharedExposureScopeIneligible(exposure);
  }

  const selected = records.slice(0, limit);
  const last = selected.at(-1);
  const nextCursor = records.length > limit && last
    ? ports.cursors.profile.sign({
        ...cursorContext,
        nextPosition: encodePosition(last),
      })
    : null;
  return Object.freeze({
    profile: Object.freeze({
      profileId: facts.profileId,
      handle: facts.handle,
      displayName: facts.displayName,
      avatarUrl: safeAvatarUrl(facts.avatarUrl),
      about: facts.about,
    }),
    collections: Object.freeze(selected.map((record) => Object.freeze({
      id: record.id,
      slug: record.publicationSlug,
      title: record.title,
      summary: record.summary,
      kind: record.kind,
      updatedAt: record.updatedAt,
    }))),
    page: Object.freeze({ cursor: nextCursor, hasMore: nextCursor !== null }),
  });
}

function canonicalizeHandle(value: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 192) {
    throw new PublicProfileNotFoundError();
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new PublicProfileNotFoundError();
  }
  const canonical = decoded.toLowerCase();
  if (!isCanonicalPublicProfileHandle(canonical)) throw new PublicProfileNotFoundError();
  return canonical;
}

function safeAvatarUrl(value: string | null): string | null {
  if (value === null || value === '') return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') return null;
    return parsed.href;
  } catch {
    return null;
  }
}

function encodePosition(record: PublicationDirectoryRecord): string {
  if (!/^-?\d{1,20}$/u.test(record.orderingUpdatedAtMicros)) {
    throw new Error('Publication Profile row has invalid ordering timestamp');
  }
  return `${BigInt(record.orderingUpdatedAtMicros).toString(36)}~${createHash('sha256').update(record.id).digest('hex').slice(0, 32)}`;
}

function decodePosition(value: string): { readonly orderingUpdatedAtMicros: string; readonly idLocator: string } {
  const [compactMicros, idLocator, ...extra] = value.split('~');
  if (extra.length > 0 || !compactMicros || !/^-?[0-9a-z]{1,16}$/u.test(compactMicros)
      || !idLocator || !/^[0-9a-f]{32}$/u.test(idLocator)) {
    throw new PublicProfileCursorError();
  }
  return Object.freeze({
    orderingUpdatedAtMicros: parseBase36(compactMicros).toString(10),
    idLocator,
  });
}

function parseBase36(value: string): bigint {
  const negative = value.startsWith('-');
  let result = 0n;
  for (const character of negative ? value.slice(1) : value) {
    result = result * 36n + BigInt(Number.parseInt(character, 36));
  }
  return negative ? -result : result;
}
