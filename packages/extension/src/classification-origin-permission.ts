import { RUNTIME_ORIGIN_KEY } from './config.js';
import { managedServerOrigin } from './managed-policy.js';

export function sharesHostPermission(pattern: string, origin: unknown): boolean {
  if (typeof origin !== 'string' || !origin) return false;
  const current = new URL(origin), candidate = new URL(pattern);
  return current.protocol === candidate.protocol && current.hostname === candidate.hostname;
}

/** Chrome host grants are shared across features and ports on the same host. */
export async function releaseClassificationOrigin(pattern: string): Promise<boolean> {
  const stored = await chrome.storage.local.get(RUNTIME_ORIGIN_KEY);
  const managed = await chrome.storage.managed?.get(['serverOrigin']).catch(() => ({})) ?? {};
  const server = managedServerOrigin(managed) ?? stored[RUNTIME_ORIGIN_KEY];
  if (sharesHostPermission(pattern, server)) return true;
  try { return await chrome.permissions.remove({ origins: [pattern] }) !== false; }
  catch { return !(await chrome.permissions.contains({ origins: [pattern] }).catch(() => true)); }
}
