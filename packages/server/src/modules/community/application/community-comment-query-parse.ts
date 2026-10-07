/**
 * CS-03 community comments and replies: closed-query parsing shared by the
 * list and replies read operations in `community-comment-query.ts`.
 *
 * Both endpoints accept only the contract-declared keys; unknown keys,
 * malformed values, and forbidden parent-id combinations are `invalid_query`
 * while a syntactically unacceptable cursor is `invalid_cursor`. Null is
 * never equivalent to missing. Normalized results are frozen.
 */
import {
  COMMUNITY_COMMENT_MAX_LIMIT,
  communityCommentInvalidCursor,
} from './community-comment-cursor.js';
import {
  COMMUNITY_STATIC_GENERATION,
  COMMUNITY_TARGET_KINDS,
  type CommunityTargetKind,
} from './community-target.js';
import { CommunityCommentError } from './community-comment.js';

export const COMMUNITY_COMMENT_DEFAULT_LIMIT = 20;

const CURSOR_TEXT = /^[A-Za-z0-9._~-]{1,2048}$/u;
const OPAQUE_ID = /^[A-Za-z0-9._~-]{1,128}$/u;
const BASE10 = /^[0-9]+$/u;

/** Normalized list query; parent fields are null when not supplied. */
export interface CommunityCommentsQuery {
  readonly kind: CommunityTargetKind;
  readonly id: string;
  readonly collectionId: string | null;
  readonly seriesId: string | null;
  readonly generation: string;
  readonly limit: number;
  readonly cursor: string | null;
}

/** Normalized replies query (path commentId is validated separately). */
export interface CommunityCommentRepliesQuery {
  readonly limit: number;
  readonly cursor: string | null;
}

function invalidQuery(message: string): CommunityCommentError {
  return new CommunityCommentError('invalid_query', message);
}

function normalizeLimit(value: unknown, name: string): number {
  if (value === undefined) return COMMUNITY_COMMENT_DEFAULT_LIMIT;
  let parsed: number;
  if (typeof value === 'string') {
    if (!BASE10.test(value)) throw invalidQuery(`The community comments ${name} is invalid.`);
    parsed = Number.parseInt(value, 10);
  } else if (typeof value === 'number' && Number.isInteger(value)) {
    parsed = value;
  } else {
    throw invalidQuery(`The community comments ${name} is invalid.`);
  }
  if (parsed < 1 || parsed > COMMUNITY_COMMENT_MAX_LIMIT) {
    throw invalidQuery(`The community comments ${name} is invalid.`);
  }
  return parsed;
}

function normalizeCursor(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !CURSOR_TEXT.test(value)) {
    throw communityCommentInvalidCursor();
  }
  return value;
}

const LIST_QUERY_KEYS = ['collectionId', 'cursor', 'generation', 'id', 'kind', 'limit', 'seriesId'] as const;

/**
 * Parse the closed list query. `kind`, `id`, and `generation` are required;
 * `collectionId` is required exactly for bookmark and `seriesId` exactly for
 * digest_edition — every other combination forbids the parent key. A
 * non-bookmark generation must be the literal `static-v1` (the schema
 * `const`); a bookmark generation is any opaque id later compared against
 * the resolved authority. Null is never equivalent to missing.
 */
export function parseCommunityCommentsQuery(
  raw: Readonly<Record<string, unknown>>,
): CommunityCommentsQuery {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw invalidQuery('The community comments query is invalid.');
  }
  for (const key of Object.keys(raw)) {
    if (!(LIST_QUERY_KEYS as readonly string[]).includes(key)) {
      throw invalidQuery('The community comments query is invalid.');
    }
  }
  const kind = raw.kind;
  if (typeof kind !== 'string'
      || !(COMMUNITY_TARGET_KINDS as readonly string[]).includes(kind)) {
    throw invalidQuery('The community comments kind is invalid.');
  }
  const id = raw.id;
  if (typeof id !== 'string' || !OPAQUE_ID.test(id)) {
    throw invalidQuery('The community comments id is invalid.');
  }
  const generation = raw.generation;
  if (typeof generation !== 'string' || generation.length < 1 || generation.length > 128) {
    throw invalidQuery('The community comments generation is invalid.');
  }
  if (kind === 'bookmark') {
    if (!OPAQUE_ID.test(generation)) {
      throw invalidQuery('The community comments generation is invalid.');
    }
  } else if (generation !== COMMUNITY_STATIC_GENERATION) {
    throw invalidQuery('The community comments generation is invalid.');
  }
  const collectionId = raw.collectionId;
  const seriesId = raw.seriesId;
  if (collectionId !== undefined
      && (typeof collectionId !== 'string' || !OPAQUE_ID.test(collectionId))) {
    throw invalidQuery('The community comments collectionId is invalid.');
  }
  if (seriesId !== undefined
      && (typeof seriesId !== 'string' || !OPAQUE_ID.test(seriesId))) {
    throw invalidQuery('The community comments seriesId is invalid.');
  }
  let normalizedCollectionId: string | null = null;
  let normalizedSeriesId: string | null = null;
  switch (kind as CommunityTargetKind) {
    case 'bookmark':
      if (collectionId === undefined) throw invalidQuery('A bookmark comments query requires collectionId.');
      if (seriesId !== undefined) throw invalidQuery('A bookmark comments query forbids seriesId.');
      normalizedCollectionId = collectionId as string;
      break;
    case 'digest_edition':
      if (seriesId === undefined) throw invalidQuery('A digest_edition comments query requires seriesId.');
      if (collectionId !== undefined) throw invalidQuery('A digest_edition comments query forbids collectionId.');
      normalizedSeriesId = seriesId as string;
      break;
    default:
      if (collectionId !== undefined || seriesId !== undefined) {
        throw invalidQuery(`A ${kind} comments query forbids parent ids.`);
      }
  }
  return Object.freeze<CommunityCommentsQuery>({
    kind: kind as CommunityTargetKind,
    id,
    collectionId: normalizedCollectionId,
    seriesId: normalizedSeriesId,
    generation,
    limit: normalizeLimit(raw.limit, 'limit'),
    cursor: normalizeCursor(raw.cursor),
  });
}

const REPLIES_QUERY_KEYS = ['cursor', 'limit'] as const;

/** Parse the closed replies query {limit, cursor}; both are optional. */
export function parseCommunityCommentRepliesQuery(
  raw: Readonly<Record<string, unknown>>,
): CommunityCommentRepliesQuery {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw invalidQuery('The community comment replies query is invalid.');
  }
  for (const key of Object.keys(raw)) {
    if (!(REPLIES_QUERY_KEYS as readonly string[]).includes(key)) {
      throw invalidQuery('The community comment replies query is invalid.');
    }
  }
  return Object.freeze<CommunityCommentRepliesQuery>({
    limit: normalizeLimit(raw.limit, 'limit'),
    cursor: normalizeCursor(raw.cursor),
  });
}
