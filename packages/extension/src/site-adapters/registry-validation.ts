import type { AdapterMessage, SiteAdapter } from './contracts.js';
import type { SiteDefinition } from './registry-types.js';
import { readLimits } from './read-policy.js';
const available = new Set(['observeFavorites', 'resolveItem', 'readMemberships', 'enumerateCollections', 'enumerateItems']);
/** Unsupported host capabilities cannot become available merely through a manifest claim. */
export function validateSiteDefinitions(sites: readonly SiteDefinition[]): readonly SiteDefinition[] {
  const ids = new Set<string>(), namespaces = new Set<string>();
  for (const site of sites) {
    const namespace = JSON.stringify([site.siteKey, site.identityVersion]);
    if (ids.has(site.adapterId) || namespaces.has(namespace) || !site.adapterId || !site.siteKey || !Number.isSafeInteger(site.identityVersion) || site.identityVersion < 1) throw new Error('invalidSiteRegistry');
    if (site.readScope !== undefined && !['document', 'account'].includes(site.readScope)) throw new Error('invalidReadScope');
    if (site.contentIdScope !== undefined && !['site', 'account'].includes(site.contentIdScope)) throw new Error('invalidContentScope');
    if (site.collectionSnapshot !== undefined && !['positiveOnly', 'pointInTime'].includes(site.collectionSnapshot)) throw new Error('invalidSnapshotScope');
    if (site.membershipModel !== undefined && site.membershipModel !== 'set') throw new Error('unsupportedMembershipModel');
    ids.add(site.adapterId); namespaces.add(namespace); readLimits(site);
    if (!site.matches.length || site.matches.some(pattern => { try { const u = new URL(pattern); return u.protocol !== 'https:' || !!u.username || !!u.password || u.hostname.includes('*') || !!u.hash; } catch { return true; } })) throw new Error('invalidSiteMatches');
    if (site.negativeReadback && !site.capabilities.includes('readMemberships')) throw new Error('unsupportedHostCapability');
    if (!site.capabilities.every(c => available.has(c)) || new Set(site.capabilities).size !== site.capabilities.length) throw new Error('unsupportedHostCapability');
    if (site.community?.connectOrigins.some(origin => { try { const u = new URL(origin); return u.protocol !== 'https:' || u.origin !== origin; } catch { return true; } })) throw new Error('invalidSiteMatches');
  }
  return Object.freeze([...sites]);
}
export function matchesSiteUrl(site: SiteDefinition, value: string): boolean {
  try {
    const url = new URL(value); if (url.username || url.password) return false;
    return site.matches.some(pattern => {
      const match = new URL(pattern);
      const path = (match.pathname + match.search).split('*').map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
      return url.origin === match.origin && new RegExp(`^${path}$`, 'u').test(url.pathname + url.search);
    });
  } catch { return false; }
}
export function validateAdapterImplementation(site: SiteDefinition, adapter: SiteAdapter): void {
  const methods = { observeFavorites: 'start', resolveItem: 'resolveItem', readMemberships: 'readMemberships', enumerateCollections: 'readCollectionsPage', enumerateItems: 'readItemsPage' } as const;
  if (typeof adapter.detectSource !== 'function' || typeof adapter.start !== 'function' || site.capabilities.some(c => c in methods && typeof adapter[methods[c as keyof typeof methods]] !== 'function')
    || adapter.importResume && adapter.importResume !== site.importResume) throw new Error('adapterCapabilityMismatch');
}
export function allowsSiteMessage(site: SiteDefinition, message: AdapterMessage): boolean {
  const has = (capability: SiteDefinition['capabilities'][number]) => site.capabilities.includes(capability);
  if (message.operation === 'read' || message.operation === 'capture') return false;
  if (message.operation === 'membership.hint') return has('observeFavorites') && has('readMemberships') && has('resolveItem');
  if (message.operation === 'membership.result') return has('readMemberships');
  if (message.operation === 'item.result') return has('resolveItem');
  if (message.operation === 'emit') return has('observeFavorites');
  return message.operation !== 'page.result' || message.result.status === 'failed' || has(message.result.kind === 'collections' ? 'enumerateCollections' : 'enumerateItems');
}
