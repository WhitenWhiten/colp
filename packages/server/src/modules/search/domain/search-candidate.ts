export type SearchCandidateResourceType = 'collection' | 'node' | 'profile' | 'annotation';

export interface SearchCandidateExclusiveTuple {
  readonly rank: number;
  readonly resourceType: SearchCandidateResourceType;
  readonly resourceId: string;
}

interface SearchCandidateBase {
  readonly resourceId: string;
  /** Bounded, sanitized plain text. Authorization must precede Product DTO mapping. */
  readonly snippetSource: string;
  readonly rank: number;
  readonly exclusive: SearchCandidateExclusiveTuple;
}

export interface CollectionSearchCandidate extends SearchCandidateBase {
  readonly resourceType: 'collection';
  readonly collectionId: string;
  readonly title: string;
  readonly urlHost: null;
}

export interface NodeSearchCandidate extends SearchCandidateBase {
  readonly resourceType: 'node';
  readonly collectionId: string;
  readonly title: string;
  readonly urlHost: string | null;
}

export interface ProfileSearchCandidate extends SearchCandidateBase {
  readonly resourceType: 'profile';
  readonly collectionId: null;
  readonly handle: string;
  readonly displayName: string;
}

export interface AnnotationSearchCandidate extends SearchCandidateBase {
  readonly resourceType: 'annotation';
  readonly collectionId: string;
  readonly subjectType: 'collection' | 'node';
  readonly subjectId: string;
  readonly annotationType: 'note' | 'summary' | 'tldr' | 'highlight' | 'rating' | 'custom';
}

export type SearchCandidate = CollectionSearchCandidate | NodeSearchCandidate
  | ProfileSearchCandidate | AnnotationSearchCandidate;

export interface SearchCandidatePage {
  readonly items: readonly SearchCandidate[];
  readonly hasMore: boolean;
}

export interface AnonymousSearchCandidateQuery {
  readonly query: string;
  readonly limit: number;
  readonly after?: SearchCandidateExclusiveTuple;
}

export type SearchCandidateProjection =
  | { readonly kind: 'anonymous' }
  | { readonly kind: 'account'; readonly accountId: string; readonly principalId: string;
    readonly subjectId: string; readonly securityEpoch: string };

export interface SearchCandidateQuery extends AnonymousSearchCandidateQuery {
  readonly types: readonly SearchCandidateResourceType[];
  readonly projection: SearchCandidateProjection;
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
}

export interface SearchCandidatePort {
  listAnonymousCandidates(input: AnonymousSearchCandidateQuery): Promise<SearchCandidatePage>;
  /** Account projection broadens recall only; application authorization remains authoritative. */
  listCandidates(input: SearchCandidateQuery): Promise<SearchCandidatePage>;
}

export function normalizeSearchQuery(value: string): string | null {
  const normalized = value.normalize('NFKC').toLocaleLowerCase('und')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/(?<=\p{Script=Han}) (?=\p{Script=Han})/gu, '');
  return normalized.length === 0 ? null : normalized;
}

/**
 * pg_trgm word_similarity threshold for the trigram recall arm, chosen per
 * query script.
 *
 * Han text has no word boundaries, so a short query shares only one or two
 * trigrams with the run it sits in; the evidenced 0.15 keeps that recall. For
 * Latin/other scripts the same 0.15 lets a coincidental substring win — the
 * 16 trigrams of `zzzxnotfoundxyz` share `fou`/`oun`/`und` with "Foundation"
 * (0.19) — so those queries use 0.4: a single adjacent-letter swap still
 * clears it (`desgin` vs `design` is 0.43), a stray substring does not.
 */
export const SEARCH_HAN_WORD_SIMILARITY_THRESHOLD = '0.15';
export const SEARCH_DEFAULT_WORD_SIMILARITY_THRESHOLD = '0.4';

export function searchWordSimilarityThreshold(normalizedQuery: string): string {
  return /\p{Script=Han}/u.test(normalizedQuery)
    ? SEARCH_HAN_WORD_SIMILARITY_THRESHOLD
    : SEARCH_DEFAULT_WORD_SIMILARITY_THRESHOLD;
}

export function extractSearchUrlHost(value: string | null): string | null {
  if (value === null) return null;
  try {
    const parsed = new URL(value);
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
      || parsed.username.length > 0
      || parsed.password.length > 0) return null;
    return parsed.hostname.normalize('NFKC').toLocaleLowerCase('und');
  } catch {
    return null;
  }
}

export function compareSearchCandidateTuple(left: SearchCandidate, right: SearchCandidate): number {
  if (left.rank !== right.rank) return right.rank - left.rank;
  const typeOrder: Readonly<Record<SearchCandidateResourceType, number>> = {
    collection: 0, node: 1, profile: 2, annotation: 3,
  };
  if (left.resourceType !== right.resourceType) {
    return typeOrder[left.resourceType] - typeOrder[right.resourceType];
  }
  if (left.resourceId === right.resourceId) return 0;
  return left.resourceId < right.resourceId ? -1 : 1;
}
