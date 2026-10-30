import type { ContentIdentity } from './contracts.js';
import type { SiteDefinition } from './registry-types.js';
import { matchesSiteUrl } from './registry-validation.js';

interface ContentResolver {
  definition: SiteDefinition;
  resolve(url: string, tabId?: number): Promise<string | null>;
}

/** Route before opening installation state. Failures on the matching site still
 * preserve its managed-copy protection rather than permitting an extra create. */
export async function resolvePageContent(hosts: readonly ContentResolver[], url: string, tabId?: number): Promise<ContentIdentity | null> {
  if (tabId === undefined) return null;
  for (const host of hosts) {
    const definition = host.definition;
    if (!definition.capabilities.includes('resolveItem') || !matchesSiteUrl(definition, url)) continue;
    const id = await host.resolve(url, tabId);
    if (id) return { siteKey: definition.siteKey, identityVersion: definition.identityVersion, itemId: id };
  }
  return null;
}
