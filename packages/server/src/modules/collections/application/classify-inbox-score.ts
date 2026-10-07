/**
 * Deterministic classify-inbox folder scorer. Pure: no I/O.
 *
 * Tokenization:
 * - Build token sets from bookmark `title` + URL hostname vs folder `title`.
 * - NFKC, lowercase, split on non-alphanumeric, drop tokens with length < 2.
 * - Invalid URL → host token set is empty; score title only; do NOT throw.
 *
 * Score:
 * - score = round(100 * |A∩B| / |A∪B|) using integer Math.round
 * - empty union → 0
 * - sort descending by score; ties: folderTitle ascending, then folderId ascending
 * - keep score > 0 only, max 3 items; all-zero → []
 *
 * Suggestion:
 * - suggestionId = target folderId
 * - kind only 'existing'
 * - reason exactly: Title/host overlap with "{folderTitle}".
 */

const NON_ALPHANUMERIC = /[^\p{L}\p{N}]+/u;
const MAX_SUGGESTIONS = 3;

export interface ClassifyInboxScoreBookmark {
  readonly title: string;
  readonly url: string;
}

export interface ClassifyInboxScoreFolder {
  readonly folderId: string;
  readonly folderTitle: string;
}

export interface ClassifyInboxScoreInput {
  readonly bookmark: ClassifyInboxScoreBookmark;
  readonly candidateFolders: readonly ClassifyInboxScoreFolder[];
}

export type ClassifyInboxSuggestionKind = 'existing';

export interface ClassifyInboxSuggestion {
  readonly suggestionId: string;
  readonly folderId: string;
  readonly folderTitle: string;
  readonly score: number;
  readonly reason: string;
  readonly kind: ClassifyInboxSuggestionKind;
}

export function scoreClassifyInboxSuggestions(
  input: ClassifyInboxScoreInput,
): readonly ClassifyInboxSuggestion[] {
  const bookmarkTokenSet = unionTokenSets(
    tokenize(input.bookmark.title),
    hostnameTokens(input.bookmark.url),
  );
  const ranked: ClassifyInboxSuggestion[] = [];
  for (const folder of input.candidateFolders) {
    const score = jaccardPercent(bookmarkTokenSet, tokenize(folder.folderTitle));
    if (score <= 0) continue;
    ranked.push(freezeSuggestion({
      suggestionId: folder.folderId,
      folderId: folder.folderId,
      folderTitle: folder.folderTitle,
      score,
      reason: `Title/host overlap with "${folder.folderTitle}".`,
      kind: 'existing',
    }));
  }
  ranked.sort(compareSuggestions);
  return Object.freeze(ranked.slice(0, MAX_SUGGESTIONS));
}

function tokenize(value: string): Set<string> {
  const tokens = new Set<string>();
  for (const token of value.normalize('NFKC').toLowerCase().split(NON_ALPHANUMERIC)) {
    if (token.length >= 2) tokens.add(token);
  }
  return tokens;
}

function hostnameTokens(url: string): Set<string> {
  try {
    const hostname = new URL(url).hostname;
    if (hostname.length < 1) return new Set();
    return tokenize(hostname);
  } catch {
    return new Set();
  }
}

function unionTokenSets(left: ReadonlySet<string>, right: ReadonlySet<string>): Set<string> {
  const tokens = new Set(left);
  for (const token of right) tokens.add(token);
  return tokens;
}

function jaccardPercent(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (left.size === 0 && right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection += 1;
  }
  const union = left.size + right.size - intersection;
  if (union === 0) return 0;
  return Math.round((100 * intersection) / union);
}

function compareSuggestions(left: ClassifyInboxSuggestion, right: ClassifyInboxSuggestion): number {
  if (left.score !== right.score) return right.score - left.score;
  if (left.folderTitle !== right.folderTitle) {
    return left.folderTitle < right.folderTitle ? -1 : 1;
  }
  if (left.folderId !== right.folderId) {
    return left.folderId < right.folderId ? -1 : 1;
  }
  return 0;
}

function freezeSuggestion(suggestion: ClassifyInboxSuggestion): ClassifyInboxSuggestion {
  return Object.freeze(suggestion);
}
