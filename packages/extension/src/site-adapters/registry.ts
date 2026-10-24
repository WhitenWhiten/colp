import { validateSiteDefinitions } from './registry-validation.js';
import { bilibiliDefinition } from './bilibili/definition.js';
import type { SiteDefinition } from './registry-types.js';
export type { SiteDefinition } from './registry-types.js';
/** The only host composition point for bundled site implementations. */
export const bundledSites: readonly SiteDefinition[] = validateSiteDefinitions([bilibiliDefinition]);
/** Only legacy records/messages without an installation identifier use this default. */
export const legacySite = bilibiliDefinition;
export function siteDefinition(adapterId: string): SiteDefinition {
  const value = bundledSites.find(s => s.adapterId === adapterId);
  if (!value) throw new Error('adapterUnavailable'); return value;
}
export function identityDefinition(siteKey: string, identityVersion: number): SiteDefinition {
  const value = bundledSites.find(s => s.siteKey === siteKey && s.identityVersion === identityVersion);
  if (!value) throw new Error('sourceIdentityNeedsReview'); return value;
}
export function resolveContentIdentity(url: string) {
  const matches = bundledSites.flatMap(s => { const identity = s.contentIdentity(url); return identity ? [identity] : []; });
  return matches.length === 1 ? matches[0]! : null;
}
