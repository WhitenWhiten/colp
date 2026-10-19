import { normalizeHost } from '@know-n/colp/automation';
import { parentDomains } from '../automation/public-suffix.js';
import type { RiskFlag, RiskIndex } from './risk-index.js';
import type { RiskScope } from './risklist-format.js';

/**
 * Is this address on a risk list the Owner subscribed to (doc 17 §9, RS-17, RS-18)? Read from stored
 * indexes only. The host is looked up as a host, then each parent up to its registrable domain as a
 * domain, then the URL prefixes filed under the host; so a host entry never flags a sibling and a URL
 * prefix never flags its whole host (RS-18.5). Every match is returned with its list, side by side, with
 * nothing merged (RS-18.3); an expired entry is said to be expired, and each list says how fresh it is
 * (R11: stale after 7 days without a successful refresh, out of date after 30). An address on no list
 * gets no answer at all — absence means nothing either way (RS-17.2).
 */
export const STALE_AFTER_MS = 7 * 86_400_000, OUT_OF_DATE_AFTER_MS = 30 * 86_400_000;
export type Freshness = 'fresh' | 'stale' | 'outOfDate';
export interface RiskSource { readonly id: string; readonly name: string; readonly index: RiskIndex; readonly lastSuccessAt: number | null }
export interface RiskException { readonly scope: 'host' | 'domain'; readonly value: string }
export interface RiskMatch extends RiskFlag {
  readonly listId: string;
  readonly listName: string;
  readonly scope: RiskScope;
  /** What the list names: the host, the domain or the prefix that matched. */
  readonly value: string;
  readonly expired: boolean;
  readonly freshness: Freshness;
}

export function freshness(lastSuccessAt: number | null, now: number): Freshness {
  if (lastSuccessAt === null || now - lastSuccessAt > OUT_OF_DATE_AFTER_MS) return 'outOfDate';
  return now - lastSuccessAt > STALE_AFTER_MS ? 'stale' : 'fresh';
}

/** An exception names a host, or a registrable domain with every host under it; it applies to risk alerts only (RS-17.3). */
export const excepted = (host: string, exceptions: readonly RiskException[]) =>
  exceptions.some((item) => item.scope === 'host' ? item.value === host : host === item.value || host.endsWith(`.${item.value}`));

export function checkRisk(url: string, sources: readonly RiskSource[], options: { readonly now: number; readonly exceptions?: readonly RiskException[] }): RiskMatch[] {
  let page: URL;
  try { page = new URL(url); } catch { return []; }
  if (page.protocol !== 'https:' && page.protocol !== 'http:') return [];
  const host = normalizeHost(page.hostname);
  if (!host || excepted(host, options.exceptions ?? [])) return [];
  const matches: RiskMatch[] = [];
  for (const source of sources) {
    const fresh = freshness(source.lastSuccessAt, options.now);
    const add = (scope: RiskScope, value: string, flag: RiskFlag) => matches.push({ ...flag, listId: source.id, listName: source.name, scope, value,
      expired: flag.expires !== null && Date.parse(flag.expires) < options.now, freshness: fresh });
    const exact = source.index.hosts[host];
    if (exact) add('host', host, exact);
    for (const domain of parentDomains(host)) { const flag = source.index.domains[domain]; if (flag) add('domain', domain, flag); }
    for (const item of source.index.prefixes[host] ?? []) if (page.href.startsWith(item.prefix)) add('urlPrefix', item.prefix, item.flag);
  }
  return matches;
}
