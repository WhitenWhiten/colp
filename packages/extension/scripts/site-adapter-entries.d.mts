import type { SiteDefinition } from '../src/site-adapters/registry-types.js';
export function loadBundledSites(root: string): Promise<readonly SiteDefinition[]>;
export function siteAdapterEntries(root: string, sites: readonly SiteDefinition[], reserved?: readonly string[]): Promise<{
  entries: Record<string, string>;
  bundles: { adapterId: string; adapter: string; probe?: string }[];
}>;
