import {
  createSearchGovernanceCursorSigner,
  getCatalogPreferences,
  isHiddenByCatalogPreferences,
  SEARCH_GOVERNANCE_CURSOR_PURPOSE,
  SEARCH_GOVERNANCE_CURSOR_TTL_MS,
  searchGovernanceBindDigest,
  type CatalogDisplayTarget,
  type CatalogPreferencesStore,
  type CatalogPreferencesView,
} from '../../modules/governance/index.js';
import {
  SEARCH_DEFAULT_PAGE_SIZE,
  SearchQueryError,
  type SearchQueryInput,
  type SearchQueryResult,
  type SearchResult,
} from '../../modules/search/index.js';

const MAX_INNER_PAGES = 32;

export type SearchCatalogMuteFacts = Pick<CatalogDisplayTarget, 'ownerAccountId' | 'tags' | 'language'>;

export interface SearchCatalogMuteQuery {
  execute(input: SearchQueryInput): Promise<SearchQueryResult>;
  loadCatalogDisplayTargets?(
    items: readonly SearchResult[],
  ): Promise<ReadonlyMap<string, SearchCatalogMuteFacts>>;
}

export function searchCatalogItemKey(item: Pick<SearchResult, 'resourceType' | 'resourceId'>): string {
  return `${item.resourceType}:${item.resourceId}`;
}

export function searchResultDisplayTitle(item: SearchResult): string {
  if (item.resourceType === 'profile') return item.displayName;
  if (item.resourceType === 'annotation') return item.snippet;
  return item.title;
}

export function catalogMuteRulesActive(prefs: CatalogPreferencesView): boolean {
  return prefs.hiddenOwnerAccountIds.length > 0
    || prefs.hiddenTags.length > 0
    || prefs.hiddenTitleKeywords.length > 0
    || prefs.preferredLanguages.length > 0;
}

export async function executeSearchWithCatalogPreferences(options: {
  readonly query: SearchCatalogMuteQuery;
  readonly input: SearchQueryInput;
  readonly catalogPreferences?: CatalogPreferencesStore;
  readonly accountCreatedAt?: Date;
  readonly hmacKey: string | null;
}): Promise<SearchQueryResult> {
  const principal = options.input.principal;
  if (principal.kind !== 'account' || !options.catalogPreferences || !options.hmacKey) {
    return options.query.execute(options.input);
  }
  const prefs = await getCatalogPreferences(options.catalogPreferences, {
    principalId: principal.accountId,
    accountId: principal.accountId,
    createdAt: options.accountCreatedAt ?? new Date(0),
  });
  const wrap = { hmacKey: options.hmacKey, viewer: principal.accountId, prefRev: prefs.revision };
  const resume = options.input.cursor === undefined
    ? { inner: undefined, skip: 0, pageSize: options.input.pageSize ?? SEARCH_DEFAULT_PAGE_SIZE }
    : unwrapResume(options.input.cursor, wrap);
  const loadTargets = options.query.loadCatalogDisplayTargets;
  if (!catalogMuteRulesActive(prefs) || loadTargets === undefined) {
    const result = await options.query.execute(innerInput(options.input, resume));
    return withOuterCursor(result, result.items, wrap, {
      inner: result.page.nextCursor,
      skip: 0,
      pageSize: resume.pageSize,
    }, result.page.hasMore);
  }
  return loadEligibleSearchPage(options.query, options.input, prefs, wrap, resume, loadTargets);
}

function innerInput(input: SearchQueryInput, resume: {
  readonly inner: string | undefined; readonly pageSize: number;
}): SearchQueryInput {
  return {
    principal: input.principal,
    query: input.query,
    ...(input.types === undefined ? {} : { types: input.types }),
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    ...(resume.inner === undefined ? { pageSize: resume.pageSize } : { cursor: resume.inner }),
  };
}

async function loadEligibleSearchPage(
  query: SearchCatalogMuteQuery,
  input: SearchQueryInput,
  prefs: CatalogPreferencesView,
  wrap: { readonly hmacKey: string; readonly viewer: string; readonly prefRev: string },
  start: { readonly inner: string | undefined; readonly skip: number; readonly pageSize: number },
  loadTargets: NonNullable<SearchCatalogMuteQuery['loadCatalogDisplayTargets']>,
): Promise<SearchQueryResult> {
  const kept: SearchResult[] = [];
  let inner = start.inner;
  let skip = start.skip;
  let last: SearchQueryResult | undefined;
  for (let page = 0; page < MAX_INNER_PAGES; page += 1) {
    const result = await query.execute(innerInput(input, { inner, pageSize: start.pageSize }));
    last = result;
    const visible = await visibleItems(result.items, prefs, loadTargets);
    const remaining = visible.slice(skip);
    const pageInner = inner;
    const pageSkip = skip;
    skip = 0;
    const take = remaining.slice(0, start.pageSize - kept.length);
    kept.push(...take);
    if (kept.length === start.pageSize) {
      const leftover = remaining.length - take.length;
      const hasMore = leftover > 0 || result.page.hasMore;
      return withOuterCursor(result, kept, wrap, {
        inner: leftover > 0 ? (pageInner ?? null) : result.page.nextCursor,
        skip: leftover > 0 ? pageSkip + take.length : 0,
        pageSize: start.pageSize,
      }, hasMore);
    }
    if (!result.page.hasMore || result.page.nextCursor === null) {
      return withOuterCursor(result, kept, wrap, { inner: null, skip: 0, pageSize: start.pageSize }, false);
    }
    inner = result.page.nextCursor;
  }
  if (last === undefined) throw new SearchQueryError('invalid_search_query');
  return withOuterCursor(last, kept, wrap, {
    inner: last.page.nextCursor,
    skip: 0,
    pageSize: start.pageSize,
  }, last.page.hasMore);
}

async function visibleItems(
  items: readonly SearchResult[],
  prefs: CatalogPreferencesView,
  loadTargets: (items: readonly SearchResult[]) => Promise<ReadonlyMap<string, SearchCatalogMuteFacts>>,
): Promise<SearchResult[]> {
  if (items.length === 0) return [];
  const facts = await loadTargets(items);
  const visible: SearchResult[] = [];
  for (const item of items) {
    const fact = facts.get(searchCatalogItemKey(item));
    if (fact === undefined) {
      visible.push(item);
      continue;
    }
    if (!isHiddenByCatalogPreferences({
      ownerAccountId: fact.ownerAccountId,
      tags: fact.tags,
      language: fact.language,
      title: searchResultDisplayTitle(item),
    }, prefs)) visible.push(item);
  }
  return visible;
}

function unwrapResume(
  cursor: string,
  wrap: { readonly hmacKey: string; readonly viewer: string; readonly prefRev: string },
): { inner: string | undefined; skip: number; pageSize: number } {
  const signer = createSearchGovernanceCursorSigner(wrap.hmacKey);
  try {
    const payload = signer.verify(cursor, new Date());
    const bind = searchGovernanceBindDigest({ viewer: wrap.viewer, prefRev: wrap.prefRev });
    if (payload.bind !== bind) throw new SearchQueryError('invalid_cursor');
    return {
      inner: payload.inner === null ? undefined : payload.inner,
      skip: payload.skip,
      pageSize: payload.pageSize,
    };
  } catch (error: unknown) {
    if (error instanceof SearchQueryError) throw error;
    throw new SearchQueryError('invalid_cursor');
  } finally {
    signer.destroy();
  }
}

function withOuterCursor(
  source: SearchQueryResult,
  items: readonly SearchResult[],
  wrap: { readonly hmacKey: string; readonly viewer: string; readonly prefRev: string },
  resume: { readonly inner: string | null; readonly skip: number; readonly pageSize: number },
  hasMore: boolean,
): SearchQueryResult {
  let nextCursor: string | null = null;
  if (hasMore && (resume.inner !== null || resume.skip > 0)) {
    nextCursor = signResume(wrap, resume);
  }
  return Object.freeze({
    normalizedQuery: source.normalizedQuery,
    types: source.types,
    items: Object.freeze([...items]),
    page: Object.freeze({ returnedCount: items.length, hasMore, nextCursor }),
    cache: source.cache,
    consistency: source.consistency,
  });
}

function signResume(
  wrap: { readonly hmacKey: string; readonly viewer: string; readonly prefRev: string },
  resume: { readonly inner: string | null; readonly skip: number; readonly pageSize: number },
): string {
  const signer = createSearchGovernanceCursorSigner(wrap.hmacKey);
  try {
    const now = new Date();
    return signer.sign({
      v: 1,
      purpose: SEARCH_GOVERNANCE_CURSOR_PURPOSE,
      viewer: wrap.viewer,
      prefRev: wrap.prefRev,
      inner: resume.inner,
      skip: resume.skip,
      pageSize: resume.pageSize,
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + SEARCH_GOVERNANCE_CURSOR_TTL_MS).toISOString(),
    });
  } finally {
    signer.destroy();
  }
}
