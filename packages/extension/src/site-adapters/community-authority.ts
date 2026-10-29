import { adapterBrowserSupport } from './browser-support.js';
import { siteGrants } from './community-definition.js';
import type { SiteDefinition } from './registry-types.js';
const USER_SCRIPTS = { permissions: ['userScripts', 'webNavigation'] };
/** Throws why installed packages cannot run. Allow User Scripts has no change event, so this calls the API itself. */
export async function communityApiAvailable(definition?: Pick<SiteDefinition, 'matches'>) {
  if (!adapterBrowserSupport(navigator.userAgent).supported) throw new Error('communityBrowserUnsupported');
  if (!await chrome.permissions.contains(definition ? siteGrants({ matches: definition.matches, runtime: 'userScript' }) : USER_SCRIPTS)) throw new Error('communityPermissionRequired');
  try { return await chrome.userScripts.getScripts(); } catch { throw new Error('communityToggleRequired'); }
}
