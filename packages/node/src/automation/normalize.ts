import type { EventFacts } from './types.generated.js';
import { FACTS_VERSION, validateAutomation } from './schema.js';

export const NORMALIZER_VERSION = 'colp.automation.normalize/v1' as const;
export type NormalizedUrl = { status: 'available'; host: string; path: string } | { status: 'missingInput' };

export function normalizeUrl(raw: string): NormalizedUrl {
  try {
    const parsed = new URL(raw);
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) return { status: 'missingInput' };
    const host = parsed.hostname.toLowerCase().replace(/\.+$/u, '');
    if (!host || host.length > 253 || parsed.pathname.length > 2048) return { status: 'missingInput' };
    return { status: 'available', host, path: parsed.pathname || '/' };
  } catch { return { status: 'missingInput' }; }
}

export function normalizeHost(raw: string): string | undefined {
  // Reject URL delimiters instead of interpreting a user-supplied host as a URL.
  if (!raw || (/[\s/@?#\\:%]/u.test(raw) && !/^\[[0-9a-fA-F:.]+\]$/u.test(raw))) return undefined;
  const result = normalizeUrl(`https://${raw}/`);
  return result.status === 'available' ? result.host : undefined;
}

/**
 * Rule-side path text, encoded exactly as bookmark paths are: WHATWG path percent-encoding, and dot
 * segments resolved for whole paths. Fragments (`contains`) keep their dot segments.
 */
export function normalizePathText(raw: string, whole: boolean): string {
  const url = new URL('https://path.invalid/');
  const text = raw.normalize('NFC');
  if (whole && text.startsWith('/')) { url.pathname = text; return url.pathname; }
  // A leading marker keeps "." and ".." literal; the URL setter then encodes the segment.
  return text.split(/[/\\]/u).map((segment) => { url.pathname = `/_${segment}`; return url.pathname.slice(2); }).join('/');
}

export type NormalizedFacts = { status: 'available'; facts: EventFacts } | { status: 'missingInput'; reason: string };
export function normalizeEventFacts(value: unknown, version: number = FACTS_VERSION): NormalizedFacts {
  if (version !== FACTS_VERSION) return { status: 'missingInput', reason: 'unsupportedFactsVersion' };
  if (!validateAutomation('EventFacts', value).valid) return { status: 'missingInput', reason: 'invalidFacts' };
  const facts = structuredClone(value) as EventFacts;
  const host = normalizeHost(facts.bookmark.url.host);
  if (!host) return { status: 'missingInput', reason: 'invalidUrl' };
  const path = facts.bookmark.url.path;
  if (path !== undefined && (!path.startsWith('/') || /[\r\n?#]/u.test(path))) return { status: 'missingInput', reason: 'invalidPath' };
  // Normalize only supplied data. Missing path remains missing; do not invent it.
  const normalizedPath = path === undefined ? undefined : normalizeUrl(`https://${host}${path}`);
  if (normalizedPath?.status === 'missingInput') return { status: 'missingInput', reason: 'invalidPath' };
  facts.bookmark.url = { host, ...(normalizedPath?.status === 'available' ? { path: normalizedPath.path } : {}) };
  facts.bookmark.tags = [...new Set(facts.bookmark.tags.map((tag) => tag.normalize('NFC')))];
  facts.bookmark.title = facts.bookmark.title.normalize('NFC');
  return { status: 'available', facts };
}
