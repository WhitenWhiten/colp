import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../../bootstrap/config.js';
import {
  EXPLORE_UNKNOWN_CREATOR_ID,
  type ExploreCreatorFacts,
  type ExploreCreatorsQueryPort,
  type IdentityUnitOfWork,
} from '../../modules/identity/index.js';
import {
  isExplorePageSort,
  type ExplorePagePosition,
  type ExplorePageReadPort,
  type ExplorePageRecord,
  type ExplorePageSort,
} from '../../modules/publication/index.js';
import type { SearchRateLimiter } from '../../infrastructure/rate-limit/index.js';
import {
  admitExploreDirectoryRateLimit,
  exploreDirectoryAnonymousSubject,
} from './explore-directory-rate-limit.js';
import { loadEligibleExplorePage } from './explore-preference-page.js';
import { ProductHttpError } from '../product-error.js';
import { productErrorStatus } from '../product-codes.js';
import { productRouteMetadata } from '../product-route-manifest.js';

/**
 * Explore 产品路由：公开收藏夹目录（/api/v1/explore/collections）。
 *
 * 消费 Explore 专用读端口（viewCount + SQL keyset sort），再补 creators。
 * 游标为产品层不透明 base64url JSON（sort + 排序键 + collection id），
 * 与协议目录游标（keyring 签名）互不干扰。
 */

const EXPLORE_ROUTE = '/api/v1/explore/collections';
const EXPLORE_DEFAULT_LIMIT = 24;
const EXPLORE_MAX_LIMIT = 100;

export const EXPLORE_OPERATION_IDS = [
  'listExploreCollections',
  'headExploreCollections',
] as const;

export interface ExploreCollectionItem {
  readonly id: string;
  readonly title: string;
  readonly summary: string | null;
  readonly kind: string;
  readonly tags: readonly string[];
  readonly language?: string | null;
  readonly nodeCount: number;
  readonly viewCount: number;
  readonly updatedAt: string;
  /** Null when the row is a moderation tombstone (#21). */
  readonly publicationSlug: string | null;
  readonly visibility: string;
  /** True when an official hide_public action is in force on the collection. */
  readonly hiddenPublic?: boolean;
  /** Latest public collection tldr (curator recommendation), or null. */
  readonly curatorNote: string | null;
  readonly creators: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly handle: string | null;
    readonly avatar: string | null;
  }>;
}

/**
 * Batch public collection tldr lookup (BE-02). Only visibility=public rows
 * are exposed by the underlying port; private marks never reach this route.
 */
export interface ExploreCollectionMarksPort {
  findPublicMarksForCollections(
    collectionIds: readonly string[],
  ): Promise<ReadonlyMap<string, string>>;
}

export interface ExploreCollectionsResponse {
  readonly items: readonly ExploreCollectionItem[];
  readonly nextCursor: string | null;
}

interface ExploreCursorPayload {
  readonly sort?: unknown;
  readonly micros?: unknown;
  readonly id?: unknown;
  readonly viewCount?: unknown;
  readonly nodeCount?: unknown;
}

function linksSortCount(record: ExplorePageRecord): number {
  return record.orderingNodeCount;
}

function encodeCursor(record: ExplorePageRecord, sort: ExplorePageSort): string {
  const payload = sort === 'popular'
    ? { sort, viewCount: record.viewCount, micros: record.orderingUpdatedAtMicros, id: record.id }
    : sort === 'links'
      ? { sort, nodeCount: linksSortCount(record), micros: record.orderingUpdatedAtMicros, id: record.id }
      : { sort: 'updated', micros: record.orderingUpdatedAtMicros, id: record.id };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string, sort: ExplorePageSort): ExplorePagePosition | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as ExploreCursorPayload;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    if (typeof parsed.micros !== 'string' || typeof parsed.id !== 'string') return null;
    if (!/^-?\d{1,20}$/u.test(parsed.micros) || parsed.id.length === 0) return null;
    if (parsed.sort === undefined) {
      if (sort !== 'updated') return null;
      return { micros: parsed.micros, id: parsed.id };
    }
    if (parsed.sort !== sort) return null;
    if (sort === 'popular') {
      if (!Number.isInteger(parsed.viewCount) || (parsed.viewCount as number) < 0) return null;
      return { micros: parsed.micros, id: parsed.id, viewCount: parsed.viewCount as number };
    }
    if (sort === 'links') {
      if (!Number.isInteger(parsed.nodeCount) || (parsed.nodeCount as number) < 0) return null;
      return { micros: parsed.micros, id: parsed.id, nodeCount: parsed.nodeCount as number };
    }
    return { micros: parsed.micros, id: parsed.id };
  } catch {
    return null;
  }
}

function parseLimit(raw: unknown): number {
  if (typeof raw !== 'string' || raw === '') return EXPLORE_DEFAULT_LIMIT;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > EXPLORE_MAX_LIMIT) {
    throw new ProductHttpError({
      statusCode: productErrorStatus('invalid_query'),
      code: 'invalid_query',
      message: 'The Explore limit is invalid.',
    });
  }
  return limit;
}

function parseSort(raw: unknown): ExplorePageSort {
  if (typeof raw !== 'string' || raw === '') return 'updated';
  if (!isExplorePageSort(raw)) {
    throw new ProductHttpError({
      statusCode: productErrorStatus('invalid_query'),
      code: 'invalid_query',
      message: 'The Explore sort is invalid.',
    });
  }
  return raw;
}

function parseStringParam(raw: unknown, maxLength: number): string | undefined {
  if (typeof raw !== 'string' || raw === '') return undefined;
  const value = raw.slice(0, maxLength);
  return value.length === 0 ? undefined : value;
}

function parseExploreCursorQuery(raw: unknown): string | undefined {
  if (raw === undefined || raw === '') return undefined;
  if (typeof raw !== 'string'
    || raw.length < 1
    || raw.length > 4_096) {
    invalidCursor();
  }
  return raw;
}

function invalidCursor(): never {
  throw new ProductHttpError({
    statusCode: productErrorStatus('invalid_cursor'),
    code: 'invalid_cursor',
    message: 'The Explore cursor is invalid.',
    recovery: 'restart_from_first_page',
  });
}

/** Fixed creator card for restrict_publication. Not a per-request id. */
export const EXPLORE_UNKNOWN_CREATOR: ExploreCollectionItem['creators'][number] = Object.freeze({
  id: EXPLORE_UNKNOWN_CREATOR_ID,
  name: 'Unknown',
  handle: null,
  avatar: null,
});

/**
 * Account id a client may store as a creator mute. The Unknown sentinel and
 * subject fallbacks are not filter keys.
 */
export function exploreCreatorFilterAccountId(creatorId: string): string | null {
  if (creatorId === EXPLORE_UNKNOWN_CREATOR_ID || !creatorId.startsWith('account:')) return null;
  const accountId = creatorId.slice('account:'.length);
  return accountId.length > 0 ? accountId : null;
}

/** Maps identity facts onto the Explore creator DTO; missing facts become Unknown. */
export function mapExploreCreatorDto(
  ownerSubjectId: string,
  facts: ExploreCreatorFacts | undefined,
): ExploreCollectionItem['creators'][number] {
  if (facts?.publicationRestricted === true) return EXPLORE_UNKNOWN_CREATOR;
  if (!facts) {
    return {
      id: `subject:${ownerSubjectId}`,
      name: 'Unknown',
      handle: null,
      avatar: null,
    };
  }
  return {
    id: `account:${facts.accountId}`,
    name: facts.displayName || facts.handle || 'Unknown',
    handle: facts.handle,
    avatar: facts.avatarUrl,
  };
}

export function registerExploreRoutes(
  app: FastifyInstance,
  dependencies: {
    readonly page: ExplorePageReadPort;
    readonly creators?: ExploreCreatorsQueryPort;
    readonly publicMarks?: ExploreCollectionMarksPort;
    readonly rateLimiter?: SearchRateLimiter;
    readonly config?: AppConfig;
    readonly identityUnitOfWork?: IdentityUnitOfWork;
  },
): void {
  const routeOptions = {
    config: {
      productTransport: {
        allowedQuery: ['q', 'tag', 'limit', 'cursor', 'sort'],
        cacheControl: 'public-revalidate' as const,
        rejectRequestBody: true,
      },
    },
  };
  app.get(EXPLORE_ROUTE, {
    exposeHeadRoute: false,
    config: { ...productRouteMetadata('GET', EXPLORE_ROUTE), ...routeOptions.config },
    handler: exploreHandler(dependencies),
  });
  app.head(EXPLORE_ROUTE, {
    config: { ...productRouteMetadata('HEAD', EXPLORE_ROUTE), ...routeOptions.config },
    handler: exploreHandler(dependencies),
  });
}

function exploreHandler(
  dependencies: {
    readonly page: ExplorePageReadPort;
    readonly creators?: ExploreCreatorsQueryPort;
    readonly publicMarks?: ExploreCollectionMarksPort;
    readonly rateLimiter?: SearchRateLimiter;
    readonly config?: AppConfig;
    readonly identityUnitOfWork?: IdentityUnitOfWork;
  },
) {
  return async (
    request: FastifyRequest<{ Querystring: Record<string, string | undefined> }>,
    reply: FastifyReply,
  ) => {
    const limit = parseLimit(request.query.limit);
    const sort = parseSort(request.query.sort);
    const filter = {
      q: parseStringParam(request.query.q, 256),
      tag: parseStringParam(request.query.tag, 64),
    };
    let after: ExplorePagePosition | undefined;
    const cursor = parseExploreCursorQuery(request.query.cursor);
    if (cursor !== undefined) {
      after = decodeExploreCursor(cursor, sort);
    }

    await admitExploreDirectoryRateLimit(
      dependencies.rateLimiter,
      exploreDirectoryAnonymousSubject(request),
      'Too many Explore requests. Please try again later.',
    );

    const selected = await loadEligibleExplorePage(dependencies.page, {
      filter, sort, limit, ...(after ? { after } : {}),
    });
    const pageRecords = selected.records;
    const creatorMap = dependencies.creators
      ? await dependencies.creators.findByOwnerSubjectIds(
        [...new Set(pageRecords.map((record) => record.ownerSubjectId))],
      )
      : new Map<string, ExploreCreatorFacts>();
    const curatorNotes = dependencies.publicMarks
      ? await dependencies.publicMarks.findPublicMarksForCollections(pageRecords.map((record) => record.id))
      : new Map<string, string>();
    const items: ExploreCollectionItem[] = pageRecords.map((record) => ({
      id: record.id,
      title: record.hiddenPublic ? 'Collection hidden' : record.title,
      summary: record.hiddenPublic ? null : record.summary,
      kind: record.kind,
      tags: record.hiddenPublic ? [] : record.tags,
      ...(record.hiddenPublic || record.language === undefined ? {} : { language: record.language }),
      nodeCount: record.nodeCount,
      viewCount: record.viewCount,
      updatedAt: record.updatedAt,
      publicationSlug: record.hiddenPublic ? null : record.publicationSlug,
      visibility: record.visibility,
      ...(record.hiddenPublic ? { hiddenPublic: true } : {}),
      curatorNote: record.hiddenPublic ? null : (curatorNotes.get(record.id) ?? null),
      creators: [mapExploreCreatorDto(record.ownerSubjectId, creatorMap.get(record.ownerSubjectId))],
    }));
    const nextCursor = selected.resume
      ? encodeExploreCursor(selected.resume, sort)
      : null;
    reply.header('cache-control', 'public, max-age=60');
    if (request.method === 'HEAD') return reply.send();
    return { items, nextCursor };
  };
}

function encodeExploreCursor(record: ExplorePageRecord, sort: ExplorePageSort): string {
  return encodeCursor(record, sort);
}

function decodeExploreCursor(cursor: string, sort: ExplorePageSort): ExplorePagePosition {
  const decoded = decodeCursor(cursor, sort);
  if (!decoded) invalidCursor();
  return decoded;
}
