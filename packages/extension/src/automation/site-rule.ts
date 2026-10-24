import type { BrowserSiteRuleExtension } from '../site-adapters/contracts.js';
import { closed, record } from './closed-value.js';

/** Browser-local admission, deliberately outside the shared v1 Predicate. */
export function validSiteRule(value: unknown): value is BrowserSiteRuleExtension {
  if (!record(value) || !closed(value, ['version', 'admission', 'layout']) || value.version !== 1) return false;
  const { admission: a, layout: l } = value;
  const id = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 256 && !/[\u0000-\u001f]/u.test(v);
  return record(a) && closed(a, ['entries', 'purpose', 'connectionId'], ['collectionIds']) && a.purpose === 'sourceArchive'
    && id(a.connectionId) && Array.isArray(a.entries) && a.entries.length > 0 && a.entries.length <= 3
    && new Set(a.entries).size === a.entries.length && a.entries.every(e => ['siteFavorite', 'siteImport', 'reconcile'].includes(e))
    && (a.collectionIds === undefined || Array.isArray(a.collectionIds) && a.collectionIds.length > 0 && a.collectionIds.length <= 64
      && a.collectionIds.every(id) && new Set(a.collectionIds).size === a.collectionIds.length)
    && record(l) && closed(l, ['kind', 'root']) && l.kind === 'sourceCollections' && l.root === 'actionDestination';
}

export interface SiteRuleEdge {
  readonly entry: BrowserSiteRuleExtension['admission']['entries'][number];
  readonly purpose: 'sourceArchive';
  readonly connectionId: string;
  readonly collectionId: string;
}

/** Check each edge before entering the ordinary first-match loop. */
export function admitsSiteEdge(site: BrowserSiteRuleExtension | undefined, edge: SiteRuleEdge | undefined): boolean {
  if (!edge) return site === undefined;
  return !!site && site.admission.purpose === edge.purpose && site.admission.connectionId === edge.connectionId
    && site.admission.entries.includes(edge.entry)
    && (site.admission.collectionIds === undefined || site.admission.collectionIds.includes(edge.collectionId));
}
