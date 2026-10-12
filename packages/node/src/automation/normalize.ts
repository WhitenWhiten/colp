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
  if (!raw || /[\s/@?#\\:%]/u.test(raw)) return undefined;
  const result = normalizeUrl(`https://${raw}/`);
  return result.status === 'available' ? result.host : undefined;
}

export type NormalizedFacts = { status: 'available'; facts: EventFacts } | { status: 'missingInput'; reason: string };
export function normalizeEventFacts(value: unknown, version: number = FACTS_VERSION): NormalizedFacts {
  if (version !== FACTS_VERSION) return { status: 'missingInput', reason: 'unsupportedFactsVersion' };
  if (!validateAutomation('EventFacts', value).valid) return { status: 'missingInput', reason: 'invalidFacts' };
  const facts = structuredClone(value) as EventFacts;
  const host = normalizeHost(facts.bookmark.url.host);
  if (!host) return { status: 'missingInput', reason: 'invalidUrl' };
  const path = facts.bookmark.url.path;
  if (path !== undefined && (!path.startsWith('/') || /[\r\n]/u.test(path))) return { status: 'missingInput', reason: 'invalidPath' };
  // Normalize only supplied data. Missing path remains missing; do not invent it.
  facts.bookmark.url = { host, ...(path === undefined ? {} : { path }) };
  facts.bookmark.tags = [...new Set(facts.bookmark.tags.map((tag) => tag.normalize('NFC')))];
  facts.bookmark.title = facts.bookmark.title.normalize('NFC');
  return { status: 'available', facts };
}
