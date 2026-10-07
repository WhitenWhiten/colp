import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
  assessSharedExposureScope,
  assertSharedExposureScopeIneligible,
  type SharedExposureFactsPort,
} from '../../exposure/deny-by-default.js';
import { canonicalJson } from '../../commands/index.js';
import { resolveEffectiveRole, type MembershipRole } from '../../access-policy/index.js';
import {
  normalizeSearchQuery,
  type SearchCandidate,
  type SearchCandidateExclusiveTuple,
  type SearchCandidatePort,
  type SearchCandidateResourceType,
} from '../domain/index.js';
import type { SearchTelemetryOutcome, SearchTelemetryPort } from './search-telemetry.js';

export type SearchResourceType = SearchCandidateResourceType;
export const SEARCH_DEFAULT_PAGE_SIZE = 20;
export const SEARCH_MAX_PAGE_SIZE = 100;
export const SEARCH_CANDIDATE_BATCH_LIMIT = 100;
export const SEARCH_MAX_ROUNDS = 4;
export const SEARCH_MAX_CANDIDATES = SEARCH_CANDIDATE_BATCH_LIMIT * SEARCH_MAX_ROUNDS;
export const SEARCH_DEFAULT_TIMEOUT_MS = 1_500;
export const SEARCH_MAX_TIMEOUT_MS = 5_000;
export const SEARCH_CURSOR_TTL_MS = 15 * 60 * 1_000;
/**
 * FIX-L-025 (PUB-R18): hard TTL for reusing a signed first-page cursor. An
 * unchanged first page (same query/principal/page size and same continuation
 * position) reuses the exact same cursor token within this window, so the
 * response bytes and the ETag stay stable and conditional requests can answer
 * 304. Hits never re-sign, so the cursor expiry stays anchored at the first
 * signing and is never extended. The window equals the cursor TTL: a reused
 * cursor can never outlive its own validity, and every expired cursor is
 * replaced by a freshly signed one.
 */
export const SEARCH_FIRST_PAGE_CACHE_TTL_MS = SEARCH_CURSOR_TTL_MS;
export const SEARCH_CURSOR_PURPOSE = 'product-search-cursor';
export const SEARCH_COMPARATOR_VERSION = 'rank-desc-type-asc-id-asc-v1';

const ALL_TYPES: readonly SearchResourceType[] = Object.freeze([
  'collection', 'node', 'profile', 'annotation',
]);
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

export type SearchPrincipal =
  | { readonly kind: 'anonymous' }
  | { readonly kind: 'account'; readonly accountId: string; readonly principalId: string;
    readonly subjectId: string; readonly securityEpoch: string };

interface SearchCollectionAuthorityBase {
  readonly collectionId: string;
  readonly ownerSubjectId: string;
  readonly membershipRole: MembershipRole | null;
  readonly collectionVisibility: 'private' | 'protected' | 'public' | 'unlisted';
  readonly allowSearchIndexing: boolean;
  readonly policyRevision: string;
  readonly collectionDeleted: boolean;
}

export interface CollectionSearchAuthorityFact {
  readonly resourceType: 'collection'; readonly resourceId: string; readonly collectionId: string;
  readonly ownerSubjectId: string; readonly membershipRole: MembershipRole | null;
  readonly visibility: 'private' | 'protected' | 'public' | 'unlisted';
  readonly allowSearchIndexing: boolean; readonly policyRevision: string; readonly deleted: boolean;
  readonly title: string; readonly snippetSource: string;
}

export interface NodeSearchAuthorityFact extends SearchCollectionAuthorityBase {
  readonly resourceType: 'node'; readonly resourceId: string;
  readonly visibility: 'inherit' | 'protected' | 'private'; readonly ancestorRestricted: boolean;
  readonly deleted: boolean; readonly title: string; readonly urlHost: string | null;
  readonly snippetSource: string;
}

export interface ProfileSearchAuthorityFact {
  readonly resourceType: 'profile'; readonly resourceId: string;
  readonly accountStatus: 'active' | 'disabled' | 'deleted'; readonly accountDeleted: boolean;
  readonly searchablePublicCollection: boolean; readonly handle: string; readonly displayName: string;
  readonly avatarUrl: string | null; readonly snippetSource: string;
}

export interface AnnotationSearchAuthorityFact extends SearchCollectionAuthorityBase {
  readonly resourceType: 'annotation'; readonly resourceId: string;
  readonly visibility: 'public' | 'unlisted' | 'protected' | 'private';
  readonly creatorPrincipalId: string; readonly deleted: boolean;
  readonly subjectType: 'collection' | 'node'; readonly subjectId: string;
  readonly subjectDeleted: boolean; readonly subjectVisibility: 'inherit' | 'protected' | 'private' | null;
  readonly subjectAncestorRestricted: boolean;
  readonly annotationType: 'note' | 'summary' | 'tldr' | 'highlight' | 'rating' | 'custom';
  readonly snippetSource: string;
}

export type SearchAuthorityFact = CollectionSearchAuthorityFact | NodeSearchAuthorityFact
  | ProfileSearchAuthorityFact | AnnotationSearchAuthorityFact;

export interface SearchAuthorityPort {
  loadBatch(input: { readonly principal: SearchPrincipal; readonly candidates: readonly SearchCandidate[];
    readonly signal?: AbortSignal; readonly timeoutMs: number }): Promise<readonly SearchAuthorityFact[]>;
}

interface SearchCursorPayload {
  readonly v: 1; readonly purpose: typeof SEARCH_CURSOR_PURPOSE; readonly keyVersion: string;
  readonly queryDigest: string; readonly types: readonly SearchResourceType[];
  readonly principalFingerprint: string; readonly pageSize: number;
  readonly comparatorVersion: typeof SEARCH_COMPARATOR_VERSION;
  readonly after: SearchCandidateExclusiveTuple;
  /** Every continuation re-loads authority; rank/content mutations require traversal restart for completeness. */
  readonly restart: { readonly version: 1; readonly mode: 'current-authority-recheck';
    readonly exhaustedBudget: boolean };
  readonly issuedAt: string; readonly expiresAt: string;
}

export interface SearchCursorKeyMaterial { readonly current: { readonly id: string; readonly key: string };
  readonly previous?: readonly { readonly id: string; readonly key: string; readonly retainUntil?: string }[] }
export interface SearchCursorSignerPort { readonly currentKeyId: string;
  digestScope(value: unknown, keyId?: string): string;
  sign(payload: SearchCursorPayload): string; verify(token: string, now: Date): SearchCursorPayload }

export interface SearchFirstPageCacheEntry {
  readonly token: string;
  /** ISO instant of the first signing; cache hits never move it forward. */
  readonly signedAt: string;
}

/**
 * FIX-L-025: in-process hard-TTL store for signed first-page cursor tokens.
 * The query layer re-executes every request (data and authority stay fresh);
 * this port only stabilizes the cursor token so that unchanged first pages
 * reuse the exact same response bytes and ETag within the TTL. TTL enforcement
 * and key binding live in the query layer via `ports.clock`.
 */
export interface SearchFirstPageCachePort {
  get(key: string): SearchFirstPageCacheEntry | undefined;
  set(key: string, entry: SearchFirstPageCacheEntry): void;
}

export class SearchQueryError extends Error {
  constructor(readonly code: 'invalid_search_query' | 'invalid_cursor' | 'search_timeout' | 'search_aborted') {
    super({ invalid_search_query: 'The Search query is invalid.', invalid_cursor: 'The Search cursor is invalid.',
      search_timeout: 'The Search query timed out.', search_aborted: 'The Search query was cancelled.' }[code]);
    this.name = 'SearchQueryError';
  }
}

export interface SearchQueryPorts {
  readonly candidates: SearchCandidatePort;
  readonly authority: SearchAuthorityPort;
  readonly cursors: SearchCursorSignerPort;
  readonly clock: { now(): Date };
  readonly cursorTtlMs?: number;
  readonly telemetry?: SearchTelemetryPort;
  /**
   * FIX-L-025: optional hard-TTL first-page cursor reuse. When provided,
   * identical first-page requests (same query/principal/page size and the
   * same continuation position) reuse the same signed cursor within the hard
   * TTL so the response bytes and ETag stay stable and conditional requests
   * can answer 304. The search itself always re-executes: data or
   * authority-epoch changes produce a fresh response/ETag immediately, and
   * after the TTL a fresh cursor is signed.
   */
  readonly firstPageCache?: SearchFirstPageCachePort;
  /**
   * P4A-R06: the search projection depends on the exposure-eligibility gate
   * through the approved facts port (logical facts only). Every collection a
   * result page touches is assessed; deny-by-default means no private
   * Attachment can ever surface as a searchable candidate.
   */
  readonly sharedExposure: SharedExposureFactsPort;
}

export type SearchResult =
  | Readonly<{ resourceType: 'collection'; resourceId: string; title: string; snippet: string; rank: number }>
  | Readonly<{ resourceType: 'node'; resourceId: string; collectionId: string; title: string;
    urlHost: string | null; snippet: string; rank: number }>
  | Readonly<{ resourceType: 'profile'; resourceId: string; handle: string; displayName: string;
    avatarUrl: string | null; snippet: string; rank: number }>
  | Readonly<{ resourceType: 'annotation'; resourceId: string; collectionId: string;
    subject: Readonly<{ type: 'collection' | 'node'; id: string }>;
    annotationType: AnnotationSearchAuthorityFact['annotationType']; snippet: string; rank: number }>;

export interface SearchQueryInput {
  readonly principal: SearchPrincipal; readonly query: string; readonly types?: readonly SearchResourceType[];
  readonly pageSize?: number; readonly cursor?: string; readonly timeoutMs?: number; readonly signal?: AbortSignal;
}

export interface SearchQueryResult {
  readonly normalizedQuery: string; readonly types: readonly SearchResourceType[];
  readonly items: readonly SearchResult[];
  readonly page: Readonly<{ returnedCount: number; hasMore: boolean; nextCursor: string | null }>;
  readonly cache: Readonly<{ class: 'shared-public'; partition: string }
    | { class: 'private-no-store'; partition: null }>;
  readonly consistency: Readonly<{ authority: 'recheck-each-page'; ranking: 'restart-on-mutation' }>;
}

export function createSearchCursorSigner(material: SearchCursorKeyMaterial): SearchCursorSignerPort {
  const keys: Array<{ id: string; key: string; retainUntil?: string; derived: string }> = [
    material.current, ...(material.previous ?? []),
  ].map((key) => ({ ...key,
    derived: createHmac('sha256', key.key).update(SEARCH_CURSOR_PURPOSE).digest('base64url') }));
  if (keys.length === 0 || new Set(keys.map((key) => key.id)).size !== keys.length
    || keys.some((key) => !/^[A-Za-z0-9_-]{1,64}$/u.test(key.id) || key.key.length < 16
      || (key.retainUntil !== undefined && !isCanonicalDate(key.retainUntil)))) {
    throw new TypeError('Invalid Search cursor keyring.');
  }
  return Object.freeze({
    currentKeyId: material.current.id,
    digestScope(value: unknown, keyId = material.current.id): string {
      const key = keys.find((candidate) => candidate.id === keyId);
      if (!key) throw new SearchQueryError('invalid_cursor');
      return createHmac('sha256', key.derived).update('scope\0').update(canonicalJson(value)).digest('base64url');
    },
    sign(payload: SearchCursorPayload): string {
      validateCursorPayload(payload);
      if (payload.keyVersion !== material.current.id) throw new SearchQueryError('invalid_cursor');
      const encoded = Buffer.from(canonicalJson(payload), 'utf8').toString('base64url');
      const signature = createHmac('sha256', keys[0]!.derived).update(encoded).digest('base64url');
      return `${material.current.id}.${encoded}.${signature}`;
    },
    verify(token: string, now: Date): SearchCursorPayload {
      try {
        const [keyId, encoded, signature, ...extra] = token.split('.');
        if (!keyId || !encoded || !signature || extra.length > 0 || token.length > 2_048
          || !/^[A-Za-z0-9_-]+$/u.test(encoded) || !/^[A-Za-z0-9_-]{43}$/u.test(signature)) throw new Error();
        const key = keys.find((candidate) => candidate.id === keyId);
        if (!key || (key.retainUntil !== undefined && now >= new Date(key.retainUntil))) throw new Error();
        const expected = Buffer.from(createHmac('sha256', key.derived).update(encoded).digest('base64url'));
        const supplied = Buffer.from(signature);
        if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) throw new Error();
        const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as SearchCursorPayload;
        validateCursorPayload(payload);
        if (payload.keyVersion !== keyId || now < new Date(payload.issuedAt)
          || now >= new Date(payload.expiresAt)) throw new Error();
        return payload;
      } catch {
        throw new SearchQueryError('invalid_cursor');
      }
    },
  });
}

/**
 * FIX-L-025: bounded in-process cache for signed first-page cursors. TTL
 * enforcement and key binding live in the query layer (`ports.clock`); this
 * store only keeps the most recent `limit` keys so memory stays bounded.
 */
export function createSearchFirstPageCache(limit = 1_000): SearchFirstPageCachePort {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new TypeError('Search first-page cache limit must be a positive safe integer.');
  }
  const entries = new Map<string, SearchFirstPageCacheEntry>();
  const order: string[] = [];
  return Object.freeze({
    get(key: string): SearchFirstPageCacheEntry | undefined { return entries.get(key); },
    set(key: string, entry: SearchFirstPageCacheEntry): void {
      if (!entries.has(key)) {
        order.push(key);
        if (order.length > limit) {
          const oldest = order.shift();
          if (oldest !== undefined) entries.delete(oldest);
        }
      }
      entries.set(key, entry);
    },
  });
}

export async function executeSearchQuery(ports: SearchQueryPorts, input: SearchQueryInput): Promise<SearchQueryResult> {
  const telemetryStartedAt = performance.now();
  const telemetry = { candidateCount: 0, authorizedCount: 0, resultCount: 0, roundCount: 0,
    requestedCount: input.pageSize ?? SEARCH_DEFAULT_PAGE_SIZE };
  const timeoutMs = input.timeoutMs ?? SEARCH_DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > SEARCH_MAX_TIMEOUT_MS) {
    const error = new SearchQueryError('invalid_search_query');
    recordTelemetry(ports.telemetry, input, telemetry, 'invalid', telemetryStartedAt);
    throw error;
  }
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new SearchQueryError('search_timeout')), timeoutMs);
  timer.unref?.();
  const signal = input.signal === undefined ? deadline.signal : AbortSignal.any([input.signal, deadline.signal]);
  try {
    const result = await executeSearchQueryWithinBudget(ports, { ...input, signal, timeoutMs }, telemetry);
    telemetry.resultCount = result.items.length;
    recordTelemetry(ports.telemetry, input, telemetry, 'success', telemetryStartedAt);
    return result;
  } catch (error) {
    recordTelemetry(ports.telemetry, input, telemetry, telemetryOutcome(error), telemetryStartedAt);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function executeSearchQueryWithinBudget(ports: SearchQueryPorts,
  input: SearchQueryInput,
  telemetry: { candidateCount: number; authorizedCount: number; resultCount: number; roundCount: number;
    requestedCount: number },
): Promise<SearchQueryResult> {
  const startedAt = ports.clock.now();
  const normalizedQuery = normalizeSearchQuery(input.query);
  if (normalizedQuery === null) throw new SearchQueryError('invalid_search_query');
  const types = normalizeTypes(input.types);
  assertPrincipal(input.principal);
  const timeoutMs = input.timeoutMs ?? SEARCH_DEFAULT_TIMEOUT_MS;
  checkBudget(ports, input.signal, startedAt, timeoutMs);

  const principalScope = input.principal.kind === 'anonymous'
    ? { projection: 'anonymous' as const }
    : { projection: 'account' as const, accountId: input.principal.accountId,
      principalId: input.principal.principalId, subjectId: input.principal.subjectId,
      securityEpoch: input.principal.securityEpoch };
  const queryDigest = ports.cursors.digestScope({ normalizedQuery });
  const principalFingerprint = ports.cursors.digestScope(principalScope);
  let pageSize = input.pageSize ?? SEARCH_DEFAULT_PAGE_SIZE;
  let after: SearchCandidateExclusiveTuple | undefined;
  let issuedAt = startedAt.toISOString();
  let expiresAt = new Date(startedAt.getTime() + (ports.cursorTtlMs ?? SEARCH_CURSOR_TTL_MS)).toISOString();
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > SEARCH_MAX_PAGE_SIZE) {
    throw new SearchQueryError('invalid_search_query');
  }
  if (input.cursor !== undefined) {
    if (input.pageSize !== undefined) throw new SearchQueryError('invalid_cursor');
    const cursor = ports.cursors.verify(input.cursor, startedAt);
    const expectedQueryDigest = ports.cursors.digestScope({ normalizedQuery }, cursor.keyVersion);
    const expectedPrincipalFingerprint = ports.cursors.digestScope(principalScope, cursor.keyVersion);
    if (cursor.queryDigest !== expectedQueryDigest || canonicalJson(cursor.types) !== canonicalJson(types)
      || cursor.principalFingerprint !== expectedPrincipalFingerprint) throw new SearchQueryError('invalid_cursor');
    pageSize = cursor.pageSize;
    after = cursor.after;
    issuedAt = cursor.issuedAt;
    expiresAt = cursor.expiresAt;
  }
  telemetry.requestedCount = pageSize;

  const projection = input.principal.kind === 'anonymous'
    ? { kind: 'anonymous' as const }
    : { kind: 'account' as const, accountId: input.principal.accountId,
      principalId: input.principal.principalId, subjectId: input.principal.subjectId,
      securityEpoch: input.principal.securityEpoch };
  const results: SearchResult[] = [];
  let examined = 0;
  let rounds = 0;
  let continuationAfter = after;
  let hasMore = false;
  while (results.length < pageSize && rounds < SEARCH_MAX_ROUNDS && examined < SEARCH_MAX_CANDIDATES) {
    checkBudget(ports, input.signal, startedAt, timeoutMs);
    const remainingBudget = SEARCH_MAX_CANDIDATES - examined;
    const limit = Math.min(SEARCH_CANDIDATE_BATCH_LIMIT, remainingBudget);
    let candidatePage: Awaited<ReturnType<typeof callCandidatePort>>;
    try {
      candidatePage = await callCandidatePort(ports.candidates, {
        query: normalizedQuery, types, projection, limit, ...(continuationAfter ? { after: continuationAfter } : {}),
        ...(input.signal ? { signal: input.signal } : {}), timeoutMs: remainingTime(ports, startedAt, timeoutMs),
      });
    } catch (error) {
      throw normalizeExecutionError(ports, input.signal, startedAt, timeoutMs, error);
    }
    checkBudget(ports, input.signal, startedAt, timeoutMs);
    if (typeof candidatePage.hasMore !== 'boolean') throw new Error('Search candidate port returned invalid paging state.');
    validateCandidatePage(candidatePage.items, limit, types, continuationAfter);
    if (candidatePage.items.length === 0) {
      if (candidatePage.hasMore) throw new Error('Search candidate port did not advance a non-empty page.');
      hasMore = false;
      break;
    }
    rounds += 1;
    examined += candidatePage.items.length;
    telemetry.roundCount = rounds;
    telemetry.candidateCount = examined;
    let facts: readonly SearchAuthorityFact[];
    try {
      facts = await ports.authority.loadBatch({ principal: input.principal,
        candidates: candidatePage.items, ...(input.signal ? { signal: input.signal } : {}),
        timeoutMs: remainingTime(ports, startedAt, timeoutMs) });
    } catch (error) {
      throw normalizeExecutionError(ports, input.signal, startedAt, timeoutMs, error);
    }
    checkBudget(ports, input.signal, startedAt, timeoutMs);
    const factMap = validatedFactMap(facts, candidatePage.items);
    const collectionIds = [...new Set(facts.flatMap((fact) => 'collectionId' in fact
      && typeof fact.collectionId === 'string' && fact.collectionId.length > 0 ? [fact.collectionId] : []))];
    try {
      // Search has no attachment candidates; do not load collection history.
      if (collectionIds.length > 0) assertSharedExposureScopeIneligible(await assessSharedExposureScope(
        ports.sharedExposure, { collectionId: collectionIds[0]!, collectionIds, blobIds: [] },
        { signal: input.signal },
      ));
    } catch (error) {
      throw normalizeExecutionError(ports, input.signal, startedAt, timeoutMs, error);
    }
    let filledAt = -1;
    for (let index = 0; index < candidatePage.items.length; index += 1) {
      const candidate = candidatePage.items[index]!;
      continuationAfter = candidate.exclusive;
      const fact = factMap.get(resourceKey(candidate));
      const mapped = fact === undefined ? null : authorizeAndMap(input.principal, candidate, fact);
      if (mapped !== null) {
        telemetry.authorizedCount += 1;
        results.push(mapped);
      }
      if (results.length === pageSize) { filledAt = index; break; }
    }
    if (filledAt >= 0) {
      hasMore = candidatePage.hasMore || candidatePage.items.slice(filledAt + 1).some((candidate) => {
        const fact = factMap.get(resourceKey(candidate));
        return fact !== undefined && authorizeAndMap(input.principal, candidate, fact) !== null;
      });
      break;
    }
    hasMore = candidatePage.hasMore;
    if (!candidatePage.hasMore) break;
  }
  if (results.length < pageSize && hasMore
    && (rounds >= SEARCH_MAX_ROUNDS || examined >= SEARCH_MAX_CANDIDATES)) hasMore = true;
  if (!hasMore) continuationAfter = undefined;
  checkBudget(ports, input.signal, startedAt, timeoutMs);
  let nextCursor: string | null = null;
  if (hasMore && continuationAfter !== undefined) {
    // FIX-L-025: a first page with more pages signs its cursor once and reuses
    // the token within the hard TTL. The key binds query/principal/page size
    // AND the continuation position, so a changed page can never reuse a stale
    // cursor; the search itself always re-executes, so data and authority
    // changes invalidate the response (and its ETag) immediately. Continuation
    // requests are skipped: their issuedAt/expiresAt already come from the
    // presented cursor and are therefore stable.
    const exhaustedBudget = results.length < pageSize;
    const cacheKey = input.cursor === undefined && ports.firstPageCache !== undefined
      ? firstPageCacheKey({ queryDigest, types, principalFingerprint, pageSize, after: continuationAfter,
        exhaustedBudget }) : undefined;
    const cached = cacheKey === undefined ? undefined : ports.firstPageCache!.get(cacheKey);
    if (cached !== undefined && isFreshFirstPageCursor(startedAt, cached.signedAt,
      ports.cursorTtlMs ?? SEARCH_CURSOR_TTL_MS)) {
      nextCursor = cached.token;
    } else {
      nextCursor = ports.cursors.sign({
        v: 1, purpose: SEARCH_CURSOR_PURPOSE, keyVersion: ports.cursors.currentKeyId,
        queryDigest, types, principalFingerprint, pageSize, comparatorVersion: SEARCH_COMPARATOR_VERSION,
        after: continuationAfter, restart: { version: 1, mode: 'current-authority-recheck', exhaustedBudget },
        issuedAt, expiresAt,
      });
      if (cacheKey !== undefined) {
        ports.firstPageCache!.set(cacheKey, { token: nextCursor, signedAt: issuedAt });
      }
    }
  }
  const cache = input.principal.kind === 'anonymous'
    ? Object.freeze({ class: 'shared-public' as const, partition: digest({
      contract: 'search-product-v1', queryDigest, types, pageSize,
      cursor: input.cursor === undefined ? null : digest({ cursor: input.cursor }),
      comparatorVersion: SEARCH_COMPARATOR_VERSION,
    }) })
    : Object.freeze({ class: 'private-no-store' as const, partition: null });
  return Object.freeze({ normalizedQuery, types, items: Object.freeze(results),
    page: Object.freeze({ returnedCount: results.length, hasMore, nextCursor }), cache,
    consistency: Object.freeze({ authority: 'recheck-each-page' as const,
      ranking: 'restart-on-mutation' as const }) });
}

function recordTelemetry(port: SearchTelemetryPort | undefined, input: SearchQueryInput,
  facts: { candidateCount: number; authorizedCount: number; resultCount: number; roundCount: number;
    requestedCount: number },
  outcome: SearchTelemetryOutcome, startedAt: number): void {
  if (!port) return;
  port.record({ outcome, resourceTypes: input.types ?? ALL_TYPES,
    candidateCount: facts.candidateCount, authorizedCount: facts.authorizedCount,
    resultCount: facts.resultCount, requestedCount: facts.requestedCount, roundCount: facts.roundCount,
    latencyMs: Math.max(0, performance.now() - startedAt) });
}

function telemetryOutcome(error: unknown): SearchTelemetryOutcome {
  const code = error instanceof SearchQueryError ? error.code
    : typeof error === 'object' && error !== null && 'code' in error
      ? (error as { code?: unknown }).code : undefined;
  if (code === 'invalid_search_query' || code === 'invalid_cursor') return 'invalid';
  if (code === 'search_timeout') return 'timeout';
  if (code === 'search_aborted') return 'abort';
  return 'error';
}

async function callCandidatePort(port: SearchCandidatePort,
  input: Parameters<SearchCandidatePort['listCandidates']>[0]) {
  return port.listCandidates(input);
}

function authorizeAndMap(principal: SearchPrincipal, candidate: SearchCandidate,
  fact: SearchAuthorityFact): SearchResult | null {
  try {
    if (candidate.resourceType !== fact.resourceType || candidate.resourceId !== fact.resourceId
      || !isClosedAuthorityFact(fact)) return null;
    switch (fact.resourceType) {
    case 'collection': {
      if (fact.collectionId !== fact.resourceId || fact.deleted !== false || fact.allowSearchIndexing !== true
        || !canReadCollection(principal, fact)) return null;
      return Object.freeze({ resourceType: 'collection', resourceId: fact.resourceId,
        title: safeRequiredText(fact.title), snippet: safeSnippet(fact.snippetSource), rank: candidate.rank });
    }
    case 'node': {
      if (fact.collectionDeleted !== false || fact.deleted !== false || fact.allowSearchIndexing !== true
        || !canReadCollection(principal, fact)
        || (!isMember(principal, fact) && (fact.visibility !== 'inherit' || fact.ancestorRestricted))) return null;
      return Object.freeze({ resourceType: 'node', resourceId: fact.resourceId, collectionId: fact.collectionId,
        title: safeRequiredText(fact.title), urlHost: safeHost(fact.urlHost),
        snippet: safeSnippet(fact.snippetSource), rank: candidate.rank });
    }
    case 'profile': {
      if (fact.accountStatus !== 'active' || fact.accountDeleted !== false || fact.searchablePublicCollection !== true
        || fact.handle !== fact.resourceId) return null;
      return Object.freeze({ resourceType: 'profile', resourceId: fact.resourceId,
        handle: safeRequiredText(fact.handle), displayName: safeRequiredText(fact.displayName),
        avatarUrl: safeAvatar(fact.avatarUrl), snippet: safeSnippet(fact.snippetSource), rank: candidate.rank });
    }
    case 'annotation': {
      const member = isMember(principal, fact);
      if (fact.collectionDeleted !== false || fact.deleted !== false || fact.subjectDeleted !== false
        || fact.allowSearchIndexing !== true
        || !canReadCollection(principal, fact)) return null;
      if (member) {
        if (fact.visibility === 'private'
          && (principal.kind !== 'account' || principal.principalId !== fact.creatorPrincipalId)) return null;
      } else if (fact.visibility !== 'public'
        || (fact.subjectType === 'node'
          && (fact.subjectVisibility !== 'inherit' || fact.subjectAncestorRestricted))) return null;
      return Object.freeze({ resourceType: 'annotation', resourceId: fact.resourceId,
        collectionId: fact.collectionId, subject: Object.freeze({ type: fact.subjectType, id: fact.subjectId }),
        annotationType: fact.annotationType, snippet: safeSnippet(fact.snippetSource), rank: candidate.rank });
    }
    }
  } catch {
    return null;
  }
}

function isClosedAuthorityFact(fact: SearchAuthorityFact): boolean {
  if (!fact.resourceId || ('collectionId' in fact && !fact.collectionId)) return false;
  if (fact.resourceType === 'profile') {
    return ['active', 'disabled', 'deleted'].includes(fact.accountStatus)
      && typeof fact.accountDeleted === 'boolean' && typeof fact.searchablePublicCollection === 'boolean'
      && typeof fact.handle === 'string' && typeof fact.displayName === 'string'
      && typeof fact.snippetSource === 'string';
  }
  if (!fact.ownerSubjectId || !fact.policyRevision
    || (fact.membershipRole !== null && !['owner', 'editor', 'viewer'].includes(fact.membershipRole))
    || typeof fact.allowSearchIndexing !== 'boolean') return false;
  if (fact.resourceType === 'collection') {
    return ['private', 'protected', 'public', 'unlisted'].includes(fact.visibility)
      && typeof fact.deleted === 'boolean' && typeof fact.title === 'string'
      && typeof fact.snippetSource === 'string';
  }
  if (!['private', 'protected', 'public', 'unlisted'].includes(fact.collectionVisibility)
    || typeof fact.collectionDeleted !== 'boolean' || typeof fact.deleted !== 'boolean') return false;
  if (fact.resourceType === 'node') {
    return ['inherit', 'protected', 'private'].includes(fact.visibility)
      && typeof fact.ancestorRestricted === 'boolean' && typeof fact.title === 'string'
      && typeof fact.snippetSource === 'string';
  }
  return ['public', 'unlisted', 'protected', 'private'].includes(fact.visibility)
    && ['collection', 'node'].includes(fact.subjectType) && fact.subjectId.length > 0
    && ['note', 'summary', 'tldr', 'highlight', 'rating', 'custom'].includes(fact.annotationType)
    && typeof fact.subjectDeleted === 'boolean' && typeof fact.subjectAncestorRestricted === 'boolean'
    && typeof fact.creatorPrincipalId === 'string' && fact.creatorPrincipalId.length > 0
    && typeof fact.snippetSource === 'string'
    && (fact.subjectType !== 'collection' || fact.subjectId === fact.collectionId)
    && (fact.subjectVisibility === null || ['inherit', 'protected', 'private'].includes(fact.subjectVisibility));
}

function canReadCollection(principal: SearchPrincipal, facts: {
  readonly collectionId: string; readonly ownerSubjectId: string; readonly membershipRole: MembershipRole | null;
  readonly collectionVisibility?: 'private' | 'protected' | 'public' | 'unlisted';
  readonly visibility?: 'inherit' | 'private' | 'protected' | 'public' | 'unlisted';
}): boolean {
  if (isMember(principal, facts)) return true;
  return (facts.collectionVisibility ?? facts.visibility) === 'public';
}

function isMember(principal: SearchPrincipal, facts: {
  readonly collectionId: string; readonly ownerSubjectId: string; readonly membershipRole: MembershipRole | null;
}): boolean {
  if (principal.kind !== 'account') return false;
  if (facts.membershipRole !== null
    && facts.membershipRole !== 'owner' && facts.membershipRole !== 'editor' && facts.membershipRole !== 'viewer') return false;
  return resolveEffectiveRole({ collectionId: facts.collectionId, ownerSubjectId: facts.ownerSubjectId,
    membershipRole: facts.membershipRole, visibility: 'private', policyRevision: 'search', deleted: false },
  { kind: 'account', principalId: principal.principalId, subjectId: principal.subjectId }) !== null;
}

function validatedFactMap(facts: readonly SearchAuthorityFact[], candidates: readonly SearchCandidate[]) {
  const candidateKeys = new Set(candidates.map(resourceKey));
  const map = new Map<string, SearchAuthorityFact>();
  for (const fact of facts) {
    const key = resourceKey(fact);
    if (!candidateKeys.has(key) || map.has(key)) throw new Error('Search authority port returned invalid batch facts.');
    map.set(key, fact);
  }
  return map;
}

function validateCandidatePage(items: readonly SearchCandidate[], limit: number,
  types: readonly SearchResourceType[], after: SearchCandidateExclusiveTuple | undefined): void {
  if (items.length > limit) throw new Error('Search candidate port exceeded the requested batch limit.');
  const keys = new Set<string>();
  let previous = after;
  for (const item of items) {
    if (!types.includes(item.resourceType) || item.resourceId.length === 0 || item.resourceId.length > 512
      || item.exclusive.resourceType !== item.resourceType || item.exclusive.resourceId !== item.resourceId
      || item.exclusive.rank !== item.rank || !Number.isFinite(item.rank) || item.rank <= 0 || item.rank > 1
      || Number(item.rank.toFixed(6)) !== item.rank) throw new Error('Search candidate port returned an invalid candidate.');
    const key = resourceKey(item); if (keys.has(key)) throw new Error('Search candidate port returned duplicate candidates.');
    keys.add(key);
    if (previous !== undefined && compareTuple(previous, item.exclusive) >= 0) {
      throw new Error('Search candidate port returned candidates outside the exclusive order.');
    }
    previous = item.exclusive;
  }
}

function compareTuple(left: SearchCandidateExclusiveTuple, right: SearchCandidateExclusiveTuple): number {
  if (left.rank !== right.rank) return right.rank - left.rank;
  const order: Record<SearchResourceType, number> = { collection: 0, node: 1, profile: 2, annotation: 3 };
  if (left.resourceType !== right.resourceType) return order[left.resourceType] - order[right.resourceType];
  if (left.resourceId === right.resourceId) return 0;
  return left.resourceId < right.resourceId ? -1 : 1;
}

function normalizeTypes(input: readonly SearchResourceType[] | undefined): readonly SearchResourceType[] {
  if (input === undefined) return ALL_TYPES;
  if (input.length === 0 || input.some((type) => !ALL_TYPES.includes(type))) {
    throw new SearchQueryError('invalid_search_query');
  }
  const selected = new Set(input);
  return Object.freeze(ALL_TYPES.filter((type) => selected.has(type)));
}

function assertPrincipal(principal: SearchPrincipal): void {
  if (principal.kind === 'anonymous') return;
  if (!principal.accountId || !principal.principalId || !principal.subjectId || !principal.securityEpoch) {
    throw new SearchQueryError('invalid_search_query');
  }
}

function checkBudget(ports: SearchQueryPorts, signal: AbortSignal | undefined,
  startedAt: Date, timeoutMs: number): void {
  if (signal?.aborted) throw abortError(signal);
  if (ports.clock.now().getTime() - startedAt.getTime() >= timeoutMs) throw new SearchQueryError('search_timeout');
}

function remainingTime(ports: SearchQueryPorts, startedAt: Date, timeoutMs: number): number {
  return Math.max(1, timeoutMs - (ports.clock.now().getTime() - startedAt.getTime()));
}

function normalizeExecutionError(ports: SearchQueryPorts, signal: AbortSignal | undefined,
  startedAt: Date, timeoutMs: number, error: unknown): unknown {
  if (signal?.aborted) return abortError(signal);
  if (ports.clock.now().getTime() - startedAt.getTime() >= timeoutMs || isPostgresStatementTimeout(error)) {
    return new SearchQueryError('search_timeout');
  }
  return error;
}

function abortError(signal: AbortSignal): SearchQueryError {
  return signal.reason instanceof SearchQueryError && signal.reason.code === 'search_timeout'
    ? signal.reason : new SearchQueryError('search_aborted');
}

function isPostgresStatementTimeout(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '57014';
}

function validateCursorPayload(value: SearchCursorPayload): void {
  if (!value || !hasExactKeys(value, ['after', 'comparatorVersion', 'expiresAt', 'issuedAt', 'keyVersion',
    'pageSize', 'principalFingerprint', 'purpose', 'queryDigest', 'restart', 'types', 'v'])
    || !hasExactKeys(value.after, ['rank', 'resourceId', 'resourceType'])
    || !hasExactKeys(value.restart, ['exhaustedBudget', 'mode', 'version'])
    || value.v !== 1 || value.purpose !== SEARCH_CURSOR_PURPOSE || value.keyVersion.length === 0
    || !/^[A-Za-z0-9_-]{43}$/u.test(value.queryDigest)
    || !/^[A-Za-z0-9_-]{43}$/u.test(value.principalFingerprint)
    || canonicalJson(value.types) !== canonicalJson(normalizeTypes(value.types))
    || !value.types.includes(value.after.resourceType)
    || !Number.isInteger(value.pageSize) || value.pageSize < 1 || value.pageSize > SEARCH_MAX_PAGE_SIZE
    || value.comparatorVersion !== SEARCH_COMPARATOR_VERSION || !validTuple(value.after)
    || value.restart?.version !== 1 || value.restart.mode !== 'current-authority-recheck'
    || typeof value.restart.exhaustedBudget !== 'boolean'
    || !isCanonicalDate(value.issuedAt) || !isCanonicalDate(value.expiresAt)
    || Date.parse(value.expiresAt) <= Date.parse(value.issuedAt)
    || Date.parse(value.expiresAt) - Date.parse(value.issuedAt) > SEARCH_CURSOR_TTL_MS) {
    throw new SearchQueryError('invalid_cursor');
  }
}

function hasExactKeys(value: unknown, expected: readonly string[]): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && canonicalJson(Object.keys(value).sort()) === canonicalJson([...expected].sort());
}

function validTuple(value: SearchCandidateExclusiveTuple): boolean {
  return value !== null && typeof value === 'object' && ALL_TYPES.includes(value.resourceType)
    && typeof value.resourceId === 'string' && value.resourceId.length > 0 && Number.isFinite(value.rank)
    && value.rank > 0 && value.rank <= 1 && Number(value.rank.toFixed(6)) === value.rank;
}

function safeSnippet(value: string): string {
  if (typeof value !== 'string' || [...value].length > 1_024 || UNSAFE_TEXT.test(value)) {
    throw new Error('Search authority returned an unsafe snippet source.');
  }
  return value;
}

function safeRequiredText(value: string): string {
  if (typeof value !== 'string' || value.length === 0 || [...value].length > 512 || UNSAFE_TEXT.test(value)) {
    throw new Error('Search authority returned unsafe Product text.');
  }
  return value;
}

function safeHost(value: string | null): string | null {
  if (value === null) return null;
  if (value.length > 253
    || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(value)) {
    return null;
  }
  return value;
}

function safeAvatar(value: string | null): string | null {
  if (value === null) return null;
  if (value.length > 2_048 || UNSAFE_TEXT.test(value)) return null;
  try { const parsed = new URL(value); return parsed.protocol === 'https:' && !parsed.username && !parsed.password ? parsed.href : null; }
  catch { return null; }
}

function resourceKey(value: { readonly resourceType: SearchResourceType; readonly resourceId: string }): string {
  return `${value.resourceType}:${value.resourceId}`;
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('base64url');
}

function firstPageCacheKey(input: { queryDigest: string; types: readonly SearchResourceType[];
  principalFingerprint: string; pageSize: number; after: SearchCandidateExclusiveTuple;
  exhaustedBudget: boolean }): string {
  return digest({ contract: 'search-first-page-cursor-v1', queryDigest: input.queryDigest,
    types: input.types, pageSize: input.pageSize, principalFingerprint: input.principalFingerprint,
    comparatorVersion: SEARCH_COMPARATOR_VERSION, after: input.after, exhaustedBudget: input.exhaustedBudget });
}

function isFreshFirstPageCursor(now: Date, signedAt: string, cursorTtlMs: number): boolean {
  const signed = Date.parse(signedAt);
  return Number.isFinite(signed) && signed <= now.getTime()
    && now.getTime() - signed < Math.min(SEARCH_FIRST_PAGE_CACHE_TTL_MS, cursorTtlMs);
}

function isCanonicalDate(value: string): boolean {
  const parsed = Date.parse(value); return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}
