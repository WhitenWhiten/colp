import { isAcceptedBookmarkUrl } from '../domain/bookmark-url.js';
import { CLASSIFICATION_POLICY, ClassificationError, type ClassificationBookmark } from './classification-policy.js';

const encoder = new TextEncoder();
const words = new Intl.Segmenter('zh', { granularity: 'word' });

/** Pure prompt-only transform: never writes back into the source Node. */
export function compileClassificationText(value: string | null, maxBytes: number): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new ClassificationError('invalid_input');
  const normalized = (value ?? '').normalize('NFKC').replace(/\s+/gu, ' ')
    .replace(/[\p{Cc}\p{Cf}]/gu, '').replace(/[^\p{L}\p{N}\p{P}\p{S} ]/gu, '').replace(/ +/g, ' ').trim();
  if (encoder.encode(normalized).length <= maxBytes) return normalized;
  let output = ''; let bytes = 0;
  for (const { segment } of words.segment(normalized)) {
    const size = encoder.encode(segment).length;
    if (bytes + size > maxBytes) break;
    output += segment; bytes += size;
  }
  return output.trimEnd();
}

export function normalizeClassificationBookmark(bookmark: ClassificationBookmark): ClassificationBookmark & { readonly hostname: string } {
  if (!isAcceptedBookmarkUrl(bookmark.url) || typeof bookmark.title !== 'string' || (bookmark.description !== null && typeof bookmark.description !== 'string')) throw new ClassificationError('invalid_input');
  const url = new URL(bookmark.url);
  return {
    title: compileClassificationText(bookmark.title, CLASSIFICATION_POLICY.titleBytes),
    url: bookmark.url,
    description: bookmark.description === null ? null : compileClassificationText(bookmark.description, CLASSIFICATION_POLICY.bookmarkDescriptionBytes),
    hostname: url.hostname.toLowerCase().replace(/\.$/, '').replace(/^www\./, ''),
  };
}

/** ASCII runs + Han bigrams. Identity fields and tag strings are NOT normalized. */
export function classificationTokens(value: string): ReadonlySet<string> {
  const tokens = new Set<string>();
  for (const match of value.normalize('NFKC').toLowerCase().matchAll(/[a-z0-9]+|\p{Script=Han}+/gu)) {
    const text = match[0];
    if (/^[a-z0-9]+$/.test(text)) tokens.add(text);
    else {
      const chars = [...text];
      if (chars.length === 1) tokens.add(text);
      else for (let i = 1; i < chars.length; i++) tokens.add(chars[i - 1]! + chars[i]!);
    }
  }
  return tokens;
}

export function classificationBookmarkTokens(bookmark: ClassificationBookmark): ReadonlySet<string> {
  const normalized = normalizeClassificationBookmark(bookmark);
  const url = new URL(bookmark.url);
  let path = url.pathname;
  try { path = decodeURIComponent(path); } catch { /* Malformed escaping stays literal. */ }
  return classificationTokens(`${normalized.title} ${url.hostname} ${path} ${normalized.description ?? ''}`);
}

export function classificationJaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection++;
  const union = a.size + b.size - intersection;
  return union ? intersection / union : 0;
}

export function compareClassificationBytes(a: string, b: string): number {
  const left = encoder.encode(a); const right = encoder.encode(b);
  for (let i = 0; i < Math.min(left.length, right.length); i++) if (left[i] !== right[i]) return left[i]! - right[i]!;
  return left.length - right.length;
}

export function assertClassificationRequestBudget(input: unknown): void {
  const json = JSON.stringify(input);
  if (json === undefined || encoder.encode(json).length > CLASSIFICATION_POLICY.maxRequestBytes) throw new ClassificationError('context_limit');
}
