/**
 * CS-01 community target identity. The closed Target object is the durable
 * identity a client echoes back on writes: `collectionId`/`seriesId` are
 * explicit null unless the kind requires them, non-bookmark generation is the
 * `static-v1` constant, and a bookmark generation is an opaque server-minted
 * value that changes on every semantic source-URL mutation.
 */

export const COMMUNITY_TARGET_KINDS = [
  'collection',
  'bookmark',
  'digest_series',
  'digest_edition',
] as const;
export type CommunityTargetKind = (typeof COMMUNITY_TARGET_KINDS)[number];

export const COMMUNITY_STATIC_GENERATION = 'static-v1';
export const COMMUNITY_BOOKMARK_GENERATION_PREFIX = 'bm-gen-';

const OPAQUE_ID = /^[A-Za-z0-9._~-]{1,128}$/u;

export type CommunityVoteValue = -1 | 0 | 1;

export type CommunityTarget =
  | {
      readonly kind: 'collection';
      readonly id: string;
      readonly collectionId: null;
      readonly seriesId: null;
      readonly generation: typeof COMMUNITY_STATIC_GENERATION;
    }
  | {
      readonly kind: 'bookmark';
      readonly id: string;
      readonly collectionId: string;
      readonly seriesId: null;
      readonly generation: string;
    }
  | {
      readonly kind: 'digest_series';
      readonly id: string;
      readonly collectionId: null;
      readonly seriesId: null;
      readonly generation: typeof COMMUNITY_STATIC_GENERATION;
    }
  | {
      readonly kind: 'digest_edition';
      readonly id: string;
      readonly collectionId: null;
      readonly seriesId: string;
      readonly generation: typeof COMMUNITY_STATIC_GENERATION;
    };

/** Wire identity used for vote storage/counts (generation excluded). */
export interface CommunityTargetIdentity {
  readonly kind: CommunityTargetKind;
  readonly id: string;
  readonly collectionId: string | null;
  readonly seriesId: string | null;
}

export interface CommunityVoteState {
  readonly target: CommunityTarget;
  readonly up: number;
  readonly down: number;
  readonly myVote: CommunityVoteValue | null;
}

/**
 * Why `canComment` is false on a resolved target: `anonymous` when the
 * viewer is not signed in, `locked` when a curator or official action
 * locked the comment area. Null whenever `canComment` is true — the wire
 * always carries the field so a signed-in denial is explainable (R14-36).
 */
export type CommunityCommentDeniedReason = 'anonymous' | 'locked';

export interface CommunityTargetView {
  readonly target: CommunityTarget;
  readonly title: string;
  readonly href: string;
  readonly canVote: boolean;
  readonly canComment: boolean;
  readonly commentDeniedReason: CommunityCommentDeniedReason | null;
  readonly canCurateComments: boolean;
  readonly votes: CommunityVoteState;
}

export type CommunityTargetErrorCode =
  | 'invalid_request'
  | 'invalid_query'
  | 'resource_not_found'
  | 'insufficient_permission'
  | 'revision_conflict';

export class CommunityTargetError extends Error {
  constructor(readonly code: CommunityTargetErrorCode, message: string) {
    super(message);
    this.name = 'CommunityTargetError';
  }
}

/** Query shape for resolveCommunityTarget (no generation — the server returns it). */
export interface CommunityTargetQuery {
  readonly kind: CommunityTargetKind;
  readonly id: string;
  readonly collectionId?: string;
  readonly seriesId?: string;
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === 'string' && OPAQUE_ID.test(value);
}

function isBookmarkGeneration(value: unknown): value is string {
  return typeof value === 'string'
    && value.startsWith(COMMUNITY_BOOKMARK_GENERATION_PREFIX)
    && OPAQUE_ID.test(value);
}

function invalidQuery(message: string): CommunityTargetError {
  return new CommunityTargetError('invalid_query', message);
}

function invalidRequest(message: string): CommunityTargetError {
  return new CommunityTargetError('invalid_request', message);
}

/**
 * Parse the resolveCommunityTarget query object. Parent keys follow the
 * contract's conditional-required rules: bookmark requires collectionId and
 * forbids seriesId; digest_edition requires seriesId and forbids
 * collectionId; the other kinds forbid both. Null is never equivalent to
 * missing.
 */
export function parseCommunityTargetQuery(
  query: Readonly<Record<string, unknown>>,
): CommunityTargetQuery {
  const kind = query.kind;
  const id = query.id;
  const collectionId = query.collectionId;
  const seriesId = query.seriesId;
  if (typeof kind !== 'string'
      || !(COMMUNITY_TARGET_KINDS as readonly string[]).includes(kind)) {
    throw invalidQuery('The community target kind is invalid.');
  }
  if (!isOpaqueId(id)) throw invalidQuery('The community target id is invalid.');
  for (const [key, value] of [['collectionId', collectionId], ['seriesId', seriesId]] as const) {
    if (value !== undefined && !isOpaqueId(value)) {
      throw invalidQuery(`The community target ${key} is invalid.`);
    }
  }
  switch (kind as CommunityTargetKind) {
    case 'bookmark':
      if (collectionId === undefined) throw invalidQuery('A bookmark target requires collectionId.');
      if (seriesId !== undefined) throw invalidQuery('A bookmark target forbids seriesId.');
      return { kind: 'bookmark', id: id as string, collectionId: collectionId as string };
    case 'digest_edition':
      if (seriesId === undefined) throw invalidQuery('A digest_edition target requires seriesId.');
      if (collectionId !== undefined) throw invalidQuery('A digest_edition target forbids collectionId.');
      return { kind: 'digest_edition', id: id as string, seriesId: seriesId as string };
    case 'collection':
    case 'digest_series':
      if (collectionId !== undefined || seriesId !== undefined) {
        throw invalidQuery(`A ${kind} target forbids parent ids.`);
      }
      return { kind: kind as 'collection' | 'digest_series', id: id as string };
  }
}

/** Exact key set of the closed Target object, in canonical order. */
const TARGET_KEYS = ['collectionId', 'generation', 'id', 'kind', 'seriesId'] as const;

/**
 * Parse a supplied closed Target object (vote request body). Unknown keys
 * reject; the five required keys must all be present; parent/generation
 * values are validated per kind but NOT checked against the live target —
 * the caller compares the parsed identity against the resolved authority.
 */
export function parseCommunityTarget(value: unknown): CommunityTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidRequest('The community target must be an object.');
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== TARGET_KEYS.length || TARGET_KEYS.some((key) => !keys.includes(key))) {
    throw invalidRequest('The community target object is invalid.');
  }
  const kind = record.kind;
  const id = record.id;
  const collectionId = record.collectionId;
  const seriesId = record.seriesId;
  const generation = record.generation;
  if (typeof kind !== 'string'
      || !(COMMUNITY_TARGET_KINDS as readonly string[]).includes(kind)
      || !isOpaqueId(id)) {
    throw invalidRequest('The community target object is invalid.');
  }
  switch (kind as CommunityTargetKind) {
    case 'collection':
    case 'digest_series':
      if (collectionId !== null || seriesId !== null || generation !== COMMUNITY_STATIC_GENERATION) {
        throw invalidRequest('The community target object is invalid.');
      }
      return {
        kind: kind as 'collection' | 'digest_series',
        id: id as string,
        collectionId: null,
        seriesId: null,
        generation: COMMUNITY_STATIC_GENERATION,
      };
    case 'bookmark':
      if (!isOpaqueId(collectionId) || seriesId !== null || !isBookmarkGeneration(generation)) {
        throw invalidRequest('The community target object is invalid.');
      }
      return {
        kind: 'bookmark',
        id: id as string,
        collectionId: collectionId as string,
        seriesId: null,
        generation: generation as string,
      };
    case 'digest_edition':
      if (collectionId !== null || !isOpaqueId(seriesId) || generation !== COMMUNITY_STATIC_GENERATION) {
        throw invalidRequest('The community target object is invalid.');
      }
      return {
        kind: 'digest_edition',
        id: id as string,
        collectionId: null,
        seriesId: seriesId as string,
        generation: COMMUNITY_STATIC_GENERATION,
      };
  }
}

export function parseCommunityVoteValue(value: unknown): CommunityVoteValue {
  if (value !== -1 && value !== 0 && value !== 1) {
    throw invalidRequest('The community vote value must be -1, 0, or 1.');
  }
  return value;
}

export function communityTargetIdentity(target: CommunityTarget | CommunityTargetQuery): CommunityTargetIdentity {
  return {
    kind: target.kind,
    id: target.id,
    collectionId: 'collectionId' in target ? target.collectionId ?? null : null,
    seriesId: 'seriesId' in target ? target.seriesId ?? null : null,
  };
}

/**
 * Whether a supplied Target's parent identity and generation match the
 * currently resolved authority. A mismatch maps to 409 revision_conflict;
 * concealment (resolve returned null) maps to 404 before this is called.
 */
export function communityTargetMatches(
  supplied: CommunityTarget,
  resolved: CommunityTarget,
): boolean {
  return supplied.kind === resolved.kind
    && supplied.id === resolved.id
    && supplied.collectionId === resolved.collectionId
    && supplied.seriesId === resolved.seriesId
    && supplied.generation === resolved.generation;
}
