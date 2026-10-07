import type { OrganizePlannerBookmark } from './organize-planner.js';

const INBOX_FOLDER_TITLES: ReadonlySet<string> = new Set([
  'unsorted',
  'inbox',
  'uncategorized',
  'reading later',
  'read later',
  '未分类',
  '未整理',
  '稍后读',
  '稍后再读',
]);

const STOPWORDS: ReadonlySet<string> = new Set([
  'the',
  'and',
  'for',
  'with',
  'from',
  'http',
  'https',
  'www',
  'com',
  'org',
  'net',
]);

export function normalizeInboxTitle(title: string): string {
  return title.normalize('NFKC').toLocaleLowerCase('und').replace(/\s+/gu, ' ').trim();
}

export function isInboxFolderTitle(title: string): boolean {
  return INBOX_FOLDER_TITLES.has(normalizeInboxTitle(title));
}

export function tokenizeTitle(value: string): readonly string[] {
  const normalized = value.normalize('NFKC').toLocaleLowerCase('und');
  const tokens: string[] = [];
  const seen = new Set<string>();
  for (const match of normalized.matchAll(/[\p{L}\p{N}]+/gu)) {
    const token = match[0]!;
    if (token.length < 2 || STOPWORDS.has(token) || seen.has(token)) continue;
    seen.add(token);
    tokens.push(token);
  }
  return tokens;
}

export function hostTokens(url: string): readonly string[] {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.length < 1) return [];
    return tokenizeTitle(parsed.hostname);
  } catch {
    return [];
  }
}

function addSingularStems(tokens: Set<string>): void {
  for (const token of [...tokens]) {
    if (token.length > 4 && token.endsWith('s') && !token.endsWith('ss')) {
      tokens.add(token.slice(0, -1));
    }
  }
}

export function bookmarkTokenSet(
  bookmark: Pick<OrganizePlannerBookmark, 'title' | 'url'>,
): ReadonlySet<string> {
  const tokens = new Set(tokenizeTitle(bookmark.title));
  for (const token of hostTokens(bookmark.url)) tokens.add(token);
  addSingularStems(tokens);
  return tokens;
}

export function folderTokenSet(folderTitle: string): ReadonlySet<string> {
  const tokens = new Set(tokenizeTitle(folderTitle));
  addSingularStems(tokens);
  return tokens;
}

/** Same formula as Classify: round(100 * |A∩B| / |A∪B|); empty union → 0. */
export function jaccard(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (left.size === 0 && right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection += 1;
  }
  const union = left.size + right.size - intersection;
  if (union === 0) return 0;
  return Math.round((100 * intersection) / union);
}

function titleCaseToken(token: string): string {
  if (token.length === 0) return token;
  return token.slice(0, 1).toLocaleUpperCase('und') + token.slice(1);
}

function looksLikeUrl(value: string): boolean {
  return /:\/\//u.test(value) || /^https?:/iu.test(value);
}

function clusterFallbackTitle(
  bookmarks: readonly Pick<OrganizePlannerBookmark, 'id'>[],
): string {
  if (bookmarks.length === 0) return 'Cluster';
  const shortest = [...bookmarks]
    .map((bookmark) => bookmark.id)
    .sort((left, right) => left.length - right.length || (left < right ? -1 : left > right ? 1 : 0))[0] ?? '';
  const suffix = /^[0-9a-f]+$/iu.test(shortest)
    ? shortest.slice(0, 6).toLocaleLowerCase('und')
    : shortest.slice(0, 6);
  return `Cluster${suffix}`;
}

export function suggestFolderTitle(
  tokens: Iterable<string>,
  bookmarks: readonly Pick<OrganizePlannerBookmark, 'id' | 'title' | 'url'>[],
): string {
  const bookmarkSets = bookmarks.map((bookmark) => bookmarkTokenSet(bookmark));
  const ranked = [...new Set(tokens)]
    .map((token, index) => ({
      token,
      index,
      df: bookmarkSets.reduce((count, set) => count + (set.has(token) ? 1 : 0), 0),
    }))
    .filter((entry) => entry.df > 0)
    .sort((left, right) => right.df - left.df || left.index - right.index)
    .slice(0, 3)
    .map((entry) => titleCaseToken(entry.token));
  const suggested = ranked.join(' ');
  if (
    suggested.length === 0
    || isInboxFolderTitle(suggested)
    || looksLikeUrl(suggested)
    || bookmarks.some((bookmark) => bookmark.url === suggested)
  ) {
    return clusterFallbackTitle(bookmarks);
  }
  return suggested;
}
