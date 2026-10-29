import { validateSiteDefinitions } from './registry-validation.js';
import { bilibiliDefinition } from './bilibili/definition.js';
import type { SiteDefinition } from './registry-types.js';
export type { SiteDefinition, SiteIcon } from './registry-types.js';
/** The only host composition point for bundled site implementations. */
export const bundledSites: readonly SiteDefinition[] = validateSiteDefinitions([bilibiliDefinition]);
/** Only legacy records/messages without an installation identifier use this default. */
export const legacySite = bilibiliDefinition;
let installed: readonly SiteDefinition[] = [];
let loaded: Promise<void> = Promise.resolve();
/** Sites from installed packages, set by whoever has read them (the worker, the settings page). */
export function setCommunitySites(sites: readonly SiteDefinition[]) { installed = Object.freeze([...sites]); }
export const communitySites = () => installed;
export const allSites = (): readonly SiteDefinition[] => [...bundledSites, ...installed];
/** The worker reads installed packages after it starts. Identity lookups that can run before then await this. */
export const sitesLoaded = () => loaded;
export function loadingSites(work: Promise<unknown>) { loaded = work.then(() => undefined, () => undefined); }
export function siteDefinition(adapterId: string): SiteDefinition {
  const value = allSites().find(s => s.adapterId === adapterId);
  if (!value) throw new Error('adapterUnavailable'); return value;
}
export function identityDefinition(siteKey: string, identityVersion: number): SiteDefinition {
  const value = allSites().find(s => s.siteKey === siteKey && s.identityVersion === identityVersion);
  if (!value) throw new Error('sourceIdentityNeedsReview'); return value;
}
/** A bundled site's reading of its own pages wins; an installed package cannot make them ambiguous. */
export function resolveContentIdentity(url: string) {
  for (const sites of [bundledSites, installed]) {
    const matches = sites.flatMap(s => { const identity = s.contentIdentity(url); return identity ? [identity] : []; });
    if (matches.length) return matches.length === 1 ? matches[0]! : null;
  }
  return null;
}
